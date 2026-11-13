import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-restarts-"));

const { Store } = await import("../src/store.js");
const { JobRunner, continueNote } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { JobProgress, describeWorkerTool } = await import("../src/status.js");
import type { AgentRunner, RunOptions, RunResult } from "../src/agents.js";
import type { Messenger } from "../src/whatsapp.js";

const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const REPORT = "Done the work.\n<message_to_paul>Done.</message_to_paul>";

test("an interrupted job carries on its own conversation after a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-resume-session-"));
  {
    const store = new Store(dir);
    // The first process: the worker reports its session, then the process dies mid-run.
    const runner: AgentRunner = (o) => {
      o.onSession?.("sess-123");
      return new Promise<RunResult>(() => undefined);
    };
    const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
    const job = jobs.start("research", "Look into X", FOUNDER, "product");
    await waitFor(() => store.getJob(job.id)?.sessionId === "sess-123");
  }
  const store = new Store(dir);
  const calls: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    calls.push(o);
    return { text: REPORT, costUsd: 0.01 };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  await jobs.resumeInterrupted();
  const id = store.allJobs()[0].id;
  await waitFor(() => store.getJob(id)?.status === "done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, "sess-123", "the same conversation is resumed");
  assert.match(calls[0].prompt, /restarted while you were working/);
  assert.ok(!calls[0].prompt.includes("Look into X"), "the brief is already in the conversation");
});

test("a session that cannot be resumed falls back to a fresh run with the brief", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-resume-fallback-"));
  {
    const store = new Store(dir);
    const runner: AgentRunner = (o) => {
      o.onSession?.("gone");
      return new Promise<RunResult>(() => undefined);
    };
    const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
    const job = jobs.start("research", "Look into Y", FOUNDER, "product");
    await waitFor(() => store.getJob(job.id)?.sessionId === "gone");
  }
  const store = new Store(dir);
  const calls: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    calls.push(o);
    if (o.resume) throw new Error("No conversation found with session ID: gone");
    return { text: REPORT };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  await jobs.resumeInterrupted();
  const id = store.allJobs()[0].id;
  await waitFor(() => store.getJob(id)?.status === "done");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, undefined);
  assert.match(calls[1].prompt, /Look into Y/);
  assert.match(calls[1].prompt, /interrupted by a service restart/);
});

test("a credit failure while resuming is a real failure, not a reason to run again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-resume-credit-"));
  {
    const store = new Store(dir);
    const runner: AgentRunner = (o) => {
      o.onSession?.("s1");
      return new Promise<RunResult>(() => undefined);
    };
    const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
    const job = jobs.start("research", "Look into Z", FOUNDER, "product");
    await waitFor(() => store.getJob(job.id)?.sessionId === "s1");
  }
  const store = new Store(dir);
  let calls = 0;
  const runner: AgentRunner = async () => {
    calls++;
    return { text: "", error: { kind: "credit", detail: "Insufficient credits" } };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner, undefined, { failureNotices: { batchMs: 1 } });
  await jobs.resumeInterrupted();
  const id = store.allJobs()[0].id;
  await waitFor(() => store.getJob(id)?.status === "failed");
  assert.equal(calls, 1);
});

test("a retry starts a fresh conversation", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-retry-session-")));
  const calls: RunOptions[] = [];
  let fail = true;
  const runner: AgentRunner = async (o) => {
    calls.push(o);
    o.onSession?.(`s${calls.length}`);
    if (fail) return { text: "", error: { kind: "error", detail: "boom" } };
    return { text: REPORT };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner, undefined, { failureNotices: { batchMs: 1 } });
  const job = jobs.start("research", "R", FOUNDER, "product");
  await waitFor(() => store.getJob(job.id)?.status === "failed");
  fail = false;
  jobs.retry(job.id);
  await waitFor(() => store.getJob(job.id)?.status === "done");
  assert.equal(calls[1].resume, undefined);
});

test("activeCount is what the deploy waits on", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-active-")));
  let release!: (r: RunResult) => void;
  const runner: AgentRunner = () => new Promise<RunResult>((r) => (release = r));
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  assert.equal(jobs.activeCount(), 0);
  const job = jobs.start("research", "Busy", FOUNDER, "product");
  await waitFor(() => jobs.activeCount() === 1);
  release({ text: REPORT });
  await waitFor(() => store.getJob(job.id)?.status === "done");
  assert.equal(jobs.activeCount(), 0);
});

/** A messenger that can edit, recording every call. */
function editingMessenger() {
  const log: string[] = [];
  const m: Messenger = {
    async send(to, text) {
      log.push(`send ${text}`);
    },
    async sendEditable(_to, text) {
      log.push(`new ${text}`);
      return "h1";
    },
    async edit(_to, _h, text) {
      log.push(`edit ${text}`);
    },
    async remove() {
      log.push("remove");
    },
  };
  return { m, log };
}

test("the progress line waits a minute, shows the latest step and time, and goes when the job ends", async () => {
  let now = 0;
  const { m, log } = editingMessenger();
  const p = new JobProgress(m, "dc:c:1", { firstAfterMs: 60_000, now: () => now });
  p.note("Reading jobs.ts");
  p.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(log.length, 0, "nothing in the first minute");
  now = 90_000;
  p.note("Running the tests");
  p.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["new Working, 1 minute in: Running the tests…"]);
  p.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(log.length, 1, "an unchanged line is not edited again");
  now = 13 * 60_000;
  p.note("Opening the pull request");
  p.tick();
  await new Promise((r) => setTimeout(r, 5));
  await p.finish();
  assert.deepEqual(log.slice(1), ["edit Working, 13 minutes in: Opening the pull request…", "remove"]);
});

test("a channel that cannot edit gets no progress messages at all", async () => {
  const sent: string[] = [];
  const m: Messenger = { async send(_to, t) { sent.push(t); } };
  const p = new JobProgress(m, "+447700900000", { firstAfterMs: 0 }).start();
  p.note("Reading a file");
  p.tick();
  await p.finish();
  assert.deepEqual(sent, []);
});

test("worker steps read as plain words and never show a command", () => {
  assert.equal(describeWorkerTool("Read", { file_path: "/data/self/src/jobs.ts" }), "Reading jobs.ts");
  assert.equal(describeWorkerTool("Edit", { file_path: "src/status.ts" }), "Editing status.ts");
  assert.equal(describeWorkerTool("Bash", { command: "npm test 2>&1 | tail" }), "Running the tests");
  assert.equal(describeWorkerTool("Bash", { command: "npm run build" }), "Typechecking");
  assert.equal(describeWorkerTool("Bash", { command: "gh pr create --title x" }), "Opening the pull request");
  assert.equal(describeWorkerTool("Bash", { command: "SECRET=abc ./thing.sh" }), "Running a command");
  assert.equal(describeWorkerTool("mcp__search__web_search", { query: "prebid 10 release" }), "Searching the web: prebid 10 release");
  assert.equal(describeWorkerTool("mcp__browse__open", { url: "https://www.amazon.co.uk/x" }), "Reading amazon.co.uk");
  assert.equal(describeWorkerTool("mcp__something__unknown"), "Working");
  assert.match(continueNote(2), /attempt 2/);
});

test("a running job shows its progress in its thread and removes it when done", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-progress-job-")));
  const { m, log } = editingMessenger();
  let release!: (r: RunResult) => void;
  let tool!: (n: string, i: Record<string, unknown>) => void;
  const runner: AgentRunner = (o) =>
    new Promise<RunResult>((r) => {
      tool = o.onToolUse!;
      release = r;
    });
  const jobs = new JobRunner(store, m, runner, undefined, { progress: { firstAfterMs: 0, everyMs: 5 } });
  const job = jobs.start("research", "P", FOUNDER, "product");
  await waitFor(() => Boolean(tool));
  tool("WebSearch", { query: "fly deploys" });
  await waitFor(() => log.some((l) => l.startsWith("new Working")));
  release({ text: REPORT });
  await waitFor(() => store.getJob(job.id)?.status === "done");
  await waitFor(() => log.includes("remove"));
  const removedAt = log.indexOf("remove");
  const finishedAt = log.findIndex((l) => l.startsWith("send ") && /Done/.test(l));
  assert.ok(removedAt < finishedAt, "the progress line goes before the finished message");
});
