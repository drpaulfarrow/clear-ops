import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-depth-"));
process.env.REPO_DIR = path.join(process.env.DATA_DIR, "product-checkout");
process.env.SELF_REPO_DIR = path.join(process.env.DATA_DIR, "self-checkout");
process.env.PRODUCT_REPO = "example/clear-exchange";

const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { workerSpec, JOB_KINDS, detectDepth, runLimits, DEEP_RESEARCH_NOTE, RESEARCH_SIZING } = await import("../src/agents.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-depth-store-")));
  const runs: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    return { text: "Report.\n\n<message_to_paul>Done.</message_to_paul>" };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  return { store, jobs, runs };
}

test("the research prompt no longer caps the saved report, and asks for an executive summary on deep work", () => {
  const p = workerSpec("research").prompt;
  assert.doesNotMatch(p, /at most \d+ words/i, "the saved report has no word cap");
  assert.doesNotMatch(p, /\b\d{3,}\s+words\b/i);
  assert.ok(p.includes(RESEARCH_SIZING));
  assert.match(p, /no word limit/);
  assert.match(p, /executive summary at the top/);
  assert.match(p, /Do not stop early or hand back a partial report/);
  // The chat message rule is unchanged: still three or four plain sentences.
  assert.match(p, /<message_to_paul>/);
  assert.match(p, /three or four/);
});

test("every worker prompt names the real local paths of both repositories", () => {
  for (const kind of JOB_KINDS) {
    for (const target of ["product", "self"] as const) {
      const p = workerSpec(kind, target).prompt;
      assert.ok(p.includes(config.repoDir), `${kind}/${target} is told the product checkout path`);
      assert.ok(p.includes(config.selfRepoDir), `${kind}/${target} is told the workforce checkout path`);
      assert.ok(p.includes("example/clear-exchange"), `${kind}/${target} is told the product's GitHub slug`);
    }
  }
});

test("research depth is read from the brief when the chief does not set it", () => {
  for (const b of ["Deep market and competitor research", "An in-depth look at TollBit", "Comprehensive landscape of AI licensing deals", "A thorough multi-part study"]) {
    assert.equal(detectDepth(b), "deep", b);
  }
  for (const b of ["What did SPUR announce this week?", "Find TollBit's pricing page"]) assert.equal(detectDepth(b), "standard", b);
});

test("deep research gets more turns and a larger, configurable budget; other kinds keep their limits", () => {
  const std = runLimits("research", "standard");
  const deep = runLimits("research", "deep");
  assert.ok(deep.maxTurns > std.maxTurns);
  assert.ok(std.maxTurns >= 40, "standard research never drops below the old limit");
  assert.equal(deep.maxBudgetUsd, config.deepResearchBudgetUsd);
  assert.ok(config.deepResearchBudgetUsd > config.jobBudgetUsd);
  assert.equal(std.maxBudgetUsd, config.jobBudgetUsd);
  assert.deepEqual(runLimits("engineer"), { maxTurns: 200, maxBudgetUsd: config.engineerBudgetUsd });
  assert.deepEqual(runLimits("maintain"), { maxTurns: 80, maxBudgetUsd: config.engineerBudgetUsd });
  assert.deepEqual(runLimits("design"), { maxTurns: 80, maxBudgetUsd: config.design.budgetUsd });
  assert.deepEqual(runLimits("write", "deep"), { maxTurns: 40, maxBudgetUsd: config.jobBudgetUsd }, "depth only applies to research");
  for (const kind of JOB_KINDS) assert.ok(Number.isFinite(runLimits(kind, "deep").maxBudgetUsd), `${kind} is always capped`);
});

test("a deep research job runs with the deep limits and note; a standard one without", async () => {
  const { store, jobs, runs } = setup();
  const deep = jobs.start("research", "Market map", FOUNDER, "product", undefined, { depth: "deep" });
  const quick = jobs.start("research", "SPUR news this week", FOUNDER);
  await waitFor(() => runs.length === 2 && store.getJob(deep.id)!.status === "done" && store.getJob(quick.id)!.status === "done");
  const d = runs.find((r) => r.prompt.startsWith("Market map"))!;
  const q = runs.find((r) => r.prompt.startsWith("SPUR news"))!;
  assert.equal(store.getJob(deep.id)!.depth, "deep");
  assert.equal(store.getJob(quick.id)!.depth, "standard");
  assert.ok(d.prompt.includes(DEEP_RESEARCH_NOTE));
  assert.ok(!q.prompt.includes(DEEP_RESEARCH_NOTE));
  assert.deepEqual([d.maxTurns, d.maxBudgetUsd], [runLimits("research", "deep").maxTurns, config.deepResearchBudgetUsd]);
  assert.deepEqual([q.maxTurns, q.maxBudgetUsd], [runLimits("research", "standard").maxTurns, config.jobBudgetUsd]);
});

test("an unlabelled research brief that asks for depth runs deep; other kinds never carry a depth", async () => {
  const { store, jobs, runs } = setup();
  const r = jobs.start("research", "Deep competitor research on content licensing marketplaces", FOUNDER);
  const w = jobs.start("write", "A pitch", FOUNDER, "product", undefined, { depth: "deep" });
  await waitFor(() => runs.length === 2 && store.getJob(w.id)!.status === "done");
  assert.equal(store.getJob(r.id)!.depth, "deep");
  assert.equal(store.getJob(w.id)!.depth, undefined);
  assert.ok(!runs.find((x) => x.prompt.startsWith("A pitch"))!.prompt.includes(DEEP_RESEARCH_NOTE));
});
