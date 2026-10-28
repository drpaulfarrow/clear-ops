import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config, isAllowed } from "./config.js";
import type { AgentRunner } from "./agents.js";
import { JOB_KINDS } from "./agents.js";
import { ACTION_KINDS, actionExecutors, lockKey, type JobRunner } from "./jobs.js";
import type { Scheduler } from "./scheduler.js";
import type { Job, JobKind, JobTarget, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";
import { describeToolUse, LiveStatus, type LiveStatusOptions } from "./status.js";

const CHIEF_PROMPT = `You are the chief of staff for Clear Exchange, a company being founded by Paul Farrow. Clear Exchange is a planned private exchange where publishers compete to answer AI agents' questions with licensed content: agents send a query to one endpoint, the exchange matches it against a catalogue of publisher content, prices offers from publishers' rate cards, ranks on relevance first with price as a constraint, and issues signed entitlements, all inside an attested confidential VM. Supply comes from SPUR publishers' own APIs, marketplaces such as TollBit, and an open-source Prebid seller module running in IAB Tech Lab's Trusted Server. Revenue is a small clearing fee on every paid retrieval.

You talk to Paul over a chat app on his phone, so keep replies short: a few sentences, or a compact list when he is choosing between things. No em dashes. British English. Direct and honest; no flattery.

You run a workforce. For anything that takes more than a minute, delegate with start_job and tell Paul the job id; the worker will message him when it finishes. Kinds: research (web research, sourced brief), design (brand and design director, see below), write (drafts in Paul's voice), engineer (a senior engineer who implements on a branch with tests and opens a pull request), maintain (the one agent that reviews and merges pull requests; it starts automatically after every engineer job, so you only start it by hand to re-review after fixes or to clear a backlog), analyse (questions about previous outputs and data), create_agent (the agent-creator, see below). Every agent can read both repositories. Give the engineer a clear outcome, not instructions on how; it decides the approach. The review loop closes itself: when the maintainer requests changes on an engineer's or agent-creator's pull request, an engineer job to address that review on the same pull request starts automatically (queued like any engineering job), and the update is re-reviewed automatically, up to 3 fix rounds per pull request. Engineers and the maintainer bring branches up to date with main themselves. If it is still not mergeable after 3 rounds, or the blocker is something only Paul can do (a secret, a GitHub or hosting setting, account access, a product decision), Paul is messaged once with exactly what he must do. So never ask Paul whether to merge or fix a pull request, and do not start fix jobs by hand unless he asks for another round after the loop has stopped. The engineer can also improve this workforce itself (new tools, better prompts, new worker kinds, fixes): start an engineer job with target "self". Changes go live a few minutes after it merges, via CI; the service restarts, and the conversation continues from stored sessions. When Paul asks for a new kind of agent in plain language ("I want an agent that monitors IAB Tech Lab announcements weekly", "an agent that drafts publisher outreach"), start a create_agent job and pass his request on in his words, plus any context from the conversation; do not design it yourself or tell him how it will be built. The agent-creator decides whether it is a scheduled job on an existing kind (it then recommends a brief and cron and writes no code) or a new worker kind (it opens a pull request on this workforce, which the maintainer reviews and merges like any other). When it recommends a schedule and Paul agrees, read the job with get_output and call schedule_job with the kind, cron and brief it gave. Use engineer with target "self" for other changes to the workforce, and create_agent only for adding an agent. design is the brand and design director: it screenshots the live site (https://clear-exchange.fly.dev) and branches with a headless browser and looks at them, runs critiques as buyer personas (a publisher's head of revenue, an AI company's product lead, an investor), and writes brand work (logo direction, palette, type, tone, UI principles) and page specs an engineer can build. It writes no production code and never merges. Use a single design job for a one-off critique, brand directions or a spec. Use the design loop (start_job with kind design and loop true) when Paul wants the site improved until it is customer-ready ("make the site look like something I can show customers"): the designer critiques and writes a spec, an engineer builds it on the product (queued like any engineer job), the maintainer reviews and merges, and after CI deploys the designer looks at the live site again; up to 3 implemented rounds, or fewer if the critiques find no high-impact issues, then a closing report to Paul. The loop runs itself; do not start its engineer or design jobs by hand. When it pauses for a decision only Paul can make (for example one of three brand directions), the images and the question go to him; when he answers, call start_job with kind design, continueLoop set to the id of the job that asked, and his answer as the brief. Pass his goal on in his words. Only one engineering job (engineer or create_agent) runs per repository at a time, product and workforce counted separately. Queueing is automatic: if one is already running on that repository, start_job queues the new one and tells you which job it is waiting behind, and it starts by itself when that finishes, in the order requested. So start engineer jobs whenever they are needed, without checking job_status first, and tell Paul when one is queued. The maintainer and the other kinds never wait. Answer quick questions yourself. Use get_output to read a finished job before answering questions about it.

You never send email, post publicly, sign anything or move money. Side effects outside the workers' remit (a deploy or migration command, for example) go through propose_action, which asks Paul to reply YES <id>; only run_command exists. Recurring work goes through schedule_job with a cron expression in Europe/London time. If Paul tells you something to apply from now on, store it with remember.

Clean room rule: never reference or reconstruct anything from a repository called comp-exchange or "Atom", or any Microsoft internal material. Paul is leaving Microsoft; everything here is built from public standards and his general expertise.`;

export interface HandleContext {
  /** Address replies go to and the conversation is keyed by. Defaults to the sender. */
  replyTo?: string;
  /** The inbound message id, for channels that can open a thread under it. */
  messageId?: string;
}

export class Orchestrator {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly jobs: JobRunner,
    private readonly scheduler: Scheduler,
    private readonly run: AgentRunner,
    private readonly statusOptions: LiveStatusOptions = {},
  ) {}

  /**
   * Serialise messages per conversation so a quick second message does not race the first.
   * `ctx.replyTo` is where replies go (a chat, channel or thread); it is also the conversation key,
   * so each Discord thread is its own conversation with the chief. Defaults to the sender.
   */
  handle(from: string, text: string, ctx: HandleContext = {}): Promise<void> {
    const replyTo = ctx.replyTo ?? from;
    const prev = this.queues.get(replyTo) ?? Promise.resolve();
    const next = prev.then(() => this.handleOne(from, text, replyTo, ctx.messageId)).catch(async (err) => {
      await this.messenger.send(replyTo, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.queues.set(replyTo, next);
    return next;
  }

  private async handleOne(sender: string, text: string, from: string, messageId?: string): Promise<void> {
    // `sender` is who wrote; `from` is the conversation address replies and sessions are keyed by.
    if (!isAllowed(sender)) {
      console.warn(`Ignored message from unlisted sender ${sender}`);
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
    if (/^\/(help|start)$/i.test(trimmed)) return this.messenger.send(from, HELP);
    const show = trimmed.match(/^show job ([a-f0-9]{6})$/i);
    if (show) {
      const out = this.store.readOutput(show[1].toLowerCase());
      return this.messenger.send(from, out ?? `No output for job ${show[1]}.`);
    }

    // Everything else goes to the chief of staff. While it works, the founder sees a typing indicator
    // and one status line, edited in place from the chief's tool calls and removed when the reply is ready.
    const status = new LiveStatus(this.messenger, from, this.statusOptions).start();
    try {
      const result = await this.run({
        prompt: trimmed,
        systemPrompt: CHIEF_PROMPT + this.standingNotes(),
        model: config.models.chief,
        resume: this.store.getSession(from),
        allowedTools: ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "mcp__ops__*"],
        tools: ["WebSearch", "WebFetch", "Read", "Glob", "Grep"],
        mcpServers: { ops: this.opsServer(sender, from, messageId) },
        maxTurns: 25,
        maxBudgetUsd: config.jobBudgetUsd,
        onToolUse: (name, input) => status.update(describeToolUse(name, input)),
      });
      await status.finish();
      if (result.sessionId) this.store.setSession(from, result.sessionId);
      await this.messenger.send(from, result.text || "(no reply)");
    } catch (err) {
      await status.finish();
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
    return jobs.map((j) => `${j.id} ${j.kind} ${this.statusText(j)} · ${j.brief.slice(0, 60)}`).join("\n");
  }

  private statusText(j: Job): string {
    if (j.status !== "queued" || !j.waitingFor) return j.status;
    const pos = this.jobs.queuePosition(j.id);
    return `queued behind ${j.waitingFor}${pos ? ` (#${pos} on ${lockKey(j)})` : ""}`;
  }

  private pendingText(): string {
    const p = this.store.pendingActions();
    if (!p.length) return "Nothing waiting for approval.";
    return p.map((a) => `${a.id} ${a.kind}: ${a.description}\nReply YES ${a.id} or NO ${a.id}`).join("\n\n");
  }

  /** The chief's tools. Each call closes over the requester and conversation so results route back correctly. */
  private opsServer(sender: string, from: string, messageId?: string) {
    const store = this.store;
    const jobs = this.jobs;
    const scheduler = this.scheduler;
    const kind = z.enum(JOB_KINDS as [JobKind, ...JobKind[]]);
    const scheduleKind = z.enum(JOB_KINDS.filter((k) => k !== "create_agent") as [JobKind, ...JobKind[]]);

    return createSdkMcpServer({
      name: "ops",
      version: "1.0.0",
      tools: [
        tool(
          "start_job",
          "Delegate a task to a worker agent. Returns a job id. The worker messages the founder when it finishes. Use kind create_agent when the founder asks for a new kind of agent; its brief is his request in plain language. Only one engineer or create_agent job runs per repository (product, self) at a time; if one is running, the new job is queued automatically and starts when it finishes, so there is no need to check first.",
          {
            kind,
            brief: z.string().describe("A complete, self-contained brief. The worker has no other context."),
            target: z.enum(["product", "self"]).default("product").describe('Engineer only. "product" is the Clear Exchange repository; "self" is this workforce\'s own code. create_agent always works on "self".'),
            loop: z.boolean().optional().describe("Design only: run the design loop (critique, spec, engineer builds, merge, deploy, critique again), capped at 3 rounds. The brief is Paul's goal."),
            continueLoop: z.string().optional().describe("Design only: the id of the design job that paused its loop for Paul's decision. The brief is his answer."),
          },
          async ({ kind, brief, target, loop, continueLoop }) => {
            if (kind === "create_agent") target = "self";
            if (kind === "design") target = "product";
            const looping = kind === "design" && (loop || continueLoop);
            // On channels with threads, give the job its own thread so its reports and the maintainer's review stay together.
            let replyTo = from;
            // A design loop being continued reports where it always has.
            if (this.messenger.openThread && messageId && !(looping && continueLoop)) {
              const thread = await this.messenger.openThread(from, messageId, `${kind}: ${brief.slice(0, 70)}`).catch(() => undefined);
              if (thread) replyTo = thread;
            }
            if (looping) {
              let job: Job;
              try {
                job = jobs.startDesignLoop(brief, sender, continueLoop ? undefined : replyTo, continueLoop || undefined);
              } catch (err) {
                return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
              }
              const what = continueLoop ? `Design loop ${job.designLoop} carries on (round ${job.designRound})` : `Design loop ${job.id} started`;
              if (job.replyTo && job.replyTo !== from) await this.messenger.send(job.replyTo, `${what}: job ${job.id}. Reports will land here.`);
              return { content: [{ type: "text", text: `${what}: job ${job.id} (design). Each round's spec goes to an engineer automatically; Paul hears at decisions and at the end.` }] };
            }
            const job = jobs.start(kind, brief, sender, target as JobTarget, replyTo);
            const where = target === "self" ? ", on the workforce itself" : "";
            if (job.waitingFor) {
              const behind = `queued behind job ${job.waitingFor}, the ${target === "self" ? "workforce" : "product"} repository's running engineering job`;
              if (replyTo !== from) await this.messenger.send(replyTo, `Job ${job.id} (${kind}) ${behind}. It starts automatically when that finishes. Reports will land here.`);
              const pos = jobs.queuePosition(job.id);
              return { content: [{ type: "text", text: `Queued job ${job.id} (${kind}${where}): ${behind}${pos && pos > 1 ? `, position ${pos} in the queue` : ""}. It starts automatically when that finishes.` }] };
            }
            if (replyTo !== from) await this.messenger.send(replyTo, `Job ${job.id} (${kind}) started. Reports will land here.`);
            return { content: [{ type: "text", text: `Started job ${job.id} (${kind}${where}).` }] };
          },
        ),
        tool(
          "job_status",
          "List recent jobs with their status, or one job by id. A queued engineering job shows the job it is waiting behind and its place in that repository's queue.",
          { id: z.string().optional() },
          async ({ id }) => {
            if (id) {
              const j = store.getJob(id);
              if (!j) return { content: [{ type: "text", text: `No job ${id}` }] };
              const queue = j.waitingFor ? { queuedBehind: j.waitingFor, queuePosition: jobs.queuePosition(j.id) } : {};
              return { content: [{ type: "text", text: JSON.stringify({ ...j, ...queue }, null, 2) }] };
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
            const a = store.createAction(kind, description, payload, sender);
            return { content: [{ type: "text", text: `Pending approval ${a.id}. Tell the founder to reply YES ${a.id} or NO ${a.id}.` }] };
          },
        ),
        tool(
          "schedule_job",
          "Create a recurring job. cron is a 5-field expression evaluated in Europe/London.",
          // Adding agents on a timer makes no sense and would open pull requests unattended.
          { cron: z.string(), kind: scheduleKind, brief: z.string() },
          async ({ cron, kind, brief }) => {
            const s = scheduler.add({ cron, timezone: "Europe/London", kind, brief, requestedBy: sender, replyTo: from });
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
/jobs: recent jobs
/pending: actions waiting for your approval
show job <id>: full output of a job
YES <id> or NO <id>: approve or reject an action
/reset: start a fresh conversation (jobs and notes are kept)`;
