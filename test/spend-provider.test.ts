/**
 * The daily cap counts what the provider actually charges: OpenRouter's own usage figure where it can
 * be read, the Agent SDK's estimate only as a fallback, and never an unread figure as zero. The
 * provider is stubbed throughout; no test here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-src-"));
process.env.DAILY_BUDGET_USD = "10";
process.env.OPENROUTER_API_KEY = "sk-or-v1-test-key";

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { SpendMeter, spendCaveat, spendPhrase, spendSourceLabel } = await import("../src/spend.js");
const { londonYmd } = await import("../src/london.js");
import type { AgentRunner } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** One stubbed reply: a usage figure, an HTTP failure, or a network error. The last one repeats. */
type Reply = number | { status: number } | Error;

/** A stubbed usage endpoint, counting how often it is asked. */
function usageFetch(values: Reply[]) {
  const calls: Array<{ url: string; auth?: string }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const reply = values[Math.min(i++, values.length - 1)];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") return { ok: true, status: 200, json: async () => ({ data: { usage: reply } }) };
    return { ok: false, status: reply.status, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fixed clock, so the London day and the refresh interval are both under the test's control. */
function harness(options: { usage: Reply[]; at?: number; maxAgeMs?: number; slots?: number; hold?: boolean }) {
  const clock = { t: options.at ?? Date.parse("2026-11-13T10:00:00Z") };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-src-")));
  const messenger = new ConsoleMessenger();
  const sent: string[] = [];
  messenger.send = async (_to: string, text: string) => {
    sent.push(text);
  };
  const started: string[] = [];
  /** With `hold`, each run waits until the test lets it finish, so a job can be held mid-run. */
  const held: Array<() => void> = [];
  const runner: AgentRunner = async (o) => {
    started.push(o.prompt.split("\n")[0]);
    if (!options.hold) return { text: "done" };
    return new Promise((resolve) => held.push(() => resolve({ text: "done" })));
  };
  const { fetchImpl, calls } = usageFetch(options.usage);
  const meter = new SpendMeter({
    apiKey: "sk-or-v1-test-key",
    fetch: fetchImpl,
    now: () => clock.t,
    maxAgeMs: options.maxAgeMs,
    load: () => store.usageStart(),
    save: (b) => store.setUsageStart(b),
    warn: () => undefined,
  });
  const jobs = new JobRunner(store, messenger, runner, undefined, { spend: meter, liveness: { now: () => clock.t }, slots: options.slots });
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  /** A job that finished today, with the SDK's rounded-up estimate the cap used to believe. */
  const estimated = (cost: number) => {
    const j = store.createJob("research", "Costly research", FOUNDER, "product");
    store.updateJob(j.id, { status: "done", costUsd: cost, finishedAt: new Date(clock.t - HOUR).toISOString() });
    return j;
  };
  return { store, jobs, orch, meter, sent, started, held, clock, calls, estimated };
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("the cap counts OpenRouter's own usage for the day, not the SDK's rounded-up estimate", async () => {
  // 100.00 at the start of the day, 101.66 after the work: OpenRouter says 1.66 was charged.
  const h = harness({ usage: [100, 101.66] });
  h.estimated(20); // the estimate alone would be past the $10 cap
  await h.jobs.refreshSpend();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].auth, "Bearer sk-or-v1-test-key", "the key is sent as a bearer token");
  assert.equal(h.jobs.spendState().usd, 0, "the first reading of the day starts the count at zero");
  h.clock.t += 2 * MINUTE;
  await h.jobs.refreshSpend();
  assert.equal(h.calls.length, 2);
  const spend = h.jobs.spendState();
  assert.deepEqual({ usd: spend.usd, source: spend.source }, { usd: 1.66, source: "provider" });
  assert.equal(h.jobs.capReached(), false, "1.66 charged is nowhere near the $10 cap");
  assert.equal(spendCaveat(spend), undefined, "a provider figure carries no caveat");
  assert.equal(spendPhrase(spend), "$1.66 charged by OpenRouter");
  // A job starts straight away rather than queueing behind a cap that has not really been reached.
  h.jobs.start("research", "R1", FOUNDER);
  await waitFor(() => h.started.includes("R1"));
  assert.equal(h.sent.filter((t) => /daily spend cap/.test(t)).length, 0, "no false 'cap is hit' message");

  await h.orch.handle(FOUNDER, "/spend", { replyTo: FOUNDER });
  const out = h.sent.at(-1)!;
  assert.match(out, /Today \(\d{4}-\d{2}-\d{2}\): \$1\.66 spent today \(OpenRouter's own figure\), cap \$10\.00, \$8\.34 left, not blocking jobs\./);
  assert.match(out, /The Agent SDK's estimate for today's jobs is \$20\.00: its price table, rounded up, so not the bill\./);
  assert.match(out, /By kind \(estimated\): research \$20\.00\./);
  assert.match(out, /Top: Costly research \(\w+\) \$20\.00 estimated/);
});

test("a job whose turn comes is confirmed against the provider, so a stale estimate cannot hold the queue", async () => {
  const h = harness({ usage: [100, 101.66], slots: 1, hold: true });
  h.estimated(20); // the estimate alone is past the $10 cap
  h.jobs.start("engineer", "E1", FOUNDER);
  await waitFor(() => h.started.includes("E1"));
  h.jobs.start("engineer", "E2", FOUNDER); // one slot, so this queues behind E1
  assert.deepEqual(h.started, ["E1"], "E2 waits for the free slot");
  h.clock.t += 6 * MINUTE; // the reading is now stale, so the cap falls back to the $20 estimate
  assert.equal(h.jobs.spendState().source, "estimate");
  assert.equal(h.jobs.capReached(), true);
  h.held.shift()!(); // E1 finishes and hands its repository to the queue
  await waitFor(() => h.started.includes("E2"));
  assert.equal(h.sent.filter((t) => /daily spend cap/.test(t)).length, 0, "no false 'cap is hit' message on the queue path");
});

test("with the provider unreachable the estimate is used, said to be an estimate, and the cap still blocks", async () => {
  const h = harness({ usage: [new Error("getaddrinfo ENOTFOUND openrouter.ai")] });
  h.estimated(12);
  await h.jobs.refreshSpend();
  const spend = h.jobs.spendState();
  assert.equal(spend.source, "estimate");
  assert.equal(spend.usd, 12);
  assert.match(spendCaveat(spend)!, /OpenRouter could not be read/);
  assert.equal(h.jobs.capReached(), true, "an unknown provider figure is never treated as zero");

  h.jobs.start("research", "R1", FOUNDER);
  await waitFor(() => h.sent.some((t) => /daily spend cap/.test(t)));
  const notice = h.sent.find((t) => /daily spend cap/.test(t))!;
  assert.match(notice, /\$10 is hit: \$12\.00 spent today \(our estimate: OpenRouter could not be read/);
  assert.match(notice, /\/resume/);
  assert.deepEqual(h.started, [], "nothing started while the estimated spend is past the cap");
});

test("a rate limit falls back the same way, and the provider is not hammered", async () => {
  const h = harness({ usage: [{ status: 429 }] });
  h.estimated(11);
  for (let i = 0; i < 5; i++) await h.jobs.refreshSpend();
  assert.equal(h.calls.length, 1, "at most one call a minute, however often the cap is checked");
  assert.match(h.meter.lastFailure()!, /rate-limited/);
  assert.match(spendCaveat(h.jobs.spendState())!, /rate-limited/);
  h.clock.t += 2 * MINUTE;
  await h.jobs.refreshSpend();
  assert.equal(h.calls.length, 2, "a minute later it may ask again");
});

test("a reading that has gone stale is not trusted: the estimate is used and labelled so", async () => {
  const h = harness({ usage: [40], maxAgeMs: 2 * MINUTE });
  h.estimated(12);
  await h.jobs.refreshSpend();
  assert.equal(h.jobs.spendState().source, "provider");
  h.clock.t += 5 * MINUTE; // no further reading: the figure is now too old to bill from
  const spend = h.jobs.spendState();
  assert.equal(spend.source, "estimate");
  assert.equal(spend.usd, 12);
  assert.match(spendCaveat(spend)!, /too old to trust/);
});

test("the day boundary restarts the count from the last reading of the day before, across a restart", async () => {
  // 23:50 on the 12th, then 00:10 on the 13th: the 13th's spend is the difference, 3.00.
  const h = harness({ usage: [100, 103], at: Date.parse("2026-11-12T23:50:00Z") });
  await h.jobs.refreshSpend();
  assert.deepEqual(h.store.usageStart(), { ymd: "2026-11-12", usd: 100, at: new Date(h.clock.t).toISOString() });
  h.clock.t = Date.parse("2026-11-13T00:10:00Z");
  await h.jobs.refreshSpend();
  assert.equal(londonYmd(new Date(h.clock.t)), "2026-11-13");
  assert.deepEqual(h.store.usageStart(), { ymd: "2026-11-13", usd: 100, at: new Date(h.clock.t).toISOString() }, "the day starts from the last reading of the day before");
  const spend = h.jobs.spendState();
  assert.deepEqual({ usd: spend.usd, source: spend.source }, { usd: 3, source: "provider" });
  assert.equal(h.jobs.capReached(), false);

  // A restart: a fresh meter over the same store keeps the day's starting figure, not zero.
  const restarted = new SpendMeter({
    apiKey: "sk-or-v1-test-key",
    fetch: usageFetch([103]).fetchImpl,
    now: () => h.clock.t,
    load: () => h.store.usageStart(),
    save: (b) => h.store.setUsageStart(b),
    warn: () => undefined,
  });
  await restarted.refresh();
  const after = restarted.today(0, "2026-11-13");
  assert.deepEqual({ usd: after.usd, source: after.source }, { usd: 3, source: "provider" });
});

test("a figure that goes backwards (a new key) starts the day again rather than reporting a negative", async () => {
  const h = harness({ usage: [50, 2], at: Date.parse("2026-11-13T09:00:00Z") });
  await h.jobs.refreshSpend();
  h.clock.t += 2 * MINUTE;
  await h.jobs.refreshSpend();
  assert.equal(h.jobs.spendState().usd, 0);
  assert.deepEqual(h.store.usageStart(), { ymd: "2026-11-13", usd: 2, at: new Date(h.clock.t).toISOString() });
});

test("Anthropic mode keeps the SDK's list-price cost and never calls a usage endpoint", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-src-")));
  let fetched = 0;
  const meter = new SpendMeter({
    apiKey: "",
    fetch: (async () => {
      fetched++;
      throw new Error("no call expected");
    }) as unknown as typeof fetch,
    now: () => Date.now(),
    load: () => store.usageStart(),
    save: (b) => store.setUsageStart(b),
  });
  await meter.refresh();
  const spend = meter.today(4.5, "2026-11-13");
  assert.equal(fetched, 0, "no provider is asked without a key");
  // On Anthropic the SDK's list-price cost is the bill, so it is not called an estimate.
  assert.deepEqual({ usd: spend.usd, source: spend.source }, { usd: 4.5, source: "anthropic" });
  assert.equal(spendCaveat(spend), undefined, "the bill is not caveated");
  assert.equal(spendSourceLabel(spend), "Anthropic's own list price");
  assert.equal(spendPhrase(spend), "$4.50 charged by Anthropic (list price)");
});
