import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const E = await import("../src/eval.js");
const T = await import("../src/telemetry.js");
import type { EvalTask } from "../src/eval.js";

const task = (judge: EvalTask["judge"], prompt = "Answer the question."): EvalTask => ({ id: "t1", category: "current-fact", prompt, judge });

test("the shipped eval set is versioned, complete and covers every category", () => {
  const set = E.loadEvalSet(path.resolve("eval", "tasks.v1.json"));
  assert.equal(set.version, "1");
  assert.ok(set.tasks.length >= 30, `expected about thirty tasks, got ${set.tasks.length}`);
  assert.equal(new Set(set.tasks.map((t) => t.id)).size, set.tasks.length, "ids must be unique");
  for (const category of E.EVAL_CATEGORIES) {
    assert.ok(set.tasks.some((t) => t.category === category), `no task covers ${category}`);
  }
  // Every task must be judged by something, and must not depend on Paul's mail, calendar or uploads.
  for (const t of set.tasks) {
    assert.ok(Object.keys(t.judge).length > 0, `${t.id} has no checks`);
    assert.doesNotMatch(JSON.stringify(t), /gmail|calendar|uploads|Connections\.csv/i, `${t.id} must not touch private data`);
  }
  // A broken set is refused rather than half-run.
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-eval-")), "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ tasks: [{ id: "a", category: "nonsense", prompt: "x", judge: { any: ["x"] } }] }));
  assert.throws(() => E.loadEvalSet(bad), /not one of/);
});

test("judging is deterministic, and names the checks that failed without repeating the answer", () => {
  assert.deepEqual(E.judgeAnswer(task({ all: ["spur"], cite: true, maxWords: 20 }), "SPUR is a standard, see https://example.org/spur for detail."), { pass: true, failed: [] });

  const missing = E.judgeAnswer(task({ all: ["spur"], any: ["iab", "tech lab"], cite: true, maxWords: 20 }), "It is a standard for publisher content.");
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.failed, ['missing "spur"', "none of: iab / tech lab", "no link cited"]);
  // The failure record never carries a word of the answer.
  assert.doesNotMatch(JSON.stringify(missing), /publisher content/);

  // Groups: each must be satisfied, so a one-sided answer fails.
  const grouped = task({ anyGroups: [["research"], ["engineer", "maintainer"]] });
  assert.equal(E.judgeAnswer(grouped, "Research, research and designer only.").pass, false);
  assert.equal(E.judgeAnswer(grouped, "Research gets it; the engineer does not.").pass, true);

  // A not-found task: saying so passes; inventing a number fails.
  const nf = task({ notFound: true, forbid: ["per share"] });
  assert.equal(E.judgeAnswer(nf, "I could not find any share price for Clear Exchange: it is not a listed company.").pass, true);
  assert.equal(E.judgeAnswer(nf, "I could not find a listing, but the price is $12.40 per share.").pass, false);

  // Patterns and length.
  const pattern = task({ regex: ["\\bv?\\d+\\.\\d+\\b"], minWords: 3, maxWords: 6 });
  assert.equal(E.judgeAnswer(pattern, "Prebid.js 10.12 shipped today.").pass, true);
  assert.deepEqual(E.judgeAnswer(pattern, "It shipped.").failed, ["no match for /\\bv?\\d+\\.\\d+\\b/", "too short (2 words)"]);
});

test("{{vars}} fill a task's prompt and its checks, so a seeded job can be named", () => {
  assert.equal(E.fillVars("What is job {{jobId}} doing?", { jobId: "16d5d3" }), "What is job 16d5d3 doing?");
  assert.equal(E.fillVars("What is job {{jobId}} doing?", {}), "What is job {{jobId}} doing?");
  const t: EvalTask = { id: "s", category: "job-status", prompt: "What is {{jobId}} doing?", judge: { all: ["{{jobId}}"] } };
  assert.equal(E.judgeAnswer(t, "Job 16d5d3 finished.", { jobId: "16d5d3" }).pass, true);
  assert.equal(E.judgeAnswer(t, "It finished.", { jobId: "16d5d3" }).pass, false);
});

test("the runner scores the set, counts what it cost and stops when the budget is spent", async () => {
  const tasks: EvalTask[] = [
    { id: "a", category: "current-fact", prompt: "A", judge: { all: ["yes"] } },
    { id: "b", category: "drafting", prompt: "B", judge: { all: ["yes"] } },
    { id: "c", category: "own-repo", prompt: "C", judge: { all: ["yes"] } },
  ];
  const answers: Record<string, string> = { A: "yes, here it is", B: "no", C: "yes" };
  const seen: string[] = [];
  const run = await E.runEvalSet({
    tasks,
    version: "9",
    label: "test",
    budgetUsd: 10,
    run: async (t, prompt) => {
      seen.push(prompt);
      return { text: answers[prompt], estimateUsd: 0.05, tokens: { ...T.emptyTotals(), calls: 1, promptTokens: 10, cachedTokens: 30, completionTokens: 4 } };
    },
  });
  assert.deepEqual(seen, ["A", "B", "C"]);
  assert.equal(run.passed, 2);
  assert.equal(run.failed, 1);
  assert.equal(run.passRate, 2 / 3);
  assert.equal(run.estimateUsd, 0.15);
  assert.equal(run.totals.calls, 3);
  assert.equal(run.totals.cachedTokens, 90);
  assert.equal(run.cacheHitRate, 0.75);
  assert.equal(run.tasks.find((t) => t.id === "b")!.pass, false);
  assert.deepEqual(run.tasks.find((t) => t.id === "b")!.failed, ['missing "yes"']);
  // The whole run carries no answer text anywhere.
  assert.doesNotMatch(JSON.stringify(run), /here it is/);
  assert.match(E.evalSummaryLine(run), /test \(set v9\): 2\/3 passed \(67%\), 0 skipped/);
  assert.match(E.evalSummaryLine(run), /internal estimate for comparing runs, not a bill/);
  assert.deepEqual(E.failuresByCategory(run), [
    { category: "current-fact", ran: 1, failed: 0 },
    { category: "own-repo", ran: 1, failed: 0 },
    { category: "drafting", ran: 1, failed: 1 },
  ]);

  // A budget already spent stops the set: the rest are skipped, not run, and do not count as failures.
  const capped = await E.runEvalSet({
    tasks,
    budgetUsd: 0.05,
    run: async (t, prompt) => ({ text: answers[prompt], estimateUsd: 0.05, tokens: T.emptyTotals() }),
  });
  assert.equal(capped.passed, 1);
  assert.equal(capped.skipped, 2);
  assert.equal(capped.tasks[1].skipped, true);
  assert.equal(capped.passRate, 1, "skipped tasks are not counted as failures");
  assert.match(capped.tasks[1].failed[0], /not run/);

  // A task whose run throws fails that task and no other.
  const thrown = await E.runEvalSet({
    tasks,
    run: async (t, prompt) => {
      if (prompt === "B") throw new Error("no credit");
      return { text: answers[prompt] };
    },
  });
  assert.equal(thrown.passed, 2);
  assert.equal(thrown.failed, 1);
  assert.match(thrown.tasks[1].failed[0], /the run threw: no credit/);
});

test("results are written owner-only, and never hold a prompt or an answer", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-eval-out-")), "eval");
  const run = await E.runEvalSet({
    tasks: [{ id: "a", category: "drafting", prompt: "Write a secret-sounding email to sam@acme.com.", judge: { all: ["sam@acme.com"] } }],
    label: "baseline run",
    run: async () => ({ text: "Dear sam@acme.com, the answer is forty two.", estimateUsd: 0.01, tokens: { ...T.emptyTotals(), calls: 1 } }),
  });
  const file = E.writeEvalResult(dir, run);
  assert.ok(file.startsWith(E.evalResultsDir(dir.replace(/\/eval$/, ""))));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /"passRate": 1/);
  assert.match(written, /"estimateUsd": 0\.01/);
  assert.doesNotMatch(written, /forty two|secret-sounding|Dear sam/);
});
