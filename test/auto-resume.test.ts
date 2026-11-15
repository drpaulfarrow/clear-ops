import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-autoresume-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { nextCheckAt, AUTO_RESUME_BACKOFF_MIN } = await import("../src/auto-resume.js");
import type { AgentRunner, RunResult } from "../src/agents.js";
import type { Messenger } from "../src/whatsapp.js";
import type { Canary } from "../src/auto-resume.js";

const FOUNDER = "tg:99887766";
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(answers: boolean[]) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ar-")));
  const sent: string[] = [];
  const messenger: Messenger = { async send(_to, t) { sent.push(t); } };
  let credit = false;
  const runner: AgentRunner = async (): Promise<RunResult> =>
    credit ? { text: "Done.\n<message_to_paul>Done.</message_to_paul>" } : { text: "", error: { kind: "credit", detail: "Insufficient credits" } };
  let now = Date.parse("2026-11-15T12:00:00Z");
  const calls: string[] = [];
  const canary: Canary = async (p) => {
    calls.push(p);
    const ok = answers.shift() ?? false;
    if (ok) credit = true;
    return { ok, detail: ok ? "200" : "402" };
  };
  const jobs = new JobRunner(store, messenger, runner, undefined, { failureNotices: { batchMs: 1 }, canary, liveness: { now: () => now } });
  return { store, jobs, sent, calls, advance: (mins: number) => (now += mins * 60_000), setNow: (t: number) => (now = t) };
}

test("the backoff is 2, 5, 10, 15 then every 30 minutes", () => {
  assert.deepEqual(AUTO_RESUME_BACKOFF_MIN, [2, 5, 10, 15, 30]);
  assert.equal(nextCheckAt(0, 0), 2 * 60_000);
  assert.equal(nextCheckAt(0, 9), 30 * 60_000);
});

test("a credit hold lifts itself once the provider answers, reruns the job and tells Paul", async () => {
  const t = setup([false, true]);
  const job = t.jobs.start("engineer", "Fix it", FOUNDER, "product");
  await waitFor(() => t.store.getJob(job.id)?.status === "failed");
  const hold = t.store.queueHold();
  assert.ok(hold, "the queue is held");
  t.setNow(Date.parse(hold!.since));
  assert.equal(await t.jobs.tryAutoResume(), false, "not before the first interval");
  assert.equal(t.calls.length, 0);
  t.advance(2);
  assert.equal(await t.jobs.tryAutoResume(), false, "the provider still refuses");
  assert.equal(t.calls.length, 1);
  assert.ok(t.store.queueHold(), "still held");
  t.advance(2);
  assert.equal(await t.jobs.tryAutoResume(), false, "the next check waits 5 minutes");
  assert.equal(t.calls.length, 1);
  t.advance(4);
  assert.equal(await t.jobs.tryAutoResume(), true);
  assert.equal(t.store.queueHold(), undefined, "the hold is lifted");
  await waitFor(() => t.store.getJob(job.id)?.status === "done");
  assert.ok(t.sent.some((m) => /answering again/.test(m) && /No need to send \/resume/.test(m)));
  assert.equal(new Set(t.calls).size, 1, "every check asks the same provider");
});

test("without a canary nothing checks, and /resume still works", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ar-none-")));
  let calls = 0;
  const runner: AgentRunner = async () => (++calls === 1 ? { text: "", error: { kind: "credit", detail: "Insufficient credits" } } : { text: "Done.\n<message_to_paul>Done.</message_to_paul>" });
  const jobs = new JobRunner(store, { async send() {} }, runner, undefined, { failureNotices: { batchMs: 1 } });
  const job = jobs.start("engineer", "X", FOUNDER, "product");
  await waitFor(() => store.getJob(job.id)?.status === "failed");
  assert.equal(await jobs.tryAutoResume(), false);
  assert.ok(store.queueHold());
  await jobs.resume();
  await waitFor(() => store.getJob(job.id)?.status === "done");
  assert.equal(store.queueHold(), undefined);
});
