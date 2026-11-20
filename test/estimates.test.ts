/**
 * What a job usually costs (src/estimates.ts), and where the web app shows it.
 *
 * As much about what an estimate must never be as what it is: it comes only from the provider's own
 * figures for jobs that finished, never from the Agent SDK's estimate; it is never put where a job's
 * own cost goes; and with too little to go on there is none at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-estimates-"));

const { costEstimates, estimateFor, estimateModel, ESTIMATE_MIN_JOBS, ESTIMATE_RECENT } = await import("../src/estimates.js");
const { Store } = await import("../src/store.js");
const { appBoard, appJob, appSpend } = await import("../src/app-data.js");
import type { Job } from "../src/store.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const GLM = "z-ai/glm-5.3";
const KIMI = "moonshotai/kimi-k3.1-pro";
const FLASH = "deepseek/deepseek-v4.1-flash";

let n = 0;
/** A finished job with the provider's own figure, charged to one model unless `usage` says otherwise. */
const job = (kind: string, usd: number, o: { model?: string; minsAgo?: number; patch?: Partial<Job>; usage?: Record<string, unknown> } = {}): Job =>
  ({
    id: `j${++n}`,
    kind,
    brief: "A brief.",
    status: "done",
    createdAt: at((o.minsAgo ?? n) + 10),
    finishedAt: at(o.minsAgo ?? n),
    usage: { costUsd: usd, costSource: "provider", costByModel: [{ model: o.model ?? GLM, usd, calls: 4 }], ...o.usage },
    ...o.patch,
  }) as unknown as Job;

test("an estimate is the middle of what finished jobs of a kind cost on a model, with the range most fell in", () => {
  const jobs = [1, 2, 3, 4, 100].map((usd) => job("engineer", usd));
  const [e, ...rest] = costEstimates(jobs);
  assert.equal(rest.length, 0);
  // The median, so the one runaway job does not move it; the quartiles either side.
  assert.deepEqual(e, { kind: "engineer", model: GLM, usd: 3, lowUsd: 2, highUsd: 4, jobs: 5 });
  // An even count sits between the two middle jobs.
  assert.equal(costEstimates([1, 2, 3, 10].map((usd) => job("write", usd)))[0]!.usd, 2.5);
});

test("with too few finished jobs there is no estimate, and nothing is guessed", () => {
  assert.equal(ESTIMATE_MIN_JOBS, 3);
  assert.deepEqual(costEstimates([job("engineer", 1), job("engineer", 2)]), []);
  assert.equal(costEstimates([job("engineer", 1), job("engineer", 2), job("engineer", 3)]).length, 1);
  // Two on one model and two on another are not four of anything.
  assert.deepEqual(costEstimates([job("engineer", 1), job("engineer", 2), job("engineer", 3, { model: KIMI }), job("engineer", 4, { model: KIMI })]), []);
  // Nor are kinds pooled.
  assert.deepEqual(costEstimates([job("engineer", 1), job("engineer", 2), job("write", 3)]), []);
});

test("only the provider's own figure for a job that ran to the end counts", () => {
  const three = [job("research", 1), job("research", 1), job("research", 1)];
  const usual = (extra: Job[]) => costEstimates([...three, ...extra])[0];
  const same = { kind: "research", model: GLM, usd: 1, lowUsd: 1, highUsd: 1, jobs: 3 };
  // The Agent SDK's estimate, on the usage record or on the job itself, is never read.
  assert.deepEqual(usual([job("research", 50, { usage: { costSource: "estimate" } })]), same);
  assert.deepEqual(usual([job("research", 50, { usage: { costSource: "unavailable", costUsd: undefined }, patch: { costUsd: 50 } as never })]), same);
  // A failed or cancelled job says what a failure cost, and a stopped one's figures are partial.
  assert.deepEqual(usual([job("research", 50, { patch: { status: "failed" } }), job("research", 50, { patch: { status: "cancelled" } as never })]), same);
  assert.deepEqual(usual([job("research", 50, { usage: { partial: true } })]), same);
  // A lower bound (the provider priced only some of the calls) would pull the estimate down.
  assert.deepEqual(usual([job("research", 0.01, { usage: { costNote: "OpenRouter priced 2 of this job's 9 calls, so the figure is a lower bound" } })]), same);
  // Anthropic's list price is the bill there, so it counts.
  assert.equal(usual([job("research", 9, { usage: { costSource: "anthropic" } })])!.jobs, 4);
  assert.doesNotMatch(fs.readFileSync("src/estimates.ts", "utf8"), /estimateUsd|job\.costUsd/, "the SDK's estimate is not read here");
});

test("a job's model is the one it was pinned to, or the one most of its charges were for", () => {
  // A worker's small helper calls go to a cheaper model: the job still ran on its main one, and the
  // helper's charges are part of what it cost.
  const helped = () => job("engineer", 3.5, { usage: { costByModel: [{ model: GLM, usd: 3.2, calls: 30 }, { model: FLASH, usd: 0.3, calls: 10 }] } });
  assert.deepEqual(costEstimates([helped(), helped(), helped()]).map((e) => [e.model, e.usd]), [[GLM, 3.5]]);
  // Split evenly, or charged to a model the provider did not name, it has no one price.
  const split = () => job("engineer", 2, { usage: { costByModel: [{ model: GLM, usd: 1, calls: 5 }, { model: KIMI, usd: 1, calls: 5 }] } });
  const unnamed = () => job("engineer", 2, { usage: { costByModel: [{ model: "not reported", usd: 2, calls: 5 }] } });
  assert.deepEqual(costEstimates([split(), split(), split(), unnamed(), unnamed(), unnamed()]), []);
  // A total only: the one model its usage names, or nothing when it names several.
  const total = (models: string[]) => job("maintain", 1, { usage: { costByModel: undefined, models: models.map((model) => ({ model })) } });
  assert.deepEqual(costEstimates([total([KIMI]), total([KIMI]), total([KIMI]), total([KIMI, GLM])]).map((e) => [e.model, e.jobs]), [[KIMI, 3]]);
  // A pinned job says which model it ran on itself.
  const pinned = () => job("write", 4, { model: "something/else", patch: { model: KIMI } });
  assert.deepEqual(costEstimates([pinned(), pinned(), pinned()]).map((e) => e.model), [KIMI]);
  // Names are compared without case or a routing suffix.
  assert.equal(estimateModel(" Z-AI/GLM-5.3:nitro "), GLM);
  assert.ok(estimateFor(costEstimates([job("cv", 1), job("cv", 1), job("cv", 1)]), { kind: "cv" } as never, "z-ai/GLM-5.3:nitro"));
});

test("deep research is its own kind of work, and only the newest jobs count", () => {
  const deep = () => job("research", 6, { patch: { depth: "deep" } });
  const list = costEstimates([deep(), deep(), deep(), job("research", 1), job("research", 1), job("research", 1)]);
  assert.deepEqual(list.map((e) => [e.kind, e.usd]), [["research, deep", 6], ["research", 1]], "the dearest first");
  assert.equal(estimateFor(list, { kind: "research", depth: "deep" }, GLM)!.usd, 6);
  assert.equal(estimateFor(list, { kind: "research" }, GLM)!.usd, 1);
  assert.equal(estimateFor(list, { kind: "research" }, KIMI), undefined);
  assert.equal(estimateFor(list, { kind: "research" }, undefined), undefined);
  // Old prices fall out: forty jobs at a dollar long ago, then thirty at two.
  const old = Array.from({ length: 40 }, (_, i) => job("write", 1, { minsAgo: 10_000 + i }));
  const fresh = Array.from({ length: ESTIMATE_RECENT }, (_, i) => job("write", 2, { minsAgo: i }));
  assert.deepEqual(costEstimates([...old, ...fresh]).map((e) => [e.usd, e.jobs]), [[2, ESTIMATE_RECENT]]);
});

/* ---------- Where the app shows it ---------- */

const PAUL = "tg:99887766";
const quietQueue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: NOW }), capReached: () => false };

function seeded() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-estimates-app-")));
  const mk = (kind: string, title: string, patch: Record<string, unknown>) => s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, "product", PAUL, { title } as never).id, patch as never);
  const done = (kind: string, usd: number, model: string, minsAgo: number) =>
    mk(kind, `Done ${kind} ${usd}`, { status: "done", startedAt: at(minsAgo + 10), finishedAt: at(minsAgo), usage: { role: "worker", costUsd: usd, costSource: "provider", totals: { calls: 4, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: 0 }, costByModel: [{ model, usd, calls: 4 }] } });
  [0.4, 0.6, 0.8, 1.2].forEach((usd, i) => done("research", usd, GLM, 60 + i));
  [2, 3, 4].forEach((usd, i) => done("research", usd, KIMI, 90 + i));
  [5, 6].forEach((usd, i) => done("engineer", usd, GLM, 120 + i));
  return { s, mk };
}

test("a job with no figure of its own yet says what jobs like it usually cost, and never as its cost", () => {
  const { s, mk } = seeded();
  const waiting = mk("research", "Waiting", { status: "queued", model: GLM });
  const running = mk("research", "Running", { status: "running", startedAt: at(5), model: KIMI, costUsd: 7.77 });
  const tooFew = mk("engineer", "Too few", { status: "queued", model: GLM });
  const unknown = mk("research", "No history on this model", { status: "queued", model: "anthropic/claude-opus-5.5" });
  const board = appBoard({ store: s, queue: quietQueue, now: NOW });
  const card = (id: string) => board.jobs.find((j) => j.id === id)!;
  assert.deepEqual(card(waiting.id).usual, { usd: 0.7, lowUsd: 0.55, highUsd: 0.9, jobs: 4 });
  assert.deepEqual(card(running.id).usual, { usd: 3, lowUsd: 2.5, highUsd: 3.5, jobs: 3 });
  // The estimate is not the job's cost: that stays absent until the provider gives a figure.
  assert.equal(card(waiting.id).costUsd, undefined);
  assert.equal(card(running.id).costUsd, undefined);
  assert.equal(card(tooFew.id).usual, undefined);
  assert.equal(card(unknown.id).usual, undefined);
  // A finished job has its own figure, or none; never the usual one in its place.
  for (const j of board.jobs.filter((j) => j.status === "done")) assert.equal(j.usual, undefined);
  const failed = mk("research", "Failed", { status: "failed", finishedAt: at(1), model: GLM });
  assert.equal(appJob({ store: s, queue: quietQueue, now: NOW }, failed.id)!.job.usual, undefined);
  assert.deepEqual(appJob({ store: s, queue: quietQueue, now: NOW }, waiting.id)!.job.usual, card(waiting.id).usual);
});

test("running a job again says what it usually costs on each model there is enough to go on for", () => {
  const { s, mk } = seeded();
  const failed = mk("research", "Failed", { status: "failed", finishedAt: at(1) });
  const actions = appJob({ store: s, queue: quietQueue, now: NOW }, failed.id)!.actions;
  assert.deepEqual(actions.rerunModels, [GLM, KIMI, "anthropic/claude-opus-5.5"]);
  assert.deepEqual(actions.rerunUsual, [{ model: GLM, usd: 0.7, jobs: 4 }, { model: KIMI, usd: 3, jobs: 3 }]);
  // With nothing to go on the field is not sent at all.
  const eng = mk("engineer", "Failed engineer", { status: "failed", finishedAt: at(1) });
  assert.equal("rerunUsual" in appJob({ store: s, queue: quietQueue, now: NOW }, eng.id)!.actions, false);
});

test("the Spend page lists what each kind usually costs on each model, the dearest first", () => {
  const { s } = seeded();
  const page = appSpend({ store: s, queue: quietQueue, now: NOW });
  assert.deepEqual(page.usual.map((u) => [u.who, u.model, u.usd, u.lowUsd, u.highUsd, u.jobs]), [
    ["Researcher", KIMI, 3, 2.5, 3.5, 3],
    ["Researcher", GLM, 0.7, 0.55, 0.9, 4],
  ]);
  assert.deepEqual(appSpend({ store: new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-estimates-none-"))), queue: quietQueue, now: NOW }).usual, []);
});

test("the page words an estimate as what jobs like it cost, and keeps it out of the cost itself", () => {
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.match(js, /Jobs like this usually cost about \$\{money\(job\.usual\.usd\)\}/);
  assert.match(js, /An estimate from \$\{u\.jobs\} past jobs, not this job's cost\./);
  // The card's own figure and the job page's cost tile read only the job's real cost.
  assert.match(js, /job\.costUsd !== undefined \? h\("div", \{ class: "card-cost num" \}, money\(job\.costUsd\)\) : null/);
  assert.doesNotMatch(js, /card-cost[^\n]*usual/);
  assert.doesNotMatch(js, /money\(job\.usual\.usd\)[^\n]*"The provider's own figure\."/);
});
