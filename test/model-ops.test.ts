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
 * a model that is unknown, not tool-capable or unpriced (null and empty price fields count as
 * unreadable, never as free), recording every applied change with its reason and price delta — for a
 * role change as for a tier change — reverting one without a deploy (including a role whose previous
 * model was a full provider id), and the once-a-day check that reports offers and better-value
 * alternatives per role and messages Paul only when it recommends a change. The check never applies a
 * recommendation; the one change it makes itself is the previous-model fallback for a tier whose model
 * has left OpenRouter's list, recorded and told. It never invents a performance score: OpenRouter's
 * public list carries prices, tool support and context length, and the report says so.
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

test("null and empty price fields are unreadable, not free", async () => {
  const body = () =>
    Promise.resolve(
      modelsBody([
        ...fullList(),
        { id: "null/price", name: "null/price", context_length: 128000, supported_parameters: ["tools"], pricing: { prompt: null, completion: "" } },
        { id: "cache/nulls", name: "cache/nulls", context_length: 128000, supported_parameters: ["tools"], pricing: { prompt: "0.0000003", completion: "0.0000012", cache_read: null, cache_write: "" } },
      ]),
    );
  const parsed = await ops.fetchLiveModels({ fetch: (async () => body()) as typeof fetch });
  const unpriced = parsed.find((m) => m.id === "null/price")!;
  assert.equal(unpriced.input, undefined, "Number(null) is not a price");
  assert.equal(unpriced.output, undefined, 'Number("") is not a price');
  await assert.rejects(
    ops.applyModelChange(deps(async () => body()), { alias: "haiku", model: "null/price", why: "a tool-capable model with null prices must be refused, not free" }),
    /no readable price/,
  );
  const cached = parsed.find((m) => m.id === "cache/nulls")!;
  assert.equal(cached.input, 0.3);
  assert.equal(cached.cacheRead, undefined, "a null cache price is unreadable too");
  assert.equal(ops.priceRow(cached).cacheRead, 0.3, "an unreadable cache price falls back to the input price, never to zero");
  assert.equal(ops.priceRow(cached).cacheWrite, 0.3);
});

test("a role change validates the destination tier's model and records both price rows", async () => {
  // A role pointed at a tier whose model is broken is refused before anything is written.
  cat.writeCatalogue(DIR, { version: 1, aliases: { sonnet: "broken/model" } });
  await assert.rejects(
    ops.applyModelChange(deps(async () => Promise.resolve(modelsBody([...fullList(), row("no/tools-model", "0.0000001", "0.0000001", false)]))), { role: "engineer", to: "sonnet", why: "broken destination" }),
    /is not on OpenRouter's model list/,
  );
  assert.equal(cat.readCatalogue(DIR).changes, undefined, "no change was recorded for the unknown destination");
  cat.writeCatalogue(DIR, { version: 1, aliases: { sonnet: "no/tools-model" } });
  const before = fs.readFileSync(path.join(DIR, "model-catalogue.json"), "utf8");
  await assert.rejects(
    ops.applyModelChange(deps(async () => Promise.resolve(modelsBody([...fullList(), row("no/tools-model", "0.0000001", "0.0000001", false)]))), { role: "engineer", to: "sonnet", why: "tool-less destination" }),
    /does not support tools/,
  );
  assert.equal(fs.readFileSync(path.join(DIR, "model-catalogue.json"), "utf8"), before, "no write happened on the refused paths");
  // A valid role change records both price rows and the delta, like a tier change.
  cat.writeCatalogue(DIR, { version: 1 });
  const text = await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "engineer", to: "sonnet", why: "Paul wants engineers on the stronger tier" });
  assert.match(text, /z-ai\/glm-5\.3/);
  assert.match(text, /\$1\.40/);
  assert.match(text, /more in and \d+% more out/, "a pricier destination says it is pricier, not 'less'");
  const entry = cat.readCatalogue(DIR).changes!.at(-1)!;
  assert.equal(entry.kind, "role");
  assert.equal(entry.from, "haiku");
  assert.equal(entry.to, "sonnet");
  assert.equal(entry.fromPrice!.input, 0.3, "the model the role ran on before, priced");
  assert.equal(entry.fromPrice!.output, 1.2);
  assert.equal(entry.toPrice!.input, 1.4, "the destination model, priced");
  assert.equal(entry.toPrice!.output, 4.4);
  const back = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "engineer" });
  assert.match(back, /engineer is back on haiku \(sonnet before/);
  assert.equal(config.models.engineer, "haiku");
});

test("a fable change under the deploy's opus pin is refused, and the pin is named", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  config.openrouter.models.opus = "env/opus";
  assert.equal(llm.openrouterModels().fable, "env/opus", "the opus variable pins fable when fable itself is unset");
  await assert.rejects(
    ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "fable", model: "qwen/qwen3.8-flash", why: "under the opus pin" }),
    /OPENROUTER_OPUS_MODEL is set in the deploy/,
  );
  assert.equal(llm.openrouterModels().fable, "env/opus", "nothing changed");
  assert.match(ops.catalogueView(store), /fable → env\/opus .*the deploy's own OPENROUTER_OPUS_MODEL/, "the chief's view names the pin actually in force");
  // A revert under the same pin is refused too: restoring the catalogue row would change nothing.
  config.openrouter.models.opus = "";
  await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "fable", model: "qwen/qwen3.8-flash", why: "fable change with no pin" });
  config.openrouter.models.opus = "env/opus";
  await assert.rejects(ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "fable" }), /OPENROUTER_OPUS_MODEL is set in the deploy/);
  config.openrouter.models.opus = "";
  const back = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "fable" });
  assert.match(back, /fable tier is back on moonshotai\/kimi-k3\.1-pro/);
  cat.writeCatalogue(DIR, { version: 1 });
});

test("a withdrawn model falls back to its previous model, recorded and told", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  store.setSetting("modelWatch", undefined);
  // A decision moves the haiku tier to qwen; the model it left is kept as the tier's fallback.
  await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku", model: "qwen/qwen3.8-flash", why: "Paul asked for the cheaper model" });
  assert.equal(cat.readCatalogue(DIR).fallbacks!.haiku, "deepseek/deepseek-v4.1-flash");
  // The next check finds qwen gone from OpenRouter's list: the tier goes back to deepseek on its own.
  const sent: Array<{ to: string; text: string }> = [];
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now,
    fetch: (async () => Promise.resolve(modelsBody([DEEPSEEK, GLM, KIMI]))) as typeof fetch,
    messenger: { send: async (to, text) => void sent.push({ to, text }) },
    to: "tg:123",
    warn: () => undefined,
  });
  const result = await watch.run();
  assert.equal(result.ran, true);
  assert.equal(result.flagged, true, "the vanished model is flagged even though the fallback engaged");
  assert.equal(result.engaged.length, 1);
  assert.equal(result.engaged[0]!.alias, "haiku");
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash", "the tier runs on its previous model again, with no deploy");
  const after = cat.readCatalogue(DIR);
  const record = after.changes!.find((c) => c.kind === "fallback")!;
  assert.equal(record.by, "model-check");
  assert.equal(record.from, "qwen/qwen3.8-flash");
  assert.equal(record.to, "deepseek/deepseek-v4.1-flash");
  assert.match(record.why, /left OpenRouter's model list/);
  assert.equal(record.toPrice!.input, 0.3, "the fallback's price is recorded");
  assert.equal(after.fallbacks, undefined, "the fallback is spent, so the check cannot re-engage it");
  const superseded = after.changes!.find((c) => c.kind === "alias" && c.to === "qwen/qwen3.8-flash")!;
  assert.ok(superseded.reverted, "the decision the fallback superseded is marked undone");
  await assert.rejects(ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku" }), /no model change to revert for haiku/, "a revert cannot bring the vanished model back");
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash");
  assert.equal(sent.length, 1, "Paul is told the fallback engaged");
  assert.match(sent[0]!.text, /qwen\/qwen3\.8-flash has left OpenRouter's model list/);
  assert.match(sent[0]!.text, /deepseek\/deepseek-v4\.1-flash/);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", `${londonYmd(now())}.md`), "utf8"), /## Fallbacks engaged today/);
  store.setSetting("modelWatch", undefined);
  cat.writeCatalogue(DIR, { version: 1 });
});

test("a model still on the list that fails its check is reported with its real reason, not auto-withdrawn", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  store.setSetting("modelWatch", undefined);
  // A decision moved the haiku tier to qwen; the model it left is the recorded fallback.
  await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku", model: "qwen/qwen3.8-flash", why: "Paul asked for the cheaper model" });
  assert.equal(cat.readCatalogue(DIR).fallbacks!.haiku, "deepseek/deepseek-v4.1-flash");
  const sent: Array<{ to: string; text: string }> = [];
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now,
    // qwen is still on the list but no longer tool-capable: that is a decision for the chief, not a
    // withdrawal, so the fallback is never engaged for it.
    fetch: (async () => Promise.resolve(modelsBody([DEEPSEEK, row("qwen/qwen3.8-flash", "0.00000015", "0.0000005", false, 256000), GLM, KIMI]))) as typeof fetch,
    messenger: { send: async (to, text) => void sent.push({ to, text }) },
    to: "tg:123",
    warn: () => undefined,
  });
  const result = await watch.run();
  assert.equal(result.engaged.length, 0, "a model still on OpenRouter's list is never withdrawn from automatically");
  assert.equal(result.flagged, true, "the broken model is still flagged");
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash", "the tier is left exactly as it was");
  const after = cat.readCatalogue(DIR);
  assert.equal(after.fallbacks!.haiku, "deepseek/deepseek-v4.1-flash", "the fallback is not spent");
  assert.ok(!after.changes!.some((c) => c.kind === "fallback"), "no fallback move was recorded");
  const report = fs.readFileSync(path.join(DIR, "model-watch", `${londonYmd(now())}.md`), "utf8");
  assert.match(report, /NOT VERIFIED: "qwen\/qwen3\.8-flash" does not support tools/, "the report gives the real reason");
  assert.ok(!report.includes("## Fallbacks engaged today"));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /does not support tools on OpenRouter/, "Paul is told the real reason");
  assert.match(sent[0]!.text, /still on OpenRouter's model list, so its recorded previous model was not engaged automatically/, "the message says why the previous model stayed put");
  store.setSetting("modelWatch", undefined);
  cat.writeCatalogue(DIR, { version: 1 });
});

test("a cheaper tier no role runs on is never recommended", async () => {
  // Every role is on haiku; the sonnet tier is mapped to a model that is cheaper than haiku's but
  // that no role uses, and the only model cheaper than it is not 20% cheaper than haiku's own.
  cat.writeCatalogue(DIR, { version: 1, aliases: { sonnet: "cheap/unused-tier" } });
  store.setSetting("modelWatch", undefined);
  const sent: Array<{ to: string; text: string }> = [];
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now,
    fetch: (async () => Promise.resolve(modelsBody([DEEPSEEK, GLM, KIMI, row("cheap/unused-tier", "0.0000005", "0.000001"), row("cheap/option", "0.00000035", "0.0000007")]))) as typeof fetch,
    messenger: { send: async (to, text) => void sent.push({ to, text }) },
    to: "tg:123",
    warn: () => undefined,
  });
  const result = await watch.run();
  assert.equal(result.recommend, false, "the unused sonnet tier's cheap model is not recommended");
  assert.equal(result.engaged.length, 0);
  assert.equal(sent.length, 0, "nothing for Paul to decide means no message");
  const report = fs.readFileSync(path.join(DIR, "model-watch", `${londonYmd(now())}.md`), "utf8");
  assert.ok(!report.includes("RECOMMENDED"), "no recommendation appears in the report");
  assert.ok(!report.includes("for the sonnet tier"), "nothing is recommended for a tier no role runs on");
  store.setSetting("modelWatch", undefined);
  cat.writeCatalogue(DIR, { version: 1 });
});

test("a role on a direct provider model id is verified and gets the same better-value analysis", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  store.setSetting("modelWatch", undefined);
  config.models.chief = "vendor/direct-model";
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now,
    fetch: (async () => Promise.resolve(modelsBody([...fullList(), row("vendor/direct-model", "0.0000005", "0.000002")]))) as typeof fetch,
    warn: () => undefined,
  });
  await watch.run();
  const report = fs.readFileSync(path.join(DIR, "model-watch", `${londonYmd(now())}.md`), "utf8");
  assert.match(report, /chief: vendor\/direct-model → vendor\/direct-model — verified: tools, \$0\.50\/M in and \$2\.00\/M out/);
  assert.match(report, /Cheaper on price alone: qwen\/qwen3\.8-flash at \$0\.15\/M in and \$0\.50\/M out, context 256000 ≥ 128000, tool-capable\. Listed, not recommended: this role's model is a direct provider id/);
  config.models.chief = "haiku";
  store.setSetting("modelWatch", undefined);
  cat.writeCatalogue(DIR, { version: 1 });
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
  assert.match(sent[0]!.text, /no previous model to fall back on, so runs on it will fail until it is changed/, "with no fallback the message claims no availability it does not provide");
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
