import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-model-ops-direct-"));
delete process.env.OPENROUTER_API_KEY;
// The deploy itself points the chief at a full OpenRouter model id rather than a tier (CHIEF_MODEL
// and friends take ids as well as aliases): a catalogue change to such a role must apply, and a
// revert must put the deployed id back, which it does by removing the catalogue's role overlay.
process.env.CHIEF_MODEL = "vendor/direct-model";
for (const k of ["WORKER_MODEL", "ENGINEER_MODEL", "MAINTAINER_MODEL", "DESIGN_MODEL", "EA_MODEL", "OPENROUTER_HAIKU_MODEL", "OPENROUTER_SONNET_MODEL", "OPENROUTER_OPUS_MODEL", "OPENROUTER_FABLE_MODEL", "OPENROUTER_PRICES", "LLM_PROVIDER"]) delete process.env[k];
// The deploy points the workers at a direct id too, so the runtime fallback can be exercised for a
// role change whose recorded previous model is a full provider id, not a tier (src/jobs.ts).
process.env.WORKER_MODEL = "vendor/direct-model";

const { config } = await import("../src/config.js");
const llm = await import("../src/llm.js");
const cat = await import("../src/catalogue.js");
const ops = await import("../src/model-ops.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const DIR = config.dataDir;
const store = new Store(DIR);
config.openrouter.apiKey = "sk-or-v1-test";
cat.writeCatalogue(DIR, { version: 1 });

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
const DIRECT = row("vendor/direct-model", "0.0000005", "0.000002");
const DEEPSEEK = row("deepseek/deepseek-v4.1-flash", "0.0000003", "0.0000012");
const GLM = row("z-ai/glm-5.3", "0.0000014", "0.0000044");
const KIMI = row("moonshotai/kimi-k3.1-pro", "0.000002", "0.00001");
const fullList = () => [DIRECT, DEEPSEEK, GLM, KIMI];

const now = () => new Date("2026-11-21T09:30:00Z");
const deps = (fetchImpl: typeof fetch) => ({ store, fetch: fetchImpl, now });

test("a role change from a full provider model id applies and reverts without a deploy", async () => {
  assert.equal(config.models.chief, "vendor/direct-model", "the deploy sets the chief to a direct model id");
  const text = await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "chief", to: "haiku", why: "Paul wants the chief on the cheap tier" });
  assert.match(text, /chief now runs on the haiku tier \(deepseek\/deepseek-v4\.1-flash\)/);
  // The live row the apply already fetched supplies the old price when no configured row exists, so a
  // direct-model role change records both price rows and the delta like any other.
  assert.match(text, /was vendor\/direct-model at \$0\.50\/M in and \$2\.00\/M out, 40% less in and 40% less out/, "the reply shows the old live price and the delta");
  assert.equal(config.models.chief, "haiku");
  const entry = cat.readCatalogue(DIR).changes!.at(-1)!;
  assert.equal(entry.kind, "role");
  assert.equal(entry.from, "vendor/direct-model", "the direct id is recorded, not a tier name");
  assert.equal(entry.fromPrice!.input, 0.5, "the direct model's own live row supplies the old price");
  assert.equal(entry.fromPrice!.output, 2);
  assert.equal(entry.toPrice!.input, 0.3, "the destination tier's model is priced");
  assert.equal(cat.readCatalogue(DIR).roles!.chief, "haiku");
  // The revert restores the deployed direct value by removing the overlay, so no recorded tier has
  // to be re-interpreted and the deploy's own model shows through again.
  const back = await ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "chief" });
  assert.match(back, /chief is back on vendor\/direct-model \(haiku before\)/);
  assert.equal(config.models.chief, "vendor/direct-model");
  assert.equal(cat.readCatalogue(DIR).roles, undefined, "the role overlay is gone, not a guess at a tier");
  // A second revert says there is nothing left to revert.
  await assert.rejects(ops.revertModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "chief" }), /no model change to revert for chief/);
});

test("the catalogue view shows a direct role model as itself, priced where a row exists", () => {
  const view = ops.catalogueView(store);
  assert.match(view, /chief: vendor\/direct-model → vendor\/direct-model — the deploy's own variable/);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash");
});

/** The error text OpenRouter shapes when a model has been withdrawn: a 404 that is not credit, auth or rate. */
const WITHDRAWN = { kind: "api", detail: 'API Error: 404 {"type":"error","error":{"type":"api_error","message":"No allowed providers are available for the selected model"}}' } as const;

test("a role change from a direct model id is retried on that id when the tier's model is withdrawn", async () => {
  // Start from only a role change: the workers move off the deploy's direct id onto the haiku tier,
  // whose model OpenRouter then refuses mid-run. The recorded previous model is the direct id
  // itself, so the retry must run on it and the overlay must be removed, letting the deploy's own
  // value show through again (the same restore a revert does).
  cat.writeCatalogue(DIR, { version: 1 });
  await ops.applyModelChange(deps(async () => Promise.resolve(modelsBody(fullList()))), { role: "worker", to: "haiku", why: "Paul wants the workers on the cheap tier" });
  assert.equal(config.models.worker, "haiku");
  const applied = cat.readCatalogue(DIR);
  assert.equal(applied.roles!.worker, "haiku");
  assert.equal(applied.roleFallbacks!.worker, "vendor/direct-model", "the direct id the role ran on before is recorded as its fallback");
  const asked: RunOptions[] = [];
  const results = [() => ({ text: "", error: { ...WITHDRAWN } }), () => ({ text: "The analysis, done." })];
  const runner: AgentRunner = async (o) => {
    asked.push(o);
    const next = results.shift();
    if (!next) throw new Error("the runner was called more often than the test expected");
    return next();
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const job = jobs.start("analyse", "A direct-model look at the outputs.", "tg:99887766");
  await waitFor(() => store.getJob(job.id)!.status === "done");
  assert.equal(asked.length, 2, "the run was retried exactly once");
  assert.equal(asked[1]!.model, "vendor/direct-model", "the retry runs on the recorded direct model id");
  const after = cat.readCatalogue(DIR);
  assert.equal(after.roles, undefined, "the role overlay is removed, so the deploy's direct id shows through again");
  assert.equal(after.roleFallbacks, undefined, "the role fallback is spent");
  assert.equal(config.models.worker, "vendor/direct-model", "the role runs on the deployed id again, with no deploy");
  const record = after.changes!.find((c) => c.kind === "fallback")!;
  assert.equal(record.target, "worker");
  assert.equal(record.from, "deepseek/deepseek-v4.1-flash");
  assert.equal(record.to, "vendor/direct-model");
  const superseded = after.changes!.find((c) => c.kind === "role")!;
  assert.ok(superseded.reverted, "the role change the fallback superseded is marked undone");
  const output = fs.readFileSync(store.outputPath(job.id), "utf8");
  assert.match(output, /retried once on its recorded previous model \(vendor\/direct-model\)/);
  cat.writeCatalogue(DIR, { version: 1 });
  cat.applyCatalogueRoles(store, DIR);
});
