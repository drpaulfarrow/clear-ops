/**
 * The jobs board: one read-only page Paul opens on his phone instead of typing /jobs in chat.
 *
 * It shows only jobs: what is running now, what is queued (and behind which job, in which
 * repository's queue), what finished recently and what is scheduled. Each card says in plain English
 * what the job is, two or three lines taken from the job's own brief by src/job-descriptions.ts (this
 * file never touches a brief itself: that module redacts, strips the markup and caps it, and says so
 * honestly when a brief yields nothing), what kind of worker it is, and what a finished job produced.
 *
 * It never shows spend, cost, budget, caps or model figures (it does not read src/spend.ts at all), and
 * never a job's output text, transcript, file path, environment variable, secret or personal data.
 * Titles, kind, status, timings, repository, ids, a redacted description of the brief and a link that
 * already exists (a saved output, a pull request) only.
 *
 * The page changes nothing: the only route is a GET, and nothing here writes to a job, a queue or a
 * schedule. The link carries a long-lived token the service minted itself and keeps in the store
 * (/board prints it in chat); it is never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { lockKey, type JobRunner } from "./jobs.js";
import { classify, EXCLUDED_KINDS } from "./output-folders.js";
import { entryFor } from "./publish-outputs.js";
import { failureLabel } from "./failures.js";
import { jobTitle } from "./titles.js";
import { describeJob, liveStep, NO_DESCRIPTION } from "./job-descriptions.js";
import type { Job, Store } from "./store.js";
import type { ScheduledRun } from "./scheduler.js";

export const BOARD_PATH = "/jobs";
/** The link refreshes itself so it stays useful while Paul watches a run. */
export const BOARD_REFRESH_SECONDS = 10;
/** Finished jobs older than this drop off the board; the last few of the day stay. */
const FINISHED_WINDOW_MS = 24 * 60 * 60_000;
const FINISHED_MAX = 8;
/** Where saved outputs are published (src/publish-outputs.ts): the private repository's default branch. */
const OUTPUTS_BRANCH = "main";

/* ---------- The token: minted once by the service, held in the store, never logged ---------- */

type TokenStore = Pick<Store, "settings" | "setSetting">;

/** The board's long-lived token, minted on first use and kept in the store. */
export function boardToken(store: TokenStore): string {
  const existing = store.settings().jobsBoardToken;
  if (existing) return existing;
  const token = randomBytes(24).toString("base64url");
  store.setSetting("jobsBoardToken", token);
  return token;
}

/** The bookmarkable link, printed in chat by /board. The token rides in the query string. */
export function boardUrl(store: TokenStore): string {
  return `${config.publicUrl}${BOARD_PATH}?t=${boardToken(store)}`;
}

/** True only for the exact token the service minted, compared in constant time. */
export function boardTokenValid(store: TokenStore, token: string): boolean {
  const expected = store.settings().jobsBoardToken;
  if (!expected || !token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/* ---------- The board, as plain data ---------- */

export interface BoardJobRef {
  title: string;
  id: string;
}

export interface BoardLink {
  what: string;
  url: string;
}

export interface BoardJob {
  id: string;
  title: string;
  /** The worker kind, raw ("engineer"). */
  kind: string;
  /** What the kind of worker and the repository mean, in one plain line ("engineer on the workforce repo: ..."). */
  kindLabel: string;
  /** The repository alias whose queue the job belongs to. */
  repository: string;
  status: "running" | "queued" | "done" | "failed";
  /** What this job is, in plain English from its own brief: two or three lines on a phone. */
  description?: string;
  /** Shown instead of a description when the brief yields nothing usable. */
  descriptionUnavailable?: string;
  /** The longer detail from the same brief, behind the card's expand control. */
  more?: string;
  /** Running: what the worker is doing this minute, in plain words ("Editing jobs.ts"). */
  now?: string;
  /** Finished: one line on what it produced, from the record only. */
  produced?: string;
  /** Running: how long it has been going, e.g. "12 min". */
  runningFor?: string;
  /** Running: when its worker last did anything, e.g. "2 min ago". */
  lastActive?: string;
  /** Finished: when it finished, e.g. "5 min ago". */
  finishedAgo?: string;
  /** Finished: what came of it ("done", or "failed: stalled, stopped"). */
  outcome?: string;
  /** Queued: the job it is waiting behind. */
  waitingBehind?: BoardJobRef;
  /** Queued: the queue is held after a credit or key failure until Paul sends /resume. */
  heldUntilResume?: boolean;
  /** Queued: its place in the queue, 1 is first. */
  queuePosition?: number;
  /** Links that already exist for this job: a saved output, and the pull request it opened or fixes. */
  links?: BoardLink[];
}

export interface BoardSchedule {
  title: string;
  kind: string;
  cron: string;
  timezone: string;
  /** Next run, ISO. */
  next?: string;
}

export interface Board {
  generatedAt: string;
  /** The engineering queues are held after a credit or key failure, until /resume. */
  paused: boolean;
  running: BoardJob[];
  queued: BoardJob[];
  finished: BoardJob[];
  scheduled: BoardSchedule[];
}

/** What the board reads: the store, the queue's own view of it, the scheduler's next runs. */
export interface BoardSource {
  store: Store;
  /** The queue's view of a job's place and whether it is held, so the board repeats none of that logic. */
  queue: Pick<JobRunner, "isHeld" | "queuePosition"> & { latestStep?: (id: string) => string | undefined };
  /** The enabled schedules with their next runs, from the scheduler. */
  schedules?: readonly ScheduledRun[];
  /** The clock, for the tests. */
  now?: number;
}

/* ---------- Small time helpers ---------- */

const MINUTE = 60_000;

function since(fromIso: string | undefined, now: number): string | undefined {
  if (!fromIso) return undefined;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return undefined;
  const mins = Math.floor(Math.max(0, now - t) / MINUTE);
  if (mins < 1) return "under a minute";
  if (mins < 90) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function ago(fromIso: string | undefined, now: number): string | undefined {
  const d = since(fromIso, now);
  return d ? `${d} ago` : undefined;
}

/* ---------- The data ---------- */

/**
 * A finished job's saved output, as a link into the private outputs repository, when one would be
 * there: the output exists, and src/output-folders.ts says it is copied (assistant, CV and
 * upload-derived outputs never are, so nothing personal is ever pointed at). An assistant output is
 * never even read.
 */
function savedOutputLink(store: Store, job: Job): BoardLink | undefined {
  if (EXCLUDED_KINDS.has(job.kind)) return undefined;
  const text = store.readOutput(job.id);
  if (text === undefined) return undefined;
  const verdict = classify(job, text);
  if ("excluded" in verdict) return undefined;
  const entry = entryFor(job, verdict.folder);
  return { what: "saved output", url: `https://github.com/${config.outputsRepo}/blob/${OUTPUTS_BRANCH}/${entry.file}` };
}

/** An absolute pull-request address, as src/jobs.ts records it on the job. */
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** The links that already exist for a job, so the board points at work rather than repeating it. */
function jobLinks(store: Store, job: Job): BoardLink[] {
  const links: BoardLink[] = [];
  const saved = savedOutputLink(store, job);
  if (saved) links.push(saved);
  if (job.pr && PR_URL.test(job.pr)) links.push({ what: "pull request", url: job.pr });
  return links;
}

function toBoardJob(source: BoardSource, job: Job, now: number): BoardJob {
  const repository = lockKey(job) ?? job.target ?? "product";
  const links = jobLinks(source.store, job);
  // Everything the card says about the job comes from its own record: its brief (redacted, stripped and
  // capped by src/job-descriptions.ts), its kind, and the links that already exist on it.
  const described = describeJob(job, { hasPullRequest: links.some((l) => l.what === "pull request"), hasSavedOutput: links.some((l) => l.what === "saved output") }, repository);
  const base: BoardJob = {
    id: job.id,
    title: jobTitle(job),
    kind: job.kind,
    kindLabel: described.kindLine,
    repository,
    status: job.status,
    ...(described.description ? { description: described.description } : { descriptionUnavailable: NO_DESCRIPTION }),
    ...(described.more ? { more: described.more } : {}),
    ...(described.produced ? { produced: described.produced } : {}),
    ...(links.length ? { links } : {}),
  };
  if (job.status === "running") {
    // What it is doing this minute: the worker's latest step, in plain words, when it is running here.
    const now_ = liveStep(source.queue.latestStep?.(job.id));
    return { ...base, runningFor: since(job.startedAt ?? job.createdAt, now), lastActive: ago(job.lastActivityAt, now), ...(now_ ? { now: now_ } : {}) };
  }
  if (job.status === "queued") {
    // A job blocked by the daily cap points waitingFor at itself when no queue holder exists, so a
    // holder is only ever a different job. Place and hold come from the queue itself (src/jobs.ts).
    const holder = job.waitingFor && job.waitingFor !== job.id ? source.store.getJob(job.waitingFor) : undefined;
    return {
      ...base,
      ...(source.queue.isHeld(job) ? { heldUntilResume: true } : holder ? { waitingBehind: { title: jobTitle(holder), id: holder.id } } : {}),
      queuePosition: holder ? source.queue.queuePosition(job.id) : undefined,
    };
  }
  return {
    ...base,
    finishedAgo: ago(job.finishedAt, now),
    outcome: job.status === "failed" ? `failed: ${failureLabel(job.failure)}` : "done",
  };
}

/**
 * The whole board as plain data: read from the store and the queue, nothing written and no output
 * text included. The only links are ones that already exist on the job.
 */
export function boardData(source: BoardSource): Board {
  const { store, schedules = [], now = Date.now() } = source;
  const all = store.allJobs();
  const running = all
    .filter((j) => j.status === "running")
    .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt))
    .map((j) => toBoardJob(source, j, now));
  const queued = all
    .filter((j) => j.status === "queued")
    .sort((a, b) => (a.queuePos ?? Number.MAX_SAFE_INTEGER) - (b.queuePos ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt))
    .map((j) => toBoardJob(source, j, now));
  const finished = all
    .filter((j) => (j.status === "done" || j.status === "failed") && j.finishedAt && now - Date.parse(j.finishedAt) <= FINISHED_WINDOW_MS)
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, FINISHED_MAX)
    .map((j) => toBoardJob(source, j, now));
  const scheduled = [...schedules]
    .sort((a, b) => (a.next ?? "~").localeCompare(b.next ?? "~"))
    .map((s) => ({ title: s.title, kind: s.kind, cron: s.cron, timezone: s.timezone, ...(s.next ? { next: s.next } : {}) }));
  return { generatedAt: new Date(now).toISOString(), paused: !!store.queueHold(), running, queued, finished, scheduled };
}

/* ---------- The page ---------- */

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Thu 29 Oct, 14:00" in London time, for a schedule's next run. */
function londonWhen(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

const STYLE = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:34rem;margin:0 auto;padding:1rem 1rem 3rem;color:#1a1a1a;line-height:1.4}
h1{font-size:1.35rem;margin:.2rem 0 .1rem}
h2{font-size:1rem;margin:1.4rem 0 .5rem;color:#333;border-bottom:1px solid #e2e2e2;padding-bottom:.25rem}
.job{border:1px solid #e2e2e2;border-radius:8px;padding:.6rem .75rem;margin:.5rem 0;background:#fff}
.job .t{font-weight:600}
.job .m{font-size:.85rem;color:#555;margin-top:.15rem}
.job .id{font-family:ui-monospace,Menlo,Consolas,monospace;color:#333}
.job .d{margin:.35rem 0 0;font-size:.9rem}
.job .p{margin:.3rem 0 0;font-size:.9rem}
.job .now{margin:.3rem 0 0;font-size:.9rem;color:#1a7f37}
.job .k{margin:.4rem 0 0;font-size:.78rem;color:#666}
.job .none{margin:.35rem 0 0;font-size:.9rem;color:#777;font-style:italic}
.job details{margin:.4rem 0 0}
.job summary{font-size:.8rem;color:#1a56db;cursor:pointer}
.job .x{margin:.3rem 0 0;font-size:.85rem;color:#444}
.badge{display:inline-block;font-size:.75rem;padding:.05rem .4rem;border-radius:999px;background:#eef1f5;color:#333;margin-left:.35rem;vertical-align:middle}
.badge.run{background:#e6f4ea;color:#1a7f37}
.badge.fail{background:#fdecec;color:#b42318}
.note{font-size:.85rem;color:#555;margin:.2rem 0 0}
.warn{border:1px solid #f0d9a8;background:#fdf6e6;border-radius:8px;padding:.5rem .75rem;margin:.6rem 0;font-size:.9rem}
.empty{color:#777;font-size:.9rem;margin:.3rem 0}
.ok{color:#1a7f37}
.fail{color:#b42318}
a{color:#1a56db}`;

function jobBlock(job: BoardJob): string {
  const badge = job.status === "running" ? `<span class="badge run">running</span>` : job.status === "failed" ? `<span class="badge fail">failed</span>` : "";
  // What the job is: the short description read off its brief, or the honest note that there is none.
  const what = job.description
    ? `<p class="d">${escapeHtml(job.description)}</p>`
    : job.descriptionUnavailable
      ? `<p class="none">${escapeHtml(job.descriptionUnavailable)}</p>`
      : "";
  const nowLine = job.now ? `<p class="now">Now: ${escapeHtml(job.now)}</p>` : "";
  const produced = job.produced ? `<p class="p">${escapeHtml(job.produced)}</p>` : "";
  // What the kind of worker means, and the repository in Paul's own name for it.
  const kind = `<div class="k">${escapeHtml(job.kindLabel)}</div>`;
  const meta: string[] = [`<span class="id">${escapeHtml(job.id)}</span>`];
  if (job.runningFor) meta.push(`running ${escapeHtml(job.runningFor)}`);
  if (job.lastActive) meta.push(`worker last active ${escapeHtml(job.lastActive)}`);
  if (job.queuePosition) meta.push(`#${job.queuePosition} in the queue`);
  if (job.heldUntilResume) meta.push("queue held until /resume");
  else if (job.waitingBehind) meta.push(`waiting behind ${escapeHtml(job.waitingBehind.title)} (<span class="id">${escapeHtml(job.waitingBehind.id)}</span>)`);
  if (job.finishedAgo) meta.push(`finished ${escapeHtml(job.finishedAgo)}`);
  if (job.outcome) meta.push(`<span class="${job.status === "failed" ? "fail" : "ok"}">${escapeHtml(job.outcome)}</span>`);
  for (const link of job.links ?? []) meta.push(`<a href="${escapeHtml(link.url)}">${escapeHtml(link.what)}</a>`);
  // The rest of the brief, behind an expand control: plain HTML, nothing loaded and no script.
  const more = job.more ? `<details><summary>More of the brief</summary><div class="x">${escapeHtml(job.more)}</div></details>` : "";
  return `<div class="job"><div class="t">${escapeHtml(job.title)}${badge}</div>${what}${nowLine}${produced}${kind}<div class="m">${meta.join(" &middot; ")}</div>${more}</div>`;
}

function section(title: string, jobs: BoardJob[], empty: string): string {
  const body = jobs.length ? jobs.map(jobBlock).join("") : `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<h2>${escapeHtml(title)}</h2>${body}`;
}

/** The whole page. Every value is escaped; the only markup is this template. */
export function renderBoard(board: Board, token: string): string {
  const now = new Date(board.generatedAt);
  const clock = Number.isNaN(now.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
  const schedules = board.scheduled.length
    ? board.scheduled
        .map((s) => {
          const when = londonWhen(s.next);
          return `<div class="job"><div class="t">${escapeHtml(s.title)}</div><div class="m">${escapeHtml(s.kind)} &middot; next ${escapeHtml(when ?? "not armed")} &middot; <span class="id">${escapeHtml(s.cron)}</span> (${escapeHtml(s.timezone)})</div></div>`;
        })
        .join("")
    : `<p class="empty">No scheduled jobs.</p>`;
  const paused = board.paused ? `<div class="warn">The engineering queues are held until you send /resume.</div>` : "";
  const refresh = `${BOARD_REFRESH_SECONDS}; url=${BOARD_PATH}?t=${escapeHtml(token)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${refresh}"><title>Workforce jobs</title><style>${STYLE}</style></head><body>
<h1>Workforce jobs</h1>
<p class="note">Read only, refreshes every ${BOARD_REFRESH_SECONDS} seconds. Updated ${escapeHtml(clock)} London.</p>
${paused}
${section("Running now", board.running, "Nothing running.")}
${section("Queued", board.queued, "Nothing queued.")}
${section("Finished recently", board.finished, "Nothing finished in the last day.")}
<h2>Scheduled</h2>${schedules}
</body></html>`;
}

/** A plain page for a refused link. Never echoes the token or anything from the request. */
export function refusedPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><style>${STYLE}</style></head><body><h1>Not found</h1><p>That link is not valid.</p></body></html>`;
}
