/**
 * Plans (Paul, 22 Nov 2026): a list of engineering steps on one repository that the service runs to
 * completion itself. "I don't want it to stop until it's done, even if we hit a spending cap, I want it
 * to resume tomorrow."
 *
 * Before this the workforce knew only jobs. Every job ended with a message to Paul, and the next one
 * started when he asked: he was the one managing a build to completion. A queued engineer job was no
 * substitute, because it starts when the job before it finishes, not when that job's pull request has
 * been reviewed and merged, so it would build on a default branch without the step before it.
 *
 * A plan is steps in build order, each one pull request with its own brief and finish line. The driver
 * starts step one as an ordinary engineer job and, each minute, reads from the job records where the
 * step has got to. Nothing about a step's progress is stored here: it is derived every time from the
 * jobs that carry the plan's mark (the step's engineer job and its fix rounds) and the maintainer's
 * reviews of them, so a restart loses nothing and there is no second account of the truth to drift.
 *
 *   - merged (the maintainer's own verdict line): the step is done and the next one starts.
 *   - a blocking review: the fix round is automatic for a plan's jobs, PLAN_FIX_ROUNDS of them,
 *     whatever AUTO_FIX_ROUNDS says (src/jobs.ts afterReview).
 *   - a job that failed (its budget, its turns, a stall, an API error): retried, PLAN_RETRIES times,
 *     carrying on from the work it kept.
 *   - the daily cap: nothing is started or retried while it is reached. The plan waits, says so once
 *     that day, and carries on by itself when the next London day begins.
 *   - a credit or key failure: the engineering queue is held (as for any job) and /resume restarts it.
 *
 * It stops, and tells Paul once, only when it cannot go on: a review says the step needs something
 * only he has, the fix rounds or the retries are used up, a step opened no pull request, or he stopped
 * its job. A plan stopped on an open pull request watches it, and carries on by itself when it is
 * merged (on this repository, where Paul merges, that is how every step proceeds). Otherwise he tells
 * Marlo to resume the plan, or to skip the step.
 *
 * A plan is refused when no daily cap is set: the cap is what bounds a thing that spends without asking.
 *
 * A plan starts jobs through JobRunner.start like everything else, so every rule that lives there
 * holds for it: the repository lock, the cap, the queue hold, the finish-line contract, the review.
 * It cannot merge, approve, send, pay or sign anything, and it gives no job a permit.
 */
import { randomBytes } from "node:crypto";
import { failureReason, HOLD_KINDS, type FailureKind } from "./failures.js";
import { londonYmd } from "./london.js";
import type { Job, JobTarget, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";

export const PLAN_MAX_STEPS = 40;
/** Automatic fix rounds for a plan's pull requests, whatever AUTO_FIX_ROUNDS is: a plan is not to stall on a blocking review. */
export const PLAN_FIX_ROUNDS = 2;
/** How many times one step's failed job is retried before the plan stops. */
export const PLAN_RETRIES = 2;
/** A finished job is left this long before its step is judged, so the review or fix round that follows it has been started. */
export const PLAN_SETTLE_MS = 60_000;
/** How long a failed job is left before it is retried, so a provider's bad minute is not retried into. */
export const PLAN_RETRY_WAIT_MS = 5 * 60_000;
/** How long a stopped plan goes on watching its open pull request for Paul's merge. */
export const PLAN_WATCH_MS = 14 * 24 * 60 * 60_000;
/** How often a stopped plan's pull request is looked up on GitHub. */
export const PLAN_WATCH_EVERY_MS = 5 * 60_000;
/** Finished and stopped plans kept in the store, newest last. */
export const PLANS_KEPT = 20;

/** What the chief is told about plans (CHIEF_PROMPT, src/orchestrator.ts). */
export const PLAN_NOTE = `When Paul wants a build carried through to the end (a batch of a plan, a feature that takes several pull requests, "don't stop until it's done"), use plan_start with the steps in build order, one pull request each, and do not start_job them yourself or queue them: the service starts each step when the one before has merged, has blocking reviews fixed, retries a failed job, waits on the daily cap and carries on the next day, and tells Paul only when it stops or finishes. A plan that has stopped says why; when Paul has dealt with it or says to try again, plan_resume carries it on, with skip only when he says to skip the step. plan_status says where a plan is.`;

export interface PlanStep {
  title: string;
  brief: string;
  doneWhen: string;
  state: "todo" | "working" | "done" | "skipped";
  /** The engineer job the step was started as. */
  jobId?: string;
  pr?: string;
  /** How many times a failed job of this step has been retried. */
  retries?: number;
  finishedAt?: string;
}

export interface Plan {
  id: string;
  title: string;
  target: JobTarget;
  requestedBy: string;
  replyTo?: string;
  createdAt: string;
  state: "running" | "stopped" | "done";
  steps: PlanStep[];
  /** Why it stopped, in plain words. */
  why?: string;
  stoppedAt?: string;
  /** The open pull request a stopped plan is waiting on: when it is merged the plan carries on by itself. */
  watch?: string;
  /** The London day Paul was last told the plan is waiting for the daily cap. */
  capToldOn?: string;
}

/** What the driver needs of the job runner. JobRunner is this; tests may hand in less. */
export interface PlanJobs {
  start(kind: "engineer", brief: string, requestedBy: string, target: JobTarget, replyTo: string | undefined, extra: { title: string; doneWhen: string; plan: { id: string; step: number } }): Job;
  retry(id: string): Job;
  capReached(): boolean;
  /** True when a daily spending cap is set at all. */
  hasDailyCap(): boolean;
  pullState(url: string): Promise<"open" | "merged" | "closed" | undefined>;
  requestFixRound(url: string, by: string, replyTo: string): Promise<string>;
  reviewAgain(id: string): Job;
  verdictOf(review: Job, pr: string | undefined): { outcome: "merged" | "changes_requested" | "needs_founder"; detail?: string } | undefined;
}

type StepStatus =
  | { kind: "working" }
  | { kind: "done"; pr?: string }
  | { kind: "failed"; job: Job }
  | { kind: "blocked"; why: string; pr?: string; verdict?: "changes_requested" | "needs_founder" }
  | { kind: "unreviewed"; pr: string; job: Job };

const byCreated = (a: Job, b: Job) => a.createdAt.localeCompare(b.createdAt);
const stepWords = (plan: Plan, i: number) => `step ${i + 1} of ${plan.steps.length} (${plan.steps[i]!.title})`;

export class PlanRunner {
  private ticking = false;
  /** When each stopped plan's pull request was last looked up, so GitHub is asked every few minutes and not every turn. */
  private readonly looked = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly jobs: PlanJobs,
    private readonly messenger: Messenger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  all(): Plan[] {
    return this.store.settings().plans ?? [];
  }

  get(id: string): Plan | undefined {
    return this.all().find((p) => p.id === id.trim().toLowerCase());
  }

  private save(plan: Plan): void {
    const others = this.all().filter((p) => p.id !== plan.id);
    const open = [...others, plan].filter((p) => p.state === "running");
    const closed = [...others, plan].filter((p) => p.state !== "running").slice(-PLANS_KEPT);
    this.store.setSetting("plans", [...closed, ...open]);
  }

  private tell(plan: Plan, text: string): void {
    void this.messenger.send(plan.replyTo ?? plan.requestedBy, text).catch(() => undefined);
  }

  /**
   * Starts a plan. Throws plain words when it cannot: no steps, too many, a step without a brief or a
   * finish line, or another plan still open on the same repository (two would interleave their pull
   * requests on one default branch).
   */
  create(input: { title: string; target: JobTarget; steps: Array<{ title: string; brief: string; doneWhen: string }> }, requestedBy: string, replyTo?: string): Plan {
    // A plan spends without being asked each time, so the day's cap is what bounds it. With no cap set
    // nothing would, and that is not a decision to take by default.
    if (!this.jobs.hasDailyCap()) throw new Error("There is no daily spending cap set, and a plan runs job after job without asking, so nothing would bound what it spends. Paul sets one on the Spend page of the web app; then start the plan.");
    if (!input.steps.length) throw new Error("A plan needs at least one step.");
    if (input.steps.length > PLAN_MAX_STEPS) throw new Error(`A plan takes at most ${PLAN_MAX_STEPS} steps, and this one has ${input.steps.length}. Start the first ${PLAN_MAX_STEPS} as one plan and the rest as the next.`);
    input.steps.forEach((s, i) => {
      if (!s.brief.trim()) throw new Error(`Step ${i + 1} has no brief.`);
      if (!s.doneWhen.trim()) throw new Error(`Step ${i + 1} has no doneWhen: every step is an engineer job, and an engineer job needs its finish line.`);
    });
    const open = this.all().find((p) => p.target === input.target && p.state !== "done");
    if (open) throw new Error(`The plan "${open.title}" (${open.id}) is still ${open.state === "running" ? "running" : "stopped"} on that repository. Two plans on one repository would interleave their pull requests, so finish, resume or stop-and-skip that one first.`);
    const plan: Plan = {
      id: randomBytes(4).toString("hex").slice(0, 6),
      title: input.title,
      target: input.target,
      requestedBy,
      ...(replyTo ? { replyTo } : {}),
      createdAt: new Date(this.now()).toISOString(),
      state: "running",
      steps: input.steps.map((s) => ({ title: s.title.trim(), brief: s.brief.trim(), doneWhen: s.doneWhen.trim(), state: "todo" })),
    };
    this.save(plan);
    return plan;
  }

  /** The driver's turn, run every minute and after anything that changes a plan. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const { id } of this.all()) {
        const plan = this.get(id);
        if (!plan) continue;
        try {
          if (plan.state === "running") await this.advance(plan);
          else if (plan.state === "stopped" && plan.watch) await this.watch(plan);
        } catch (err) {
          console.warn(`plan ${plan.id} could not be advanced: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Where a step has got to, read from the job records alone. */
  private status(plan: Plan, i: number): StepStatus {
    const all = this.store.allJobs();
    const engineers = all.filter((j) => j.plan?.id === plan.id && j.plan.step === i).sort(byCreated);
    if (!engineers.length) return { kind: "blocked", why: "its job is no longer on record" };
    const ids = new Set(engineers.map((j) => j.id));
    const chain = [...engineers, ...all.filter((j) => j.kind === "maintain" && !!j.reviewOf && ids.has(j.reviewOf))].sort(byCreated);
    if (chain.some((j) => j.status === "queued" || j.status === "running")) return { kind: "working" };
    const last = chain[chain.length - 1]!;
    const pr = [...engineers].reverse().find((j) => j.pr)?.pr;
    if (last.status === "failed") return { kind: "failed", job: last };
    const settled = this.now() - Date.parse(last.finishedAt ?? last.createdAt) >= PLAN_SETTLE_MS;
    if (last.kind === "maintain") {
      const verdict = this.jobs.verdictOf(last, pr);
      if (verdict?.outcome === "merged") return { kind: "done", ...(pr ? { pr } : {}) };
      // A fix round is started a moment after its review finishes: give it that moment.
      if (!settled) return { kind: "working" };
      if (verdict?.outcome === "needs_founder") return { kind: "blocked", why: `it needs you${verdict.detail ? `: ${verdict.detail.slice(0, 300)}` : ` (show job ${last.id} has why)`}`, ...(pr ? { pr } : {}), verdict: "needs_founder" };
      if (verdict?.outcome === "changes_requested") return { kind: "blocked", why: `the maintainer still asks for changes after the automatic fix rounds (show job ${last.id})`, ...(pr ? { pr } : {}), verdict: "changes_requested" };
      return { kind: "blocked", why: pr ? `its review gave no verdict (show job ${last.id})` : `it opened no pull request (show job ${engineers[engineers.length - 1]!.id})`, ...(pr ? { pr } : {}) };
    }
    // The last job is an engineer's and it is done: its review starts a moment later.
    if (!settled) return { kind: "working" };
    if (!pr) return { kind: "blocked", why: `it opened no pull request and nothing reviewed it (show job ${last.id})` };
    return { kind: "unreviewed", pr, job: last };
  }

  /** True when the daily cap is holding the plan. Says so to Paul once a day. */
  private waitingForCap(plan: Plan, i: number): boolean {
    if (!this.jobs.capReached()) return false;
    const today = londonYmd(new Date(this.now()));
    if (plan.capToldOn !== today) {
      plan.capToldOn = today;
      this.save(plan);
      this.tell(plan, `The plan "${plan.title}" is waiting at ${stepWords(plan, i)}: today's spending cap is reached. It carries on by itself tomorrow, or sooner if you send /resume.`);
    }
    return true;
  }

  private stop(plan: Plan, i: number, why: string, watch?: string): void {
    plan.state = "stopped";
    plan.why = why;
    plan.stoppedAt = new Date(this.now()).toISOString();
    if (watch) plan.watch = watch;
    else delete plan.watch;
    this.save(plan);
    const next = watch ? `It carries on by itself if ${watch} is merged. Otherwise tell Marlo to resume the plan once that is sorted, or to skip the step.` : "Tell Marlo to resume the plan once that is sorted, or to skip the step.";
    this.tell(plan, `The plan "${plan.title}" has stopped at ${stepWords(plan, i)}: ${why}. ${next}`);
  }

  private doneStep(plan: Plan, i: number, pr?: string): void {
    const step = plan.steps[i]!;
    step.state = "done";
    step.finishedAt = new Date(this.now()).toISOString();
    if (pr) step.pr = pr;
    this.save(plan);
  }

  /** Moves a running plan as far as it can go right now. */
  private async advance(plan: Plan): Promise<void> {
    for (;;) {
      const i = plan.steps.findIndex((s) => s.state === "todo" || s.state === "working");
      if (i < 0) {
        plan.state = "done";
        delete plan.why;
        delete plan.watch;
        this.save(plan);
        const skipped = plan.steps.filter((s) => s.state === "skipped").length;
        this.tell(plan, `The plan "${plan.title}" is finished: ${plan.steps.length - skipped} of its ${plan.steps.length} steps are merged${skipped ? ` and ${skipped} ${skipped === 1 ? "was" : "were"} skipped` : ""}.`);
        return;
      }
      const step = plan.steps[i]!;
      if (step.state === "todo") {
        if (this.waitingForCap(plan, i)) return;
        let job: Job;
        try {
          job = this.jobs.start("engineer", step.brief, plan.requestedBy, plan.target, plan.replyTo, { title: step.title, doneWhen: step.doneWhen, plan: { id: plan.id, step: i } });
        } catch (err) {
          this.stop(plan, i, `its job could not be started (${err instanceof Error ? err.message : String(err)})`);
          return;
        }
        step.state = "working";
        step.jobId = job.id;
        this.save(plan);
        return;
      }
      const status = this.status(plan, i);
      if (status.kind === "working") return;
      if (status.kind === "done") {
        this.doneStep(plan, i, status.pr);
        continue;
      }
      if (status.kind === "failed") {
        if (!(await this.afterFailure(plan, i, status.job))) return;
        continue;
      }
      if (status.kind === "unreviewed") {
        // A pull request nothing reviewed after its last push: merged or closed in the meantime, or the review never started.
        const state = await this.jobs.pullState(status.pr);
        if (state === "merged") {
          this.doneStep(plan, i, status.pr);
          continue;
        }
        this.stop(plan, i, state === "closed" ? `${status.pr} was closed without being merged` : `nothing reviewed ${status.pr} after its last push (show job ${status.job.id})`, state === "closed" ? undefined : status.pr);
        return;
      }
      this.stop(plan, i, status.why, status.pr);
      return;
    }
  }

  /** A step's job failed. Returns true when the loop should look at the step again at once. */
  private async afterFailure(plan: Plan, i: number, job: Job): Promise<boolean> {
    const step = plan.steps[i]!;
    const kind = (job.failure ?? "error") as FailureKind;
    if (kind === "cancelled") {
      this.stop(plan, i, `its job was stopped (${job.id})`);
      return false;
    }
    // Credit or a rejected key holds the whole engineering queue, and /resume reruns what failed: the plan waits with it.
    if (HOLD_KINDS.includes(kind)) return false;
    if ((step.retries ?? 0) >= PLAN_RETRIES) {
      this.stop(plan, i, `its job failed ${PLAN_RETRIES + 1} times, the last because ${failureReason({ kind, detail: job.error ?? "" })} (show job ${job.id})`);
      return false;
    }
    if (this.waitingForCap(plan, i)) return false;
    if (this.store.queueHold()) return false;
    if (this.now() - Date.parse(job.finishedAt ?? job.createdAt) < PLAN_RETRY_WAIT_MS) return false;
    step.retries = (step.retries ?? 0) + 1;
    this.save(plan);
    this.jobs.retry(job.id);
    return false;
  }

  /** A stopped plan waiting on an open pull request: carries on when it has been merged. */
  private async watch(plan: Plan): Promise<void> {
    if (!plan.watch || this.now() - Date.parse(plan.stoppedAt ?? plan.createdAt) > PLAN_WATCH_MS) return;
    const i = plan.steps.findIndex((s) => s.state === "working");
    if (i < 0) return;
    if (this.now() - (this.looked.get(plan.id) ?? 0) < PLAN_WATCH_EVERY_MS) return;
    this.looked.set(plan.id, this.now());
    if ((await this.jobs.pullState(plan.watch)) !== "merged") return;
    const pr = plan.watch;
    plan.state = "running";
    delete plan.why;
    delete plan.watch;
    this.doneStep(plan, i, pr);
    await this.advance(plan);
  }

  /** Paul stops a plan. Its running job, if any, is left to finish: stopping a job is its own command. */
  halt(id: string): string {
    const plan = this.get(id);
    if (!plan) return `There is no plan ${id}.`;
    if (plan.state !== "running") return `The plan "${plan.title}" is already ${plan.state}.`;
    plan.state = "stopped";
    plan.why = "Paul stopped it";
    plan.stoppedAt = new Date(this.now()).toISOString();
    delete plan.watch;
    this.save(plan);
    const i = plan.steps.findIndex((s) => s.state === "working");
    return `The plan "${plan.title}" is stopped${i >= 0 ? ` at ${stepWords(plan, i)}. The job already running for that step is left to finish; nothing new starts` : ""}. resume carries on from where it is.`;
  }

  /**
   * Paul says to carry on. With `skip`, the step it stopped at is left and the next one starts.
   * Otherwise the step is taken up where it stopped: a failed job is retried, a merged pull request
   * counts as done, a pull request still asking for changes gets one more fix round, and one that was
   * waiting on Paul is reviewed again.
   */
  async resume(id: string, by: string, skip = false): Promise<string> {
    const plan = this.get(id);
    if (!plan) return `There is no plan ${id}.`;
    if (plan.state === "done") return `The plan "${plan.title}" is finished.`;
    if (plan.state === "running") return `The plan "${plan.title}" is running, not stopped.`;
    const i = plan.steps.findIndex((s) => s.state === "todo" || s.state === "working");
    const go = (said: string): string => {
      plan.state = "running";
      delete plan.why;
      delete plan.watch;
      delete plan.stoppedAt;
      this.save(plan);
      void this.tick();
      return said;
    };
    if (i < 0) return go(`The plan "${plan.title}" has no step left; it will close.`);
    const step = plan.steps[i]!;
    if (skip) {
      step.state = "skipped";
      step.finishedAt = new Date(this.now()).toISOString();
      return go(`Skipped ${stepWords(plan, i)}. The plan "${plan.title}" carries on with the next step; a later step that depends on the skipped one may fail.`);
    }
    if (step.state === "todo") return go(`The plan "${plan.title}" carries on at ${stepWords(plan, i)}.`);
    const status = this.status(plan, i);
    if (status.kind === "working" || status.kind === "done") return go(`The plan "${plan.title}" carries on at ${stepWords(plan, i)}.`);
    if (status.kind === "failed") {
      if (this.jobs.capReached()) return go(`The plan "${plan.title}" is running again. Today's spending cap is reached, so its failed job is retried tomorrow, or sooner if you send /resume.`);
      step.retries = 0;
      this.jobs.retry(status.job.id);
      return go(`The plan "${plan.title}" carries on: the failed job of ${stepWords(plan, i)} is being retried.`);
    }
    const pr = status.pr;
    if (!pr) {
      // No pull request to take up: the step starts again as a new job.
      step.state = "todo";
      delete step.jobId;
      step.retries = 0;
      return go(`The plan "${plan.title}" carries on: ${stepWords(plan, i)} starts again as a new job.`);
    }
    const state = await this.jobs.pullState(pr);
    if (state === "merged") {
      this.doneStep(plan, i, pr);
      return go(`${pr} is merged, so ${stepWords(plan, i)} is done and the plan "${plan.title}" carries on.`);
    }
    if (state === "closed") return `${pr} is closed without being merged, so ${stepWords(plan, i)} cannot carry on from it. Resume with skip to leave the step, or reopen the pull request first.`;
    if (status.kind === "blocked" && status.verdict === "changes_requested") {
      const said = await this.jobs.requestFixRound(pr, by, plan.replyTo ?? plan.requestedBy);
      return go(`The plan "${plan.title}" carries on. ${said}`);
    }
    const engineers = this.store.allJobs().filter((j) => j.plan?.id === plan.id && j.plan.step === i).sort(byCreated);
    const review = this.jobs.reviewAgain(engineers[engineers.length - 1]!.id);
    return go(`The plan "${plan.title}" carries on: ${pr} is being reviewed again (${review.id}).`);
  }

  /** The plans as the chief reports them: open ones first, each with where it is. */
  describe(): string {
    const plans = [...this.all()].reverse();
    if (!plans.length) return "There are no plans.";
    return plans
      .map((p) => {
        const done = p.steps.filter((s) => s.state === "done").length;
        const skipped = p.steps.filter((s) => s.state === "skipped").length;
        const i = p.steps.findIndex((s) => s.state === "todo" || s.state === "working");
        const head = `Plan ${p.id} "${p.title}" on ${p.target}: ${p.state}${p.state === "stopped" && p.why ? ` (${p.why})` : ""}. ${done} of ${p.steps.length} steps merged${skipped ? `, ${skipped} skipped` : ""}${i >= 0 ? `; now at ${stepWords(p, i)}` : ""}.`;
        const lines = p.steps.map((s, n) => `  ${n + 1}. ${s.title}: ${s.state}${s.jobId ? ` (job ${s.jobId})` : ""}${s.pr ? ` ${s.pr}` : ""}`);
        return [head, ...lines].join("\n");
      })
      .join("\n\n");
  }
}
