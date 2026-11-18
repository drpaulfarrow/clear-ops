import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-contract-"));
process.env.ALLOWED_TELEGRAM_IDS = "424242";

const { withContract, originalTask, sameBlockers, deadEnds, JobRunner } = await import("../src/jobs.js");
const { workerSpec, CONTRACT_HEADING } = await import("../src/agents.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");

const FOUNDER = "tg:424242";
const PR = "https://github.com/drpaulfarrow/clear-exchange/pull/7";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "contract-store-"));
const settle = () => new Promise((r) => setTimeout(r, 60));

test("the contract rides at the end of the brief, once", () => {
  const b = withContract("Fix the redirect loop.", "a new test reproduces the loop and passes after the fix");
  assert.match(b, /^Fix the redirect loop\.\n\nDone when:\na new test reproduces/);
  assert.equal(withContract(b, "a new test reproduces the loop and passes after the fix"), b);
});

test("the engineer and the maintainer are both held to the contract", () => {
  assert.match(workerSpec("engineer", "product").prompt, /see it fail, then make the change/);
  assert.match(workerSpec("maintain", "product").prompt, /A line that is not met is a blocking issue/);
  assert.equal(CONTRACT_HEADING, "Done when:");
});

test("only an engineer job keeps a contract, and its review quotes it", async () => {
  const store = new Store(tmp());
  const runner = async (o: { systemPrompt: string }) =>
    /You are the maintainer/.test(o.systemPrompt) ? { text: `Fine.\nREVIEW ${PR}: merged` } : { text: `Done. ${PR}` };
  const jobs = new JobRunner(store, new ConsoleMessenger(false), runner as never);
  const r = jobs.start("research", "Look into X", FOUNDER, "product", undefined, { title: "X", doneWhen: "ignored" });
  assert.equal(store.getJob(r.id)?.doneWhen, undefined);
  assert.equal(store.getJob(r.id)?.brief, "Look into X");
  const e = jobs.start("engineer", "Add /version", FOUNDER, "product", undefined, { title: "Version route", doneWhen: "GET /version returns the commit" });
  assert.equal(store.getJob(e.id)?.doneWhen, "GET /version returns the commit");
  await settle();
  await settle();
  const review = store.allJobs().find((j) => j.kind === "maintain");
  assert.ok(review, "a review followed");
  assert.match(review!.brief, /Done when:\nGET \/version returns the commit/);
});

test("a fix round quotes the original task, not the previous fix brief", () => {
  const orig = withContract("Fix the footer", "footer test passes");
  const round1 = `Address the maintainer's review on ${PR} (automatic fix round 1 of 3).\n\nOriginal task:\n${orig}\n\nMaintainer's review (job r1):\nThe test is missing.`;
  assert.equal(originalTask(round1), orig);
  assert.equal(originalTask(orig), orig);
});

const reviewA = `Changes requested. src/auth/refresh.ts line 61 still redirects an expired session to /dashboard instead of /login. The new test test/auth-refresh.test.ts does not exercise the expired cookie path, so it passes before the fix as well. Add an assertion for the expired session and correct the redirect target.\nREVIEW ${PR}: changes requested`;
const reviewA2 = `Changes requested again (head 9f3c2ab). src/auth/refresh.ts line 63 still redirects an expired session to /dashboard instead of /login. The new test test/auth-refresh.test.ts still does not exercise the expired cookie path, so it passes before the fix as well. Add an assertion for the expired session and correct the redirect target.\nREVIEW ${PR}: changes requested`;
const reviewB = `Changes requested. The redirect is now correct, thank you. One new problem: the migration in db/migrations/0042_sessions.sql drops the sessions index, which the brief forbids touching. Revert that file and keep the schema unchanged; nothing else blocks the merge.\nREVIEW ${PR}: changes requested`;

test("two reviews raising the same blockers are recognised; different blockers are not", () => {
  assert.equal(sameBlockers(reviewA, reviewA2), true);
  assert.equal(sameBlockers(reviewA, reviewB), false);
  assert.equal(sameBlockers("short", "short"), false);
});

test("a fix round is told what earlier rounds already tried", () => {
  assert.equal(deadEnds([]), "");
  const t = deadEnds([{ id: "r1", text: reviewA }]);
  assert.match(t, /Already tried: this pull request has been through 1 earlier review\b/);
  assert.match(t, /take a different one/);
  assert.match(t, /Earlier review \(job r1\)/);
});

/**
 * The fix round answering the Nth review, chosen by its own properties: its round number and its
 * brief. Store.allJobs() is Object.values and its order is not guaranteed; a job id that happens to
 * be all digits (about one in seventeen, shortId's six hex characters) is an integer-like key, which
 * JavaScript orders ahead of every string key, shuffling that job to the front of the array. This is
 * the old flake in test/contract.test.ts (CI run 44271905913), demonstrated deterministically below.
 */
const roundFix = (jobs: ReturnType<Store["allJobs"]>, round: number) => jobs.find((j) => j.kind === "engineer" && j.fixRound === round);

test("an all-digit job id shuffles store order: order-based selection reads the wrong fix round, semantic selection the intended one", () => {
  const orig = withContract("Fix the redirect loop", "expired session goes to /login");
  const lead = (round: number) =>
    `Address the maintainer's review on the existing pull request ${PR} (automatic fix round ${round} of 3). Check out that pull request's branch, bring it up to date with the default branch, fix every blocking issue in the review, run the tests and typecheck, push to the same branch and reply to each review comment with gh. Read the review itself with gh pr view ${PR} --comments. Do not open a new pull request.`;
  const round1Brief = `${lead(1)}\n\nOriginal task:\n${orig}\n\nMaintainer's review (job r1):\n${reviewA}`;
  const round2Brief = `${lead(2)}\n\nOriginal task:\n${orig}\n\nMaintainer's review (job r2):\n${reviewB}${deadEnds([{ id: "r1", text: reviewA }])}`;
  const fix = (id: string, fixRound: number, brief: string) => ({
    id, kind: "engineer", target: "product", brief, requestedBy: FOUNDER, replyTo: FOUNDER,
    status: "done", createdAt: new Date().toISOString(), title: `Fix round ${fixRound}: Redirect loop`, fixRound,
  });
  const dir = tmp();
  // Synthetic ids, invented for this demonstration: the round-1 job under the hex id 8301fb, the
  // round-2 job under the all-digit id 276523 (the id shape CI run 44271905913 happened to draw).
  // No such store or job ever existed; both records are fixtures. Round 1 was "created" first, as in
  // the real loop, but its hex key sorts after the round-2 job's integer-like key.
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ jobs: { "8301fb": fix("8301fb", 1, round1Brief), "276523": fix("276523", 2, round2Brief) } }));
  const store = new Store(dir);
  const fixes = store.allJobs().filter((j) => j.kind === "engineer" && j.fixRound);
  assert.equal(fixes.length, 2, "both fix rounds are in the store");
  // The defect, shown not assumed: allJobs() hands the round-2 job back first, so the old
  // order-based selection (fixes[1], the array's second job) reads the round-1 brief, which carries
  // no "Already tried" section. That is exactly what the failed CI run asserted against.
  assert.equal(fixes[0].fixRound, 2, "the all-digit id shuffles its job to the front");
  assert.equal(fixes[1].fixRound, 1, "the old order-based fixes[1] is the round-1 job");
  assert.doesNotMatch(fixes[1].brief, /Already tried/, "the old check read the wrong brief");
  // The semantic selection finds the intended round whatever order the store returns.
  const second = roundFix(fixes, 2);
  assert.ok(second, "the second fix round is found by its own round number");
  assert.match(second.brief, /Already tried: this pull request has been through 1 earlier review/);
  assert.match(second.brief, /Original task:\nFix the redirect loop\n\nDone when:\nexpired session goes to \/login\n\nMaintainer's review/);
  assert.equal(roundFix(fixes, 1)?.brief, round1Brief, "the first fix round is found the same way");
});

test("the same blockers twice stop the fix loop early and go to Paul; new blockers start another round", async () => {
  for (const [second, stops] of [[reviewA2, true], [reviewB, false]] as const) {
    const store = new Store(tmp());
    const messenger = new ConsoleMessenger(false);
    let reviews = 0;
    const runner = async (o: { systemPrompt: string }) => {
      if (/You are the maintainer/.test(o.systemPrompt)) return { text: ++reviews === 1 ? reviewA : reviews === 2 ? second : `Good.\nREVIEW ${PR}: merged` };
      return { text: `Pushed. ${PR}` };
    };
    const jobs = new JobRunner(store, messenger, runner as never);
    jobs.start("engineer", "Fix the redirect loop", FOUNDER, "product", undefined, { title: "Redirect loop", doneWhen: "expired session goes to /login" });
    for (let i = 0; i < 100; i++) {
      await settle();
      if (store.allJobs().every((j) => j.status === "done" || j.status === "failed") && (stops ? /is stuck/.test(messenger.sent.map((m) => m.text).join("\n")) : reviews >= 3)) break;
    }
    await settle();
    const fixes = store.allJobs().filter((j) => j.kind === "engineer" && j.fixRound);
    const said = messenger.sent.map((m) => m.text).join("\n");
    if (stops) {
      assert.equal(fixes.length, 1, "only the first fix round ran");
      assert.match(said, /is stuck: the last two reviews raised the same blocking issues/);
    } else {
      assert.equal(fixes.length, 2, "a second fix round ran");
      // Selected semantically (roundFix above), never by array position: allJobs() order is not
      // guaranteed, and an all-digit job id shuffles its job to the front (see the demonstration test).
      const second = roundFix(fixes, 2);
      assert.ok(second, "the second fix round is found by its round number, not the store's order");
      assert.match(second.brief, /Already tried: this pull request has been through 1 earlier review/);
      assert.match(second.brief, /Original task:\nFix the redirect loop\n\nDone when:\nexpired session goes to \/login\n\nMaintainer's review/);
      assert.doesNotMatch(said, /is stuck/);
    }
  }
});
