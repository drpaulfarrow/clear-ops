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
