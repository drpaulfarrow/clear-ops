import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-cap-"));
process.env.DAILY_BUDGET_USD = "10";

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const HOUR = 3_600_000;

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-cap-")));
  const messenger = new ConsoleMessenger();
  const sent: string[] = [];
  const send = messenger.send.bind(messenger);
  messenger.send = async (to: string, text: string) => {
    sent.push(text);
    return send(to, text);
  };
  const started: string[] = [];
  const runner: AgentRunner = async (o) => {
    started.push(o.prompt.split("\n")[0]);
    return { text: "done" };
  };
  const clock = { t: Date.parse("2026-10-28T15:00:00Z") };
  const jobs = new JobRunner(store, messenger, runner, undefined, { liveness: { now: () => clock.t } });
  // Jobs finished today that cost $12, past the $10 cap.
  const spent = store.createJob("research", "earlier", FOUNDER, "product");
  store.updateJob(spent.id, { status: "done", costUsd: 12, finishedAt: new Date(clock.t - HOUR).toISOString() });
  return { store, jobs, clock, sent, started };
}

test("past the daily cap new jobs stay queued, Paul is told once, and /resume lifts it for the day", async () => {
  const { store, jobs, sent, started } = setup();
  await jobs.resumeInterrupted();
  assert.equal(jobs.capReached(), true);

  const a = jobs.start("research", "R1", FOUNDER);
  const b = jobs.start("engineer", "E1", FOUNDER, "product");
  const c = jobs.start("research", "R2", FOUNDER);
  await jobs.checkLiveness();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(started, [], "nothing starts while capped");
  for (const j of [a, b, c]) assert.equal(store.getJob(j.id)!.status, "queued");

  // One message for three blocked jobs, saying what was spent and that /resume lifts it.
  const notices = sent.filter((t) => /daily spend cap/.test(t));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /\$10 is hit: \$12\.00 spent today/);
  assert.match(notices[0], /\/resume/);

  const result = await jobs.resume();
  assert.equal(result.released, false);
  await waitFor(() => ["R1", "R2", "E1"].every((k) => started.includes(k)));
  assert.equal(jobs.capReached(), false);
  // Lifted: a new job starts straight away, with no second notice.
  jobs.start("research", "R3", FOUNDER);
  await waitFor(() => started.includes("R3"));
  assert.equal(sent.filter((t) => /daily spend cap/.test(t)).length, 1);
});

test("blocked jobs start by themselves when the next London day begins", async () => {
  const { store, jobs, clock, started } = setup();
  await jobs.resumeInterrupted();
  const a = jobs.start("engineer", "E1", FOUNDER, "product");
  await jobs.checkLiveness();
  assert.equal(store.getJob(a.id)!.status, "queued");
  clock.t += 12 * HOUR;
  await jobs.checkLiveness();
  await waitFor(() => started.includes("E1"));
});
