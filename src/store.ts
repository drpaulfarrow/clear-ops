import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { derivedJobTitle, legacyScheduleTitle } from "./titles.js";
import type { FailureKind } from "./failures.js";

export type JobKind = "research" | "write" | "engineer" | "maintain" | "analyse" | "create_agent" | "ea" | "design" | "ideate" | "cv";
/**
 * What an executive-assistant job may change in Paul's Google Workspace, granted per job by the chief
 * only when Paul asked for it in chat. Without a permit the job can only read.
 */
export type EaPermit = "drafts" | "holds" | "send";
/**
 * Which managed repository a job works in: the alias of an entry in the repository list
 * ("product" and "self" always exist; others such as "site" come from MANAGED_REPOS or are created
 * by the workforce). See src/repos.ts.
 */
export type JobTarget = string;
/** What a job may do beyond its kind's defaults, granted per job by the chief only when Paul asked in chat. */
export type JobPermit = EaPermit | "create_repo";
/** A repository the workforce created, kept so it can be worked on straight away and after a restart. */
export interface CreatedRepo {
  slug: string;
  private: boolean;
  description?: string;
  createdAt: string;
  /** The job that created it. */
  jobId?: string;
}
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  /** Waiting because the daily spend cap was reached; starts once it is lifted or the London day turns. */
  capBlocked?: boolean;
  target?: JobTarget;
  /**
   * What Paul sees for this job everywhere: five words or fewer, chosen by the chief or derived by the
   * system ("Review: Fly deploy"). Optional only for state written before titles; the store fills it in on load.
   */
  title?: string;
  /** The full brief, unchanged, for the worker. */
  brief: string;
  requestedBy: string;
  /** Where results are posted: the chat, channel or thread the job came from. Defaults to requestedBy. */
  replyTo?: string;
  status: JobStatus;
  /** Set when a restart interrupted the job and it was re-queued. */
  resumed?: number;
  /**
   * Set while the job waits for the per-target engineering lock: the id of the job holding it.
   * A queued job with this set has never started; one without it is about to start.
   */
  waitingFor?: string;
  /** Position in its target's queue, increasing. Persisted so FIFO order survives a restart. */
  queuePos?: number;
  /** The pull request this job opened or is fixing (engineering kinds), as a URL or "#<number>". */
  pr?: string;
  /** Engineer jobs started automatically to address a review: 1 for the first round, and so on. */
  fixRound?: number;
  /** Maintainer jobs started automatically after an engineering job: the id of that job. */
  reviewOf?: string;
  /**
   * Design loop: the id of the loop's first design job. Set on every design, engineer and fix job the
   * loop starts, so a merge leads to the next round. designRound counts from 1.
   */
  designLoop?: string;
  designRound?: number;
  /** The founder's goal for the loop, on the loop's first design job. */
  designGoal?: string;
  /** The loop's closing critique: report to the founder, start no more engineering. */
  designFinal?: boolean;
  /** On the loop's first job: the loop is waiting for Paul, so start_job with continueLoop may carry it on. */
  designPaused?: boolean;
  /** A design round that must wait for the product's deploy of the merge before it looks. */
  awaitDeploy?: boolean;
  /** Executive-assistant jobs: what it may change (drafts, holds). Absent means read only. */
  permits?: JobPermit[];
  /** Research jobs: "deep" gets more turns and budget and writes a long, structured report. */
  depth?: "standard" | "deep";
  createdAt: string;
  /** When the current attempt's worker started (after any wait for a deploy). */
  startedAt?: string;
  /**
   * The worker's heartbeat: when it last did anything (a message, a tool call, a result). Written at
   * most once a minute; the job runner holds the exact time in memory while the worker is alive.
   */
  lastActivityAt?: string;
  /**
   * An engineering job that was stopped (stalled, over its maximum runtime, or cancelled): the branch
   * it was on and the stash holding its uncommitted work, so a retry carries on and nothing is lost.
   */
  savedWork?: SavedWork;
  finishedAt?: string;
  summary?: string;
  outputPath?: string;
  costUsd?: number;
  error?: string;
  /**
   * Failed jobs: why, when the run ended in an API or SDK error (no credit, a rejected key, rate limits,
   * overload, no output) or threw. A failed job did no work, and nothing follows it automatically.
   */
  failure?: FailureKind;
}

/** Where a stopped engineering job's work was kept. */
export interface SavedWork {
  /** The checkout it worked in. */
  dir: string;
  /** The branch checked out when it stopped. */
  branch?: string;
  /** The stash message, when there was uncommitted work to keep. */
  stash?: string;
}

/**
 * Set when a job failed on something that would fail every run until Paul acts (no Anthropic credit, a
 * rejected key). While it is set no queued engineering job starts; /resume or the chief's resume_jobs
 * clears it, reruns the jobs that failed and restarts the queues.
 */
export interface QueueHold {
  kind: FailureKind;
  /** The job whose failure set the hold. */
  jobId: string;
  since: string;
  detail: string;
}

export interface PendingAction {
  id: string;
  kind: string;
  description: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: string;
}

export interface Schedule {
  id: string;
  cron: string;
  timezone: string;
  kind: JobKind;
  /** The title each run's job gets. Optional only for state written before titles; filled in on load. */
  title?: string;
  brief: string;
  requestedBy: string;
  replyTo?: string;
  createdAt: string;
  enabled: boolean;
}

/**
 * Something in Paul's mail that needs following up, kept by the executive assistant.
 * owed: someone is waiting on Paul. promised: Paul said he would do something. waiting: Paul is waiting on someone.
 * Subject, who and excerpt come from email, so they are untrusted data wherever they are shown to a model.
 */
export type FollowUpKind = "owed" | "promised" | "waiting";
export interface FollowUp {
  id: string;
  /** Identifies the thing tracked, so a re-scan updates rather than duplicates: "<kind>:<thread or message id>". */
  key: string;
  kind: FollowUpKind;
  threadId: string;
  messageId?: string;
  subject: string;
  /** The other party: who is waiting, or who Paul is waiting on, as "Name <address>" or an address. */
  who: string;
  /** A short quote: the question asked or the commitment made. */
  excerpt: string;
  /** When the email this is about was sent. */
  since: string;
  /** When it should be done (owed, promised) or chased (waiting). */
  dueAt: string;
  /** When it counts as stale and Paul is nudged in chat. */
  staleAt: string;
  status: "open" | "snoozed" | "done";
  snoozedUntil?: string;
  /** Set when Paul was nudged about it; he is nudged again only after a snooze. */
  nudgedAt?: string;
  doneAt?: string;
  /** Why it was closed: "done" (Paul), "replied" (the thread moved on), or a reason the assistant gave. */
  closedReason?: string;
  /** "scan" when found by the detectors, "assistant" when the executive assistant added it. */
  source: "scan" | "assistant";
  createdAt: string;
  updatedAt: string;
}

/**
 * Holds placed together as proposed times for one meeting. When a real meeting with one of `with`
 * appears on Paul's calendar, the hold watcher removes the rest. Only events listed here, and only
 * while they are still the assistant's own holds, are ever removed.
 */
export interface HoldGroup {
  id: string;
  title: string;
  /** Lower-case addresses of the people the meeting is with. Empty means no automatic release. */
  with: string[];
  holds: Array<{ eventId: string; start: string; end: string }>;
  /** The ea job that placed them, which held the holds permit Paul granted. */
  jobId?: string;
  replyTo?: string;
  status: "open" | "confirmed" | "expired";
  confirmedEventId?: string;
  createdAt: string;
  closedAt?: string;
}

/**
 * An email or invitation prepared for Paul's approval. Nothing is sent until Paul approves this id in chat;
 * the record is also the audit log (who approved, when, recipients, subject, the id Google returned).
 */
export type OutboundKind = "send_draft" | "send_email" | "invite";
export type OutboundStatus = "pending" | "executing" | "executed" | "cancelled" | "expired" | "changed" | "failed";
export interface OutboundAction {
  id: string;
  kind: OutboundKind;
  status: OutboundStatus;
  createdAt: string;
  expiresAt: string;
  /** The ea job that prepared it, and where Paul was shown it. */
  jobId?: string;
  replyTo: string;
  email?: { draftId?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string; attachments?: string[] };
  invite?: { title: string; start: string; end: string; attendees: string[]; location?: string; description?: string };
  /** Digest of exactly what Paul was shown. A draft that no longer matches needs a new approval. */
  hash: string;
  approvedBy?: string;
  approvedAt?: string;
  executedAt?: string;
  /** Gmail message id or calendar event id returned by Google. */
  resultId?: string;
  note?: string;
}

/** Runtime settings Paul sets from chat. */
export interface Settings {
  /** Paul's Google Calendar appointment-schedule booking link, offered in scheduling drafts. */
  eaBookingLink?: string;
  /** Where follow-up nudges and hold releases are reported: the chat Google was connected from. */
  eaReplyTo?: string;
  /** The repository problems Paul was last told about at start-up, so a restart does not repeat them. */
  repoProblemsTold?: string;
  /** The last GitHub auth problem Paul was told about, so it is sent once. */
  githubProblemTold?: string;
}

interface State {
  sessions: Record<string, string>; // phone number -> agent session id
  jobs: Record<string, Job>;
  actions: Record<string, PendingAction>;
  schedules: Record<string, Schedule>;
  notes: string[]; // standing instructions the operator asked the workforce to remember
  followups: Record<string, FollowUp>;
  holdGroups: Record<string, HoldGroup>;
  settings: Settings;
  outbound?: Record<string, OutboundAction>;
  /** Gmail drafts the assistant created: the only drafts it may prepare for sending. */
  createdDrafts?: Record<string, { at: string; jobId?: string }>;
  /** Repositories the workforce created, by alias. */
  repos?: Record<string, CreatedRepo>;
  queueHold?: QueueHold;
  /** London dates (YYYY-MM-DD): the day /resume lifted the daily spend cap, and the day Paul was last told it was hit. */
  capLiftedOn?: string;
  capNotifiedOn?: string;
}

const empty = (): State => ({ sessions: {}, jobs: {}, actions: {}, schedules: {}, notes: [], followups: {}, holdGroups: {}, settings: {} });

export function shortId(): string {
  // 4 bytes -> 8 hex chars, trimmed to 6 for easy typing on a phone
  return randomBytes(4).toString("hex").slice(0, 6);
}

/**
 * A small JSON-file store. One operator, a few hundred records, atomic writes.
 * Swap for SQLite or Postgres if this ever has more than one instance.
 */
export class Store {
  private state: State;
  private readonly file: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
    this.file = path.join(dir, "state.json");
    this.state = fs.existsSync(this.file)
      ? { ...empty(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) }
      : empty();
    this.migrateTitles();
  }

  /**
   * Jobs and schedules stored before titles existed get a short derived one, once, on load. Jobs are
   * titled oldest first so a review or fix round can take its title from the job it belongs to.
   */
  private migrateTitles(): void {
    let changed = false;
    const schedules = Object.values(this.state.schedules);
    for (const s of schedules) {
      if (s.title?.trim()) continue;
      s.title = legacyScheduleTitle(s);
      changed = true;
    }
    const jobs = Object.values(this.state.jobs).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const j of jobs) {
      if (j.title?.trim()) continue;
      j.title = derivedJobTitle(j, (id) => this.state.jobs[id], jobs, schedules);
      changed = true;
    }
    if (changed) this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Sessions
  getSession(number: string): string | undefined {
    return this.state.sessions[number];
  }
  setSession(number: string, sessionId: string): void {
    this.state.sessions[number] = sessionId;
    this.save();
  }
  clearSession(number: string): void {
    delete this.state.sessions[number];
    this.save();
  }

  // Jobs
  createJob(kind: JobKind, brief: string, requestedBy: string, target?: JobTarget, replyTo?: string, extra: Partial<Job> = {}): Job {
    const job: Job = {
      ...extra,
      id: shortId(),
      kind,
      target,
      brief,
      requestedBy,
      replyTo: replyTo ?? requestedBy,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    // A job nobody titled (a scheduled run, a nudge, a caller that passed none) gets a derived one.
    job.title = extra.title?.trim() || derivedJobTitle(job, (id) => this.state.jobs[id], Object.values(this.state.jobs), Object.values(this.state.schedules));
    this.state.jobs[job.id] = job;
    this.save();
    return job;
  }
  updateJob(id: string, patch: Partial<Job>): Job {
    const job = this.state.jobs[id];
    if (!job) throw new Error(`No job ${id}`);
    Object.assign(job, patch);
    this.save();
    return job;
  }
  getJob(id: string): Job | undefined {
    return this.state.jobs[id];
  }
  /** Jobs a previous process left running. Called once on boot so they can be resumed. */
  interruptedJobs(): Job[] {
    return Object.values(this.state.jobs).filter((j) => j.status === "running" || j.status === "queued");
  }
  /** Every job, in no particular order. */
  allJobs(): Job[] {
    return Object.values(this.state.jobs);
  }
  listJobs(limit = 10): Job[] {
    return Object.values(this.state.jobs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  outputPath(jobId: string): string {
    return path.join(this.dir, "outputs", `${jobId}.md`);
  }
  writeOutput(jobId: string, text: string): string {
    const p = this.outputPath(jobId);
    fs.writeFileSync(p, text);
    return p;
  }
  readOutput(jobId: string): string | undefined {
    const p = this.outputPath(jobId);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  }

  // Approvals
  createAction(kind: string, description: string, payload: Record<string, unknown>, requestedBy: string): PendingAction {
    const action: PendingAction = {
      id: shortId(),
      kind,
      description,
      payload,
      requestedBy,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.state.actions[action.id] = action;
    this.save();
    return action;
  }
  getAction(id: string): PendingAction | undefined {
    return this.state.actions[id];
  }
  updateAction(id: string, patch: Partial<PendingAction>): PendingAction {
    const a = this.state.actions[id];
    if (!a) throw new Error(`No action ${id}`);
    Object.assign(a, patch);
    this.save();
    return a;
  }
  pendingActions(): PendingAction[] {
    return Object.values(this.state.actions).filter((a) => a.status === "pending");
  }

  // Outbound (send and invite) approvals and their log
  putOutbound(a: OutboundAction): OutboundAction {
    (this.state.outbound ??= {})[a.id] = a;
    this.save();
    return a;
  }
  getOutbound(id: string): OutboundAction | undefined {
    return this.state.outbound?.[id];
  }
  updateOutbound(id: string, patch: Partial<OutboundAction>): OutboundAction {
    const a = this.state.outbound?.[id];
    if (!a) throw new Error(`No outbound action ${id}`);
    Object.assign(a, patch);
    this.save();
    return a;
  }
  listOutbound(): OutboundAction[] {
    return Object.values(this.state.outbound ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  recordCreatedDraft(draftId: string, jobId?: string): void {
    (this.state.createdDrafts ??= {})[draftId] = { at: new Date().toISOString(), jobId };
    this.save();
  }
  isCreatedDraft(draftId: string): boolean {
    return Boolean(this.state.createdDrafts?.[draftId]);
  }

  // Schedules
  createSchedule(s: Omit<Schedule, "id" | "createdAt" | "enabled">): Schedule {
    const schedule: Schedule = { ...s, title: s.title?.trim() || legacyScheduleTitle(s), id: shortId(), createdAt: new Date().toISOString(), enabled: true };
    this.state.schedules[schedule.id] = schedule;
    this.save();
    return schedule;
  }
  listSchedules(): Schedule[] {
    return Object.values(this.state.schedules);
  }
  disableSchedule(id: string): boolean {
    const s = this.state.schedules[id];
    if (!s) return false;
    s.enabled = false;
    this.save();
    return true;
  }

  // Standing notes
  addNote(note: string): void {
    this.state.notes.push(note);
    this.save();
  }
  notes(): string[] {
    return [...this.state.notes];
  }

  // Follow-ups
  listFollowUps(): FollowUp[] {
    return Object.values(this.state.followups);
  }
  getFollowUp(id: string): FollowUp | undefined {
    return this.state.followups[id];
  }
  findFollowUp(key: string): FollowUp | undefined {
    return Object.values(this.state.followups).find((f) => f.key === key);
  }
  createFollowUp(f: Omit<FollowUp, "id" | "createdAt" | "updatedAt">): FollowUp {
    let id = shortId();
    while (this.state.followups[id]) id = shortId();
    const now = new Date().toISOString();
    const item: FollowUp = { ...f, id, createdAt: now, updatedAt: now };
    this.state.followups[id] = item;
    this.save();
    return item;
  }
  updateFollowUp(id: string, patch: Partial<FollowUp>): FollowUp {
    const f = this.state.followups[id];
    if (!f) throw new Error(`No follow-up ${id}`);
    Object.assign(f, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return f;
  }

  // Hold groups
  createHoldGroup(g: Omit<HoldGroup, "id" | "createdAt" | "status">): HoldGroup {
    const group: HoldGroup = { ...g, id: shortId(), status: "open", createdAt: new Date().toISOString() };
    this.state.holdGroups[group.id] = group;
    this.save();
    return group;
  }
  listHoldGroups(): HoldGroup[] {
    return Object.values(this.state.holdGroups);
  }
  updateHoldGroup(id: string, patch: Partial<HoldGroup>): HoldGroup {
    const g = this.state.holdGroups[id];
    if (!g) throw new Error(`No hold group ${id}`);
    Object.assign(g, patch);
    this.save();
    return g;
  }

  // Queue hold
  queueHold(): QueueHold | undefined {
    return this.state.queueHold ? { ...this.state.queueHold } : undefined;
  }
  setQueueHold(hold: QueueHold | undefined): void {
    if (hold) this.state.queueHold = hold;
    else delete this.state.queueHold;
    this.save();
  }

  // Daily spend cap
  capDays(): { liftedOn?: string; notifiedOn?: string } {
    return { liftedOn: this.state.capLiftedOn, notifiedOn: this.state.capNotifiedOn };
  }
  setCapDays(patch: { liftedOn?: string; notifiedOn?: string }): void {
    if (patch.liftedOn) this.state.capLiftedOn = patch.liftedOn;
    if (patch.notifiedOn) this.state.capNotifiedOn = patch.notifiedOn;
    this.save();
  }

  // Settings
  createdRepos(): Record<string, CreatedRepo> {
    return { ...(this.state.repos ?? {}) };
  }
  addCreatedRepo(alias: string, repo: CreatedRepo): void {
    this.state.repos = { ...(this.state.repos ?? {}), [alias]: repo };
    this.save();
  }
  settings(): Settings {
    return { ...this.state.settings };
  }
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (value === undefined) delete this.state.settings[key];
    else this.state.settings[key] = value;
    this.save();
  }
}
