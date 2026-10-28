import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-failures-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { classifyError, failureFromError, failureText, FailureNotifier, runFailure } = await import("../src/failures.js");
const { Orchestrator, chiefFailureText } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { PAUL_STYLE } = await import("../src/messages.js");
import type { AgentRunner, RunResult } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const PR = "https://github.com/acme/clear-exchange/pull/12";
const CREDIT = "Credit balance is too low";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runner whose runs finish only when the test says so, keyed by the first line of the brief. */
function gatedRunner() {
  const gates = new Map<string, (r: RunResult) => void>();
  const started: string[] = [];
  const runner: AgentRunner = (o) =>
    new Promise<RunResult>((resolve) => {
      const key = o.prompt.split("\n")[0];
      started.push(key);
      gates.set(key, resolve);
    });
  return { runner, started, finish: (key: string, r: RunResult) => gates.get(key)!(r) };
}

function setup(batchMs = 60, cooldownMs = 200) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fail-")));
  const messenger = new ConsoleMessenger();
  const g = gatedRunner();
  const jobs = new JobRunner(store, messenger, g.runner, undefined, { failureNotices: { batchMs, cooldownMs } });
  return { store, messenger, jobs, ...g };
}

const failedNotices = (m: InstanceType<typeof ConsoleMessenger>) => m.sent.filter((s) => s.text.startsWith("Failed:"));

test("API and SDK errors are recognised as failures; a real report never is", () => {
  assert.deepEqual(runFailure({ text: CREDIT }), { kind: "credit", detail: CREDIT });
  assert.equal(runFailure({ text: "" })?.kind, "empty");
  assert.equal(runFailure({ text: "   \n" })?.kind, "empty");
  assert.equal(runFailure({ text: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}" })?.kind, "overloaded");
  assert.equal(runFailure({ text: "API Error: 429 rate_limit_error: too many requests" })?.kind, "rate_limit");
  assert.equal(runFailure({ text: "Invalid API key · Please run /login" })?.kind, "auth");
  assert.equal(runFailure({ text: "API Error: 500 Internal server error" })?.kind, "api");
  // The runner's own verdict wins.
  assert.equal(runFailure({ text: "whatever", error: { kind: "auth", detail: "401" } })?.kind, "auth");
  // Real work that mentions credit, billing or rate limits is a report, not a failure.
  assert.equal(runFailure({ text: "Researched billing: Stripe's credit balance is too low a bar for publishers, so we should..." }), undefined);
  assert.equal(runFailure({ text: `Opened ${PR}. Added a rate limit test. Tests green.` }), undefined);
  assert.equal(runFailure({ text: `${CREDIT}. ${"x".repeat(500)}` }), undefined, "a long text is a report");
  // The SDK's code and the HTTP status beat the text.
  assert.equal(classifyError("something", "billing_error"), "credit");
  assert.equal(classifyError("something", "authentication_failed"), "auth");
  assert.equal(classifyError("something", undefined, 402), "credit");
  assert.equal(classifyError("something", undefined, 401), "auth");
  assert.equal(classifyError("something", "overloaded"), "overloaded");
  // A thrown SDK error is classified; a thrown service error stays a plain error.
  assert.equal(failureFromError(new Error(`Claude Code process exited with code 1: ${CREDIT}`)).kind, "credit");
  assert.equal(failureFromError(new Error("boom")).kind, "error");
});

test("a credit failure is recorded as failed with the reason, and nothing follows it", async () => {
  const { store, messenger, jobs, started, finish } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "product", undefined, { title: "Fly deploy" });
  await waitFor(() => started.includes("A"));
  finish("A", { text: CREDIT, costUsd: 0 });
  await waitFor(() => store.getJob(a.id)!.status === "failed");
  const job = store.getJob(a.id)!;
  assert.equal(job.failure, "credit");
  assert.equal(job.error, CREDIT);
  assert.equal(job.pr, undefined);
  assert.match(store.readOutput(a.id)!, /failed and did no work, because the Anthropic account is out of credit/);
  // No auto-review, no "Finished".
  await sleep(120);
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0, "no review of a pull request that does not exist");
  assert.ok(!messenger.sent.some((m) => m.text.startsWith("Finished:")));
  // One plain message: title, id, plain reason, what to do.
  const notices = failedNotices(messenger);
  assert.equal(notices.length, 1);
  const text = notices[0].text;
  assert.match(text, new RegExp(`^Failed: Fly deploy · engineer · ${a.id}\\. It did no work because the Anthropic account is out of credit\\.`));
  assert.match(text, /top up the Anthropic credit/);
  assert.match(text, /\/resume/);
  assert.ok(!text.includes("—"), "no em dashes");
  assert.ok(!/^\s*[-*•]|^#/m.test(text), "no bullets or headings");
  assert.equal(store.queueHold()?.kind, "credit");
});

test("a credit outage holds the engineering queue and sends one message for the whole burst", async () => {
  const { store, messenger, jobs, started, finish } = setup(80);
  const a = jobs.start("engineer", "A", FOUNDER, "product", undefined, { title: "Job A" });
  const queued = ["B", "C", "D", "E"].map((k) => jobs.start("engineer", k, FOUNDER, "product", undefined, { title: `Job ${k}` }));
  const r1 = jobs.start("research", "R1", FOUNDER, "product", undefined, { title: "Research one" });
  const s1 = jobs.start("engineer", "S1", FOUNDER, "self", undefined, { title: "Self job" });
  await waitFor(() => ["A", "R1", "S1"].every((k) => started.includes(k)));
  finish("A", { text: CREDIT });
  finish("R1", { text: CREDIT });
  finish("S1", { text: "", error: { kind: "credit", detail: CREDIT } });
  await waitFor(() => failedNotices(messenger).length > 0);
  await sleep(150);
  // The queue is not burned through: B..E never started and wait for /resume.
  assert.deepEqual(started.sort(), ["A", "R1", "S1"]);
  for (const q of queued) {
    const j = store.getJob(q.id)!;
    assert.equal(j.status, "queued");
    assert.ok(jobs.isHeld(j));
  }
  // Exactly one message naming every failed job.
  const notices = failedNotices(messenger);
  assert.equal(notices.length, 1, notices.map((n) => n.text).join("\n"));
  const text = notices[0].text;
  assert.match(text, /^Failed: 3 jobs did no work because the Anthropic account is out of credit/);
  for (const j of [a, r1, s1]) assert.ok(text.includes(j.id), `names ${j.id}`);
  assert.match(text, /paused the engineering queue so the 4 jobs waiting in it do not fail/);
  assert.match(text, /top up the Anthropic credit/);
  // A new engineering job while held waits too, and says so.
  const late = jobs.start("engineer", "LATE", FOUNDER, "product");
  assert.equal(late.status, "queued");
  assert.ok(jobs.isHeld(late));
  await sleep(30);
  assert.ok(!started.includes("LATE"));
});

test("failures after the first message are gathered into one follow-up, not a flood", async () => {
  const messenger = new ConsoleMessenger();
  const n = new FailureNotifier(messenger, { batchMs: 30, cooldownMs: 150 });
  const job = (id: string) => ({ id, title: `Job ${id}`, brief: id, kind: "research" as const, requestedBy: FOUNDER, replyTo: FOUNDER });
  const f = { kind: "overloaded" as const, detail: "overloaded_error" };
  n.add(job("aaaaaa"), f);
  await waitFor(() => messenger.sent.length === 1);
  for (const id of ["bbbbbb", "cccccc", "dddddd"]) n.add(job(id), f);
  await sleep(60);
  assert.equal(messenger.sent.length, 1, "nothing more during the cooldown");
  await waitFor(() => messenger.sent.length === 2);
  assert.match(messenger.sent[1].text, /^Failed: 3 jobs did no work because the Anthropic API was overloaded/);
  assert.match(messenger.sent[1].text, /bbbbbb.*cccccc.*dddddd/);
  // Different reasons are separate messages.
  n.add(job("eeeeee"), { kind: "auth", detail: "401" });
  await waitFor(() => messenger.sent.length === 3);
  assert.match(messenger.sent[2].text, /API key was rejected/);
  // Jobs reporting to different threads are batched to Paul himself.
  const m2 = new ConsoleMessenger();
  const n2 = new FailureNotifier(m2, { batchMs: 30, cooldownMs: 50 });
  n2.add({ ...job("ffffff"), replyTo: "dc:c:1" }, f);
  n2.add({ ...job("aaaaab"), replyTo: "dc:c:2", requestedBy: FOUNDER }, f);
  await waitFor(() => m2.sent.length === 1);
  assert.equal(m2.sent[0].to, FOUNDER);
});

test("/resume lifts the hold, reruns the failed jobs first and restarts the queue in order", async () => {
  const { store, messenger, jobs, started, finish } = setup(20, 50);
  const a = jobs.start("engineer", "A", FOUNDER, "product");
  const b = jobs.start("engineer", "B", FOUNDER, "product");
  const c = jobs.start("engineer", "C", FOUNDER, "product");
  await waitFor(() => started.includes("A"));
  finish("A", { text: CREDIT });
  await waitFor(() => store.queueHold() !== undefined);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), async () => ({ text: "unused" }));
  await orch.handle(FOUNDER, "/jobs");
  const list = messenger.sent.at(-1)!.text;
  assert.match(list, /^Engineering queue paused: the Anthropic account is out of credit\. Send \/resume/);
  assert.match(list, new RegExp(`${a.id} · failed: out of Anthropic credit`));
  assert.match(list, new RegExp(`${b.id} · held until /resume, #1 on product`));

  await orch.handle(FOUNDER, "/resume");
  assert.match(messenger.sent.at(-1)!.text, new RegExp(`^The engineering queue is running again\\. Rerunning A \\(${a.id}\\)\\.`));
  assert.equal(store.queueHold(), undefined);
  // The failed job reruns first, under the same id; B and C wait behind it in order.
  await waitFor(() => started.filter((k) => k === "A").length === 2);
  assert.equal(store.getJob(a.id)!.status, "running");
  assert.equal(store.getJob(a.id)!.failure, undefined);
  assert.equal(jobs.queuePosition(b.id), 1);
  assert.equal(jobs.queuePosition(c.id), 2);
  finish("A", { text: `Opened ${PR}. Tests green.` });
  await waitFor(() => started.includes("B"));
  assert.equal(store.getJob(a.id)!.status, "done");
  assert.ok(store.allJobs().some((j) => j.kind === "maintain" && j.reviewOf === a.id), "a real run is reviewed as usual");
});

test("retry <id> reruns one failed job; a job that is not failed is refused", async () => {
  const { store, messenger, jobs, started, finish } = setup(20, 50);
  const r = jobs.start("research", "R", FOUNDER, "product", undefined, { title: "Busy research" });
  await waitFor(() => started.includes("R"));
  finish("R", { text: "API Error: 429 rate_limit_error" });
  await waitFor(() => store.getJob(r.id)!.status === "failed");
  assert.equal(store.queueHold(), undefined, "a rate limit does not hold the queue");
  await waitFor(() => failedNotices(messenger).length === 1);
  assert.match(failedNotices(messenger)[0].text, new RegExp(`rate limiting it.*send retry ${r.id}`));
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), async () => ({ text: "unused" }));
  await orch.handle(FOUNDER, `retry ${r.id}`);
  assert.equal(messenger.sent.at(-1)!.text, `Rerunning Busy research (${r.id}).`);
  await waitFor(() => started.filter((k) => k === "R").length === 2);
  finish("R", { text: "A real brief." });
  await waitFor(() => store.getJob(r.id)!.status === "done");
  await orch.handle(FOUNDER, `retry ${r.id}`);
  assert.match(messenger.sent.at(-1)!.text, new RegExp(`Nothing to retry for ${r.id}`));
});

test("a maintainer review that fails on credit starts no fix round and sends no escalation", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fail-review-")));
  const messenger = new ConsoleMessenger();
  const runner: AgentRunner = async (o) => (o.systemPrompt.startsWith("You are the maintainer") ? { text: CREDIT } : { text: `Opened ${PR}. Tests green.` });
  const jobs = new JobRunner(store, messenger, runner, undefined, { failureNotices: { batchMs: 20, cooldownMs: 50 } });
  const eng = jobs.start("engineer", "Build it", FOUNDER, "product");
  await waitFor(() => store.allJobs().some((j) => j.kind === "maintain" && j.status === "failed"));
  await sleep(100);
  const review = store.allJobs().find((j) => j.kind === "maintain")!;
  assert.equal(review.reviewOf, eng.id);
  assert.equal(review.failure, "credit");
  assert.equal(store.allJobs().filter((j) => j.kind === "engineer").length, 1, "no fix round");
  assert.ok(!messenger.sent.some((m) => /Action needed|Changes requested|Finished: Review/.test(m.text)));
  assert.equal(failedNotices(messenger).length, 1);
});

test("the chief is told about failed jobs and a paused queue, and its own credit failure reads plainly", async () => {
  const { store, messenger, jobs, started, finish } = setup(20, 50);
  const a = jobs.start("engineer", "A", FOUNDER, "self", undefined, { title: "Status line" });
  await waitFor(() => started.includes("A"));
  finish("A", { text: CREDIT });
  await waitFor(() => store.queueHold() !== undefined);
  let systemPrompt = "";
  const replies: string[] = [];
  const runner: AgentRunner = async (o) => {
    systemPrompt = o.systemPrompt;
    const tools = (o.mcpServers?.ops as any).instance._registeredTools;
    const call = async (name: string, args: unknown) => (await (tools[name].callback ?? tools[name].handler)(args, {})).content[0].text as string;
    replies.push(await call("job_status", { id: a.id }));
    replies.push(await call("job_status", {}));
    replies.push(await call("start_job", { kind: "engineer", title: "Another fix", brief: "More", target: "product" }));
    replies.push(await call("resume_jobs", {}));
    return { text: "ok", sessionId: "s1" };
  };
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  await orch.handle(FOUNDER, "how are the jobs?");
  assert.match(systemPrompt, /status is "failed" did no work/);
  assert.match(systemPrompt, /Never tell Paul a failed job ran or is done/);
  assert.match(systemPrompt, new RegExp(`engineering queue is paused: job ${a.id} failed because the Anthropic account is out of credit`));
  const status = JSON.parse(replies[0]);
  assert.equal(status.status, "failed");
  assert.equal(status.failure, "credit");
  assert.match(status.failedReason, /did no work, because the Anthropic account is out of credit\. Treat it as not done/);
  assert.match(replies[1], new RegExp(`${a.id} · failed: out of Anthropic credit`));
  assert.match(replies[2], /^Queued but held: Another fix .*paused because the Anthropic account is out of credit/);
  assert.equal(replies[3], `The engineering queue is running again. Rerunning Status line (${a.id}).`);

  // The chief itself out of credit: a plain sentence, not the raw API text.
  const text = chiefFailureText({ kind: "credit", detail: CREDIT });
  assert.equal(text, "I could not answer because the Anthropic account is out of credit. Please top up the Anthropic credit at console.anthropic.com, then message me again.");
  const m2 = new ConsoleMessenger();
  const s2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-fail-chief-")));
  const broke: AgentRunner = async () => ({ text: CREDIT, error: { kind: "credit", detail: CREDIT } });
  const orch2 = new Orchestrator(s2, m2, new JobRunner(s2, m2, broke), new Scheduler(s2, new JobRunner(s2, m2, broke)), broke);
  await orch2.handle(FOUNDER, "hello");
  assert.equal(m2.sent.at(-1)!.text, text);
});

test("failure messages follow Paul's style: plain sentences, British English, no em dashes", () => {
  const jobs = [
    { id: "3552e7", title: "Fly deploy", brief: "x", kind: "engineer" as const },
    { id: "063198", title: "Review: Fly deploy", brief: "x", kind: "maintain" as const },
  ];
  for (const kind of ["credit", "auth", "rate_limit", "overloaded", "api", "empty", "error"] as const) {
    for (const set of [jobs.slice(0, 1), jobs]) {
      const t = failureText(set, { kind, detail: "API Error: 500 — something" });
      assert.ok(!/[—–]/.test(t.replace("API Error: 500 — something", "")), `${kind}: no em dashes`);
      assert.ok(!/^\s*([-*•]|#|\d+\.)\s/m.test(t), `${kind}: no lists or headings`);
      assert.ok(!/Outcome:/i.test(t));
      for (const j of set) assert.ok(t.includes(j.id), `${kind}: names ${j.id}`);
      assert.ok(t.split(/(?<=\.)\s/).length <= 5, `${kind}: short`);
    }
  }
  assert.ok(PAUL_STYLE.length > 0);
});
