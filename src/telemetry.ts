/**
 * What a job's model calls used and cost: the per-call record, the job's totals, and the two views of
 * them Paul can read. This is the baseline every later change to models, prompts, tools and retrieval
 * is judged against, so it records numbers only and never a word of a prompt, a brief or an output.
 *
 * Where the numbers come from. Every model call the Agent SDK reports carries the provider's own usage
 * for that response (prompt, cached, cache-write and completion tokens, and the thinking tokens where
 * the provider reports them), which is what a call record holds. A run's own totals come from the
 * SDK's per-model summary of that run, which is the field meant for token accounting. Latency is the
 * gap between the call's reply and the previous message the SDK produced, so it is an upper bound on
 * the call itself: any local tool work in between is included.
 *
 * Money is the awkward part, and this module is careful about it. A job's figure is only ever the
 * provider's own (src/realcost.ts: what OpenRouter charged for this job's calls, read by its cap meter
 * while one was counting) or Anthropic's own list price (which is the bill on Anthropic's API), and
 * where neither could be read `costSource` says "unavailable" and no number is shown, rather than one
 * being invented. The Agent SDK's own `total_cost_usd`, priced from the rounded-up table in src/llm.ts,
 * is an ESTIMATE: it is kept as an internal number for the per-run cap and for comparing one slice with
 * the next, and it is never shown to anyone.
 *
 * Privacy. An executive-assistant job works over Paul's mail and calendar, and a cv job over his
 * uploads, so nothing about their content may be recorded: for those kinds a call record keeps the
 * tool-call count but never tool names, and no record ever holds prompt, brief, output or tool input
 * text for any kind. `PRIVATE_KINDS`.
 */
import type { Provider } from "./llm.js";
import type { ModelCost, RealCost } from "./realcost.js";
import { spendDisplay, type RealSpend } from "./spend.js";
import type { JobKind } from "./store.js";

/** The role a job's calls are recorded under, which is how the report groups them. */
export type TelemetryRole = "chief" | "worker" | "engineer" | "maintainer" | "designer" | "assistant";

/**
 * Kinds whose work touches Paul's mail, calendar or uploads. Their call records keep counts and never
 * tool names, so nothing derived from a mail, calendar entry or uploaded file can appear in a figure.
 */
export const PRIVATE_KINDS: JobKind[] = ["ea", "cv"];

export function isPrivateKind(kind: JobKind): boolean {
  return PRIVATE_KINDS.includes(kind);
}

/** Which role a job's calls are recorded under. The chief's own chat turns are "chief". */
export function roleForKind(kind: JobKind): TelemetryRole {
  if (kind === "engineer" || kind === "create_agent") return "engineer";
  if (kind === "maintain") return "maintainer";
  if (kind === "design") return "designer";
  if (kind === "ea") return "assistant";
  return "worker";
}

/** The words the report uses for a role. */
export function roleLabel(role: TelemetryRole): string {
  return role === "assistant" ? "executive assistant" : role;
}

/**
 * Which figure a cost is, so nothing an estimate produced can be read as a bill:
 * "provider" (OpenRouter's own usage), "anthropic" (its own list price, the bill on Anthropic's API),
 * "estimate" (the SDK's rounded-up price table: internal only, never shown), or "unavailable" (the
 * provider cannot be read and the word is said rather than a number).
 */
export type UsageCostSource = "provider" | "anthropic" | "estimate" | "unavailable";

/**
 * Why a record has no money figure, in one plain clause. On OpenRouter the provider is asked per call
 * only while a cap is counting (src/realcost.ts), and it had published nothing these calls could be
 * read for; on Anthropic it is only a run that reports no cost at all.
 */
export const NO_PER_JOB_FIGURE = "no amount the provider itself reported could be read for these calls";

/** One model call: the numbers only, never a prompt, an output or a tool input. */
export interface ModelCall {
  /** When the reply arrived, ms since the epoch. */
  at: number;
  role: TelemetryRole;
  /** The model id the provider reported for this call. */
  model: string;
  provider: Provider;
  /** Input tokens that were not served from the cache. */
  promptTokens: number;
  /** Input tokens the provider served from the prompt cache. */
  cachedTokens: number;
  /** Input tokens written to the prompt cache by this call. */
  cacheWriteTokens: number;
  completionTokens: number;
  /** Thinking tokens, where the provider reports them, already part of `completionTokens`. */
  reasoningTokens?: number;
  /**
   * Which figure this call's cost is. No provider reports a per-call amount (OpenRouter reports one
   * figure for the whole key, Anthropic reports tokens rather than a price), so today this is always
   * "unavailable": a call record carries no cost rather than one that was worked out from a table.
   */
  costSource: UsageCostSource;
  /** The gap since the previous message the SDK produced: an upper bound on the call's own latency. */
  latencyMs?: number;
  toolCalls: number;
  /** Tool names, omitted for the kinds that touch Paul's mail, calendar or uploads. */
  tools?: string[];
}

/** A total over calls: the same numbers a call carries, summed. */
export interface UsageTotals {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
}

export function emptyTotals(): UsageTotals {
  return { calls: 0, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: 0 };
}

export function addCall(totals: UsageTotals, call: ModelCall): UsageTotals {
  totals.calls += 1;
  totals.promptTokens += call.promptTokens;
  totals.cachedTokens += call.cachedTokens;
  totals.cacheWriteTokens += call.cacheWriteTokens;
  totals.completionTokens += call.completionTokens;
  totals.reasoningTokens += call.reasoningTokens ?? 0;
  totals.toolCalls += call.toolCalls;
  return totals;
}

export function totalsOf(calls: ModelCall[]): UsageTotals {
  return calls.reduce(addCall, emptyTotals());
}

/**
 * The run's own totals as the SDK reports them, falling back to the sum of the calls when it reports
 * none. The run summary is the field meant for token accounting, so it is what a job's totals use.
 */
export function runTotals(usage: AssistantUsage | null | undefined, fallback: UsageTotals): UsageTotals {
  if (!usage) return fallback;
  const out = emptyTotals();
  out.calls = fallback.calls;
  out.promptTokens = tokens(usage.input_tokens);
  out.cachedTokens = tokens(usage.cache_read_input_tokens);
  out.cacheWriteTokens = tokens(usage.cache_creation_input_tokens);
  out.completionTokens = tokens(usage.output_tokens);
  out.reasoningTokens = tokens(usage.output_tokens_details?.thinking_tokens);
  out.toolCalls = fallback.toolCalls;
  return out;
}

/** Keeps the first `max` calls and counts the rest, so a job's record cannot grow without bound. */
export function capCalls(calls: ModelCall[], max = MAX_CALLS_PER_JOB): { calls: ModelCall[]; callsOmitted?: number } {
  if (calls.length <= max) return { calls };
  return { calls: calls.slice(0, max), callsOmitted: calls.length - max };
}

/** Sums of two totals, for grouping jobs by kind or by day. */
export function addTotals(sum: UsageTotals, add?: UsageTotals): UsageTotals {
  if (!add) return sum;
  sum.calls += add.calls;
  sum.promptTokens += add.promptTokens;
  sum.cachedTokens += add.cachedTokens;
  sum.cacheWriteTokens += add.cacheWriteTokens;
  sum.completionTokens += add.completionTokens;
  sum.reasoningTokens += add.reasoningTokens;
  sum.toolCalls += add.toolCalls;
  return sum;
}

/**
 * The share of input tokens served from the prompt cache: cached ÷ (cached + prompt). Undefined when
 * the run read no input tokens at all, so a report never divides by zero or invents a rate.
 */
export function cacheHitRate(totals: Pick<UsageTotals, "cachedTokens" | "promptTokens">): number | undefined {
  const input = totals.cachedTokens + totals.promptTokens;
  return input > 0 ? totals.cachedTokens / input : undefined;
}

/** A rate as a whole percentage. */
export function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** One model's figures within a run, as the SDK's per-model summary reports them. */
export interface ModelRunUsage {
  model: string;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  /** The SDK's own cost for this model, priced from src/llm.ts. Internal only, never shown. */
  estimateUsd?: number;
}

/** Everything recorded for one job's run. */
export interface JobUsage {
  role: TelemetryRole;
  provider: Provider;
  /** Calls the run reported, oldest first, capped at MAX_CALLS_PER_JOB. */
  calls: ModelCall[];
  /** Calls counted in `totals` but not kept, because the cap was reached. */
  callsOmitted?: number;
  totals: UsageTotals;
  /** The run's own per-model figures, which are what its totals are checked against. */
  models?: ModelRunUsage[];
  durationMs?: number;
  numTurns?: number;
  /**
   * The job's cost where a real figure exists: Anthropic's own list price when the run went to
   * Anthropic directly. On OpenRouter there is no per-job amount, so this is unset.
   */
  costUsd?: number;
  /**
   * The Agent SDK's own price for the run, from the rounded-up table in src/llm.ts. This is an
   * ESTIMATE, not a bill, and it is internal only: it is never shown to Paul, under any label, and
   * nothing that reaches him reads it. It exists so one slice of the efficiency programme can be
   * compared with the next (and so the eval runner can price a run), which is the only thing it is
   * good for. Where `costUsd` is set this is the same number.
   */
  estimateUsd?: number;
  costSource: UsageCostSource;
  /** Why there is no per-job figure, when there is none. */
  costNote?: string;
  /** The provider's own charges for this run by the model each call ran on (src/realcost.ts). */
  costByModel?: ModelCost[];
  /** The job was stopped before it finished, so these figures are partial. */
  partial?: boolean;
}

/**
 * Adds what the provider charged for one of the chief's turns to the day's record, by model, starting
 * again when the London day turns over. Only the current day is ever held.
 */
export function mergeModelCosts(held: { ymd: string; models: ModelCost[] } | undefined, ymd: string, add: ModelCost[]): { ymd: string; models: ModelCost[] } {
  const by = new Map<string, ModelCost>((held?.ymd === ymd ? held.models : []).map((m) => [m.model, { ...m }]));
  for (const m of add) {
    const row = by.get(m.model) ?? { model: m.model, usd: 0, calls: 0 };
    by.set(m.model, { model: m.model, usd: row.usd + m.usd, calls: row.calls + m.calls });
  }
  return { ymd, models: [...by.values()].sort((a, b) => b.usd - a.usd) };
}

/**
 * A usage record with the provider's own figure put in, for a run that was priced after it ended
 * (src/realcost.ts). Only ever the provider's figure: anything else leaves the record as it was.
 */
export function withRealCost(usage: JobUsage, real: RealCost): JobUsage {
  if (real.source !== "provider" || usage.provider === "anthropic") return usage;
  const { costNote: _was, ...rest } = usage;
  return { ...rest, costSource: "provider", costUsd: real.usd, ...(real.note ? { costNote: real.note } : {}), ...(real.byModel?.length ? { costByModel: real.byModel } : {}) };
}

/** Calls kept per job. Beyond this the totals keep counting and only the call list is trimmed. */
export const MAX_CALLS_PER_JOB = 500;
/** Calls kept for the chief's own chat turns in one London day. */
export const MAX_CHAT_CALLS = 200;

/** The shape of one assistant message's usage, which is all a call record needs from the SDK. */
export interface AssistantUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
}

export interface AssistantCallInput {
  at: number;
  role: TelemetryRole;
  model: string;
  provider: Provider;
  usage?: AssistantUsage | null;
  /** Tool names used in this reply. Dropped for the kinds that touch private content. */
  tools?: string[];
  latencyMs?: number;
  /** True for the kinds whose content must not be recorded: tool names are dropped. */
  private?: boolean;
}

/** Non-negative whole tokens: anything missing or nonsense counts as zero rather than as a guess. */
function tokens(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** One call record from one assistant message. Pure, so the shape can be pinned by a test. */
export function callFromAssistant(i: AssistantCallInput): ModelCall {
  const u = i.usage ?? undefined;
  const tools = i.private ? undefined : i.tools?.length ? [...i.tools] : undefined;
  const reasoning = u?.output_tokens_details?.thinking_tokens;
  const call: ModelCall = {
    at: i.at,
    role: i.role,
    model: i.model,
    provider: i.provider,
    promptTokens: tokens(u?.input_tokens),
    cachedTokens: tokens(u?.cache_read_input_tokens),
    cacheWriteTokens: tokens(u?.cache_creation_input_tokens),
    completionTokens: tokens(u?.output_tokens),
    costSource: "unavailable",
    toolCalls: i.tools?.length ?? 0,
  };
  if (typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning > 0) call.reasoningTokens = Math.round(reasoning);
  if (i.latencyMs !== undefined && Number.isFinite(i.latencyMs) && i.latencyMs >= 0) call.latencyMs = Math.round(i.latencyMs);
  if (tools) call.tools = tools;
  return call;
}

/** The per-model summary the SDK reports for a run, as agents.ts hands it over. */
export interface RawModelUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  /** The model id the provider reported, when the SDK has one, rather than the key it was asked for. */
  canonicalModel?: string;
}

/** The SDK's per-model summary of a run, keyed by model id, as a list. */
export function modelRunUsages(raw: Record<string, RawModelUsage>): ModelRunUsage[] {
  return Object.entries(raw).map(([key, u]) => {
    const out: ModelRunUsage = {
      model: u.canonicalModel ?? key,
      promptTokens: tokens(u.inputTokens),
      cachedTokens: tokens(u.cacheReadInputTokens),
      cacheWriteTokens: tokens(u.cacheCreationInputTokens),
      completionTokens: tokens(u.outputTokens),
      estimateUsd: Number.isFinite(u.costUSD) ? u.costUSD : undefined,
    };
    if (typeof u.thinkingTokens === "number" && Number.isFinite(u.thinkingTokens) && u.thinkingTokens > 0) out.reasoningTokens = Math.round(u.thinkingTokens);
    return out;
  });
}

/**
 * Collects a run's calls as they arrive, so a job interrupted by a restart keeps what it had already
 * used and a long job's figures can be written out without waiting for it to finish.
 */
export class UsageRecorder {
  private readonly kept: ModelCall[] = [];
  private omitted = 0;
  private readonly totals = emptyTotals();

  constructor(readonly maxCalls: number = MAX_CALLS_PER_JOB) {}

  add(call: ModelCall): void {
    addCall(this.totals, call);
    if (this.kept.length < this.maxCalls) this.kept.push(call);
    else this.omitted += 1;
  }

  /** True when nothing has been recorded: a fake runner in a test, or a run that made no calls. */
  get empty(): boolean {
    return this.totals.calls === 0;
  }

  calls(): ModelCall[] {
    return [...this.kept];
  }

  summary(): { calls: ModelCall[]; callsOmitted?: number; totals: UsageTotals } {
    return { calls: this.calls(), ...(this.omitted ? { callsOmitted: this.omitted } : {}), totals: { ...this.totals } };
  }
}

/** What a finished run reports about itself, which agents.ts fills in from the SDK's result. */
export interface RunUsage {
  role: TelemetryRole;
  provider: Provider;
  calls: ModelCall[];
  callsOmitted?: number;
  totals: UsageTotals;
  models?: ModelRunUsage[];
  durationMs?: number;
  numTurns?: number;
  /** The run's real cost where one exists (Anthropic's own list price). */
  costUsd?: number;
  /** The Agent SDK's own price for the run. Internal only, never shown (see JobUsage.estimateUsd). */
  estimateUsd?: number;
}

/**
 * The job's usage record from a finished run: the calls, the totals, the models, and the money that
 * can honestly be attached to it. On OpenRouter that is the provider's own per-call figures where the
 * job's cap meter read them (`realCost`, src/realcost.ts; a lower bound until the provider has priced
 * every call, and the note says so); where it read none, the record says there is no figure.
 */
export function jobUsageFromRun(run: RunUsage, o: { partial?: boolean; realCost?: RealCost } = {}): JobUsage {
  const anthropic = run.provider === "anthropic";
  const provider = !anthropic && o.realCost?.source === "provider" ? o.realCost : undefined;
  const usage: JobUsage = {
    role: run.role,
    provider: run.provider,
    calls: run.calls,
    totals: run.totals,
    costSource: anthropic && run.costUsd !== undefined ? "anthropic" : provider ? "provider" : "unavailable",
  };
  if (run.callsOmitted) usage.callsOmitted = run.callsOmitted;
  if (run.models?.length) usage.models = run.models;
  if (run.durationMs !== undefined) usage.durationMs = Math.max(0, Math.round(run.durationMs));
  if (run.numTurns !== undefined) usage.numTurns = run.numTurns;
  if (run.estimateUsd !== undefined && Number.isFinite(run.estimateUsd)) usage.estimateUsd = run.estimateUsd;
  if (usage.costSource === "anthropic") usage.costUsd = run.costUsd;
  else if (provider) {
    usage.costUsd = provider.usd;
    if (provider.note) usage.costNote = provider.note;
    if (provider.byModel?.length) usage.costByModel = provider.byModel;
  } else usage.costNote = NO_PER_JOB_FIGURE;
  if (o.partial) usage.partial = true;
  return usage;
}

/**
 * Adds one run to the chief's record for a London day, starting again when the day turns over. Only the
 * current day is ever held, so this cannot grow without bound across a long conversation.
 */
export function mergeChatUsage(
  held: { ymd: string; usage: JobUsage } | undefined,
  ymd: string,
  add: JobUsage,
): { ymd: string; usage: JobUsage } {
  const base: JobUsage =
    held && held.ymd === ymd
      ? { ...held.usage, calls: [...held.usage.calls], totals: { ...held.usage.totals } }
      : { role: "chief", provider: add.provider, calls: [], totals: emptyTotals(), costSource: "unavailable", costNote: NO_PER_JOB_FIGURE };
  addTotals(base.totals, add.totals);
  const room = Math.max(0, MAX_CHAT_CALLS - base.calls.length);
  base.calls.push(...add.calls.slice(0, room));
  const dropped = add.calls.length - Math.min(room, add.calls.length) + (add.callsOmitted ?? 0);
  if (dropped > 0) base.callsOmitted = (base.callsOmitted ?? 0) + dropped;
  if (add.models?.length) base.models = add.models;
  if (add.durationMs !== undefined) base.durationMs = (base.durationMs ?? 0) + add.durationMs;
  if (add.numTurns !== undefined) base.numTurns = (base.numTurns ?? 0) + add.numTurns;
  // An Anthropic-only deployment prices the chief's calls at list price, which is the bill; on
  // OpenRouter there is no per-job amount for the chief's turns either and the note says so.
  if (add.costSource === "anthropic" && add.costUsd !== undefined) {
    base.costUsd = (base.costUsd ?? 0) + add.costUsd;
    base.costSource = "anthropic";
    delete base.costNote;
  }
  // Internal only, never shown: it is what a later slice compares against, nothing more.
  if (add.estimateUsd !== undefined) base.estimateUsd = (base.estimateUsd ?? 0) + add.estimateUsd;
  base.provider = add.provider;
  base.role = "chief";
  return { ymd, usage: base };
}

/** The models a job's calls ran on, in the order they were first seen. */
export function modelsOf(usage: JobUsage): string[] {
  const seen: string[] = [];
  for (const m of usage.models?.map((x) => x.model) ?? []) if (m && !seen.includes(m)) seen.push(m);
  for (const c of usage.calls) if (c.model && !seen.includes(c.model)) seen.push(c.model);
  return seen;
}

/** The provider's name for a job's usage, for a report line. */
export function providerLabel(provider: Provider): string {
  return provider === "openrouter" ? "OpenRouter" : "Anthropic";
}

/**
 * One line of tokens, used by both views: counts only, so it is safe for any job.
 */
export function tokenLine(totals: UsageTotals): string {
  const rate = cacheHitRate(totals);
  const parts = [
    `${totals.calls} model call${totals.calls === 1 ? "" : "s"}`,
    `${totals.promptTokens} prompt tokens (${totals.cachedTokens} from cache, ${totals.cacheWriteTokens} written to it)`,
    `${totals.completionTokens} completion tokens${totals.reasoningTokens ? ` (${totals.reasoningTokens} reasoning)` : ""}`,
    `${totals.toolCalls} tool call${totals.toolCalls === 1 ? "" : "s"}`,
  ];
  return `${parts.join(", ")}; cache hit rate ${rate === undefined ? "not available (no input tokens counted)" : percent(rate)}.`;
}

/**
 * The cost line for one job's usage. A real figure is named as whose it is; where there is none the
 * line says so and shows nothing, so no estimate can be read as a bill.
 */
export function jobCostLine(usage: JobUsage): string {
  if (usage.costSource === "anthropic" && usage.costUsd !== undefined) return `Cost: $${usage.costUsd.toFixed(4)} (Anthropic's own list price, which is the bill there).`;
  if (usage.costSource === "provider" && usage.costUsd !== undefined) return `Cost: $${usage.costUsd.toFixed(4)} (the provider's own figure${usage.costNote ? `; ${usage.costNote}` : ""}).`;
  if (usage.costSource === "unavailable") return `Cost: no figure (${usage.costNote ?? NO_PER_JOB_FIGURE}). The Agent SDK's estimate is internal and is not shown.`;
  // "estimate" (and anything else): the SDK's rounded-up price is never a figure, so it is never shown.
  return `Cost: no figure (${usage.costNote ?? NO_PER_JOB_FIGURE}). The Agent SDK's estimate is internal and is not shown.`;
}

/** The per-job view: which job it was, who ran it, on what, and the numbers. Never a brief or an output. */
export function jobUsageLines(job: UsageJob): string[] {
  const usage = job.usage;
  const head = `Job ${job.id} (${job.kind})${job.title ? ` "${job.title}"` : ""}${job.finishedAt ? `, finished ${job.finishedAt}` : ""}`;
  if (!usage) return [`${head}: no model calls were recorded for it.`];
  const models = modelsOf(usage);
  return [
    head,
    `Role: ${roleLabel(usage.role)}. Provider: ${providerLabel(usage.provider)}. Models: ${models.join(", ") || "not reported"}.`,
    `Tokens: ${tokenLine(usage.totals)}`,
    usage.durationMs !== undefined ? `Run time: ${usage.durationMs} ms${usage.numTurns ? `, ${usage.numTurns} turns` : ""}.` : "",
    jobCostLine(usage),
    usage.callsOmitted ? `${usage.callsOmitted} further calls are counted in the totals but not kept individually.` : "",
    usage.partial ? "This job was stopped before it finished, so its figures are partial." : "",
  ].filter(Boolean);
}

/** A job as the report needs it: the numbers, plus enough to name it. */
export interface UsageJob {
  id: string;
  kind: JobKind;
  title?: string;
  finishedAt?: string;
  usage?: JobUsage;
}

/** One London day's usage, and where its money figure came from. */
export interface UsageView {
  /** The London day being reported, YYYY-MM-DD, and how to say it. */
  ymd: string;
  label: string;
  /** The provider's own figure for the day, as src/spend.ts reads it. */
  spend: RealSpend;
  /** Jobs that finished that day, with their recorded usage. */
  jobs: UsageJob[];
  /** The chief's own chat turns, when they were recorded for that day. */
  chat?: JobUsage;
}

/** The money line for a day: the provider's figure with its label, or the plain fact that there is none. */
export function dayMoneyLine(view: UsageView): string {
  const display = spendDisplay(view.spend);
  if (display.kind === "figure") return `${view.label} (${view.ymd}): $${display.usd.toFixed(2)} (${display.label}), across the jobs below.`;
  return `${view.label} (${view.ymd}): no spend figure (${display.reason}), so I cannot say what that day cost. The Agent SDK's estimate is internal and is not shown.`;
}

/** A job's tokens, in the plain shape the per-kind and top-jobs lines use. */
function jobTokens(job: UsageJob): number {
  const t = job.usage?.totals;
  return t ? t.promptTokens + t.cachedTokens + t.completionTokens : 0;
}

/**
 * The short report Paul can read in chat: tokens and cache hit rate per day (always real), the money
 * figure with the words that say whose it is, cost per kind and the top jobs by cost where those
 * amounts exist, and tokens by kind and the biggest jobs by tokens where they do not.
 */
export function usageLines(view: UsageView): string[] {
  const lines: string[] = [dayMoneyLine(view)];
  const jobs = view.jobs;
  const totals = jobs.reduce((sum, j) => addTotals(sum, j.usage?.totals), emptyTotals());
  if (view.chat) addTotals(totals, view.chat.totals);
  lines.push(`Tokens: ${tokenLine(totals)}`);
  // A real money split exists only where the provider reports per-run amounts (Anthropic's own list
  // price). On OpenRouter there is no per-job amount, so the split is by tokens and says why.
  const priced = view.spend.source === "anthropic";
  const withCost = jobs.filter((j) => j.usage?.costUsd !== undefined && j.usage.costSource === "anthropic");
  if (priced && withCost.length) {
    const by = new Map<string, number>();
    for (const j of withCost) by.set(j.kind, (by.get(j.kind) ?? 0) + (j.usage?.costUsd ?? 0));
    lines.push(`Cost per kind (Anthropic's own list price): ${[...by].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} $${c.toFixed(2)}`).join(", ")}.`);
    const top = [...withCost].sort((a, b) => (b.usage?.costUsd ?? 0) - (a.usage?.costUsd ?? 0)).slice(0, 3);
    lines.push(`Top jobs by cost: ${top.map((j) => `${j.title ?? j.id} (${j.id}) $${(j.usage?.costUsd ?? 0).toFixed(2)}`).join(", ")}.`);
  } else if (jobs.length) {
    // Honest about why: a per-job figure is the provider's own only where its cap meter read one, and
    // where it exists it can be a lower bound, so the per-kind sums would not add up to the day's one
    // figure above and are not shown. The token split is the provider's own counts.
    lines.push(
      priced
        ? "No per-kind cost: no job that day recorded a figure."
        : "No cost per kind or top jobs by cost: a job's money figure is the provider's own only where its cap meter read one, and it can miss calls, so those amounts are not summed here. The split below is by tokens, which are the provider's own counts.",
    );
  }
  const tokensByKind = new Map<string, number>();
  for (const j of jobs) tokensByKind.set(j.kind, (tokensByKind.get(j.kind) ?? 0) + jobTokens(j));
  if (jobs.length) {
    lines.push(`Tokens per kind: ${[...tokensByKind].sort((a, b) => b[1] - a[1]).map(([k, t]) => `${k} ${t}`).join(", ")}.`);
    const top = [...jobs].sort((a, b) => jobTokens(b) - jobTokens(a)).slice(0, 3).filter((j) => jobTokens(j) > 0);
    if (top.length) lines.push(`Top jobs by tokens: ${top.map((j) => `${j.title ?? j.id} (${j.id}) ${jobTokens(j)}`).join(", ")}.`);
  } else lines.push("No jobs finished that day with usage recorded.");
  if (view.chat) lines.push(`The chief's own chat turns are included: ${tokenLine(view.chat.totals)}`);
  else lines.push("The chief's own chat turns are not recorded for that day, so they are not in these figures.");
  lines.push("Tokens are the provider's own counts for each call. Money is never estimated here: where no provider figure can be read, the line says so.");
  return lines;
}

/**
 * The same report as JSON, for a later slice to diff two runs: numbers only, with the source of every
 * money figure named.
 */
export function usageJson(view: UsageView): Record<string, unknown> {
  const totals = view.jobs.reduce((sum, j) => addTotals(sum, j.usage?.totals), emptyTotals());
  if (view.chat) addTotals(totals, view.chat.totals);
  return {
    ymd: view.ymd,
    spend: { ...view.spend, source: view.spend.source },
    totals,
    cacheHitRate: cacheHitRate(totals) ?? null,
    jobs: view.jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      role: j.usage?.role ?? null,
      provider: j.usage?.provider ?? null,
      models: j.usage ? modelsOf(j.usage) : [],
      totals: j.usage?.totals ?? null,
      costUsd: j.usage?.costSource === "estimate" ? null : (j.usage?.costUsd ?? null),
      costSource: j.usage?.costSource ?? "unavailable",
      // The SDK's own price for the run. It is an ESTIMATE, internal only and never shown to Paul;
      // it is here so a later slice can compare one run of the eval with the next.
      estimateUsd: j.usage?.estimateUsd ?? null,
    })),
    chat: view.chat?.totals ?? null,
    chatEstimateUsd: view.chat?.estimateUsd ?? null,
  };
}
