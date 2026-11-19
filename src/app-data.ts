/**
 * What the web app under /app reads (docs/APP.md): the board, the older history and one job, as plain
 * data. Read-only by construction: nothing here writes to a job, a queue, a schedule or the store.
 *
 * It shows more than the jobs board at /jobs does, on Paul's instruction (18 Nov 2026) and behind its
 * own sign-in (src/app-auth.ts): today's spend against the cap, a job's saved trace, and what a job
 * cost. The rules those figures already live by are kept:
 *
 *  - Money is the provider's own figure or nothing. Today's spend goes through `spendDisplay`, so when
 *    OpenRouter cannot be read the app says so and shows no number; a job's cost is `realCost`, which
 *    never returns the Agent SDK's estimate.
 *  - A trace is served exactly as src/trace.ts stored it: already clipped and redacted, and names and
 *    outcomes only for the kinds that work over Paul's mail, calendar, CV and zones.
 *  - A saved output is served only where src/reports.ts would serve it (`reportFor`), so an assistant,
 *    CV or upload-derived output is not here either.
 *  - Something waiting on Paul is shown as the gate itself would show it in chat (`preview`), because
 *    since slice 3 the app is a place he approves it (src/app-approver.ts). Each item carries a
 *    fingerprint of that exact text, and the approval route refuses a tap whose fingerprint is not the
 *    current one, so what he approves is what he was shown.
 */
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { PR_KINDS, runLimits, workerSpec } from "./agents.js";
import { failureLabel } from "./failures.js";
import { boardHealth } from "./health.js";
import { describeJob, kindName, liveStep, repoLabel } from "./job-descriptions.js";
import { lockKey, parseReviewVerdicts, type JobRunner } from "./jobs.js";
import { shortText } from "./messages.js";
import { PER_JOB_MODELS, resolveModel, runRoute } from "./llm.js";
import { londonYmd } from "./london.js";
import { renderMarkdown, reportFor } from "./reports.js";
import { redact } from "./repos.js";
import { spendDisplay } from "./spend.js";
import { jobTitle } from "./titles.js";
import { PRIVATE_KINDS, readTrace, traceFigures, type TraceFigures, type TraceLine } from "./trace.js";
import { realCost } from "./worker-stats.js";
import { WEB_CONVERSATION, type WebChat } from "./web-chat.js";
import type { ProbeResult } from "./health.js";
import type { PrInfo } from "./pr-state.js";
import { liveView, type LiveView } from "./live-settings.js";
import type { JobPull, PullSummary } from "./app-pulls.js";
import type { DnsAction, Job, OutboundAction, PurchaseAction, SignupAction, Store } from "./store.js";
import type { UptimeReport } from "./uptime.js";

/** Finished jobs this recent are on the board itself; older ones are history, a page at a time. */
export const APP_RECENT_MS = 48 * 60 * 60_000;
export const APP_RECENT_MAX = 100;
export const APP_HISTORY_PAGE = 50;
/** The most trace lines one answer carries: the newest, which is what a watcher wants. */
export const APP_TRACE_LINES = 500;

export interface AppSource {
  store: Store;
  queue: Pick<JobRunner, "isHeld" | "queuePosition" | "latestStep" | "liveness" | "spendState" | "capReached">;
  uptime?: { report: () => UptimeReport };
  probes?: { snapshot: () => ProbeResult[] };
  activeWorkers?: () => number;
  /** What GitHub says of a pull request, when it has been asked (src/pr-state.ts). Never waits. */
  prState?: (url: string) => PrInfo | undefined;
  /** The pull request a job is tied to inside its own repository (src/app-pulls.ts). No network. */
  jobPull?: (job: Job) => JobPull | undefined;
  /** The open pull requests of the managed repositories, as last read from GitHub. Never waits. */
  openPulls?: () => { pulls: PullSummary[]; unread: string[]; loading: boolean };
  /** The app's threads that have anything in them, by address (src/web-chat.ts). */
  threads?: () => Map<string, { count: number; lastAt: string }>;
  /** The approval gates, for what waits on Paul as each gate itself words it. Absent: named only. */
  gates?: AppGates;
  /** Where traces are read from, for the tests. */
  traceDir?: string;
  now?: number;
}

export interface AppJob {
  id: string;
  title: string;
  kind: string;
  kindName: string;
  /** The repository alias whose queue the job belongs to, and its plain name. */
  repository: string;
  repositoryName: string;
  status: Job["status"];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  /** The model id, where the record or the live configuration says which. */
  model?: string;
  /** True when Paul pinned this job to that model. */
  modelPinned?: boolean;
  /** What the job really cost, where the store holds the provider's own figure. Never an estimate. */
  costUsd?: number;
  /** A pull request address, where the job has one. */
  pr?: string;
  /** Its thread in the app, when anything has been said there. */
  thread?: AppThreadNote;
  /** Failed: why, in a word or two. */
  failure?: string;
  /** Running: what the worker is doing this minute, in plain words. */
  now?: string;
  /** Running: whether this process has a live worker on it. */
  alive?: boolean;
  /** Queued: held by the daily cap or after a credit or key failure. */
  held?: boolean;
  /** Queued: the job it waits behind, and its place. */
  waitingBehind?: { id: string; title: string };
  queuePosition?: number;
  fixRound?: number;
  reviewOf?: string;
  /** Finished: whether it got what Paul asked for, as far as the service itself can tell. */
  outcome?: AppOutcome;
  /** Finished: the first of what the worker told Paul, for kinds that do not work over his private things. */
  said?: string;
}

/**
 * Whether a finished job got what Paul asked for (his point, 18 Nov 2026: a run that ended is not a
 * wish that was met, and the board must not show them alike). Only what the service itself holds
 * counts as evidence: a purchase it placed, an email it sent, a record it changed, an account it
 * created, a review's own verdict line. A worker saying it went well is not evidence, so where the
 * service holds none the answer is "not confirmed", never "done".
 */
export interface AppOutcome {
  state: "met" | "not_met" | "waiting" | "unconfirmed";
  /** One plain line saying what the evidence is. */
  text: string;
  /** Who says so: Paul himself, the service's own records, the worker's own report, or nobody. */
  by: "you" | "service" | "worker" | "nobody";
}

export interface AppSpend {
  /** Today's spend in dollars, only when it is the provider's own figure. */
  usd?: number;
  /** Where the figure came from, or why there is none. */
  note: string;
  capUsd?: number;
  capReached: boolean;
  /** The cap was lifted for today with /resume. */
  capLifted: boolean;
}

/** One approval gate, as far as the app reads it: what is pending, and how the gate words an item. */
interface AppGate<T> {
  pending(): T[];
  preview(a: T): string;
}
export interface AppGates {
  outbound: AppGate<OutboundAction>;
  dns: AppGate<DnsAction>;
  signup: AppGate<SignupAction>;
  purchase: AppGate<PurchaseAction>;
}

export interface AppWaiting {
  /** What kind of thing is waiting: "email", "purchase", "dns", "signup". */
  what: "email" | "purchase" | "dns" | "signup";
  id: string;
  /** One plain line naming it, with nothing of its content. */
  label: string;
  /** What Paul types in chat to approve it, until the app can do it itself. */
  command: string;
  createdAt: string;
  expiresAt: string;
  jobId?: string;
  /** The item exactly as its gate shows it in chat. Present when the gates are. */
  preview?: string;
  /** A fingerprint of that text. A decision in the app must carry it back unchanged. */
  seen?: string;
}

/** That a job or a pull request has a thread with something in it. */
export interface AppThreadNote {
  count: number;
  lastAt: string;
}

export interface AppBoard {
  generatedAt: string;
  spend: AppSpend;
  health: { level: "ok" | "warn"; headline: string; live: string };
  /** The engineering queues are held after a credit or key failure, until /resume. */
  paused: boolean;
  waiting: AppWaiting[];
  /** Running and queued jobs, then the recently finished, newest first. */
  jobs: AppJob[];
  /** Whether older finished jobs exist beyond the recent ones. */
  hasOlder: boolean;
  /** Every open pull request in the managed repositories, newest first, as GitHub lists them. */
  pulls: Array<PullSummary & { thread?: AppThreadNote }>;
  /** Repositories whose pull requests GitHub would not show, so "none open" is not claimed for them. */
  pullsUnread: string[];
  /** The list has not been read yet since the service started. */
  pullsLoading: boolean;
}

export interface AppJobDetail {
  generatedAt: string;
  job: AppJob;
  description?: string;
  more?: string;
  produced?: string;
  doneWhen?: string;
  links: Array<{ what: string; url: string }>;
  /** The job's pull request in its own repository, for the review panel. `wrote` is the repository as the worker mistyped it. */
  pull?: { repo: string; number: number; wrote?: string };
  /** The run's limits: turns, and the real-money cap when one is set. */
  limits: { maxTurns: number; budgetUsd?: number };
  trace: { lines: TraceLine[]; total: number; figures: TraceFigures };
  /** The saved output as HTML rendered by src/reports.ts, which escapes everything. */
  outputHtml?: string;
  /** What the app's buttons may do to it right now. */
  actions: AppJobActions;
  /** The jobs around it: what it reviews, and what followed it. */
  related: Array<{ id: string; title: string; kind: string; status: Job["status"]; relation: string }>;
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** How long the first line of what a worker told Paul may be on a card. */
export const APP_SAID_MAX = 220;

/** What the service holds, gathered once per answer, that says how a job's ask turned out. */
interface Evidence {
  /** Approval items by the job that prepared them. */
  acts: Map<string, Array<{ what: "purchase" | "email" | "dns" | "signup"; status: string; line: string }>>;
  /** The newest review of each engineering job, by that job's id. */
  reviews: Map<string, Job>;
}

function evidenceOf(store: Store): Evidence {
  const acts: Evidence["acts"] = new Map();
  const add = (jobId: string | undefined, what: "purchase" | "email" | "dns" | "signup", status: string, line: string) => {
    if (!jobId) return;
    acts.set(jobId, [...(acts.get(jobId) ?? []), { what, status, line }]);
  };
  for (const a of store.listPurchases()) add(a.jobId, "purchase", a.status, `${a.total} on ${a.host}`);
  for (const a of store.listOutbound()) add(a.jobId, "email", a.status, a.kind === "invite" || a.kind === "cancel_event" ? "the calendar change" : "the email");
  for (const a of store.listDns()) add(a.jobId, "dns", a.status, `the DNS change on ${a.domain}`);
  for (const a of store.listSignups()) add(a.jobId, "signup", a.status, `the account on ${a.domain}`);
  const reviews: Evidence["reviews"] = new Map();
  for (const j of store.allJobs()) {
    if (!j.reviewOf || j.status !== "done") continue;
    const seen = reviews.get(j.reviewOf);
    if (!seen || (seen.finishedAt ?? "") < (j.finishedAt ?? "")) reviews.set(j.reviewOf, j);
  }
  return { acts, reviews };
}

/** A finished review's own verdict lines, read once: a saved output does not change. */
const verdictCache = new Map<string, ReturnType<typeof parseReviewVerdicts>>();
function verdictsOf(store: Store, review: Job): ReturnType<typeof parseReviewVerdicts> {
  const key = `${review.id}:${review.finishedAt ?? ""}`;
  const cached = verdictCache.get(key);
  if (cached) return cached;
  const parsed = parseReviewVerdicts(store.readOutput(review.id) ?? "");
  if (verdictCache.size > 2000) verdictCache.clear();
  verdictCache.set(key, parsed);
  return parsed;
}

const DID: Record<"purchase" | "email" | "dns" | "signup", { done: string; not: string; none: string }> = {
  purchase: { done: "Bought", not: "Nothing was bought", none: "Nothing was bought: no purchase was put to you." },
  email: { done: "Sent", not: "Nothing was sent", none: "Nothing was sent: nothing was put to you to approve." },
  dns: { done: "Applied", not: "Nothing was changed", none: "Nothing was changed: no DNS change was put to you." },
  signup: { done: "Created", not: "No account was created", none: "No account was created: no sign-up was put to you." },
};
const STATUS_WORDS: Record<string, string> = { expired: "it expired before you approved it", declined: "you declined it", cancelled: "it was cancelled", failed: "it failed", changed: "what was shown had changed", partial: "only part of it was applied" };

/** What a job was allowed to do that only counts if it actually happened. */
function askedFor(job: Job): Array<"purchase" | "email" | "dns" | "signup"> {
  const permits = job.permits ?? [];
  return [...(permits.includes("purchase") ? (["purchase"] as const) : []), ...(permits.includes("send") ? (["email"] as const) : []), ...(permits.includes("dns") ? (["dns"] as const) : []), ...(permits.includes("signup") ? (["signup"] as const) : [])];
}

/**
 * In order of who is believed: Paul's own answer, then what the service itself did or recorded, then
 * what the worker's report says. A worker saying "met" earns no tick; a worker saying it did not get
 * there, or that it needs him, is taken at its word, because that is not a claim anyone inflates.
 */
type Github = Pick<AppSource, "prState" | "jobPull">;

function outcomeOf(store: Store, job: Job, ev: Evidence, gh: Github = {}): AppOutcome | undefined {
  if (job.status !== "done" && job.status !== "failed") return undefined;
  if (job.verdict) return job.verdict.met ? { state: "met", text: "You marked this as done.", by: "you" } : { state: "not_met", text: "You marked this as not done.", by: "you" };
  const held = recorded(store, job, ev, gh);
  if (held.state !== "unconfirmed") return { ...held, by: "service" };
  const claim = job.claimed;
  // The words of a job that works over his private things are not put on a card.
  const quiet = PRIVATE_KINDS.includes(job.kind) || !!job.docSnapshot;
  const why = claim?.detail && !quiet ? `: ${shortText(redact(claim.detail), 160)}` : ".";
  if (claim?.state === "not_met") return { state: "not_met", text: `It says it did not get there${why}`, by: "worker" };
  if (claim?.state === "needs_paul") return { state: "waiting", text: `It says it needs you${why}`, by: "worker" };
  if (claim?.state === "met") return { state: "unconfirmed", text: "It says it did what you asked. Nothing here confirms that.", by: "worker" };
  return { ...held, by: "nobody" };
}

/** What the service's own records say of a finished job, or "unconfirmed" when they say nothing. */
/** How far GitHub's clock and the service's may disagree about when a pull request was opened. */
const OWN_PR_SLACK_MS = 2 * 60_000;

/**
 * Whether a job's pull request is its own: one the service handed it to fix (a fix round), or one
 * GitHub says was opened while the job existed and before it finished. Anything else it only worked on.
 */
function ownPr(job: Job, github: PrInfo): boolean {
  if (job.fixRound) return true;
  const opened = github.openedAt ? Date.parse(github.openedAt) : NaN;
  const from = Date.parse(job.createdAt);
  const to = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  return Number.isFinite(opened) && Number.isFinite(from) && Number.isFinite(to) && opened >= from - OWN_PR_SLACK_MS && opened <= to + OWN_PR_SLACK_MS;
}

function recorded(store: Store, job: Job, ev: Evidence, gh: Github = {}): Omit<AppOutcome, "by"> {
  if (job.status === "failed") return { state: "not_met", text: `Stopped before it finished: ${failureLabel(job.failure)}.` };
  // A job that was allowed to buy, send, change DNS or sign up: the gate's own record says whether it did.
  for (const what of askedFor(job)) {
    const mine = (ev.acts.get(job.id) ?? []).filter((a) => a.what === what);
    const words = DID[what];
    const done = mine.find((a) => a.status === "executed");
    if (done) return { state: "met", text: `${words.done}: ${done.line}.` };
    const waiting = mine.find((a) => a.status === "pending" || a.status === "approved" || a.status === "executing" || a.status === "needsPaul");
    if (waiting) return { state: "waiting", text: `Waiting on you: ${waiting.line}.` };
    const last = mine[mine.length - 1];
    return { state: "not_met", text: last ? `${words.not}: ${STATUS_WORDS[last.status] ?? last.status}.` : words.none };
  }
  // A review did its job when it gave a verdict; what the verdict was belongs to the job it reviewed.
  if (job.reviewOf) {
    const verdict = verdictsOf(store, job).at(-1);
    if (!verdict) return { state: "unconfirmed", text: "The review finished without a verdict line." };
    return { state: "met", text: verdict.outcome === "merged" ? "Reviewed: merged." : verdict.outcome === "needs_founder" ? "Reviewed: left for you." : "Reviewed: asked for changes." };
  }
  // An engineering job: first what GitHub itself says of its pull request, which settles it either way
  // and is the only record of a merge Paul made himself; then its review's own verdict line. GitHub's
  // word counts for the job only when the pull request is its own. A job's `pr` is often just the first
  // pull request its report names, so a job that diagnosed or reviewed one is not done because it merged.
  if (PR_KINDS.includes(job.kind)) {
    // The address is the job's pull request in its own repository where that can be told (a worker
    // sometimes mistypes the owner), and otherwise the address as the report gave it.
    const address = gh.jobPull?.(job)?.url ?? (job.pr && PR_URL.test(job.pr) ? job.pr : undefined);
    const seen = address ? gh.prState?.(address) : undefined;
    const missing = seen?.state === "missing";
    const github = missing ? undefined : seen;
    const own = !!github && ownPr(job, github);
    if (own && github.state === "merged") return { state: "met", text: "Its pull request was merged." };
    if (own && github.state === "closed") return { state: "not_met", text: "Its pull request was closed without being merged." };
    const review = ev.reviews.get(job.id);
    const verdict = review ? verdictsOf(store, review).at(-1) : undefined;
    if (verdict?.outcome === "merged") return { state: "met", text: "Reviewed and merged." };
    // Someone else's pull request that is now settled: nothing is waiting on Paul, and nothing says this job did its part.
    if (github && github.state !== "open") return { state: "unconfirmed", text: `The pull request it worked on was ${github.state === "merged" ? "merged" : "closed without being merged"}. Nothing here confirms this job's own part.` };
    if (verdict?.outcome === "needs_founder") return { state: "waiting", text: `Reviewed and left for you${verdict.detail ? `: ${shortText(redact(verdict.detail), 140)}` : "."}` };
    if (verdict?.outcome === "changes_requested") return { state: "not_met", text: "The review asked for changes." };
    // Nothing is waiting on Paul at an address GitHub does not have.
    if (missing) return { state: "unconfirmed", text: "GitHub does not show the pull request this job names, so nothing here can check it." };
    if (job.reviewOnly && job.pr) return { state: "waiting", text: "Its pull request is open for you to review." };
    return { state: "unconfirmed", text: job.pr ? "It opened a pull request. No review verdict is recorded." : "It finished without a pull request." };
  }
  return { state: "unconfirmed", text: "The run finished. Nothing here can confirm it did what you asked." };
}

/** The first of what the worker told Paul, for kinds whose words are not about his private things. */
function saidOf(job: Job): string | undefined {
  if (!job.summary || PRIVATE_KINDS.includes(job.kind) || job.docSnapshot) return undefined;
  return shortText(redact(job.summary.replace(/\s+/g, " ").trim()), APP_SAID_MAX) || undefined;
}

/** The model a job runs or ran on, where that is actually known. A finished, unpinned job is not guessed at. */
function modelOf(job: Job): { model?: string; modelPinned?: boolean } {
  if (job.model) return { model: job.model, modelPinned: true };
  if (job.status !== "running" && job.status !== "queued") return {};
  try {
    const route = runRoute(job, workerSpec(job.kind, job.target).model);
    return { model: route.provider === "anthropic" ? `anthropic/${route.model}` : resolveModel(route.model) };
  } catch {
    return {};
  }
}

function toAppJob(source: AppSource, job: Job, ev: Evidence): AppJob {
  const repository = lockKey(job) ?? job.target ?? "product";
  const cost = realCost(job);
  const outcome = outcomeOf(source.store, job, ev, source);
  const pr = source.jobPull?.(job)?.url ?? (job.pr && PR_URL.test(job.pr) ? job.pr : undefined);
  const note = source.threads?.().get(`web:job:${job.id}`);
  const said = job.status === "done" || job.status === "failed" ? saidOf(job) : undefined;
  const base: AppJob = {
    id: job.id,
    title: jobTitle(job),
    kind: job.kind,
    kindName: kindName(job.kind),
    repository,
    repositoryName: repoLabel(repository),
    status: job.status,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.lastActivityAt ? { lastActivityAt: job.lastActivityAt } : {}),
    ...modelOf(job),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(pr ? { pr } : {}),
    ...(note ? { thread: note } : {}),
    ...(job.fixRound ? { fixRound: job.fixRound } : {}),
    ...(job.reviewOf ? { reviewOf: job.reviewOf } : {}),
    ...(outcome ? { outcome } : {}),
    ...(said ? { said } : {}),
  };
  if (job.status === "running") {
    const step = liveStep(source.queue.latestStep(job.id));
    const live = source.queue.liveness(job.id);
    return { ...base, ...(step ? { now: step } : {}), ...(live ? { alive: live.alive, ...(live.lastActivityAt ? { lastActivityAt: live.lastActivityAt } : {}) } : {}) };
  }
  if (job.status === "queued") {
    const holder = job.waitingFor && job.waitingFor !== job.id ? source.store.getJob(job.waitingFor) : undefined;
    const position = holder ? source.queue.queuePosition(job.id) : undefined;
    return {
      ...base,
      ...(source.queue.isHeld(job) || job.capBlocked ? { held: true } : {}),
      ...(holder ? { waitingBehind: { id: holder.id, title: jobTitle(holder) } } : {}),
      ...(position !== undefined ? { queuePosition: position } : {}),
    };
  }
  if (job.status === "failed") return { ...base, failure: failureLabel(job.failure) };
  return base;
}

function spendOf(source: AppSource, now: number): AppSpend {
  const display = spendDisplay(source.queue.spendState());
  const cap = config.dailyBudgetUsd;
  return {
    ...(display.kind === "figure" ? { usd: display.usd, note: display.label } : { note: `No spend figure: ${display.reason}.` }),
    ...(cap !== undefined ? { capUsd: cap } : {}),
    capReached: source.queue.capReached(),
    capLifted: source.store.capDays().liftedOn === londonYmd(new Date(now)),
  };
}

/** One line of where today's money went: an agent or a project, its jobs' own figures added up. */
export interface AppSpendGroup {
  name: string;
  usd: number;
  jobs: number;
}

/** One role on one model: what the provider charged for those calls today. */
export interface AppSpendRow {
  who: string;
  model: string;
  usd: number;
  calls: number;
}

const ROLE_WORDS: Record<string, string> = { chief: "The chief", worker: "Workers", engineer: "Engineers", maintainer: "The maintainer", designer: "The designer", assistant: "The assistant" };

export interface AppSpendPage {
  generatedAt: string;
  spend: AppSpend;
  /** Jobs that finished today and have the provider's own figure, dearest first. */
  jobs: Array<{ id: string; title: string; kind: string; who: string; repositoryName: string; costUsd: number }>;
  /** Which role spent what on which model: the provider's own charges, dearest first. */
  byAgentModel: AppSpendRow[];
  byProject: AppSpendGroup[];
  /** Those jobs' figures and the chief's own replies, added up. */
  attributedUsd: number;
  /** Today's total less that, when today's total is the provider's own: whatever has not been priced yet, and jobs still running. */
  unattributedUsd?: number;
  /** Jobs that finished today with no figure of their own. */
  withoutFigure: number;
  settings: LiveView;
}

/** How many of today's jobs the Spend page lists. */
export const APP_SPEND_JOBS = 30;

/**
 * The Spend page: today's figure, where the store can say it went, and the settings Paul may change.
 * Every amount is the provider's own or is not shown. A job's figure is its whole cost, counted on the
 * day it finished, so a job that ran over midnight is counted once, on the later day.
 */
export function appSpend(source: AppSource): AppSpendPage {
  const now = source.now ?? Date.now();
  const today = londonYmd(new Date(now));
  const spend = spendOf(source, now);
  const finished = source.store.allJobs().filter((j) => isFinished(j) && j.finishedAt && londonYmd(new Date(j.finishedAt)) === today);
  const priced = finished.flatMap((j) => {
    const usd = realCost(j);
    return usd === undefined ? [] : [{ job: j, usd }];
  });
  const group = (key: (j: Job) => string): AppSpendGroup[] => {
    const by = new Map<string, AppSpendGroup>();
    for (const { job, usd } of priced) {
      const name = key(job);
      const g = by.get(name) ?? { name, usd: 0, jobs: 0 };
      by.set(name, { name, usd: g.usd + usd, jobs: g.jobs + 1 });
    }
    return [...by.values()].sort((a, b) => b.usd - a.usd);
  };
  // Role by model. A job priced call by call says which model each charge was for; one with only a
  // total is put under the one model it ran on, or under "not recorded" when it ran on several.
  const rows = new Map<string, AppSpendRow>();
  const addRow = (who: string, model: string, usd: number, calls: number) => {
    const key = `${who}\n${model}`;
    const row = rows.get(key) ?? { who, model, usd: 0, calls: 0 };
    rows.set(key, { who, model, usd: row.usd + usd, calls: row.calls + calls });
  };
  for (const { job, usd } of priced) {
    const who = ROLE_WORDS[job.usage?.role ?? ""] ?? kindName(job.kind);
    const by = job.usage?.costByModel;
    if (by?.length) for (const m of by) addRow(who, m.model, m.usd, m.calls);
    else addRow(who, job.usage?.models?.length === 1 ? job.usage.models[0]!.model : "not recorded", usd, job.usage?.totals.calls ?? 0);
  }
  // The chief's own replies, priced after each turn.
  const chat = source.store.chatCost();
  const chief = chat?.ymd === today ? chat.models : [];
  for (const m of chief) addRow(ROLE_WORDS.chief!, m.model, m.usd, m.calls);
  const attributed = priced.reduce((n, p) => n + p.usd, 0) + chief.reduce((n, m) => n + m.usd, 0);
  return {
    generatedAt: new Date(now).toISOString(),
    spend,
    jobs: priced
      .sort((a, b) => b.usd - a.usd)
      .slice(0, APP_SPEND_JOBS)
      .map(({ job, usd }) => ({ id: job.id, title: jobTitle(job), kind: job.kind, who: kindName(job.kind), repositoryName: repoLabel(lockKey(job) ?? job.target ?? "product"), costUsd: usd })),
    byAgentModel: [...rows.values()].sort((a, b) => b.usd - a.usd),
    byProject: group((j) => repoLabel(lockKey(j) ?? j.target ?? "product")),
    attributedUsd: attributed,
    ...(spend.usd !== undefined && spend.usd >= attributed ? { unattributedUsd: spend.usd - attributed } : {}),
    withoutFigure: finished.length - priced.length,
    settings: liveView(source.store),
  };
}

/** The fingerprint a decision in the app must carry: which item, and the exact words shown for it. */
export function seenHash(what: AppWaiting["what"], id: string, preview: string): string {
  return createHash("sha256").update(`${what}\n${id}\n${preview}`).digest("hex");
}

/** What waits on Paul's own approval: worded by its gate when the gates are given, otherwise named only. */
export function appWaiting(store: Store, gates: AppGates | undefined, now: number): AppWaiting[] {
  const live = <T extends { status: string; expiresAt: string }>(items: T[]) => items.filter((a) => a.status === "pending" && Date.parse(a.expiresAt) > now);
  const shown = <T>(what: AppWaiting["what"], id: string, gate: AppGate<T> | undefined, a: T) => {
    if (!gate) return {};
    const preview = redact(gate.preview(a));
    return { preview, seen: seenHash(what, id, preview) };
  };
  const out: AppWaiting[] = [];
  for (const a of live(gates ? gates.outbound.pending() : store.listOutbound()))
    out.push({ what: "email", id: a.id, label: a.kind === "send_draft" || a.kind === "send_email" ? "An email is ready to send" : "A calendar change is ready to send", command: `send ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt, ...(a.jobId ? { jobId: a.jobId } : {}), ...shown("email", a.id, gates?.outbound, a) });
  for (const a of live(gates ? gates.purchase.pending() : store.listPurchases())) out.push({ what: "purchase", id: a.id, label: "A purchase is ready to approve", command: `buy ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt, ...shown("purchase", a.id, gates?.purchase, a) });
  for (const a of live(gates ? gates.dns.pending() : store.listDns())) out.push({ what: "dns", id: a.id, label: "A DNS change is ready to apply", command: `dns apply ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt, ...shown("dns", a.id, gates?.dns, a) });
  for (const a of live(gates ? gates.signup.pending() : store.listSignups())) out.push({ what: "signup", id: a.id, label: "A new account is ready to create", command: `signup apply ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt, ...shown("signup", a.id, gates?.signup, a) });
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Why a job cannot be run again from the app on another model, or undefined when it can. */
export function rerunRefusal(job: Job): string | undefined {
  if (job.kind === "ea") return "The executive assistant always runs on Claude, so it cannot be run on another model.";
  if (job.reviewOf || job.fixRound || job.designLoop) return "This job belongs to a review or design loop, which starts its own follow-ups.";
  if (job.origin || job.commission || job.importedRun || job.docSnapshot) return "This job was not started from your own chat, so it is not run again from here.";
  return undefined;
}

/** What Paul may do to a job from the app right now. */
export interface AppJobActions {
  /** Paul may say whether it did what he asked, and what he has said so far. */
  verdict: boolean;
  yourVerdict?: boolean;
  cancel: boolean;
  front: boolean;
  retry: boolean;
  /** The models it may be run again on; empty when it may not. */
  rerunModels: string[];
  /** It has a pull request the app can show and, when nothing blocks it, merge (src/app-pulls.ts). */
  review: boolean;
}

function actionsOf(job: Job, review: boolean): AppJobActions {
  const active = job.status === "running" || job.status === "queued";
  return {
    verdict: job.status === "done" || job.status === "failed",
    ...(job.verdict ? { yourVerdict: job.verdict.met } : {}),
    cancel: active,
    front: job.status === "queued" && !!job.waitingFor && job.waitingFor !== job.id,
    retry: job.status === "failed",
    rerunModels: rerunRefusal(job) ? [] : [...PER_JOB_MODELS],
    review,
  };
}

const finishedDesc = (a: Job, b: Job) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt);
const isFinished = (j: Job) => j.status === "done" || j.status === "failed";

/** The board: everything active, what waits on Paul, and the recently finished. */
export function appBoard(source: AppSource): AppBoard {
  const now = source.now ?? Date.now();
  const all = source.store.allJobs();
  const running = all.filter((j) => j.status === "running").sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));
  const queued = all.filter((j) => j.status === "queued").sort((a, b) => (a.queuePos ?? Number.MAX_SAFE_INTEGER) - (b.queuePos ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt));
  const finished = all.filter(isFinished).sort(finishedDesc);
  const recent = finished.filter((j) => now - Date.parse(j.finishedAt ?? j.createdAt) <= APP_RECENT_MS).slice(0, APP_RECENT_MAX);
  const ev = evidenceOf(source.store);
  const open = source.openPulls?.() ?? { pulls: [], unread: [], loading: false };
  const threads = source.threads?.();
  const health = boardHealth({ store: source.store, uptime: source.uptime, probes: source.probes, activeWorkers: source.activeWorkers, liveness: (id) => source.queue.liveness(id), now });
  return {
    generatedAt: new Date(now).toISOString(),
    spend: spendOf(source, now),
    health: { level: health.level, headline: health.headline, live: health.live },
    paused: !!source.store.queueHold(),
    waiting: appWaiting(source.store, source.gates, now),
    jobs: [...running, ...queued, ...recent].map((j) => toAppJob(source, j, ev)),
    hasOlder: finished.length > recent.length,
    pulls: open.pulls.map((p) => {
      const note = threads?.get(`web:pull:${p.repo}:${p.number}`);
      return note ? { ...p, thread: note } : p;
    }),
    pullsUnread: open.unread,
    pullsLoading: open.loading,
  };
}

/** Finished jobs older than a moment, newest first, a page at a time: the whole history is reachable. */
export function appHistory(source: AppSource, before: string | undefined, limit = APP_HISTORY_PAGE): { jobs: AppJob[]; next?: string } {
  const cutoff = before && !Number.isNaN(Date.parse(before)) ? before : new Date(source.now ?? Date.now()).toISOString();
  const older = source.store
    .allJobs()
    .filter(isFinished)
    .filter((j) => (j.finishedAt ?? j.createdAt) < cutoff)
    .sort(finishedDesc);
  const page = older.slice(0, Math.max(1, Math.min(limit, APP_HISTORY_PAGE)));
  const last = page[page.length - 1];
  const ev = evidenceOf(source.store);
  return { jobs: page.map((j) => toAppJob(source, j, ev)), ...(older.length > page.length && last ? { next: last.finishedAt ?? last.createdAt } : {}) };
}

export interface AppChatMessage {
  id: string;
  at: string;
  from: "paul" | "clearops";
  /** Paul's own words, shown as text. */
  text?: string;
  /** What the service said, rendered and escaped by src/reports.ts. */
  html?: string;
  /** The chief's status line while it works. Plain text. */
  live?: true;
}

export interface AppChat {
  generatedAt: string;
  messages: AppChatMessage[];
  /** The chief is working on a reply. */
  typing: boolean;
  /** The jobs started from this conversation, newest last, so the app can show each as a live card. */
  jobs: AppJob[];
}

/** How many of the conversation's jobs ride along with the chat. */
export const APP_CHAT_JOBS = 40;

/** One of the app's conversations with the chief (the main one, or a thread), and the jobs it started. */
export function appChat(source: AppSource, chat: Pick<WebChat, "view">, conversation: string = WEB_CONVERSATION): AppChat {
  const now = source.now ?? Date.now();
  const view = chat.view(conversation);
  const ev = evidenceOf(source.store);
  const jobs = source.store
    .allJobs()
    .filter((j) => (j.replyTo ?? j.requestedBy) === conversation)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-APP_CHAT_JOBS);
  return {
    generatedAt: new Date(now).toISOString(),
    messages: view.messages.map((m) =>
      m.from === "paul" || m.live ? { id: m.id, at: m.at, from: m.from, text: m.text, ...(m.live ? { live: true as const } : {}) } : { id: m.id, at: m.at, from: m.from, html: renderMarkdown(m.text) },
    ),
    typing: view.typing,
    jobs: jobs.map((j) => toAppJob(source, j, ev)),
  };
}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One job in full: what it is, how it is going, its trace and what it produced. */
export function appJob(source: AppSource, id: string): AppJobDetail | undefined {
  if (!JOB_ID.test(id)) return undefined;
  const job = source.store.getJob(id);
  if (!job) return undefined;
  const now = source.now ?? Date.now();
  const app = toAppJob(source, job, evidenceOf(source.store));
  const links = app.pr ? [{ what: "pull request", url: app.pr }] : [];
  const pull = source.jobPull?.(job);
  const described = describeJob(job, { hasPullRequest: !!app.pr }, app.repository);
  const limits = runLimits(job.kind, job.depth);
  const lines = readTrace(job.id, source.traceDir);
  const report = reportFor(source.store, job.id);
  const related: AppJobDetail["related"] = [];
  const add = (j: Job | undefined, relation: string) => j && related.push({ id: j.id, title: jobTitle(j), kind: j.kind, status: j.status, relation });
  if (job.reviewOf) add(source.store.getJob(job.reviewOf), "reviews");
  for (const other of source.store.allJobs()) if (other.reviewOf === job.id) add(other, "reviewed by");
  return {
    generatedAt: new Date(now).toISOString(),
    job: app,
    ...(described.description ? { description: described.description } : {}),
    ...(described.more ? { more: described.more } : {}),
    ...(described.produced ? { produced: described.produced } : {}),
    ...(job.doneWhen && PR_KINDS.includes(job.kind) ? { doneWhen: redact(job.doneWhen) } : {}),
    links,
    limits: { maxTurns: limits.maxTurns, ...(limits.realBudgetUsd !== undefined ? { budgetUsd: limits.realBudgetUsd } : {}) },
    trace: { lines: lines.slice(-APP_TRACE_LINES), total: lines.length, figures: traceFigures(lines) },
    ...(report?.markdown !== undefined ? { outputHtml: renderMarkdown(report.markdown) } : {}),
    actions: actionsOf(job, !!pull),
    ...(pull ? { pull: { repo: pull.repo, number: pull.number, ...(pull.wrote ? { wrote: pull.wrote } : {}) } } : {}),
    related,
  };
}
