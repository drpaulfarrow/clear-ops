/**
 * The jobs board: one read-only page Paul bookmarks on his phone instead of typing /jobs in chat.
 * No network and no model: the fake runner is never invoked, because the board only reads what is
 * already in the store. The tests cover the token (accepted and refused), the shape it returns, that
 * a brief, an output or a spend figure cannot leak, and that a running, a queued and a finished job
 * each render.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-board-"));

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { boardToken, boardTokenValid, boardData, renderBoard, BOARD_PATH } = await import("../src/jobs-board.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";
import type { JobRunner } from "../src/jobs.js";
import type { Scheduler } from "../src/scheduler.js";
import type { Job } from "../src/store.js";

/** The board reads the store, so the runner must never be called. It fails the test loudly if it is. */
const runner: AgentRunner = async () => {
  throw new Error("the board must not run any worker");
};

const messenger = new ConsoleMessenger();
const PAUL = "tg:99887766";
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

let store: InstanceType<typeof Store>;
let scheduler: Scheduler;
let queue: JobRunner;
let server: import("node:http").Server;
let base: string;
let runningJob: Job;
let holderJob: Job;
let queuedJob: Job;
let doneJob: Job;
let failedJob: Job;
let eaJob: Job;

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  // A schedule made before boot, so the scheduler arms it and the board can show a next run.
  store.createSchedule({ cron: "0 7 * * *", timezone: "Europe/London", kind: "research", brief: "SECRET SCHEDULE BRIEF", requestedBy: PAUL, title: "Morning research" });

  const job = (kind: Job["kind"], title: string, brief: string, target: Job["target"] = "product") =>
    store.createJob(kind, brief, PAUL, target, undefined, { title });

  holderJob = store.updateJob(job("engineer", "Web UI restyle", "SECRET BRIEF beta", "self").id, { status: "running", startedAt: at(30 * MIN), lastActivityAt: at(1 * MIN) });
  runningJob = store.updateJob(job("engineer", "Fix deploy", "SECRET BRIEF alpha", "self").id, { status: "running", startedAt: at(12 * MIN), lastActivityAt: at(2 * MIN) });
  queuedJob = store.updateJob(job("engineer", "Add CI job", "SECRET BRIEF gamma", "self").id, { waitingFor: holderJob.id, queuePos: 1 });
  doneJob = store.updateJob(job("research", "TollBit research", "SECRET BRIEF delta").id, { status: "done", finishedAt: at(5 * MIN) });
  store.writeOutput(doneJob.id, "SECRET OUTPUT beta: what the research found");
  failedJob = store.updateJob(job("engineer", "Broken build", "SECRET BRIEF epsilon").id, { status: "failed", failure: "stalled", finishedAt: at(10 * MIN), pr: "https://github.com/drpaulfarrow/clear-exchange/pull/61" });
  eaJob = store.updateJob(job("ea", "Inbox triage", "SECRET BRIEF zeta").id, { status: "done", finishedAt: at(3 * MIN) });
  store.writeOutput(eaJob.id, "mail from jo@example.com SECRET MAIL");

  const built = buildApp({ messenger, runner, store });
  scheduler = built.scheduler;
  queue = built.jobs;
  await new Promise<void>((r) => (server = built.app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

// buildApp boots the scheduler, which arms this test's schedule; the armed tasks would keep the
// process alive after the run, so they are stopped with everything else.
after(() => {
  scheduler.stopAll();
  server.close();
});

test("the token is minted once, kept in the store, and accepted only when it matches exactly", () => {
  const token = boardToken(store);
  assert.ok(token.length >= 20);
  assert.equal(boardToken(store), token, "the same link every time, so it can be bookmarked");
  assert.equal(store.settings().jobsBoardToken, token);
  assert.ok(boardTokenValid(store, token));
  assert.ok(!boardTokenValid(store, ""));
  assert.ok(!boardTokenValid(store, token.slice(0, -1)));
  assert.ok(!boardTokenValid(store, `${token}x`));
});

test("the page is served only with the token, is never cached, and has no way to change anything", async () => {
  assert.equal((await fetch(`${base}${BOARD_PATH}`)).status, 404);
  assert.equal((await fetch(`${base}${BOARD_PATH}?t=not-the-token`)).status, 404);
  const token = boardToken(store);
  const ok = await fetch(`${base}${BOARD_PATH}?t=${token}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
  const html = await ok.text();
  assert.match(html, /Workforce jobs/);
  assert.match(html, /name="viewport"/, "reads on a phone");
  assert.match(html, /http-equiv="refresh"/, "refreshes itself");
  // Read only: a POST to the page is not a route at all, so nothing on it can act.
  assert.equal((await fetch(`${base}${BOARD_PATH}?t=${token}`, { method: "POST" })).status, 404);
  assert.ok(!html.includes("SECRET"), "no brief or output text reaches the page");
  // The same data as JSON, behind the same token, with the same refusal.
  assert.equal((await fetch(`${base}${BOARD_PATH}?format=json`)).status, 404);
  const jsonRes = await fetch(`${base}${BOARD_PATH}?t=${token}&format=json`);
  assert.match(jsonRes.headers.get("content-type") ?? "", /application\/json/);
  const data = (await jsonRes.json()) as { running: unknown[]; queued: unknown[]; finished: unknown[]; scheduled: unknown[] };
  assert.deepEqual(Object.keys(data).sort(), ["finished", "generatedAt", "paused", "queued", "running", "scheduled"]);
  assert.equal(data.running.length, 2);
  assert.equal(data.queued.length, 1);
  assert.equal(data.finished.length, 3);
  assert.equal(data.scheduled.length, 1);
});

test("a running, a queued and a finished job each render, with their timings and queue", () => {
  const board = boardData({ store, queue, schedules: scheduler.upcoming() });
  assert.equal(board.running.length, 2);
  const running = board.running.find((j) => j.id === runningJob.id)!;
  assert.equal(running.title, "Fix deploy");
  assert.equal(running.kind, "engineer");
  assert.equal(running.kindLabel, "engineer, workforce");
  assert.equal(running.repository, "self");
  assert.equal(running.runningFor, "12 min");
  assert.equal(running.lastActive, "2 min ago");

  const queued = board.queued.find((j) => j.id === queuedJob.id)!;
  assert.deepEqual(queued.waitingBehind, { title: "Web UI restyle", id: holderJob.id });
  assert.equal(queued.repository, "self");
  assert.equal(queued.queuePosition, 1);

  const done = board.finished.find((j) => j.id === doneJob.id)!;
  assert.equal(done.kindLabel, "research, product");
  assert.equal(done.outcome, "done");
  assert.equal(done.finishedAgo, "5 min ago");
  const failed = board.finished.find((j) => j.id === failedJob.id)!;
  assert.match(failed.outcome!, /^failed: /);

  assert.equal(board.scheduled.length, 1);
  assert.equal(board.scheduled[0].title, "Morning research");
  assert.match(board.scheduled[0].cron, /0 7 \* \* \*/);
  // buildApp boots the scheduler, so the task is armed and has a next run ahead of it.
  assert.ok(board.scheduled[0].next && Date.parse(board.scheduled[0].next) > Date.now());

  const html = renderBoard(board, "token");
  assert.match(html, /next /, "the next run is shown");
  assert.match(html, /Fix deploy/);
  assert.match(html, /engineer, workforce/);
  assert.match(html, /#1 in the queue/);
  assert.match(html, /Web UI restyle/);
  assert.match(html, /TollBit research/);
  assert.match(html, /waiting behind/);
  assert.match(html, /Morning research/);
});

test("a schedule with a next run shows it in London time, soonest first", () => {
  const run = (id: string, title: string, next?: string) => ({ id, title, kind: "research" as const, cron: "0 7 * * *", timezone: "Europe/London", ...(next ? { next } : {}) });
  const board = boardData({ store, queue, schedules: [run("b", "Later brief", "2026-11-16T07:00:00.000Z"), run("a", "Morning research", "2026-11-14T07:00:00.000Z")] });
  assert.deepEqual(board.scheduled.map((s) => s.title), ["Morning research", "Later brief"]);
  const html = renderBoard(board, "token");
  assert.match(html, /next Sat 14 Nov, 07:00/, "the next run is shown in plain London time");
});

test("a saved output and a pull request are linked where they already exist, never for an assistant output", () => {
  const board = boardData({ store, queue });
  const done = board.finished.find((j) => j.id === doneJob.id)!;
  assert.match(done.links![0].url, new RegExp(`^https://github\\.com/drpaulfarrow/clear-outputs/blob/main/research/\\d{4}-\\d{2}-\\d{2}-${doneJob.id}-tollbit-research\\.md$`));
  const failed = board.finished.find((j) => j.id === failedJob.id)!;
  assert.deepEqual(failed.links, [{ what: "pull request", url: "https://github.com/drpaulfarrow/clear-exchange/pull/61" }]);
  const ea = board.finished.find((j) => j.id === eaJob.id)!;
  assert.equal(ea.links, undefined, "assistant outputs are never copied to the repository, so never linked");
  const html = renderBoard(board, "token");
  // Two links only: the assistant job's output is never read, so nothing of Paul's mail is pointed at.
  assert.equal((html.match(/href="https:\/\/github\.com\//g) ?? []).length, 2);
  assert.match(html, /saved output/);
  assert.match(html, /pull request/);
});

test("no brief, output, schedule brief, spend figure or personal text can leak into the page or its JSON", () => {
  const board = boardData({ store, queue });
  const html = renderBoard(board, boardToken(store));
  const json = JSON.stringify(board);
  for (const text of ["SECRET BRIEF alpha", "SECRET BRIEF beta", "SECRET BRIEF gamma", "SECRET BRIEF delta", "SECRET BRIEF epsilon", "SECRET BRIEF zeta", "SECRET SCHEDULE BRIEF", "SECRET OUTPUT beta", "SECRET MAIL", "jo@example.com"]) {
    assert.ok(!html.includes(text), `the page leaked: ${text}`);
    assert.ok(!json.includes(text), `the JSON leaked: ${text}`);
  }
  for (const word of ["cost", "spend", "budget", "$"]) assert.ok(!json.includes(word) && !html.includes(word), `a figure reached the board: ${word}`);
  assert.ok(!json.includes(boardToken(store)), "the token is not in the JSON");
});

test("the board reads no spend and holds no cost field at all", () => {
  const src = fs.readFileSync(new URL("../src/jobs-board.ts", import.meta.url), "utf8");
  assert.ok(!/spend\.js/.test(src), "the board must not read src/spend.ts");
  assert.ok(!/costUsd/.test(src), "the board must not carry a cost");
  assert.ok(!/\.brief/.test(src), "the board must not read a job's brief");
});
