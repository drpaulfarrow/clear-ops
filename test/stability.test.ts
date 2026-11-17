import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-stability-"));
delete process.env.SELF_MERGE;

const { config } = await import("../src/config.js");
const { providerTools, workerSpec, SELF_MERGE_DENY, ANTHROPIC_ONLY_TOOLS } = await import("../src/agents.js");

const spec = { allowedTools: ["WebSearch", "WebFetch", "Read"], tools: ["WebSearch", "WebFetch", "Read"], disallowedTools: ["Edit"] };

test("on OpenRouter, WebSearch is removed from what a run is offered and explicitly denied", () => {
  const t = providerTools(spec, false, true);
  assert.deepEqual(t.allowedTools, ["WebFetch", "Read"]);
  assert.deepEqual(t.tools, ["WebFetch", "Read"]);
  assert.deepEqual(t.disallowedTools, ["Edit", ...ANTHROPIC_ONLY_TOOLS]);
});

test("a run pinned to Anthropic, or Anthropic mode, keeps WebSearch", () => {
  assert.deepEqual(providerTools(spec, true, true), spec);
  assert.deepEqual(providerTools(spec, false, false), spec);
});

test("SELF_MERGE defaults to paul", () => {
  assert.equal(config.selfMerge, "paul");
});

test("the maintainer on the workforce repository cannot merge and is told to hand it to Paul", () => {
  const s = workerSpec("maintain", "self");
  for (const d of SELF_MERGE_DENY) assert.ok(s.disallowedTools?.includes(d), d);
  assert.match(s.prompt, /never merge here/);
  assert.match(s.prompt, /REVIEW <url>: needs Paul: approve and merge/);
});

test("the maintainer on the product repository still merges as before", () => {
  const s = workerSpec("maintain", "product");
  assert.ok(!s.disallowedTools?.includes("Bash(gh pr merge*)"));
  assert.doesNotMatch(s.prompt, /never merge here/);
});

test("the engineer on the workforce repository is unchanged by the merge gate", () => {
  const s = workerSpec("engineer", "self");
  assert.doesNotMatch(s.prompt, /never merge here/);
});

test("the maintainer has its own model setting", () => {
  assert.equal(typeof config.models.maintainer, "string");
  assert.ok(config.models.maintainer.length > 0);
});

test("LLM_PROVIDER=openrouter with no key refuses every run instead of falling back to Claude", async () => {
  const { provider, openRouterKeyMissing, resolveModel, llmEnv } = await import("../src/llm.js");
  const { sdkRunner } = await import("../src/agents.js");
  const saved = { p: config.llmProvider, k: config.openrouter.apiKey, a: process.env.ANTHROPIC_API_KEY };
  try {
    (config as { llmProvider: string }).llmProvider = "openrouter";
    config.openrouter.apiKey = "";
    process.env.ANTHROPIC_API_KEY = "sk-ant-would-be-used-by-a-fallback";
    assert.equal(provider(), "openrouter");
    assert.equal(openRouterKeyMissing(), true);
    // The aliases still resolve to OpenRouter ids, and the SDK is never pointed at Anthropic.
    assert.notEqual(resolveModel("sonnet"), "sonnet");
    assert.equal(llmEnv().ANTHROPIC_API_KEY, "");
    const r = await sdkRunner({ prompt: "hi", systemPrompt: "x", model: "sonnet", allowedTools: [] } as never);
    assert.equal(r.error?.kind, "auth");
    assert.match(r.error?.detail ?? "", /never fall back to Claude/);
  } finally {
    (config as { llmProvider: string }).llmProvider = saved.p;
    config.openrouter.apiKey = saved.k;
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

test("with no LLM_PROVIDER, the provider is still inferred from the key as before", async () => {
  const { provider } = await import("../src/llm.js");
  const saved = { p: config.llmProvider, k: config.openrouter.apiKey };
  try {
    (config as { llmProvider: string }).llmProvider = "";
    config.openrouter.apiKey = "";
    assert.equal(provider(), "anthropic");
    config.openrouter.apiKey = "sk-or-v1-test";
    assert.equal(provider(), "openrouter");
  } finally {
    (config as { llmProvider: string }).llmProvider = saved.p;
    config.openrouter.apiKey = saved.k;
  }
});
