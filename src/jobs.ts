import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { AgentRunner } from "./agents.js";
import { workerSpec } from "./agents.js";
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

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product"): Job {
    const job = this.store.createJob(kind, brief, requestedBy, target);
    // Fire and forget. The webhook has already been acknowledged.
    void this.execute(job.id);
    return job;
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
      const result = await this.run({
        prompt: `${job.brief}${standing}`,
        systemPrompt: spec.prompt,
        model: spec.model,
        cwd: spec.cwd,
        allowedTools: spec.allowedTools,
        disallowedTools: spec.disallowedTools,
        tools: spec.tools,
        agents: spec.agents,
        maxTurns: job.kind === "engineer" ? 200 : 40,
        maxBudgetUsd: job.kind === "engineer" ? config.engineerBudgetUsd : config.jobBudgetUsd,
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
      await this.messenger.send(
        job.requestedBy,
        `Job ${id} (${job.kind}${job.target === "self" ? ", workforce" : ""}) finished.${cost}\n\n${summary}\n\n${result.text.length > summary.length ? `Full output saved. Ask "show job ${id}" for the rest or ask me questions about it.` : ""}`.trim(),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.updateJob(id, { status: "failed", finishedAt: new Date().toISOString(), error });
      await this.messenger.send(job.requestedBy, `Job ${id} (${job.kind}) failed: ${error}`);
    } finally {
      this.running.delete(id);
    }
  }
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
