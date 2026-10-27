import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type JobKind = "research" | "write" | "engineer" | "maintain" | "analyse";
/** Which codebase an engineering job works in: the product, or this workforce itself. */
export type JobTarget = "product" | "self";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  target?: JobTarget;
  brief: string;
  requestedBy: string;
  /** Where results are posted: the chat, channel or thread the job came from. Defaults to requestedBy. */
  replyTo?: string;
  status: JobStatus;
  /** Set when a restart interrupted the job and it was re-queued. */
  resumed?: number;
  createdAt: string;
  finishedAt?: string;
  summary?: string;
  outputPath?: string;
  costUsd?: number;
  error?: string;
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
  brief: string;
  requestedBy: string;
  replyTo?: string;
  createdAt: string;
  enabled: boolean;
}

interface State {
  sessions: Record<string, string>; // phone number -> agent session id
  jobs: Record<string, Job>;
  actions: Record<string, PendingAction>;
  schedules: Record<string, Schedule>;
  notes: string[]; // standing instructions the operator asked the workforce to remember
}

const empty = (): State => ({ sessions: {}, jobs: {}, actions: {}, schedules: {}, notes: [] });

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
  createJob(kind: JobKind, brief: string, requestedBy: string, target?: JobTarget, replyTo?: string): Job {
    const job: Job = {
      id: shortId(),
      kind,
      target,
      brief,
      requestedBy,
      replyTo: replyTo ?? requestedBy,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
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

  // Schedules
  createSchedule(s: Omit<Schedule, "id" | "createdAt" | "enabled">): Schedule {
    const schedule: Schedule = { ...s, id: shortId(), createdAt: new Date().toISOString(), enabled: true };
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
}
