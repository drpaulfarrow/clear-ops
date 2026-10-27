/**
 * Invariants of the workforce. The engineer may add to this file; it may not remove
 * or weaken anything in it. CLAUDE.md states the rule; this file enforces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("only allowlisted numbers are answered", () => {
  const orch = src("orchestrator.ts");
  assert.match(orch, /config\.allowedNumbers\.includes\(from\)/, "the allowlist check must stay in the orchestrator");
});

test("webhook signatures are verified before any message is processed", () => {
  const index = src("index.ts");
  const verifyAt = index.indexOf("verifySignature(");
  const parseAt = index.indexOf("parseInbound(req.body)");
  assert.ok(verifyAt > -1 && parseAt > -1 && verifyAt < parseAt, "verifySignature must run before parseInbound in the POST handler");
});

test("every worker and the chief carry the clean-room rule", () => {
  const agents = src("agents.ts");
  const orch = src("orchestrator.ts");
  assert.match(agents, /const CLEAN_ROOM = /);
  for (const kind of ["research", "write", "engineer", "maintain", "analyse"]) {
    const block = agents.slice(agents.indexOf(`case "${kind}":`));
    const promptEnd = block.indexOf("};");
    assert.match(block.slice(0, promptEnd), /\$\{CLEAN_ROOM\}/, `${kind} prompt must include CLEAN_ROOM`);
  }
  assert.match(orch, /Clean room rule/, "chief prompt must include the clean-room rule");
});

test("the engineer cannot force-push, rewrite shared history or delete recursively", () => {
  const agents = src("agents.ts");
  for (const rule of ['"Bash(rm -rf*)"', '"Bash(git push --force*)"', '"Bash(git push -f*)"', '"Bash(git reset --hard*)"']) {
    assert.ok(agents.includes(rule), `engineer disallowedTools must include ${rule}`);
  }
});

test("only the maintainer merges: engineers cannot merge or push the default branch", () => {
  const agents = src("agents.ts");
  const eng = agents.slice(agents.indexOf('case "engineer":'), agents.indexOf('case "maintain":'));
  for (const rule of ['"Bash(git merge*)"', '"Bash(gh pr merge*)"', '"Bash(git push origin main*)"']) {
    assert.ok(eng.includes(rule), `engineer disallowedTools must include ${rule}`);
  }
  const jobs = src("jobs.ts");
  assert.match(jobs, /job\.kind === "engineer"\)[\s\S]*?this\.start\(\s*"maintain"/, "a maintainer job must follow every engineer job");
});

test("agents run headless: nothing waits on an interactive permission prompt", () => {
  assert.match(src("agents.ts"), /permissionMode: "dontAsk"/);
});

test("spend is capped on every run", () => {
  const jobs = src("jobs.ts");
  const orch = src("orchestrator.ts");
  assert.match(jobs, /maxBudgetUsd:/);
  assert.match(orch, /maxBudgetUsd:/);
});
