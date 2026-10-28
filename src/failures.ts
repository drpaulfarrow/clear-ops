import type { RunResult } from "./agents.js";
import type { Job } from "./store.js";
import type { Messenger } from "./whatsapp.js";
import { shortText } from "./messages.js";
import { jobLabel, jobRef } from "./titles.js";

/**
 * Why a worker run produced no real work. "credit" and "auth" are account-wide: every further run
 * fails the same way until Paul fixes it, so the engineering queues are held (HOLD_KINDS).
 * "error" is anything else that threw (a crash, a failed deploy wait). The last three are jobs the
 * service stopped (STOP_KINDS): "stalled" when its worker showed no activity for too long, "timeout"
 * when it ran past the maximum runtime, "cancelled" when Paul cancelled it.
 */
export type FailureKind = "credit" | "auth" | "rate_limit" | "overloaded" | "api" | "empty" | "error" | "stalled" | "timeout" | "cancelled";

/** Jobs the service stopped rather than ones that failed on their own; their work is kept for a retry. */
export const STOP_KINDS: FailureKind[] = ["stalled", "timeout", "cancelled"];

export interface RunFailure {
  kind: FailureKind;
  /** The raw error text, for the saved output and job_status. */
  detail: string;
}

/** Failures that will hit every run until Paul acts: hold the queues rather than burn through them. */
export const HOLD_KINDS: FailureKind[] = ["credit", "auth"];

/** Thrown inside the job runner when a run ended in an API or SDK error rather than real work. */
export class RunFailedError extends Error {
  constructor(readonly failure: RunFailure) {
    super(failure.detail);
  }
}

/** The SDK's assistant-message error codes (SDKAssistantMessageError) mapped to our kinds. */
const SDK_ERROR_KINDS: Record<string, FailureKind> = {
  billing_error: "credit",
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  cloud_credential_error: "auth",
  rate_limit: "rate_limit",
  overloaded: "overloaded",
};

/** HTTP statuses from the Anthropic API mapped to our kinds. */
function statusKind(status?: number | null): FailureKind | undefined {
  if (status === 402) return "credit";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  return undefined;
}

const CREDIT = /credit balance|insufficient (?:credit|funds|balance)|billing|payment required|out of credits?/i;
const AUTH = /invalid (?:x-)?api[ -]?key|authentication|unauthori[sz]ed|permission[_ ]error|oauth token|please run \/login|not logged in|\b40[13]\b/i;
const RATE = /rate[ _-]?limit|too many requests|\b429\b/i;
const OVERLOAD = /overloaded|\b529\b/i;

/**
 * Classifies an error from the API or the SDK. The SDK's own code and the HTTP status win; otherwise
 * the text decides, and anything unrecognised is a generic API error.
 */
export function classifyError(text: string, sdkError?: string, status?: number | null): FailureKind {
  const fromSdk = sdkError ? SDK_ERROR_KINDS[sdkError] : undefined;
  if (fromSdk) return fromSdk;
  const fromStatus = statusKind(status);
  if (fromStatus) return fromStatus;
  if (CREDIT.test(text)) return "credit";
  if (AUTH.test(text)) return "auth";
  if (RATE.test(text)) return "rate_limit";
  if (OVERLOAD.test(text)) return "overloaded";
  return "api";
}

/**
 * Short texts that are an API error dressed as a result ("Credit balance is too low", "API Error: 529
 * ..."). Only short texts count, so a real report that mentions billing or rate limits is never mistaken
 * for one.
 */
const ERROR_ONLY = /^(?:credit balance is too low|api error\b|invalid api key|error:|.*\b(?:authentication_error|permission_error|rate_limit_error|overloaded_error|api_error|invalid_request_error)\b|please run \/login|not logged in)/i;

/**
 * Whether a worker's run did real work. Returns the failure when it ended in an API or SDK error, or
 * produced nothing at all; undefined when it has a report to save.
 */
export function runFailure(result: RunResult): RunFailure | undefined {
  if (result.error) return result.error;
  const text = (result.text ?? "").trim();
  if (!text) return { kind: "empty", detail: "The agent returned no output." };
  if (text.length <= 400 && ERROR_ONLY.test(text)) return { kind: classifyError(text), detail: text };
  return undefined;
}

/** The failure behind something a run threw: a recognised API error, or a generic error. */
export function failureFromError(err: unknown): RunFailure {
  if (err instanceof RunFailedError) return err.failure;
  const detail = err instanceof Error ? err.message : String(err);
  const kind = classifyError(detail);
  return { kind: kind === "api" && !/\bapi\b|anthropic/i.test(detail) ? "error" : kind, detail };
}

/** Why it failed, in plain words, to follow "because". */
export function failureReason(f: Pick<RunFailure, "kind" | "detail">): string {
  switch (f.kind) {
    case "credit":
      return "the Anthropic account is out of credit";
    case "auth":
      return "the Anthropic API key was rejected";
    case "rate_limit":
      return "the Anthropic API kept rate limiting it and the retries ran out";
    case "overloaded":
      return "the Anthropic API was overloaded and the retries ran out";
    case "empty":
      return "the agent came back with nothing";
    case "api":
      return `the Anthropic API returned an error (${shortText(f.detail, 120)})`;
    case "stalled":
      return "its worker showed no activity for too long, so it was stopped";
    case "timeout":
      return "it ran past the maximum runtime, so it was stopped";
    case "cancelled":
      return "it was cancelled";
    default:
      return `it hit an error (${shortText(f.detail, 120)})`;
  }
}

/** A few words for /jobs: "failed: out of Anthropic credit". */
export function failureLabel(kind: FailureKind | undefined): string {
  switch (kind) {
    case "credit":
      return "out of Anthropic credit";
    case "auth":
      return "Anthropic key rejected";
    case "rate_limit":
      return "rate limited";
    case "overloaded":
      return "API overloaded";
    case "empty":
      return "no output";
    case "api":
      return "API error";
    case "stalled":
      return "stalled, stopped";
    case "timeout":
      return "ran too long, stopped";
    case "cancelled":
      return "cancelled";
    default:
      return "error";
  }
}

/** What Paul does about it. `ids` are the failed jobs, for the retry command. */
export function failureAction(kind: FailureKind, ids: string[]): string {
  const retry = ids.length === 1 ? `retry ${ids[0]}` : "retry <id>";
  switch (kind) {
    case "credit":
      return "Please top up the Anthropic credit at console.anthropic.com, then send /resume and I will rerun them and restart the queue.";
    case "auth":
      return "Please check the ANTHROPIC_API_KEY in the workforce secrets is valid, then send /resume and I will rerun them and restart the queue.";
    case "rate_limit":
    case "overloaded":
      return `Nothing needed from you beyond waiting a few minutes; send ${retry} to run it again.`;
    default:
      return `Send ${retry} to run it again, or show job ${ids[0]} for the detail.`;
  }
}

interface Pending {
  to: string;
  jobs: Array<Pick<Job, "id" | "title" | "brief" | "kind" | "target" | "replyTo" | "requestedBy">>;
  failure: RunFailure;
  timer?: ReturnType<typeof setTimeout>;
}

export interface FailureNotifierOptions {
  /** How long the first failure of a kind waits for others before the message goes. Default 15 seconds. */
  batchMs?: number;
  /** After a message, how long further failures of the same kind are gathered into one follow-up. Default 15 minutes. */
  cooldownMs?: number;
}

/**
 * Tells Paul about failed jobs, one short message per burst. The first failure of a kind waits a few
 * seconds for others (a credit outage fails everything running at once) and they go as one message;
 * more of the same kind within the cooldown are gathered into a single follow-up at its end.
 * `extra` adds a sentence when the message goes (the queue hold), so it reflects the state then.
 */
export class FailureNotifier {
  private pending = new Map<string, Pending>();
  private cooling = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly batchMs: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly messenger: Messenger,
    opts: FailureNotifierOptions = {},
    private readonly extra: (kind: FailureKind) => string = () => "",
  ) {
    this.batchMs = opts.batchMs ?? 15_000;
    this.cooldownMs = opts.cooldownMs ?? 15 * 60_000;
  }

  /** Records a failed job; the message follows after the batch window or the cooldown. */
  add(job: Pick<Job, "id" | "title" | "brief" | "kind" | "target" | "replyTo" | "requestedBy">, failure: RunFailure): void {
    // One founder: batch per person and kind, whichever thread each job reported to.
    const key = `${job.requestedBy}|${failure.kind}`;
    const p = this.pending.get(key);
    if (p) {
      p.jobs.push(job);
      if ((job.replyTo ?? job.requestedBy) !== p.to) p.to = job.requestedBy;
      return;
    }
    const entry: Pending = { to: job.replyTo ?? job.requestedBy, jobs: [job], failure };
    this.pending.set(key, entry);
    // In a cooldown the cooldown's end sends it; otherwise a short batch window does.
    if (!this.cooling.has(key)) {
      entry.timer = setTimeout(() => void this.flush(key), this.batchMs);
      entry.timer.unref?.();
    }
  }

  /** Sends everything waiting now (tests, shutdown). */
  async flushAll(): Promise<void> {
    for (const t of this.cooling.values()) clearTimeout(t);
    this.cooling.clear();
    await Promise.all([...this.pending.keys()].map((k) => this.flush(k, false)));
  }

  private async flush(key: string, cool = true): Promise<void> {
    const p = this.pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(key);
      await this.messenger.send(p.to, failureText(p.jobs, p.failure, this.extra(p.failure.kind))).catch((err) => console.warn(`failure notice not sent: ${err instanceof Error ? err.message : err}`));
    }
    if (!cool) return;
    clearTimeout(this.cooling.get(key));
    if (!p) {
      this.cooling.delete(key);
      return;
    }
    // Start (or extend) the quiet period; whatever arrives in it goes in one message at its end.
    const t = setTimeout(() => {
      this.cooling.delete(key);
      if (this.pending.has(key)) void this.flush(key);
    }, this.cooldownMs);
    t.unref?.();
    this.cooling.set(key, t);
  }
}

/**
 * The message Paul gets about failed jobs: which ones, why in plain words, and what he needs to do.
 * Plain sentences, no lists, readable on a phone.
 */
export function failureText(jobs: Array<Pick<Job, "id" | "title" | "brief" | "kind" | "target">>, failure: RunFailure, extra = ""): string {
  const ids = jobs.map((j) => j.id);
  const reason = failureReason(failure);
  const head =
    jobs.length === 1
      ? `Failed: ${jobLabel(jobs[0])}. It did no work because ${reason}.`
      : `Failed: ${jobs.length} jobs did no work because ${reason}, namely ${namesList(jobs)}.`;
  return [head, extra, failureAction(failure.kind, ids)].map((s) => s.trim()).filter(Boolean).join(" ");
}

/** "A (1a2b3c), B (4d5e6f) and C (7a8b9c)", capped so a big burst stays short. */
function namesList(jobs: Array<Pick<Job, "id" | "title" | "brief" | "kind">>): string {
  const max = 6;
  const names = jobs.slice(0, max).map((j) => jobRef(j, j.id));
  const more = jobs.length - names.length;
  if (more > 0) return `${names.join(", ")} and ${more} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}
