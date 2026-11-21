import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-model-ops-"));
delete process.env.OPENROUTER_API_KEY;
// This machine may carry the deploy's own model variables; the tests speak of the code's defaults.
for (const k of ["CHIEF_MODEL", "WORKER_MODEL", "ENGINEER_MODEL", "MAINTAINER_MODEL", "DESIGN_MODEL", "EA_MODEL", "OPENROUTER_HAIKU_MODEL", "OPENROUTER_SONNET_MODEL", "OPENROUTER_OPUS_MODEL", "OPENROUTER_FABLE_MODEL", "OPENROUTER_PRICES", "LLM_PROVIDER"]) delete process.env[k];

/**
 * The model decisions themselves (src/model-ops.ts): reading OpenRouter's public model list, refusing
 * a model that is unknown, not tool-capable or unpriced, recording every applied change with its
 * reason and price delta, reverting one without a deploy, and the once-a-day check that reports
 * offers and better-value alternatives and messages Paul only when it recommends a change. The check
 * never changes a model, and it never invents a performance score: OpenRouter's public model list
 * carries prices, tool support and context length, and the report says so.
 */
const { config } = await import("../src/config.js");
const llm = await import("../src/llm.js");
const cat = await import("../src/catalogue.js");
const ops = await import("../src/model-ops.js");
const { Store } = await import("../src/store.js");
const { londonYmd } = await import("../src/london.js");

const DIR = config.dataDir;
const store = new Store(DIR);
config.openrouter.apiKey = "sk-or-v1-test";
cat.writeCatalogue(DIR, { version: 1 });

/** OpenRouter's public model list, faked: the shape of GET https://openrouter.ai/api/v1/models. */
function modelsBody(data: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}
const row = (id: string, prompt: string, completion: string, tools = true, context_length = 128000) => ({
  id,
  name: id,
  context_length,
  pricing: { prompt, completion },
  ...(tools ? { supported_parameters: ["tools", "max_tokens"] } : { supported_parameters: ["max_tokens"] }),
});
const DEEPSEEK = row("deepseek/deepseek-v4.1-flash", "0.0000003", "0.0000012");
const QWEN = row("qwen/qwen3.8-flash", "0.00000015", "0.0000005", true, 256000);
const GLM = row("z-ai/glm-5.3", "0.0000014", "0.0000044");
const KIMI = row("moonshotai/kimi-k3.1-pro", "0.000002", "0.00001");
const fullList = () => [DEEPSEEK, QWEN, GLM, KIMI];

const now = () => new Date("2026-11-21T09:30:00Z"); // 09:30 London on a winter Saturday
const deps = (fetchImpl: typeof fetch) => ({ store, fetch: fetchImpl, now });

test("the live model list is read with prices per million tokens and tool support", async () => {
  const list = await ops.fetchLiveModels({ fetch: (() => Promise.resolve(modelsBody(fullList()))) as typeof fetch });
  const ds = list.find((m) => m.id === "deepseek/deepseek-v4.1-flash")!;
  assert.equal(ds.input, 0.3);
  assert.equal(ds.output, 1.2);
  assert.equal(ds.tools, true);
  assert.equal(ds.contextLength, 128000);
  const glm = list.find((m) => m.id === "z-ai/glm-5.3")!;
  assert.equal(glm.input, 1.4);
  assert.equal(glm.output, 4.4);
});

test("an unknown, tool-less or unpriced model is refused with a clear reason and nothing is written", async () => {
  const before = fs.readFileSync(path.join(DIR, "model-catalogue.json"), "utf8");
  for (const [model, why] of [
    ["nope/nope", /is not on OpenRouter's model list/],
    ["no/tools-model", /does not support tools/],
    ["free/unpriced", /no readable price/],
  ]) {
    await assert.rejects(
      ops.applyModelChange(deps(async () => Promise.resolve(modelsBody([...fullList(), row("no/tools-model", "0.0000001", "0.0000001", false), { id: "free/unpriced", supported_parameters: ["tools"] }]))), { alias: "haiku", model, why: "test" }),
      why,
    );
  }
  assert.equal(fs.readFileSync(path.join(DIR, "model-catalogue.json"), "utf8"), before, "a refused change writes nothing");
  await assert.rejects(ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku", model: "qwen/qwen3.8-flash" }), /needs a reason/);
  await assert.rejects(ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku", model: "qwen/qwen3.8-flash", role: "worker", to: "sonnet", why: "both" }), /either a tier and a model, or a role and a tier/);
  await assert.rejects(ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "worker", to: "mega", why: "not a tier" }), /not one of the tiers/);
});

test("a tier change is applied live, priced and recorded with its price delta", async () => {
  const text = await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku", model: "qwen/qwen3.8-flash", why: "Paul asked for the cheaper model the daily check recommended" });
  assert.match(text, /qwen\/qwen3\.8-flash/);
  assert.match(text, /\$0\.15/);
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash");
  assert.deepEqual(llm.unpricedModels(), []);
  const entry = cat.readCatalogue(DIR).changes!.at(-1)!;
  assert.equal(entry.kind, "alias");
  assert.equal(entry.target, "haiku");
  assert.equal(entry.from, "deepseek/deepseek-v4.1-flash");
  assert.equal(entry.to, "qwen/qwen3.8-flash");
  assert.equal(entry.toPrice!.input, 0.15);
  assert.match(entry.why, /Paul asked/);
});

test("a tier the deploy's own variable pins cannot be changed from the catalogue", async () => {
  config.openrouter.models.haiku = "env/deploy-model";
  await assert.rejects(ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku", model: "qwen/qwen3.8-flash", why: "x" }), /OPENROUTER_HAIKU_MODEL is set in the deploy/);
  config.openrouter.models.haiku = "";
});

test("a role change moves the role at run time, unless Paul has set it himself in the app", async () => {
  const text = await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "engineer", to: "sonnet", why: "Paul wants engineers on the stronger tier" });
  assert.match(text, /engineer/);
  assert.equal(config.models.engineer, "sonnet");
  store.setSetting("live", { models: { maintainer: "opus" } });
  config.models.maintainer = "opus";
  await assert.rejects(ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "maintainer", to: "sonnet", why: "x" }), /Paul has set the maintainer/);
  assert.equal(config.models.maintainer, "opus");
  store.setSetting("live", undefined);
});

test("the most recent change reverts without a deploy, and a second revert says so", async () => {
  const text = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku" });
  assert.match(text, /deepseek\/deepseek-v4\.1-flash/);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash", "the tier is back on the model it ran on before");
  assert.equal(llm.modelPrices()["deepseek/deepseek-v4.1-flash"]!.input, 0.3, "the price row it had before is back too");
  const reverted = cat.readCatalogue(DIR).changes!.find((c) => c.from === "deepseek/deepseek-v4.1-flash" && c.to === "qwen/qwen3.8-flash")!;
  assert.ok(reverted.reverted, "the change is marked as reverted");
  // The revert's own record is not a candidate, so a second revert is a clear refusal.
  await assert.rejects(ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku" }), /no model change to revert for haiku/);
  const roleBack = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "engineer" });
  assert.match(roleBack, /haiku/);
  assert.equal(config.models.engineer, "haiku");
});

test("the daily check writes a per-role report and messages Paul only when it recommends a change", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  const sent: Array<{ to: string; text: string }> = [];
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now,
    fetch: (async () => Promise.resolve(modelsBody(fullList()))) as typeof fetch,
    messenger: { send: async (to, text) => void sent.push({ to, text }) },
    to: "tg:123",
    warn: () => undefined,
  });
  const today = londonYmd(now());
  assert.equal(watch.due(), true, "no check has run today and it is past the hour");
  const result = await watch.run();
  assert.equal(result.ran, true);
  const report = fs.readFileSync(path.join(DIR, "model-watch", `${today}.md`), "utf8");
  for (const role of ["chief", "workers", "engineer", "maintainer", "designer"]) assert.match(report, new RegExp(role), `the report covers ${role}`);
  assert.match(report, /qwen\/qwen3\.8-flash.*\$0\.15.*\$0\.50/s, "the cheaper tool-capable model is named with its prices");
  assert.match(report, /20%/);
  assert.match(report, /OpenRouter's public model list carries no performance or quality measure/, "no performance score is invented");
  assert.equal(store.settings().modelWatch?.ymd, today, "the run is marked so it does not repeat");
  assert.equal(watch.due(), false);
  assert.equal(sent.length, 1, "Paul is messaged when a change is recommended");
  assert.match(sent[0]!.text, /qwen\/qwen3\.8-flash/);
  assert.match(sent[0]!.text, /nothing has changed yet/);
  // A day with nothing to recommend is silent.
  const quietList = () => [DEEPSEEK, GLM, KIMI, row("barely/cheaper", "0.00000029", "0.0000012")];
  store.setSetting("modelWatch", undefined);
  sent.length = 0;
  const quiet = new ops.ModelWatch({ store, dataDir: DIR, now, fetch: (async () => Promise.resolve(modelsBody(quietList()))) as typeof fetch, messenger: { send: async (to, text) => void sent.push({ to, text }) }, to: "tg:123", warn: () => undefined });
  const quietResult = await quiet.run();
  assert.equal(quietResult.ran, true);
  assert.equal(quietResult.recommend, false);
  assert.equal(sent.length, 0, "no recommendation means no message");
  // A model that has disappeared is flagged and Paul is told.
  store.setSetting("modelWatch", undefined);
  sent.length = 0;
  const gone = new ops.ModelWatch({ store, dataDir: DIR, now, fetch: (async () => Promise.resolve(modelsBody([QWEN, GLM, KIMI]))) as typeof fetch, messenger: { send: async (to, text) => void sent.push({ to, text }) }, to: "tg:123", warn: () => undefined });
  const goneResult = await gone.run();
  assert.equal(goneResult.ran, true);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", `${today}.md`), "utf8"), /is not on OpenRouter's model list/);
  assert.equal(sent.length, 1, "a broken model is flagged to Paul");
  // A failed read tries again later and says nothing.
  store.setSetting("modelWatch", undefined);
  sent.length = 0;
  const failing = new ops.ModelWatch({ store, dataDir: DIR, now, fetch: (async () => Promise.reject(new Error("network down"))) as typeof fetch, messenger: { send: async (to, text) => void sent.push({ to, text }) }, to: "tg:123", warn: () => undefined });
  const failed = await failing.run();
  assert.equal(failed.ran, false);
  assert.equal(store.settings().modelWatch?.ymd, undefined);
  assert.equal(sent.length, 0);
  assert.equal(failing.due(), true, "an unread check stays due");
  cat.writeCatalogue(DIR, { version: 1 });
});

test("the check is off when MODEL_CHECK is off or the provider is not OpenRouter", () => {
  config.modelCheck.enabled = false;
  const off = new ops.ModelWatch({ store, dataDir: DIR, now, fetch: (async () => Promise.resolve(modelsBody(fullList()))) as typeof fetch, warn: () => undefined });
  assert.equal(off.due(), false);
  assert.equal(off.start(), undefined);
  config.modelCheck.enabled = true;
  config.openrouter.apiKey = "";
  const anthropic = new ops.ModelWatch({ store, dataDir: DIR, now, fetch: (async () => Promise.resolve(modelsBody(fullList()))) as typeof fetch, warn: () => undefined });
  assert.equal(anthropic.due(), false, "on Anthropic there is no OpenRouter catalogue to check");
  config.openrouter.apiKey = "sk-or-v1-test";
});

test("the check waits for its hour and runs at most once a day", () => {
  const early = new ops.ModelWatch({ store, dataDir: DIR, now: () => new Date("2026-11-21T06:30:00Z"), fetch: (async () => Promise.resolve(modelsBody(fullList()))) as typeof fetch, warn: () => undefined });
  assert.equal(early.due(), false, "before the London hour it waits");
  const later = new ops.ModelWatch({ store, dataDir: DIR, now: () => new Date("2026-11-22T09:30:00Z"), fetch: (async () => Promise.resolve(modelsBody(fullList()))) as typeof fetch, warn: () => undefined });
  assert.equal(later.due(), true, "the next day it is due again");
});
