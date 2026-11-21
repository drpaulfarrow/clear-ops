import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-model-ops-runtime-"));
// The runtime fallback is an OpenRouter path, so the tests run in OpenRouter mode. This machine's
// shell can carry the live deploy's own variables; the tests speak of the code's defaults.
process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
for (const k of ["LLM_PROVIDER", "CHIEF_MODEL", "WORKER_MODEL", "ENGINEER_MODEL", "MAINTAINER_MODEL", "DESIGN_MODEL", "EA_MODEL", "OPENROUTER_HAIKU_MODEL", "OPENROUTER_SONNET_MODEL", "OPENROUTER_OPUS_MODEL", "OPENROUTER_FABLE_MODEL", "OPENROUTER_PRICES"]) delete process.env[k];

/**
 * The availability fallback's runtime half (src/jobs.ts, engageRunFallback in src/model-ops.ts): a
 * run whose model OpenRouter no longer offers, the error a withdrawn model produces, is retried at
 * once on the tier's recorded previous model. The move is engaged in the catalogue, recorded like
 * any change (by "runtime-fallback") and the fallback is spent, so the retry happens once, never in
 * a loop. With no fallback recorded the job fails exactly as it did before, and nothing else
 * (credit, a rejected key, rate limits, a run pinned to a model by its id) ever engages a fallback.
 * A role change records the role's own previous tier the same way, so a role-only decision is as
 * protected as a tier one: the retry runs on it, the overlay is restored, and the role change the
 * fallback superseded is marked undone.
 */
const { config } = await import("../src/config.js");
const llm = await import("../src/llm.js");
const cat = await import("../src/catalogue.js");
const ops = await import("../src/model-ops.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunOptions, RunResult } from "../src/agents.js";

const DIR = config.dataDir;
const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The error text OpenRouter shapes when a model has been withdrawn: a 404 that is not credit, auth or rate. */
const WITHDRAWN = { kind: "api", detail: 'API Error: 404 {"type":"error","error":{"type":"api_error","message":"No allowed providers are available for the selected model"}}' } as const;

/** A runner that answers from a script, one result per call, recording what each call was asked. */
function scripted(results: Array<() => RunResult>) {
  const asked: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    asked.push(o);
    const next = results.shift();
    if (!next) throw new Error("the runner was called more often than the test expected");
    return next();
  };
  return { runner, asked };
}

test("only the provider saying the model no longer exists counts as a withdrawal", () => {
  assert.equal(ops.isWithdrawnModelFailure(WITHDRAWN), true);
  assert.equal(ops.isWithdrawnModelFailure({ kind: "api", detail: "API Error: 404 This model does not exist or you do not have access to it." }), true);
  assert.equal(ops.isWithdrawnModelFailure({ kind: "api", detail: "API Error: 400 not a valid model: qwen/qwen3.8-flash" }), true);
  assert.equal(ops.isWithdrawnModelFailure({ kind: "credit", detail: "Credit balance is too low" }), false, "credit is not a withdrawal");
  assert.equal(ops.isWithdrawnModelFailure({ kind: "auth", detail: "invalid x-api-key" }), false, "a rejected key is not a withdrawal");
  assert.equal(ops.isWithdrawnModelFailure({ kind: "rate_limit", detail: "API Error: 429 rate_limit_error" }), false, "a rate limit is not a withdrawal");
  assert.equal(ops.isWithdrawnModelFailure({ kind: "api", detail: "API Error: 500 internal error" }), false, "a generic API error is not a withdrawal");
});

test("a run whose model was withdrawn is retried on the tier's recorded previous model", async () => {
  cat.writeCatalogue(DIR, {
    version: 1,
    aliases: { haiku: "qwen/qwen3.8-flash" },
    prices: { "qwen/qwen3.8-flash": { input: 0.15, output: 0.5, cacheRead: 0.15, cacheWrite: 0.15 } },
    fallbacks: { haiku: "deepseek/deepseek-v4.1-flash" },
  });
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash");
  const { runner, asked } = scripted([() => ({ text: "", error: { ...WITHDRAWN } }), () => ({ text: "The analysis, done." })]);
  const store = new Store(DIR);
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const job = jobs.start("analyse", "Look at the outputs and say what the last job found.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "done");
  assert.equal(asked.length, 2, "the run was retried exactly once");
  // The catalogue engaged the recorded previous model, recorded the move and spent the fallback.
  const after = cat.readCatalogue(DIR);
  assert.equal(llm.openrouterModels().haiku, "deepseek/deepseek-v4.1-flash", "the tier runs on its previous model again, with no deploy");
  assert.equal(after.aliases!.haiku, "deepseek/deepseek-v4.1-flash");
  assert.equal(after.fallbacks, undefined, "the fallback is spent, so the retry can never loop");
  const record = after.changes!.find((c) => c.kind === "fallback")!;
  assert.equal(record.by, "runtime-fallback");
  assert.equal(record.from, "qwen/qwen3.8-flash");
  assert.equal(record.to, "deepseek/deepseek-v4.1-flash");
  assert.match(record.why, /was refused by OpenRouter mid-run/, "the reason is recorded");
  // The saved report says the job survived a vanished model rather than hiding it.
  const output = fs.readFileSync(store.outputPath(job.id), "utf8");
  assert.match(output, /had been withdrawn from OpenRouter, so the run was retried once on its recorded previous model \(deepseek\/deepseek-v4\.1-flash\)/);
  cat.writeCatalogue(DIR, { version: 1 });
});

test("with no fallback recorded a withdrawn model fails the job as before", async () => {
  cat.writeCatalogue(DIR, { version: 1, aliases: { haiku: "qwen/qwen3.8-flash" } });
  const { runner, asked } = scripted([() => ({ text: "", error: { ...WITHDRAWN } }), () => ({ text: "never reached" })]);
  const store = new Store(DIR);
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const job = jobs.start("analyse", "Another look.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  assert.equal(asked.length, 1, "no recorded previous model means no retry");
  const after = cat.readCatalogue(DIR);
  assert.equal(after.aliases!.haiku, "qwen/qwen3.8-flash", "nothing was changed");
  assert.ok(!after.changes?.some((c) => c.kind === "fallback"), "no fallback move was recorded");
  cat.writeCatalogue(DIR, { version: 1 });
});

test("a credit failure never engages the fallback, however cheap the previous model", async () => {
  cat.writeCatalogue(DIR, {
    version: 1,
    aliases: { haiku: "qwen/qwen3.8-flash" },
    fallbacks: { haiku: "deepseek/deepseek-v4.1-flash" },
  });
  const { runner, asked } = scripted([() => ({ text: "", error: { kind: "credit", detail: "Credit balance is too low. Please top up at openrouter.ai/settings/credits." } }), () => ({ text: "never reached" })]);
  const store = new Store(DIR);
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const job = jobs.start("analyse", "A third look.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  assert.equal(asked.length, 1, "an account-wide failure is not a withdrawal, so nothing is retried");
  assert.equal(llm.openrouterModels().haiku, "qwen/qwen3.8-flash", "the catalogue is untouched");
  cat.writeCatalogue(DIR, { version: 1 });
});

/** OpenRouter's public model list, faked: enough of it for a role change to be applied live. */
function modelsBody(data: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}
const row = (id: string, prompt: string, completion: string) => ({
  id,
  name: id,
  context_length: 128000,
  pricing: { prompt, completion },
  supported_parameters: ["tools", "max_tokens"],
});
const liveList = () => [
  row("deepseek/deepseek-v4.1-flash", "0.0000003", "0.0000012"),
  row("z-ai/glm-5.3", "0.0000014", "0.0000044"),
  row("qwen/qwen3.8-flash", "0.00000015", "0.0000005"),
  row("moonshotai/kimi-k3.1-pro", "0.000002", "0.00001"),
];

test("a role change's recorded previous tier is engaged when the role's model is withdrawn mid-run", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  // Start from only a role change: the workers move to the sonnet tier (whose model OpenRouter then
  // refuses mid-run) and no tier fallback is recorded, so only the role's own previous tier can save
  // the run.
  const store = new Store(DIR);
  await ops.applyModelChange(
    { store, fetch: (async () => Promise.resolve(modelsBody(liveList()))) as typeof fetch, now: () => new Date("2026-11-21T09:30:00Z") },
    { role: "worker", to: "sonnet", why: "Paul wants the workers on the stronger tier" },
  );
  assert.equal(config.models.worker, "sonnet");
  const applied = cat.readCatalogue(DIR);
  assert.equal(applied.roles!.worker, "sonnet");
  assert.equal(applied.roleFallbacks!.worker, "haiku", "the tier the role leaves is recorded as the role's own fallback");
  assert.equal(applied.fallbacks, undefined, "no tier fallback is in play: this is the role-only case");
  const { runner, asked } = scripted([() => ({ text: "", error: { ...WITHDRAWN } }), () => ({ text: "The analysis, done." })]);
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const job = jobs.start("analyse", "A role-change look at the outputs.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "done");
  assert.equal(asked.length, 2, "the run was retried exactly once");
  assert.equal(asked[1]!.model, "haiku", "the retry runs on the role's recorded previous tier");
  const after = cat.readCatalogue(DIR);
  assert.equal(after.roles!.worker, "haiku", "the role overlay is restored, so later runs are on the previous tier too");
  assert.equal(after.roleFallbacks, undefined, "the role fallback is spent, so the retry can never loop");
  const record = after.changes!.find((c) => c.kind === "fallback")!;
  assert.equal(record.by, "runtime-fallback");
  assert.equal(record.target, "worker", "the move is recorded against the role, whose decision it undoes");
  assert.equal(record.from, "z-ai/glm-5.3");
  assert.equal(record.to, "deepseek/deepseek-v4.1-flash");
  assert.match(record.why, /was refused by OpenRouter mid-run/, "the reason is recorded");
  const superseded = after.changes!.find((c) => c.kind === "role")!;
  assert.ok(superseded.reverted, "the role change that put the workers on the vanished model is marked undone");
  const output = fs.readFileSync(store.outputPath(job.id), "utf8");
  assert.match(output, /had been withdrawn from OpenRouter, so the run was retried once on its recorded previous model \(deepseek\/deepseek-v4\.1-flash\)/);
  cat.writeCatalogue(DIR, { version: 1 });
  cat.applyCatalogueRoles(store, DIR);
  assert.equal(config.models.worker, "haiku", "the config overlay is put back for later tests");
});

test("a role fallback is spent, so a role's withdrawn model never retries twice", async () => {
  cat.writeCatalogue(DIR, { version: 1 });
  const store = new Store(DIR);
  await ops.applyModelChange(
    { store, fetch: (async () => Promise.resolve(modelsBody(liveList()))) as typeof fetch, now: () => new Date("2026-11-21T09:30:00Z") },
    { role: "worker", to: "sonnet", why: "Paul wants the workers on the stronger tier" },
  );
  // The retry itself is refused the same way: the fallback was spent by the first engagement, so the
  // job fails honestly after exactly one retry rather than looping.
  const { runner, asked } = scripted([() => ({ text: "", error: { ...WITHDRAWN } }), () => ({ text: "", error: { ...WITHDRAWN } }), () => ({ text: "never reached" })]);
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const job = jobs.start("analyse", "A role-change look that fails twice.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  assert.equal(asked.length, 2, "one retry only: the role fallback was spent by the first engagement");
  const after = cat.readCatalogue(DIR);
  assert.equal(after.changes!.filter((c) => c.kind === "fallback").length, 1, "exactly one fallback move was recorded");
  assert.equal(after.roleFallbacks, undefined);
  cat.writeCatalogue(DIR, { version: 1 });
  cat.applyCatalogueRoles(store, DIR);
});
