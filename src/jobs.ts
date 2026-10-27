import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { AgentRunner } from "./agents.js";
import { PR_KINDS, SCHEDULE_VERDICT, workerSpec } from "./agents.js";
import type { Job, JobKind, JobTarget, PendingAction, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";

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

/** Starts worker jobs in the background and reports back over WhatsApp when they finish. */
export class JobRunner {
  private running = new Set<string>();
  /** Which job holds each repository's engineering lock in this process. */
  private holders = new Map<JobTarget, string>();

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly run: AgentRunner,
  ) {}

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product", replyTo?: string): Job {
    const job = this.store.createJob(kind, brief, requestedBy, target, replyTo);
    const key = lockKey(job);
    if (key) {
      const holder = this.holder(key);
      if (holder) return this.store.updateJob(job.id, { waitingFor: holder, queuePos: this.nextQueuePos() });
      this.holders.set(key, job.id);
    }
    // Fire and forget. The webhook has already been acknowledged.
    void this.execute(job.id);
    return job;
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
    const [next, ...rest] = this.waiting(key);
    if (!next) return;
    this.holders.set(key, next.id);
    this.store.updateJob(next.id, { waitingFor: undefined, queuePos: undefined });
    for (const j of rest) this.store.updateJob(j.id, { waitingFor: next.id });
    void this.execute(next.id);
    const after = finished ? ` now that job ${finished} has finished` : "";
    await this.messenger
      .send(next.replyTo ?? next.requestedBy, `Job ${next.id} (${next.kind}) was queued and is starting${after}.`)
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
    for (const job of jobs) {
      const resumed = (job.resumed ?? 0) + 1;
      if (resumed > 3) {
        this.store.updateJob(job.id, { status: "failed", finishedAt: new Date().toISOString(), error: "Interrupted by restarts three times; giving up." });
        await this.messenger.send(job.replyTo ?? job.requestedBy, `Job ${job.id} (${job.kind}) was interrupted by restarts three times and has been stopped. Start it again when things are quiet.`);
        continue;
      }
      const key = lockKey(job);
      const holder = key && this.holders.get(key);
      if (key && holder) {
        // Another job on this repository has already reclaimed it: wait behind it.
        this.store.updateJob(job.id, { status: "queued", resumed, waitingFor: holder, queuePos: this.nextQueuePos() });
        await this.messenger.send(job.replyTo ?? job.requestedBy, `Job ${job.id} (${job.kind}) was interrupted by a restart. It is queued behind job ${holder} and will resume when that finishes.`);
        continue;
      }
      if (key) this.holders.set(key, job.id);
      this.store.updateJob(job.id, { status: "queued", resumed });
      await this.messenger.send(job.replyTo ?? job.requestedBy, `Job ${job.id} (${job.kind}) was interrupted by a restart. Resuming it (attempt ${resumed + 1}).`);
      void this.execute(job.id);
    }
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
    return jobs.length;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  private async execute(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) return;
    this.running.add(id);
    this.store.updateJob(id, { status: "running" });
    try {
      const spec = workerSpec(job.kind, job.target);
      const notes = this.store.notes();
      const standing = notes.length ? `\n\nStanding instructions from the founder:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
      const resume = job.resumed
        ? `\n\nThis job was interrupted by a service restart and is being resumed (attempt ${job.resumed + 1}). Work from a previous attempt may exist: check the working directory, git status and branches before doing anything, keep what is good, and continue from there rather than starting again.`
        : "";
      const result = await this.run({
        prompt: `${job.brief}${standing}${resume}`,
        systemPrompt: spec.prompt,
        model: spec.model,
        cwd: spec.cwd,
        allowedTools: spec.allowedTools,
        disallowedTools: spec.disallowedTools,
        tools: spec.tools,
        agents: spec.agents,
        maxTurns: PR_KINDS.includes(job.kind) ? 200 : job.kind === "maintain" ? 80 : 40,
        maxBudgetUsd: PR_KINDS.includes(job.kind) || job.kind === "maintain" ? config.engineerBudgetUsd : config.jobBudgetUsd,
      });
      const outputPath = this.store.writeOutput(id, result.text);
      const summary = firstLines(result.text, 1200);
      this.store.updateJob(id, {
        status: "done",
        finishedAt: new Date().toISOString(),
        summary,
        outputPath,
        costUsd: result.costUsd,
      });
      const cost = result.costUsd != null ? ` Cost $${result.costUsd.toFixed(2)}.` : "";
      // An engineer's pull request is reviewed by the maintainer without anyone asking. The
      // maintainer is not an engineering kind, so it runs at once and never waits for the lock.
      let chained = "";
      if (job.kind === "engineer") {
        const m = this.start(
          "maintain",
          `Review the pull request just opened by the engineer for this task, and any other open pull requests:\n\n${job.brief}\n\nEngineer's report:\n${result.text}`,
          job.requestedBy,
          job.target,
          job.replyTo,
        );
        chained = `\nMaintainer job ${m.id} started to review and merge.`;
      }
      // So is the agent-creator's, on the workforce repo. Only an explicit schedule verdict (no code
      // written) skips the maintainer; a missing or garbled verdict still gets a review.
      if (job.kind === "create_agent") {
        if (isScheduleVerdict(result.text)) {
          chained = `\nNo code needed: it fits an existing kind. Say "set it up" and I will schedule it.`;
        } else {
          const m = this.start(
            "maintain",
            `Review the pull request just opened by the agent-creator, which adds a new worker kind to this workforce, and any other open pull requests. Check in particular that the new kind's prompt carries the clean-room rule, its tools are least-privilege (no Edit, Write or unrestricted Bash unless it is an engineer, nothing that sends, posts, signs or pays), and the invariant tests were extended, not weakened:\n\n${job.brief}\n\nAgent-creator's report:\n${result.text}`,
            job.requestedBy,
            "self",
            job.replyTo,
          );
          chained = `\nMaintainer job ${m.id} started to review and merge.`;
        }
      }
      await this.messenger.send(
        job.replyTo ?? job.requestedBy,
        `Job ${id} (${job.kind}${job.target === "self" ? ", workforce" : ""}) finished.${cost}${chained}\n\n${summary}\n\n${result.text.length > summary.length ? `Full output saved. Ask "show job ${id}" for the rest or ask me questions about it.` : ""}`.trim(),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.updateJob(id, { status: "failed", finishedAt: new Date().toISOString(), error });
      await this.messenger.send(job.replyTo ?? job.requestedBy, `Job ${id} (${job.kind}) failed: ${error}`);
    } finally {
      this.running.delete(id);
      // Success, failure or error: free the repository and start whoever is next in line.
      const key = lockKey(job);
      if (key && this.holders.get(key) === id) {
        this.holders.delete(key);
        await this.startNext(key, id);
      }
    }
  }
}

/** True only when the agent-creator's output opens with the schedule verdict, i.e. it wrote no code. */
export function isScheduleVerdict(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(SCHEDULE_VERDICT.toLowerCase());
}

function firstLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return text.slice(0, cut > max / 2 ? cut : max).trimEnd() + "\n…";
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
