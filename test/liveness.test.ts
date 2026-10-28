import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-live-"));

const { Store } = await import("../src/store.js");
const { JobRunner, stashWork, savedWorkNote, duration } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunOptions, RunResult } from "../src/agents.js";
import type { Job, SavedWork } from "../src/store.js";

const FOUNDER = "tg:99887766";
const MIN = 60_000;

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * A runner whose workers finish only when the test says so, beat their heartbeat on request and, like
 * the SDK, give up when aborted. `hang` makes a worker ignore the abort, as a wedged process would.
 */
function workers(opts: { hang?: string[] } = {}) {
  const runs = new Map<string, { o: RunOptions; resolve: (r: RunResult) => void }>();
  const started: string[] = [];
  const runner: AgentRunner = (o) =>
    new Promise<RunResult>((resolve, reject) => {
      const key = o.prompt.split("\n")[0];
      started.push(key);
      runs.set(key, { o, resolve });
      o.onActivity?.();
      if (!opts.hang?.includes(key)) o.abortController?.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  return {
    runner,
    started,
    prompt: (key: string) => runs.get(key)!.o.prompt,
    beat: (key: string) => runs.get(key)!.o.onActivity?.(),
    finish: (key: string, text = `${key} done`) => runs.get(key)!.resolve({ text }),
  };
}

function setup(o: { hang?: string[]; dir?: string } = {}) {
  const store = new Store(o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-live-")));
  const messenger = new ConsoleMessenger();
  const w = workers(o);
  const clock = { t: Date.parse("2026-10-28T15:00:00Z") };
  const saved: Array<{ id: string; why: string }> = [];
  const saveWork = async (job: Job, why: string): Promise<SavedWork> => {
    saved.push({ id: job.id, why });
    return { dir: "/data/workspace", branch: `clear/${job.id}`, stash: `clear-ops ${job.id}: ${job.title} (stopped: ${why})` };
  };
  const jobs = new JobRunner(store, messenger, w.runner, undefined, {
    liveness: { stallMs: 30 * MIN, maxRuntimeMs: 240 * MIN, graceMs: 50, now: () => clock.t, saveWork },
  });
  return { store, messenger, jobs, clock, saved, ...w };
}

test("a job whose worker shows no activity past the limit is stopped, its work kept, and the queue moves", async () => {
  const { store, messenger, jobs, clock, saved, started, beat, prompt } = setup();
  await jobs.resumeInterrupted();
  const a = jobs.start("engineer", "A", FOUNDER, "product", undefined, { title: "Vertical demo catalogues" });
  const b = jobs.start("engineer", "B", FOUNDER, "product", undefined, { title: "One-call buy" });
  await waitFor(() => started.includes("A"));

  // Activity keeps it alive, and the chief can see when it last did something.
  clock.t += 20 * MIN;
  beat("A");
  clock.t += 25 * MIN;
  const live = jobs.liveness(a.id)!;
  assert.equal(live.alive, true);
  assert.equal(live.idleMinutes, 25);
  assert.equal(live.runningMinutes, 45);
  assert.match(live.summary, /is alive: its worker last did something 25 minutes ago/);
  await jobs.checkLiveness();
  assert.equal(store.getJob(a.id)!.status, "running", "25 quiet minutes is under the limit");

  // Thirty quiet minutes: stopped, work kept, B starts.
  clock.t += 5 * MIN;
  assert.equal(jobs.liveness(a.id)!.alive, false);
  await jobs.checkLiveness();
  await waitFor(() => started.includes("B"));
  const stopped = store.getJob(a.id)!;
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.failure, "stalled");
  assert.match(stopped.error!, /No activity from its worker for 30 minutes/);
  assert.deepEqual(saved, [{ id: a.id, why: "stalled" }]);
  assert.equal(stopped.savedWork?.branch, `clear/${a.id}`);
  assert.equal(jobs.holder("product"), b.id);
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0, "a stopped job starts no review");

  // Paul is told in one plain sentence: what stalled, what happened to it and to the queue.
  const notice = messenger.sent.find((m) => m.text.startsWith("Vertical demo catalogues"))!;
  assert.equal(
    notice.text,
    `Vertical demo catalogues · engineer · ${a.id} showed no activity for 30 minutes, so I stopped it, kept its unfinished work and started One-call buy (${b.id}), next in the queue; retry ${a.id} carries on from where it got to.`,
  );
  assert.equal(notice.text.split(/[.;]\s/).length <= 3 && !/\n/.test(notice.text), true);

  // A retry carries on from the kept work.
  await waitFor(() => !jobs.isRunning(a.id));
  jobs.retry(a.id);
  assert.equal(store.getJob(a.id)!.waitingFor, b.id, "the retry queues behind the job now running");
});

test("a job past the maximum runtime is stopped even while it is still busy", async () => {
  const { store, messenger, jobs, clock, started, beat } = setup();
  const a = jobs.start("research", "R", FOUNDER, "product", undefined, { title: "Endless research" });
  await waitFor(() => started.includes("R"));
  for (let i = 0; i < 24; i++) {
    clock.t += 10 * MIN;
    beat("R");
    await jobs.checkLiveness();
  }
  await waitFor(() => store.getJob(a.id)!.status === "failed");
  const j = store.getJob(a.id)!;
  assert.equal(j.failure, "timeout");
  assert.match(j.error!, /Ran for 240 minutes, past the maximum runtime of 240 minutes/);
  assert.equal(j.savedWork, undefined, "only engineering jobs have a checkout to keep");
  assert.ok(messenger.sent.some((m) => m.text === `Endless research · research · ${a.id} ran for 4 hours, past the limit of 4 hours, so I stopped it; retry ${a.id} carries on from where it got to.`));
  assert.match(store.readOutput(a.id)!, /stopped and did not finish, because it ran past the maximum runtime/);
});

test("a worker that ignores the stop is left behind and the queue still moves", async () => {
  const { store, jobs, clock, started, finish } = setup({ hang: ["A"] });
  const a = jobs.start("engineer", "A", FOUNDER, "self");
  const b = jobs.start("engineer", "B", FOUNDER, "self");
  await waitFor(() => started.includes("A"));
  clock.t += 31 * MIN;
  await jobs.checkLiveness();
  await waitFor(() => started.includes("B"));
  assert.equal(store.getJob(a.id)!.failure, "stalled");
  assert.equal(jobs.holder("self"), b.id);
  // When the wedged worker finally returns, nothing it says changes the job or the queue.
  finish("A", "A done after all");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.getJob(a.id)!.status, "failed");
  assert.equal(jobs.holder("self"), b.id);
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0);
});

test("after a restart, a stale running job is resumed and its queue waits; one that never re-attached is caught by the watchdog", async () => {
  // The state Paul saw: the holder marked running after a restart, five product jobs queued behind it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-live-restart-"));
  {
    const store = new Store(dir);
    const holder = store.createJob("engineer", "H", FOUNDER, "product", undefined, { title: "Vertical demo catalogues" });
    store.updateJob(holder.id, { status: "running", resumed: 1 });
    ["Q1", "Q2", "Q3", "Q4", "Q5"].forEach((b, i) => {
      const q = store.createJob("engineer", b, FOUNDER, "product");
      store.updateJob(q.id, { waitingFor: holder.id, queuePos: i + 2 });
    });
  }
  const { store, messenger, jobs, clock, started, finish } = setup({ dir });
  const holder = store.allJobs().find((j) => j.brief === "H")!;
  await jobs.resumeInterrupted();
  await waitFor(() => started.includes("H"));
  assert.equal(store.getJob(holder.id)!.resumed, 2);
  assert.equal(jobs.liveness(holder.id)!.alive, true, "re-attached: a worker really is running it");

  // A job left marked running that no worker picked up (the stuck case) is restarted by the watchdog.
  finish("H");
  await waitFor(() => started.includes("Q1"));
  const q1 = store.allJobs().find((j) => j.brief === "Q1")!;
  const lost = store.createJob("engineer", "L", FOUNDER, "self", undefined, { title: "Lost job" });
  store.updateJob(lost.id, { status: "running", resumed: 1 });
  assert.equal(jobs.liveness(lost.id)!.alive, false);
  assert.match(jobs.liveness(lost.id)!.summary, /marked running but no worker is alive/);
  await jobs.checkLiveness();
  await waitFor(() => started.includes("L"));
  assert.ok(messenger.sent.some((m) => m.text === `Lost job · engineer, workforce · ${lost.id} was marked running but no worker was alive, so I restarted it to carry on from where it left off (attempt 3).`));
  assert.equal(jobs.holder("product"), q1.id, "the product queue is untouched");

  // One that has already been interrupted three times is stopped instead, and its queue moves on.
  const tired = store.createJob("engineer", "T", FOUNDER, "product", undefined, { title: "Tired job" });
  store.updateJob(tired.id, { status: "running", resumed: 3 });
  finish("Q1");
  await waitFor(() => started.includes("Q2"));
  await jobs.checkLiveness();
  assert.equal(store.getJob(tired.id)!.status, "failed");
  assert.equal(store.getJob(tired.id)!.failure, "stalled");
  assert.ok(!started.includes("T"));
  void clock;
});

test("the watchdog starts a queue whose lock is free but whose jobs are still waiting", async () => {
  const { store, jobs, started } = setup();
  await jobs.resumeInterrupted();
  const gone = store.createJob("engineer", "Gone", FOUNDER, "product");
  store.updateJob(gone.id, { status: "done" });
  const w = store.createJob("engineer", "W", FOUNDER, "product");
  store.updateJob(w.id, { waitingFor: gone.id, queuePos: 1 });
  await jobs.checkLiveness();
  await waitFor(() => started.includes("W"));
  assert.equal(jobs.holder("product"), w.id);
});

test("cancelling a running job frees its slot for the next; cancelling a queued one takes it out of the queue", async () => {
  const { store, jobs, saved, started } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "product", undefined, { title: "Vertical demo catalogues" });
  const b = jobs.start("engineer", "B", FOUNDER, "product", undefined, { title: "One-call buy" });
  const c = jobs.start("engineer", "C", FOUNDER, "product", undefined, { title: "Licence terms" });
  await waitFor(() => started.includes("A"));

  const text = await jobs.cancel(c.id);
  assert.equal(text, `Cancelled Licence terms · engineer · ${c.id} before it started; it has left the queue.`);
  assert.equal(store.getJob(c.id)!.failure, "cancelled");
  assert.equal(jobs.queuePosition(c.id), undefined);

  const t2 = await jobs.cancel(a.id);
  await waitFor(() => started.includes("B"));
  assert.match(t2, new RegExp(`^Cancelled Vertical demo catalogues · engineer · ${a.id}\\. Its unfinished work is kept \\(stash "clear-ops ${a.id}: .*" on clear/${a.id}\\), and retry ${a.id} carries on from it\\. One-call buy \\(${b.id}\\) has started in its place\\.$`));
  assert.equal(store.getJob(a.id)!.status, "failed");
  assert.equal(store.getJob(a.id)!.failure, "cancelled");
  assert.deepEqual(saved, [{ id: a.id, why: "cancelled" }]);
  assert.equal(jobs.holder("product"), b.id);
  assert.ok(!started.includes("C"));
  await assert.rejects(jobs.cancel(a.id), /already failed/);
});

test("cancelling a job marked running with no live worker frees the queue", async () => {
  const { store, jobs, started } = setup();
  await jobs.resumeInterrupted();
  const ghost = store.createJob("engineer", "Ghost", FOUNDER, "product");
  store.updateJob(ghost.id, { status: "running" });
  const w = jobs.start("engineer", "W", FOUNDER, "product");
  assert.equal(w.waitingFor, ghost.id);
  await jobs.cancel(ghost.id);
  await waitFor(() => started.includes("W"));
  assert.equal(store.getJob(ghost.id)!.failure, "cancelled");
});

test("a queued job moved to the front starts next", async () => {
  const { store, jobs, started, finish } = setup();
  jobs.start("engineer", "A", FOUNDER, "product");
  const b = jobs.start("engineer", "B", FOUNDER, "product");
  const c = jobs.start("engineer", "C", FOUNDER, "product");
  const d = jobs.start("engineer", "D", FOUNDER, "product", undefined, { title: "Landing page reframe" });
  await waitFor(() => started.includes("A"));
  assert.equal(jobs.queuePosition(d.id), 3);
  assert.match(jobs.moveToFront(d.id), /^Moved Landing page reframe · engineer · \w+ to the front of the product queue; it starts when A \(\w+\) finishes\.$/);
  assert.equal(jobs.queuePosition(d.id), 1);
  assert.equal(jobs.queuePosition(b.id), 2);
  assert.match(jobs.moveToFront(d.id), /already first/);
  assert.throws(() => jobs.moveToFront(store.allJobs().find((j) => j.brief === "A")!.id), /not waiting in a queue/);
  finish("A");
  await waitFor(() => started.includes("D"));
  assert.ok(!started.includes("B"));
  finish("D");
  await waitFor(() => started.includes("B"));
  assert.ok(!started.includes("C"));
  void c;
});

test("the chief can check liveness, cancel and reorder, with Paul's wording in the tool descriptions", async () => {
  const { Orchestrator } = await import("../src/orchestrator.js");
  const { Scheduler } = await import("../src/scheduler.js");
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-live-chief-")));
  const messenger = new ConsoleMessenger();
  const w = workers();
  const out: Record<string, string> = {};
  let systemPrompt = "";
  let described: Record<string, string> = {};
  let ids: { a: string; b: string; c: string } = { a: "", b: "", c: "" };
  const runner: AgentRunner = async (o) => {
    const ops = o.mcpServers?.ops as any;
    if (!ops) return w.runner(o);
    systemPrompt = o.systemPrompt;
    const tools = ops.instance._registeredTools;
    described = Object.fromEntries(Object.entries(tools).map(([k, v]: [string, any]) => [k, v.description]));
    const call = async (name: string, args: unknown) => (await (tools[name].callback ?? tools[name].handler)(args, {})).content[0].text;
    out.alive = await call("job_alive", {});
    out.status = await call("job_status", { id: ids.a });
    out.move = await call("move_job_to_front", { id: ids.c });
    out.cancel = await call("cancel_job", { id: ids.a });
    return { text: "ok", sessionId: "s1" };
  };
  const jobs = new JobRunner(store, messenger, runner, undefined, { liveness: { graceMs: 50, saveWork: async () => undefined } });
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  ids = {
    a: jobs.start("engineer", "A", FOUNDER, "product", undefined, { title: "Vertical demo catalogues" }).id,
    b: jobs.start("engineer", "B", FOUNDER, "product", undefined, { title: "One-call buy" }).id,
    c: jobs.start("engineer", "C", FOUNDER, "product", undefined, { title: "Landing page reframe" }).id,
  };
  await waitFor(() => w.started.includes("A"));
  await orch.handle(FOUNDER, "the queue looks stuck, is anything actually running?");

  assert.match(described.job_alive, /nothing is actively running/);
  assert.match(described.job_alive, /stuck/);
  assert.match(described.cancel_job, /cancel, stop, kill or drop/);
  assert.match(described.cancel_job, /queue slot is freed/);
  assert.match(described.move_job_to_front, /do it first, move it up, prioritise it or let it jump the queue/);
  assert.match(systemPrompt, /call job_alive before answering/);

  assert.match(out.alive, /"alive": true/);
  assert.match(out.alive, /Vertical demo catalogues · engineer · \w+ is alive: its worker last did something under a minute ago/);
  assert.match(out.status, /"liveness": "Vertical demo catalogues/);
  assert.match(out.move, /^Moved Landing page reframe/);
  assert.match(out.cancel, new RegExp(`^Cancelled Vertical demo catalogues · engineer · ${ids.a}\\. retry ${ids.a} runs it again\\. Landing page reframe \\(${ids.c}\\) has started in its place\\.$`));
  await waitFor(() => w.started.includes("C"));
  assert.ok(!w.started.includes("B"));
});

test("stashWork keeps uncommitted work on its branch and leaves the checkout clean", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-live-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "clear/demo-supply-verticals");
  assert.deepEqual(await stashWork(dir, "clear-ops x"), { dir, branch: "clear/demo-supply-verticals" }, "nothing to keep: no stash");

  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  fs.writeFileSync(path.join(dir, "new.ts"), "export {};\n");
  const saved = await stashWork(dir, "clear-ops 54dc3f: Vertical demo catalogues (stopped: stalled)");
  assert.deepEqual(saved, { dir, branch: "clear/demo-supply-verticals", stash: "clear-ops 54dc3f: Vertical demo catalogues (stopped: stalled)" });
  assert.equal(git("status", "--porcelain"), "", "the next job starts in a clean checkout");
  assert.match(git("stash", "list"), /clear-ops 54dc3f: Vertical demo catalogues/);
  git("stash", "apply", "-q");
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "two\n");
  assert.ok(fs.existsSync(path.join(dir, "new.ts")), "untracked files are kept too");

  assert.equal(await stashWork(path.join(dir, "missing"), "x"), undefined);
  assert.match(savedWorkNote(saved!), /git stash apply \(not pop/);
  assert.match(savedWorkNote(saved!), /on branch clear\/demo-supply-verticals/);
});

test("a retried stopped job is told where its kept work is", async () => {
  const { store, jobs, clock, started, prompt } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "self");
  await waitFor(() => started.includes("A"));
  clock.t += 31 * MIN;
  await jobs.checkLiveness();
  await waitFor(() => store.getJob(a.id)!.status === "failed" && !jobs.isRunning(a.id));
  started.length = 0;
  jobs.retry(a.id);
  await waitFor(() => started.includes("A"));
  assert.match(prompt("A"), new RegExp(`stashed with the message "clear-ops ${a.id}: A \\(stopped: stalled\\)"`));
});

test("durations read plainly", () => {
  assert.equal(duration(45 * MIN), "45 minutes");
  assert.equal(duration(240 * MIN), "4 hours");
  assert.equal(duration(130 * MIN), "2 hours 10 minutes");
  assert.equal(duration(60 * MIN + 1), "1 hour");
});
