import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { AgentRunner } from "./agents.js";
import { MAX_FIX_ROUNDS, PR_KINDS, SCHEDULE_VERDICT, workerSpec } from "./agents.js";
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

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product", replyTo?: string, extra: Pick<Job, "pr" | "fixRound" | "reviewOf"> = {}): Job {
    const job = this.store.createJob(kind, brief, requestedBy, target, replyTo, extra);
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
      let escalation: string | undefined;
      if (job.kind === "engineer") {
        // A fix round already knows its pull request; a fresh job's is read from its report.
        const pr = job.pr ?? findPrUrl(result.text);
        if (pr && !job.pr) this.store.updateJob(id, { pr });
        const which = pr ? `the pull request ${pr}, which the engineer just ${job.fixRound ? "updated to address your last review" : "opened for this task"}` : "the pull request just opened by the engineer for this task";
        const m = this.start(
          "maintain",
          `Review ${which}, and any other open pull requests:\n\n${job.brief}\n\nEngineer's report:\n${result.text}`,
          job.requestedBy,
          job.target,
          job.replyTo,
          { reviewOf: id, pr },
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
            { reviewOf: id, pr: findPrUrl(result.text) },
          );
          chained = `\nMaintainer job ${m.id} started to review and merge.`;
        }
      }
      // Close the review loop: changes requested on the reviewed job's pull request go back to an
      // engineer, up to MAX_FIX_ROUNDS; anything only the founder can unblock is put to him once.
      if (job.kind === "maintain" && job.reviewOf) {
        const next = this.afterReview(job, result.text);
        chained = next.chained;
        escalation = next.escalation;
      }
      await this.messenger.send(
        job.replyTo ?? job.requestedBy,
        `Job ${id} (${job.kind}${job.target === "self" ? ", workforce" : ""}) finished.${cost}${chained}\n\n${summary}\n\n${result.text.length > summary.length ? `Full output saved. Ask "show job ${id}" for the rest or ask me questions about it.` : ""}`.trim(),
      );
      if (escalation) await this.messenger.send(job.replyTo ?? job.requestedBy, escalation);
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
    if (!verdict || verdict.outcome === "merged") return { chained: "" };
    const url = verdict.pr;
    const target = lockKey(reviewed) ?? reviewed.target ?? "product";
    if (verdict.outcome === "needs_founder") {
      return {
        chained: "",
        escalation: `Action needed from you on ${url}: ${verdict.detail || "the maintainer says only you can unblock it; see its report above."}\nOnce that is done, tell me and I will have it re-reviewed.`,
      };
    }
    const round = (reviewed.kind === "engineer" ? reviewed.fixRound ?? 0 : 0) + 1;
    if (round > MAX_FIX_ROUNDS) {
      return {
        chained: "",
        escalation: `${url} is still not mergeable after ${MAX_FIX_ROUNDS} automatic fix rounds, so I have stopped. The maintainer's blocking issues are in its report above. What you can do: reply "one more fix round on ${url}" to try again, give a steer on the point it is stuck on, or close the pull request.`,
      };
    }
    const fix = this.start(
      "engineer",
      `Address the maintainer's review on the existing pull request ${url} (automatic fix round ${round} of ${MAX_FIX_ROUNDS}). Check out that pull request's branch, bring it up to date with the default branch, fix every blocking issue in the review, run the tests and typecheck, push to the same branch and reply to each review comment with gh. Read the review itself with gh pr view ${url} --comments. Do not open a new pull request. If a blocker can only be resolved by the founder (a secret, a GitHub or hosting setting, account access, a product decision), do everything else and say so plainly in your report.\n\nOriginal task:\n${reviewed.brief}\n\nMaintainer's review (job ${review.id}):\n${text}`,
      reviewed.requestedBy,
      target,
      reviewed.replyTo,
      { pr: url, fixRound: round },
    );
    const queued = fix.waitingFor ? `, queued behind job ${fix.waitingFor}` : "";
    return { chained: `\nChanges requested on ${url}. Engineer job ${fix.id} started to fix them (round ${round} of ${MAX_FIX_ROUNDS}${queued}); it is re-reviewed automatically.` };
  }
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
