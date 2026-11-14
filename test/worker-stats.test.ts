/**
 * The per-kind figures on the board, from a known set of job records and a pinned clock.
 *
 * The point of these tests is honesty about money as much as arithmetic: a cost per job appears only
 * where the store holds the provider's own figure (or Anthropic's list price, which is the bill
 * there), the Agent SDK's estimate is never used for one, and where there is no real figure the page
 * says exactly that instead of putting a number there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { boardEfficiency, median, NEVER_THE_ESTIMATE, NO_REAL_COST, STATS_WINDOWS } = await import("../src/worker-stats.js");
import type { Job } from "../src/store.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A day in minutes, because `at` takes minutes ago. */
const DAY = 24 * 60;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * MIN).toISOString();

let seq = 0;

interface Usage {
  costUsd?: number;
  costSource?: string;
  totals?: { calls?: number; promptTokens?: number; cachedTokens?: number; completionTokens?: number };
}

/** A finished job, given only what these figures read: kind, status, times, failure and usage. */
function job(over: Partial<Job> & { usage?: Usage } = {}): Job {
  return {
    id: `job${String(++seq).padStart(4, "0")}`,
    kind: "engineer",
    brief: "Do the thing.",
    requestedBy: "tg:99887766",
    status: "done",
    createdAt: at(180),
    startedAt: at(178),
    finishedAt: at(158),
    ...over,
  } as unknown as Job;
}

const engineerWithCost = (minsAgo: number, waitMin: number, runMin: number, costUsd: number, cached: number) =>
  job({
    kind: "engineer",
    createdAt: at(minsAgo),
    startedAt: at(minsAgo - waitMin),
    finishedAt: at(minsAgo - waitMin - runMin),
    usage: { costUsd, costSource: "provider", totals: { promptTokens: 1_000, cachedTokens: cached } },
  });

test("the median is the middle value, and the windows are the last day and the last week", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([7]), 7);
  assert.equal(median([9, 1, 5]), 5, "the middle of the bunch, so one slow job does not skew it");
  assert.equal(median([1, 3]), 2, "an even count takes the middle of the two");
  assert.deepEqual(
    STATS_WINDOWS.map((w) => w.label),
    ["last 24 hours", "last 7 days"],
  );
});

test("one kind over both windows: finished, done, why the rest stopped, waits and runs", () => {
  const jobs: Job[] = [
    engineerWithCost(160, 2, 20, 0.42, 680),
    engineerWithCost(120, 10, 20, 0.4, 700),
    // Stopped by the watchdog: a failure, with its own reason on the page.
    job({ kind: "engineer", createdAt: at(90), startedAt: at(50), finishedAt: at(10), status: "failed", failure: "stalled" }),
    // Three days old: in the week, not the day.
    job({ kind: "maintain", createdAt: at(3 * DAY + 60), startedAt: at(3 * DAY + 55), finishedAt: at(3 * DAY + 10) }),
    // Eight days old: in neither window.
    job({ kind: "research", createdAt: at(8 * DAY + 20), startedAt: at(8 * DAY + 10), finishedAt: at(8 * DAY) }),
    // Not finished: running work is not a figure.
    job({ kind: "engineer", createdAt: at(5), startedAt: at(4), finishedAt: undefined, status: "running" }),
  ];
  const board = boardEfficiency({ jobs, now: NOW });

  const day = board.windows[0]!;
  assert.equal(day.label, "last 24 hours");
  assert.deepEqual(day.kinds.map((k) => k.kind), ["engineer"], "only a kind that finished something appears");
  const engineer = day.kinds[0]!;
  assert.equal(engineer.label, "engineer", "in Paul's word for the kind");
  assert.equal(engineer.finished, 3);
  assert.equal(engineer.done, 2);
  assert.equal(engineer.stoppedOrFailed, 1);
  assert.equal(engineer.why, "stalled, stopped", "a failure is named in plain words");
  assert.equal(engineer.wait, "queue wait before starting: 10 minutes typical, 40 minutes worst");
  assert.equal(engineer.run, "run time: 20 minutes typical, 40 minutes worst");

  const week = board.windows[1]!;
  assert.deepEqual(week.kinds.map((k) => k.kind), ["engineer", "maintain"], "the week reaches further back");
  assert.equal(week.kinds.find((k) => k.kind === "engineer")!.finished, 3);
  const maintain = week.kinds.find((k) => k.kind === "maintain")!;
  assert.equal(maintain.label, "maintainer");
  assert.equal(maintain.finished, 1);
  assert.equal(maintain.why, undefined, "nothing failed, so there is nothing to explain");
});

test("a cost per job is shown only from a real figure, and never from the SDK's estimate", () => {
  const jobs: Job[] = [
    engineerWithCost(60, 2, 20, 0.42, 680),
    engineerWithCost(50, 10, 20, 0.4, 700),
    // The Agent SDK's own estimate, and a figure with no source at all: neither is a bill.
    job({ kind: "research", usage: { costUsd: 3.5, costSource: "estimate" } }),
    job({ kind: "write", usage: { costUsd: 9.99 } }),
  ];
  const board = boardEfficiency({ jobs, now: NOW });
  const kinds = board.windows[0]!.kinds;
  const engineer = kinds.find((k) => k.kind === "engineer")!;
  assert.equal(engineer.cost, "cost per job: $0.4100 typical, the provider's own figure, from 2 of 2 jobs");
  assert.equal(kinds.find((k) => k.kind === "research")!.cost, undefined, "an estimate is never shown as a cost");
  assert.equal(kinds.find((k) => k.kind === "write")!.cost, undefined, "an unsourced figure is never shown as a cost");
  assert.ok(!JSON.stringify(board).includes("3.5") && !JSON.stringify(board).includes("9.99"), "no estimate reaches the page");
  // The section says which kinds have no real figure, so nothing is left to guess.
  assert.match(board.costNote, /no real figure stored, so no cost is shown for researcher, writer/);
  assert.ok(board.costNote.includes(NEVER_THE_ESTIMATE));

  // With no real figure anywhere it says so once, in one sentence, and prints no money at all.
  const none = boardEfficiency({ jobs: [job({ kind: "research", usage: { costUsd: 3.5, costSource: "estimate" } }), job({ kind: "engineer" })], now: NOW });
  assert.equal(none.costNote, NO_REAL_COST);
  assert.ok(!/\$\s?\d/.test(JSON.stringify(none)), "no amount of money is invented");
  assert.ok(none.windows[0]!.kinds.every((k) => k.cost === undefined));

  // Anthropic's own list price is the bill there, and the line says which figure it is.
  const anthropic = boardEfficiency({
    jobs: [job({ kind: "ea", usage: { costUsd: 0.1234, costSource: "anthropic" } })],
    now: NOW,
  });
  const ea = anthropic.windows[0]!.kinds[0]!;
  assert.equal(ea.cost, "cost per job: $0.1234 typical, Anthropic's own list price, which is the bill there, from 1 of 1 jobs");
  assert.equal(anthropic.costNote, `Cost per job is shown where the store holds a real figure (Anthropic's own list price, which is the bill there); there it is what the job really cost, not an estimate. ${NEVER_THE_ESTIMATE}`);
});

test("the cache figure is the share of prompt tokens the provider reported as cache reads", () => {
  const board = boardEfficiency({ jobs: [engineerWithCost(60, 2, 20, 0.42, 680), engineerWithCost(50, 2, 20, 0.42, 700)], now: NOW });
  assert.equal(board.windows[0]!.kinds[0]!.cache, "69% of prompt tokens were cache hits");
  // No token counts in the records, so there is no cache figure to claim.
  const plain = boardEfficiency({ jobs: [job({ kind: "engineer" })], now: NOW });
  assert.equal(plain.windows[0]!.kinds[0]!.cache, undefined);
  // A job that reported no tokens does not drag the share down as though it had none.
  const mixed = boardEfficiency({ jobs: [engineerWithCost(60, 2, 20, 0.42, 500), job({ kind: "engineer" })], now: NOW });
  assert.equal(mixed.windows[0]!.kinds[0]!.cache, "50% of prompt tokens were cache hits");
});

test("a job with no usable times still counts as finished, and adds no wait or run figure", () => {
  const board = boardEfficiency({
    jobs: [
      job({ kind: "design", createdAt: at(30), startedAt: undefined, finishedAt: at(20) }),
      job({ kind: "design", createdAt: at(25), startedAt: at(24), finishedAt: at(21) }),
    ],
    now: NOW,
  });
  const design = board.windows[0]!.kinds[0]!;
  assert.equal(design.finished, 2, "both finished and both are counted");
  assert.equal(design.wait, "queue wait before starting: 1 minute typical, 1 minute worst", "the one job with both times is measured");
  assert.equal(design.run, "run time: 3 minutes typical, 3 minutes worst");
});

test("a kind with nothing in a window is left out rather than shown as zero, and the note explains the figures", () => {
  const board = boardEfficiency({ jobs: [job({ kind: "engineer", finishedAt: at(30) })], now: NOW });
  assert.deepEqual(board.windows[1]!.kinds.map((k) => k.kind), ["engineer"]);
  assert.equal(boardEfficiency({ jobs: [], now: NOW }).windows[0]!.kinds.length, 0);
  const empty = boardEfficiency({ jobs: [], now: NOW });
  assert.match(empty.windows[0]!.note, /Jobs that finished in the last 24 hours/);
  assert.equal(empty.costNote, NO_REAL_COST, "and it still says no real figure is stored");
});
