import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bookingLink, config } from "./config.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "./agents.js";
import { MAX_DESIGN_ROUNDS, MAX_FIX_ROUNDS, PR_KINDS, readableDirs, SCHEDULE_VERDICT, workerSpec } from "./agents.js";
import { designRoot, parseDesignVerdict, reportImages, waitForProductDeploy, type DeployWait } from "./design.js";
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

  private readonly waitForDeploy: DeployWait;

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly run: AgentRunner,
    /** Extra tool servers for a job (the executive assistant's Google tools). Built per job so permits apply. */
    private readonly toolsFor: (job: Job) => Record<string, McpServerConfig> | undefined = () => undefined,
    opts: { waitForDeploy?: DeployWait } = {},
  ) {
    this.waitForDeploy = opts.waitForDeploy ?? waitForProductDeploy;
  }

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product", replyTo?: string, extra: Pick<Job, "pr" | "fixRound" | "reviewOf" | "permits" | "designLoop" | "designRound" | "designFinal" | "awaitDeploy"> = {}): Job {
    // Only the executive assistant has permits, and only drafts and holds exist.
    extra = { ...extra };
    if (kind !== "ea") delete extra.permits;
    else if (extra.permits) extra.permits = [...new Set(extra.permits)].filter((p) => p === "drafts" || p === "holds");
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
   * Starts a design loop on the product: design round 1 now; each merged spec leads to the next round
   * once the deploy is live. `continueFrom` (any job of a paused loop) carries on that loop, same round,
   * with the founder's decision in the brief.
   */
  startDesignLoop(goal: string, requestedBy: string, replyTo?: string, continueFrom?: string): Job {
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
      const job = this.store.createJob("design", designBrief(goal, 1), requestedBy, "product", replyTo, { designRound: 1, designGoal: goal });
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
    return this.start("design", designBrief(loopGoal, round, { decision: goal, previous: latest.id, final: latest.designFinal }), requestedBy, "product", replyTo ?? latest.replyTo, {
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
      // A design round after a merge looks only once the product's deploy of that merge is live.
      if (job.awaitDeploy) await this.waitForDeploy(new Date(job.createdAt));
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
      const link = job.kind === "ea" ? bookingLink(this.store) : undefined;
      const permits =
        job.kind === "ea"
          ? `\n\nThis job may change: ${job.permits?.length ? job.permits.join(" and ") : "nothing (read only)"}.${link ? ` Paul's booking link for scheduling drafts: ${link}` : ""}`
          : "";
      const result = await this.run({
        prompt: `${job.brief}${permits}${standing}${resume}`,
        systemPrompt: spec.prompt,
        model: spec.model,
        cwd: spec.cwd,
        allowedTools: spec.allowedTools,
        disallowedTools: spec.disallowedTools,
        tools: spec.tools,
        agents: spec.agents,
        mcpServers: ownTools || extraTools ? { ...extraTools, ...ownTools } : undefined,
        additionalDirectories: dirs,
        maxTurns: PR_KINDS.includes(job.kind) ? 200 : job.kind === "maintain" || job.kind === "design" ? 80 : 40,
        maxBudgetUsd: PR_KINDS.includes(job.kind) || job.kind === "maintain" ? config.engineerBudgetUsd : job.kind === "design" ? config.design.budgetUsd : config.jobBudgetUsd,
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
      if (job.kind === "design" && job.designLoop) {
        const next = this.afterDesign(job, result.text);
        chained = next.chained;
        escalation = next.escalation;
      }
      await this.messenger.send(
        job.replyTo ?? job.requestedBy,
        `Job ${id} (${job.kind}${job.target === "self" ? ", workforce" : ""}) finished.${cost}${chained}\n\n${summary}\n\n${result.text.length > summary.length ? `Full output saved. Ask "show job ${id}" for the rest or ask me questions about it.` : ""}`.trim(),
      );
      if (job.kind === "design") await this.sendImages(job, result.text);
      if (escalation) await this.messenger.send(job.replyTo ?? job.requestedBy, escalation);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.updateJob(id, { status: "failed", finishedAt: new Date().toISOString(), error });
      // A failed round leaves its loop waiting for Paul rather than stalled for good.
      this.pauseLoop(job.designLoop);
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
    if (!verdict) {
      // A design loop must not stall silently.
      this.pauseLoop(reviewed.designLoop);
      return reviewed.designLoop
        ? { chained: "", escalation: `Design loop ${reviewed.designLoop} is paused: the maintainer gave no verdict on ${pr ?? "the round's pull request"}. Tell me to re-review it, or to carry on the loop.` }
        : { chained: "" };
    }
    if (verdict.outcome === "merged") return reviewed.designLoop ? this.nextDesignRound(reviewed, verdict.pr) : { chained: "" };
    const url = verdict.pr;
    const target = lockKey(reviewed) ?? reviewed.target ?? "product";
    if (verdict.outcome === "needs_founder") {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: "",
        escalation: `Action needed from you on ${url}: ${verdict.detail || "the maintainer says only you can unblock it; see its report above."}\nOnce that is done, tell me and I will have it re-reviewed.`,
      };
    }
    const round = (reviewed.kind === "engineer" ? reviewed.fixRound ?? 0 : 0) + 1;
    if (round > MAX_FIX_ROUNDS) {
      this.pauseLoop(reviewed.designLoop);
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
      { pr: url, fixRound: round, designLoop: reviewed.designLoop, designRound: reviewed.designRound },
    );
    const queued = fix.waitingFor ? `, queued behind job ${fix.waitingFor}` : "";
    return { chained: `\nChanges requested on ${url}. Engineer job ${fix.id} started to fix them (round ${round} of ${MAX_FIX_ROUNDS}${queued}); it is re-reviewed automatically.` };
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
        escalation: `Design decision for you (loop ${loop}, round ${round}): ${verdict.detail || "see the report above."}\nReply with your choice and I will carry on from there.`,
      };
    }
    if (job.designFinal || verdict?.outcome === "done") {
      const clean = verdict?.outcome === "done";
      const built = job.designFinal ? MAX_DESIGN_ROUNDS : round - 1;
      const why = clean ? "the customer critiques found no high-impact issues" : "that was the last round";
      return { chained: `\nDesign loop ${loop} finished after ${built} implemented round${built === 1 ? "" : "s"}: ${why}. The report above is where the site stands now.` };
    }
    if (verdict?.outcome !== "spec") {
      this.pauseLoop(loop);
      return { chained: "", escalation: `Design loop ${loop} is paused: round ${round} ended without a spec or a verdict. Tell me to carry on, or give a steer.` };
    }
    const eng = this.start(
      "engineer",
      `Implement this design spec on the Clear Exchange product (design loop ${loop}, round ${round} of ${MAX_DESIGN_ROUNDS}). Build exactly what it specifies, keeping the product's existing constraints, tests and security headers; where the spec conflicts with them, keep the constraint and say so in the pull request. Assets the designer saved (SVG, CSS, JSON) are in ${designRoot()}/${job.id}/ and you may copy them into the repository. Put before and after screenshots, desktop and mobile, in the pull request description if you can produce them. Open one pull request; the maintainer reviews and merges it, and the designer then reviews the deployed result.\n\nDesign job ${job.id}'s report and spec:\n${text}`,
      job.requestedBy,
      "product",
      job.replyTo,
      { designLoop: loop, designRound: round },
    );
    const queued = eng.waitingFor ? `, queued behind job ${eng.waitingFor}` : "";
    return { chained: `\nSpec ready. Engineer job ${eng.id} started to build it (design round ${round} of ${MAX_DESIGN_ROUNDS}${queued}); after the merge and deploy, the designer reviews the live site again.` };
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
      designLoop: loop,
      designRound: round,
      designFinal: final || undefined,
      awaitDeploy: true,
    });
    return { chained: `\n${pr} merged. Design job ${d.id} will ${final ? "run the closing customer critique" : `start round ${round}`} once the deploy is live.` };
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
