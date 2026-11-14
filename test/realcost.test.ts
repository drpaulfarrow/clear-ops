import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One engineer slot, one founder, and a small real cap, so the cap is counted in the provider's money
// and the whole path (meter, stop, job record, message) can be driven offline. The workforce runs on
// OpenRouter, which is where a job's cap is counted from the provider's own figures, so this file runs
// in that mode too; the Anthropic-direct case is covered by one test of its own below.
process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-realcost-"));
process.env.ENGINEER_BUDGET_USD = "0.25";
process.env.OPENROUTER_API_KEY = "test-key";

const { RealCostMeter, usdAmount } = await import("../src/realcost.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { budgetReason, failureText } = await import("../src/failures.js");
const { config } = await import("../src/config.js");
const { callIdOf, noteCallCost, runLimits } = await import("../src/agents.js");
const { SpendMeter } = await import("../src/spend.js");
import type { AgentRunner, RunOptions, RunResult } from "../src/agents.js";
import type { JobCostWatch } from "../src/realcost.js";

const FOUNDER = "tg:99887766";

/** A generation endpoint that prices the ids it knows and answers anything else the way asked. */
function fakeProvider(costs: Record<string, number | "404" | "400" | "429"> = { gen1: 0.1 }) {
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    const id = decodeURIComponent(new URL(url).searchParams.get("id") ?? "");
    asked.push(id);
    const cost = costs[id];
    if (cost === undefined || typeof cost === "string") {
      return new Response("{}", { status: cost === undefined ? 404 : Number(cost) });
    }
    return new Response(JSON.stringify({ data: { id, total_cost: cost } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, asked };
}

/**
 * A generation endpoint that has not published a call's record yet: OpenRouter answers 404 for a
 * moment after a call finishes and prices it a little later. The first `notReady` reads 404.
 */
function slowProvider(costs: Record<string, number> = { gen1: 0.02 }, notReady = 1) {
  const asked: string[] = [];
  const counts = new Map<string, number>();
  const fetch: typeof globalThis.fetch = async (input) => {
    const id = decodeURIComponent(new URL(String(input)).searchParams.get("id") ?? "");
    asked.push(id);
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    if (n <= notReady) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ data: { id, total_cost: costs[id] ?? 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, asked };
}

const meterFor = (fetch: typeof globalThis.fetch, capUsd?: number, onExceeded: (cost: { usd: number }) => void = () => undefined) =>
  new RealCostMeter({ apiKey: "test-key", fetch, capUsd, onExceeded, gapMs: 0, settleMs: 500, settlePassMs: 5, pendingSweepMs: 5, timeoutMs: 500, warn: () => undefined });

test("a job's cost is the sum of the provider's own per-call figures, each id read once", async () => {
  const { fetch, asked } = fakeProvider({ gen1: 0.0012, gen2: 0.0031 });
  const meter = meterFor(fetch, 1, () => undefined);
  meter.note("gen1");
  meter.note("gen2");
  meter.note("gen1"); // the same reply twice is one call
  meter.note(undefined);
  const cost = await meter.settle();
  assert.deepEqual(asked, ["gen1", "gen2"]);
  assert.equal(cost.source, "provider");
  assert.equal(cost.usd, 0.01, "summed and rounded up to the cent, never down");
  assert.equal(cost.calls, 2);
  assert.equal(cost.read, 2);
});

test("the cap is counted in the provider's money: it fires past the figure and never at a penny", async () => {
  const stopped: number[] = [];
  const { fetch } = fakeProvider({ gen1: 0.3 });
  const meter = meterFor(fetch, 0.25, (cost) => stopped.push(cost.usd));
  meter.note("gen1");
  await meter.settle();
  assert.deepEqual(stopped, [0.3]);
  assert.equal(meter.exceededBy()?.usd, 0.3);

  // A job that has really spent pennies is never stopped, however long it runs.
  const cheap = fakeProvider({ gen1: 0.0004 });
  const quiet: number[] = [];
  const under = meterFor(cheap.fetch, 0.25, (cost) => quiet.push(cost.usd));
  for (let i = 0; i < 50; i++) under.note(`gen${i}`);
  const total = await under.settle();
  assert.equal(quiet.length, 0, "never stopped for budget while it has really spent pennies");
  assert.equal(under.exceededBy(), undefined);
  assert.ok(total.usd <= 0.25);
});

test("an id the provider will not price is left out and the total says it is a lower bound", async () => {
  const { fetch } = fakeProvider({ gen1: 0.02, gen2: "404" });
  const meter = meterFor(fetch);
  meter.note("gen1");
  meter.note("gen2");
  const cost = await meter.settle();
  assert.equal(cost.source, "provider");
  assert.equal(cost.usd, 0.02);
  assert.equal(cost.read, 1);
  assert.match(cost.note ?? "", /lower bound/);
});

test("an endpoint that rejects this run's ids stops being asked and reports no figure", async () => {
  const { fetch, asked } = fakeProvider({ gen1: "400", gen2: "400", gen3: "400" });
  const meter = meterFor(fetch, 0.01, () => assert.fail("the cap must never fire on a figure that could not be read"));
  meter.note("gen1");
  meter.note("gen2");
  meter.note("gen3");
  const cost = await meter.settle();
  assert.equal(cost.source, "unavailable");
  assert.equal(cost.usd, 0);
  assert.match(cost.note ?? "", /did not recognise/);
  assert.deepEqual(asked, ["gen1"], "asked once, then left alone");
  assert.equal(meter.exceededBy(), undefined);
});

test("a rate-limited price read is reported plainly and never becomes a figure", async () => {
  const { fetch } = fakeProvider({ gen1: "429" });
  const meter = meterFor(fetch);
  meter.note("gen1");
  const cost = await meter.settle();
  assert.equal(cost.source, "unavailable");
  assert.match(cost.note ?? "", /rate-limited/);
});

test("without a provider key nothing is read and the figure is simply not available", async () => {
  const fetch = (() => assert.fail("no call may be made without a key")) as unknown as typeof globalThis.fetch;
  const meter = new RealCostMeter({ apiKey: "", fetch, capUsd: 0.01, onExceeded: () => assert.fail("no cap without a figure") });
  assert.equal(meter.enabled, false);
  meter.note("gen1");
  const cost = await meter.settle();
  assert.equal(cost.source, "unavailable");
  assert.equal(meter.exceededBy(), undefined);
});

test("a call the provider has not published yet is read again, not given up on", async () => {
  // The record for a call appears a little after it finishes, so a 404 straight after the call is
  // ordinary: the id stays pending and is priced on a later read.
  const { fetch, asked } = slowProvider({ gen1: 0.02 }, 2);
  const meter = meterFor(fetch);
  meter.note("gen1");
  const cost = await meter.settle();
  assert.equal(cost.source, "provider");
  assert.equal(cost.usd, 0.02);
  assert.equal(asked.length, 3, "asked again until the provider published it");
});

test("a cap fires during the run as soon as the provider publishes the calls", async () => {
  const { fetch } = slowProvider({ gen1: 0.3 }, 1);
  const stopped: number[] = [];
  const meter = meterFor(fetch, 0.25, (cost) => stopped.push(cost.usd));
  meter.note("gen1");
  await waitFor(() => meter.exceededBy() !== undefined, 2000);
  assert.deepEqual(stopped, [0.3], "the run is stopped once the real figure passes the cap");
  meter.stop();
});

test("the id the meter is given is the provider's generation id, never the message id", () => {
  // The frame the SDK hands the runner for a real call, as OpenRouter's Anthropic-compatible endpoint
  // sends it: `message.id` is the Anthropic-shaped msg_..., `request_id` is the gen-... its own
  // pricing endpoint takes. Reading the wrong one left every cap unable to fire.
  const seen: Array<string | undefined> = [];
  const meter = { note: (id?: string) => seen.push(id) };
  const frame = {
    type: "assistant",
    message: { id: "msg_BGhiVlVXGAkILktchYfr" },
    request_id: "gen-1794609616-BGhiVlVXGAkILktchYfr",
    session_id: "s1",
    uuid: "u1",
    parent_tool_use_id: null,
  } as unknown as Parameters<typeof noteCallCost>[0];
  noteCallCost(frame, meter);
  assert.deepEqual(seen, ["gen-1794609616-BGhiVlVXGAkILktchYfr"]);
  assert.equal(callIdOf({ request_id: "  " }), undefined, "a blank id is not a call");
  noteCallCost({ ...frame, request_id: undefined } as unknown as Parameters<typeof noteCallCost>[0], meter);
  assert.deepEqual(seen, ["gen-1794609616-BGhiVlVXGAkILktchYfr", undefined], "a frame with no request id is left uncounted");
});

test("usdAmount keeps a fraction of a cent visible", () => {
  assert.equal(usdAmount(0.0042), "0.0042");
  assert.equal(usdAmount(0.3), "0.30");
  assert.equal(usdAmount(12), "12.00");
  assert.equal(usdAmount(0), "0.00");
});

test("the stopped-for-budget sentence states the spend, the cap and the measure", () => {
  assert.equal(
    budgetReason({ spentUsd: 0.3, capUsd: 0.25, measure: "provider" }),
    "it was stopped for budget with OpenRouter's own figures at $0.30 against the $0.25 cap for this kind",
  );
  assert.match(budgetReason({ spentUsd: 0.3, unreadable: 2, capUsd: 0.25, measure: "provider" }), /lower bound: 2 of its calls could not be priced/);
  assert.equal(
    budgetReason({ capUsd: 0.25, measure: "provider" }),
    "it was stopped for budget at the $0.25 cap for this kind, and the real figure could not be read, so there is no amount to quote",
  );
  assert.equal(
    budgetReason({ spentUsd: 4.2, capUsd: 1000, measure: "estimate" }),
    "it was stopped by the SDK's own runaway guard of $1000.00, an internal estimate and not a bill, by which time OpenRouter had really charged $4.20",
  );
  assert.match(budgetReason({ capUsd: 1000, measure: "estimate" }), /could not be read/);
  // On Anthropic the SDK's list-price cost is the bill, so the same sentence names it as such.
  assert.equal(
    budgetReason({ spentUsd: 12.4, capUsd: 25, measure: "anthropic" }),
    "it was stopped for budget with Anthropic's own list price at $12.40 against the $25.00 cap for this kind",
  );
  assert.equal(
    budgetReason({ spentUsd: 25.5, capUsd: 1000, measure: "anthropic", guard: true }),
    "it was stopped by the SDK's own runaway guard of $1000.00, priced at Anthropic's own list price, by which time it had really spent $25.50",
  );
  assert.equal(
    budgetReason({ capUsd: 1000, measure: "anthropic", guard: true }),
    "it was stopped by the SDK's own runaway guard of $1000.00, priced at Anthropic's own list price, and the real figure could not be read, so there is no amount to quote",
  );
});

/** A runner that reports one call, then waits to be stopped the way the SDK does. */
function stoppingRunner(ids = ["gen1"]): AgentRunner {
  return async (o: RunOptions): Promise<RunResult> => {
    for (const id of ids) o.costMeter?.note(id);
    await new Promise<void>((resolve) => {
      if (o.abortController?.signal.aborted) return resolve();
      o.abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // The SDK's iterator throws once its process is killed; the runner classifies it as below.
    throw new Error("aborted");
  };
}

function setup(run: AgentRunner, costWatch?: (capUsd: number | undefined, stop: () => void) => JobCostWatch) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-realcost-run-")));
  const messenger = new ConsoleMessenger();
  // The spend meter is off: these tests are about a job's own cap, and nothing here may reach the
  // network for a usage figure.
  const spend = new SpendMeter({ apiKey: "" });
  const jobs = new JobRunner(store, messenger, run, undefined, { failureNotices: { batchMs: 20, cooldownMs: 50 }, spend, ...(costWatch ? { costWatch } : {}) });
  return { store, messenger, jobs };
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("a job the provider's figures pass the cap is recorded failed, with the true figure and no review", async () => {
  const { fetch } = fakeProvider({ gen1: 0.3 });
  const { store, messenger, jobs } = setup(stoppingRunner(), (capUsd, stop) => meterFor(fetch, capUsd, stop));
  const job = jobs.start("engineer", "Cap me", FOUNDER, "self");
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  const stored = store.getJob(job.id)!;
  assert.equal(stored.failure, "budget");
  assert.match(stored.error ?? "", /\$0.30/);
  assert.equal(stored.status, "failed", "never recorded as done");
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0, "nothing follows a job stopped for budget");
  await jobs.failures.flushAll();
  const notice = messenger.sent.find((s) => s.text.startsWith("Failed:"));
  assert.ok(notice, "Paul is told");
  assert.match(notice!.text, /stopped for budget/);
  assert.match(notice!.text, /OpenRouter's own figures at \$0\.30 against the \$0\.25 cap/);
  assert.doesNotMatch(notice!.text, /estimate says/);
});

test("a run stopped by the SDK's runaway guard names the guard as the measure, and the real figure with it", async () => {
  const { fetch } = fakeProvider({ gen1: 0.08 });
  const guard = config.sdkRunawayBudgetUsd;
  assert.ok(guard > 0, "every run has a guard");
  const run: AgentRunner = async (o) => {
    o.costMeter?.note("gen1");
    return { text: "", costUsd: 1000.5, error: { kind: "budget", detail: "The agent stopped early (error_max_budget_usd), which is the SDK's own runaway guard, not a job's cap." } };
  };
  const { store, messenger, jobs } = setup(run, (capUsd, stop) => meterFor(fetch, capUsd, stop));
  const job = jobs.start("engineer", "Guard me", FOUNDER, "self");
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  const stored = store.getJob(job.id)!;
  assert.equal(stored.failure, "budget");
  assert.equal(stored.costUsd, 1000.5, "the internal estimate is still recorded on the job, and never shown");
  await jobs.failures.flushAll();
  const notice = messenger.sent.find((s) => s.text.startsWith("Failed:"))!;
  assert.match(notice.text, new RegExp(`runaway guard of \\$${guard}`));
  assert.match(notice.text, /not a bill/);
  assert.match(notice.text, /OpenRouter had really charged \$0\.08/);
});

test("when the real figure cannot be read the message says so rather than quoting the estimate", async () => {
  const run: AgentRunner = async () => ({ text: "", costUsd: 1000.5, error: { kind: "budget", detail: "The agent stopped early (error_max_budget_usd), which is the SDK's own runaway guard, not a job's cap." } });
  // A meter with no provider to ask: there is no per-call figure to read, and the estimate is not
  // offered in its place.
  const { store, messenger, jobs } = setup(run, (capUsd, stop) => new RealCostMeter({ apiKey: "", capUsd, onExceeded: stop }));
  const job = jobs.start("write", "No figure", FOUNDER, "product");
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  await jobs.failures.flushAll();
  const notice = messenger.sent.find((s) => s.text.startsWith("Failed:"))!;
  assert.match(notice.text, /OpenRouter's figure for it could not be read/);
  assert.doesNotMatch(notice.text, /1000\.5/, "the estimate is never quoted as the bill");
  assert.doesNotMatch(notice.text, /\$1000\.50/);
});

test("a run under its cap finishes as usual, and the guard is what the SDK is given on OpenRouter", async () => {
  const { fetch } = fakeProvider({ gen1: 0.02 });
  let given: number | undefined;
  const run: AgentRunner = async (o) => {
    given = o.maxBudgetUsd;
    o.costMeter?.note("gen1");
    return { text: "Report.\n\n<message_to_paul>\nAll done, nothing needed from you.\n</message_to_paul>", costUsd: 3 };
  };
  const { store, jobs } = setup(run, (capUsd, stop) => meterFor(fetch, capUsd, stop));
  const job = jobs.start("engineer", "Under the cap", FOUNDER, "self");
  await waitFor(() => store.getJob(job.id)!.status === "done");
  assert.equal(store.getJob(job.id)!.failure, undefined);
  assert.equal(given, config.sdkRunawayBudgetUsd, "on OpenRouter the SDK gets only the runaway guard");
});

test("on Anthropic the SDK is given the job's own cap, and the message names Anthropic's list price", async () => {
  // The ea runs on Anthropic directly, and an Anthropic-only deployment runs everything there: no
  // per-call price to read, and the SDK's list-price cost is what is billed, so the job's cap is
  // handed to the SDK itself rather than being lost.
  const key = config.openrouter.apiKey;
  config.openrouter.apiKey = "";
  try {
    let given: number | undefined;
    const run: AgentRunner = async (o) => {
      given = o.maxBudgetUsd;
      return { text: "", costUsd: 12.4, error: { kind: "budget", detail: "The agent stopped early (error_max_budget_usd)." } };
    };
    const { store, messenger, jobs } = setup(run);
    const job = jobs.start("engineer", "Anthropic cap", FOUNDER, "self");
    await waitFor(() => store.getJob(job.id)!.status === "failed");
    assert.equal(given, config.engineerBudgetUsd, "the job's own cap is the figure the SDK is given on Anthropic");
    assert.equal(store.getJob(job.id)!.failure, "budget");
    await jobs.failures.flushAll();
    const notice = messenger.sent.find((s) => s.text.startsWith("Failed:"))!;
    assert.match(notice.text, /Anthropic's own list price at \$12\.40 against the \$0\.25 cap for this kind/);
    assert.doesNotMatch(notice.text, /not a bill/, "on Anthropic the SDK's figure is the bill, not an estimate");
  } finally {
    config.openrouter.apiKey = key;
  }
});

test("the SDK's guard is the only money figure the SDK is given, and the cap is separate", () => {
  const limits = runLimits("engineer");
  assert.equal(limits.maxBudgetUsd, config.sdkRunawayBudgetUsd);
  assert.equal(limits.realBudgetUsd, config.engineerBudgetUsd);
});

test("the failure sentence reads as one plain message to Paul", () => {
  const text = failureText([{ id: "8d67d5", title: "Job caps on real cost", brief: "x", kind: "engineer", target: "product" }], {
    kind: "budget",
    detail: "stopped",
    budget: { spentUsd: 0.3, capUsd: 0.25, measure: "provider" },
  });
  assert.equal(
    text,
    "Failed: Job caps on real cost · engineer · 8d67d5. It did no work because it was stopped for budget with OpenRouter's own figures at $0.30 against the $0.25 cap for this kind. Send retry 8d67d5 to run it again, or show job 8d67d5 for the detail.",
  );
});
