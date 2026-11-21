import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-catalogue-"));
delete process.env.OPENROUTER_API_KEY;
// This machine may carry the deploy's own model variables; the tests speak of the code's defaults.
for (const k of ["CHIEF_MODEL", "WORKER_MODEL", "ENGINEER_MODEL", "MAINTAINER_MODEL", "DESIGN_MODEL", "EA_MODEL", "OPENROUTER_HAIKU_MODEL", "OPENROUTER_SONNET_MODEL", "OPENROUTER_OPUS_MODEL", "OPENROUTER_FABLE_MODEL", "OPENROUTER_PRICES", "LLM_PROVIDER"]) delete process.env[k];

/**
 * The persisted model catalogue (src/catalogue.ts): a JSON file on the data volume that says which
 * OpenRouter model each tier (haiku, sonnet, opus, fable) maps to, what models cost, and which tier
 * each role runs on. Precedence is the same everywhere: the deploy's own environment variables, then
 * the catalogue, then the code defaults; and for a role, Paul's own app setting (src/live-settings.ts)
 * beats the catalogue. With no file, or an unreadable one, the workforce behaves exactly as it did.
 */
const { config } = await import("../src/config.js");
const llm = await import("../src/llm.js");
const cat = await import("../src/catalogue.js");
const { Store } = await import("../src/store.js");

const DIR = config.dataDir;
const store = new Store(DIR);

test("with no catalogue file the aliases and prices are exactly the deploy's own", () => {
  config.openrouter.apiKey = "sk-or-v1-test";
  assert.deepEqual(llm.openrouterModels(), llm.DEFAULT_OPENROUTER_MODELS);
  assert.deepEqual(llm.unpricedModels(), []);
  for (const id of new Set(Object.values(llm.DEFAULT_OPENROUTER_MODELS))) {
    assert.ok(llm.modelPrices()[id], `${id} is priced`);
  }
  config.openrouter.apiKey = "";
});

test("a catalogue tier mapping sits under the environment override and above the code default", () => {
  config.openrouter.apiKey = "sk-or-v1-test";
  cat.writeCatalogue(DIR, { version: 1, aliases: { haiku: "qwen/qwen3.8-flash" } });
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash", "the catalogue row is used");
  assert.equal(llm.resolveModel("haiku"), "qwen/qwen3.8-flash");
  config.openrouter.models.haiku = "env/deploy-model";
  assert.equal(llm.openrouterModels().haiku, "env/deploy-model", "the deploy's own variable still wins");
  config.openrouter.models.haiku = "";
  cat.writeCatalogue(DIR, { version: 1 });
  assert.equal(llm.openrouterModels().haiku, llm.DEFAULT_OPENROUTER_MODELS.haiku, "an empty catalogue is the default");
  config.openrouter.apiKey = "";
});

test("catalogue prices cover a catalogue model, and the deploy's own price rows still win", () => {
  config.openrouter.apiKey = "sk-or-v1-test";
  cat.writeCatalogue(DIR, {
    version: 1,
    aliases: { haiku: "qwen/qwen3.8-flash" },
    prices: { "qwen/qwen3.8-flash": { input: 0.15, output: 0.5, cacheRead: 0.02, cacheWrite: 0.15 } },
  });
  assert.deepEqual(llm.unpricedModels(), []);
  assert.equal(llm.modelPrices()["qwen/qwen3.8-flash"]!.output, 0.5);
  config.openrouter.prices = JSON.stringify({ "qwen/qwen3.8-flash": { input: 0.15, output: 0.99, cacheRead: 0.02, cacheWrite: 0.15 } });
  assert.equal(llm.modelPrices()["qwen/qwen3.8-flash"]!.output, 0.99, "OPENROUTER_PRICES beats the catalogue row");
  config.openrouter.prices = "";
  cat.writeCatalogue(DIR, { version: 1 });
  config.openrouter.apiKey = "";
});

test("a catalogue role moves that role's tier at run time, under Paul's own app setting", () => {
  cat.writeCatalogue(DIR, { version: 1, roles: { worker: "sonnet" } });
  cat.applyCatalogueRoles(store);
  assert.equal(config.models.worker, "sonnet");
  cat.writeCatalogue(DIR, { version: 1, roles: { designer: "opus" } });
  cat.applyCatalogueRoles(store);
  assert.equal(config.design.model, "opus");
  assert.equal(config.models.worker, "haiku", "a role no longer in the catalogue goes back to the deploy's own tier");
  assert.equal(config.design.model, "opus");
  // Paul's own app setting (src/live-settings.ts) wins over the catalogue.
  cat.writeCatalogue(DIR, { version: 1, roles: { worker: "sonnet" } });
  store.setSetting("live", { models: { worker: "opus" } });
  config.models.worker = "opus";
  cat.applyCatalogueRoles(store);
  assert.equal(config.models.worker, "opus", "the app setting is left alone");
  store.setSetting("live", undefined);
  cat.writeCatalogue(DIR, { version: 1 });
  cat.applyCatalogueRoles(store);
  assert.equal(config.models.worker, "haiku");
  assert.equal(config.design.model, "haiku");
});

test("an unreadable or malformed catalogue is ignored, never fatal", () => {
  config.openrouter.apiKey = "sk-or-v1-test";
  const warnings: string[] = [];
  fs.writeFileSync(path.join(DIR, "model-catalogue.json"), "not json at all");
  assert.deepEqual(cat.readCatalogue(DIR, (w) => warnings.push(w)).aliases, undefined, "a corrupt file reads as empty");
  assert.ok(warnings.length, "a corrupt file is reported once");
  cat.writeCatalogue(DIR, {
    version: 1,
    aliases: { haiku: 123 as unknown as string, sonnet: "fine/model" },
    prices: { "fine/model": { input: -1, output: 0.5, cacheRead: 0.02, cacheWrite: 0.15 }, "bad/model": { input: 1 } },
    roles: { worker: "sonnet", chief: "not-a-tier" as unknown as "sonnet", engineer: 5 as unknown as "sonnet" },
    changes: [{ at: "", kind: "alias", target: "haiku", from: "a", to: "b", why: "c" }],
  });
  const kept = cat.readCatalogue(DIR);
  assert.deepEqual(kept.aliases, { sonnet: "fine/model" }, "bad rows are dropped, good ones kept");
  assert.deepEqual(Object.keys(kept.prices ?? {}), [], "a negative price row is dropped");
  assert.deepEqual(kept.roles, { worker: "sonnet" }, "a role's tier must be a real tier");
  assert.equal(kept.changes, undefined, "a change entry missing its timestamp is dropped");
  assert.equal(llm.openrouterModels().sonnet, "fine/model");
  cat.writeCatalogue(DIR, { version: 1 });
  config.openrouter.apiKey = "";
});

test("the change log is bounded, newest last", () => {
  for (let i = 0; i < cat.MAX_CATALOGUE_CHANGES + 10; i++) {
    cat.recordChange(DIR, { at: new Date(2026, 0, 1, 0, i).toISOString(), by: "chief", kind: "alias", target: "haiku", from: `from-${i}`, to: `to-${i}`, why: `change ${i}` });
  }
  const kept = cat.readCatalogue(DIR).changes!;
  assert.equal(kept.length, cat.MAX_CATALOGUE_CHANGES);
  assert.equal(kept[0]!.to, `to-${10}`, "the oldest are dropped");
  assert.equal(kept[kept.length - 1]!.to, `to-${cat.MAX_CATALOGUE_CHANGES + 9}`, "the newest is last");
  cat.writeCatalogue(DIR, { version: 1 });
});
