/**
 * Plans (Paul, 22 Nov 2026; src/plans.ts): a sequence of engineering steps on one repository that the
 * service runs to completion itself. Each step starts when the one before has merged; a blocking
 * review is fixed without asking; a failed job is retried; the daily cap makes it wait and it carries
 * on the next day; and it stops, telling Paul once, only when it cannot go on.
 *
 * The real job runner runs here with a scripted engineer and maintainer. The driver has its own clock,
 * so the minute it leaves a finished job before judging its step can be stepped over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-plans-"));
delete process.env.AUTO_FIX_ROUNDS;
delete process.env.DAILY_BUDGET_USD;

const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const plans = await import("../src/plans.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";
import type { PlanJobs } from "../src/plans.js";

const FOUNDER = "tg:99887766";
const pr = (n: number) => `https://github.com/acme/lusana/pull/${n}`;
const STEPS = [
  { title: "Project skeleton", brief: "Set up the project with a build, tests and CI.", doneWhen: "A1: npm test and npm run build pass in CI" },
  { title: "Data model", brief: "Add projects, sections and tasks to the skeleton from step 1.", doneWhen: "A1: a task can be created and read back in a test" },
  { title: "List view", brief: "Add the list view over the data model from step 2.", doneWhen: "A1: the list shows a created task in a test" },
];

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * A workforce whose engineers open the next numbered pull request (or do what `engineer` says) and
 * whose maintainer gives the scripted replies, then merges. `capped` and `prs` stand in for the daily
 * cap and for GitHub.
 */
function world(maintainerReplies: string[] = [], engineer?: (o: RunOptions, n: number) => string) {
  const runs: RunOptions[] = [];
  let opened = 0;
  let engineerRuns = 0;
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: maintainerReplies.shift() ?? `REVIEW ${pr(opened)}: merged` };
    if (/Address the maintainer's review on the existing pull request/.test(o.prompt)) return { text: `Pushed the fixes to ${pr(opened)}.` };
    engineerRuns += 1;
    const said = engineer?.(o, engineerRuns);
    if (said !== undefined) return { text: said };
    opened += 1;
    return { text: `Opened ${pr(opened)}. Tests green.` };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-plans-store-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner);
  const state = { clock: Date.now(), capped: false, hasCap: true, prs: new Map<string, "open" | "merged" | "closed">() };
  const facade: PlanJobs = {
    start: (...a) => jobs.start(...a),
    retry: (id) => jobs.retry(id),
    capReached: () => state.capped,
    hasDailyCap: () => state.hasCap,
    pullState: async (url) => state.prs.get(url),
    requestFixRound: (url, by, replyTo) => jobs.requestFixRound(url, by, replyTo),
    reviewAgain: (id) => jobs.reviewAgain(id),
    verdictOf: (review, url) => jobs.verdictOf(review, url),
  };
  const driver = () => new plans.PlanRunner(store, facade, messenger, () => state.clock);
  let runnerNow = driver();
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  /** Lets the running jobs finish, steps past the settle minute and gives the driver its turn. */
  const turn = async (ms = plans.PLAN_SETTLE_MS + 1000) => {
    await waitFor(settled);
    await new Promise((r) => setTimeout(r, 30));
    await waitFor(settled);
    state.clock = Math.max(state.clock, Date.now()) + ms;
    await runnerNow.tick();
  };
  return {
    runs,
    store,
    messenger,
    jobs,
    state,
    settled,
    turn,
    get plans() {
      return runnerNow;
    },
    restart: () => (runnerNow = driver()),
    engineers: () => runs.filter((r) => r.systemPrompt.startsWith("You are a senior engineer")),
    stepJobs: (id: string, step: number) => store.allJobs().filter((j) => j.plan?.id === id && j.plan.step === step),
    said: () => messenger.sent.map((m) => m.text),
    plan: (id: string) => runnerNow.get(id)!,
  };
}

const start = (w: ReturnType<typeof world>, steps = STEPS) => w.plans.create({ title: "Lusana foundation", target: "product", steps }, FOUNDER, FOUNDER);

test("a plan runs its steps in order, each starting only when the one before has merged, and says so once at the end", async () => {
  const w = world();
  const plan = start(w);
  await w.plans.tick();
  // Step one is an ordinary engineer job with the plan's mark and its own finish line.
  await waitFor(() => w.engineers().length === 1);
  const first = w.stepJobs(plan.id, 0)[0]!;
  assert.equal(first.kind, "engineer");
  assert.equal(first.title, "Project skeleton");
  assert.match(w.engineers()[0]!.prompt, /Set up the project with a build, tests and CI\.[\s\S]*A1: npm test and npm run build pass in CI/);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["working", "todo", "todo"]);
  // While its job and review run, another turn starts nothing.
  await w.plans.tick();
  assert.equal(w.stepJobs(plan.id, 1).length, 0, "step two waits for step one to merge");
  // Merged: the next step starts at once, and so on to the end.
  await w.turn(0);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"]);
  assert.equal(w.plan(plan.id).steps[0]!.pr, pr(1));
  await w.turn(0);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "done", "working"]);
  await w.turn(0);
  const done = w.plan(plan.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.steps.map((s) => [s.state, s.pr]), [["done", pr(1)], ["done", pr(2)], ["done", pr(3)]]);
  assert.equal(w.engineers().length, 3, "one engineer job a step, and nothing else");
  const finished = w.said().filter((t) => t.includes('The plan "Lusana foundation"'));
  assert.deepEqual(finished, ['The plan "Lusana foundation" is finished: 3 of its 3 steps are merged.'], "the driver itself speaks once");
  // A further turn does nothing more.
  await w.turn();
  assert.equal(w.engineers().length, 3);
});

test("what one step's review carried is handed to the next step's engineer", async () => {
  const w = world([`CARRY ${pr(1)}: ci.yml: cache the dependencies.\nREVIEW ${pr(1)}: merged`]);
  const plan = start(w);
  await w.plans.tick();
  await w.turn(0);
  await waitFor(() => w.engineers().length === 2);
  assert.match(w.engineers()[1]!.prompt, /Carried from review:[\s\S]*- \(from #1\) ci\.yml: cache the dependencies\./);
  assert.equal(w.plan(plan.id).steps[1]!.state, "working");
});

test("a blocking review of a plan's step is fixed without asking, whatever the fix-round setting", async () => {
  assert.equal(config.autoFixRounds, 0, "automatic fix rounds are off, as deployed");
  const w = world([`REVIEW ${pr(1)}: changes requested: the build fails on src/app.ts`, `REVIEW ${pr(1)}: merged`]);
  const plan = start(w);
  await w.plans.tick();
  await w.turn(0);
  // The engineer, its review, the fix round the review started by itself, and the review of that.
  const kinds = w.store.allJobs().map((j) => `${j.kind}${j.fixRound ? ` fix ${j.fixRound}` : ""}`);
  assert.deepEqual(kinds.slice(0, 4).sort(), ["engineer", "engineer fix 1", "maintain", "maintain"]);
  const fix = w.store.allJobs().find((j) => j.fixRound === 1)!;
  assert.deepEqual(fix.plan, { id: plan.id, step: 0 }, "the fix round carries the plan's mark, so the step is read through it");
  assert.ok(!w.said().some((t) => /No fix round was started|asked for changes on/.test(t)), "nothing was put to Paul");
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"], "and the plan went on");
  // A job that is not a plan's still goes to Paul on the same review: his setting holds for those.
  const plain = world([`REVIEW ${pr(1)}: changes requested: the build fails`]);
  plain.jobs.start("engineer", "Add a thing", FOUNDER, "product", FOUNDER);
  await waitFor(() => plain.said().some((t) => t.startsWith("The maintainer asked for changes")) && plain.settled());
  assert.equal(plain.store.allJobs().length, 2);
});

test("when the fix rounds are used up the plan stops, tells Paul once, and carries on by itself when he merges", async () => {
  const asks = (what: string) => `REVIEW ${pr(1)}: changes requested: ${what}`;
  const w = world([asks("the build fails"), asks("a test fails now"), asks("the types are wrong now")]);
  const plan = start(w);
  await w.plans.tick();
  await w.turn(0);
  assert.equal(w.plan(plan.id).state, "running", "a review that has only just finished is given its minute: the fix round starts after it");
  await w.turn();
  const stopped = w.plan(plan.id);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.watch, pr(1));
  assert.equal(w.store.allJobs().filter((j) => j.fixRound).length, plans.PLAN_FIX_ROUNDS, "two automatic rounds and no more");
  const told = w.said().filter((t) => t.startsWith('The plan "Lusana foundation" has stopped'));
  assert.equal(told.length, 1);
  assert.match(told[0]!, /has stopped at step 1 of 3 \(Project skeleton\): the maintainer still asks for changes after the automatic fix rounds \(show job \w+\)\. It carries on by itself if https:\/\/github\.com\/acme\/lusana\/pull\/1 is merged\. Otherwise tell Marlo to resume the plan once that is sorted, or to skip the step\./);
  // More turns say nothing more and start nothing.
  await w.turn();
  await w.turn();
  assert.equal(w.said().filter((t) => t.startsWith('The plan "Lusana foundation" has stopped')).length, 1);
  assert.equal(w.stepJobs(plan.id, 1).length, 0);
  // Paul merges it himself. The plan notices and goes on.
  w.state.prs.set(pr(1), "merged");
  await w.turn();
  assert.equal(w.plan(plan.id).state, "stopped", "GitHub is asked every few minutes, not every turn");
  await w.turn(plans.PLAN_WATCH_EVERY_MS);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"]);
  assert.equal(w.plan(plan.id).state, "running");
});

test("the daily cap makes the plan wait, said once that day, and it carries on the next day by itself", async () => {
  const w = world();
  w.state.capped = true;
  const plan = start(w);
  await w.plans.tick();
  await w.plans.tick();
  await w.plans.tick();
  assert.equal(w.store.allJobs().length, 0, "nothing starts while the cap is reached");
  assert.equal(w.plan(plan.id).state, "running", "waiting is not stopping");
  const waiting = w.said().filter((t) => t.includes("today's spending cap is reached"));
  assert.deepEqual(waiting, ['The plan "Lusana foundation" is waiting at step 1 of 3 (Project skeleton): today\'s spending cap is reached. It carries on by itself tomorrow, or sooner if you send /resume.']);
  // Tomorrow the cap no longer holds, and the next turn starts the step. Nobody asked.
  w.state.clock += 24 * 60 * 60_000;
  w.state.capped = false;
  await w.plans.tick();
  await waitFor(() => w.engineers().length === 1);
  assert.equal(w.plan(plan.id).steps[0]!.state, "working");
  // The cap is reached again mid-plan, between two steps: the same wait, said once for the new day.
  await waitFor(w.settled);
  w.state.capped = true;
  await w.turn(0);
  await w.turn(0);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "todo", "todo"], "the merged step counts; the next one waits");
  assert.equal(w.said().filter((t) => t.includes("is waiting at step 2 of 3 (Data model)")).length, 1);
  w.state.capped = false;
  await w.turn(0);
  assert.equal(w.plan(plan.id).steps[1]!.state, "working");
});

test("a failed job is retried after a pause, a set number of times, and then the plan stops; resume tries again", async () => {
  let fail = 3;
  const w = world([], () => {
    if (fail > 0) {
      fail -= 1;
      throw new Error("the provider returned a 500");
    }
    return undefined;
  });
  const plan = start(w);
  await w.plans.tick();
  await waitFor(() => w.settled() && w.stepJobs(plan.id, 0)[0]?.status === "failed");
  const job = w.stepJobs(plan.id, 0)[0]!;
  // Not at once: a provider's bad minute is not retried into.
  await w.turn(1000);
  assert.equal(w.store.getJob(job.id)!.status, "failed");
  assert.equal(w.plan(plan.id).steps[0]!.retries, undefined);
  // After the pause it is retried, the same job, twice.
  await w.turn(plans.PLAN_RETRY_WAIT_MS);
  await waitFor(() => w.engineers().length === 2 && w.settled());
  assert.equal(w.plan(plan.id).steps[0]!.retries, 1);
  await w.turn(plans.PLAN_RETRY_WAIT_MS);
  await waitFor(() => w.engineers().length === 3 && w.settled());
  assert.equal(w.plan(plan.id).steps[0]!.retries, plans.PLAN_RETRIES);
  assert.equal(w.stepJobs(plan.id, 0).length, 1, "a retry is the same job again, not a new one");
  // The third failure stops the plan.
  await w.turn(plans.PLAN_RETRY_WAIT_MS);
  assert.equal(w.plan(plan.id).state, "stopped");
  assert.match(w.said().find((t) => t.startsWith('The plan "Lusana foundation" has stopped'))!, /its job failed 3 times, the last because .* \(show job \w+\)\. Tell Marlo to resume the plan once that is sorted, or to skip the step\./);
  // Paul says to carry on: it is retried again, and this time it works.
  const said = await w.plans.resume(plan.id, FOUNDER);
  assert.match(said, /carries on: the failed job of step 1 of 3 \(Project skeleton\) is being retried/);
  await w.turn(0);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"]);
});

test("a step that needs Paul stops the plan; resume has it reviewed again, and skip leaves it", async () => {
  const w = world([`REVIEW ${pr(1)}: needs Paul: add the DEPLOY_TOKEN secret to the repository`]);
  const plan = start(w);
  await w.plans.tick();
  await w.turn();
  assert.equal(w.plan(plan.id).state, "stopped");
  assert.match(w.plan(plan.id).why!, /it needs you: add the DEPLOY_TOKEN secret to the repository/);
  // He adds the secret and says to carry on. The pull request is open, so it is reviewed again, not rebuilt.
  w.state.prs.set(pr(1), "open");
  const said = await w.plans.resume(plan.id, FOUNDER);
  assert.match(said, /pull\/1 is being reviewed again/);
  await waitFor(() => w.runs.filter((r) => r.systemPrompt.startsWith("You are the maintainer")).length === 2);
  assert.match(w.runs.filter((r) => r.systemPrompt.startsWith("You are the maintainer"))[1]!.prompt, /Review the pull request https:\/\/github\.com\/acme\/lusana\/pull\/1 again/);
  assert.equal(w.engineers().length, 1, "no engineer session was spent on it");
  await w.turn(0);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"]);
  // Skip: a stopped step is left and the next one starts.
  const s = world([`REVIEW ${pr(1)}: needs Paul: decide the licence`]);
  const second = start(s);
  await s.plans.tick();
  await s.turn();
  assert.equal(s.plan(second.id).state, "stopped");
  assert.match(await s.plans.resume(second.id, FOUNDER, true), /Skipped step 1 of 3 \(Project skeleton\)\..*a later step that depends on the skipped one may fail/);
  await waitFor(() => s.plan(second.id).steps[1]!.state === "working");
  assert.deepEqual(s.plan(second.id).steps.map((x) => x.state), ["skipped", "working", "todo"]);
  await s.turn(0);
  await s.turn(0);
  assert.ok(s.said().includes('The plan "Lusana foundation" is finished: 2 of its 3 steps are merged and 1 was skipped.'));
});

test("a step that opens no pull request stops the plan instead of being counted as done", async () => {
  const w = world(["There is no pull request to review."], () => "Nothing needed changing, so I opened no pull request.");
  const plan = start(w);
  await w.plans.tick();
  await w.turn();
  assert.equal(w.plan(plan.id).state, "stopped");
  assert.match(w.plan(plan.id).why!, /it opened no pull request \(show job \w+\)/);
  assert.equal(w.plan(plan.id).watch, undefined);
  assert.equal(w.stepJobs(plan.id, 1).length, 0, "the next step did not start on a step that produced nothing");
});

test("a plan's progress is read from the jobs, so a restart of the service loses nothing", async () => {
  const w = world();
  const plan = start(w);
  await w.plans.tick();
  await waitFor(w.settled);
  // The service restarts: a new driver over the same store, with nothing in memory.
  w.restart();
  await w.turn(0);
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"]);
  assert.equal(w.engineers().length, 2, "step one was not run twice");
});

test("Paul can stop a plan, and a repository takes one open plan at a time", async () => {
  const w = world();
  const plan = start(w);
  await w.plans.tick();
  assert.throws(() => start(w), /The plan "Lusana foundation" \(\w+\) is still running on that repository/);
  assert.match(w.plans.halt(plan.id), /is stopped at step 1 of 3 \(Project skeleton\)\. The job already running for that step is left to finish; nothing new starts/);
  await w.turn();
  assert.equal(w.stepJobs(plan.id, 1).length, 0, "a stopped plan starts nothing, even though step one merged");
  assert.equal(w.plan(plan.id).watch, undefined, "and it is not waiting on a pull request: Paul stopped it");
  assert.throws(() => start(w), /is still stopped on that repository/);
  // Resume: step one's pull request merged meanwhile, so it goes straight on to step two.
  assert.match(await w.plans.resume(plan.id, FOUNDER), /carries on at step 1 of 3/);
  await waitFor(() => w.plan(plan.id).steps[1]!.state === "working");
  assert.deepEqual(w.plan(plan.id).steps.map((s) => s.state), ["done", "working", "todo"]);
  const text = w.plans.describe();
  assert.match(text, /Plan \w+ "Lusana foundation" on product: running\. 1 of 3 steps merged; now at step 2 of 3 \(Data model\)\./);
  assert.match(text, /  1\. Project skeleton: done \(job \w+\) https:\/\/github\.com\/acme\/lusana\/pull\/1/);
  assert.match(text, /  3\. List view: todo/);
});

test("a plan is refused when it could not be run: no steps, too many, a step with no brief or finish line, or no daily cap", () => {
  const w = world();
  const make = (steps: typeof STEPS) => () => w.plans.create({ title: "x", target: "product", steps }, FOUNDER);
  assert.throws(make([]), /at least one step/);
  assert.throws(make(Array.from({ length: plans.PLAN_MAX_STEPS + 1 }, () => STEPS[0]!)), /at most 40 steps, and this one has 41/);
  assert.throws(make([{ ...STEPS[0]!, brief: " " }]), /Step 1 has no brief/);
  assert.throws(make([STEPS[0]!, { ...STEPS[1]!, doneWhen: "" }]), /Step 2 has no doneWhen/);
  assert.equal(w.plans.all().length, 0);
  // With no daily cap nothing would bound a thing that spends without asking, so it is not started.
  w.state.hasCap = false;
  assert.throws(() => start(w), /There is no daily spending cap set.*Paul sets one on the Spend page/);
  assert.equal(w.jobs.hasDailyCap(), config.dailyBudgetUsd !== undefined, "the real runner answers from the setting");
  assert.equal(w.plans.all().length, 0);
});

test("the chief is told to use a plan for a build carried through, and not to start or queue its steps himself", () => {
  const orchestrator = fs.readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  assert.match(orchestrator, /const CHIEF_PROMPT = `[^`]*\$\{PLAN_NOTE\}/, "the note is part of the chief's prompt");
  for (const name of ["plan_start", "plan_status", "plan_resume", "plan_stop"]) assert.ok(orchestrator.includes(`"${name}"`), `${name} is one of his tools`);
  assert.match(plans.PLAN_NOTE, /use plan_start with the steps in build order, one pull request each, and do not start_job them yourself or queue them/);
  assert.match(plans.PLAN_NOTE, /waits on the daily cap and carries on the next day, and tells Paul only when it stops or finishes/);
});
