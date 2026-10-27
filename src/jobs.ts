import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { AgentRunner } from "./agents.js";
import { PR_KINDS, SCHEDULE_VERDICT, workerSpec } from "./agents.js";
import type { Job, JobKind, JobTarget, PendingAction, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";

const exec = promisify(execFile);

/** Starts worker jobs in the background and reports back over WhatsApp when they finish. */
export class JobRunner {
  private running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly run: AgentRunner,
  ) {}

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product", replyTo?: string): Job {
    const job = this.store.createJob(kind, brief, requestedBy, target, replyTo);
    // Fire and forget. The webhook has already been acknowledged.
    void this.execute(job.id);
    return job;
  }

  /**
   * A deploy restarts the process, and a job that was running dies with it. The working
   * folders live on the volume, so the job is re-queued with a note to inspect the repo
   * state and carry on rather than start again. Called once on boot.
   */
  async resumeInterrupted(): Promise<number> {
    const jobs = this.store.interruptedJobs();
    for (const job of jobs) {
      const resumed = (job.resumed ?? 0) + 1;
      if (resumed > 3) {
        this.store.updateJob(job.id, { status: "failed", finishedAt: new Date().toISOString(), error: "Interrupted by restarts three times; giving up." });
        await this.messenger.send(job.replyTo ?? job.requestedBy, `Job ${job.id} (${job.kind}) was interrupted by restarts three times and has been stopped. Start it again when things are quiet.`);
        continue;
      }
      this.store.updateJob(job.id, { status: "queued", resumed });
      await this.messenger.send(job.replyTo ?? job.requestedBy, `Job ${job.id} (${job.kind}) was interrupted by a restart. Resuming it (attempt ${resumed + 1}).`);
      void this.execute(job.id);
    }
    return jobs.length;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  private async execute(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) return;
    const spec = workerSpec(job.kind, job.target);
    this.running.add(id);
    this.store.updateJob(id, { status: "running" });
    try {
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
      // An engineer's pull request is reviewed by the maintainer without anyone asking.
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
