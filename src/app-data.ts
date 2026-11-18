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
 *  - Something waiting on Paul is named by what it is and its id only. What an email says or what a
 *    basket holds stays where he approves it.
 */
import { config } from "./config.js";
import { PR_KINDS, runLimits, workerSpec } from "./agents.js";
import { failureLabel } from "./failures.js";
import { boardHealth } from "./health.js";
import { describeJob, kindName, liveStep, repoLabel } from "./job-descriptions.js";
import { lockKey, type JobRunner } from "./jobs.js";
import { resolveModel, runRoute } from "./llm.js";
import { londonYmd } from "./london.js";
import { renderMarkdown, reportFor } from "./reports.js";
import { redact } from "./repos.js";
import { spendDisplay } from "./spend.js";
import { jobTitle } from "./titles.js";
import { readTrace, traceFigures, type TraceFigures, type TraceLine } from "./trace.js";
import { realCost } from "./worker-stats.js";
import { WEB_CONVERSATION, type WebChat } from "./web-chat.js";
import type { ProbeResult } from "./health.js";
import type { Job, Store } from "./store.js";
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
}

export interface AppJobDetail {
  generatedAt: string;
  job: AppJob;
  description?: string;
  more?: string;
  produced?: string;
  doneWhen?: string;
  links: Array<{ what: string; url: string }>;
  /** The run's limits: turns, and the real-money cap when one is set. */
  limits: { maxTurns: number; budgetUsd?: number };
  trace: { lines: TraceLine[]; total: number; figures: TraceFigures };
  /** The saved output as HTML rendered by src/reports.ts, which escapes everything. */
  outputHtml?: string;
  /** The jobs around it: what it reviews, and what followed it. */
  related: Array<{ id: string; title: string; kind: string; status: Job["status"]; relation: string }>;
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

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

function toAppJob(source: AppSource, job: Job): AppJob {
  const repository = lockKey(job) ?? job.target ?? "product";
  const cost = realCost(job);
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
    ...(job.pr && PR_URL.test(job.pr) ? { pr: job.pr } : {}),
    ...(job.fixRound ? { fixRound: job.fixRound } : {}),
    ...(job.reviewOf ? { reviewOf: job.reviewOf } : {}),
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

/** What waits on Paul's own approval, named and nothing more. */
function waitingOf(store: Store, now: number): AppWaiting[] {
  const live = <T extends { status: string; expiresAt: string }>(items: T[]) => items.filter((a) => a.status === "pending" && Date.parse(a.expiresAt) > now);
  const out: AppWaiting[] = [];
  for (const a of live(store.listOutbound())) out.push({ what: "email", id: a.id, label: a.kind === "send_draft" || a.kind === "send_email" ? "An email is ready to send" : "A calendar change is ready to send", command: `send ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt, ...(a.jobId ? { jobId: a.jobId } : {}) });
  for (const a of live(store.listPurchases())) out.push({ what: "purchase", id: a.id, label: "A purchase is ready to approve", command: `buy ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt });
  for (const a of live(store.listDns())) out.push({ what: "dns", id: a.id, label: "A DNS change is ready to apply", command: `dns apply ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt });
  for (const a of live(store.listSignups())) out.push({ what: "signup", id: a.id, label: "A new account is ready to create", command: `signup apply ${a.id}`, createdAt: a.createdAt, expiresAt: a.expiresAt });
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  const health = boardHealth({ store: source.store, uptime: source.uptime, probes: source.probes, activeWorkers: source.activeWorkers, liveness: (id) => source.queue.liveness(id), now });
  return {
    generatedAt: new Date(now).toISOString(),
    spend: spendOf(source, now),
    health: { level: health.level, headline: health.headline, live: health.live },
    paused: !!source.store.queueHold(),
    waiting: waitingOf(source.store, now),
    jobs: [...running, ...queued, ...recent].map((j) => toAppJob(source, j)),
    hasOlder: finished.length > recent.length,
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
  return { jobs: page.map((j) => toAppJob(source, j)), ...(older.length > page.length && last ? { next: last.finishedAt ?? last.createdAt } : {}) };
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

/** The app's conversation with the chief, and the jobs it started. */
export function appChat(source: AppSource, chat: Pick<WebChat, "view">): AppChat {
  const now = source.now ?? Date.now();
  const view = chat.view();
  const jobs = source.store
    .allJobs()
    .filter((j) => (j.replyTo ?? j.requestedBy) === WEB_CONVERSATION)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-APP_CHAT_JOBS);
  return {
    generatedAt: new Date(now).toISOString(),
    messages: view.messages.map((m) =>
      m.from === "paul" || m.live ? { id: m.id, at: m.at, from: m.from, text: m.text, ...(m.live ? { live: true as const } : {}) } : { id: m.id, at: m.at, from: m.from, html: renderMarkdown(m.text) },
    ),
    typing: view.typing,
    jobs: jobs.map((j) => toAppJob(source, j)),
  };
}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One job in full: what it is, how it is going, its trace and what it produced. */
export function appJob(source: AppSource, id: string): AppJobDetail | undefined {
  if (!JOB_ID.test(id)) return undefined;
  const job = source.store.getJob(id);
  if (!job) return undefined;
  const now = source.now ?? Date.now();
  const app = toAppJob(source, job);
  const links = app.pr ? [{ what: "pull request", url: app.pr }] : [];
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
    related,
  };
}
