import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "./config.js";
import type { AgentRunner } from "./agents.js";
import { JOB_KINDS } from "./agents.js";
import { ACTION_KINDS, actionExecutors, type JobRunner } from "./jobs.js";
import type { Scheduler } from "./scheduler.js";
import type { JobKind, JobTarget, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";

const CHIEF_PROMPT = `You are the chief of staff for Clear Exchange, a company being founded by Paul Farrow. Clear Exchange is a planned private exchange where publishers compete to answer AI agents' questions with licensed content: agents send a query to one endpoint, the exchange matches it against a catalogue of publisher content, prices offers from publishers' rate cards, ranks on relevance first with price as a constraint, and issues signed entitlements, all inside an attested confidential VM. Supply comes from SPUR publishers' own APIs, marketplaces such as TollBit, and an open-source Prebid seller module running in IAB Tech Lab's Trusted Server. Revenue is a small clearing fee on every paid retrieval.

You talk to Paul over WhatsApp, so keep replies short: a few sentences, or a compact list when he is choosing between things. No em dashes. British English. Direct and honest; no flattery.

You run a workforce. For anything that takes more than a minute, delegate with start_job and tell Paul the job id; the worker will message him when it finishes. Kinds: research (web research, sourced brief), write (drafts in Paul's voice), engineer (a senior engineer who implements, tests, has the work reviewed, merges and pushes without asking), analyse (questions about previous outputs and data). Give the engineer a clear outcome, not instructions on how; it decides the approach. The engineer can also improve this workforce itself (new tools, better prompts, new worker kinds, fixes): start an engineer job with target "self". Changes go live a few minutes after it merges, via CI; the service restarts, and the conversation continues from stored sessions. Answer quick questions yourself. Use get_output to read a finished job before answering questions about it.

You never send email, post publicly, sign anything or move money. Side effects outside the workers' remit (a deploy or migration command, for example) go through propose_action, which asks Paul to reply YES <id>; only run_command exists. Recurring work goes through schedule_job with a cron expression in Europe/London time. If Paul tells you something to apply from now on, store it with remember.

Clean room rule: never reference or reconstruct anything from a repository called comp-exchange or "Atom", or any Microsoft internal material. Paul is leaving Microsoft; everything here is built from public standards and his general expertise.`;

export class Orchestrator {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly jobs: JobRunner,
    private readonly scheduler: Scheduler,
    private readonly run: AgentRunner,
  ) {}

  /** Serialise messages per sender so a quick second message does not race the first. */
  handle(from: string, text: string): Promise<void> {
    const prev = this.queues.get(from) ?? Promise.resolve();
    const next = prev.then(() => this.handleOne(from, text)).catch(async (err) => {
      await this.messenger.send(from, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.queues.set(from, next);
    return next;
  }

  private async handleOne(from: string, text: string): Promise<void> {
    if (!config.allowedNumbers.includes(from)) {
      console.warn(`Ignored message from unlisted number ${from}`);
      return;
    }
    const trimmed = text.trim();

    // Commands that never touch the model
    const approval = trimmed.match(/^(yes|approve|ok|no|reject)\s+([a-f0-9]{6})\b/i);
    if (approval) return this.handleApproval(from, approval[1].toLowerCase(), approval[2].toLowerCase());
    if (/^\/reset$/i.test(trimmed)) {
      this.store.clearSession(from);
      return this.messenger.send(from, "Started a fresh conversation. Jobs, schedules and notes are kept.");
    }
    if (/^\/jobs$/i.test(trimmed)) return this.messenger.send(from, this.jobsText());
    if (/^\/pending$/i.test(trimmed)) return this.messenger.send(from, this.pendingText());
    if (/^\/help$/i.test(trimmed)) return this.messenger.send(from, HELP);
    const show = trimmed.match(/^show job ([a-f0-9]{6})$/i);
    if (show) {
      const out = this.store.readOutput(show[1].toLowerCase());
      return this.messenger.send(from, out ?? `No output for job ${show[1]}.`);
    }

    // Everything else goes to the chief of staff, with a "working" nudge if it takes a while
    const nudge = setTimeout(() => void this.messenger.send(from, "Working on it."), 12_000);
    try {
      const result = await this.run({
        prompt: trimmed,
        systemPrompt: CHIEF_PROMPT + this.standingNotes(),
        model: config.models.chief,
        resume: this.store.getSession(from),
        allowedTools: ["WebSearch", "WebFetch", "mcp__ops__*"],
        tools: ["WebSearch", "WebFetch"],
        mcpServers: { ops: this.opsServer(from) },
        maxTurns: 25,
        maxBudgetUsd: config.jobBudgetUsd,
      });
      clearTimeout(nudge);
      if (result.sessionId) this.store.setSession(from, result.sessionId);
      await this.messenger.send(from, result.text || "(no reply)");
    } catch (err) {
      clearTimeout(nudge);
      // A broken session should not brick the conversation: drop it and tell the founder.
      this.store.clearSession(from);
      throw err;
    }
  }

  private standingNotes(): string {
    const notes = this.store.notes();
    return notes.length ? `\n\nStanding instructions from Paul:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
  }

  private async handleApproval(from: string, verb: string, id: string): Promise<void> {
    const action = this.store.getAction(id);
    if (!action) return this.messenger.send(from, `No pending action ${id}.`);
    if (action.status !== "pending") return this.messenger.send(from, `Action ${id} is already ${action.status}.`);
    if (verb === "no" || verb === "reject") {
      this.store.updateAction(id, { status: "rejected" });
      return this.messenger.send(from, `Rejected ${id}.`);
    }
    this.store.updateAction(id, { status: "approved" });
    const exec = actionExecutors[action.kind];
    if (!exec) {
      this.store.updateAction(id, { status: "failed", result: "No executor" });
      return this.messenger.send(from, `Approved ${id}, but no executor exists for ${action.kind}.`);
    }
    try {
      const result = await exec(action);
      this.store.updateAction(id, { status: "executed", result });
      await this.messenger.send(from, `Done (${action.kind} ${id}):\n${result}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.updateAction(id, { status: "failed", result: msg });
      await this.messenger.send(from, `Action ${id} failed: ${msg}`);
    }
  }

  private jobsText(): string {
    const jobs = this.store.listJobs(10);
    if (!jobs.length) return "No jobs yet.";
    return jobs.map((j) => `${j.id} ${j.kind} ${j.status} · ${j.brief.slice(0, 60)}`).join("\n");
  }

  private pendingText(): string {
    const p = this.store.pendingActions();
    if (!p.length) return "Nothing waiting for approval.";
    return p.map((a) => `${a.id} ${a.kind}: ${a.description}\nReply YES ${a.id} or NO ${a.id}`).join("\n\n");
  }

  /** The chief's tools. Each call closes over the requesting number so results route back correctly. */
  private opsServer(from: string) {
    const store = this.store;
    const jobs = this.jobs;
    const scheduler = this.scheduler;
    const kind = z.enum(JOB_KINDS as [JobKind, ...JobKind[]]);

    return createSdkMcpServer({
      name: "ops",
      version: "1.0.0",
      tools: [
        tool(
          "start_job",
          "Delegate a task to a worker agent. Returns a job id. The worker messages the founder when it finishes.",
          {
            kind,
            brief: z.string().describe("A complete, self-contained brief. The worker has no other context."),
            target: z.enum(["product", "self"]).default("product").describe('Engineer only. "product" is the Clear Exchange repository; "self" is this workforce\'s own code.'),
          },
          async ({ kind, brief, target }) => {
            const job = jobs.start(kind, brief, from, target as JobTarget);
            return { content: [{ type: "text", text: `Started job ${job.id} (${kind}${target === "self" ? ", on the workforce itself" : ""}).` }] };
          },
        ),
        tool(
          "job_status",
          "List recent jobs with their status, or one job by id.",
          { id: z.string().optional() },
          async ({ id }) => {
            if (id) {
              const j = store.getJob(id);
              return { content: [{ type: "text", text: j ? JSON.stringify(j, null, 2) : `No job ${id}` }] };
            }
            return { content: [{ type: "text", text: this.jobsText() }] };
          },
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          "get_output",
          "Read the full output of a finished job.",
          { id: z.string() },
          async ({ id }) => {
            const out = store.readOutput(id);
            return { content: [{ type: "text", text: out ?? `No output for job ${id}.` }] };
          },
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          "propose_action",
          `Ask the founder to approve a side effect. Kinds: ${ACTION_KINDS.join(", ")}. Returns the id the founder must reply YES to.`,
          {
            kind: z.enum(ACTION_KINDS as [string, ...string[]]),
            description: z.string().describe("One line the founder will read before approving"),
            payload: z.record(z.string(), z.unknown()).describe("run_command: {command}."),
          },
          async ({ kind, description, payload }) => {
            const a = store.createAction(kind, description, payload, from);
            return { content: [{ type: "text", text: `Pending approval ${a.id}. Tell the founder to reply YES ${a.id} or NO ${a.id}.` }] };
          },
        ),
        tool(
          "schedule_job",
          "Create a recurring job. cron is a 5-field expression evaluated in Europe/London.",
          { cron: z.string(), kind, brief: z.string() },
          async ({ cron, kind, brief }) => {
            const s = scheduler.add({ cron, timezone: "Europe/London", kind, brief, requestedBy: from });
            return { content: [{ type: "text", text: `Scheduled ${s.id}: ${s.cron} (${kind}).` }] };
          },
        ),
        tool(
          "list_schedules",
          "List recurring jobs.",
          {},
          async () => {
            const list = scheduler.list();
            const text = list.length ? list.map((s) => `${s.id} ${s.cron} ${s.kind} · ${s.brief.slice(0, 60)}`).join("\n") : "No schedules.";
            return { content: [{ type: "text", text }] };
          },
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          "cancel_schedule",
          "Cancel a recurring job by id.",
          { id: z.string() },
          async ({ id }) => ({ content: [{ type: "text", text: scheduler.cancel(id) ? `Cancelled ${id}.` : `No schedule ${id}.` }] }),
        ),
        tool(
          "remember",
          "Store a standing instruction from the founder that applies to all future work.",
          { note: z.string() },
          async ({ note }) => {
            store.addNote(note);
            return { content: [{ type: "text", text: "Remembered." }] };
          },
        ),
      ],
    });
  }
}

const HELP = `Talk to me normally. I answer quick things myself and delegate the rest.

Commands:
/jobs – recent jobs
/pending – actions waiting for your approval
show job <id> – full output of a job
YES <id> / NO <id> – approve or reject an action
/reset – start a fresh conversation (jobs and notes are kept)`;
