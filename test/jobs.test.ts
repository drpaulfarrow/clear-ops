import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-jobs-"));

const { Store } = await import("../src/store.js");
const { JobRunner, lockKey } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunResult } from "../src/agents.js";

const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * A runner whose workers only finish when the test says so. Each run is keyed by the first line of
 * its brief, so the test can finish, fail or inspect a particular job.
 */
function gatedRunner() {
  const gates = new Map<string, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>();
  const started: string[] = [];
  const runner: AgentRunner = (o) =>
    new Promise<RunResult>((resolve, reject) => {
      const key = o.prompt.split("\n")[0];
      started.push(key);
      gates.set(key, { resolve, reject });
    });
  return {
    runner,
    started,
    finish: (key: string, text = `${key} done`) => gates.get(key)!.resolve({ text }),
    fail: (key: string, err = "boom") => gates.get(key)!.reject(new Error(err)),
  };
}

function setup() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-lock-")));
  const messenger = new ConsoleMessenger();
  const g = gatedRunner();
  const jobs = new JobRunner(store, messenger, g.runner);
  return { store, messenger, jobs, ...g };
}

test("the lock covers engineering kinds per repository; the agent-creator always locks the workforce repo", () => {
  assert.equal(lockKey({ kind: "engineer", target: "product" }), "product");
  assert.equal(lockKey({ kind: "engineer" }), "product");
  assert.equal(lockKey({ kind: "engineer", target: "self" }), "self");
  assert.equal(lockKey({ kind: "create_agent", target: "product" }), "self");
  for (const kind of ["maintain", "research", "write", "analyse"] as const) assert.equal(lockKey({ kind, target: "self" }), undefined);
});

test("a second engineer job on the same repository is queued, then starts when the first finishes", async () => {
  const { store, messenger, jobs, started, finish } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "product");
  const b = jobs.start("engineer", "B", FOUNDER, "product");
  assert.equal(store.getJob(a.id)!.status, "running");
  assert.equal(b.status, "queued");
  assert.equal(b.waitingFor, a.id);
  assert.equal(jobs.queuePosition(b.id), 1);
  await waitFor(() => started.includes("A"));
  assert.deepEqual(started, ["A"], "B must not start while A holds the product repository");

  finish("A");
  await waitFor(() => started.includes("B"));
  assert.equal(store.getJob(a.id)!.status, "done");
  assert.equal(store.getJob(b.id)!.status, "running");
  assert.equal(store.getJob(b.id)!.waitingFor, undefined);
  assert.ok(messenger.sent.some((m) => m.text.startsWith(`Job ${b.id} (engineer) was queued and is starting now that job ${a.id} has finished`)));
});

test("the maintainer review still follows the engineer and does not hold the lock", async () => {
  const { store, jobs, started, finish } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "product");
  const b = jobs.start("engineer", "B", FOUNDER, "product");
  await waitFor(() => started.includes("A"));
  finish("A");
  const review = "Review the pull request just opened by the engineer for this task, and any other open pull requests:";
  // The maintainer for A and engineer B both run: the review is not blocked by B, nor B by it.
  await waitFor(() => started.includes("B") && started.includes(review));
  assert.match(store.allJobs().find((j) => j.kind === "maintain")!.brief, new RegExp(`Engineer's report:\nA done`));
  const maint = store.allJobs().find((j) => j.kind === "maintain")!;
  assert.equal(maint.status, "running");
  assert.equal(maint.waitingFor, undefined);
  assert.equal(jobs.holder("product"), b.id);
});

test("a failed or erroring job still releases the lock to the next in line", async () => {
  const { store, messenger, jobs, started, fail } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "self");
  const b = jobs.start("engineer", "B", FOUNDER, "self");
  await waitFor(() => started.includes("A"));
  fail("A");
  await waitFor(() => started.includes("B"));
  assert.equal(store.getJob(a.id)!.status, "failed");
  assert.equal(store.getJob(b.id)!.status, "running");
  assert.ok(messenger.sent.some((m) => m.text === `Job ${a.id} (engineer) failed: boom`));
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0, "a failed engineer starts no review");
});

test("different repositories run concurrently", async () => {
  const { store, jobs, started } = setup();
  const p = jobs.start("engineer", "P", FOUNDER, "product");
  const s = jobs.start("engineer", "S", FOUNDER, "self");
  await waitFor(() => started.includes("P") && started.includes("S"));
  assert.equal(store.getJob(p.id)!.status, "running");
  assert.equal(store.getJob(s.id)!.status, "running");
  assert.equal(s.waitingFor, undefined);
});

test("the agent-creator shares the workforce lock with self engineer jobs, not the product's", async () => {
  const { jobs, started, finish } = setup();
  const s = jobs.start("engineer", "S", FOUNDER, "self");
  const p = jobs.start("engineer", "P", FOUNDER, "product");
  const c = jobs.start("create_agent", "C", FOUNDER, "product");
  assert.equal(c.waitingFor, s.id);
  assert.equal(p.waitingFor, undefined);
  await waitFor(() => started.includes("S") && started.includes("P"));
  assert.ok(!started.includes("C"));
  finish("S");
  await waitFor(() => started.includes("C"));
});

test("three jobs on one repository start in FIFO order, one at a time", async () => {
  const { store, jobs, started, finish } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "product");
  const b = jobs.start("engineer", "B", FOUNDER, "product");
  const c = jobs.start("engineer", "C", FOUNDER, "product");
  assert.equal(jobs.queuePosition(b.id), 1);
  assert.equal(jobs.queuePosition(c.id), 2);
  await waitFor(() => started.includes("A"));
  finish("A");
  await waitFor(() => started.includes("B"));
  assert.ok(!started.includes("C"), "C waits for B, not for A");
  assert.equal(store.getJob(c.id)!.waitingFor, b.id, "the waiter points at the new holder");
  assert.equal(jobs.queuePosition(c.id), 1);
  finish("B");
  await waitFor(() => started.includes("C"));
  assert.deepEqual(started.filter((k) => ["A", "B", "C"].includes(k)), ["A", "B", "C"]);
});

test("non-engineering kinds never queue, even beside a running engineer", async () => {
  const { jobs, started } = setup();
  jobs.start("engineer", "E", FOUNDER, "product");
  jobs.start("engineer", "E2", FOUNDER, "product");
  const kinds = ["research", "write", "analyse", "maintain", "maintain"] as const;
  const others = kinds.map((k, i) => jobs.start(k, `K${i}`, FOUNDER, "product"));
  for (const j of others) assert.equal(j.waitingFor, undefined);
  await waitFor(() => kinds.every((_, i) => started.includes(`K${i}`)));
  assert.ok(!started.includes("E2"));
});

test("the queue survives a restart: the interrupted holder resumes first, waiters keep their order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-lock-restart-"));
  {
    const store = new Store(dir);
    const jobs = new JobRunner(store, new ConsoleMessenger(), gatedRunner().runner);
    jobs.start("engineer", "A", FOUNDER, "product");
    jobs.start("engineer", "B", FOUNDER, "product");
    jobs.start("engineer", "C", FOUNDER, "product");
    jobs.start("engineer", "S", FOUNDER, "self");
    // The process dies here, with A and S running and B, C queued.
  }
  const store = new Store(dir); // a fresh process reading the same volume
  const byBrief = (b: string) => store.allJobs().find((j) => j.brief === b)!;
  assert.equal(byBrief("B").status, "queued");
  assert.equal(byBrief("B").waitingFor, byBrief("A").id);

  const messenger = new ConsoleMessenger();
  const g = gatedRunner();
  const jobs = new JobRunner(store, messenger, g.runner);
  // A request that arrives before the resume has run still queues behind the interrupted job.
  const d = jobs.start("engineer", "D", FOUNDER, "product");
  assert.equal(d.waitingFor, byBrief("A").id);

  const n = await jobs.resumeInterrupted();
  assert.equal(n, 2, "only A and S were interrupted; queued jobs were never started");
  await waitFor(() => g.started.includes("A") && g.started.includes("S"));
  assert.equal(byBrief("A").resumed, 1);
  assert.equal(byBrief("B").resumed, undefined, "a job that never started gets no resume note");
  assert.ok(!["B", "C", "D"].some((k) => g.started.includes(k)), "nothing else starts on product");

  g.finish("A");
  await waitFor(() => g.started.includes("B"));
  assert.ok(!g.started.includes("C"));
  g.finish("B");
  await waitFor(() => g.started.includes("C"));
  g.finish("C");
  await waitFor(() => g.started.includes("D"));
  assert.ok(messenger.sent.some((m) => /Resuming it/.test(m.text)));
});

test("on restart two engineering jobs left running on one repository do not both resume", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-lock-legacy-"));
  let store = new Store(dir);
  const a = store.createJob("engineer", "A", FOUNDER, "self");
  const b = store.createJob("create_agent", "B", FOUNDER, "self");
  store.updateJob(a.id, { status: "running" });
  store.updateJob(b.id, { status: "running" });
  store = new Store(dir);
  const messenger = new ConsoleMessenger();
  const g = gatedRunner();
  const jobs = new JobRunner(store, messenger, g.runner);
  await jobs.resumeInterrupted();
  await waitFor(() => g.started.length > 0);
  assert.equal(g.started.length, 1);
  const [first, second] = g.started[0] === "A" ? [a, b] : [b, a];
  assert.equal(store.getJob(second.id)!.status, "queued");
  assert.equal(store.getJob(second.id)!.waitingFor, first.id);
  assert.ok(messenger.sent.some((m) => m.text.includes(`queued behind job ${first.id}`)));
  g.finish(g.started[0], "VERDICT: schedule\nnothing to build");
  await waitFor(() => g.started.includes(second.brief));
  assert.equal(store.getJob(second.id)!.status, "running");
});

test("on restart, a queue whose holder gives up starts its next job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-lock-giveup-"));
  let store = new Store(dir);
  const a = store.createJob("engineer", "A", FOUNDER, "product");
  store.updateJob(a.id, { status: "running", resumed: 3 });
  const b = store.createJob("engineer", "B", FOUNDER, "product");
  store.updateJob(b.id, { waitingFor: a.id, queuePos: 1 });
  store = new Store(dir);
  const g = gatedRunner();
  const jobs = new JobRunner(store, new ConsoleMessenger(), g.runner);
  await jobs.resumeInterrupted();
  assert.equal(store.getJob(a.id)!.status, "failed");
  await waitFor(() => g.started.includes("B"));
  assert.equal(jobs.holder("product"), b.id);
});

test("the chief's start_job says a job was queued and behind which job; job_status shows it", async () => {
  const { Orchestrator } = await import("../src/orchestrator.js");
  const { Scheduler } = await import("../src/scheduler.js");
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-lock-chief-")));
  const messenger = new ConsoleMessenger();
  const replies: string[] = [];
  let systemPrompt = "";
  const g = gatedRunner();
  const runner: AgentRunner = async (o) => {
    const ops = o.mcpServers?.ops as any;
    if (!ops) return g.runner(o);
    systemPrompt = o.systemPrompt;
    const tools = ops.instance?._registeredTools;
    const call = (name: string, args: unknown) => (tools[name].callback ?? tools[name].handler)(args, {});
    const r1 = await call("start_job", { kind: "engineer", brief: "First", target: "self" });
    const r2 = await call("start_job", { kind: "create_agent", brief: "Second", target: "product" });
    const list = await call("job_status", {});
    replies.push(r1.content[0].text, r2.content[0].text, list.content[0].text);
    return { text: "ok", sessionId: "s1" };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  await orch.handle(FOUNDER, "two self changes please");
  const first = store.allJobs().find((j) => j.brief === "First")!;
  assert.match(replies[0], new RegExp(`^Started job ${first.id}`));
  assert.match(replies[1], new RegExp(`^Queued job \\w+ \\(create_agent, on the workforce itself\\): queued behind job ${first.id}.*starts automatically`));
  assert.match(replies[2], new RegExp(`create_agent queued behind ${first.id} \\(#1 on self\\)`));
  assert.match(systemPrompt, /Queueing is automatic/);
});
