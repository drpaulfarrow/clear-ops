import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-llm-"));
delete process.env.OPENROUTER_API_KEY;

const { config, assertProductionConfig } = await import("../src/config.js");
const llm = await import("../src/llm.js");
const { failureReason, failureAction, failureLabel } = await import("../src/failures.js");
const { chiefFailureText } = await import("../src/orchestrator.js");
const { sdkRunner } = await import("../src/agents.js");

const OR_KEY = "sk-or-v1-test";

function useOpenRouter(on: boolean) {
  config.openrouter.apiKey = on ? OR_KEY : "";
}

test("without an OpenRouter key nothing changes: Anthropic, aliases pass through, no env or pricing", () => {
  useOpenRouter(false);
  assert.equal(llm.provider(), "anthropic");
  assert.equal(llm.resolveModel("haiku"), "haiku");
  assert.deepEqual(llm.llmEnv(), {});
  assert.equal(llm.llmManagedSettings(), undefined);
  assert.equal(failureReason({ kind: "credit", detail: "" }), "the Anthropic account is out of credit");
  assert.match(failureAction("credit", ["a1"]), /console\.anthropic\.com/);
});

test("with OPENROUTER_API_KEY the aliases map to OpenRouter models and explicit ids pass through", () => {
  useOpenRouter(true);
  assert.equal(llm.provider(), "openrouter");
  assert.equal(llm.resolveModel("haiku"), llm.DEFAULT_OPENROUTER_MODELS.haiku);
  assert.equal(llm.resolveModel("Opus"), llm.DEFAULT_OPENROUTER_MODELS.opus);
  assert.equal(llm.resolveModel("qwen/qwen3.8-flash"), "qwen/qwen3.8-flash");
  config.openrouter.models.sonnet = "qwen/qwen3.8-flash";
  assert.equal(llm.resolveModel("sonnet"), "qwen/qwen3.8-flash", "OPENROUTER_SONNET_MODEL overrides the default");
  config.openrouter.models.sonnet = "";
  useOpenRouter(false);
});

test("the SDK is pointed at OpenRouter with the documented variables and every internal alias mapped", () => {
  useOpenRouter(true);
  const env = llm.llmEnv();
  assert.equal(env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, OR_KEY);
  assert.equal(env.ANTHROPIC_API_KEY, "", "must be explicitly empty, or the CLI uses Anthropic");
  for (const k of ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    assert.ok(env[k] && !/^claude/.test(env[k]), `${k} is an OpenRouter model, so no call silently goes to Claude`);
  }
  assert.ok(llm.LLM_STRIPPED.includes("OPENROUTER_API_KEY"));
  useOpenRouter(false);
});

test("every default model is priced, so the per-run and daily spend caps are not guesses", () => {
  useOpenRouter(true);
  assert.deepEqual(llm.unpricedModels(), []);
  const overrides = llm.llmManagedSettings()!.modelPricing.overrides;
  for (const id of new Set(Object.values(llm.DEFAULT_OPENROUTER_MODELS))) assert.ok(overrides[id], `${id} has a price row`);
  config.openrouter.models.haiku = "qwen/qwen3.8-flash";
  assert.deepEqual(llm.unpricedModels(), ["qwen/qwen3.8-flash"]);
  assert.match(llm.modelLine(), /No price for qwen\/qwen3\.8-flash/);
  config.openrouter.prices = JSON.stringify({ "qwen/qwen3.8-flash": { input: 0.15, output: 0.5, cacheRead: 0.02, cacheWrite: 0.15 } });
  assert.deepEqual(llm.unpricedModels(), []);
  assert.equal(llm.llmManagedSettings()!.modelPricing.overrides["qwen/qwen3.8-flash"].output, 0.5);
  config.openrouter.models.haiku = "";
  config.openrouter.prices = "";
  useOpenRouter(false);
});

test("bad OPENROUTER_PRICES rows are dropped with a warning, never fatal", () => {
  const warnings: string[] = [];
  assert.deepEqual(llm.parsePrices("not json", (w) => warnings.push(w)), {});
  const rows = llm.parsePrices(JSON.stringify({ a: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 }, b: { input: 1 } }), (w) => warnings.push(w));
  assert.deepEqual(Object.keys(rows), ["a"]);
  assert.equal(warnings.length, 2);
});

test("failure messages name OpenRouter and where to fix it", () => {
  useOpenRouter(true);
  assert.equal(failureReason({ kind: "credit", detail: "" }), "the OpenRouter account is out of credit");
  assert.match(failureAction("credit", ["a1"]), /openrouter\.ai\/settings\/credits/);
  assert.match(failureAction("auth", ["a1"]), /OPENROUTER_API_KEY/);
  assert.equal(failureLabel("credit"), "out of OpenRouter credit");
  assert.match(chiefFailureText({ kind: "credit", detail: "" }), /OpenRouter credit at openrouter\.ai/);
  useOpenRouter(false);
});

test("production config accepts either key and still requires one", () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENROUTER_API_KEY };
  config.channels = [];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(() => assertProductionConfig(), /OPENROUTER_API_KEY or ANTHROPIC_API_KEY/);
  process.env.OPENROUTER_API_KEY = OR_KEY;
  assert.doesNotThrow(() => {
    try {
      assertProductionConfig();
    } catch (e) {
      // With no channels configured the check may still object to that; only the key matters here.
      if (/API_KEY/.test(String(e))) throw e;
    }
  });
  if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.a;
  if (saved.o === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved.o;
});

test("the executive assistant runs on Claude Sonnet on Anthropic directly; follow-up nudges and every other kind do not", () => {
  assert.deepEqual(llm.runRoute({ kind: "ea", title: "Morning brief" }, "haiku"), { model: "sonnet", provider: "anthropic" });
  assert.deepEqual(llm.runRoute({ kind: "ea", title: "Draft nudge 327d31" }, "haiku"), { model: config.models.worker }, "follow-ups go to the open models");
  for (const kind of ["research", "write", "engineer", "maintain", "analyse"]) assert.deepEqual(llm.runRoute({ kind, title: "Anything" }, "haiku"), { model: "haiku" });
  assert.equal(llm.isFollowUpJob({ kind: "ea", title: "Draft nudge about the board" }), false, "only the exact nudge title counts");
});

test("an Anthropic-pinned run never falls back to OpenRouter: no Anthropic key means it fails, before any model call", async () => {
  useOpenRouter(true);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await sdkRunner({ prompt: "read my inbox", systemPrompt: "s", model: "sonnet", provider: "anthropic", allowedTools: [] });
  assert.equal(r.error?.kind, "auth");
  assert.match(r.error!.detail, /runs only on Anthropic/);
  assert.match(llm.modelLine(), /ANTHROPIC_API_KEY is not set, so executive assistant jobs will fail/);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  useOpenRouter(false);
});
