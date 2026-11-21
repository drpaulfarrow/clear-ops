/**
 * Fix rounds do not start on their own (Paul's decision, 21 Nov 2026), and neither a fix round nor its
 * review runs on a pull request that has been merged or closed.
 *
 * A fix round is a whole new engineer session and another review after it. On 21 Nov two of them ran,
 * with their reviews, on a pull request Paul had already merged, and held every deploy while they did.
 * The review still runs once and its verdict goes to him; one round is his to ask for. The loop's own
 * mechanics, for when rounds are set to start on their own, are in test/review-loop.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fix-rounds-"));
delete process.env.AUTO_FIX_ROUNDS;

const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { MAX_FIX_ROUNDS } = await import("../src/agents.js");
const { PrStates } = await import("../src/pr-state.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { PAUL_STYLE } = await import("../src/messages.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";
import type { PrState } from "../src/pr-state.js";

const FOUNDER = "tg:99887766";
const PR = "https://github.com/acme/clear-exchange/pull/12";
const THREAD = "dc:c:thread-1";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const changes = (detail = "") => `Blocking: the test for the 402 path is missing.\n\nREVIEW ${PR}: changes requested${detail ? `: ${detail}` : ""}`;

function world(maintainerReplies: string[], prState?: (url: string) => Promise<PrState | undefined>) {
  const runs: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: maintainerReplies.shift() ?? `REVIEW ${PR}: merged` };
    return { text: `Opened ${PR}. Tests green.` };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fix-rounds-store-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner, undefined, prState ? { prState } : {});
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  const reviews = () => runs.filter((r) => r.systemPrompt.startsWith("You are the maintainer")).length;
  const said = () => messenger.sent.map((m) => m.text);
  return { runs, store, messenger, jobs, settled, reviews, said };
}

test("none start on their own unless Paul sets it, and never more than the cap", () => {
  assert.equal(config.autoFixRounds, 0, "off by default");
  assert.ok(MAX_FIX_ROUNDS >= 1 && MAX_FIX_ROUNDS <= 5);
  const src = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(src, /autoFixRounds: autoFixRounds\(process\.env\.AUTO_FIX_ROUNDS\),/);
  // Anything that is not a whole number from 0 to 5 is none, never "as many as it takes".
  assert.match(src, /Number\.isInteger\(n\) && n >= 0 && n <= 5 \? n : 0;/);
  const jobs = fs.readFileSync(new URL("../src/jobs.ts", import.meta.url), "utf8");
  assert.match(jobs, /const auto = Math\.min\(config\.autoFixRounds, MAX_FIX_ROUNDS\);/, "the setting can never lift the cap");
});

test("a review that asks for changes goes to Paul with what to say next, and starts nothing", async () => {
  const w = world([changes("the 402 path has no test")]);
  const eng = w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.store.allJobs().length === 2 && w.settled() && w.said().some((t) => t.startsWith("The maintainer asked for changes")));
  await new Promise((r) => setTimeout(r, 50));
  // One engineer job and one review: no fix round, and no second review.
  assert.deepEqual(w.store.allJobs().map((j) => j.kind).sort(), ["engineer", "maintain"]);
  assert.equal(w.reviews(), 1);
  assert.ok(!w.store.allJobs().some((j) => j.fixRound));
  const review = w.store.allJobs().find((j) => j.kind === "maintain" && j.reviewOf === eng.id)!;
  const told = w.said().find((t) => t.startsWith("The maintainer asked for changes"))!;
  assert.equal(told, `The maintainer asked for changes on ${PR}: the 402 path has no test. No fix round was started, because automatic fix rounds are off. Reply "one more fix round on ${PR}" to have an engineer fix it once, or merge or close it as it is. The whole review: show job ${review.id}.`);
  assert.equal(w.messenger.sent.find((m) => m.text === told)!.to, THREAD, "it is said where the job reports");
  assert.ok(!w.said().some((t) => /Started .* to fix them/.test(t)));
  // It is written the way Paul is written to.
  assert.doesNotMatch(told, /[—–]|\n|^\s*[-*#]/m);
  assert.ok(told.split(/(?<=\.)\s/).length <= 5 && PAUL_STYLE.length > 0);
  // With nothing after the verdict, the sentence still ends properly.
  const bare = world([changes()]);
  bare.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => bare.said().some((t) => t.startsWith("The maintainer asked for changes")));
  assert.match(bare.said().find((t) => t.startsWith("The maintainer asked for changes"))!, new RegExp(`^The maintainer asked for changes on ${PR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. No fix round was started,`));
});

test("a round he asks for is one round: it is reviewed again, and nothing follows that by itself", async () => {
  const w = world([changes("still no test for the 402 path")]);
  // What the chief starts when he says "one more fix round on <address>": an engineer job on that pull request.
  const fix = w.jobs.start("engineer", `Address the maintainer's review on the existing pull request ${PR}.`, FOUNDER, "product", THREAD, { title: "Fix round 1: Add the 402 flow", pr: PR, fixRound: 1 });
  await waitFor(() => w.said().some((t) => t.startsWith("The maintainer asked for changes")));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.reviews(), 1, "his round is re-reviewed, once");
  assert.equal(w.store.allJobs().filter((j) => j.kind === "engineer").length, 1, "and no further round starts");
  assert.ok(w.store.allJobs().some((j) => j.kind === "maintain" && j.reviewOf === fix.id));
});

test("with rounds set to start on their own, the loop is as it was", async () => {
  config.autoFixRounds = 1;
  try {
    const w = world([changes("first"), changes("something else entirely is wrong with the retry path now")]);
    w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
    await waitFor(() => w.said().some((t) => t.startsWith("The maintainer asked for changes")), 8000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.store.allJobs().filter((j) => j.fixRound).length, 1, "the one round he allowed ran");
    assert.equal(w.reviews(), 2);
    assert.ok(w.said().some((t) => t.includes(`Changes requested on ${PR}. Started Fix round 1`)));
    assert.match(w.said().find((t) => t.startsWith("The maintainer asked for changes"))!, /No fix round was started, because the one automatic fix round has been used\./);
  } finally {
    config.autoFixRounds = 0;
  }
});

test("no fix round starts on a pull request that has been merged or closed, whatever the setting", async () => {
  config.autoFixRounds = MAX_FIX_ROUNDS;
  try {
    for (const [state, words] of [["merged", /but it has been merged, so no fix round was started: a fix pushed to its branch would reach nothing\. What the review found is in the default branch now \(show job [a-f0-9]{6}\)\. Ask for a new change if you want it fixed\.$/], ["closed", /but it has been closed, so no fix round was started\. The review is saved \(show job [a-f0-9]{6}\)\.$/]] as const) {
      const asked: string[] = [];
      const w = world([changes("seven things")], async (url) => (asked.push(url), state));
      w.jobs.start("engineer", "Add the model catalogue", FOUNDER, "product", THREAD);
      await waitFor(() => w.said().some((t) => t.startsWith("The maintainer asked for changes")));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(asked, [PR], "GitHub is asked once, when the review comes back");
      assert.ok(!w.store.allJobs().some((j) => j.fixRound), `${state}: no fix round`);
      assert.equal(w.reviews(), 1);
      assert.match(w.said().find((t) => t.startsWith("The maintainer asked for changes"))!, words);
      assert.ok(!w.said().some((t) => /one more fix round/.test(t)), "he is not offered a round that would reach nothing");
    }
    // Open, unknown, or GitHub not answering: the loop carries on as it would have.
    for (const answer of [async () => "open" as const, async () => undefined, async () => { throw new Error("GitHub is down"); }]) {
      const w = world([changes("one thing")], answer);
      w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
      await waitFor(() => w.store.allJobs().some((j) => j.fixRound === 1) && w.settled(), 8000);
      assert.equal(w.store.allJobs().filter((j) => j.fixRound === 1).length, 1);
    }
  } finally {
    config.autoFixRounds = 0;
  }
});

test("a fix round whose pull request was merged while it ran is not reviewed, and Paul is told where its work is", async () => {
  const asked: string[] = [];
  const w = world([], async (url) => (asked.push(url), "merged"));
  const fix = w.jobs.start("engineer", `Address the maintainer's review on the existing pull request ${PR}.`, FOUNDER, "product", THREAD, { title: "Fix round 1: Add the model catalogue", pr: PR, fixRound: 1 });
  await waitFor(() => w.settled() && w.said().some((t) => t.includes("was merged while this fix round was running")));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.reviews(), 0, "no review is paid for");
  assert.deepEqual(w.store.allJobs().map((j) => j.id), [fix.id]);
  assert.ok(w.said().some((t) => t.includes(`${PR} was merged while this fix round was running, so nothing reviews it: what the round pushed is on the pull request's branch and not in the default branch. Ask for a new pull request from that branch if you want those fixes.`)));
  assert.deepEqual(asked, [PR]);
  // A first job's pull request is always reviewed, merged or not: the review is how he learns what went in.
  const first = world([`REVIEW ${PR}: merged`], async () => "merged");
  first.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => first.reviews() === 1 && first.settled());
});

test("the state is asked of GitHub at that moment, not read from what was known a few minutes ago", async () => {
  let merged = false;
  const calls: string[] = [];
  const states = new PrStates({
    token: () => "t",
    fetch: (async (url: string) => (calls.push(String(url)), new Response(JSON.stringify({ state: merged ? "closed" : "open", merged, created_at: "2026-11-21T10:26:24Z" }), { status: 200 }))) as unknown as typeof fetch,
  });
  assert.equal(await states.fresh(PR), "open");
  assert.equal(states.get(PR), "open", "what it learned is kept for the app");
  merged = true;
  // The app's own reading would still say open for a few minutes; a decision asks again.
  assert.equal(states.get(PR), "open");
  assert.equal(await states.fresh(PR), "merged");
  assert.equal(states.get(PR), "merged");
  assert.deepEqual(calls, ["https://api.github.com/repos/acme/clear-exchange/pulls/12", "https://api.github.com/repos/acme/clear-exchange/pulls/12"]);
  // Not a pull request's own address, no credential, or GitHub failing: nothing is claimed.
  assert.equal(await states.fresh("https://example.org/acme/x/pull/1"), undefined);
  assert.equal(await new PrStates({ token: () => undefined }).fresh(PR), undefined);
  assert.equal(await new PrStates({ token: () => "t", fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch }).fresh(PR), undefined);
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /prState: \(url\) => prStates\.fresh\(url\)/, "the service's job runner is given it");
});

test("the pull request's page is told what the maintainer said of it and whether a fix is under way", async () => {
  const { appPullWatch } = await import("../src/app-data.js");
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fix-rounds-watch-")));
  const queue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: Date.now() }), capReached: () => false };
  const source = { store, queue };
  const SELF = "https://github.com/drpaulfarrow/clear-ops/pull/";
  const pull = (number: number) => ({ repo: "self", repository: "drpaulfarrow/clear-ops", number });
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
  const review = (output: string, minsAgo: number, target = "self") => {
    const j = store.updateJob(store.createJob("maintain", "Review it", FOUNDER, target as never, FOUNDER, { title: "Review" }).id, { status: "done", finishedAt: at(minsAgo) });
    store.writeOutput(j.id, output);
    return j;
  };
  // One review covers the pull request it was started for and another open one it looked at.
  const r1 = review(`Seven blocking issues.\n\nREVIEW ${SELF}153: changes requested: role changes bypass model validation\nREVIEW ${SELF}155: changes requested\nREVIEW #150: merged`, 30);
  assert.deepEqual(appPullWatch(source, pull(153)), { review: { verdict: "changes_requested", by: "Vera", detail: "role changes bypass model validation", job: r1.id, at: r1.finishedAt } });
  assert.deepEqual(appPullWatch(source, pull(155)).review, { verdict: "changes_requested", by: "Vera", job: r1.id, at: r1.finishedAt });
  // Merged, never reviewed, or another repository's pull request of the same number: nothing to say.
  assert.deepEqual(appPullWatch(source, pull(150)), {});
  assert.deepEqual(appPullWatch(source, pull(99)), {});
  assert.deepEqual(appPullWatch(source, { repo: "product", repository: "drpaulfarrow/clear-exchange", number: 153 }), {});
  review(`REVIEW #153: changes requested: in the product`, 20, "product");
  assert.equal(appPullWatch(source, pull(153)).review!.job, r1.id, "a number alone counts only for the repository the review ran in");
  // The newest word stands: left for Paul, then a later "merged" clears it.
  const r2 = review(`REVIEW ${SELF}153: needs Paul: merge when ready`, 10);
  assert.deepEqual(appPullWatch(source, pull(153)).review, { verdict: "needs_founder", by: "Vera", detail: "merge when ready", job: r2.id, at: r2.finishedAt });
  review(`REVIEW ${SELF}153: merged`, 5);
  assert.equal(appPullWatch(source, pull(153)).review, undefined);
  // A fix round that is queued or running on it is named; a finished one is not.
  const fix = store.createJob("engineer", "Address the review", FOUNDER, "self", FOUNDER, { title: "Fix round 2", pr: `${SELF}155`, fixRound: 2 });
  assert.deepEqual(appPullWatch(source, pull(155)).fixing, { by: "Fitz", job: fix.id, round: 2, running: false });
  store.updateJob(fix.id, { status: "running", startedAt: at(1) });
  assert.equal(appPullWatch(source, pull(155)).fixing!.running, true);
  store.updateJob(fix.id, { status: "done", finishedAt: at(0) });
  assert.equal(appPullWatch(source, pull(155)).fixing, undefined);
  // The page shows it above the Merge button, as text, and the route adds it to what GitHub says.
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.match(js, /pullWatch\(v\),\s*merge,/, "above the Merge button");
  assert.match(js, /`\$\{r\.by\} asked for changes\$\{v\.state === "merged" \? " before this was merged" : ""\}/);
  assert.match(js, /Merging now takes the version before those fixes\./);
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /res\.json\(\{ \.\.\.view, \.\.\.appPullWatch\(appSource\(\), view\) \}\);/);
});

test("the round he asks for is refused on a merged or closed pull request before any session starts", async () => {
  for (const state of ["merged", "closed"] as const) {
    let now: PrState = "open";
    const w = world([changes("the 402 path has no test")], async () => now);
    w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
    await waitFor(() => w.said().some((t) => t.startsWith("The maintainer asked for changes")));
    const sessions = w.runs.length;
    // He merges or closes it, and then asks for the round.
    now = state;
    const answer = await w.jobs.requestFixRound(PR, FOUNDER, THREAD);
    await new Promise((r) => setTimeout(r, 80));
    assert.match(answer, new RegExp(`^${PR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has been ${state}, so no fix round was started: a fix pushed to its branch would reach nothing\\.`));
    assert.equal(w.runs.length, sessions, `${state}: no engineer and no review session ran`);
    assert.ok(!w.store.allJobs().some((j) => j.fixRound), `${state}: no fix round exists`);
  }
});

test("the round he asks for carries its pull request and number, is reviewed once, and is not reviewed if merged meanwhile", async () => {
  let now: PrState = "open";
  const w = world([changes("the 402 path has no test"), changes("the retry path is still wrong in a new way entirely")], async () => now);
  w.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => w.said().some((t) => t.startsWith("The maintainer asked for changes")));
  const review = w.store.allJobs().find((j) => j.kind === "maintain")!;
  const answer = await w.jobs.requestFixRound(PR, FOUNDER, "web:pull:product:12");
  const fix = w.store.allJobs().find((j) => j.fixRound === 1)!;
  assert.ok(fix, "an engineer job on that pull request");
  assert.deepEqual([fix.kind, fix.pr, fix.fixRound, fix.target, fix.replyTo, fix.requestedBy], ["engineer", PR, 1, "product", "web:pull:product:12", FOUNDER]);
  assert.match(fix.brief, new RegExp(`existing pull request ${PR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(fix round 1, asked for by the founder\\)`));
  assert.match(fix.brief, new RegExp(`Maintainer's review \\(job ${review.id}\\):`), "it carries the review it is to fix");
  assert.match(fix.brief, /Do not open a new pull request/);
  assert.match(answer, new RegExp(`^Started Fix round 1: Add the 402 flow · engineer · ${fix.id} to fix what the maintainer asked for on `));
  assert.match(answer, /It is reviewed once when it finishes, and nothing more follows unless you ask\.$/);
  // While it runs, a second ask starts nothing.
  if (w.store.getJob(fix.id)!.status !== "done") assert.match(await w.jobs.requestFixRound(PR, FOUNDER, THREAD), /^A fix round on .* is already (running|queued)/);
  // It finishes, is reviewed once, and that review's change request goes to him without another round.
  await waitFor(() => w.reviews() === 2 && w.settled() && w.said().filter((t) => t.startsWith("The maintainer asked for changes")).length === 2, 8000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.store.allJobs().filter((j) => j.fixRound).length, 1);
  assert.ok(w.store.allJobs().some((j) => j.kind === "maintain" && j.reviewOf === fix.id));
  // The next round he asks for is round 2, and if the pull request is merged while it runs, nothing reviews it.
  const before = w.reviews();
  const second = await w.jobs.requestFixRound(PR, FOUNDER, THREAD);
  assert.match(second, /^Started Fix round 2:/);
  now = "merged";
  await waitFor(() => w.settled() && w.said().some((t) => t.includes("was merged while this fix round was running")), 8000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.reviews(), before, "no review of a round whose pull request merged meanwhile");
});

test("a round is only ever started for a pull request the maintainer asked for changes on", async () => {
  const none = world([]);
  assert.equal(await none.jobs.requestFixRound(PR, FOUNDER, THREAD), `I have no review by the maintainer of ${PR}, so there is nothing for a fix round to fix. Ask me for the change in your own words if you want an engineer on it.`);
  const merged = world([`REVIEW ${PR}: merged`]);
  merged.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => merged.reviews() === 1 && merged.settled());
  assert.match(await merged.jobs.requestFixRound(PR, FOUNDER, THREAD), /^The last review of .* did not ask for changes, so there is nothing for a fix round to fix \(show job [a-f0-9]{6}\)\.$/);
  assert.equal(merged.store.allJobs().filter((j) => j.kind === "engineer").length, 1);
  // Another pull request of the same number somewhere else is not this one.
  const other = world([changes()]);
  other.jobs.start("engineer", "Add the 402 flow", FOUNDER, "product", THREAD);
  await waitFor(() => other.said().some((t) => t.startsWith("The maintainer asked for changes")));
  assert.match(await other.jobs.requestFixRound("https://github.com/someone/else/pull/12", FOUNDER, THREAD), /^I have no review by the maintainer of https:\/\/github\.com\/someone\/else\/pull\/12/);
});

test("his message is taken by the service itself, before the chief, and only as the whole message with a full address", async () => {
  const { Orchestrator, FIX_ROUND_COMMAND, fixLoopNote } = await import("../src/orchestrator.js");
  const { Scheduler } = await import("../src/scheduler.js");
  for (const yes of [`one more fix round on ${PR}`, `One more fix round on ${PR}.`, `one more fix round on <${PR}>`, `ONE MORE FIX ROUND ON   ${PR}!`]) assert.equal(FIX_ROUND_COMMAND.exec(yes)?.[1], PR, yes);
  for (const no of [`please do one more fix round on ${PR}`, `one more fix round on ${PR} and merge it`, "one more fix round on #12", "one more fix round on https://github.com/acme/clear-exchange/pull/0", "one more fix round on https://evil.example/acme/x/pull/12", `one more fix round on ${PR}/files`, "one more fix round"]) assert.equal(FIX_ROUND_COMMAND.test(no), false, no);
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fix-rounds-orch-")));
  const m = new ConsoleMessenger();
  const seen: RunOptions[] = [];
  const runner: AgentRunner = async (o) => (seen.push(o), { text: "ok" });
  const jobs = new JobRunner(store, m, runner);
  const orch = new Orchestrator(store, m, jobs, new Scheduler(store, jobs), runner);
  await orch.handle(FOUNDER, `one more fix round on ${PR}`);
  assert.equal(seen.length, 0, "no model is asked: the service answers itself");
  assert.equal(m.sent.at(-1)!.text, `I have no review by the maintainer of ${PR}, so there is nothing for a fix round to fix. Ask me for the change in your own words if you want an engineer on it.`);
  // Anything else goes to the chief, who is told how the loop works now and not to start a round himself.
  await orch.handle(FOUNDER, "can you get those review comments fixed?");
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.systemPrompt!.includes(fixLoopNote(0)));
  assert.match(fixLoopNote(0), /^The maintainer reviews an engineer's or agent-creator's pull request once\. When it requests changes, nothing starts by itself/);
  assert.match(fixLoopNote(0), /a fix round starts only on his own message "one more fix round on <the pull request's address>", which the service handles itself/);
  assert.match(fixLoopNote(0), /do not start an engineer job for it yourself/);
  assert.doesNotMatch(seen[0]!.systemPrompt!, /starts automatically \(queued like any engineering job\)|up to 3 fix rounds/, "nothing in his instructions still promises the automatic loop");
  assert.match(seen[0]!.systemPrompt!, /the review loop \(one review, then a message to Paul, and a fix round only when he asks for one\) works the same everywhere/);
  // With rounds set to start on their own, he is told that, with the number.
  assert.match(fixLoopNote(2), /starts automatically \(queued like any engineering job\), and the update is re-reviewed automatically, up to 2 fix rounds per pull request/);
  assert.doesNotMatch(fixLoopNote(0) + fixLoopNote(3), /—/);
  // The page offers the same words as one button, while the pull request is open and no round is under way.
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.match(js, /const sent = await sendThread\(`one more fix round on \$\{v\.url\}`, `pull:\$\{v\.repo\}:\$\{v\.number\}`\);/);
  assert.match(js, /r && r\.verdict === "changes_requested" && v\.state === "open" && !f\s*\? h\("div", \{ class: "links" \}, h\("button", \{[^}]*onclick: \(\) => void askForFix\(v\) \}, "Have these fixed, once"\)\)/);
});
