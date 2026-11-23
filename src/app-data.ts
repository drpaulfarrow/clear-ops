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
 *    The one figure that is not a job's own is what finished jobs of its kind usually cost on its model
 *    (src/estimates.ts): worked out from those provider figures alone, sent apart from any cost
 *    (`usual`), and shown only as an estimate.
 *  - A trace is served exactly as src/trace.ts stored it: already clipped and redacted, and names and
 *    outcomes only for the kinds that work over Paul's mail, calendar, CV and zones.
 *  - A saved output is served where src/reports.ts would serve it, so an assistant's or a CV output is
 *    not here either. The one thing more is a report made from a file Paul uploaded (`appReportFor`):
 *    the app is behind his own sign-in and its chat already prints it on `show job`, so it is shown
 *    here, marked private, and still has no report link and no copy in the outputs repository.
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
import { describeJob, kindDoes, kindName, liveStep, repoLabel } from "./job-descriptions.js";
import { lockKey, parseReviewVerdicts, samePr, type JobRunner } from "./jobs.js";
import { AGENT_NAMES, plainStop, REPORT_POINTER, shortText, stoppedEarly, stoppedEarlyWords } from "./messages.js";
import { PER_JOB_MODELS, resolveModel, runRoute } from "./llm.js";
import { londonYmd } from "./london.js";
import { appReportFor, renderMarkdown } from "./reports.js";
import { redact, repoRegistry } from "./repos.js";
import { spendDisplay } from "./spend.js";
import { jobTitle } from "./titles.js";
import { PRIVATE_KINDS, readTrace, traceFigures, type TraceFigures, type TraceLine } from "./trace.js";
import { boardEfficiency, realCost, STATS_WINDOWS } from "./worker-stats.js";
import { costEstimates, estimateFor, type CostEstimate } from "./estimates.js";
import { inOwnSpace, ownSpaceAddress, SPACE_NOTES_MAX, type OwnSpace } from "./spaces.js";
import { WEB_CONVERSATION, type WebChat, type WebMessage } from "./web-chat.js";
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

/** The voice of ClearOps in the app (src/web-voice.ts). She has no jobs of her own: she hands what is asked to the chief. */
export const CLEO = "Cleo";

export interface AppSource {
  store: Store;
  queue: Pick<JobRunner, "isHeld" | "queuePosition" | "latestStep" | "liveness" | "spendState" | "capReached"> & Partial<Pick<JobRunner, "draining">> & { plans?: Pick<JobRunner["plans"], "view"> };
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
  threads?: () => Map<string, { count: number; lastAt: string; saidAt?: string }>;
  /** Whether Cleo can be talked to from the app just now. */
  voice?: () => boolean;
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
  /**
   * For a job waiting or running with no figure of its own yet: what finished jobs of its kind on its
   * model usually cost (the middle, and the range the middle half fell in), and how many that is from.
   * An estimate from history, shown as one; never this job's cost.
   */
  usual?: { usd: number; lowUsd: number; highUsd: number; jobs: number };
  /** A pull request address, where the job has one. */
  pr?: string;
  /** The space of Paul's own whose chat it was started from, where it was. */
  space?: string;
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
  /** A deploy is draining the queues: new jobs wait until it has restarted the service. When the drain ends. */
  deploying?: string;
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
  /** Whether Cleo can be talked to from the app just now (src/web-voice.ts): voice is switched on and can be transcribed. */
  voice: boolean;
  /** The project spaces: one per managed repository, made automatically. */
  spaces: AppSpace[];
  /** Who is on shift and what each is doing this minute. */
  roster: AppRosterEntry[];
  /** The plans the service is running to completion (src/plans.ts): every open one and those that finished in the last day. */
  plans: AppPlan[];
}

/** A plan on the board: where it is, why it is not moving if it is not, and the repository it builds in. */
export type AppPlan = import("./plans.js").PlanView & { repository: string; repositoryName: string };

/**
 * A project space. For now a space is a managed repository and nothing more: its id is the alias its
 * jobs are queued under, so "the jobs in a space" is exactly "the jobs on that repository".
 */
export interface AppSpace {
  id: string;
  name: string;
  /** Jobs running or queued there now. */
  active: number;
  /** Finished jobs there that the board shows as waiting on Paul. */
  waiting: number;
  /** It has a chat of its own (`web:space:<id>`): a repository ClearOps manages, or a space of Paul's own. */
  managed: boolean;
  /** One of Paul's own (src/spaces.ts), with the repositories he put in it. Its jobs are theirs and any started from its chat. */
  own?: true;
  repos?: string[];
  /** When the service last said something in that chat, so the app can mark it as having something new. */
  saidAt?: string;
}

/**
 * One line of the roster: the chief, each named worker, and any other kind that has work in hand. It is
 * read off the same job cards the board shows, so it can never say something the board does not.
 */
export interface AppRosterEntry {
  kind: string;
  /** The worker's name, for the kinds that have one (`AGENT_NAMES`). */
  name?: string;
  role: string;
  state: "here" | "working" | "stuck" | "waiting" | "held" | "queued" | "idle";
  line: string;
  /** The job the line is about, when it is about one. */
  jobId?: string;
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
  /** The report was made from a file Paul uploaded: it is shown in the app only, and has no report link and no copy in the outputs repository. */
  outputPrivate?: "upload";
  /** Set when the job is recorded as done but wrote no report: why, and what to do, in place of `outputHtml`. */
  noReport?: string;
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
  /** What each kind of job usually costs on each model, from finished jobs' real figures (src/estimates.ts). */
  estimates: CostEstimate[];
  /** Paul's own spaces (src/spaces.ts). */
  spaces: OwnSpace[];
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
  return { acts, reviews, estimates: costEstimates(store.allJobs()), spaces: store.spaces() };
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
  // Recorded as done with nothing but the line saying it was stopped (a job from before 20 Nov 2026
  // that ran out of turns): it wrote no report, so it did not do what was asked, whatever its status says.
  const stopped = wroteNothing(job);
  if (stopped) return { state: "not_met", text: `${stoppedEarlyWords(stopped)} There is nothing to read; run it again to get one.` };
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

/**
 * Why a job that is recorded as done has no report: its whole output is the line saying the run was
 * stopped. Undefined for a job with a real report, and for one that is not done.
 */
function wroteNothing(job: Job): string | undefined {
  return job.status === "done" ? stoppedEarly(job.summary) : undefined;
}

/** The first of what the worker told Paul, for kinds whose words are not about his private things. */
function saidOf(job: Job): string | undefined {
  if (!job.summary || PRIVATE_KINDS.includes(job.kind) || job.docSnapshot) return undefined;
  // The stop line is the service's, not the worker's, and the outcome already says it in plain words.
  if (wroteNothing(job)) return undefined;
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
  // Started from the chat of one of his own spaces: it belongs there whatever repository it is on.
  const started = ev.spaces.find((sp) => (job.replyTo ?? job.requestedBy) === ownSpaceAddress(sp.id));
  const said = job.status === "done" || job.status === "failed" ? saidOf(job) : undefined;
  // What jobs like it usually cost, only while it has no figure of its own and its model is known.
  const usual = cost === undefined && (job.status === "queued" || job.status === "running") ? estimateFor(ev.estimates, job, modelOf(job).model) : undefined;
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
    ...(usual ? { usual: { usd: usual.usd, lowUsd: usual.lowUsd, highUsd: usual.highUsd, jobs: usual.jobs } } : {}),
    ...(pr ? { pr } : {}),
    ...(started ? { space: started.id } : {}),
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
  /** What each kind of job usually costs on each model, from finished jobs' real figures; the dearest first. */
  usual: Array<CostEstimate & { who: string }>;
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
    usual: costEstimates(source.store.allJobs()).map((e) => {
      const who = e.kind === "research, deep" ? `${kindName("research")} (deep)` : kindName(e.kind);
      return { ...e, who: who.charAt(0).toUpperCase() + who.slice(1) };
    }),
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
  /** What a job of this kind usually costs on each of those models, where enough have finished to say. */
  rerunUsual?: Array<{ model: string; usd: number; jobs: number }>;
  /** It has a pull request the app can show and, when nothing blocks it, merge (src/app-pulls.ts). */
  review: boolean;
}

function actionsOf(job: Job, review: boolean, estimates: readonly CostEstimate[] = []): AppJobActions {
  const active = job.status === "running" || job.status === "queued";
  const models = rerunRefusal(job) ? [] : [...PER_JOB_MODELS];
  const usual = models.flatMap((model) => {
    const e = estimateFor(estimates, job, model);
    return e ? [{ model, usd: e.usd, jobs: e.jobs }] : [];
  });
  return {
    verdict: job.status === "done" || job.status === "failed",
    ...(job.verdict ? { yourVerdict: job.verdict.met } : {}),
    cancel: active,
    front: job.status === "queued" && !!job.waitingFor && job.waitingFor !== job.id,
    retry: job.status === "failed",
    rerunModels: models,
    ...(usual.length ? { rerunUsual: usual } : {}),
    review,
  };
}

const finishedDesc = (a: Job, b: Job) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt);
const isFinished = (j: Job) => j.status === "done" || j.status === "failed";

/** The board: everything active, what waits on Paul, and the recently finished. */
/** The spaces: every managed repository that has an address, then any other a card on the board belongs to. */
function spacesOf(jobs: readonly AppJob[], pulls: ReadonlyArray<{ repo: string }>, threads?: Map<string, { saidAt?: string }>, own: readonly OwnSpace[] = []): AppSpace[] {
  const managed = new Set(repoRegistry.aliases());
  const ids = repoRegistry.list().filter((r) => r.slug).map((r) => r.alias);
  for (const id of [...jobs.map((j) => j.repository), ...pulls.map((p) => p.repo)]) if (!ids.includes(id)) ids.push(id);
  const counts = (mine: readonly AppJob[], id: string) => ({
    active: mine.filter((j) => j.status === "running" || j.status === "queued").length,
    waiting: mine.filter((j) => j.outcome?.state === "waiting").length,
    ...(threads?.get(`web:space:${id}`)?.saidAt ? { saidAt: threads.get(`web:space:${id}`)!.saidAt } : {}),
  });
  return [
    ...ids.map((id) => ({ id, name: repoLabel(id), managed: managed.has(id), ...counts(jobs.filter((j) => j.repository === id), id) })),
    // His own, after the repositories': the jobs on their repositories, and any started from their chat.
    ...own.map((sp) => ({ id: sp.id, name: sp.name, managed: true, own: true as const, repos: [...sp.repos], ...counts(jobs.filter((j) => sp.repos.includes(j.repository) || j.space === sp.id), sp.id) })),
  ];
}

/** The workers that are always on the roster, in the order Paul meets them. */
const ROSTER_KINDS = ["engineer", "maintain", "research", "design"] as const;

function rosterOf(jobs: readonly AppJob[], capReached: boolean): AppRosterEntry[] {
  const names: Record<string, string> = AGENT_NAMES;
  const number = (j: AppJob) => /\/pull\/(\d+)$/.exec(j.pr ?? "")?.[1];
  const what = (j: AppJob) => (number(j) ? `#${number(j)}` : j.title);
  const waiting = jobs.filter((j) => j.outcome?.state === "waiting");
  // A change that was reviewed and left for Paul is the maintainer's hand-off, not the engineer's wait.
  const reviewed = new Set(jobs.filter((j) => j.kind === "maintain" && j.reviewOf).map((j) => j.reviewOf));
  const entry = (kind: string): AppRosterEntry => {
    const base = { kind, ...(names[kind] ? { name: names[kind] } : {}), role: kindName(kind) };
    const mine = jobs.filter((j) => j.kind === kind);
    const running = mine.filter((j) => j.status === "running");
    if (running.length) {
      const quiet = running.find((j) => j.alive === false);
      const j = quiet ?? running[0]!;
      const more = running.length > 1 ? ` and ${running.length - 1} more` : "";
      if (quiet) return { ...base, state: "stuck", line: `Gone quiet on ${what(j)}`, jobId: j.id };
      return { ...base, state: "working", line: `${kind === "engineer" ? "Building" : kind === "maintain" ? "Reviewing" : "Working on"} ${what(j)}${more}`, jobId: j.id };
    }
    const handed = kind === "maintain" ? waiting.find((j) => reviewed.has(j.id)) : waiting.find((j) => j.kind === kind && !reviewed.has(j.id));
    if (handed) return { ...base, state: "waiting", line: `Waiting on you: ${what(handed)}`, jobId: handed.id };
    const queued = mine.filter((j) => j.status === "queued");
    const next = queued.find((j) => !j.held) ?? queued[0];
    if (next?.held) return { ...base, state: "held", line: capReached ? "Held by the cap" : "Held until the queue is resumed", jobId: next.id };
    if (next) return { ...base, state: "queued", line: `Next up: ${next.title}`, jobId: next.id };
    return { ...base, state: "idle", line: "Idle" };
  };
  const busy = [...new Set(jobs.filter((j) => j.status === "running" || j.status === "queued").map((j) => j.kind))].filter((k) => !(ROSTER_KINDS as readonly string[]).includes(k));
  return [{ kind: "chief", name: AGENT_NAMES.chief, role: "chief", state: "here", line: "With you" }, ...[...ROSTER_KINDS, ...busy].map(entry)];
}

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
  const jobs = [...running, ...queued, ...recent].map((j) => toAppJob(source, j, ev));
  const spend = spendOf(source, now);
  return {
    generatedAt: new Date(now).toISOString(),
    spend,
    health: { level: health.level, headline: health.headline, live: health.live },
    paused: !!source.store.queueHold(),
    ...(source.queue.draining?.() ? { deploying: source.queue.draining!() } : {}),
    waiting: appWaiting(source.store, source.gates, now),
    jobs,
    voice: !!source.voice?.(),
    spaces: spacesOf(jobs, open.pulls, threads, ev.spaces),
    // Cleo is on shift only when she can actually be talked to.
    roster: [...rosterOf(jobs, spend.capReached), ...(source.voice?.() ? [{ kind: "voice", name: CLEO, role: "voice", state: "here" as const, line: "Ready to talk" }] : [])],
    hasOlder: finished.length > recent.length,
    pulls: open.pulls.map((p) => {
      const note = threads?.get(`web:pull:${p.repo}:${p.number}`);
      return note ? { ...p, thread: note } : p;
    }),
    pullsUnread: open.unread,
    pullsLoading: open.loading,
    plans: (source.queue.plans?.view() ?? []).map((p) => ({ ...p, repository: p.target, repositoryName: repoLabel(p.target) })),
  };
}

/** Finished jobs older than a moment, newest first, a page at a time: the whole history is reachable. */
export function appHistory(source: AppSource, before: string | undefined, limit = APP_HISTORY_PAGE, space?: string): { jobs: AppJob[]; next?: string } {
  const cutoff = before && !Number.isNaN(Date.parse(before)) ? before : new Date(source.now ?? Date.now()).toISOString();
  const mine = space ? source.store.spaces().find((sp) => sp.id === space) : undefined;
  const older = source.store
    .allJobs()
    .filter(isFinished)
    // One space's history: the same rule a card's own repository is worked out by, or for one of his own
    // spaces the rule its board goes by.
    .filter((j) => !space || (mine ? inOwnSpace(mine, j, lockKey(j) ?? j.target ?? "product") : (lockKey(j) ?? j.target ?? "product") === space))
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
  /** The names of the files Paul sent with it. */
  files?: string[];
  /** What was heard in the voice note(s) he sent with it. Empty: they could not be transcribed. Absent: none, or not transcribed yet. */
  heard?: string;
  /** He said it to Cleo, and she asked the chief for him. */
  via?: "cleo";
  /** A picture the service sent with it: the name the app asks its picture route for, and the caption as plain words for its description. */
  picture?: string;
  caption?: string;
  /** The job whose report this message announces, so the app links straight to it. `missing`: the job wrote none, so the app says so. */
  report?: { job: string; title: string; missing?: true };
}

export interface AppChat {
  generatedAt: string;
  messages: AppChatMessage[];
  /** The chief is working on a reply. */
  typing: boolean;
  /** The jobs started from this conversation, newest last, so the app can show each as a live card. */
  jobs: AppJob[];
  /** Paul's own chats beside the main one, the one spoken in most recently first. */
  chats: Array<{ id: string; title: string; count: number; lastAt: string; saidAt?: string }>;
  /** When the service last spoke in the main conversation and in each chat (`saidAt`), so the app can mark what has something new. */
  mainSaidAt?: string;
}

/** How many of the conversation's jobs ride along with the chat. */
export const APP_CHAT_JOBS = 40;

/** One of the app's conversations with the chief (the main one, or a thread), and the jobs it started. */
/**
 * Whether a finished job has a report the app would show (`appReportFor`: saved, and not withheld from the app),
 * remembered per job. A chat is read every few seconds and a finished job's output does not change, so
 * the file is read once per finish and not on every read of the chat. Nothing is written anywhere.
 */
const reportKnown = new WeakMap<Store, Map<string, { at: string; has: boolean }>>();
function hasReport(store: Store, job: Job): boolean {
  if (job.status !== "done") return false;
  const known = reportKnown.get(store) ?? new Map<string, { at: string; has: boolean }>();
  reportKnown.set(store, known);
  const at = job.finishedAt ?? "";
  const kept = known.get(job.id);
  if (kept?.at === at) return kept.has;
  if (known.size > 500) known.clear();
  const has = appReportFor(store, job.id) !== undefined;
  known.set(job.id, { at, has });
  return has;
}

/**
 * One message from the service, for the app. A finished job's message ends by saying where its report
 * is, as a command to type (`reportPointer`). The app can do better than that: when the job is one the
 * store holds, the sentence is taken off and the message carries the job, so the app shows a link that
 * opens the report. A job the store does not hold leaves the words as they were.
 */
function said(source: AppSource, m: WebMessage): AppChatMessage {
  const pointed = REPORT_POINTER.exec(m.text);
  const job = pointed ? source.store.getJob(pointed[1]!) : undefined;
  // A job recorded as done that wrote nothing (an older one that ran out of turns): there is no report,
  // and the app says so with the way to the job's page. Otherwise the link is offered only for a report
  // the app would show. A job whose output is withheld or gone keeps the sentence exactly as it was sent.
  const stopped = job ? wroteNothing(job) : undefined;
  const linked = !!job && (!!stopped || hasReport(source.store, job));
  // The run's own stop line ("The agent stopped early (error_max_turns).") is said in plain words here.
  const text = plainStop(linked ? m.text.slice(0, pointed!.index) : m.text);
  return { id: m.id, at: m.at, from: m.from, html: renderMarkdown(text), ...(m.picture ? { picture: m.picture, caption: m.text } : {}), ...(linked ? { report: { job: job!.id, title: jobTitle(job!), ...(stopped ? { missing: true as const } : {}) } } : {}) };
}

export function appChat(source: AppSource, chat: Pick<WebChat, "view"> & Partial<Pick<WebChat, "ownChats" | "mainSaidAt">>, conversation: string = WEB_CONVERSATION): AppChat {
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
      // His own words and the chief's status line are plain text; what the service wrote is rendered.
      // What was said aloud with Cleo is not here: that is her own conversation (`appCleo`).
      m.from === "paul" || m.live ? { id: m.id, at: m.at, from: m.from, text: m.text, ...(m.live ? { live: true as const } : {}), ...(m.via ? { via: m.via } : {}), ...(m.files?.length ? { files: m.files } : {}), ...(m.heard !== undefined ? { heard: m.heard } : {}) } : said(source, m),
    ),
    typing: view.typing,
    jobs: jobs.map((j) => toAppJob(source, j, ev)),
    // Paul's own chats, for the list he switches between: the same whichever conversation was asked for.
    chats: (chat.ownChats?.() ?? []).map((c) => ({ id: c.id, title: c.title, count: c.count, lastAt: c.lastAt, ...(c.saidAt ? { saidAt: c.saidAt } : {}) })),
    ...(chat.mainSaidAt?.() ? { mainSaidAt: chat.mainSaidAt() } : {}),
  };
}

/* ---------- A pull request: what the maintainer said of it, and whether a fix is under way ---------- */

/** How many of the newest finished reviews are looked through for a verdict on one pull request. */
export const APP_PULL_REVIEWS = 40;

export interface AppPullWatch {
  /**
   * The maintainer's latest verdict on this pull request that is not "merged": it asked for changes,
   * or left it for Paul. So the page says so above the Merge button, where on 21 Nov 2026 it said
   * nothing and two pull requests were merged minutes after changes were asked for.
   */
  review?: { verdict: "changes_requested" | "needs_founder"; by: string; detail?: string; job: string; at: string };
  /** A fix round on this pull request that is queued or running now. Merging takes the version before it. */
  fixing?: { by: string; job: string; round: number; running: boolean };
}

/**
 * What the service's own records say of one pull request, beside what GitHub says of it. Read-only.
 * A review covers the pull request it was started for and any other open one it looked at, so every
 * recent review's verdict lines are read, and a line counts when it names this pull request: by its
 * full address in this repository, or by number in a review that ran in this repository.
 */
export function appPullWatch(source: AppSource, pull: { repo: string; repository: string; number: number }): AppPullWatch {
  const here = (j: Job) => (lockKey(j) ?? j.target ?? "product") === pull.repo;
  const names = (ref: string, j: Job): boolean => {
    const full = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref);
    if (full) return full[1]!.toLowerCase() === pull.repository.toLowerCase() && Number(full[2]) === pull.number;
    return here(j) && samePr(ref, `#${pull.number}`);
  };
  const out: AppPullWatch = {};
  const reviews = source.store
    .allJobs()
    .filter((j) => j.kind === "maintain" && j.status === "done" && j.finishedAt)
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, APP_PULL_REVIEWS);
  for (const j of reviews) {
    const verdict = verdictsOf(source.store, j).filter((v) => names(v.pr, j)).at(-1);
    if (!verdict) continue;
    // The newest word on it is the one that stands: a later "merged" means there is nothing to warn of.
    if (verdict.outcome !== "merged") out.review = { verdict: verdict.outcome, by: AGENT_NAMES.maintain, ...(verdict.detail ? { detail: shortText(redact(verdict.detail), 300) } : {}), job: j.id, at: j.finishedAt! };
    break;
  }
  const fix = source.store
    .allJobs()
    .filter((j) => j.kind === "engineer" && (j.status === "running" || j.status === "queued") && !!j.fixRound && !!j.pr && names(j.pr, j))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (fix) out.fixing = { by: AGENT_NAMES.engineer, job: fix.id, round: fix.fixRound!, running: fix.status === "running" };
  return out;
}

/* ---------- One space: Paul's notes for it, and its library ---------- */

export const APP_SPACE_REPORTS = 50;
export const APP_SPACE_FILES = 50;
/** How many of a space's newest finished jobs are looked at for a report. */
export const APP_SPACE_SCANNED = 300;

export interface AppSpacePage {
  generatedAt: string;
  id: string;
  name: string;
  own?: true;
  /** For one of his own: the repositories he put in it, by name. */
  repositories?: string[];
  /** His own notes for the space, as he wrote them. */
  notes?: { text: string; updatedAt: string };
  notesMax: number;
  /** The reports of the space's jobs, newest first: only ones the app would show (`appReportFor`). */
  reports: Array<{ id: string; title: string; kind: string; who: string; at: string }>;
  moreReports: boolean;
  /** The names of the files he sent in the space's chat, newest first. The files themselves are not served. */
  files: Array<{ name: string; at: string }>;
  moreFiles: boolean;
}

/** One space's page, for a repository the service manages or a space of Paul's own; anything else is no space. */
export function appSpace(source: AppSource, chat: Pick<WebChat, "kept">, id: string): AppSpacePage | undefined {
  const own = source.store.spaces().find((sp) => sp.id === id);
  const repo = own ? undefined : repoRegistry.list().find((r) => r.alias === id);
  if (!own && !repo) return undefined;
  const now = source.now ?? Date.now();
  const within = (j: Job) => (own ? inOwnSpace(own, j, lockKey(j) ?? j.target ?? "product") : (lockKey(j) ?? j.target ?? "product") === id);
  // Newest first, and only as far as it takes to fill the list: a report is a file on disk.
  const withReport: Job[] = [];
  for (const j of source.store.allJobs().filter((x) => x.status === "done" && within(x)).sort(finishedDesc).slice(0, APP_SPACE_SCANNED)) {
    if (withReport.length > APP_SPACE_REPORTS) break;
    if (hasReport(source.store, j)) withReport.push(j);
  }
  const address = ownSpaceAddress(id);
  const sent = chat
    .kept()
    .filter((m) => m.thread === address && m.from === "paul" && m.files?.length)
    .reverse()
    .flatMap((m) => m.files!.map((name) => ({ name, at: m.at })));
  const notes = source.store.spaceNote(id);
  return {
    generatedAt: new Date(now).toISOString(),
    id,
    name: own ? own.name : repoLabel(id),
    ...(own ? { own: true as const, repositories: own.repos.map((r) => repoLabel(r)) } : {}),
    ...(notes ? { notes } : {}),
    notesMax: SPACE_NOTES_MAX,
    reports: withReport.slice(0, APP_SPACE_REPORTS).map((j) => ({ id: j.id, title: jobTitle(j), kind: j.kind, who: kindName(j.kind), at: j.finishedAt ?? j.createdAt })),
    moreReports: withReport.length > APP_SPACE_REPORTS,
    files: sent.slice(0, APP_SPACE_FILES),
    moreFiles: sent.length > APP_SPACE_FILES,
  };
}

/* ---------- One agent: who it is, what it may use, and how it has been doing ---------- */

export const APP_AGENT_JOBS = 10;

/** One window of an agent's record. Finished is not the same as done, so the outcomes are counted apart. */
export interface AppAgentWindow {
  label: string;
  finished: number;
  /** Of those: confirmed done, finished with nothing confirming it, waiting on Paul, and did not get there. */
  met: number;
  unconfirmed: number;
  waiting: number;
  notMet: number;
  /** Why the ones that stopped or failed did, in plain words with counts. */
  why?: string;
  run?: string;
  wait?: string;
  /** What those jobs cost in all, where the store holds the provider's own figures, and how many of them that covers. */
  costUsd?: number;
  costedJobs: number;
}

export interface AppAgent {
  generatedAt: string;
  kind: string;
  name?: string;
  role: string;
  /** What it does, in one short line. */
  does: string;
  /** What it is doing this minute, as the roster says it. */
  now: Pick<AppRosterEntry, "state" | "line" | "jobId">;
  /** The model its next job runs on, and one line on where that is decided. */
  model?: string;
  modelNote: string;
  /** How far one job of its may run. Absent for the chief, which runs no jobs. */
  limits?: { maxTurns: number; budgetUsd?: number };
  /** What it may use, in plain words, and how many commands are refused to it outright. */
  tools: string[];
  refused: number;
  windows: AppAgentWindow[];
  /** What a job of its usually costs on each model, where there is enough to say (src/estimates.ts). */
  usual: CostEstimate[];
  /** The chief only: what the provider charged today for its own replies, by model. */
  repliesToday?: Array<{ model: string; usd: number; calls: number }>;
  /** Its newest jobs, any status. */
  jobs: AppJob[];
}

/** What a tool is for, in the words a card would use. A name not listed here is shown as it is. */
const TOOL_WORDS: Array<[RegExp, string]> = [
  [/^(Edit|Write|NotebookEdit)$/, "Edit and write files"],
  [/^Read$/, "Read files"],
  [/^(Glob|Grep)$/, "Search files"],
  [/^Bash$/, "Run commands"],
  [/^Bash\((.+?)[ :]\*?\)$/, "Run $1 only"],
  [/^WebSearch$/, "Search the web"],
  [/^WebFetch$/, "Read web pages"],
  [/^mcp__design__screenshot$/, "Take screenshots of a site"],
  [/^mcp__design__save_asset$/, "Save design assets"],
  [/^mcp__google__/, "Your Gmail and Calendar, within its permits"],
  [/^mcp__dns__/, "Your GoDaddy DNS: read, and prepare changes for you to approve"],
];
function toolWords(allowed: readonly string[]): string[] {
  const out: string[] = [];
  // Plain "Bash" covers every narrower "Bash(...)" beside it.
  const all = allowed.includes("Bash") ? allowed.filter((t) => !t.startsWith("Bash(")) : allowed;
  for (const tool of all) {
    const hit = TOOL_WORDS.find(([shape]) => shape.test(tool));
    const words = !hit ? tool : hit[1].includes("$1") ? tool.replace(hit[0], hit[1]) : hit[1];
    if (!out.includes(words)) out.push(words);
  }
  return out;
}

const AGENT_KIND = /^[a-z_]{1,24}$/;
const MODEL_ROLE: Record<string, string> = { engineer: "engineers", create_agent: "engineers", maintain: "maintainer" };

/** One agent's page. `kind` is "chief" or a kind of worker; anything else is no agent at all. */
export function appAgent(source: AppSource, kind: string): AppAgent | undefined {
  if (!AGENT_KIND.test(kind)) return undefined;
  const now = source.now ?? Date.now();
  const names: Record<string, string> = AGENT_NAMES;
  const board = appBoard(source);
  const on = board.roster.find((r) => r.kind === kind);
  const base = { generatedAt: new Date(now).toISOString(), kind, ...(names[kind] ? { name: names[kind] } : {}) };
  if (kind === "chief") {
    const chat = source.store.chatCost();
    return {
      ...base,
      role: "chief",
      does: "answers you, starts jobs and hands longer work to the others",
      now: { state: "here", line: "With you" },
      model: resolveModel(config.models.chief),
      modelNote: "The chief's model, which you can change on the Spend page.",
      tools: ["Start, stop and look up jobs", "Read the board, the spend and the health checks", "Prepare what needs your approval, and nothing past it"],
      refused: 0,
      windows: [],
      usual: [],
      ...(chat?.ymd === londonYmd(new Date(now)) && chat.models.length ? { repliesToday: chat.models.map((m) => ({ ...m })) } : {}),
      jobs: [],
    };
  }
  if (kind === "voice") {
    const on = !!source.voice?.();
    return {
      ...base,
      name: CLEO,
      role: "voice",
      does: "is who you talk to: she answers what she can, the board included, asks the chief for the rest, and tells you what he said and where he wrote it",
      now: on ? { state: "here", line: "Ready to talk" } : { state: "idle", line: "Switched off" },
      model: resolveModel(config.voice.model),
      modelNote: "Her own quick model, set where the service runs. She speaks with a text-to-speech voice and hears through the same transcription a voice note uses.",
      tools: ["Read the board as it stands when you speak: what is running, queued, waiting on you, open, finished lately and spent", "Hand your request to the chief, in your words", "Nothing else: she cannot see inside a job, or your mail or files, and nothing said aloud can approve anything"],
      refused: 0,
      windows: [],
      usual: [],
      jobs: [],
    };
  }
  const does = kindDoes(kind);
  if (!does) return undefined;
  const spec = workerSpec(kind as Job["kind"]);
  const route = runRoute({ kind }, spec.model);
  const limits = runLimits(kind as Job["kind"]);
  const mine = source.store.allJobs().filter((j) => j.kind === kind);
  const ev = evidenceOf(source.store);
  const figures = boardEfficiency({ jobs: mine, now });
  const windows = STATS_WINDOWS.map((w, i): AppAgentWindow => {
    const from = now - w.hours * 3_600_000;
    const done = mine.filter((j) => isFinished(j) && j.finishedAt && Date.parse(j.finishedAt) >= from);
    const count = (state: AppOutcome["state"]) => done.filter((j) => (outcomeOf(source.store, j, ev, source)?.state ?? "unconfirmed") === state).length;
    const costs = done.map(realCost).filter((c): c is number => c !== undefined);
    const stats = figures.windows[i]?.kinds[0];
    return {
      label: w.label,
      finished: done.length,
      met: count("met"),
      unconfirmed: count("unconfirmed"),
      waiting: count("waiting"),
      notMet: count("not_met"),
      ...(stats?.why ? { why: stats.why } : {}),
      ...(stats?.run ? { run: stats.run } : {}),
      ...(stats?.wait ? { wait: stats.wait } : {}),
      ...(costs.length ? { costUsd: costs.reduce((n, c) => n + c, 0) } : {}),
      costedJobs: costs.length,
    };
  });
  return {
    ...base,
    role: kindName(kind),
    does,
    now: on ? { state: on.state, line: on.line, ...(on.jobId ? { jobId: on.jobId } : {}) } : { state: "idle", line: "Idle" },
    model: route.provider === "anthropic" ? `anthropic/${route.model}` : resolveModel(route.model),
    modelNote: route.provider === "anthropic" ? "Always Claude, on Anthropic's API directly. It is not changed from the app." : `The ${MODEL_ROLE[kind] ?? "workers"}' model, which you can change on the Spend page. A job you pin to a model runs on that one instead.`,
    limits: { maxTurns: limits.maxTurns, ...(limits.realBudgetUsd !== undefined ? { budgetUsd: limits.realBudgetUsd } : {}) },
    tools: toolWords(spec.allowedTools),
    refused: spec.disallowedTools?.length ?? 0,
    windows,
    usual: ev.estimates.filter((e) => e.kind === kind || (kind === "research" && e.kind === "research, deep")),
    jobs: mine
      .sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.startedAt ?? a.createdAt))
      .slice(0, APP_AGENT_JOBS)
      .map((j) => toAppJob(source, j, ev)),
  };
}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One job in full: what it is, how it is going, its trace and what it produced. */
export function appJob(source: AppSource, id: string): AppJobDetail | undefined {
  if (!JOB_ID.test(id)) return undefined;
  const job = source.store.getJob(id);
  if (!job) return undefined;
  const now = source.now ?? Date.now();
  const ev = evidenceOf(source.store);
  const app = toAppJob(source, job, ev);
  const links = app.pr ? [{ what: "pull request", url: app.pr }] : [];
  const pull = source.jobPull?.(job);
  const described = describeJob(job, { hasPullRequest: !!app.pr }, app.repository);
  const limits = runLimits(job.kind, job.depth);
  const lines = readTrace(job.id, source.traceDir);
  const report = appReportFor(source.store, job.id);
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
    // The stop line is not a report: the page says the job wrote none, in plain words, in its place.
    ...(wroteNothing(job) ? { noReport: `${stoppedEarlyWords(wroteNothing(job)!)} There is nothing to read. Run it again to get one: a job that runs out of turns now writes up what it has.` } : report?.markdown !== undefined ? { outputHtml: renderMarkdown(report.markdown), ...(report.private ? { outputPrivate: report.private } : {}) } : {}),
    actions: actionsOf(job, !!pull, ev.estimates),
    ...(pull ? { pull: { repo: pull.repo, number: pull.number, ...(pull.wrote ? { wrote: pull.wrote } : {}) } } : {}),
    related,
  };
}
