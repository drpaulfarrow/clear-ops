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
 * model was a full provider id), and the once-a-day check that reports offers and cheaper alternatives
 * per role. For the cheapest tier in use the check moves the tier to a cheaper model itself, only when
 * the benchmark lookup supports it (src/model-evidence.ts, faked here), and messages Paul only when it
 * has moved a tier or a model is broken; the other change it makes itself is the previous-model
 * fallback for a tier whose model has left OpenRouter's list. It never invents a performance score: OpenRouter's
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
  assert.equal(cat.readCatalogue(DIR).roleFallbacks!.engineer, "haiku", "the tier the role leaves is recorded as its own fallback, so a withdrawn model cannot kill its runs");
  const back = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "engineer" });
  assert.match(back, /engineer is back on haiku \(sonnet before/);
  assert.equal(config.models.engineer, "haiku");
  assert.equal(cat.readCatalogue(DIR).roleFallbacks!.engineer, "sonnet", "a revert records the tier it leaves the same way");
  cat.writeCatalogue(DIR, { version: 1 });
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

test("a vanished model with a role's recorded previous tier is reported as protected, not as doomed", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  store.setSetting("modelWatch", undefined);
  // Only a role change: the engineers move to the sonnet tier, recording haiku as their own previous
  // tier, and the sonnet tier itself keeps no fallback. Sonnet's model then leaves OpenRouter's list.
  await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "engineer", to: "sonnet", why: "Paul wants engineers on the stronger tier" });
  assert.equal(cat.readCatalogue(DIR).roleFallbacks!.engineer, "haiku");
  assert.equal(cat.readCatalogue(DIR).fallbacks, undefined, "no tier fallback is recorded");
  const sent: Array<{ to: string; text: string }> = [];
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now,
    // glm is gone from the list; everything else verifies, and nothing on the list is 20% cheaper
    // than the cheapest tier in use, so the message is the broken-model one, not a recommendation.
    fetch: (async () => Promise.resolve(modelsBody([DEEPSEEK, KIMI]))) as typeof fetch,
    messenger: { send: async (to, text) => void sent.push({ to, text }) },
    to: "tg:123",
    warn: () => undefined,
  });
  const result = await watch.run();
  assert.equal(result.engaged.length, 0, "no tier fallback is recorded, so the check itself moves nothing");
  assert.equal(llm.openrouterModels().sonnet, "z-ai/glm-5.3", "the tier is left exactly as it was");
  assert.equal(cat.readCatalogue(DIR).roles!.engineer, "sonnet", "moving the role stays the chief's decision, not the check's");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /retried on the role's recorded previous tier at once/, "the message says the runtime fallback protects runs");
  assert.ok(!sent[0]!.text.includes("no previous model to fall back on"), "it does not claim there is nothing to fall back on while a role has its previous tier recorded");
  store.setSetting("modelWatch", undefined);
  cat.writeCatalogue(DIR, { version: 1 });
  cat.applyCatalogueRoles(store, DIR);
  assert.equal(config.models.engineer, "haiku", "the config overlay is put back for later tests");
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
  assert.ok(!report.includes("Cheaper candidate"), "no candidate appears in the report");
  assert.ok(!report.includes("## Benchmark evidence"), "and nothing was looked up");
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

test("the daily check writes a per-role report, and a cheaper model with no benchmark evidence changes nothing and sends nothing", async () => {
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
  // No search engine is configured here, so there is nothing to look benchmarks up with: no
  // information, no move, and no daily note about a model that is merely cheaper.
  assert.equal(result.recommend, true, "a cheaper candidate exists");
  assert.equal(result.applied, undefined);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash", "the tier has not moved");
  assert.equal(cat.readCatalogue(DIR).changes, undefined, "nothing was recorded");
  assert.match(report, /Cheaper candidate: qwen\/qwen3\.8-flash.*Taken up only on benchmark evidence/);
  assert.match(report, /## Benchmark evidence\n- qwen\/qwen3\.8-flash: not supported, no search engine is configured/);
  assert.match(report, /Nothing was changed by this check\. It moves a tier only on benchmark evidence/);
  assert.equal(sent.length, 0, "a cheaper model the evidence does not support is not worth a message");
  // A day with nothing cheaper is silent too.
  const quietList = () => [DEEPSEEK, GLM, KIMI, row("barely/cheaper", "0.00000029", "0.0000012")];
  store.setSetting("modelWatch", undefined);
  sent.length = 0;
  const quiet = new ops.ModelWatch({ store, dataDir: DIR, now, fetch: (async () => Promise.resolve(modelsBody(quietList()))) as typeof fetch, messenger: { send: async (to, text) => void sent.push({ to, text }) }, to: "tg:123", warn: () => undefined });
  const quietResult = await quiet.run();
  assert.equal(quietResult.ran, true);
  assert.equal(quietResult.recommend, false);
  assert.equal(sent.length, 0, "nothing cheaper means no message");
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

/* ------------------------------------------------------------------ the check's own moves, on evidence */

type Verdict = import("../src/model-evidence.js").EvidenceVerdict;
const ROWS = [
  { benchmark: "SWE-bench Verified", candidate: 71.2, current: 68, candidateUrl: "https://bench.example/compare", currentUrl: "https://bench.example/compare" },
  { benchmark: "MMLU-Pro", candidate: 82.1, current: 80.3, candidateUrl: "https://a.example/qwen", currentUrl: "https://b.example/deepseek" },
];
const SUPPORTED: Verdict = { ok: true, reason: "it is level or ahead on all 2 benchmarks that report both models: SWE-bench Verified 71.2 against 68, MMLU-Pro 82.1 against 80.3.", rows: ROWS, searches: [{ engine: "exa", query: "qwen3.8-flash vs deepseek-v4.1-flash benchmark comparison", results: 5 }] };
const UNSUPPORTED: Verdict = { ok: false, reason: "no benchmark reporting both models was found.", rows: [], searches: [{ engine: "brave", query: "qwen3.8-flash benchmark scores", results: 0 }] };
const at = (iso: string) => () => new Date(iso);

/** A check with a faked benchmark lookup, recording which candidates were looked up against what. */
function watching(list: unknown[], answer: (candidate: string) => Verdict, when = now) {
  const sent: string[] = [];
  const asked: string[] = [];
  const watch = new ops.ModelWatch({
    store,
    dataDir: DIR,
    now: when,
    fetch: (async () => Promise.resolve(modelsBody(list))) as typeof fetch,
    messenger: { send: async (_to, text) => void sent.push(text) },
    to: "tg:123",
    warn: () => undefined,
    evidence: async (candidate, current) => {
      asked.push(`${candidate.id}>${current.id}`);
      return answer(candidate.id);
    },
  });
  return { watch, sent, asked };
}
const fresh = () => {
  cat.writeCatalogue(DIR, { version: 1 });
  store.setSetting("modelWatch", undefined);
};

test("benchmark evidence moves the cheapest tier in use: recorded, told once, and undone with a revert that sticks", async () => {
  fresh();
  const day1 = watching(fullList(), () => SUPPORTED);
  const result = await day1.watch.run();
  assert.deepEqual(day1.asked, ["qwen/qwen3.8-flash>deepseek/deepseek-v4.1-flash"]);
  assert.equal(result.applied?.to, "qwen/qwen3.8-flash");
  assert.match(result.summary, /moved the haiku tier to qwen\/qwen3\.8-flash on benchmark evidence/);
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash", "the tier runs on the cheaper model from the next run, with no deploy");
  const after = cat.readCatalogue(DIR);
  const record = after.changes!.at(-1)!;
  assert.equal(record.by, "model-check");
  assert.equal(record.kind, "alias");
  assert.equal(record.from, "deepseek/deepseek-v4.1-flash");
  assert.equal(record.why, "The daily check moved the tier on benchmark evidence: against deepseek/deepseek-v4.1-flash, level or ahead on all 2 published benchmarks that report both models (71.2 against 68, 82.1 against 80.3). Names and sources are in the model report for 2026-11-21.", "the recorded reason, which the chief reads, carries numbers and no text from the web");
  assert.equal(record.toPrice!.input, 0.15, "the new price is recorded");
  assert.equal(after.fallbacks!.haiku, "deepseek/deepseek-v4.1-flash", "the model it left is kept, so a refused run is retried on it");
  // Paul is told once, in a few plain sentences, with what the evidence was and how to undo it.
  assert.equal(day1.sent.length, 1);
  const text = day1.sent[0]!;
  assert.match(text, /^Model check for 2026-11-21: the haiku tier, which chief and workers and engineers and maintainer and designer run on, was moved from deepseek\/deepseek-v4\.1-flash to qwen\/qwen3\.8-flash, which costs \$0\.15\/M in and \$0\.50\/M out instead of \$0\.30\/M in and \$1\.20\/M out\./);
  assert.match(text, /level or ahead on all 2 that report both: SWE-bench Verified 71\.2 against 68, MMLU-Pro 82\.1 against 80\.3\./);
  assert.match(text, /Tell Marlo to revert the haiku tier if you want the old model back\.$/);
  assert.ok(!text.includes("—"), "no em dash");
  assert.ok(!/\.md\b/.test(text), "no file name a chat app would turn into a web link");
  const report = fs.readFileSync(path.join(DIR, "model-watch", "2026-11-21.md"), "utf8");
  assert.match(report, /## Benchmark evidence\nThe haiku tier was moved from deepseek\/deepseek-v4\.1-flash to qwen\/qwen3\.8-flash today/);
  assert.match(report, /Searched exa for "qwen3\.8-flash vs deepseek-v4\.1-flash benchmark comparison": 5 results\./);
  assert.match(report, /MMLU-Pro: 82\.1 \(https:\/\/a\.example\/qwen\) against 80\.3 \(https:\/\/b\.example\/deepseek\)\./);
  assert.match(report, /chief: haiku → qwen\/qwen3\.8-flash/, "the report describes what is in force after the move");
  assert.match(report, /The only change made by this check was the move above/);

  // Paul undoes it. The model is never taken up again, whatever the evidence says later.
  const back = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { alias: "haiku" });
  assert.match(back, /haiku tier is back on deepseek\/deepseek-v4\.1-flash/);
  const later = watching(fullList(), () => SUPPORTED, at("2026-12-20T09:30:00Z"));
  const again = await later.watch.run();
  assert.deepEqual(later.asked, [], "a model a change was undone from is not even looked up");
  assert.equal(again.applied, undefined);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash");
  assert.equal(later.sent.length, 0);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", "2026-12-20.md"), "utf8"), /qwen\/qwen3\.8-flash: A change to this model was undone before, so it is not taken up again\./);
  fresh();
});

test("a candidate the evidence does not support is left, silently, and is not searched for again every morning", async () => {
  fresh();
  const day1 = watching(fullList(), () => UNSUPPORTED);
  const first = await day1.watch.run();
  assert.equal(first.applied, undefined);
  assert.match(first.summary, /the evidence did not support a move/);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash");
  assert.equal(day1.sent.length, 0, "no daily note");
  assert.deepEqual(store.settings().modelWatch?.looked, { "qwen/qwen3.8-flash>deepseek/deepseek-v4.1-flash": "2026-11-21" });
  // The next morning: no search, no message.
  const day2 = watching(fullList(), () => SUPPORTED, at("2026-11-22T09:30:00Z"));
  await day2.watch.run();
  assert.deepEqual(day2.asked, [], "looked up yesterday, so not again today");
  assert.equal(day2.sent.length, 0);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", "2026-11-22.md"), "utf8"), /Looked up on 2026-11-21 and not supported; it is looked up again after 7 days\./);
  // A week on it is looked up again, and benchmarks that have appeared since move the tier.
  const day8 = watching(fullList(), () => SUPPORTED, at("2026-11-28T09:30:00Z"));
  const moved = await day8.watch.run();
  assert.deepEqual(day8.asked, ["qwen/qwen3.8-flash>deepseek/deepseek-v4.1-flash"]);
  assert.equal(moved.applied?.to, "qwen/qwen3.8-flash");
  assert.equal(store.settings().modelWatch?.looked, undefined, "a candidate that was taken up is no longer waiting");
  fresh();
});

test("a free model is never a candidate, however the list prices it", async () => {
  fresh();
  const FREE = row("inclusionai/ling-3.2-flash:free", "0", "0", true, 1000000);
  const ZERO = row("vendor/costs-nothing", "0", "0", true, 1000000);
  const only = watching([DEEPSEEK, GLM, KIMI, FREE, ZERO], () => SUPPORTED);
  const result = await only.watch.run();
  assert.equal(result.recommend, false, "with only free models cheaper, there is nothing to consider");
  assert.deepEqual(only.asked, []);
  assert.equal(only.sent.length, 0);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash");
  const report = fs.readFileSync(path.join(DIR, "model-watch", "2026-11-21.md"), "utf8");
  assert.match(report, /chief: haiku → deepseek\/deepseek-v4\.1-flash.*\n  No cheaper tool-capable alternative today\./);
  assert.match(report, /inclusionai\/ling-3\.2-flash:free — \$0\.00\/M in, \$0\.00\/M out, context 1000000 \(free: rate-limited for the whole account, never a candidate\)/);
  // Beside a paid candidate, the free ones are still passed over and the paid one is what is looked up.
  store.setSetting("modelWatch", undefined);
  const mixed = watching([...fullList(), FREE, ZERO], () => UNSUPPORTED);
  await mixed.watch.run();
  assert.deepEqual(mixed.asked, ["qwen/qwen3.8-flash>deepseek/deepseek-v4.1-flash"]);
  fresh();
});

test("candidates are looked up cheapest first, three a day at most, and the first one supported is taken", async () => {
  fresh();
  const cheaper = [row("a/one", "0.00000005", "0.0000001"), row("b/two", "0.00000005", "0.0000002"), row("c/three", "0.00000005", "0.0000003"), row("d/four", "0.00000005", "0.0000004")];
  const none = watching([...fullList(), ...cheaper], () => UNSUPPORTED);
  await none.watch.run();
  assert.deepEqual(none.asked.map((a) => a.split(">")[0]), ["a/one", "b/two", "c/three"], "three lookups, cheapest first");
  // The next day the three already looked up are skipped, and the next cheapest get their turn.
  const next = watching([...fullList(), ...cheaper], (id) => (id === "qwen/qwen3.8-flash" ? SUPPORTED : UNSUPPORTED), at("2026-11-22T09:30:00Z"));
  const result = await next.watch.run();
  assert.deepEqual(next.asked.map((a) => a.split(">")[0]), ["d/four", "qwen/qwen3.8-flash"]);
  assert.equal(result.applied?.to, "qwen/qwen3.8-flash", "the first candidate the evidence supports is taken, not the cheapest on the list");
  fresh();
});

test("a tier the check has just moved is left alone for a week, and a tier the deploy pins is never looked at", async () => {
  fresh();
  const day1 = watching(fullList(), () => SUPPORTED);
  await day1.watch.run();
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash");
  const EVEN_CHEAPER = row("x/cheaper-still", "0.00000005", "0.0000001", true, 256000);
  const day2 = watching([...fullList(), EVEN_CHEAPER], () => SUPPORTED, at("2026-11-22T09:30:00Z"));
  const held = await day2.watch.run();
  assert.deepEqual(day2.asked, [], "no lookup the day after a move");
  assert.equal(held.applied, undefined);
  assert.equal(day2.sent.length, 0);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", "2026-11-22.md"), "utf8"), /The check moved the haiku tier on 2026-11-21, and leaves it alone for 7 days after a move\./);
  const day9 = watching([...fullList(), EVEN_CHEAPER], () => UNSUPPORTED, at("2026-11-29T09:30:00Z"));
  await day9.watch.run();
  assert.deepEqual(day9.asked, ["x/cheaper-still>qwen/qwen3.8-flash"], "after a week the tier is looked at again, against the model now in force");
  fresh();
  // The deploy's own variable outranks the catalogue, so there is nothing the check could move.
  config.openrouter.models.haiku = "deepseek/deepseek-v4.1-flash";
  const pinned = watching(fullList(), () => SUPPORTED);
  const result = await pinned.watch.run();
  config.openrouter.models.haiku = "";
  assert.deepEqual(pinned.asked, []);
  assert.equal(result.applied, undefined);
  assert.equal(pinned.sent.length, 0);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", "2026-11-21.md"), "utf8"), /OPENROUTER_HAIKU_MODEL is set in the deploy, so the check cannot move the haiku tier and looked nothing up\./);
  fresh();
});

test("a stronger tier is never traded down, and a day with a move and a broken model says both", async () => {
  fresh();
  // As deployed: engineers on sonnet, the maintainer on opus. The engineers' model has an alternative
  // well under its own price (and above the cheap tier's). It is listed and never looked up.
  const deployed = () => {
    cat.writeCatalogue(DIR, { version: 1, roles: { engineer: "sonnet", maintainer: "opus" } });
    cat.applyCatalogueRoles(store, DIR);
  };
  deployed();
  const day = watching([...fullList(), row("cheap/coder", "0.0000008", "0.000003")], () => SUPPORTED);
  await day.watch.run();
  assert.deepEqual(day.asked, ["qwen/qwen3.8-flash>deepseek/deepseek-v4.1-flash"], "only the cheapest tier in use is looked at");
  assert.equal(llm.openrouterModels().sonnet, "z-ai/glm-5.3", "the engineers' tier has not moved");
  assert.match(day.sent[0]!, /the haiku tier, which chief and workers and designer run on, was moved/);
  assert.match(fs.readFileSync(path.join(DIR, "model-watch", "2026-11-21.md"), "utf8"), /engineers: sonnet → z-ai\/glm-5\.3 .*\n  Cheaper on price alone: .*Listed, not recommended: this tier is bought for strength/);
  fresh();
  deployed();
  // The maintainer's model has lost its tools the same morning the cheap tier is moved.
  const both = watching([DEEPSEEK, QWEN, GLM, row("moonshotai/kimi-k3.1-pro", "0.000002", "0.00001", false)], () => SUPPORTED);
  const result = await both.watch.run();
  assert.equal(result.applied?.to, "qwen/qwen3.8-flash");
  assert.equal(result.flagged, true);
  assert.equal(both.sent.length, 2, "one message for the move, one for the broken model");
  assert.match(both.sent[0]!, /was moved from deepseek\/deepseek-v4\.1-flash to qwen\/qwen3\.8-flash/);
  assert.match(both.sent[1]!, /moonshotai\/kimi-k3\.1-pro (?:has|and others have) failed the check/);
  fresh();
  cat.applyCatalogueRoles(store, DIR);
  assert.equal(config.models.engineer, "haiku", "the config overlay is put back for later tests");
});
