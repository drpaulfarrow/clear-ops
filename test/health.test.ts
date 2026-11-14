/**
 * The board's health block: the dependency probes and the plain words built from them.
 *
 * No network and no model anywhere here: every probe is given a fake fetch, and the block is built
 * from a real store in a temporary directory. The tests cover what each result says, that a probe
 * that fails, throws or never answers is one honest line rather than a broken page, that a key rides
 * in a header and never in a URL, a log, the store or the page, that the block is built without
 * touching a job, and that the uptime half says plainly what it is measuring.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-health-"));

const { Store } = await import("../src/store.js");
const { HealthProbes, boardHealth, boardUptime, defaultProbes, PROBE_INTERVAL_MS, PROBE_TIMEOUT_MS, SEARCH_PROBE_INTERVAL_MS } = await import("../src/health.js");
const { config } = await import("../src/config.js");
const { uptimeReport, UPTIME_NOTE } = await import("../src/uptime.js");
const { boardData, renderBoard } = await import("../src/jobs-board.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const KEY = "sk-or-v1-SECRETKEYMATERIAL";
/** Both providers' keys, so the probe is exercised whichever one this machine runs on. */
const KEYS = { openrouter: KEY, anthropic: KEY };

/** A Response stand-in. `text` throws, so a probe that read a reply body would fail loudly here. */
const reply = (status: number) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => {
      throw new Error("a probe must never read the reply body");
    },
    json: () => {
      throw new Error("a probe must never read the reply body");
    },
  }) as unknown as Response;

/** A fetch stand-in that records what it was asked for and answers however the test says. */
function fakeFetch(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return answer(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

let store: InstanceType<typeof Store>;

before(() => {
  store = new Store(process.env.DATA_DIR!);
  const job = (kind: "engineer" | "research", title: string) => store.createJob(kind, "Do the thing.", "tg:99887766", "self", undefined, { title });
  store.updateJob(job("engineer", "Fix deploy").id, { status: "running", startedAt: new Date(NOW - 12 * MIN).toISOString() });
  store.updateJob(job("research", "TollBit research").id, { status: "queued", queuePos: 1 });
});

/* ---------- The probes themselves ---------- */

test("a probe that is answered says so, and one that is refused never reads the reply", async () => {
  const ok = fakeFetch(() => reply(200));
  const good = defaultProbes({ fetch: ok.impl, keys: KEYS, githubToken: async () => "gh-token" });
  const model = good.find((p) => p.name === "model provider")!;
  assert.deepEqual(await model.check(), { state: "ok", detail: "answered" });
  // The key rides in a header, never in the address.
  assert.ok(!ok.calls[0]!.url.includes(KEY), "the key is not in the URL");
  const headers = Object.values((ok.calls[0]!.init?.headers ?? {}) as Record<string, string>);
  assert.ok(
    headers.includes(KEY) || headers.includes(`Bearer ${KEY}`),
    "the key is in a header",
  );

  const refused = fakeFetch(() => reply(401));
  const bad = defaultProbes({ fetch: refused.impl, keys: KEYS });
  const outcome = await bad.find((p) => p.name === "model provider")!.check();
  assert.equal(outcome.state, "fail");
  assert.match(outcome.detail, /refused the key \(401\)/);
  assert.ok(!outcome.detail.includes(KEY), "the key is never in a detail line");
});

test("a slow, silent or throwing dependency is one plain line, never a hang and never a body", async () => {
  const broken = fakeFetch(() => reply(503));
  assert.match((await defaultProbes({ fetch: broken.impl, keys: KEYS }).find((p) => p.name === "model provider")!.check()).detail, /did not answer properly \(503\)/);

  const threw = fakeFetch(() => {
    throw new Error("socket hang up");
  });
  assert.equal((await defaultProbes({ fetch: threw.impl, keys: KEYS }).find((p) => p.name === "model provider")!.check()).detail, "did not answer");

  const timedOut = fakeFetch(() => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    throw err;
  });
  assert.match((await defaultProbes({ fetch: timedOut.impl, keys: KEYS, timeoutMs: 5_000 }).find((p) => p.name === "model provider")!.check()).detail, /did not answer within 5 seconds/);

  // A probe that never answers is settled by the pass, so one dead dependency cannot hold the rest.
  const probes = new HealthProbes([{ name: "slow", check: () => new Promise(() => {}) }], { timeoutMs: 30, now: () => NOW });
  await probes.tick();
  const [slow] = probes.snapshot();
  assert.equal(slow!.state, "fail");
  assert.match(slow!.detail, /did not answer within/);
});

test("a probe that is not configured is reported as off rather than as a fault", async () => {
  const net = fakeFetch(() => reply(200));
  const probes = defaultProbes({ fetch: net.impl, keys: {}, githubToken: async () => undefined });
  const byName = new Map(probes.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(Object.fromEntries(byName)).sort(), ["Brave search", "Exa search", "GitHub", "Google Workspace", "model provider"]);
  assert.deepEqual(await byName.get("model provider")!.check(), { state: "off", detail: "no model key is set" });
  assert.match((await byName.get("Brave search")!.check()).detail, /no Brave key/);
  assert.match((await byName.get("Exa search")!.check()).detail, /no Exa key/);
  assert.match((await byName.get("GitHub")!.check()).detail, /no GitHub token/);
  assert.match((await byName.get("Google Workspace")!.check()).detail, /not set up/);
  assert.equal(net.calls.length, 0, "nothing unconfigured is ever probed over the network");
});

test("the Google check is off until Paul connects, and one authenticated read once he has", async () => {
  const named = (google: { connected: () => boolean; profile: () => Promise<unknown> }) => defaultProbes({ keys: KEYS, google }).find((p) => p.name === "Google Workspace")!;

  // Not connected: nothing is asked of Google, and the line says why rather than inventing a fault.
  let asked = 0;
  const off = named({ connected: () => false, profile: async () => { asked += 1; } });
  assert.deepEqual(await off.check(), { state: "off", detail: "Paul's Google account is not connected" });
  assert.equal(asked, 0, "an unconnected account is not called");

  // Connected: the smallest authenticated read, and it is the allowlisted one.
  assert.deepEqual(await named({ connected: () => true, profile: async () => ({ emailAddress: "someone@example.com" }) }).check(), { state: "ok", detail: "answered" });

  // A revoked credential is a fault, and Google's own words are never printed: a body can hold an
  // address, so only the status number is taken and the phrase around it is this file's own.
  const revoked = named({ connected: () => true, profile: async () => { throw new Error("Google gmail GET failed: 401 invalid_grant for someone@example.com"); } });
  const outcome = await revoked.check();
  assert.deepEqual(outcome, { state: "fail", detail: "refused the stored credential (401)" });
  assert.ok(!JSON.stringify(outcome).includes("example.com"), "no address from a reply reaches the page");

  // Anything else that throws is one honest line, with no status to quote.
  assert.deepEqual(await named({ connected: () => true, profile: async () => { throw new Error("socket closed"); } }).check(), { state: "fail", detail: "did not answer" });
  assert.deepEqual(await named({ connected: () => true, profile: async () => { throw new Error("Google gmail GET failed: 503 backend error"); } }).check(), { state: "fail", detail: "did not answer properly (503)" });
});

test("a token that cannot be read is not configured, never a refusal, and a real one that is refused still says so", async () => {
  // An environment with the App key and GH_TOKEN stripped (a worker's): the page must say there is no
  // token, not cry wolf about a refused one, and it must not send an empty bearer to GitHub at all.
  const cases: Array<() => Promise<string | undefined>> = [
    async () => undefined,
    async () => "",
    async () => "   ",
    async () => {
      throw new Error("the App key is not in this environment");
    },
  ];
  for (const githubToken of cases) {
    const net = fakeFetch(() => reply(401));
    const github = defaultProbes({ fetch: net.impl, keys: KEYS, githubToken }).find((p) => p.name === "GitHub")!;
    assert.deepEqual(await github.check(), { state: "off", detail: "no GitHub token is configured" });
    assert.equal(net.calls.length, 0, "no request is made without a credential to send");
  }

  // A real credential that GitHub refuses is a fault, and the page says which, without the token.
  const refused = fakeFetch(() => reply(401));
  const github = defaultProbes({ fetch: refused.impl, keys: KEYS, githubToken: async () => "gh-token" }).find((p) => p.name === "GitHub")!;
  const outcome = await github.check();
  assert.deepEqual(outcome, { state: "fail", detail: "refused the token (401)" });
  assert.equal(refused.calls.length, 1);
  assert.equal(refused.calls[0]!.url, "https://api.github.com/rate_limit", "the cheapest authenticated read");
  assert.ok(!refused.calls[0]!.url.includes("gh-token"), "the token is never in the address");
  const sent = Object.values((refused.calls[0]!.init?.headers ?? {}) as Record<string, string>);
  assert.ok(sent.includes("Bearer gh-token"), "the token rides in a header and nowhere else");
});

test("a pass keeps the last result of every probe, waits until it has one, and stops cleanly", async () => {
  const probes = new HealthProbes(
    [
      { name: "models", check: async () => ({ state: "ok", detail: "answered" }) },
      { name: "search", check: async () => ({ state: "fail", detail: "refused the key (403)" }) },
    ],
    { now: () => NOW, intervalMs: HOUR },
  );
  assert.deepEqual(probes.snapshot().map((p) => p.state), ["waiting", "waiting"], "nothing is claimed before a pass");
  await probes.tick();
  const [models, search] = probes.snapshot();
  assert.equal(models!.state, "ok");
  assert.equal(search!.state, "fail");
  assert.equal(models!.checkedAt, new Date(NOW).toISOString(), "each result says when it was taken");
  // A probe that throws is a failing line, not a broken pass.
  const throwing = new HealthProbes([{ name: "x", check: async () => { throw new Error("nope"); } }], { now: () => NOW });
  await throwing.tick();
  assert.equal(throwing.snapshot()[0]!.state, "fail");
  // Starting it probes at once and returns a stop that leaves nothing running.
  const started = new HealthProbes([{ name: "quick", check: async () => ({ state: "ok", detail: "answered" }) }], { now: () => NOW, intervalMs: HOUR });
  const stop = started.start();
  stop();
  assert.equal(PROBE_TIMEOUT_MS, 5_000, "a probe is given five seconds before it is called unanswered");
});

test("the two metered search checks run hourly, and the cheap ones every five minutes", async () => {
  // Each check says what its own cadence is, and only the two that are billed have a slower one.
  const set = defaultProbes({ keys: { openrouter: KEY, brave: "brave-key", exa: "exa-key" }, githubToken: async () => "gh-token" });
  const cadence = new Map(set.map((p) => [p.name, p.intervalMs]));
  assert.equal(cadence.get("Brave search"), SEARCH_PROBE_INTERVAL_MS, "Brave bills per request");
  assert.equal(cadence.get("Exa search"), SEARCH_PROBE_INTERVAL_MS, "Exa meters searches the same way");
  for (const cheap of ["model provider", "GitHub", "Google Workspace"]) {
    assert.equal(cadence.get(cheap), undefined, `${cheap} is a cheap read and keeps the pass's five minute cadence`);
  }
  assert.equal(PROBE_INTERVAL_MS, 5 * MIN);
  assert.equal(SEARCH_PROBE_INTERVAL_MS, HOUR);
  // 288 a day each at five minutes is what the slower cadence exists to avoid; hourly is 24.
  assert.equal((24 * HOUR) / SEARCH_PROBE_INTERVAL_MS, 24);
  assert.equal((24 * HOUR) / PROBE_INTERVAL_MS, 288);

  // The timer honours it. A probe that counts its own runs is driven by a clock the test moves.
  let clock = NOW;
  const runs = new Map<string, number>();
  const counted = (name: string, intervalMs?: number) => ({
    name,
    ...(intervalMs ? { intervalMs } : {}),
    check: async () => {
      runs.set(name, (runs.get(name) ?? 0) + 1);
      return { state: "ok" as const, detail: "answered" };
    },
  });

  // Not a pulse early, and run the moment the hour is up.
  const slow = new HealthProbes([counted("Brave search", SEARCH_PROBE_INTERVAL_MS)], { now: () => clock, intervalMs: PROBE_INTERVAL_MS });
  await slow.tick();
  assert.equal(runs.get("Brave search"), 1, "the pass at boot probes everything once");
  clock = NOW + HOUR - 1;
  await slow.pulse();
  assert.equal(runs.get("Brave search"), 1, "a minute short of the hour, it is left alone");
  clock = NOW + HOUR;
  await slow.pulse();
  assert.equal(runs.get("Brave search"), 2, "and run when the hour is up");

  // A day of five minute pulses: the cheap check answers on every one, the metered ones once an hour.
  clock = NOW;
  runs.clear();
  const timed = new HealthProbes([counted("cheap"), counted("Brave search", SEARCH_PROBE_INTERVAL_MS), counted("Exa search", SEARCH_PROBE_INTERVAL_MS)], { now: () => clock, intervalMs: PROBE_INTERVAL_MS });
  await timed.tick();
  const pulses = (24 * HOUR) / PROBE_INTERVAL_MS;
  for (let i = 0; i < pulses; i++) {
    clock += PROBE_INTERVAL_MS;
    await timed.pulse();
  }
  assert.equal(runs.get("cheap"), 1 + pulses, "the cheap check runs on every pulse");
  assert.equal(runs.get("Brave search"), 25, "once at boot, then 24 times in the day");
  assert.equal(runs.get("Exa search"), 25);
  assert.equal(timed.snapshot().length, 3, "every probe still has a result to show");
  assert.equal(timed.snapshot().find((p) => p.name === "cheap")!.checkedAt, new Date(clock).toISOString());

  // A check that takes time to answer must not push its own cadence out by how long it took: the pass
  // is measured from when it began, or a five minute check would slowly drift to ten.
  clock = NOW;
  runs.clear();
  const slowToAnswer = new HealthProbes(
    [
      {
        name: "cheap",
        check: async () => {
          clock += 90_000;
          runs.set("cheap", (runs.get("cheap") ?? 0) + 1);
          return { state: "ok" as const, detail: "answered" };
        },
      },
    ],
    { now: () => clock, intervalMs: PROBE_INTERVAL_MS },
  );
  await slowToAnswer.tick(); // the pass begins at NOW; the check itself takes a minute and a half
  clock = NOW + PROBE_INTERVAL_MS; // five minutes after the pass began, not after it finished
  await slowToAnswer.pulse();
  assert.equal(runs.get("cheap"), 2, "a slow answer does not delay the next check by its own duration");
});

test("the probe keys come from config, the same place the models read them", async () => {
  const before = { openrouter: config.openrouter.apiKey, anthropic: config.anthropic.apiKey };
  const envBefore = process.env.ANTHROPIC_API_KEY;
  try {
    // An Anthropic key in config, a different one in the environment, and no OpenRouter key: the probe
    // must use the one config holds, so one place decides which key is in force.
    config.openrouter.apiKey = "";
    config.anthropic.apiKey = "sk-ant-from-config";
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-environment";
    const net = fakeFetch(() => reply(200));
    const model = defaultProbes({ fetch: net.impl }).find((p) => p.name === "model provider")!;
    assert.deepEqual(await model.check(), { state: "ok", detail: "answered" });
    assert.equal(net.calls[0]!.url, "https://api.anthropic.com/v1/models?limit=1");
    assert.deepEqual(net.calls[0]!.init?.headers, { "x-api-key": "sk-ant-from-config", "anthropic-version": "2023-06-01" });
    assert.ok(!JSON.stringify(net.calls[0]).includes("from-the-environment"), "the environment is not read around config");
  } finally {
    config.openrouter.apiKey = before.openrouter;
    config.anthropic.apiKey = before.anthropic;
    if (envBefore === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = envBefore;
  }
});

/* ---------- What the page says ---------- */

test("a healthy service says so in a sentence, with the counts, the checks and the uptime beside it", () => {
  const beats = Array.from({ length: 240 }, (_, i) => NOW - 240 * MIN + i * MIN);
  const health = boardHealth({
    store,
    now: NOW,
    uptime: { report: () => uptimeReport({ beats, boots: [NOW - 3 * HOUR], now: NOW }) },
    probes: { snapshot: () => [{ name: "model provider", state: "ok", detail: "answered", checkedAt: new Date(NOW - MIN).toISOString() }] },
    activeWorkers: () => 1,
    liveness: () => ({ alive: true }),
  });
  assert.equal(health.level, "ok");
  assert.match(health.headline, /^Everything looks healthy/);
  assert.equal(health.live, "Up 3 h since the last restart, 1 worker running, 1 job queued, nothing stalled, the queue is not held.");
  assert.deepEqual(health.checks, [{ name: "model provider", state: "ok", detail: "answered", checkedAt: new Date(NOW - MIN).toISOString() }]);
  assert.match(health.checksLine, /Last checked 1 min ago/);
  assert.match(health.uptime.headline, /^Uptime 100% since records begin \(4 h ago\)/);
  assert.equal(health.uptime.empty, false);
  assert.equal(health.uptime.note, UPTIME_NOTE, "the page says what uptime means here");
  assert.match(health.uptime.restartLine, /last started 3 h ago/);
});

test("a failed check, a stalled job and a held queue each make the verdict a plain warning", () => {
  const failing = {
    snapshot: () => [
      { name: "model provider", state: "fail" as const, detail: "refused the key (401)" },
      { name: "GitHub", state: "ok" as const, detail: "answered" },
    ],
  };
  const warn = boardHealth({ store, now: NOW, probes: failing, liveness: () => ({ alive: false }), activeWorkers: () => 0 });
  assert.equal(warn.level, "warn");
  assert.match(warn.headline, /Something needs a look/);
  assert.match(warn.headline, /model provider refused the key \(401\)/);
  assert.match(warn.headline, /shown no activity for too long/);
  assert.match(warn.live, /no workers running/);
  assert.match(warn.live, /1 job stalled/);
  assert.ok(!warn.headline.includes("GitHub"), "a check that answered is not a problem");

  // A hold after a credit or key failure is the runner's own state, repeated here in plain words.
  const held: InstanceType<typeof Store> = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-health-hold-")));
  held.setQueueHold({ kind: "credit", jobId: "abc123", since: new Date(NOW).toISOString(), detail: "out of credit" });
  const byHold = boardHealth({ store: held, now: NOW });
  assert.equal(byHold.level, "warn");
  assert.match(byHold.headline, /held after a credit failure/);
  assert.match(byHold.live, /the engineering queue is held until \/resume/);
  // With no checks in this process the page says so rather than implying everything is fine.
  assert.equal(byHold.checks.length, 0);
  assert.match(byHold.checksLine, /not running in this process/);
});

test("the block is built without touching a job, and the page stays readable when everything is broken", () => {
  let snapshots = 0;
  const board = boardData({
    store,
    queue: { isHeld: () => false, queuePosition: () => 1 },
    now: NOW,
    activeWorkers: () => 0,
    probes: {
      snapshot: () => {
        snapshots++;
        return [
          { name: "model provider", state: "fail", detail: "did not answer" },
          { name: "Brave search", state: "fail", detail: "did not answer" },
        ];
      },
    },
    uptime: { report: () => uptimeReport({ beats: [], now: NOW }) },
  });
  assert.equal(snapshots, 1, "the page reads the last pass once and never asks for a new one");
  const html = renderBoard(board, "token");
  assert.match(html, /Health and uptime/);
  assert.match(html, /no real figure is stored for these jobs|Cost per job/);
  assert.match(html, /model provider/);
  assert.match(html, /No heartbeat history yet, so there is no uptime figure\./, "an empty history is said plainly");
  assert.match(html, /did not answer/);
  assert.match(html, /How the workers are doing/);
  // Still one read-only document with nothing fetched from anywhere.
  assert.ok(!/<script|<link|<img|<iframe|@import|url\(/i.test(html), "nothing is fetched from anywhere");
});

test("a render builds the uptime report once and reads both of its lines off it", () => {
  let reports = 0;
  const beats = [NOW - 4 * HOUR, NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - MIN];
  const health = boardHealth({
    store,
    now: NOW,
    uptime: {
      report: () => {
        reports += 1;
        return uptimeReport({ beats, boots: [NOW - 3 * HOUR], now: NOW });
      },
    },
  });
  assert.equal(reports, 1, "the report sorts the kept history, so it is built once per render, not once per line");
  assert.match(health.live, /^Up 3 h since the last restart/);
  assert.match(health.uptime.headline, /^Uptime /);
});

test("the uptime half says what is measured, lists the recent gaps and never claims more than it knows", () => {
  const empty = boardUptime(uptimeReport({ beats: [], now: NOW }), NOW);
  assert.equal(empty.empty, true);
  assert.match(empty.headline, /No heartbeat history yet/);
  assert.equal(empty.strip.length, 48);
  assert.match(empty.restartLine, /has just started|last started/);
  assert.equal(empty.note, UPTIME_NOTE);
  assert.match(UPTIME_NOTE, /means the service was recording, not that the page answered from outside/);

  // Two twenty minute gaps in the last day, at 2 and 9 hours ago.
  const holes = [2 * HOUR, 9 * HOUR].map((h) => NOW - h);
  const beats: number[] = [];
  for (let t = NOW - 24 * HOUR; t <= NOW; t += MIN) {
    if (holes.some((h) => t > h && t <= h + 20 * MIN)) continue;
    beats.push(t);
  }
  const shown = boardUptime(uptimeReport({ beats, boots: [NOW - 5 * MIN], now: NOW }), NOW);
  assert.equal(shown.empty, false);
  assert.match(shown.headline, /^Uptime 97\.2% of the last 24 hours; downtime 40 min in the last 24 hours\.$/);
  assert.match(shown.gapsLine, /^2 gaps in the last 24 hours, the same in the last 7 days\. Most recent, newest first: /);
  assert.equal((shown.gapsLine.match(/\(20 min\)/g) ?? []).length, 2, "each gap is listed with how long it lasted");
  // Each gap is listed from when it started to when the beats came back, not from its end alone. Both
  // holes here fall inside one London day, so the clock is a plain "hh:mm" with no weekday.
  const at = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  for (const h of holes) {
    const said = `started ${at(h + MIN)}, back ${at(h + 21 * MIN)} (20 min)`;
    assert.ok(shown.gapsLine.includes(said), `the gap that began at ${at(h)} reads "${said}": ${shown.gapsLine}`);
  }
  const [firstGap] = [...shown.gapsLine.matchAll(/started (\d\d:\d\d), back (\d\d:\d\d)/g)];
  assert.ok(firstGap![1]! < firstGap![2]!, "a gap starts before it ends");
  assert.match(shown.restartLine, /started once in the last 24 hours/);
  assert.equal(shown.strip.filter((c) => c === "down").length, 2, "each gap shows in the day's strip");
});

test("the block never holds a brief, an output, an address or a key", () => {
  const board = boardData({
    store,
    queue: { isHeld: () => false, queuePosition: () => 1 },
    now: NOW,
    probes: { snapshot: () => [{ name: "model provider", state: "fail", detail: "refused the key (401)" }] },
    uptime: { report: () => uptimeReport({ beats: [NOW - MIN], boots: [NOW - 2 * MIN], now: NOW }) },
  });
  const health = JSON.stringify(board.health);
  const html = renderBoard(board, "token");
  // The new figures are their own stretch of the page, between the health heading and the cards.
  const figures = html.slice(html.indexOf("<h2>Health and uptime</h2>"), html.indexOf('<h2>Running now</h2>'));
  assert.ok(figures.includes("How the workers are doing"), "the figures are the part under test");
  for (const text of ["Do the thing.", KEY, "ghp_", "jo@example.com"]) {
    assert.ok(!health.includes(text), `the health block leaked: ${text}`);
    assert.ok(!figures.includes(text), `the figures leaked: ${text}`);
  }
  assert.match(health, /refused the key \(401\)/, "and it still says what is wrong, without the key");
});
