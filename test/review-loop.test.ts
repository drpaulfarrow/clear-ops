import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-review-"));

const { Store } = await import("../src/store.js");
const { JobRunner, parseReviewVerdicts, findPrUrl, samePr } = await import("../src/jobs.js");
const { MAX_FIX_ROUNDS, REVIEW_VERDICT_RULES, workerSpec } = await import("../src/agents.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const PR = "https://github.com/acme/clear-exchange/pull/12";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * Engineers report the pull request; the maintainer answers with the next scripted verdict.
 * Every run is recorded so tests can read the briefs the loop wrote.
 */
function scripted(maintainerReplies: string[]) {
  const runs: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: maintainerReplies.shift() ?? `REVIEW ${PR}: merged` };
    return { text: `Opened ${PR}. Tests green.` };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-loop-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner);
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  return { runs, store, messenger, jobs, settled };
}

const changes = (why = "the test for the 402 path is missing") => `Blocking: ${why}.\n\nREVIEW ${PR}: changes requested`;

test("the review verdict lines are parsed, and only the forms the maintainer is told to use count", () => {
  const v = parseReviewVerdicts(
    `Report.\nREVIEW ${PR}: merged\n- **REVIEW https://github.com/a/b/pull/3: changes requested**\nREVIEW #4: needs Paul: add the FLY_API_TOKEN secret in Settings.\nreview this: later`,
  );
  assert.deepEqual(v, [
    { pr: PR, outcome: "merged", detail: undefined },
    { pr: "https://github.com/a/b/pull/3", outcome: "changes_requested", detail: undefined },
    { pr: "#4", outcome: "needs_founder", detail: "add the FLY_API_TOKEN secret in Settings." },
  ]);
  assert.equal(findPrUrl(`Done: ${PR}, see CI.`), PR);
  assert.equal(findPrUrl("no pull request"), undefined);
  assert.ok(samePr("#12", PR) && !samePr("#1", PR));
  assert.match(workerSpec("maintain").prompt, /REVIEW <url>: changes requested/);
  assert.ok(workerSpec("maintain", "self").prompt.includes(REVIEW_VERDICT_RULES));
});

test("changes requested on an engineer's pull request start a fix round on the same pull request, which is re-reviewed", async () => {
  const { runs, store, messenger, jobs, settled } = scripted([changes()]);
  const eng = jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", "dc:c:thread-1");
  await waitFor(() => store.allJobs().length === 4 && settled());

  const all = store.allJobs();
  const review1 = all.find((j) => j.kind === "maintain" && j.reviewOf === eng.id)!;
  const fix = all.find((j) => j.fixRound === 1)!;
  const review2 = all.find((j) => j.kind === "maintain" && j.reviewOf === fix.id)!;
  assert.equal(store.getJob(eng.id)!.pr, PR, "the engineer's pull request is read from its report");
  assert.match(review1.brief, new RegExp(`Review the pull request ${PR}`));

  assert.equal(fix.kind, "engineer");
  assert.equal(fix.target, "product");
  assert.equal(fix.pr, PR);
  assert.equal(fix.fixRound, 1);
  assert.equal(fix.replyTo, "dc:c:thread-1", "the fix reports where the original job did");
  assert.match(fix.brief, new RegExp(`existing pull request ${PR}`));
  assert.match(fix.brief, /round 1 of 3/);
  assert.match(fix.brief, /the test for the 402 path is missing/, "the brief carries the review text");
  assert.match(fix.brief, /Do not open a new pull request/);

  assert.match(review2.brief, /updated to address your last review/);
  assert.equal(runs.filter((r) => r.systemPrompt.startsWith("You are the maintainer")).length, 2);
  assert.ok(messenger.sent.some((m) => m.text.includes(`Changes requested on ${PR}. Started Fix round 1: Add the 402 flow · engineer · ${fix.id} to fix them (round 1 of 3`)));
  assert.ok(!messenger.sent.some((m) => m.text.startsWith("Action needed")), "a merged pull request needs nothing from the founder");
});

test("the loop stops after the cap and tells the founder once, in plain English", async () => {
  const { store, messenger, jobs, settled } = scripted(Array.from({ length: MAX_FIX_ROUNDS + 2 }, () => changes()));
  jobs.start("engineer", "Add the 402 flow", FOUNDER, "product");
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.includes("automatic fix rounds")));
  await new Promise((r) => setTimeout(r, 50));

  const engineers = store.allJobs().filter((j) => j.kind === "engineer");
  assert.equal(engineers.length, 1 + MAX_FIX_ROUNDS, "one original job plus three fix rounds, no more");
  assert.deepEqual(engineers.map((j) => j.fixRound ?? 0).sort(), [0, 1, 2, 3]);
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 1 + MAX_FIX_ROUNDS);
  const stuck = messenger.sent.filter((m) => m.text.includes("still not mergeable"));
  assert.equal(stuck.length, 1, "the founder is told exactly once");
  assert.match(stuck[0].text, new RegExp(`${PR} is still not mergeable after 3 automatic fix rounds`));
});

test("a blocker only the founder can clear stops the loop and tells him exactly what to do", async () => {
  const { store, messenger, jobs, settled } = scripted([
    `CI cannot deploy.\nREVIEW ${PR}: needs Paul: add a repository secret named FLY_API_TOKEN under Settings, Secrets and variables, Actions.`,
  ]);
  jobs.start("engineer", "Add continuous deployment", FOUNDER, "product");
  await waitFor(() => settled() && store.allJobs().length === 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.allJobs().filter((j) => j.kind === "engineer").length, 1, "no fix round for a founder-only blocker");
  const asks = messenger.sent.filter((m) => m.text.startsWith("Action needed"));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].text.split("\n")[0], `Action needed from you on ${PR}: add a repository secret named FLY_API_TOKEN under Settings, Secrets and variables, Actions.`);
});

test("a fix round waits its turn behind the repository's running engineering job", async () => {
  // The maintainer finishes only when told, so a second engineer job can take the lock first.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-loopq-")));
  const messenger = new ConsoleMessenger();
  const blockers = new Map<string, () => void>();
  const runner: AgentRunner = async (o) => {
    if (o.systemPrompt.startsWith("You are the maintainer")) {
      await gate;
      return { text: changes() };
    }
    if (o.prompt.startsWith("Other work")) {
      await new Promise<void>((r) => blockers.set("other", r));
      return { text: "Other done, https://github.com/acme/clear-exchange/pull/13" };
    }
    return { text: `Opened ${PR}.` };
  };
  const jobs = new JobRunner(store, messenger, runner);
  jobs.start("engineer", "First", FOUNDER, "product");
  await waitFor(() => store.allJobs().some((j) => j.kind === "maintain"));
  const other = jobs.start("engineer", "Other work", FOUNDER, "product");
  await waitFor(() => blockers.has("other"));
  release();
  await waitFor(() => store.allJobs().some((j) => j.fixRound === 1));
  const fix = store.allJobs().find((j) => j.fixRound === 1)!;
  assert.equal(fix.status, "queued");
  assert.equal(fix.waitingFor, other.id, "the fix respects the one-engineer-per-repository queue");
  blockers.get("other")!();
  await waitFor(() => store.getJob(fix.id)!.status !== "queued");
});

test("other pull requests in the maintainer's report never start fix rounds", async () => {
  const { store, jobs, settled } = scripted([`REVIEW ${PR}: merged\nREVIEW https://github.com/acme/clear-exchange/pull/9: changes requested`]);
  jobs.start("engineer", "Task", FOUNDER, "product");
  await waitFor(() => settled() && store.allJobs().length === 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.allJobs().length, 2);
});

test("an agent-creator's pull request gets fix rounds too, on the workforce repo", async () => {
  const { store, jobs, settled } = scripted([changes("the new kind lacks an invariant test")]);
  jobs.start("create_agent", "an agent that drafts publisher outreach", FOUNDER, "self");
  await waitFor(() => settled() && store.allJobs().length === 4);
  const fix = store.allJobs().find((j) => j.fixRound === 1)!;
  assert.equal(fix.kind, "engineer");
  assert.equal(fix.target, "self");
  assert.equal(fix.pr, PR);
});
