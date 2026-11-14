/**
 * The jobs board: one read-only page Paul bookmarks on his phone instead of typing /jobs in chat.
 * No network and no model: the fake runner is never invoked, because the board only reads what is
 * already in the store. The tests cover the token (accepted and refused), the shape it returns, that
 * every card says in plain English what its job is (from the job's own brief) and what kind of worker
 * it is, that a token, a pasted report, an output, a schedule brief or a spend figure cannot leak, and
 * that a running, a queued and a finished job each render.
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
const { boardToken, boardTokenValid, boardData, renderBoard, BOARD_PATH, BOARD_REFRESH_SECONDS } = await import("../src/jobs-board.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { boardHealth, HealthProbes } = await import("../src/health.js");
const { boardEfficiency, NO_REAL_COST } = await import("../src/worker-stats.js");
const { UptimeLog } = await import("../src/uptime.js");
import type { AgentRunner } from "../src/agents.js";
import type { JobRunner } from "../src/jobs.js";
import type { Scheduler } from "../src/scheduler.js";
import type { Job } from "../src/store.js";
import type { BoardJob } from "../src/jobs-board.js";

/** The board reads the store, so the runner must never be called. It fails the test loudly if it is. */
const runner: AgentRunner = async () => {
  throw new Error("the board must not run any worker");
};

const messenger = new ConsoleMessenger();
const PAUL = "tg:99887766";
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

let store: InstanceType<typeof Store>;
let app: ReturnType<typeof buildApp>;
let uptimeLog: UptimeLog;
let healthProbes: HealthProbes;
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
let reviewJob: Job;
let vagueJob: Job;

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  // The board's health block, with the heartbeat file in the test's own directory and two probes
  // that never touch the network: the wiring the entry point uses, without either timer leaking out.
  uptimeLog = new UptimeLog({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-board-uptime-")) });
  healthProbes = new HealthProbes(
    [
      { name: "model provider", check: async () => ({ state: "ok", detail: "answered" }) },
      { name: "GitHub", check: async () => ({ state: "fail", detail: "did not answer" }) },
    ],
    { intervalMs: 60 * MIN },
  );
  // A schedule made before boot, so the scheduler arms it and the board can show a next run.
  store.createSchedule({ cron: "0 7 * * *", timezone: "Europe/London", kind: "research", brief: "SECRET SCHEDULE BRIEF", requestedBy: PAUL, title: "Morning research" });

  const job = (kind: Job["kind"], title: string, brief: string, target: Job["target"] = "product") =>
    store.createJob(kind, brief, PAUL, target, undefined, { title });

  // The briefs are what each card describes the job from, so they read like real ones. "SECRET" marks
  // the text that must never reach the page: a token in a brief, and a report pasted into a brief.
  holderJob = store.updateJob(job("engineer", "Web UI restyle", "Restyle the web interface in the house style, keeping the fixed file list and the security headers.", "self").id, { status: "running", startedAt: at(30 * MIN), lastActivityAt: at(1 * MIN) });
  runningJob = store.updateJob(job("engineer", "Fix deploy", "Fix the deploy: read the environment variable the workflow never set. The token in the log was ghp_AAAABBBBCCCCDDDDEEEE1111222233334444.", "self").id, { status: "running", startedAt: at(12 * MIN), lastActivityAt: at(2 * MIN) });
  queuedJob = store.updateJob(
    job(
      "engineer",
      "Add CI job",
      // Long on purpose: past the cap on a card, so the card carries the first part and the expand
      // control the rest, and the tail of it reaches neither.
      `Add a CI job that runs the whole test suite on every pull request and reports a red check to the maintainer, so a merge is never taken on a broken branch. The workflow file itself is covered by a test that reads it back. ${"Keep the existing deploy job untouched and make sure the new job does not run twice on a push to a branch. Say which secrets the workflow needs and which of them Paul still has to add. ".repeat(6)}NOT-ON-A-CARD.`,
      "self",
    ).id,
    { waitingFor: holderJob.id, queuePos: 1 },
  );
  doneJob = store.updateJob(job("research", "TollBit research", "Research TollBit's buyer-side moves this month and say whether they are building an exchange.").id, { status: "done", finishedAt: at(5 * MIN) });
  store.writeOutput(doneJob.id, "SECRET OUTPUT beta: what the research found");
  failedJob = store.updateJob(job("engineer", "Broken build", "Fix the broken build on main after the last merge.").id, { status: "failed", failure: "stalled", finishedAt: at(10 * MIN), pr: "https://github.com/drpaulfarrow/clear-exchange/pull/61" });
  eaJob = store.updateJob(job("ea", "Inbox triage", "Go through today's inbox and say what needs Paul.").id, { status: "done", finishedAt: at(3 * MIN) });
  store.writeOutput(eaJob.id, "mail from jo@example.com SECRET MAIL");
  // A review brief carries the engineer's report pasted into it; a card must never show any of it.
  reviewJob = store.updateJob(job("maintain", "Review: Fix deploy", "Review the pull request the engineer just opened for this task, and any other open pull requests:\n\nFix the deploy.\n\nEngineer's report:\nSECRET REPORT TEXT", "self").id, { status: "running", startedAt: at(2 * MIN), lastActivityAt: at(1 * MIN), pr: "https://github.com/drpaulfarrow/clear-ops/pull/63" });
  vagueJob = store.updateJob(job("dns", "Domain check", "  ", "self").id, { status: "done", finishedAt: at(20 * MIN) });

  const built = buildApp({ messenger, runner, store, uptime: uptimeLog, probes: healthProbes });
  app = built;
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
  assert.deepEqual(Object.keys(data).sort(), ["efficiency", "finished", "generatedAt", "health", "paused", "queued", "running", "scheduled"]);
  assert.equal(data.running.length, 3);
  assert.equal(data.queued.length, 1);
  assert.equal(data.finished.length, 4);
  assert.equal(data.scheduled.length, 1);
  // The page is still one read-only document: no script, nothing fetched from anywhere, and the only
  // expand control is plain HTML, so nothing loads when Paul taps it.
  assert.ok(!/<script/i.test(html), "no script on the page");
  assert.ok(!/<link|<img|<iframe|@import|url\(/i.test(html), "nothing is fetched from anywhere");
  assert.match(html, /<details><summary>More of the brief<\/summary>/, "longer detail sits behind an expand control");
});

test("a running, a queued and a finished job each render, with their timings and queue", () => {
  const board = boardData({ store, queue, schedules: scheduler.upcoming() });
  assert.equal(board.running.length, 3);
  const running = board.running.find((j) => j.id === runningJob.id)!;
  assert.equal(running.title, "Fix deploy");
  assert.equal(running.kind, "engineer");
  assert.equal(running.kindLabel, "engineer on the workforce repo: writes the change on a branch and opens a pull request");
  assert.equal(running.repository, "self");
  assert.equal(running.runningFor, "12 min");
  assert.equal(running.lastActive, "2 min ago");
  // Running: what it is doing, read off its own brief.
  assert.match(running.description!, /^Fix the deploy: read the environment variable the workflow never set\./);

  const queued = board.queued.find((j) => j.id === queuedJob.id)!;
  assert.deepEqual(queued.waitingBehind, { title: "Web UI restyle", id: holderJob.id });
  assert.equal(queued.repository, "self");
  assert.equal(queued.queuePosition, 1);
  // Queued: what it will do, and the existing line saying what it waits behind.
  assert.match(queued.description!, /^Add a CI job that runs the whole test suite on every pull request/);
  assert.match(queued.more!, /^Keep the existing deploy job untouched/, "the rest of the brief sits behind the expand control");

  const done = board.finished.find((j) => j.id === doneJob.id)!;
  assert.equal(done.kindLabel, "researcher on the Clear Exchange repo: researches on the web and writes a sourced brief");
  assert.equal(done.outcome, "done");
  assert.equal(done.finishedAgo, "5 min ago");
  assert.equal(done.produced, "Wrote a report; the report is linked below.");
  const failed = board.finished.find((j) => j.id === failedJob.id)!;
  assert.match(failed.outcome!, /^failed: /);
  assert.equal(failed.produced, undefined, "a failed job produced nothing to show");

  assert.equal(board.scheduled.length, 1);
  assert.equal(board.scheduled[0].title, "Morning research");
  assert.match(board.scheduled[0].cron, /0 7 \* \* \*/);
  // buildApp boots the scheduler, so the task is armed and has a next run ahead of it.
  assert.ok(board.scheduled[0].next && Date.parse(board.scheduled[0].next) > Date.now());

  const html = renderBoard(board, "token");
  assert.match(html, /next /, "the next run is shown");
  assert.match(html, /Fix deploy/);
  assert.match(html, /engineer on the workforce repo: writes the change on a branch and opens a pull request/);
  assert.match(html, /#1 in the queue/);
  assert.match(html, /Web UI restyle/);
  assert.match(html, /TollBit research/);
  assert.match(html, /waiting behind/);
  assert.match(html, /Morning research/);
  assert.match(html, /Opened the pull request|Wrote a report|Reviewed/, "a finished card says what it produced");
});

test("a running card shows what the worker is doing this minute, and a card with nothing to say says so", () => {
  const step = "Editing jobs-board.ts";
  const withStep = boardData({ store, queue: { isHeld: () => false, queuePosition: () => 1, latestStep: () => step } });
  const running = withStep.running.find((j) => j.id === runningJob.id)!;
  assert.equal(running.now, step);
  assert.match(renderBoard(withStep, "token"), /Now: Editing jobs-board\.ts/);
  // Nothing is running in this process's runner, so no card claims to know a step.
  assert.equal(boardData({ store, queue }).running.find((j) => j.id === runningJob.id)!.now, undefined);
  assert.ok(!renderBoard(boardData({ store, queue }), "token").includes("Now:"));

  const vague = boardData({ store, queue }).finished.find((j) => j.id === vagueJob.id)!;
  assert.equal(vague.description, undefined);
  assert.match(vague.descriptionUnavailable!, /brief is empty or unreadable/);
  assert.match(renderBoard(boardData({ store, queue }), "token"), /No description: this job&#39;s brief is empty or unreadable\./);
  // Every card carries either a description or that honest note, and a kind line explaining itself.
  for (const group of [boardData({ store, queue }).running, boardData({ store, queue }).queued, boardData({ store, queue }).finished]) {
    for (const j of group) {
      assert.ok(j.description || j.descriptionUnavailable, `${j.id} says nothing about what it is`);
      assert.match(j.kindLabel, / on the .+ repo: .+/, `${j.id} does not explain its kind`);
    }
  }
});

test("only a running card carries the turning arc and the pulse, and nothing on the page can shift or fetch", () => {
  // One card of each kind, so each card's own markup can be looked at on its own.
  const card = (id: string, title: string, status: BoardJob["status"]): BoardJob => ({
    id,
    title,
    kind: "engineer",
    kindLabel: "engineer on the workforce repo: writes the change on a branch and opens a pull request",
    repository: "self",
    status,
    description: "Do the thing.",
  });
  const html = renderBoard(
    {
      generatedAt: new Date().toISOString(),
      paused: false,
      health: boardHealth({ store, now: Date.now() }),
      efficiency: boardEfficiency({ jobs: [], now: Date.now() }),
      running: [card("run0001", "Running card", "running")],
      queued: [card("queue001", "Queued card", "queued")],
      finished: [card("done0001", "Done card", "done"), card("fail0001", "Failed card", "failed")],
      scheduled: [],
    },
    "token",
  );
  // Each card is its own block: the page puts them out back to back, so the split is exact.
  const cards = html.split('<div class="job">').slice(1);
  assert.equal(cards.length, 4);
  const isArc = (c: string) => c.includes('class="arc"');
  assert.equal(cards.filter(isArc).length, 1, "exactly one card turns");
  assert.match(cards.find(isArc)!, /Running card/);
  assert.match(cards.find(isArc)!, /<span class="badge run"><span class="arc" aria-hidden="true"><\/span>running<\/span>/);
  for (const c of cards.filter((c) => !isArc(c))) {
    assert.ok(!c.includes("arc"), `${c.slice(0, 40)} is not running but carries the arc`);
    assert.ok(!c.includes("animation"), "a card that is not running animates nothing");
    assert.ok(!/class="badge run"/.test(c), "only a running card wears the running badge");
  }
  // The arc is decoration: a screen reader is given the word running, not the ring.
  assert.match(html, /aria-hidden="true"/);

  // The style block itself: no script, no fetch, no filter or blur, and nothing animated but transform
  // and opacity, so the animation stays cheap and cannot move anything on the card.
  const style = html.match(/<style>([\s\S]*)<\/style>/)![1];
  assert.ok(!/<script/i.test(html) && !/<link|<img|<iframe/i.test(html), "no script and nothing fetched");
  assert.ok(!/@import|url\(/i.test(style), "the stylesheet fetches nothing either");
  assert.ok(!/filter|blur|box-shadow|transition/i.test(style), "nothing expensive is animated");
  const frames = [...style.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\}\s*\}/g)];
  assert.equal(frames.length, 2, "a spin and a pulse, no more");
  assert.deepEqual(frames.map((m) => m[1]).sort(), ["board-pulse", "board-spin"]);
  for (const [, name, body] of frames) {
    const props = [...new Set([...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]))];
    assert.deepEqual(props, [name === "board-spin" ? "transform" : "opacity"], `${name} animates something other than transform and opacity`);
  }
  // The reload is every ten seconds, so each duration divides it exactly and the restart lands on the
  // same phase, invisibly. A duration that did not divide it would show a jump every ten seconds.
  const duration = (name: string) => {
    const m = style.match(new RegExp(`${name} ([0-9.]+)s`));
    assert.ok(m, `${name} has no duration`);
    return Number(m![1]);
  };
  for (const name of ["board-spin", "board-pulse"]) {
    const seconds = duration(name);
    assert.ok(seconds > 0 && seconds < BOARD_REFRESH_SECONDS, `${name} is not a short repeat`);
    assert.equal(BOARD_REFRESH_SECONDS / seconds, Math.round(BOARD_REFRESH_SECONDS / seconds), `${name} does not divide the ${BOARD_REFRESH_SECONDS}s refresh`);
  }
  // With reduced motion asked for, the running card is still, and still says it is running.
  assert.match(style, /@media \(prefers-reduced-motion:reduce\)\{\.badge\.run,\.arc\{animation:none\}\}/);
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
  // The assistant's card still says what it did, from the job's own record, without reading its output.
  assert.equal(ea.produced, "Worked over your mail and calendar; the report is in your chat.");
  const html = renderBoard(board, "token");
  // Three links only: the assistant job's output is never read, so nothing of Paul's mail is pointed at.
  assert.equal((html.match(/href="https:\/\/github\.com\//g) ?? []).length, 3);
  assert.match(html, /saved output/);
  assert.match(html, /pull request/);
});

test("no token, pasted report, output, schedule brief, spend figure or personal text can leak into the page or its JSON", () => {
  const board = boardData({ store, queue });
  const html = renderBoard(board, boardToken(store));
  const json = JSON.stringify(board);
  for (const text of ["SECRET", "ghp_AAAABBBBCCCCDDDDEEEE1111222233334444", "Engineer's report", "SECRET OUTPUT beta", "SECRET MAIL", "jo@example.com"]) {
    assert.ok(!html.includes(text), `the page leaked: ${text}`);
    assert.ok(!json.includes(text), `the JSON leaked: ${text}`);
  }
  // A card's description is read off the brief and capped, so a brief too long to be a card is never
  // on the page whole, and the text past the cap is not there at all.
  for (const j of [...board.running, ...board.queued, ...board.finished]) {
    assert.ok(!("brief" in j), "a brief reached the JSON");
    const full = store.getJob(j.id)!.brief;
    if (full.length <= 240) continue;
    assert.ok(!html.includes(full), `the whole brief is on the page: ${j.id}`);
    assert.ok(!json.includes(full), `the whole brief is in the JSON: ${j.id}`);
    assert.ok(!html.includes("NOT-ON-A-CARD"), "text past the cap reached the page");
  }
  // Money: still no spend figure, no cap, no budget and no amount of money on the page or in the JSON,
  // and still no per-kind cost figure here, because this store holds no real one. The word "cost"
  // appears only in the one honest sentence saying exactly that (worker-stats.ts), so the ban on the
  // word is replaced by a check of what it is doing there, and by the checks that matter more: no
  // amount of money, no SDK estimate, no costUsd.
  for (const word of ["spend", "budget", "$", "costUsd", "costSource"]) assert.ok(!json.includes(word) && !html.includes(word), `a figure reached the board: ${word}`);
  assert.ok(!/\$\s?\d/.test(html) && !/\$\s?\d/.test(json), "a money amount reached the board");
  assert.ok(!json.includes('"cost"'), "a per-kind cost figure reached the JSON");
  assert.ok(json.includes(NO_REAL_COST) && html.includes("no real figure is stored for these jobs"), "the board says plainly that no real figure is stored");
  assert.ok(!json.includes(boardToken(store)), "the token is not in the JSON");
});

test("the board reads no spend, holds no cost field, and reads no brief except through src/job-descriptions.ts", () => {
  const src = fs.readFileSync(new URL("../src/jobs-board.ts", import.meta.url), "utf8");
  assert.ok(!/spend\.js/.test(src), "the board must not read src/spend.ts");
  assert.ok(!/costUsd/.test(src), "the board must not carry a cost");
  assert.ok(!/"summary"|\.summary/.test(src), "the board must not show a job's report message");
  assert.ok(!/\.brief/.test(src), "every brief the board shows is cleaned, redacted and capped in src/job-descriptions.ts");
});

test("the entry point's health wiring: the heartbeat and the checks reach the board, and both stop", async () => {
  assert.equal(typeof app.startHealth, "function", "the running service starts them and a test never has to");
  const stop = app.startHealth();
  try {
    // A start and a heartbeat are written at once, so a restart always leaves a mark to measure from.
    const lines = fs.readFileSync(uptimeLog.path(), "utf8").trim().split("\n");
    assert.ok(lines.length >= 2, "the boot marker and the first beat");
    assert.ok(lines.some((l) => l.includes('"b":true')), "the start is recorded apart from the beats");
    await healthProbes.tick();
    const token = boardToken(store);
    const data = (await (await fetch(`${base}${BOARD_PATH}?t=${token}&format=json`)).json()) as {
      health: { level: string; headline: string; checks: Array<{ name: string; state: string }>; uptime: { empty: boolean; strip: unknown[] } };
      efficiency: { windows: Array<{ label: string; kinds: unknown[] }> };
    };
    assert.equal(data.health.checks.find((c) => c.name === "GitHub")!.state, "fail");
    assert.equal(data.health.level, "warn");
    assert.match(data.health.headline, /GitHub did not answer/);
    assert.equal(data.health.uptime.empty, false, "the beats written by this process are the uptime figure");
    assert.equal(data.health.uptime.strip.length, 48);
    assert.equal(data.efficiency.windows.length, 2);
    const html = await (await fetch(`${base}${BOARD_PATH}?t=${token}`)).text();
    assert.match(html, /Health and uptime/);
    assert.match(html, /GitHub<\/span>: did not answer/, "a failing check is one honest line");
    assert.match(html, /the service last started|The service last started/i);
  } finally {
    stop();
  }
});
