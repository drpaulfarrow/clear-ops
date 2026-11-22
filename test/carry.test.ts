/**
 * Merge and carry (Paul, 22 Nov 2026; src/carry.ts): a review holds a pull request back only for a
 * blocking finding. Smaller findings are merged with, written down as CARRY lines, and handed by the
 * service to the next engineer job on the same repository to fix in its own pull request. Nothing is
 * sent round again, and nothing waits on Paul, for a finding that does not stop the work being used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-carry-"));
delete process.env.AUTO_FIX_ROUNDS;

const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { workerSpec } = await import("../src/agents.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { fixLoopNote } = await import("../src/orchestrator.js");
const carry = await import("../src/carry.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const THREAD = "dc:c:thread-1";
const pr = (n: number) => `https://github.com/acme/clear-exchange/pull/${n}`;

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A workforce whose engineers open the next numbered pull request and whose maintainer says what it is given to say. */
function world(maintainerReplies: string[], engineer?: (o: RunOptions, n: number) => string) {
  const runs: RunOptions[] = [];
  let opened = 0;
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: maintainerReplies.shift() ?? `REVIEW ${pr(opened)}: merged` };
    if (/Address the maintainer's review on the existing pull request/.test(o.prompt)) return { text: `Pushed the fixes to ${pr(opened)}.` };
    opened += 1;
    return { text: engineer ? engineer(o, opened) : `Opened ${pr(opened)}. Tests green.` };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-carry-store-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner);
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  const engineers = () => runs.filter((r) => r.systemPrompt.startsWith("You are a senior engineer"));
  const reviews = () => runs.filter((r) => r.systemPrompt.startsWith("You are the maintainer"));
  const said = () => messenger.sent.map((m) => m.text);
  const held = () => store.settings().carried ?? [];
  return { runs, store, messenger, jobs, settled, engineers, reviews, said, held };
}

const MERGED_WITH_TWO = `Merged at abc1234. Two things I would tidy.

CARRY ${pr(1)}: src/pay.ts: the 402 handler repeats the header parsing in src/headers.ts, so call that instead.
**CARRY <${pr(1)}>: test/pay.test.ts: there is no test for an expired quote, so add one.**
REVIEW ${pr(1)}: merged`;

test("the maintainer's CARRY lines are read, whatever decoration they come in, and nothing else is", () => {
  assert.deepEqual(carry.parseCarryLines(MERGED_WITH_TWO), [
    { pr: pr(1), text: "src/pay.ts: the 402 handler repeats the header parsing in src/headers.ts, so call that instead." },
    { pr: pr(1), text: "test/pay.test.ts: there is no test for an expired quote, so add one." },
  ]);
  assert.deepEqual(carry.parseCarryLines(`- CARRY ${pr(3)}:   spaced   out   text  `), [{ pr: pr(3), text: "spaced out text" }]);
  assert.deepEqual(carry.parseCarryLines("CARRY the bags: to the car\nCARRY #12: no address\nI will carry on.\nCARRY https://example.com/pull/1: not GitHub"), [], "a line with no pull request address is prose");
  assert.equal(carry.parseCarryLines(`CARRY ${pr(1)}: ${"x".repeat(900)}`)[0]!.text.length, carry.CARRY_TEXT_MAX);
});

test("the maintainer is told what blocks a merge and that everything else is carried", () => {
  for (const target of ["product", "self"] as const) {
    const prompt = workerSpec("maintain", target).prompt;
    assert.ok(prompt.includes(carry.MERGE_AND_CARRY_RULE), `the ${target} maintainer carries the rule`);
  }
  const rule = carry.MERGE_AND_CARRY_RULE;
  assert.match(rule, /held back only by a blocking finding/);
  for (const blocking of ["the build, the typecheck, the tests or CI fail", "does not do what its task asked", "breaks something that worked before", "a security problem, or a way to lose or corrupt data", "removes or weakens tests"]) assert.ok(rule.includes(blocking), blocking);
  assert.match(rule, /Do not request changes for a carried finding, and do not hold a merge for one\./);
  assert.match(rule, /CARRY <the pull request's full URL>: <file or area>: <what is wrong and what to do, in one sentence>/);
  assert.match(rule, /one that was not fixed is carried again with a new CARRY line, and is never blocking/);
  const product = workerSpec("maintain", "product").prompt;
  assert.match(product, /If nothing blocking remains: gh pr merge <number> --merge --delete-branch, whatever you are carrying\./);
  assert.match(product, /Never merge a pull request that removes or weakens tests, touches secrets/, "the standards that are never merged are as they were");
});

test("a review that merges with smaller findings stops nothing: they are held, and Paul is told once", async () => {
  const w = world([MERGED_WITH_TWO]);
  w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.store.allJobs().length === 2 && w.settled() && w.said().some((t) => t.includes("held for the next engineer job")));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(w.store.allJobs().map((j) => j.kind).sort(), ["engineer", "maintain"], "no fix round, and nothing else");
  assert.ok(!w.said().some((t) => /asked for changes|Action needed/.test(t)), "nothing is put to Paul to decide");
  const told = w.said().find((t) => t.includes("held for the next engineer job"))!;
  assert.match(told, /2 smaller findings from the review are held for the next engineer job on this repository, to be fixed in its pull request\./);
  assert.ok(!w.said().some((t) => /^\s*\**CARRY /m.test(t)), "the CARRY lines themselves are for the service, not for his chat");
  const review = w.store.allJobs().find((j) => j.kind === "maintain")!;
  assert.deepEqual(
    w.held().map((c) => [c.target, c.pr, c.text, c.review, c.takenBy]),
    [
      ["product", pr(1), "src/pay.ts: the 402 handler repeats the header parsing in src/headers.ts, so call that instead.", review.id, undefined],
      ["product", pr(1), "test/pay.test.ts: there is no test for an expired quote, so add one.", review.id, undefined],
    ],
  );
});

test("the next engineer job on that repository is handed them, its review sees them, and that review settles them", async () => {
  const w = world([MERGED_WITH_TWO, `REVIEW ${pr(2)}: merged`, `Merged at def5678. The expired-quote test is still missing.\n\nCARRY ${pr(3)}: test/pay.test.ts: there is still no test for an expired quote, so add one.\nREVIEW ${pr(3)}: merged`]);
  w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.held().length === 2 && w.settled());
  // A job on another repository is not handed the product's findings.
  w.jobs.start("engineer", "Tidy the workforce's README", FOUNDER, "self", THREAD);
  await waitFor(() => w.engineers().length === 2 && w.settled());
  assert.ok(!w.engineers()[1]!.prompt.includes(carry.CARRIED_HEADING));
  assert.ok(w.held().every((c) => c.takenBy === undefined));
  // The next one on the product is.
  const next = w.jobs.start("engineer", "Add refunds", FOUNDER, "product", THREAD);
  await waitFor(() => w.engineers().length === 3);
  const prompt = w.engineers()[2]!.prompt;
  assert.ok(prompt.startsWith("Add refunds\n\nCarried from review:\nThese were found when earlier work on this repository was reviewed"), "its own task comes first, then what it carries");
  assert.match(prompt, /Fix each one in this same pull request, alongside your task/);
  assert.match(prompt, /- \(from #1\) src\/pay\.ts: the 402 handler repeats the header parsing/);
  assert.match(prompt, /- \(from #1\) test\/pay\.test\.ts: there is no test for an expired quote/);
  await waitFor(() => w.settled() && w.held().length === 1);
  assert.equal(w.store.getJob(next.id)!.carried!.length, 2, "the job keeps what it was handed");
  // Its review is shown what the job was handed, so it can check each.
  const reviewBrief = w.reviews().at(-1)!.prompt;
  assert.match(reviewBrief, /Add refunds\n\nCarried from review:[\s\S]*- \(from #1\) src\/pay\.ts[\s\S]*Engineer's report:/);
  // That review merged: the two it was handed are dropped, and the one it carried again is held, free for the next job.
  assert.deepEqual(w.held().map((c) => [c.target, c.pr, c.text, c.takenBy]), [["product", pr(3), "test/pay.test.ts: there is still no test for an expired quote, so add one.", undefined]]);
});

test("a finding is handed to one job at a time, and comes back when that job fails or opens nothing", async () => {
  const w = world([MERGED_WITH_TWO], (o, n) => (n === 2 ? "Nothing needed changing, so I opened no pull request." : `Opened ${pr(n)}. Tests green.`));
  w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.held().length === 2 && w.settled());
  // The second job takes them and opens no pull request, so no review will ever settle them.
  const second = w.jobs.start("engineer", "Check the refunds path", FOUNDER, "product", THREAD);
  await waitFor(() => w.engineers().length === 2 && w.store.getJob(second.id)!.status === "done" && w.settled());
  assert.ok(w.engineers()[1]!.prompt.includes(carry.CARRIED_HEADING));
  assert.ok(w.held().every((c) => c.takenBy === second.id), "they are marked as that job's");
  assert.equal(w.store.getJob(second.id)!.pr, undefined);
  // So the third gets them.
  const third = w.jobs.start("engineer", "Add refunds", FOUNDER, "product", THREAD);
  await waitFor(() => w.engineers().length === 3);
  assert.match(w.engineers()[2]!.prompt, /- \(from #1\) src\/pay\.ts/);
  await waitFor(() => w.settled());
  assert.equal(w.held().length, 0, "and its merged review settles them");
  assert.equal(w.store.getJob(third.id)!.carried!.length, 2);
  // The rule itself, for the states a job can be in.
  const item = { id: "a", target: "product" as const, pr: pr(1), text: "x", at: "", review: "r", takenBy: "j" };
  assert.equal(carry.carriedFree({ ...item, takenBy: undefined }, () => undefined), true);
  assert.equal(carry.carriedFree(item, () => undefined), true, "a job that no longer exists holds nothing");
  assert.equal(carry.carriedFree(item, () => ({ status: "failed" })), true);
  assert.equal(carry.carriedFree(item, () => ({ status: "done" })), true);
  assert.equal(carry.carriedFree(item, () => ({ status: "done", pr: pr(2) })), false, "a pull request awaiting review still has them");
  assert.equal(carry.carriedFree(item, () => ({ status: "running" })), false);
  assert.equal(carry.carriedFree(item, () => ({ status: "queued" })), false);
});

test("a review-only job is not handed them: no maintainer review would ever settle them", async () => {
  const w = world([MERGED_WITH_TWO]);
  w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.held().length === 2 && w.settled());
  w.jobs.start("engineer", "Add refunds", FOUNDER, "product", THREAD, { reviewOnly: true });
  await waitFor(() => w.engineers().length === 2 && w.settled());
  assert.ok(!w.engineers()[1]!.prompt.includes(carry.CARRIED_HEADING));
  assert.ok(w.held().every((c) => c.takenBy === undefined));
});

test("a blocking review still asks for changes, holds nothing, and its fix round takes the CARRY lines with it", async () => {
  const blocked = `Blocking: the build fails on src/pay.ts line 40.\n\nCARRY ${pr(1)}: src/pay.ts: rename q to quote.\nREVIEW ${pr(1)}: changes requested: the build fails`;
  // With fix rounds off (the default), it goes to Paul as before.
  const off = world([blocked]);
  off.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => off.said().some((t) => t.startsWith("The maintainer asked for changes")) && off.settled());
  assert.equal(off.held().length, 0, "a pull request that is not merged leaves nothing for a later job");
  // With one round on, the round is told to clear the CARRY lines in the same push.
  config.autoFixRounds = 1;
  try {
    const on = world([blocked, `REVIEW ${pr(1)}: merged`]);
    on.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
    await waitFor(() => on.store.allJobs().length === 4 && on.settled());
    const fix = on.runs.find((r) => /Address the maintainer's review on the existing pull request/.test(r.prompt))!;
    assert.match(fix.prompt, /fix every blocking issue in the review, and its CARRY lines too so that nothing is left over for a later job/);
    assert.match(fix.prompt, /CARRY https:\/\/github\.com\/acme\/clear-exchange\/pull\/1: src\/pay\.ts: rename q to quote\./, "the review it is given has them");
    assert.equal(on.held().length, 0);
  } finally {
    config.autoFixRounds = 0;
  }
});

test("no more than a job's worth is handed over, and no more than a repository's worth is kept", async () => {
  const many = (n: number, from: number) => Array.from({ length: n }, (_, i) => `CARRY ${pr(from)}: file${i}.ts: point ${i}.`).join("\n");
  const w = world([`${many(carry.CARRY_MAX_PER_REPO + 5, 1)}\nREVIEW ${pr(1)}: merged`]);
  w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.held().length > 0 && w.settled());
  assert.equal(w.held().length, carry.CARRY_MAX_PER_REPO, "the oldest go first");
  assert.equal(w.held()[0]!.text, "file5.ts: point 5.");
  w.jobs.start("engineer", "Add refunds", FOUNDER, "product", THREAD);
  await waitFor(() => w.engineers().length === 2);
  assert.equal(w.engineers()[1]!.prompt.match(/^- \(from #1\)/gm)!.length, carry.CARRY_PER_JOB);
  await waitFor(() => w.settled());
  assert.equal(w.held().length, carry.CARRY_MAX_PER_REPO - carry.CARRY_PER_JOB, "the rest wait for the job after");
});

test("the chief knows held findings are finished business, whatever the fix-round setting", () => {
  for (const auto of [0, 1, 3]) assert.ok(fixLoopNote(auto).endsWith(carry.CARRY_NOTE));
  assert.match(carry.CARRY_NOTE, /do not start a job for them, and do not put them to Paul as something to decide/);
});
