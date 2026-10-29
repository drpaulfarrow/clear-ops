import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { bookingLink, config } from "./config.js";
import { londonYmd } from "./london.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "./agents.js";
import { DEEP_RESEARCH_NOTE, detectDepth, MAX_DESIGN_ROUNDS, MAX_FIX_ROUNDS, PR_KINDS, readableDirs, runLimits, SCHEDULE_VERDICT, workerSpec } from "./agents.js";
import { designRoot, parseDesignVerdict, reportImages, waitForProductDeploy, type DeployWait } from "./design.js";
import type { Job, JobKind, JobStatus, JobTarget, PendingAction, SavedWork, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";
import { shortText, splitReport } from "./messages.js";
import { FailureNotifier, failureFromError, failureLabel, failureReason, HOLD_KINDS, RunFailedError, runFailure, type FailureKind, type FailureNotifierOptions, type RunFailure } from "./failures.js";
import { buildTitle, deriveTitle, designRoundTitle, fixTitle, jobLabel, jobRef, jobTitle, reviewTitle } from "./titles.js";

const exec = promisify(execFile);

/**
 * The repository an engineering job writes to, or undefined for kinds that write no code. Only one
 * job per repository holds this lock at a time; the rest wait in FIFO order. The agent-creator
 * always works on the workforce repo. The maintainer reviews and merges but does not take the lock.
 */
export function lockKey(job: Pick<Job, "kind" | "target">): JobTarget | undefined {
  if (!PR_KINDS.includes(job.kind)) return undefined;
  if (job.kind === "create_agent") return "self";
  return job.target ?? "product";
}

/** Why the service stopped a running job. */
export interface StopReason {
  kind: "stalled" | "timeout" | "cancelled";
  /** Recorded on the job as its error and in its saved output. */
  detail: string;
  /** The one plain sentence Paul is told, if any. Cancelling needs none: the chief tells him. */
  notice?: (job: Job, saved: SavedWork | undefined) => string;
}

/** A worker this process is running: its heartbeat, its runtime and the handle that stops it. */
interface LiveRun {
  abort: AbortController;
  startedAt: number;
  lastActivity: number;
  /** When lastActivityAt was last written to the store; the heartbeat is persisted at most once a minute. */
  persistedAt: number;
  /** Waiting for the product's deploy before a design round looks: not working yet, so never stalled. */
  waiting: boolean;
  /** The run returned and the job is being reported: too late to stop it. */
  finishing: boolean;
  stop?: StopReason;
  /** The stop has been recorded on the job, so it is never recorded twice. */
  recorded?: boolean;
  settled: Promise<void>;
  settle: () => void;
}

export interface LivenessOptions {
  /** No activity for this long and a running job is stalled. Default JOB_STALL_MINUTES (30 minutes). */
  stallMs?: number;
  /** The longest a job may run. Default JOB_MAX_RUNTIME_MINUTES (4 hours). */
  maxRuntimeMs?: number;
  /** How long a stopped worker gets to let go before the job is finished without it. Default 30 seconds. */
  graceMs?: number;
  /** The clock, for tests. */
  now?: () => number;
  /** Keeps a stopped engineering job's work (default: stash it in its checkout). Tests inject a fake. */
  saveWork?: (job: Job, why: StopReason["kind"]) => Promise<SavedWork | undefined>;
}

/** What the chief and Paul see when they ask whether a job is actually alive. */
export interface Liveness {
  id: string;
  status: JobStatus;
  /** True when a worker in this process is running the job and has shown activity recently. */
  alive: boolean;
  /** One plain sentence saying what is going on. */
  summary: string;
  lastActivityAt?: string;
  idleMinutes?: number;
  runningMinutes?: number;
  waitingForDeploy?: boolean;
  stallAfterMinutes: number;
  maxRuntimeMinutes: number;
}

const MINUTE = 60_000;
const minutes = (ms: number) => Math.round(ms / MINUTE);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Starts worker jobs in the background and reports back over WhatsApp when they finish. */
export class JobRunner {
  private running = new Set<string>();
  /** The workers this process is running, with their heartbeats. */
  private live = new Map<string, LiveRun>();
  /** Set once resumeInterrupted() has run: from then on a job marked running with no worker here is an orphan. */
  private booted = false;
  private checking = false;
  private readonly stallMs: number;
  private readonly maxRuntimeMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly saveWork: (job: Job, why: StopReason["kind"]) => Promise<SavedWork | undefined>;
  /** Which job holds each repository's engineering lock in this process. */
  private holders = new Map<JobTarget, string>();

  private readonly waitForDeploy: DeployWait;
  /** Batches failure messages so an outage that fails many jobs sends Paul one message, not a flood. */
  readonly failures: FailureNotifier;

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly run: AgentRunner,
    /** Extra tool servers for a job (the executive assistant's Google tools). Built per job so permits apply. */
    private readonly toolsFor: (job: Job) => Record<string, McpServerConfig> | undefined = () => undefined,
    opts: { waitForDeploy?: DeployWait; failureNotices?: FailureNotifierOptions; liveness?: LivenessOptions } = {},
  ) {
    this.waitForDeploy = opts.waitForDeploy ?? waitForProductDeploy;
    const l = opts.liveness ?? {};
    this.stallMs = l.stallMs ?? config.jobStallMinutes * MINUTE;
    this.maxRuntimeMs = l.maxRuntimeMs ?? config.jobMaxRuntimeMinutes * MINUTE;
    this.graceMs = l.graceMs ?? 30_000;
    this.now = l.now ?? Date.now;
    this.saveWork = l.saveWork ?? defaultSaveWork;
    this.failures = new FailureNotifier(messenger, opts.failureNotices, (kind) => this.holdSentence(kind));
  }

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product", replyTo?: string, extra: Pick<Job, "title" | "pr" | "fixRound" | "reviewOf" | "permits" | "designLoop" | "designRound" | "designFinal" | "awaitDeploy" | "depth"> = {}): Job {
    // Only the executive assistant has permits, and only drafts and holds exist.
    extra = { ...extra };
    if (kind !== "ea") delete extra.permits;
    else if (extra.permits) extra.permits = [...new Set(extra.permits)].filter((p) => p === "drafts" || p === "holds");
    // Only research has a depth; unlabelled research (a scheduled run, say) takes it from the brief.
    if (kind !== "research") delete extra.depth;
    else extra.depth = extra.depth === "deep" || extra.depth === "standard" ? extra.depth : detectDepth(brief);
    const job = this.store.createJob(kind, brief, requestedBy, target, replyTo, extra);
    return this.dispatch(job);
  }

  /**
   * Runs a queued job now, or puts an engineering job in its repository's queue: behind the job holding
   * the lock, or, while the queues are held after a credit or key failure, behind the job that failed.
   * `ignoreHold` is for a job Paul explicitly asked to retry.
   */
  private dispatch(job: Job, ignoreHold = false): Job {
    const key = lockKey(job);
    if (!ignoreHold && this.capReached()) return this.blockForCap(job);
    if (key) {
      const holder = this.holder(key);
      if (holder) return this.store.updateJob(job.id, { waitingFor: holder, queuePos: this.nextQueuePos() });
      const hold = this.store.queueHold();
      if (hold && !ignoreHold) return this.store.updateJob(job.id, { waitingFor: hold.jobId, queuePos: this.nextQueuePos() });
      this.holders.set(key, job.id);
    }
    // Fire and forget. The webhook has already been acknowledged.
    void this.execute(job.id);
    return this.store.getJob(job.id) ?? job;
  }

  /** Spend on jobs that finished today (London), in dollars. */
  spentToday(): number {
    return this.spendOn(londonYmd(new Date(this.now()))).total;
  }

  /** Jobs that finished on a London day with a recorded cost, and their total in dollars. The one place spend is summed. */
  spendOn(ymd: string): { total: number; jobs: Job[] } {
    const jobs = this.store.allJobs().filter((j) => j.finishedAt && j.costUsd && londonYmd(new Date(j.finishedAt)) === ymd);
    return { total: jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0), jobs };
  }

  /** True when today's spend is at or past the daily cap and /resume has not lifted it for today. */
  capReached(): boolean {
    const today = londonYmd(new Date(this.now()));
    return this.store.capDays().liftedOn !== today && this.spentToday() >= config.dailyBudgetUsd;
  }

  /** Leaves a job queued because of the cap, and tells Paul the first time each London day. */
  private blockForCap(job: Job): Job {
    const key = lockKey(job);
    const holder = key ? this.holder(key) : undefined;
    const blocked = this.store.updateJob(job.id, { status: "queued", capBlocked: true, ...(key ? { waitingFor: holder ?? job.id, queuePos: this.nextQueuePos() } : {}) });
    this.noticeCap(blocked);
    return blocked;
  }

  private noticeCap(blocked: Job): void {
    const today = londonYmd(new Date(this.now()));
    if (this.store.capDays().notifiedOn !== today) {
      this.store.setCapDays({ notifiedOn: today });
      const spent = this.spentToday().toFixed(2);
      void this.messenger
        .send(blocked.replyTo ?? blocked.requestedBy, `The daily spend cap of $${config.dailyBudgetUsd} is hit: $${spent} spent today, so new jobs are waiting, starting with ${jobLabel(blocked)}. Send /resume to lift it for the rest of today, or they start tomorrow.`)
        .catch(() => undefined);
    }
  }

  /** Starts jobs the cap was holding that are free to run, once it no longer applies. */
  private async releaseCapped(): Promise<void> {
    if (this.capReached()) return;
    for (const job of this.store.allJobs()) {
      if (job.status !== "queued" || !job.capBlocked) continue;
      this.store.updateJob(job.id, { capBlocked: undefined });
      if (!lockKey(job)) void this.execute(job.id);
    }
    for (const key of ["product", "self"] as JobTarget[]) await this.startNext(key);
  }

  /** The queue hold, if a credit or key failure has paused the engineering queues. */
  hold() {
    return this.store.queueHold();
  }

  /** True when a queued job is waiting for the hold to be lifted rather than for a running job. */
  isHeld(job: Pick<Job, "status" | "waitingFor">): boolean {
    const hold = this.store.queueHold();
    return !!hold && job.status === "queued" && !!job.waitingFor && this.store.getJob(job.waitingFor)?.status !== "running";
  }

  /** The sentence the failure message carries about the hold: how many queued jobs are waiting. */
  private holdSentence(kind: FailureKind): string {
    if (!HOLD_KINDS.includes(kind) || !this.store.queueHold()) return "";
    const n = this.waiting("product").length + this.waiting("self").length;
    return n
      ? `I have paused the engineering queue so the ${n === 1 ? "job" : `${n} jobs`} waiting in it ${n === 1 ? "does" : "do"} not fail the same way.`
      : "I have paused the engineering queue so nothing else fails the same way.";
  }

  /**
   * Puts a failed job back to work under the same id, title and links (pull request, review, loop), as
   * if it had just been started. Paul asked for it, so it runs even while the queues are held.
   */
  retry(id: string): Job {
    const job = this.store.getJob(id);
    if (!job) throw new Error(`No job ${id}.`);
    if (job.status !== "failed") throw new Error(`${jobRef(job, id)} is ${job.status}, not failed, so there is nothing to retry.`);
    const reset = this.store.updateJob(id, { status: "queued", error: undefined, failure: undefined, finishedAt: undefined, waitingFor: undefined, queuePos: undefined, resumed: undefined });
    return this.dispatch(reset, true);
  }

  /**
   * Lifts the queue hold once Paul has fixed the cause, reruns the jobs that failed (those named, or by
   * default every job that failed on credit or a rejected key during this outage) and restarts both
   * repositories' queues. Retried engineering jobs go to the front of their queue, oldest first.
   */
  async resume(ids?: string[]): Promise<{ retried: Job[]; skipped: string[]; released: boolean }> {
    const hold = this.store.queueHold();
    this.store.setQueueHold(undefined);
    this.store.setCapDays({ liftedOn: londonYmd(new Date(this.now())) });
    const targets = ids?.length ? ids.map((i) => i.trim().toLowerCase()).filter(Boolean) : this.outageFailures(hold).map((j) => j.id);
    const retried: Job[] = [];
    const skipped: string[] = [];
    const front = Math.min(0, ...this.store.allJobs().map((j) => j.queuePos ?? 0)) - targets.length - 1;
    targets.forEach((id, i) => {
      const job = this.store.getJob(id);
      if (!job || job.status !== "failed") {
        skipped.push(id);
        return;
      }
      const reset = { status: "queued" as const, error: undefined, failure: undefined, finishedAt: undefined, resumed: undefined };
      if (lockKey(job)) {
        // Line up first; startNext below hands each repository to the first in line.
        retried.push(this.store.updateJob(id, { ...reset, waitingFor: hold?.jobId ?? id, queuePos: front + i }));
      } else {
        retried.push(this.dispatch(this.store.updateJob(id, { ...reset, waitingFor: undefined, queuePos: undefined })));
      }
    });
    await this.releaseCapped();
    for (const key of ["product", "self"] as JobTarget[]) await this.startNext(key);
    return { retried: retried.map((j) => this.store.getJob(j.id) ?? j), skipped, released: !!hold };
  }

  /** Jobs that failed on the hold's cause during this outage (or on credit or a key in the last day). */
  private outageFailures(hold: ReturnType<Store["queueHold"]>): Job[] {
    const since = hold ? Date.parse(hold.since) - 60_000 : Date.now() - 24 * 3_600_000;
    const kinds: FailureKind[] = hold ? [hold.kind] : HOLD_KINDS;
    return this.store
      .allJobs()
      .filter((j) => j.status === "failed" && j.failure && kinds.includes(j.failure) && Date.parse(j.finishedAt ?? j.createdAt) >= since)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Starts a design loop on the product: design round 1 now; each merged spec leads to the next round
   * once the deploy is live. `continueFrom` (any job of a paused loop) carries on that loop, same round,
   * with the founder's decision in the brief.
   */
  startDesignLoop(goal: string, requestedBy: string, replyTo?: string, continueFrom?: string, title?: string): Job {
    const prev = continueFrom ? this.store.getJob(continueFrom) : undefined;
    if (continueFrom && !prev?.designLoop) throw new Error(`Job ${continueFrom} is not part of a design loop`);
    if (prev?.designLoop) {
      // Only a loop that stopped to wait for Paul carries on; a running one would get a second build.
      if (!this.store.getJob(prev.designLoop)?.designPaused) {
        throw new Error(`Design loop ${prev.designLoop} is not paused (it is still running or has finished), so there is nothing to carry on. Start a new loop for more rounds.`);
      }
      this.store.updateJob(prev.designLoop, { designPaused: false });
    }
    if (!prev?.designLoop) {
      // The loop's first job carries the loop's title; later rounds are "Design round 2: <title>".
      const job = this.store.createJob("design", designBrief(goal, 1), requestedBy, "product", replyTo, { title: title ?? deriveTitle(goal, "design"), designRound: 1, designGoal: goal });
      this.store.updateJob(job.id, { designLoop: job.id });
      void this.execute(job.id);
      return job;
    }
    // Whichever job of the loop was named, carry on from its latest design round.
    const latest = this.store
      .allJobs()
      .filter((j) => j.kind === "design" && j.designLoop === prev.designLoop)
      .sort((a, b) => (a.designRound ?? 0) - (b.designRound ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .at(-1) ?? prev;
    const loopGoal = this.store.getJob(prev.designLoop)?.designGoal ?? goal;
    const round = latest.designRound ?? 1;
    const loopTitle = jobTitle(this.store.getJob(prev.designLoop) ?? latest);
    return this.start("design", designBrief(loopGoal, round, { decision: goal, previous: latest.id, final: latest.designFinal }), requestedBy, "product", replyTo ?? latest.replyTo, {
      title: designRoundTitle(loopTitle, round, latest.designFinal),
      designLoop: prev.designLoop,
      designRound: round,
      designFinal: latest.designFinal,
    });
  }

  /**
   * The job holding a repository's lock. A job a previous process left running still holds it
   * until resumeInterrupted() has dealt with it, so a request that arrives during boot queues.
   */
  holder(key: JobTarget): string | undefined {
    const held = this.holders.get(key);
    if (held) return held;
    return this.store.allJobs().find((j) => j.status === "running" && lockKey(j) === key && !this.running.has(j.id))?.id;
  }

  /** Jobs waiting for a repository's lock, first in line first. */
  waiting(key: JobTarget): Job[] {
    return this.store
      .allJobs()
      .filter((j) => j.status === "queued" && j.waitingFor && lockKey(j) === key)
      .sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0) || a.createdAt.localeCompare(b.createdAt));
  }

  /** 1 for the next job to start on its repository, 2 for the one after, and so on. */
  queuePosition(id: string): number | undefined {
    const job = this.store.getJob(id);
    const key = job && lockKey(job);
    if (!key || !job.waitingFor) return undefined;
    const i = this.waiting(key).findIndex((j) => j.id === id);
    return i < 0 ? undefined : i + 1;
  }

  private nextQueuePos(): number {
    return Math.max(0, ...this.store.allJobs().map((j) => j.queuePos ?? 0)) + 1;
  }

  /** Hands a free repository lock to the first job in its queue and starts it. */
  private async startNext(key: JobTarget, finished?: string): Promise<void> {
    if (this.holders.has(key)) return;
    // Held after a credit or key failure: the queue waits for /resume instead of failing job after job.
    if (this.store.queueHold()) return;
    const [next, ...rest] = this.waiting(key);
    if (!next) return;
    if (this.capReached()) {
      this.store.updateJob(next.id, { capBlocked: true });
      this.noticeCap(next);
      return;
    }
    this.store.updateJob(next.id, { capBlocked: undefined });
    this.holders.set(key, next.id);
    this.store.updateJob(next.id, { waitingFor: undefined, queuePos: undefined });
    for (const j of rest) this.store.updateJob(j.id, { waitingFor: next.id });
    void this.execute(next.id);
    const done = finished ? this.store.getJob(finished) : undefined;
    const after = finished ? `, now that ${jobRef(done, finished)} has ${done?.status === "failed" ? "stopped" : "finished"}` : "";
    await this.messenger
      .send(next.replyTo ?? next.requestedBy, `Starting: ${jobLabel(next)} (was queued)${after}.`)
      .catch(() => undefined);
  }

  /**
   * A deploy restarts the process, and a job that was running dies with it. The working
   * folders live on the volume, so the job is re-queued with a note to inspect the repo
   * state and carry on rather than start again. Jobs that were waiting for a repository's
   * lock stay in the queue in order; at most one job per repository is started. Called once on boot.
   */
  async resumeInterrupted(): Promise<number> {
    const jobs = this.store
      .interruptedJobs()
      // Anything this process already started (a request that arrived during boot) is not interrupted.
      .filter((j) => !this.running.has(j.id) && !j.waitingFor)
      // Jobs that were running reclaim their repository before ones that had not started yet.
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) await this.reclaim(job, "restart");
    // A repository nobody reclaimed (its job gave up, or none was running) starts its queue.
    for (const key of ["product", "self"] as JobTarget[]) {
      const holder = this.holders.get(key);
      if (!holder) {
        await this.startNext(key);
        continue;
      }
      // Requests that queued during boot behind a job that has since given up now wait for the real holder.
      for (const j of this.waiting(key)) if (j.waitingFor !== holder) this.store.updateJob(j.id, { waitingFor: holder });
    }
    this.booted = true;
    return jobs.length;
  }

  /**
   * Puts a job that has no live worker back to work: after a restart, or when the watchdog finds a job
   * marked running that nothing in this process is running (an orphan). It resumes in place with a note
   * to carry on from its working folder, queues behind its repository's holder, waits for /resume while
   * the queues are held, or, after three interruptions, is stopped.
   */
  private async reclaim(job: Job, why: "restart" | "orphan"): Promise<void> {
    const label = jobLabel(job);
    const orphan = why === "orphan";
    const lead = orphan ? `${label} was marked running but no worker was alive` : `Interrupted by a restart: ${label}.`;
    const to = job.replyTo ?? job.requestedBy;
    const say = (text: string) => this.messenger.send(to, text).catch(() => undefined);
    const resumed = (job.resumed ?? 0) + 1;
    if (resumed > 3) {
      this.store.updateJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: orphan ? "Marked running with no live worker after three interruptions; giving up." : "Interrupted by restarts three times; giving up.",
        ...(orphan ? { failure: "stalled" as const } : {}),
      });
      this.pauseLoop(job.designLoop);
      await say(orphan ? `${lead}, and it had already been restarted three times, so I have stopped it; retry ${job.id} runs it again.` : `Stopped: ${label}. It was interrupted by restarts three times. Start it again when things are quiet.`);
      return;
    }
    const key = lockKey(job);
    const current = key && this.holders.get(key);
    const holder = current && current !== job.id ? current : undefined;
    const hold = this.store.queueHold();
    if (key && !holder && hold) {
      // The queues are held after a credit or key failure: wait for /resume rather than fail again.
      this.store.updateJob(job.id, { status: "queued", resumed, waitingFor: hold.jobId, queuePos: this.nextQueuePos() });
      if (this.holders.get(key) === job.id) this.holders.delete(key);
      await say(orphan ? `${lead}, so I put it back in the queue, which is paused until you send /resume because ${failureReason(hold)}.` : `${lead} The engineering queue is paused because ${failureReason(hold)}, so it waits; send /resume once that is fixed.`);
      return;
    }
    if (key && holder) {
      // Another job on this repository has already reclaimed it: wait behind it.
      this.store.updateJob(job.id, { status: "queued", resumed, waitingFor: holder, queuePos: this.nextQueuePos() });
      const ref = jobRef(this.store.getJob(holder), holder);
      await say(orphan ? `${lead}, so I put it back in the queue behind ${ref}.` : `${lead} Queued behind ${ref}; it resumes when that finishes.`);
      return;
    }
    if (key) this.holders.set(key, job.id);
    this.store.updateJob(job.id, { status: "queued", resumed });
    await say(orphan ? `${lead}, so I restarted it to carry on from where it left off (attempt ${resumed + 1}).` : `${lead} Resuming it (attempt ${resumed + 1}).`);
    void this.execute(job.id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  private async execute(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) return;
    const now = this.now();
    let settle = () => {};
    const settled = new Promise<void>((r) => (settle = r));
    const live: LiveRun = { abort: new AbortController(), startedAt: now, lastActivity: now, persistedAt: now, waiting: !!job.awaitDeploy, finishing: false, settled, settle };
    this.live.set(id, live);
    this.running.add(id);
    const at = new Date(now).toISOString();
    this.store.updateJob(id, { status: "running", startedAt: at, lastActivityAt: at });
    try {
      // A design round after a merge looks only once the product's deploy of that merge is live.
      if (job.awaitDeploy) {
        await this.waitForDeploy(new Date(job.createdAt));
        // The work starts now: the runtime and the heartbeat count from here.
        live.waiting = false;
        live.startedAt = live.lastActivity = live.persistedAt = this.now();
        const t = new Date(live.startedAt).toISOString();
        this.store.updateJob(id, { startedAt: t, lastActivityAt: t });
      }
      if (live.stop) throw new Error("stopped");
      const spec = workerSpec(job.kind, job.target);
      const perJob = spec.perJob?.(id) ?? {};
      // Engineers building a design spec may read the designer's assets.
      const dirs = perJob.additionalDirectories ?? (job.designLoop ? [...readableDirs(), designRoot()] : undefined);
      // Each kind's own tool servers only: a design job never gets the ea's Google server, and only a
      // design job gets the design server (it comes from the design spec alone).
      const fromService = job.kind === "design" ? undefined : this.toolsFor(job);
      const extraTools = fromService ? Object.fromEntries(Object.entries(fromService).filter(([name]) => name !== "design")) : undefined;
      const ownTools = job.kind === "design" ? perJob.mcpServers : undefined;
      const notes = this.store.notes();
      const standing = notes.length ? `\n\nStanding instructions from the founder:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
      const resume = job.resumed
        ? `\n\nThis job was interrupted by a service restart and is being resumed (attempt ${job.resumed + 1}). Work from a previous attempt may exist: check the working directory, git status and branches before doing anything, keep what is good, and continue from there rather than starting again.`
        : "";
      const carryOn = job.savedWork ? `\n\n${savedWorkNote(job.savedWork)}` : "";
      const link = job.kind === "ea" ? bookingLink(this.store) : undefined;
      const permits =
        job.kind === "ea"
          ? `\n\nThis job may change: ${job.permits?.length ? job.permits.join(" and ") : "nothing (read only)"}.${link ? ` Paul's booking link for scheduling drafts: ${link}` : ""}`
          : "";
      const depth = job.kind === "research" && job.depth === "deep" ? `\n\n${DEEP_RESEARCH_NOTE}` : "";
      // Every run is capped; deep research gets more turns and budget than the default.
      const limits = runLimits(job.kind, job.depth);
      const result = await this.run({
        prompt: `${job.brief}${permits}${depth}${standing}${resume}${carryOn}`,
        systemPrompt: spec.prompt,
        model: spec.model,
        cwd: spec.cwd,
        allowedTools: spec.allowedTools,
        disallowedTools: spec.disallowedTools,
        tools: spec.tools,
        agents: spec.agents,
        mcpServers: ownTools || extraTools ? { ...extraTools, ...ownTools } : undefined,
        additionalDirectories: dirs,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,
        abortController: live.abort,
        onActivity: () => this.touch(id, live),
      });
      // Stopped (stalled, too long, cancelled) while it ran: whatever came back is not the job's result.
      if (live.stop) throw new Error("stopped");
      live.finishing = true;
      // An API or SDK error (no credit, a rejected key, overload after retries, no output) is not work:
      // it is recorded as failed, and nothing follows it (no review, no fix round, no "Finished").
      const failed = runFailure(result);
      if (failed) {
        if (result.costUsd !== undefined) this.store.updateJob(id, { costUsd: result.costUsd });
        throw new RunFailedError(failed);
      }
      // The full report (verdict lines and all) is the saved output; Paul sees only the short message.
      const { report, message } = splitReport(result.text);
      const outputPath = this.store.writeOutput(id, report);
      this.store.updateJob(id, {
        status: "done",
        finishedAt: new Date().toISOString(),
        summary: message,
        outputPath,
        costUsd: result.costUsd,
      });
      // An engineer's pull request is reviewed by the maintainer without anyone asking. The
      // maintainer is not an engineering kind, so it runs at once and never waits for the lock.
      let chained = "";
      let escalation: string | undefined;
      if (job.kind === "engineer") {
        // A fix round already knows its pull request; a fresh job's is read from its report.
        const pr = job.pr ?? findPrUrl(report);
        if (pr && !job.pr) this.store.updateJob(id, { pr });
        const which = pr ? `the pull request ${pr}, which the engineer just ${job.fixRound ? "updated to address your last review" : "opened for this task"}` : "the pull request just opened by the engineer for this task";
        const m = this.start(
          "maintain",
          `Review ${which}, and any other open pull requests:\n\n${job.brief}\n\nEngineer's report:\n${report}`,
          job.requestedBy,
          job.target,
          job.replyTo,
          { title: reviewTitle(job), reviewOf: id, pr },
        );
        chained = `Started ${jobLabel(m)} to review and merge.`;
      }
      // So is the agent-creator's, on the workforce repo. Only an explicit schedule verdict (no code
      // written) skips the maintainer; a missing or garbled verdict still gets a review.
      if (job.kind === "create_agent") {
        if (isScheduleVerdict(report)) {
          const rec = scheduleRecommendation(report);
          chained = `No code needed: it fits ${rec.kind ? `a ${rec.kind} job` : "an existing kind"}${rec.cron ? ` on the schedule ${rec.cron}` : ""}. Say "set it up" and I will schedule it.`;
        } else {
          const m = this.start(
            "maintain",
            `Review the pull request just opened by the agent-creator, which adds a new worker kind to this workforce, and any other open pull requests. Check in particular that the new kind's prompt carries the clean-room rule, its tools are least-privilege (no Edit, Write or unrestricted Bash unless it is an engineer, nothing that sends, posts, signs or pays), and the invariant tests were extended, not weakened:\n\n${job.brief}\n\nAgent-creator's report:\n${report}`,
            job.requestedBy,
            "self",
            job.replyTo,
            { title: reviewTitle(job), reviewOf: id, pr: findPrUrl(report) },
          );
          chained = `Started ${jobLabel(m)} to review and merge.`;
        }
      }
      // Close the review loop: changes requested on the reviewed job's pull request go back to an
      // engineer, up to MAX_FIX_ROUNDS; anything only the founder can unblock is put to him once.
      if (job.kind === "maintain" && job.reviewOf) {
        const next = this.afterReview(job, report);
        chained = next.chained;
        escalation = next.escalation;
      }
      if (job.kind === "design" && job.designLoop) {
        const next = this.afterDesign(job, report);
        chained = next.chained;
        escalation = next.escalation;
      }
      await this.messenger.send(
        job.replyTo ?? job.requestedBy,
        finishedText(job, message, chained),
      );
      if (job.kind === "design") await this.sendImages(job, report);
      if (escalation) await this.messenger.send(job.replyTo ?? job.requestedBy, escalation);
    } catch (err) {
      if (live.stop) await this.recordStop(job, live);
      else await this.recordFailure(job, failureFromError(err));
    } finally {
      // A worker that would not let go after a stop was already finished without it; nothing more here.
      const mine = this.live.get(id) === live;
      if (mine) {
        this.live.delete(id);
        this.running.delete(id);
      }
      live.settle();
      // Success, failure, error or stop: free the repository and start whoever is next in line.
      if (mine) await this.release(job);
    }
  }

  /** Frees the repository a job holds and starts whoever is next in line. */
  private async release(job: Job): Promise<void> {
    const key = lockKey(job);
    if (key && this.holders.get(key) === job.id) {
      this.holders.delete(key);
      await this.startNext(key, job.id);
    }
  }

  /** The heartbeat: the worker did something. Kept exactly in memory, written to the store at most once a minute. */
  private touch(id: string, live: LiveRun): void {
    const now = this.now();
    live.lastActivity = now;
    if (now - live.persistedAt < MINUTE || !this.store.getJob(id)) return;
    live.persistedAt = now;
    this.store.updateJob(id, { lastActivityAt: new Date(now).toISOString() });
  }

  /**
   * Stops a running job: aborts its worker, keeps its work, records why and frees its repository. A
   * worker that does not let go within the grace period is left behind and the job is finished
   * without it, so a hung process can never hold the queue.
   */
  private async stop(id: string, reason: StopReason): Promise<boolean> {
    const live = this.live.get(id);
    if (!live || live.stop || live.finishing) return false;
    live.stop = reason;
    live.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([live.settled.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.graceMs)))]);
    clearTimeout(timer);
    if (!settled && this.live.get(id) === live) {
      this.live.delete(id);
      this.running.delete(id);
      const job = this.store.getJob(id);
      if (job) {
        await this.recordStop(job, live);
        await this.release(job);
      }
    }
    return true;
  }

  /** Records a stopped job: its work kept, failed with the reason, its loop paused, Paul told in one sentence. */
  private async recordStop(job: Job, live: LiveRun): Promise<void> {
    const reason = live.stop;
    if (!reason || live.recorded) return;
    live.recorded = true;
    let saved: SavedWork | undefined;
    if (lockKey(job)) {
      saved = await this.saveWork(job, reason.kind).catch((err) => {
        console.warn(`could not keep the work of job ${job.id}: ${err instanceof Error ? err.message : err}`);
        return undefined;
      });
    }
    const failure = { kind: reason.kind, detail: reason.detail };
    const kept = saved ? `\n\n${savedWorkNote(saved)}` : "";
    const outputPath = this.store.writeOutput(job.id, `This job was stopped and did not finish, because ${failureReason(failure)}.\n\n${reason.detail}${kept}\n`);
    this.store.updateJob(job.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: reason.detail,
      failure: reason.kind,
      outputPath,
      summary: `Stopped (${failureLabel(reason.kind)}): ${shortText(reason.detail, 200)}`,
      ...(saved ? { savedWork: saved } : {}),
    });
    this.pauseLoop(job.designLoop);
    const notice = reason.notice?.(this.store.getJob(job.id) ?? job, saved);
    if (notice) await this.messenger.send(job.replyTo ?? job.requestedBy, notice).catch(() => undefined);
  }

  /**
   * The watchdog, run every minute. Stops a job whose worker has shown no activity for the stall limit
   * or has run past the maximum runtime; puts back to work a job marked running that no worker here is
   * running (it resumes, or is stopped after three interruptions); and starts any repository queue whose
   * lock is free. Each stop keeps the job's work and tells Paul in one sentence.
   */
  async checkLiveness(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = this.now();
      for (const [id, live] of [...this.live]) {
        if (live.stop || live.waiting || live.finishing) continue;
        const idle = now - live.lastActivity;
        const ran = now - live.startedAt;
        if (idle >= this.stallMs) {
          const mins = minutes(idle);
          await this.stop(id, {
            kind: "stalled",
            detail: `No activity from its worker for ${plural(mins, "minute")} (the limit is ${plural(minutes(this.stallMs), "minute")}).`,
            notice: (job, saved) => `${jobLabel(job)} showed no activity for ${plural(mins, "minute")}, so I stopped it${this.afterStop(job, saved)}.`,
          });
        } else if (ran >= this.maxRuntimeMs) {
          const mins = minutes(ran);
          await this.stop(id, {
            kind: "timeout",
            detail: `Ran for ${plural(mins, "minute")}, past the maximum runtime of ${plural(minutes(this.maxRuntimeMs), "minute")}.`,
            notice: (job, saved) => `${jobLabel(job)} ran for ${duration(ran)}, past the limit of ${duration(this.maxRuntimeMs)}, so I stopped it${this.afterStop(job, saved)}.`,
          });
        }
      }
      // Before boot has resumed the interrupted jobs, a job marked running is the previous process's.
      if (!this.booted) return;
      for (const job of this.store.allJobs()) {
        const lost = job.status === "running" || (job.status === "queued" && !job.waitingFor && !job.capBlocked);
        if (lost && !this.running.has(job.id)) await this.reclaim(this.store.getJob(job.id) ?? job, "orphan");
      }
      await this.releaseCapped();
      for (const key of ["product", "self"] as JobTarget[]) {
        const held = this.holders.get(key);
        // A lock held by a job nothing is running frees itself.
        if (held && !this.running.has(held)) this.holders.delete(key);
        const holder = this.holders.get(key);
        if (!holder) await this.startNext(key);
        else for (const j of this.waiting(key)) if (j.waitingFor !== holder && !this.isHeld(j)) this.store.updateJob(j.id, { waitingFor: holder });
      }
    } finally {
      this.checking = false;
    }
  }

  /** Runs the watchdog every minute (by default) until the returned function is called. */
  startWatchdog(intervalMs = MINUTE): () => void {
    const timer = setInterval(() => {
      this.checkLiveness().catch((err) => console.warn(`liveness check failed: ${err instanceof Error ? err.message : err}`));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The rest of the stop sentence: what happened to the work and to the queue, and how to carry on. */
  private afterStop(job: Job, saved: SavedWork | undefined): string {
    const key = lockKey(job);
    const next = key ? this.waiting(key)[0] : undefined;
    const work = saved?.stash ? ", kept its unfinished work" : "";
    const queue = next && !this.store.queueHold() ? ` and started ${jobRef(next, next.id)}, next in the queue` : "";
    return `${work}${queue}; retry ${job.id} carries on from where it got to`;
  }

  /**
   * Whether a job is actually alive: a worker in this process is running it and has shown activity
   * recently. For the chief's job_alive and job_status, when Paul says nothing seems to be running.
   */
  liveness(id: string): Liveness | undefined {
    const job = this.store.getJob(id);
    if (!job) return undefined;
    const live = this.live.get(id);
    const now = this.now();
    const base = { id, status: job.status, stallAfterMinutes: minutes(this.stallMs), maxRuntimeMinutes: minutes(this.maxRuntimeMs) };
    const label = jobLabel(job);
    if (live) {
      const idle = now - live.lastActivity;
      const ran = now - live.startedAt;
      const info = { ...base, lastActivityAt: new Date(live.lastActivity).toISOString(), idleMinutes: minutes(idle), runningMinutes: minutes(ran) };
      if (live.waiting) return { ...info, alive: true, waitingForDeploy: true, summary: `${label} is alive, waiting for the product deploy before it starts.` };
      if (live.stop) return { ...info, alive: false, summary: `${label} is being stopped (${failureLabel(live.stop.kind)}).` };
      const alive = idle < this.stallMs;
      const last = idle < MINUTE ? "under a minute ago" : `${plural(minutes(idle), "minute")} ago`;
      return {
        ...info,
        alive,
        summary: alive
          ? `${label} is alive: its worker last did something ${last}, and it has been running for ${duration(ran)}.`
          : `${label} looks stalled: no activity for ${plural(minutes(idle), "minute")}; the watchdog stops it at ${plural(minutes(this.stallMs), "minute")}.`,
      };
    }
    if (job.status === "running") {
      const last = job.lastActivityAt ? ` (last activity ${job.lastActivityAt})` : "";
      return { ...base, alive: false, lastActivityAt: job.lastActivityAt, summary: `${label} is marked running but no worker is alive${last}; the watchdog will restart it or stop it within a minute, or cancel_job frees its place now.` };
    }
    if (job.status === "queued") {
      const pos = this.queuePosition(id);
      const behind = job.waitingFor ? (this.isHeld(job) ? ", held until /resume" : `, behind ${jobRef(this.store.getJob(job.waitingFor), job.waitingFor)}${pos ? ` (#${pos} on ${lockKey(job)})` : ""}`) : "";
      return { ...base, alive: false, summary: `${label} has not started yet: it is queued${behind}.` };
    }
    return { ...base, alive: false, lastActivityAt: job.lastActivityAt, summary: `${label} is ${job.status}${job.finishedAt ? ` (since ${job.finishedAt})` : ""}; nothing is running for it.` };
  }

  /**
   * Cancels a job at Paul's request: a queued job leaves the queue; a running one has its worker stopped,
   * its work kept and its repository handed to the next in line. Returns one plain sentence.
   */
  async cancel(id: string): Promise<string> {
    const job = this.store.getJob(id);
    if (!job) throw new Error(`No job ${id}.`);
    const label = jobLabel(job);
    if (job.status === "done" || job.status === "failed") throw new Error(`${label} is already ${job.status}, so there is nothing to cancel.`);
    const reason: StopReason = { kind: "cancelled", detail: "Cancelled at Paul's request." };
    const key = lockKey(job);
    if (job.status === "queued" && !this.running.has(id)) {
      this.store.updateJob(id, { status: "failed", finishedAt: new Date().toISOString(), error: reason.detail, failure: "cancelled", summary: "Cancelled before it started.", waitingFor: undefined, queuePos: undefined });
      this.pauseLoop(job.designLoop);
      if (key && this.holders.get(key) === id) await this.release(job);
      return `Cancelled ${label} before it started; it has left the queue.`;
    }
    if (this.live.has(id)) await this.stop(id, reason);
    else {
      // Marked running, but no worker here: nothing to stop, so record it and free its place.
      const orphan: LiveRun = { abort: new AbortController(), startedAt: 0, lastActivity: 0, persistedAt: 0, waiting: false, finishing: false, stop: reason, settled: Promise.resolve(), settle: () => {} };
      await this.recordStop(job, orphan);
      if (key && this.holders.get(key) === id) await this.release(job);
      else if (key && !this.holders.get(key)) await this.startNext(key, id);
    }
    const after = this.store.getJob(id) ?? job;
    if (after.status !== "failed") return `${label} had already finished, so there was nothing to cancel.`;
    const next = key ? this.holder(key) : undefined;
    const work = after.savedWork?.stash ? ` Its unfinished work is kept (stash "${after.savedWork.stash}" on ${after.savedWork.branch ?? "its branch"}), and retry ${id} carries on from it.` : ` retry ${id} runs it again.`;
    const queue = next && next !== id ? ` ${jobRef(this.store.getJob(next), next)} has started in its place.` : "";
    return `Cancelled ${label}.${work}${queue}`;
  }

  /** Moves a queued engineering job to the front of its repository's queue, so it starts next. Returns one plain sentence. */
  moveToFront(id: string): string {
    const job = this.store.getJob(id);
    if (!job) throw new Error(`No job ${id}.`);
    const key = lockKey(job);
    if (job.status !== "queued" || !job.waitingFor || !key) throw new Error(`${jobLabel(job)} is not waiting in a queue (it is ${job.status}), so there is nothing to move.`);
    const queue = this.waiting(key);
    if (queue[0]?.id === id) return `${jobLabel(job)} is already first in the ${key} queue.`;
    const front = Math.min(...queue.map((j) => j.queuePos ?? 0)) - 1;
    this.store.updateJob(id, { queuePos: front });
    const holder = this.holder(key);
    const when = this.isHeld(job) ? "once the queue is resumed" : holder ? `when ${jobRef(this.store.getJob(holder), holder)} finishes` : "next";
    return `Moved ${jobLabel(job)} to the front of the ${key} queue; it starts ${when}.`;
  }

  /**
   * A job that did no work: marked failed with the reason (job_status, /jobs and its saved output say
   * why), its design loop paused, and Paul told. API failures are batched into one message per burst;
   * credit and key failures also hold the engineering queues until Paul says /resume.
   */
  private async recordFailure(job: Job, failure: RunFailure): Promise<void> {
    const finishedAt = new Date().toISOString();
    const reason = failureReason(failure);
    const outputPath = this.store.writeOutput(job.id, `This job failed and did no work, because ${reason}.\n\nError: ${failure.detail}\n`);
    this.store.updateJob(job.id, { status: "failed", finishedAt, error: failure.detail, failure: failure.kind, outputPath, summary: `Failed (${failureLabel(failure.kind)}): ${shortText(failure.detail, 200)}` });
    // A failed round leaves its loop waiting for Paul rather than stalled for good.
    this.pauseLoop(job.designLoop);
    if (HOLD_KINDS.includes(failure.kind) && !this.store.queueHold()) {
      this.store.setQueueHold({ kind: failure.kind, jobId: job.id, since: finishedAt, detail: failure.detail });
    }
    const current = this.store.getJob(job.id) ?? job;
    if (failure.kind === "error") {
      // Something in the service threw (not the API): one job, said at once, as before.
      await this.messenger.send(job.replyTo ?? job.requestedBy, `Failed: ${jobLabel(current)}. ${shortText(failure.detail)}`).catch(() => undefined);
      return;
    }
    this.failures.add(current, failure);
  }

  /**
   * Decides what follows a maintainer review of an engineering job's pull request. Only the reviewed
   * job's own pull request counts; other pull requests the maintainer looked at are reported as usual.
   */
  private afterReview(review: Job, text: string): { chained: string; escalation?: string } {
    const reviewed = review.reviewOf ? this.store.getJob(review.reviewOf) : undefined;
    if (!reviewed) return { chained: "" };
    const verdicts = parseReviewVerdicts(text);
    const pr = review.pr ?? reviewed.pr;
    const verdict = pr ? verdicts.find((v) => samePr(v.pr, pr)) : verdicts.length === 1 ? verdicts[0] : undefined;
    if (!verdict) {
      // A design loop must not stall silently.
      this.pauseLoop(reviewed.designLoop);
      return reviewed.designLoop
        ? { chained: "", escalation: `Design loop ${this.loopRef(reviewed.designLoop)} is paused: the maintainer gave no verdict on ${pr ?? "the round's pull request"}. Tell me to re-review it, or to carry on the loop.` }
        : { chained: "" };
    }
    if (verdict.outcome === "merged") return reviewed.designLoop ? this.nextDesignRound(reviewed, verdict.pr) : { chained: "" };
    const url = verdict.pr;
    const target = lockKey(reviewed) ?? reviewed.target ?? "product";
    if (verdict.outcome === "needs_founder") {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: "",
        escalation: `Action needed from you on ${url}: ${verdict.detail ? shortText(verdict.detail, 400) : `the maintainer says only you can unblock it (show job ${review.id} has why).`}\nOnce that is done, tell me and I will have it re-reviewed.`,
      };
    }
    const round = (reviewed.kind === "engineer" ? reviewed.fixRound ?? 0 : 0) + 1;
    if (round > MAX_FIX_ROUNDS) {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: "",
        escalation: `${url} is still not mergeable after ${MAX_FIX_ROUNDS} automatic fix rounds, so I have stopped. The blocking issues are in the last review (show job ${review.id}). Reply "one more fix round on ${url}" to try again, give me a steer on where it is stuck, or close the pull request.`,
      };
    }
    const fix = this.start(
      "engineer",
      `Address the maintainer's review on the existing pull request ${url} (automatic fix round ${round} of ${MAX_FIX_ROUNDS}). Check out that pull request's branch, bring it up to date with the default branch, fix every blocking issue in the review, run the tests and typecheck, push to the same branch and reply to each review comment with gh. Read the review itself with gh pr view ${url} --comments. Do not open a new pull request. If a blocker can only be resolved by the founder (a secret, a GitHub or hosting setting, account access, a product decision), do everything else and say so plainly in your report.\n\nOriginal task:\n${reviewed.brief}\n\nMaintainer's review (job ${review.id}):\n${text}`,
      reviewed.requestedBy,
      target,
      reviewed.replyTo,
      { title: fixTitle(jobTitle(reviewed), round), pr: url, fixRound: round, designLoop: reviewed.designLoop, designRound: reviewed.designRound },
    );
    return { chained: `Changes requested on ${url}. Started ${jobLabel(fix)} to fix them (round ${round} of ${MAX_FIX_ROUNDS}${this.queuedText(fix)}); it is re-reviewed automatically.` };
  }

  /**
   * What follows a design-loop round. A spec goes to an engineer on the product (queued like any
   * engineering job and reviewed by the maintainer as usual); a decision only the founder can make is
   * put to him once; a clean critique, or the closing round, ends the loop with a report.
   */
  private afterDesign(job: Job, text: string): { chained: string; escalation?: string } {
    const loop = job.designLoop!;
    const round = job.designRound ?? 1;
    const verdict = parseDesignVerdict(text);
    if (verdict?.outcome === "needs_founder") {
      this.pauseLoop(loop);
      return {
        chained: "",
        escalation: `Design decision for you on ${this.loopRef(loop)}, round ${round}: ${verdict.detail ? shortText(verdict.detail, 400) : `show job ${job.id} has the options.`}\nReply with your choice and I will carry on from there.`,
      };
    }
    if (job.designFinal || verdict?.outcome === "done") {
      const clean = verdict?.outcome === "done";
      const built = job.designFinal ? MAX_DESIGN_ROUNDS : round - 1;
      const why = clean ? "the customer critiques found no high-impact issues" : "that was the last round";
      return { chained: `Design loop ${this.loopRef(loop)} finished after ${built} implemented round${built === 1 ? "" : "s"}: ${why}.` };
    }
    if (verdict?.outcome !== "spec") {
      this.pauseLoop(loop);
      return { chained: "", escalation: `Design loop ${this.loopRef(loop)} is paused: round ${round} ended without a spec or a verdict. Tell me to carry on, or give a steer.` };
    }
    const eng = this.start(
      "engineer",
      `Implement this design spec on the Clear Exchange product (design loop ${loop}, round ${round} of ${MAX_DESIGN_ROUNDS}). Build exactly what it specifies, keeping the product's existing constraints, tests and security headers; where the spec conflicts with them, keep the constraint and say so in the pull request. Assets the designer saved (SVG, CSS, JSON) are in ${designRoot()}/${job.id}/ and you may copy them into the repository. Put before and after screenshots, desktop and mobile, in the pull request description if you can produce them. Open one pull request; the maintainer reviews and merges it, and the designer then reviews the deployed result.\n\nDesign job ${job.id}'s report and spec:\n${text}`,
      job.requestedBy,
      "product",
      job.replyTo,
      { title: buildTitle(this.loopTitle(loop), round), designLoop: loop, designRound: round },
    );
    return { chained: `Spec ready. Started ${jobLabel(eng)} to build it (design round ${round} of ${MAX_DESIGN_ROUNDS}${this.queuedText(eng)}); after the merge and deploy, the designer reviews the live site again.` };
  }

  /** ", queued behind Fly deploy (16d5d3)" for a job waiting for its repository, otherwise nothing. */
  private queuedText(job: Job): string {
    return job.waitingFor ? `, queued behind ${jobRef(this.store.getJob(job.waitingFor), job.waitingFor)}` : "";
  }

  /** The title of a design loop: its first job's. */
  private loopTitle(loop: string): string {
    const first = this.store.getJob(loop);
    return first ? jobTitle(first) : "Design loop";
  }

  /** "Customer-ready site (3fa9c1)", for naming a design loop in a message. */
  private loopRef(loop: string): string {
    return jobRef(this.store.getJob(loop), loop);
  }

  /** Marks a design loop as waiting for Paul, so start_job with continueLoop may carry it on. */
  private pauseLoop(loop: string | undefined): void {
    if (loop && this.store.getJob(loop)) this.store.updateJob(loop, { designPaused: true });
  }

  /** A design-loop pull request merged: the next round looks at the deployed site once it is live. */
  private nextDesignRound(reviewed: Job, pr: string): { chained: string } {
    const loop = reviewed.designLoop!;
    const round = (reviewed.designRound ?? 1) + 1;
    const final = round > MAX_DESIGN_ROUNDS;
    const goal = this.store.getJob(loop)?.designGoal ?? "";
    const d = this.start("design", designBrief(goal, round, { merged: pr, final }), reviewed.requestedBy, "product", reviewed.replyTo, {
      title: designRoundTitle(this.loopTitle(loop), round, final),
      designLoop: loop,
      designRound: round,
      designFinal: final || undefined,
      awaitDeploy: true,
    });
    return { chained: `${pr} merged. ${jobLabel(d)} will ${final ? "run the closing customer critique" : `start round ${round}`} once the deploy is live.` };
  }

  /** Shows the founder the images the designer picked, where the channel can carry them. */
  private async sendImages(job: Job, text: string): Promise<void> {
    if (!this.messenger.sendImage) return;
    const to = job.replyTo ?? job.requestedBy;
    for (const img of reportImages(job.id, text)) {
      await this.messenger.sendImage(to, img.file, img.caption).catch((err) => console.warn(`image not sent: ${err instanceof Error ? err.message : err}`));
    }
  }
}

/**
 * The brief for one design-loop round. Round 1 starts from the founder's goal; later rounds look at
 * what was merged and deployed; the closing round critiques only. Exported for tests.
 */
export function designBrief(goal: string, round: number, o: { merged?: string; final?: boolean; decision?: string; previous?: string } = {}): string {
  const head = o.final
    ? `Design loop, closing review after ${MAX_DESIGN_ROUNDS} implemented rounds. The last change (${o.merged ?? "the latest pull request"}) has merged and deployed.`
    : round === 1
      ? `Design loop, round 1 of ${MAX_DESIGN_ROUNDS}.`
      : `Design loop, round ${round} of ${MAX_DESIGN_ROUNDS}. The previous round's spec was built in ${o.merged ?? "a pull request"}, which has merged and deployed.`;
  const task = o.final
    ? `Screenshot the live site at desktop and mobile and run the customer-persona critique. Write no new spec. Report to Paul: what changed across the loop, how each persona now sees the site, and any remaining issues ranked by impact, with the best before and after images. End with DESIGN: no high-impact issues, or DESIGN: needs Paul: <decision> if something remaining is genuinely his call.`
    : `Screenshot the live site at desktop and mobile, run the customer-persona critique, and write a spec for the highest-impact issues that one engineer can build in one pull request. Earlier rounds' reports are in the outputs folder and their screenshots in the design folder; compare against them and do not re-raise what is fixed. If the critiques find no high-impact issues, say so and end with DESIGN: no high-impact issues.`;
  const decision = o.decision ? `\n\nPaul has answered the open question from job ${o.previous}: ${o.decision}\nApply his choice and carry on.` : "";
  return `${head} ${task}${decision}\n\nGoal from Paul:\n${goal}`;
}

export interface ReviewVerdict {
  pr: string;
  outcome: "merged" | "changes_requested" | "needs_founder";
  detail?: string;
}

/** Reads the maintainer's "REVIEW <url>: ..." lines (see REVIEW_VERDICT_RULES in agents.ts). */
export function parseReviewVerdicts(text: string): ReviewVerdict[] {
  const out: ReviewVerdict[] = [];
  for (const m of text.matchAll(/^[ \t>*`_-]*REVIEW[ \t]+<?(\S+?)>?[ \t]*:[ \t]*(merged|changes requested|needs Paul)\b[ \t:]*(.*)$/gim)) {
    const word = m[2].toLowerCase();
    const outcome = word === "merged" ? "merged" : word === "changes requested" ? "changes_requested" : "needs_founder";
    out.push({ pr: m[1], outcome, detail: m[3].replace(/[*`_]+$/, "").trim() || undefined });
  }
  return out;
}

/** The first GitHub pull request URL in a report. */
export function findPrUrl(text: string): string | undefined {
  return text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
}

/** Two references to the same pull request, by number ("#12", ".../pull/12"). */
export function samePr(a: string, b: string): boolean {
  const n = (s: string) => s.match(/(?:\/pull\/|#)(\d+)/)?.[1];
  return n(a) !== undefined && n(a) === n(b);
}

/** The kind and cron the agent-creator recommends after its schedule verdict ("Kind: research", "Cron: 0 7 * * 1"). */
export function scheduleRecommendation(text: string): { kind?: string; cron?: string } {
  const field = (name: string) => text.match(new RegExp(`^[ \\t>*_-]*${name}[ \\t]*:[ \\t]*(.+)$`, "im"))?.[1].replace(/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/g, "").trim();
  const kind = field("Kind");
  return { kind: kind && /^[a-z_]+$/.test(kind) ? kind : undefined, cron: field("Cron") };
}

/** True only when the agent-creator's output opens with the schedule verdict, i.e. it wrote no code. */
export function isScheduleVerdict(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(SCHEDULE_VERDICT.toLowerCase());
}

/**
 * What Paul sees when a job finishes: which job, the worker's short plain message, what happens next,
 * and where the full report is. Never the report itself, its headings, lists or verdict lines.
 */
export function finishedText(job: Pick<Job, "id" | "title" | "brief" | "kind" | "target">, message: string, next = ""): string {
  const body = [message, next, `Full report: show job ${job.id}.`].map((s) => s.trim()).filter(Boolean).join(" ");
  return `Finished: ${jobLabel(job)}.\n${body}`;
}

/** "45 minutes", "4 hours", "2 hours 10 minutes": a duration in plain words. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return plural(m, "minute");
  return m ? `${plural(h, "hour")} ${plural(m, "minute")}` : plural(h, "hour");
}

/** What a retried job is told about the work its stopped attempt left behind. Exported for tests. */
export function savedWorkNote(saved: SavedWork): string {
  const where = `in ${saved.dir}${saved.branch ? ` on branch ${saved.branch}` : ""}`;
  return saved.stash
    ? `A previous attempt at this job was stopped before it finished. Its uncommitted work was kept ${where}, stashed with the message "${saved.stash}". Check out that branch, find the stash with git stash list, apply it with git stash apply (not pop, so it stays kept until your work is pushed), then check git status and carry on from there rather than starting again.`
    : `A previous attempt at this job was stopped before it finished, working ${where}. Check that branch and its commits before doing anything, keep what is good and carry on from there rather than starting again.`;
}

/**
 * Keeps a stopped engineering job's work so the next job in the checkout starts clean and nothing is
 * lost: notes the branch and stashes any uncommitted changes, untracked files included. Never deletes
 * anything; the stash stays until someone applies and drops it. Exported for tests.
 */
export async function stashWork(dir: string, message: string): Promise<SavedWork | undefined> {
  if (!fs.existsSync(path.join(dir, ".git"))) return undefined;
  // A stash is a commit: give it an identity in case the checkout has none configured.
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", dir, "-c", "user.name=clear-ops", "-c", "user.email=clear-ops@users.noreply.github.com", ...args], { timeout: 60_000 })).stdout.trim();
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => undefined);
  const dirty = await git("status", "--porcelain");
  if (!dirty) return { dir, branch };
  await git("stash", "push", "--include-untracked", "-m", message);
  return { dir, branch, stash: message };
}

/** The real saveWork: stash in the checkout the job's worker runs in. */
async function defaultSaveWork(job: Job, why: StopReason["kind"]): Promise<SavedWork | undefined> {
  const dir = workerSpec(job.kind, job.target).cwd;
  if (!dir) return undefined;
  return stashWork(dir, `clear-ops ${job.id}: ${jobTitle(job)} (stopped: ${why})`);
}

/* ---------- Approved actions ---------- */

export type ActionExecutor = (action: PendingAction) => Promise<string>;

/**
 * Side effects outside the workers' own remit, each behind an explicit YES from the
 * founder. The engineer merges and pushes on its own; this is for anything else.
 */
export const actionExecutors: Record<string, ActionExecutor> = {
  /** Run one shell command in the repo on the founder's behalf (a deploy, a migration). payload: { command } */
  async run_command(action) {
    const command = String(action.payload.command ?? "");
    if (!command) throw new Error("No command given");
    const { stdout, stderr } = await exec("bash", ["-lc", command], { cwd: config.repoDir, timeout: 10 * 60_000 });
    return (stdout + stderr).trim().slice(-3000) || "Done (no output)";
  },
};

export const ACTION_KINDS = Object.keys(actionExecutors);
