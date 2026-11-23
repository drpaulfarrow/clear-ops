import type { PrState } from "./pr-state.js";
import { SitePolicy } from "./site-policy.js";
import { safeVaultDomains, vault } from "./vault.js";
import { BROWSE_KINDS, SEARCH_KINDS, webToolsFor, type WebTools } from "./web-tools.js";
import { EVIDENCE_RULE, retrieve } from "./retrieval.js";
import { SIGNUP_NOTE, SIGNUP_TOOLS } from "./signup-gate.js";
import { PURCHASE_NOTE, PURCHASE_SERVER, PURCHASE_TOOLS, purchaseServer, type PurchaseGate } from "./purchase.js";
import { BEAT_NOTE, BEAT_SERVER, BEAT_TOOLS, beatServer } from "./beats.js";
import { perJobModelError, provider, resolveModel, runRoute } from "./llm.js";
import { engageRunFallback, isWithdrawnModelFailure } from "./model-ops.js";
import { isAliasName, type CatalogueRole } from "./catalogue.js";
import type { OtpRelay } from "./otp.js";
import { DocReaderError, type DocReader } from "./doc-reader.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bookingLink, config } from "./config.js";
import { londonYmd } from "./london.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, RunOptions, RunResult } from "./agents.js";
import { describeWorkerTool, JobProgress, type JobProgressOptions } from "./status.js";
import { nextCheckAt, type Canary, type CanaryProvider } from "./auto-resume.js";
import { BRIDGE_READ_DENY, CONTRACT_HEADING, DEEP_RESEARCH_NOTE, detectDepth, repoPaths, MAX_DESIGN_ROUNDS, MAX_FIX_ROUNDS, PR_KINDS, readableDirs, repoFocus, runLimits, SCHEDULE_VERDICT, workerSpec, type RunLimits } from "./agents.js";
import { designRoot, parseDesignVerdict, reportImages, waitForProductDeploy, type DeployWait } from "./design.js";
import type { Job, JobKind, JobPermit, JobStatus, JobTarget, PendingAction, SavedWork, Store } from "./store.js";
import type { Messenger } from "./whatsapp.js";
import { addToReport, parseOutcome, shortText, splitReport, reportPointer } from "./messages.js";
import { FailureNotifier, failureFromError, failureLabel, failureReason, HOLD_KINDS, RunFailedError, runFailure, type BudgetStop, type FailureKind, type FailureNotifierOptions, type RunFailure } from "./failures.js";
import { RealCostMeter, usdAmount, type JobCostWatch, type RealCost } from "./realcost.js";
import { CREATE_REPO_NOTE, REPO_SERVER } from "./repo-tools.js";
import { spendDisplay, storeMeter, type RealSpend, type SpendMeter } from "./spend.js";
import { repoRegistry } from "./repos.js";
import { PLAN_FIX_ROUNDS, PlanRunner } from "./plans.js";
import { isImageInputFailure, isTextOnly, rememberTextOnly, switchedNote, TEXT_ONLY_NOTE, visionAlias } from "./image-input.js";
import { CARRY_MAX_PER_REPO, CARRY_PER_JOB, carriedFree, carriedSection, parseCarryLines, type CarriedFinding } from "./carry.js";
import { randomBytes } from "node:crypto";
import { JobTrace, tracesDir, type RawTraceEvent } from "./trace.js";
import { removeSnapshot, snapshotRepos } from "./bridge-snapshot.js";
import { jobCredentialNote } from "./bootstrap.js";
import { buildTitle, deriveTitle, designRoundTitle, fixTitle, isScheduledRun, jobLabel, jobRef, jobTitle, reviewTitle } from "./titles.js";
import { preparedCopies, setupNote, workerBuildEnv, type PreparedCopies } from "./setup.js";
import { isPrivateKind, jobUsageFromRun, roleForKind, UsageRecorder, withRealCost, type JobUsage, type ModelCall, type RunUsage } from "./telemetry.js";

const exec = promisify(execFile);

/** The kinds that build and test what they write, so their working copy is worth preparing (src/setup.ts). */
/** The only kinds a job from the Instinct bridge may be: read the web and the repositories, write a report. */
export const BRIDGE_KINDS: JobKind[] = ["research", "write"];

const BUILDS = (kind: JobKind) => PR_KINDS.includes(kind) || kind === "maintain";

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

/**
 * The catalogue role a job's kind runs as, for the runtime model fallback (src/model-ops.ts
 * engageRunFallback): the worker, engineer, maintainer and designer tiers the catalogue can move.
 * An executive-assistant job has none (it runs on Anthropic, where the fallback path never fires);
 * every other kind the runner starts is one of the four.
 */
function catalogueRole(kind: JobKind): CatalogueRole | undefined {
  const role = roleForKind(kind);
  return role === "worker" || role === "engineer" || role === "maintainer" || role === "designer" ? role : undefined;
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
  /** When the job's usage was last written to the store; also at most once a minute (state.json is one file). */
  usagePersistedAt: number;
  /** Waiting for the product's deploy before a design round looks: not working yet, so never stalled. */
  waiting: boolean;
  /** Waiting for a working copy of its own (another job is in the checkout): not working, so never stalled. */
  waitingForCopy: boolean;
  /** The run returned and the job is being reported: too late to stop it. */
  finishing: boolean;
  /** The worker's latest step in plain words (src/status.ts describeWorkerTool), for the jobs board. */
  step?: string;
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
  /** How often a job that could not be given a copy of its own looks again for a free checkout. Default 10 seconds. */
  copyWaitMs?: number;
}

/**
 * The machine's load, as one line for the log, when an engineering job starts. The kernel's own 1-minute
 * average spread over the cores: at or above one runnable task per core the machine is fully spoken for.
 * Nothing here delays, slows or queues a job: a busy machine is visible in the log rather than discovered
 * later, and the work goes ahead exactly as it would have (no throttle ever hides behind this).
 */
export function loadNote(load = os.loadavg()[0], cores = os.cpus().length, perCore = 1): string | undefined {
  if (!Number.isFinite(load) || !Number.isFinite(cores) || cores < 1 || load < perCore * cores) return undefined;
  return `heavy load ${load.toFixed(1)} on ${cores} cores`;
}

/** What the machine has left to give: how much of it is spoken for, in bytes. */
export interface Memory {
  total: number;
  /** Memory another process could have without the kernel swapping or killing something, where known. */
  available: number;
}

/**
 * The machine's memory as the kernel sees it: MemAvailable from /proc/meminfo where it exists, else
 * whatever Node can say. This is the tighter limit than the cores when several jobs build and test at
 * once (four typechecks and their test runs measured 3.6GB of a 4GB machine), so it is worth naming.
 */
export function readMemory(): Memory {
  const total = os.totalmem();
  try {
    const info = fs.readFileSync("/proc/meminfo", "utf8");
    const available = /^MemAvailable:\s+(\d+) kB/m.exec(info);
    if (available) return { total, available: Number(available[1]) * 1024 };
  } catch {
    // Not Linux, or no /proc: fall back to what Node reports.
  }
  return { total, available: os.freemem() };
}

/**
 * One line for the log when the machine is nearly out of memory, so four jobs at once is seen in the log
 * rather than discovered as an out-of-memory restart. Like loadNote it only describes: nothing waits,
 * slows or queues because of it.
 */
export function memoryNote(memory: Memory = readMemory(), nearlyFull = 0.12): string | undefined {
  const { total, available } = memory;
  if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0 || available < 0) return undefined;
  if (available > nearlyFull * total) return undefined;
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  return `memory nearly full, ${gb(available)} of ${gb(total)} free`;
}

/** How long a job waits before looking again for a working copy of its own (tests shorten it). */
const COPY_WAIT_MS = 10_000;

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
/** A browse kind's permits: the sign-up permit as granted, plus the purchase permit if granted. */
function withPurchase(kept: JobPermit[], granted: JobPermit[] | undefined): JobPermit[] | undefined {
  const all = granted?.includes("purchase") ? [...kept, "purchase" as const] : kept;
  return all.length ? all : undefined;
}

/**
 * Builds the meter that counts one job's real cost, given the job's cap in the provider's money and
 * the way to stop the run when the provider's own figures pass it. Tests inject one with their own
 * fetch, so the accounting is covered offline.
 */
export type CostWatchFactory = (capUsd: number | undefined, stop: () => void) => JobCostWatch;

/**
 * Which money limit one run is given. On OpenRouter the SDK gets only its own runaway guard and the
 * job's cap is counted from the provider's own figures; on Anthropic the SDK's list-price cost is the
 * bill, so the job's cap itself is handed to the SDK.
 */
interface RunCap {
  /** The figure handed to the Agent SDK as `maxBudgetUsd`, in the estimate it prices it from. */
  sdkUsd: number;
  /** True when this run goes to Anthropic's API directly, where the SDK's cost is the bill. */
  onAnthropic: boolean;
  /** True when the limit that stopped the run was the SDK's own runaway guard, not a cap Paul set. */
  isGuard: boolean;
}

/** The longest contract kept on a job. */
export const DONE_WHEN_MAX = 1200;

/** The brief with its contract as the last section; a brief that already ends with this contract is left alone. */
export function withContract(brief: string, doneWhen: string): string {
  const section = `${CONTRACT_HEADING}\n${doneWhen.trim()}`;
  return brief.includes(section) ? brief : `${brief.trimEnd()}\n\n${section}`;
}

/**
 * A fix round's brief quotes the task it is fixing. From the second round on that task is itself a fix
 * brief, so the quote would nest (and grow) every round: take the innermost original task instead.
 */
export function originalTask(brief: string): string {
  const marker = "\n\nOriginal task:\n";
  const at = brief.indexOf(marker);
  if (at < 0) return brief;
  const rest = brief.slice(at + marker.length);
  const end = rest.indexOf("\n\nMaintainer's review (job ");
  return end < 0 ? rest : rest.slice(0, end);
}

/** The words of a review that carry its substance: lower case, no numbers, hashes, links or short words. */
function reviewWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\b[0-9a-f]{7,40}\b/g, " ")
      .split(/[^a-z_./-]+/)
      .filter((w) => w.length >= 5),
  );
}

/** How alike two reviews must be to count as raising the same blockers (share of words in common). */
export const SAME_BLOCKERS = 0.7;

/**
 * Whether two reviews of the same pull request raise the same blocking issues: most of their words are
 * shared. Deliberately blunt and deterministic. A false alarm costs one message to Paul, who can say
 * "one more fix round"; a miss costs one more round, bounded by MAX_FIX_ROUNDS as before.
 */
export function sameBlockers(a: string, b: string): boolean {
  const x = reviewWords(a);
  const y = reviewWords(b);
  if (x.size < 12 || y.size < 12) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= SAME_BLOCKERS;
}

/** What the fix-round engineer is told about earlier rounds: the last two reviews, clipped. */
export function deadEnds(earlier: Array<{ id: string; text: string }>): string {
  if (!earlier.length) return "";
  const shown = earlier.slice(-2).map((r) => `Earlier review (job ${r.id}):\n${r.text.length > 1500 ? `${r.text.slice(0, 1500)}\n[cut]` : r.text}`);
  return `\n\nAlready tried: this pull request has been through ${earlier.length} earlier review${earlier.length === 1 ? "" : "s"}. Anything below that the latest review raises again was not fixed by the last round, so the approach taken then is a dead end: read what was done (git log on the branch) and take a different one, and say in your report what you did differently.\n\n${shown.join("\n\n")}`;
}

/** Finished jobs waiting to be priced, one after another (`JobRunner.priceAfter`). */
let pricing: Promise<void> = Promise.resolve();
/** Resolves once every finished job has been priced. For the tests. */
export const pricingSettled = (): Promise<void> => pricing;

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
  private readonly copyWaitMs: number;
  private readonly saveWork: (job: Job, why: StopReason["kind"]) => Promise<SavedWork | undefined>;
  /** Which job holds each repository's engineering lock in this process. */
  /** The jobs holding each repository's slots (at most `slots` each), by repository. */
  private holders = new Map<JobTarget, string[]>();
  /** Engineering jobs that may run at once per repository, each in its own working copy. */
  private readonly slots: number;
  /** Engineering jobs at once across all repositories (config.engineerTotal). */
  private readonly total: number;

  private readonly waitForDeploy: DeployWait;
  /** Batches failure messages so an outage that fails many jobs sends Paul one message, not a flood. */
  readonly failures: FailureNotifier;
  /** Told when a job finishes with a saved output (the outputs repository copy). Fire and forget: it can never fail or delay a job. */
  private readonly onOutput?: (job: Job) => void;
  /** The purchase approval gate (src/purchase.ts), for jobs holding the purchase permit. */
  private readonly purchase?: PurchaseGate;
  /**
   * The one-time code relay (src/otp.ts): a browsing job's sign-in that asks for a code gets it from the
   * service, which reads the site's email or asks Paul in chat, and never from the worker.
   */
  private readonly otp?: OtpRelay;
  /**
   * The private Google Docs reader (src/doc-reader.ts). A snapshot is bound to one job only when
   * Paul starts that job with the private source handle a staged read handed him (never through a
   * chat command, which is refused before any fetch), and snapshotBlock hands its text to that job
   * alone.
   */
  private readonly docs?: DocReader;
  /**
   * Where the spend figure comes from (src/spend.ts): the provider's own usage where it can be read,
   * and the SDK's estimate only as the internal stand-in the daily cap falls back to. Only the
   * provider's figure is ever shown; `spendDisplay` is the one way it reaches a message.
   */
  private readonly spend: SpendMeter;
  /** The running commentary in each job's thread (src/status.ts JobProgress). */
  private readonly progressOpts: JobProgressOptions;
  /** The auto-resume check (src/auto-resume.ts), and how many checks this hold has failed. */
  private readonly canary?: Canary;
  private autoResume = { holdSince: "", attempts: 0, lastAt: 0, busy: false };
  /**
   * Builds the meter that counts one job's real cost (src/realcost.ts): the sum of what the provider
   * charged for its calls, which is the only money a job's own cap is ever counted in.
   */
  private readonly costWatch: CostWatchFactory;
  /** Reused dependency installs for the working copies coding jobs run in (src/setup.ts). */
  private readonly setup: PreparedCopies;
  /**
   * Draining for a deploy (23 Nov 2026, Paul: "Can we pause jobs for deploy elegantly?"). While it lasts,
   * no job starts: a new or queued one is held exactly as the spend cap holds it (`capBlocked`) and
   * starts when the drain ends, which is when it lapses or when the service restarts (it lives in
   * memory only, so a new process always starts undrained). Running jobs carry on; whatever is still
   * running when the deploy goes ahead resumes its own conversation after the restart, with its
   * working folder as it was on the data volume.
   */
  private drainUntil = 0;
  /** The longest a drain may last, so a deploy that never comes cannot hold the queues for long. */
  static readonly DRAIN_MAX_MINUTES = 30;

  /** Starts (or extends) a drain for `minutes`, capped. What is running and what is held now. */
  drain(minutes: number): { until: string; running: number; held: number } {
    const m = Math.min(Math.max(1, Math.round(Number.isFinite(minutes) ? minutes : 0)), JobRunner.DRAIN_MAX_MINUTES);
    this.drainUntil = Math.max(this.drainUntil, this.now() + m * MINUTE);
    return { until: new Date(this.drainUntil).toISOString(), running: this.activeCount(), held: this.store.allJobs().filter((j) => j.status === "queued").length };
  }

  /** When the drain ends, while one is on. */
  draining(): string | undefined {
    return this.now() < this.drainUntil ? new Date(this.drainUntil).toISOString() : undefined;
  }

  /** Holds a job for the deploy: queued, behind its repository's holder if it has one, started when the drain ends. No message: it is minutes. */
  private blockForDeploy(job: Job): Job {
    const key = lockKey(job);
    const holder = key ? this.holder(key) : undefined;
    return this.store.updateJob(job.id, { status: "queued", capBlocked: true, ...(key ? { waitingFor: holder ?? job.id, queuePos: this.nextQueuePos() } : {}) });
  }

  /** How many workers are running right now (not waiting for a deploy or a working copy): what the deploy waits on. */
  activeCount(): number {
    return [...this.live.values()].filter((l) => !l.waiting && !l.waitingForCopy && !l.stop).length;
  }

  private readonly prState?: (url: string) => Promise<PrState | undefined>;

  /** Whether a pull request is no longer open, as GitHub says now: "merged" or "closed", or undefined when it is open or could not be asked. */
  private async gone(url: string | undefined): Promise<"merged" | "closed" | undefined> {
    if (!url || !this.prState) return undefined;
    const state = await this.prState(url).catch(() => undefined);
    return state === "merged" || state === "closed" ? state : undefined;
  }

  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly run: AgentRunner,
    /** Extra tool servers for a job (the executive assistant's Google tools). Built per job so permits apply. */
    private readonly toolsFor: (job: Job) => Record<string, McpServerConfig> | undefined = () => undefined,
    opts: {
      waitForDeploy?: DeployWait;
      onOutput?: (job: Job) => void;
      failureNotices?: FailureNotifierOptions;
      liveness?: LivenessOptions;
      purchase?: PurchaseGate;
      otp?: OtpRelay;
      docs?: DocReader;
      slots?: number;
      /** Engineering jobs at once across all repositories; defaults to config.engineerTotal. */
      total?: number;
      spend?: SpendMeter;
      progress?: JobProgressOptions;
      costWatch?: CostWatchFactory;
      setup?: PreparedCopies;
      /** Whether the provider answers again after a credit or key hold (src/auto-resume.ts); off in tests unless given. */
      canary?: Canary;
      /**
       * What GitHub says of a pull request right now (src/pr-state.ts `fresh`), asked before a fix round
       * or its re-review is started, so neither runs on a pull request that has been merged or closed
       * meanwhile. Absent, or unanswered, and the loop carries on as it would have.
       */
      prState?: (url: string) => Promise<PrState | undefined>;
    } = {},
  ) {
    this.canary = opts.canary;
    this.prState = opts.prState;
    this.costWatch = opts.costWatch ?? ((capUsd, stop) => new RealCostMeter({ capUsd, onExceeded: stop }));
    this.progressOpts = opts.progress ?? {};
    this.waitForDeploy = opts.waitForDeploy ?? waitForProductDeploy;
    this.onOutput = opts.onOutput;
    this.purchase = opts.purchase;
    this.otp = opts.otp;
    this.docs = opts.docs;
    this.spend = opts.spend ?? storeMeter(store);
    this.setup = opts.setup ?? preparedCopies;
    this.slots = Math.max(1, opts.slots ?? config.engineerSlots);
    this.total = Math.max(1, opts.total ?? config.engineerTotal);
    const l = opts.liveness ?? {};
    this.stallMs = l.stallMs ?? config.jobStallMinutes * MINUTE;
    this.maxRuntimeMs = l.maxRuntimeMs ?? config.jobMaxRuntimeMinutes * MINUTE;
    this.graceMs = l.graceMs ?? 30_000;
    this.now = l.now ?? Date.now;
    this.copyWaitMs = l.copyWaitMs ?? COPY_WAIT_MS;
    this.saveWork = l.saveWork ?? defaultSaveWork;
    this.failures = new FailureNotifier(messenger, opts.failureNotices, (kind) => this.holdSentence(kind));
    this.plans = new PlanRunner(store, this, messenger, () => this.now());
  }

  /** The plans this runner drives to completion (src/plans.ts). */
  readonly plans: PlanRunner;

  /** True when a daily spending cap is set at all: a plan is not started without one (src/plans.ts). */
  hasDailyCap(): boolean {
    return config.dailyBudgetUsd !== undefined;
  }

  /** A pull request's state as GitHub has it now, for the plan driver. Undefined when it cannot be read. */
  async pullState(url: string): Promise<"open" | "merged" | "closed" | undefined> {
    if (!this.prState) return undefined;
    const state = await this.prState(url).catch(() => undefined);
    return state === "open" || state === "merged" || state === "closed" ? state : undefined;
  }

  /** The verdict a finished review gave on a pull request (its last one), read from its saved report. */
  verdictOf(review: Job, pr: string | undefined): ReviewVerdict | undefined {
    const verdicts = parseReviewVerdicts(this.store.readOutput(review.id) ?? "");
    return (pr ? verdicts.filter((v) => samePr(v.pr, pr)) : verdicts).at(-1);
  }

  /**
   * Has the maintainer review an engineer job's pull request again, exactly as the review that
   * followed the job did. For a plan Paul resumes after sorting out what a review was waiting on.
   */
  reviewAgain(id: string): Job {
    const job = this.store.getJob(id);
    if (!job || job.kind !== "engineer" || !job.pr) throw new Error(`Job ${id} has no pull request to review again.`);
    const report = this.store.readOutput(id) ?? "";
    return this.start("maintain", `Review the pull request ${job.pr} again: what it was waiting on has been dealt with.\n\n${job.brief}${carriedSection(this.carriedFor(job, job.pr))}\n\nEngineer's report:\n${report}`, job.requestedBy, job.target, job.replyTo, { title: reviewTitle(job), reviewOf: id, pr: job.pr });
  }

  start(kind: JobKind, brief: string, requestedBy: string, target: JobTarget = "product", replyTo?: string, extra: Pick<Job, "title" | "pr" | "fixRound" | "reviewOf" | "permits" | "designLoop" | "designRound" | "designFinal" | "awaitDeploy" | "depth" | "origin" | "triggerMessage" | "model" | "reviewOnly" | "doneWhen" | "plan"> = {}, launch: { source?: string } = {}): Job {
    // Permits are per kind: the executive assistant's drafts and holds, and an engineer's create_repo.
    // The chief grants them only when Paul asked in chat; nothing else gets any.
    extra = { ...extra };
    // A job from the Instinct bridge: only these kinds, never a permit, whatever the caller passed. The
    // rule lives here, in the one function every job goes through, not in a prompt.
    if (extra.origin === "instinct") {
      if (!BRIDGE_KINDS.includes(kind)) throw new Error(`The Instinct bridge cannot start a ${kind} job.`);
      delete extra.permits;
      extra.origin = "instinct";
      delete extra.triggerMessage;
      // Nor a model pin or the review-only flag: both are the owner's own start_job and nothing else's,
      // so a bridge job never carries either, whatever a caller passed here.
      delete extra.model;
      delete extra.reviewOnly;
      delete extra.doneWhen;
    } else delete extra.origin;
    if (kind === "ea") extra.permits = extra.permits ? [...new Set(extra.permits)].filter((p) => p === "drafts" || p === "holds" || p === "send") : extra.permits;
    else if (kind === "dns") extra.permits = extra.permits?.includes("dns") ? ["dns"] : undefined;
    else if (kind === "engineer") extra.permits = extra.permits?.includes("create_repo") ? ["create_repo"] : undefined;
    // The sign-up permit goes to the kinds that carry the browser, and to them only.
    // So does the purchase permit (the browser fills the basket; Paul approves each order).
    else if (BROWSE_KINDS.includes(kind)) extra.permits = withPurchase(extra.permits?.includes("signup") ? ["signup"] : [], extra.permits);
    else delete extra.permits;
    if (!extra.permits) delete extra.permits;
    // Only research has a depth; unlabelled research (a scheduled run, say) takes it from the brief.
    if (kind !== "research") delete extra.depth;
    else extra.depth = extra.depth === "deep" || extra.depth === "standard" ? extra.depth : detectDepth(brief);
    // A model pinned for this one job, and the review-only flag, are validated here too, in the one
    // function every job goes through: an unknown or alias model never reaches a run, and only a kind
    // that opens a pull request can be review only. Both unset leave everything exactly as it was.
    if (extra.model !== undefined) {
      const refused = perJobModelError(extra.model);
      if (refused) throw new Error(refused);
      if (kind === "ea") throw new Error("The executive assistant always runs on Claude on Anthropic's API directly, so its model cannot be pinned for a job.");
      extra.model = extra.model.trim();
    }
    if (extra.reviewOnly !== undefined) {
      if (!PR_KINDS.includes(kind)) throw new Error(`A ${kind} job cannot be review only: only ${PR_KINDS.join(" and ")} open a pull request for Paul to review.`);
      if (extra.reviewOnly !== true) delete extra.reviewOnly;
    }
    // A shaped brief (src/brief.ts) is shaped in the prompt, never gated here: whether its contract
    // carries acceptance IDs ("A1:", "A2:") is the chief's shaping guidance to follow, not a rule
    // the runner enforces. The IDs are review evidence: the engineer reports against them and the
    // maintainer checks each by ID during review, in the review loop exactly as it is. This funnel
    // never refuses a brief over them and never inspects a report for them.
    // The contract: only an engineer job has one, and it rides at the end of the brief, so the review
    // and every fix round (which quote the brief) carry it with no further plumbing.
    if (kind !== "engineer" || !extra.doneWhen?.trim()) delete extra.doneWhen;
    else {
      extra.doneWhen = extra.doneWhen.trim().slice(0, DONE_WHEN_MAX);
      brief = withContract(brief, extra.doneWhen);
    }
    // Explicit owner-selected prelaunch binding of a private source (src/doc-reader.ts): the one
    // staged snapshot behind the private handle passed with the start is bound to this job between
    // creating it and dispatching it, so the worker receives exactly that explicitly selected
    // source in its first prompt. There is no ambient next-job binding: without a handle nothing
    // is ever bound. Every refusal of the handle (not one of ours, lapsed, another owner's, a
    // kind that cannot work from a source, no reader wired) happens in checkSource, before the
    // job is created, so a refusal starts nothing. A job marked for a source never runs
    // source-free: a bind that could not happen fails the job closed.
    if (launch.source !== undefined) {
      const docs = this.docs;
      if (!docs) throw new DocReaderError("A private source was requested, but the document reader is not available, so nothing was started.");
      docs.checkSource(launch.source, { kind, requestedBy });
    }
    const job = this.store.createJob(kind, brief, requestedBy, target, replyTo, extra);
    if (launch.source !== undefined) {
      const docs = this.docs!;
      const bound = docs.bindSource(launch.source, job.id);
      if (!bound) {
        this.store.updateJob(job.id, { status: "failed", finishedAt: new Date().toISOString(), error: "The private source could not be bound to this job, so it was not started.", failure: "error" });
        throw new DocReaderError("The private source could not be bound to this job, so it was not started.");
      }
      this.store.updateJob(job.id, { docSnapshot: true });
    }
    return this.dispatch(job);
  }

  /**
   * Runs a queued job now, or puts an engineering job in its repository's queue: behind the job holding
   * the lock, or, while the queues are held after a credit or key failure, behind the job that failed.
   * `ignoreHold` is for a job Paul explicitly asked to retry.
   */
  private dispatch(job: Job, ignoreHold = false, passHoldOnly = false): Job {
    const key = lockKey(job);
    // Keep the spend figure current without waiting for it: cached, so at most one call a minute.
    void this.refreshSpend().catch(() => undefined);
    if (!ignoreHold && this.capReached()) return this.blockForCap(job);
    // A deploy is about to restart the service: nothing starts now, so nothing new is cut off.
    if (this.draining()) return this.blockForDeploy(job);
    if (key) {
      const holder = this.holder(key);
      if (holder) return this.store.updateJob(job.id, { waitingFor: holder, queuePos: this.nextQueuePos() });
      const hold = this.store.queueHold();
      if (hold && !ignoreHold && !passHoldOnly) return this.store.updateJob(job.id, { waitingFor: hold.jobId, queuePos: this.nextQueuePos() });
      this.take(key, job.id);
    }
    // Fire and forget. The webhook has already been acknowledged.
    void this.execute(job.id);
    return this.store.getJob(job.id) ?? job;
  }

  /**
   * The SDK's own estimate for jobs that finished today (London), priced from the table in
   * src/llm.ts. Internal only, never shown to anyone: on OpenRouter it is not the bill, so the cap
   * uses the provider's own figure whenever it can be read (`spendState`) and this is only the
   * stand-in for when it cannot.
   */
  spentToday(): number {
    return this.spendOn(londonYmd(new Date(this.now()))).total;
  }

  /** Jobs that finished on a London day with a recorded cost, and their total in dollars. The one place spend is summed. */
  spendOn(ymd: string): { total: number; jobs: Job[] } {
    const jobs = this.store.allJobs().filter((j) => j.finishedAt && j.costUsd && londonYmd(new Date(j.finishedAt)) === ymd);
    return { total: jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0), jobs };
  }

  /**
   * Today's spend (London) with its source: OpenRouter's own figure when it has been read recently,
   * the internal stand-in otherwise (which `spendDisplay` reports as there being no figure at all).
   * Never an unread or stale provider figure counted as zero.
   */
  spendState(): RealSpend {
    return this.spend.today(this.spentToday(), londonYmd(new Date(this.now())));
  }

  /**
   * Reads the provider's usage now, at most once a minute however often this is called. Never throws
   * and never waits longer than a few seconds, so it can never hold up a job's finish.
   */
  async refreshSpend(): Promise<void> {
    await this.spend.refresh();
  }

  /** True when today's spend is at or past the daily cap and /resume has not lifted it for today. */
  capReached(): boolean {
    const today = londonYmd(new Date(this.now()));
    const cap = config.dailyBudgetUsd;
    if (cap === undefined) return false;
    return this.store.capDays().liftedOn !== today && this.spendState().usd >= cap;
  }

  /** Leaves a job queued because of the cap, then confirms the figure before telling Paul. */
  private blockForCap(job: Job): Job {
    const key = lockKey(job);
    const holder = key ? this.holder(key) : undefined;
    const blocked = this.store.updateJob(job.id, { status: "queued", capBlocked: true, ...(key ? { waitingFor: holder ?? job.id, queuePos: this.nextQueuePos() } : {}) });
    void this.confirmCap(blocked).catch((err) => console.warn(`cap check failed: ${err instanceof Error ? err.message : err}`));
    return blocked;
  }

  /**
   * The cap blocks on the provider's own figure where it can be read, never on the estimate alone
   * while OpenRouter is reachable. This reads it once (cached, so at most one call a minute), starts
   * the job again if the real spend is under the cap, and only tells Paul once the figure is in.
   */
  private async confirmCap(job: Job): Promise<void> {
    await this.refreshSpend();
    if (!this.capReached()) {
      await this.releaseCapped();
      return;
    }
    this.noticeCap(job);
  }

  private noticeCap(blocked: Job): void {
    const today = londonYmd(new Date(this.now()));
    if (this.store.capDays().notifiedOn !== today) {
      this.store.setCapDays({ notifiedOn: today });
      const cap = `$${(config.dailyBudgetUsd ?? 0).toFixed(2)}`;
      const tail = "Send /resume to lift it for the rest of today, or they start tomorrow.";
      // The provider's own figure, or that there is none. The SDK's estimate is never printed: when
      // OpenRouter cannot be read the message says so and says the cap is on an internal stand-in.
      const display = spendDisplay(this.spendState());
      const text =
        display.kind === "figure"
          ? `The daily spend cap of ${cap} is hit: $${display.usd.toFixed(2)} spent today (${display.label}), so new jobs are waiting, starting with ${jobLabel(blocked)}. ${tail}`
          : `The daily spend cap of ${cap} is holding new jobs, starting with ${jobLabel(blocked)}: OpenRouter's usage could not be read just now (${display.reason}), so I cannot say what today has cost and the cap is judged on an internal stand-in figure. ${tail}`;
      void this.messenger.send(blocked.replyTo ?? blocked.requestedBy, text).catch(() => undefined);
    }
  }

  /** Starts jobs the cap was holding that are free to run, once it no longer applies. */
  private async releaseCapped(): Promise<void> {
    if (this.capReached() || this.draining()) return;
    for (const job of this.store.allJobs()) {
      if (job.status !== "queued" || !job.capBlocked) continue;
      this.store.updateJob(job.id, { capBlocked: undefined });
      if (!lockKey(job)) void this.execute(job.id);
    }
    for (const key of this.lockKeys()) await this.startNext(key);
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
    const n = this.lockKeys().reduce((sum, k) => sum + this.waiting(k).length, 0);
    return n
      ? `I have paused the engineering queue so the ${n === 1 ? "job" : `${n} jobs`} waiting in it ${n === 1 ? "does" : "do"} not fail the same way.`
      : "I have paused the engineering queue so nothing else fails the same way.";
  }

  /**
   * Puts a failed job back to work under the same id, title and links (pull request, review, loop), as
   * if it had just been started. Paul asked for it, so it runs even while the queues are held.
   */
  /**
   * Starts ONE engineer job on the workforce repo from a brief the caller has already pinned by hash. It passes the
   * queue hold for itself only (the hold stays set, nothing else starts, no failed job is retried) but still obeys the
   * daily spend cap and its repository's lock. No permits. Nothing reviews or merges it afterwards (see finish).
   */
  startCommission(commission: string, brief: string, requestedBy: string, title: string): Job {
    const job = this.store.createJob("engineer", brief, requestedBy, "self", undefined, { title, commission });
    return this.dispatch(job, false, true);
  }

  retry(id: string): Job {
    const job = this.store.getJob(id);
    if (!job) throw new Error(`No job ${id}.`);
    if (job.status !== "failed") throw new Error(`${jobRef(job, id)} is ${job.status}, not failed, so there is nothing to retry.`);
    const reset = this.store.updateJob(id, { status: "queued", error: undefined, failure: undefined, finishedAt: undefined, waitingFor: undefined, queuePos: undefined, resumed: undefined, sessionId: undefined });
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
      const reset = { status: "queued" as const, error: undefined, failure: undefined, finishedAt: undefined, resumed: undefined, sessionId: undefined };
      if (lockKey(job)) {
        // Line up first; startNext below hands each repository to the first in line.
        retried.push(this.store.updateJob(id, { ...reset, waitingFor: hold?.jobId ?? id, queuePos: front + i }));
      } else {
        retried.push(this.dispatch(this.store.updateJob(id, { ...reset, waitingFor: undefined, queuePos: undefined })));
      }
    });
    await this.releaseCapped();
    for (const key of this.lockKeys()) await this.startNext(key);
    return { retried: retried.map((j) => this.store.getJob(j.id) ?? j), skipped, released: !!hold };
  }

  /**
   * While a credit or key hold lasts, checks on a backing-off timer (2, 5, 10, 15, then every 30
   * minutes) whether the provider the failed job used would now answer a real one-token request, and
   * when it does, resumes exactly as /resume does and tells Paul in one sentence. Exported for tests.
   */
  async tryAutoResume(): Promise<boolean> {
    const hold = this.store.queueHold();
    if (!hold || !this.canary || this.autoResume.busy) return false;
    if (this.autoResume.holdSince !== hold.since) this.autoResume = { holdSince: hold.since, attempts: 0, lastAt: Date.parse(hold.since) || this.now(), busy: false };
    if (this.now() < nextCheckAt(this.autoResume.lastAt, this.autoResume.attempts)) return false;
    this.autoResume.busy = true;
    try {
      const held = this.store.getJob(hold.jobId);
      const which: CanaryProvider = held && runRoute(held, "haiku").provider === "anthropic" ? "anthropic" : provider() === "openrouter" ? "openrouter" : "anthropic";
      const answer = await this.canary(which);
      this.autoResume.lastAt = this.now();
      if (!answer.ok) {
        this.autoResume.attempts++;
        return false;
      }
      // Still the same hold (Paul may have sent /resume meanwhile): carry on as /resume would.
      if (this.store.queueHold()?.since !== hold.since) return false;
      const { retried } = await this.resume();
      const name = which === "openrouter" ? "OpenRouter" : "Anthropic";
      const reran = retried.length ? `, so I carried on and reran ${retried.length === 1 ? "the job that failed" : `the ${retried.length} jobs that failed`}` : ", so I carried on";
      const to = held?.replyTo ?? held?.requestedBy;
      if (to) await this.messenger.send(to, `${name} is answering again${reran}. No need to send /resume.`).catch(() => undefined);
      return true;
    } finally {
      this.autoResume.busy = false;
    }
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
    const occupants = this.occupants(key);
    if (occupants.length >= this.slots) return occupants[0];
    // The repository has room but the machine does not: wait behind whichever job holds a slot.
    return this.machineFull() ? this.anyHolder() : undefined;
  }

  /**
   * The jobs using a repository's slots: those this process gave a slot, then any a previous process
   * left marked running (until resumeInterrupted() has dealt with them), so a request during boot queues.
   */
  private occupants(key: JobTarget, except?: string): string[] {
    const held = (this.holders.get(key) ?? []).filter((id) => id !== except);
    const stale = this.store
      .allJobs()
      .filter((j) => j.status === "running" && lockKey(j) === key && !this.running.has(j.id) && !held.includes(j.id) && j.id !== except)
      .map((j) => j.id);
    return [...held, ...stale];
  }

  private full(key: JobTarget): boolean {
    return (this.holders.get(key) ?? []).length >= this.slots || this.machineFull();
  }

  /** Every repository's slots together: the machine-wide limit (ENGINEER_TOTAL). */
  private machineFull(except?: string): boolean {
    let n = 0;
    for (const ids of this.holders.values()) n += ids.filter((h) => h !== except).length;
    return n >= this.total;
  }

  /** The first job holding any slot: what a job waits behind when the machine, not its repository, is full. */
  private anyHolder(except?: string): string | undefined {
    for (const ids of this.holders.values()) for (const h of ids) if (h !== except) return h;
    return undefined;
  }

  private holds(key: JobTarget, id: string): boolean {
    return (this.holders.get(key) ?? []).includes(id);
  }

  /** Gives a job a slot and a working copy: its own earlier lane if free (a resumed job), else the lowest free one. */
  private take(key: JobTarget, id: string): void {
    const held = (this.holders.get(key) ?? []).filter((h) => h !== id);
    this.holders.set(key, [...held, id]);
    const used = new Set(held.map((h) => this.store.getJob(h)?.lane ?? 0));
    const own = this.store.getJob(id)?.lane ?? 0;
    let lane = own;
    if (used.has(lane)) for (lane = 0; used.has(lane); lane++);
    if (lane !== (this.store.getJob(id)?.lane ?? 0)) this.store.updateJob(id, { lane: lane || undefined });
    // A busy or nearly full machine is worth a log line: four cores and 4GB, several test runs and
    // typechecks at once. It is only ever a line. Nothing here waits, slows or holds back a job with a slot.
    const state = [loadNote(), memoryNote()].filter(Boolean).join(", ");
    if (state) console.log(`${state}: starting ${jobRef(this.store.getJob(id), id)} anyway.`);
  }

  /**
   * True when another job on this repository is working in its checkout rather than a copy of its own,
   * so this job has nowhere private to go (its own copy could not be made) and must wait for it.
   */
  private checkoutTaken(key: JobTarget, except: string): boolean {
    return (this.holders.get(key) ?? []).some((id) => id !== except && !this.store.getJob(id)?.lane);
  }

  /**
   * Waits until this job can have the checkout to itself, then claims it: its own copy of the repository
   * could not be made (git refused, or there is no room), and two jobs in one working copy would corrupt
   * each other's work, so the job waits rather than shares one. It keeps its slot while it waits, like a
   * design round waiting for a deploy, and looks again every `copyWaitMs`. False: the job went away first.
   */
  private async claimCheckout(job: Job, key: JobTarget): Promise<boolean> {
    const free = () => !this.checkoutTaken(key, job.id);
    // Claiming the checkout as lane 0, so the next job on this repository is given a lane of its own.
    if (free()) {
      this.store.updateJob(job.id, { lane: undefined });
      return true;
    }
    console.warn(`${jobLabel(job)} could not be given a working copy of its own: it waits for ${workerSpec(job.kind, job.target).cwd} rather than share it.`);
    for (;;) {
      if (free()) {
        this.store.updateJob(job.id, { lane: undefined });
        return true;
      }
      if (this.live.get(job.id)?.stop || !this.running.has(job.id)) return false;
      await new Promise((r) => setTimeout(r, this.copyWaitMs));
    }
  }

  private free(key: JobTarget, id: string): void {
    const left = (this.holders.get(key) ?? []).filter((h) => h !== id);
    if (left.length) this.holders.set(key, left);
    else this.holders.delete(key);
  }

  /** Every repository that has a lock: all managed repositories, plus any a stored job names. */
  private lockKeys(): JobTarget[] {
    const keys = new Set<JobTarget>(repoRegistry.aliases());
    for (const j of this.store.allJobs()) {
      const k = lockKey(j);
      if (k) keys.add(k);
    }
    return [...keys];
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
    // Fill every free slot, one queued job at a time.
    while (!this.full(key)) {
      const before = this.waiting(key).length;
      if (!before || !(await this.startOne(key, finished))) break;
    }
    // A slot freed here may be the machine-wide one another repository's queue is waiting for.
    if (finished) for (const other of this.lockKeys()) if (other !== key && !this.full(other)) await this.startNext(other);
  }

  /** Starts the first job in a repository's queue in a free slot. False when nothing could start. */
  private async startOne(key: JobTarget, finished?: string): Promise<boolean> {
    // Held after a credit or key failure: the queue waits for /resume instead of failing job after job.
    if (this.store.queueHold()) return false;
    const [next, ...rest] = this.waiting(key);
    if (!next) return false;
    if (this.draining()) {
      this.store.updateJob(next.id, { capBlocked: true });
      return false;
    }
    if (this.capReached()) {
      this.store.updateJob(next.id, { capBlocked: true });
      // Same path as a job blocked as it arrives: read the provider's own figure (cached, so at most
      // a call a minute) and only then tell Paul, so a stale estimate cannot hold the queue back.
      // If the real spend is under the cap, `confirmCap` releases the queue and the job starts.
      await this.confirmCap(next);
      return false;
    }
    this.store.updateJob(next.id, { capBlocked: undefined });
    this.take(key, next.id);
    this.store.updateJob(next.id, { waitingFor: undefined, queuePos: undefined });
    for (const j of rest) this.store.updateJob(j.id, { waitingFor: next.id });
    void this.execute(next.id);
    const done = finished ? this.store.getJob(finished) : undefined;
    const after = finished ? `, now that ${jobRef(done, finished)} has ${done?.status === "failed" ? "stopped" : "finished"}` : "";
    await this.messenger
      .send(next.replyTo ?? next.requestedBy, `Starting: ${jobLabel(next)} (was queued)${after}.`)
      .catch(() => undefined);
    return true;
  }

  /**
   * A deploy restarts the process, and a job that was running dies with it. The working
   * folders live on the volume, so the job is re-queued with a note to inspect the repo
   * state and carry on rather than start again. Jobs that were waiting for a repository's
   * lock stay in the queue in order; at most one job per repository is started. Called once on boot.
   */
  async resumeInterrupted(): Promise<number> {
    // One read of the provider's usage before any queue moves, so a restart does not resume jobs on
    // a stale day figure. Cached and time-limited; a failure falls back to the internal stand-in.
    await this.refreshSpend().catch(() => undefined);
    const jobs = this.store
      .interruptedJobs()
      // Anything this process already started (a request that arrived during boot) is not interrupted.
      .filter((j) => !this.running.has(j.id) && !j.waitingFor)
      // Jobs that were running reclaim their repository before ones that had not started yet.
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) await this.reclaim(job, "restart");
    // A repository nobody reclaimed (its job gave up, or none was running) starts its queue.
    for (const key of this.lockKeys()) {
      await this.startNext(key);
      // Requests that queued during boot behind a job that has since given up now wait for a real holder.
      const holder = this.holders.get(key)?.[0];
      if (holder) for (const j of this.waiting(key)) if (j.waitingFor !== holder && !this.isHeld(j)) this.store.updateJob(j.id, { waitingFor: holder });
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
    const others = key ? (this.holders.get(key) ?? []).filter((h) => h !== job.id) : [];
    const holder = key && others.length >= this.slots ? others[0] : key && this.machineFull(job.id) ? this.anyHolder(job.id) : undefined;
    const hold = this.store.queueHold();
    if (key && !holder && hold) {
      // The queues are held after a credit or key failure: wait for /resume rather than fail again.
      this.store.updateJob(job.id, { status: "queued", resumed, waitingFor: hold.jobId, queuePos: this.nextQueuePos() });
      this.free(key, job.id);
      await say(orphan ? `${lead}, so I put it back in the queue, which is paused until you send /resume because ${failureReason(hold)}.` : `${lead} The engineering queue is paused because ${failureReason(hold)}, so it waits; I carry on by myself once that is fixed, or send /resume.`);
      return;
    }
    if (key && holder) {
      // Another job on this repository has already reclaimed it: wait behind it.
      this.store.updateJob(job.id, { status: "queued", resumed, waitingFor: holder, queuePos: this.nextQueuePos() });
      const ref = jobRef(this.store.getJob(holder), holder);
      await say(orphan ? `${lead}, so I put it back in the queue behind ${ref}.` : `${lead} Queued behind ${ref}; it resumes when that finishes.`);
      return;
    }
    if (key) this.take(key, job.id);
    this.store.updateJob(job.id, { status: "queued", resumed });
    await say(orphan ? `${lead}, so I restarted it to carry on from where it left off (attempt ${resumed + 1}).` : `${lead} Resuming it (attempt ${resumed + 1}).`);
    void this.execute(job.id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * What a running job's worker is doing this minute, in plain words ("Editing jobs.ts"), or undefined
   * when this process is not running it. The jobs board shows it on the job's card; it is the same
   * phrase (src/status.ts describeWorkerTool) the job's thread gets, never a command or an argument.
   */
  latestStep(id: string): string | undefined {
    return this.live.get(id)?.step;
  }

  /**
   * A run that used all its turns without a final answer: one short turn more on the same conversation
   * to write up what it has. Returns that write-up as the run's result, with both runs' cost. If there
   * is no conversation to carry on, or the write-up comes back empty or runs out as well, the result is
   * a failure of its own kind ("turns"), so the job is recorded as failed and never as done with
   * nothing. A provider failure during the write-up (no credit, a rejected key) stays that failure.
   */
  private async writeUp(opts: RunOptions, spent: RunResult, turns: number): Promise<RunResult> {
    const none: RunFailure = { kind: "turns", detail: `It used all ${turns} of its turns and wrote no report.` };
    if (!spent.sessionId) return { ...spent, text: "", error: none, outOfTurns: undefined };
    const more: RunResult = await this.run({ ...opts, prompt: writeUpNote(turns), resume: spent.sessionId, maxTurns: WRITE_UP_TURNS }).catch((err) => ({ text: "", error: failureFromError(err) }));
    const costUsd = spent.costUsd === undefined && more.costUsd === undefined ? undefined : (spent.costUsd ?? 0) + (more.costUsd ?? 0);
    const both = { sessionId: more.sessionId ?? spent.sessionId, ...(costUsd !== undefined ? { costUsd } : {}), ...(more.usage ?? spent.usage ? { usage: more.usage ?? spent.usage } : {}) };
    if (more.error && HOLD_KINDS.includes(more.error.kind)) return { ...both, text: "", error: more.error };
    if (more.outOfTurns || runFailure(more)) return { ...both, text: "", error: none };
    return { ...both, text: more.text };
  }

  private async execute(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) return;
    const now = this.now();
    let settle = () => {};
    const settled = new Promise<void>((r) => (settle = r));
    const live: LiveRun = { abort: new AbortController(), startedAt: now, lastActivity: now, persistedAt: now, usagePersistedAt: now, waiting: !!job.awaitDeploy, waitingForCopy: false, finishing: false, settled, settle };
    this.live.set(id, live);
    this.running.add(id);
    const at = new Date(now).toISOString();
    this.store.updateJob(id, { status: "running", startedAt: at, lastActivityAt: at, capBlocked: undefined });
    let web: WebTools | undefined;
    // A bridge job's throwaway source copy (src/bridge-snapshot.ts), removed when the job ends.
    let snapshot: string | undefined;
    let progress: JobProgress | undefined;
    let costMeter: JobCostWatch | undefined;
    // What the job's model calls used (src/telemetry.ts). Kept in memory as the calls arrive and
    // written to the store at most once a minute, so a restart keeps what the job had already used.
    const usage = new UsageRecorder();
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
      const base = workerSpec(job.kind, job.target);
      // An engineering job running beside another on the same repository works in its own copy of it.
      const key = lockKey(job);
      const lane = key && job.lane && base.cwd ? await ensureLane(base.cwd, job.lane) : undefined;
      // Its own copy could not be made, and the checkout is another job's working copy: this job waits,
      // holding its slot, rather than write to the same files. It starts as soon as the checkout is free.
      if (key && lane !== undefined && lane === base.cwd && hasGitDir(lane)) {
        live.waitingForCopy = true;
        const mine = await this.claimCheckout(job, key);
        live.waitingForCopy = false;
        if (!mine) {
          // Stopped while it waited: the stop path records it (recordStop is idempotent).
          if (live.stop) throw new Error("stopped");
          return;
        }
        live.startedAt = live.lastActivity = live.persistedAt = this.now();
        this.store.updateJob(id, { startedAt: new Date(live.startedAt).toISOString(), lastActivityAt: new Date(live.startedAt).toISOString() });
      }
      const copied = lane && base.cwd ? { ...base, cwd: lane, prompt: `${base.prompt}\n\n${laneNote(base.cwd, lane)}` } : base;
      // A coding job's working copy is given the dependencies another job already installed for this
      // lockfile (src/setup.ts), and is told exactly what it got. Anything that goes wrong there
      // leaves the worker to install for itself, as it did before.
      const prepared = BUILDS(job.kind) && copied.cwd ? await this.setup.prepare(copied.cwd, job.target).catch(() => undefined) : undefined;
      const deps = prepared && copied.cwd ? setupNote(prepared, copied.cwd) : "";
      const bridged = job.origin === "instinct";
      if (bridged) snapshot = snapshotRepos(repoRegistry.list().map((r) => ({ alias: r.alias, dir: r.dir })));
      const specBase = deps ? { ...copied, prompt: `${copied.prompt}\n\n${deps}` } : copied;
      // A bridge job is told about its snapshot, not the live checkouts it may not read.
      const spec = bridged && snapshot ? { ...specBase, prompt: specBase.prompt.replace(repoPaths(), `Repositories: read-only source snapshots (no git history, no env files) are under ${snapshot}, one folder per repository (${repoRegistry.list().map((r) => r.alias).join(", ")}). Use Read, Glob and Grep with these absolute paths.`) } : specBase;
      const perJob = spec.perJob?.(id) ?? {};
      // Engineers building a design spec may read the designer's assets.
      // A job from the Instinct bridge reads its source snapshot and nothing else: not the live checkouts,
      // the uploads folder or the data directory (secrets, stored state, outputs of other jobs).
      const dirs = bridged ? [snapshot!] : perJob.additionalDirectories ?? (job.designLoop ? [...readableDirs(), designRoot()] : undefined);
      // Each kind's own tool servers only: a design job never gets the ea's Google server, and only a
      // design job gets the design server (it comes from the design spec alone).
      const fromService = job.kind === "design" ? undefined : this.toolsFor(job);
      const extraTools = fromService && !bridged ? Object.fromEntries(Object.entries(fromService).filter(([name]) => name !== "design")) : undefined;
      const ownTools = job.kind === "design" ? perJob.mcpServers : undefined;
      // The cv and advisor workers' own save tools, from their specs alone (toolsFor gives them nothing else).
      const cvTools = job.kind === "cv" || job.kind === "advisor" ? perJob.mcpServers : undefined;
      // The service's own search and read-only browser, for research-type kinds only (src/web-tools.ts).
      // The one-time code relay is bound to this job: a code request carries its id and its conversation,
      // and a run the system started (a scheduled run) is refused a code outright (src/otp.ts).
      const codes = this.otp?.forJob({ id, replyTo: job.replyTo, scheduled: isScheduledRun(job.brief) });
      web = webToolsFor(job.kind, {
        ...(bridged ? { noBrowse: true } : {}),
        browse: { policy: new SitePolicy(this.store, safeVaultDomains), vault, ...(codes ? { otp: codes } : {}), ...(job.permits?.includes("purchase") ? { purchasing: true } : {}) },
      });
      const notes = this.store.notes();
      const standing = notes.length && !bridged ? `\n\nStanding instructions from the founder:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
      const resume = job.resumed
        ? `\n\nThis job was interrupted by a service restart and is being resumed (attempt ${job.resumed + 1}). Work from a previous attempt may exist: check the working directory, git status and branches before doing anything, keep what is good, and continue from there rather than starting again.`
        : "";
      const carryOn = job.savedWork ? `\n\n${savedWorkNote(job.savedWork)}` : "";
      // Findings earlier reviews carried instead of blocking on (src/carry.ts): this engineer fixes
      // them in the pull request it was going to open anyway. Taken when the job starts running, not
      // when it was queued, so it gets what the review before it has only just written down.
      const carried = carriedSection(this.takeCarried(job));
      // The private source bound to this job, if any (src/doc-reader.ts): its text is handed to
      // this job's worker alone, fenced as untrusted data with its provenance, after the snapshot
      // is verified against the fingerprint recorded when it was read. A job marked as carrying a
      // bound source fails closed here if the source is absent, corrupt, modified, or the reader
      // itself is missing: it never runs source-free by accident, and no path, token or source
      // detail is ever mentioned in the failure.
      const marked = this.store.getJob(id)?.docSnapshot ?? job.docSnapshot;
      if (marked && !this.docs) throw new DocReaderError(`The private source bound to job ${id} cannot be checked because the document reader is not available, so the job refuses to run without it.`);
      let docNote = "";
      if (this.docs) {
        const block = marked ? this.docs.requireBound(id) : this.docs.snapshotBlock(id);
        if (marked && !block) throw new DocReaderError(`The private source bound to job ${id} produced no text, so the job refuses to run without it.`);
        docNote = block ? `\n\n${block}` : "";
      }
      const link = job.kind === "ea" ? bookingLink(this.store) : undefined;
      const permits =
        job.kind === "ea"
          ? `\n\nThis job may change: ${job.permits?.length ? job.permits.join(" and ") : "nothing (read only)"}.${link ? ` Paul's booking link for scheduling drafts: ${link}` : ""}`
          : "";
      const dnsPermit = job.kind === "dns" ? `\n\nThis job may: ${job.permits?.includes("dns") ? "prepare DNS changes for Paul's approval (dns_prepare_change); nothing is applied until he replies \"dns apply <id>\" himself" : "read only (no dns_prepare_change): list domains, records and snapshots, and explain"}.` : "";
      const createRepo = job.kind === "engineer" && job.permits?.includes("create_repo") ? `\n\n${CREATE_REPO_NOTE}` : "";
      const signupPermit = job.permits?.includes("signup") ? `\n\n${SIGNUP_NOTE}` : "";
      // A job allowed to buy (Paul asked in chat) gets the one tool that asks him to approve the exact order,
      // bound to its own browser. Without a browser or the gate it gets nothing.
      const buying = job.permits?.includes("purchase") && web.session && this.purchase ? purchaseServer({ gate: this.purchase, browser: web.session, jobId: id, replyTo: job.replyTo }) : undefined;
      const purchasePermit = buying ? `\n\n${PURCHASE_NOTE}` : "";
      // A write job can generate an instrumental from Paul's Stable Audio account (src/beats.ts): a
      // narrow tool on the write kind alone, its free credits only, the track saved into his private
      // beats folder with his private link in the worker's report. No other kind gets it, and nothing
      // on the path can buy credits: the account runs out and the job says so.
      const beats = job.kind === "write" ? beatServer(this.store) : undefined;
      const beatNote = beats ? `\n\n${BEAT_NOTE}` : "";
      const focus = job.kind !== "engineer" && job.kind !== "maintain" && job.kind !== "create_agent" ? repoFocus(job.target, job.kind) : "";
      const depth = job.kind === "research" && job.depth === "deep" ? `\n\n${DEEP_RESEARCH_NOTE}` : "";
      // Every run is capped on turns; deep research gets more of them.
      const limits = runLimits(job.kind, job.depth);
      // Which money limit this run is given, and on which provider.
      //
      // On OpenRouter the job's own cap is counted in the provider's money, call by call
      // (src/realcost.ts): the sum of what OpenRouter charged, read from its own figures. A job is
      // stopped for budget only when those figures have passed the cap, so it is never stopped while
      // it has really spent pennies, and when the provider cannot be read the cap simply does not fire
      // and the message says there is no figure. The SDK is given only its own runaway guard, priced
      // from its rounded-up estimate, which is not a bill.
      //
      // On Anthropic directly there is no per-call price to read and the SDK's list-price cost is what
      // is billed, so the job's own cap is handed to the SDK itself and the measure is named as
      // Anthropic's own list price. A model pinned for this job (PER_JOB_MODELS) is the model the run
      // sends, not a label: it overrides the kind's own model here, on the way to the SDK.
      const route = runRoute(job, job.model ?? spec.model);
      const onAnthropic = route.provider === "anthropic" || provider() === "anthropic";
      const cap: RunCap = onAnthropic
        ? { sdkUsd: limits.realBudgetUsd ?? limits.maxBudgetUsd, onAnthropic, isGuard: limits.realBudgetUsd === undefined }
        : { sdkUsd: limits.maxBudgetUsd, onAnthropic, isGuard: true };
      costMeter = this.costWatch(cap.onAnthropic ? undefined : limits.realBudgetUsd, () => live.abort.abort());
      // A job whose worker was handed a bound private source (docNote above, src/doc-reader.ts) traces
      // names and outcomes only, whatever its kind (src/trace.ts): `redact` knows token shapes, not a
      // document's own words, so a clipped command, tail or remark kept here could carry the source's
      // path and quotes past the one job the source is bound to. An unbound job keeps the detailed trace.
      const trace = new JobTrace(id, job.kind, tracesDir(), docNote !== "");
      trace.note(`${job.kind} on ${job.target ?? "product"}, model ${route.model}${job.resumed ? `, resumed (${job.resumed})` : ""}${job.fixRound ? `, fix round ${job.fixRound}` : ""}`);
      progress = new JobProgress(this.messenger, job.replyTo ?? job.requestedBy, this.progressOpts).start();
      const shown = progress;
      // Retrieval as a harness decision (src/retrieval.ts): before a search-carrying worker composes its
      // answer, the service decides on the cheap tier whether a search is needed, runs it itself within a
      // hard budget, and hands the results over as fenced evidence. A resumed run keeps what it already had.
      let evidence = "";
      if (SEARCH_KINDS.includes(job.kind) && !job.resumed) {
        const outcome = await retrieve(job.brief, { note: (line) => shown.note(line) });
        this.store.updateJob(id, { retrieval: outcome.record });
        evidence = outcome.evidence;
      }
      const evidencePrefix = evidence ? `${evidence}\n\n` : "";
      // A model already known to take no images (src/image-input.ts): this run cannot open an image
      // file, and is told so, before it can end itself on one.
      // Where a larger tier can see, a run that needs to look stops instead and the job switches to it.
      const runModel = onAnthropic ? route.model : resolveModel(route.model);
      const textOnly = isTextOnly(this.store, runModel);
      const needsImage: { file?: string } = {};
      const canSwitch = textOnly && !onAnthropic && visionAlias(this.store, runModel, resolveModel) !== undefined;
      const opts = {
        denyImages: textOnly,
        onImageNeeded: canSwitch ? (file: string) => { needsImage.file = file; } : undefined,
        prompt: `${evidencePrefix}${job.brief}${carried}${focus ? `\n\n${focus}` : ""}${permits}${dnsPermit}${createRepo}${signupPermit}${purchasePermit}${beatNote}${depth}${web.note}${standing}${resume}${carryOn}${docNote}`,
        systemPrompt: SEARCH_KINDS.includes(job.kind) ? `${spec.prompt}\n\n${EVIDENCE_RULE}` : spec.prompt,
        ...route,
        cwd: bridged && snapshot ? snapshot : spec.cwd,
        // Only a kind that builds gets the npm development-mode settings: the service runs
        // NODE_ENV=production, which would leave typescript and tsx out of a worker's own install.
        ...(BUILDS(job.kind) ? { env: workerBuildEnv(this.setup.npmCache()) } : {}),
        allowedTools: [...(createRepo ? [...spec.allowedTools, `mcp__${REPO_SERVER}__*`] : spec.allowedTools), ...(job.permits?.includes("signup") ? SIGNUP_TOOLS : []), ...(buying ? PURCHASE_TOOLS : []), ...(beats ? BEAT_TOOLS : []), ...web.allowed],
        disallowedTools: bridged ? [...(spec.disallowedTools ?? []), ...BRIDGE_READ_DENY] : job.commission ? [...(spec.disallowedTools ?? []), "Task"] : spec.disallowedTools,
        tools: spec.tools,
        agents: spec.agents,
        mcpServers: ownTools || extraTools || cvTools || beats || web.allowed.length ? { ...extraTools, ...ownTools, ...cvTools, ...web.servers, ...(buying ? { [PURCHASE_SERVER]: buying } : {}), ...(beats ? { [BEAT_SERVER]: beats } : {}) } : undefined,
        additionalDirectories: dirs,
        maxTurns: limits.maxTurns,
        // The SDK's own guard (a runaway trip, never the job's cap), or the job's own cap on Anthropic,
        // where the SDK's list-price cost is the bill.
        maxBudgetUsd: cap.sdkUsd,
        costMeter,
        abortController: live.abort,
        onActivity: () => this.touch(id, live),
        onTrace: (e: RawTraceEvent) => trace.event(e),
        onToolUse: (name: string, input: Record<string, unknown>) => {
          const step = describeWorkerTool(name, input);
          live.step = step;
          shown.note(step);
        },
        onSession: (sessionId: string) => {
          if (this.store.getJob(id)?.sessionId !== sessionId) this.store.updateJob(id, { sessionId });
        },
        telemetry: { role: roleForKind(job.kind), private: isPrivateKind(job.kind) },
        onCall: (call: ModelCall) => {
          usage.add(call);
          this.persistUsage(id, job, live, usage, this.realCostFor(costMeter));
        },
      };
      if (textOnly) opts.prompt += TEXT_ONLY_NOTE;
      // Interrupted by a restart: carry on the same conversation, so the worker keeps everything it had
      // read and decided instead of starting again. If that cannot work (the session is gone or broken),
      // fall back to a fresh run with the usual note to check the working folder.
      let result: RunResult | undefined;
      if (job.resumed && job.sessionId && !job.savedWork) {
        result = await this.run({ ...opts, prompt: continueNote(job.resumed + 1), resume: job.sessionId }).catch((err) => ({ text: "", error: failureFromError(err) }));
        const broken = runFailure(result);
        // A resumed run that ended on an image its model cannot take is not a broken session: it is left
        // for the image cure below, which switches to a model that can see (23 Nov 2026, job a0655b, which
        // was instead started fresh on the same model and opened the same picture again).
        if (broken && !live.stop && !HOLD_KINDS.includes(broken.kind) && !isImageInputFailure(broken)) {
          console.warn(`job ${id}: resuming its session failed (${broken.detail.slice(0, 200)}); starting a fresh run`);
          this.store.updateJob(id, { sessionId: undefined });
          result = undefined;
        }
      }
      if (result === undefined) {
        try {
          result = await this.run(opts);
        } catch (err) {
          // A run the service aborted because the provider's figures passed the job's cap reports
          // nothing back; that is a budget stop, not a crash, and it is classified below.
          if (live.stop) throw err;
          result = { text: "", error: failureFromError(err) };
        }
      }
      // The one failure the service cures by itself: a run whose model OpenRouter no longer offers
      // (withdrawn mid-flight). The recorded previous model is engaged at once, the move is recorded
      // like any change, and the run happens again on it, so the job does not die waiting for the
      // next daily check (src/model-ops.ts engageRunFallback, the same record the daily check
      // engages). A role change recorded the role's own previous tier (catalogue.roleFallbacks), and
      // for a run of that role it wins: the role is moved back, never the whole tier, and the retry is
      // started on what it ran on before. Once only: engaging spends the fallback, so a second
      // refusal fails the job honestly. A run pinned to a model by its id (never an alias) and every
      // run on Anthropic have no fallback and fail as before.
      if (!live.stop && !onAnthropic && isAliasName(route.model) && result?.error && isWithdrawnModelFailure(result.error) && !isImageInputFailure(result.error)) {
        const withdrew = engageRunFallback(route.model, undefined, result.error.detail, catalogueRole(job.kind), this.store);
        if (withdrew) {
          trace.note(`model ${withdrew.from} was refused by OpenRouter mid-run; retried on its recorded previous ${withdrew.role ? `tier for ${withdrew.role}` : "model"} ${withdrew.to}`);
          shown.note(`The model this job started on is gone from OpenRouter; retrying on ${withdrew.to}`);
          result = undefined;
          try {
            result = await this.run(withdrew.retryOn ? { ...opts, model: withdrew.retryOn } : opts);
          } catch (err) {
            if (live.stop) throw err;
            result = { text: "", error: failureFromError(err) };
          }
          if (!runFailure(result)) result.text = addToReport(result.text, `The model this job started on (${withdrew.from}) had been withdrawn from OpenRouter, so the run was retried once on its recorded previous model (${withdrew.to}).`);
        }
      }
      // The other failure the service cures by itself (23 Nov 2026, src/image-input.ts): the worker
      // needed to look at an image on a model that takes no images. Either the provider ended the run
      // when it opened one (the model is then remembered as text only), or the run was already known to
      // be on such a model and stopped itself at the Read. Where a larger tier runs on a model that can
      // see, the job switches to it and carries on at once, so only the runs that look pay for it. With
      // none, the run happens again with image files refused and the worker told. Fresh, never resumed:
      // the ended conversation holds the picture and would be refused again. Once only.
      const imageFailed = !live.stop && !opts.denyImages && !!result?.error && isImageInputFailure(result.error);
      if (imageFailed) {
        rememberTextOnly(this.store, runModel);
        trace.note(`model ${runModel} takes no images and the run ended on an image file`);
      }
      if (!live.stop && (imageFailed || needsImage.file)) {
        const to = onAnthropic ? undefined : visionAlias(this.store, runModel, resolveModel);
        const basePrompt = textOnly ? opts.prompt.slice(0, -TEXT_ONLY_NOTE.length) : opts.prompt;
        try {
          if (to) {
            const toModel = resolveModel(to);
            trace.note(`switched from ${runModel} to ${toModel} (${to}) to look at ${needsImage.file ?? "an image file"}`);
            shown.note(`Switching to ${toModel} to look at an image`);
            result = await this.run({ ...opts, model: to, resume: undefined, denyImages: false, onImageNeeded: undefined, prompt: `${basePrompt}${switchedNote(needsImage.file, runModel)}` });
            if (!runFailure(result)) result.text = addToReport(result.text, `This job started on ${runModel}, which cannot take images. It switched to ${toModel} when it needed to look at one, and finished there.`);
          } else if (imageFailed) {
            trace.note("no tier that can see images; retried with image files refused");
            shown.note("This model cannot take images; carrying on without opening image files");
            result = await this.run({ ...opts, resume: undefined, denyImages: true, onImageNeeded: undefined, prompt: `${basePrompt}${TEXT_ONLY_NOTE}` });
            if (!runFailure(result)) result.text = addToReport(result.text, `This job's model (${runModel}) cannot take images. Its first run ended when it opened an image file, so it was run again with image files refused: anything it says about how a page looks was not checked by eye.`);
          }
        } catch (err) {
          if (live.stop) throw err;
          result = { text: "", error: failureFromError(err) };
        }
      }
      if (!result) result = { text: "", error: failureFromError(new Error("the run ended with no result")) };
      // Out of turns before it wrote anything up (the SDK's error_max_turns). The reading is done and
      // paid for; only the report is missing. So it gets one short turn more, on the same conversation,
      // to write up what it has and say what it did not reach. Until 20 Nov 2026 such a run was recorded
      // as done with the one line "The agent stopped early (error_max_turns)." as its whole report.
      let ranOut = false;
      if (result.outOfTurns && !live.stop) {
        ranOut = true;
        result = await this.writeUp(opts, result, limits.maxTurns);
      }
      await progress.finish();
      // Stopped (stalled, too long, cancelled) while it ran: whatever came back is not the job's result.
      if (live.stop) throw new Error("stopped");
      live.finishing = true;
      // Stopped for money: the job's own cap, counted in the provider's money, or the SDK's runaway
      // guard. Recorded as failed with the honest figures, and nothing follows it.
      const broke = await this.budgetStop(result, costMeter, limits, cap);
      if (broke) {
        if (result.costUsd !== undefined) this.store.updateJob(id, { costUsd: result.costUsd });
        throw new RunFailedError(broke);
      }
      // An API or SDK error (no credit, a rejected key, overload after retries, no output) is not work:
      // it is recorded as failed, and nothing follows it (no review, no fix round, no "Finished").
      const failed = runFailure(result);
      if (failed) {
        this.store.updateJob(id, { ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), usage: this.usageFor(job, result.usage, usage, this.realCostFor(costMeter)) });
        throw new RunFailedError(failed);
      }
      // A job that clones and pushes gains one plain line at the end of its saved report saying which
      // GitHub credential reached its repository: the variable's name, never a token
      // (src/repo-tokens.ts). Paul's short message is untouched, and a repository on the App or
      // GH_TOKEN adds nothing (src/bootstrap.ts jobCredentialNote).
      if (BUILDS(job.kind)) result.text = addToReport(result.text, jobCredentialNote(job.target));
      // A write-up after running out of turns says so in the saved report, whatever the worker wrote.
      if (ranOut) result.text = addToReport(result.text, `This job reached its limit of ${limits.maxTurns} turns before it finished. This report is its write-up of what it had found by then.`);
      // The full report (verdict lines and all) is the saved output; Paul sees only the short message.
      // The report's per-acceptance lines ("ACCEPT A1: met", src/agents.ts) are review evidence the
      // maintainer reads: the runner never inspects the report for them, never marks a job failed
      // over one and never short-circuits the review flow (src/brief.ts).
      const { report, message } = splitReport(result.text);
      const outputPath = this.store.writeOutput(id, report);
      // What the worker itself says came of it (its GOAL line). Kept as a claim and shown as one:
      // nothing here acts on it, and no job is failed, retried or reviewed differently because of it.
      const claimed = parseOutcome(report);
      this.store.updateJob(id, {
        status: "done",
        finishedAt: new Date().toISOString(),
        summary: message,
        ...(claimed ? { claimed } : {}),
        outputPath,
        costUsd: result.costUsd,
        usage: this.usageFor(job, result.usage, usage, this.realCostFor(costMeter)),
      });
      try {
        const done = this.store.getJob(id);
        if (done) this.onOutput?.(done);
      } catch (err) {
        console.warn(`outputs copy not started for job ${id}: ${err instanceof Error ? err.message : err}`);
      }
      // An engineer's pull request is reviewed by the maintainer without anyone asking. The
      // maintainer is not an engineering kind, so it runs at once and never waits for the lock.
      let chained = "";
      let escalation: string | undefined;
      if (job.kind === "engineer" && (job.commission || job.reviewOnly)) {
        const pr = job.pr ?? findPrUrl(report);
        if (pr && !job.pr) this.store.updateJob(id, { pr });
        // A review-only job stops here in code, not only in the brief: the automatic review, its fix
        // rounds and the merge are all downstream of the maintainer this branch never starts.
        chained = pr
          ? job.reviewOnly
            ? `Opened ${pr} for review. This job is review only: you review and merge it yourself; nothing reviews or merges it automatically.`
            : `Opened ${pr} for review. Nothing reviews or merges it automatically.`
          : "";
      } else if (job.kind === "engineer") {
        // A fix round already knows its pull request; a fresh job's is read from its report.
        const pr = job.pr ?? findPrUrl(report);
        if (pr && !job.pr) this.store.updateJob(id, { pr });
        // A fix round pushes to a pull request that was open when it began. If that has been merged or
        // closed since, what it pushed reaches nothing, and a review of it would be paid for and lead
        // nowhere (21 Nov 2026: two rounds and their reviews ran on one Paul had merged). Say so instead.
        const gone = job.fixRound ? await this.gone(pr) : undefined;
        if (gone) {
          chained = `${pr} was ${gone} while this fix round was running, so nothing reviews it: what the round pushed is on the pull request's branch and not in the default branch. Ask for a new pull request from that branch if you want those fixes.`;
        } else {
          const which = pr ? `the pull request ${pr}, which the engineer just ${job.fixRound ? "updated to address your last review" : "opened for this task"}` : "the pull request just opened by the engineer for this task";
          const m = this.start(
            "maintain",
            `Review ${which}, and any other open pull requests:\n\n${job.brief}${carriedSection(this.carriedFor(this.store.getJob(id) ?? job, pr))}\n\nEngineer's report:\n${report}`,
            job.requestedBy,
            job.target,
            job.replyTo,
            { title: reviewTitle(job), reviewOf: id, pr },
          );
          chained = `Started ${jobLabel(m)} to review and merge.`;
        }
      }
      // So is the agent-creator's, on the workforce repo. Only an explicit schedule verdict (no code
      // written) skips the maintainer; a missing or garbled verdict still gets a review. A review-only
      // one skips it too, and for the same reason as an engineer's: the pull request stays for Paul.
      if (job.kind === "create_agent") {
        if (isScheduleVerdict(report)) {
          const rec = scheduleRecommendation(report);
          chained = `No code needed: it fits ${rec.kind ? `a ${rec.kind} job` : "an existing kind"}${rec.cron ? ` on the schedule ${rec.cron}` : ""}. Say "set it up" and I will schedule it.`;
        } else if (job.reviewOnly) {
          const pr = job.pr ?? findPrUrl(report);
          if (pr && !job.pr) this.store.updateJob(id, { pr });
          chained = pr ? `Opened ${pr} for review. This job is review only: you review and merge it yourself; nothing reviews or merges it automatically.` : "";
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
        const next = this.afterReview(job, report, await this.gone(job.pr ?? this.store.getJob(job.reviewOf)?.pr));
        chained = next.chained;
        escalation = next.escalation;
      }
      if (job.kind === "design" && job.designLoop) {
        const next = this.afterDesign(job, report);
        chained = next.chained;
        escalation = next.escalation;
      }
      // After running out of turns, what follows the worker's words starts by saying the report is partial.
      if (ranOut) chained = [`It reached its limit of ${limits.maxTurns} turns, so the report is what it had found by then.`, chained].filter(Boolean).join(" ");
      await this.messenger.send(
        job.replyTo ?? job.requestedBy,
        finishedText(job, message, chained),
      );
      if (job.kind === "design") await this.sendImages(job, report);
      if (escalation) await this.messenger.send(job.replyTo ?? job.requestedBy, escalation);
    } catch (err) {
      // Whatever the job had used before it stopped or failed is kept, marked as partial: a job that
      // was cancelled or crashed still spent what it spent, and the record should say so.
      if (!usage.empty) this.store.updateJob(id, { usage: this.usageFor(job, undefined, usage, this.realCostFor(costMeter)) });
      if (live.stop) await this.recordStop(job, live);
      else await this.recordFailure(job, failureFromError(err));
    } finally {
      await progress?.finish().catch(() => undefined);
      // The run is over, however it ended: its calls are priced once, in the background, so the job's
      // record says what the provider charged and on which model. Nothing waits on this.
      this.priceAfter(id, costMeter);
      // The job's browser, if it opened one, goes with it, and so does any wait for a one-time code: a
      // reply that arrives afterwards settles nothing.
      await web?.close().catch(() => undefined);
      this.otp?.dropJob(id);
      removeSnapshot(snapshot);
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
    if (key && this.holds(key, job.id)) {
      this.free(key, job.id);
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
   * Writes what a running job has used so far, at most once a minute (state.json is one file rewritten
   * whole, so this must not happen on every call). Marked partial: the job is still running.
   */
  private persistUsage(id: string, job: Job, live: LiveRun, usage: UsageRecorder, realCost: RealCost | undefined): void {
    const now = this.now();
    if (now - live.usagePersistedAt < MINUTE || !this.store.getJob(id)) return;
    live.usagePersistedAt = now;
    try {
      this.store.updateJob(id, { usage: this.usageFor(job, undefined, usage, realCost) });
    } catch (err) {
      console.warn(`usage not written for job ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * The provider's own figure for what this job's calls have cost, when its cap meter read one
   * (src/realcost.ts). Cheap: the meter only sums what it has already read, so this asks nobody for
   * anything. Where it read nothing (no cap was counting, or the provider has not published yet), there
   * is no figure and the usage record says so; the SDK's estimate is never offered in its place.
   */
  /**
   * Prices a finished job's calls in the background and writes the provider's own figure into its
   * record (src/realcost.ts). One job at a time, so a burst of finished jobs is not a burst of
   * requests. It never holds a job up, never feeds a cap, and never throws.
   */
  private priceAfter(id: string, meter: JobCostWatch | undefined): void {
    if (!meter) return;
    meter.stop();
    pricing = pricing
      .then(async () => {
        const real = await meter.settle();
        const job = this.store.getJob(id);
        if (job?.usage && real.source === "provider") this.store.updateJob(id, { usage: withRealCost(job.usage, real) });
      })
      .catch(() => undefined);
  }

  private realCostFor(meter: JobCostWatch | undefined): RealCost | undefined {
    if (!meter) return undefined;
    const cost = meter.cost();
    return cost.source === "provider" ? cost : undefined;
  }

  /**
   * A job's usage record: the run's own report of itself where there is one, otherwise what the
   * recorder kept (a run that was stopped, or a runner that reports no usage). Numbers only.
   */
  private usageFor(job: Job, run: RunUsage | undefined, usage: UsageRecorder, realCost: RealCost | undefined = undefined): JobUsage {
    if (run) return jobUsageFromRun(run, { realCost });
    const kept = usage.summary();
    return jobUsageFromRun(
      {
        role: roleForKind(job.kind),
        provider: provider(),
        calls: kept.calls,
        ...(kept.callsOmitted ? { callsOmitted: kept.callsOmitted } : {}),
        totals: kept.totals,
      },
      { partial: true, realCost },
    );
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

  /**
   * A job's trace for a line the service writes outside the run itself (a stop or a failure, from
   * `recordStop` or `recordFailure`). Whether the job carries a bound private source is read from
   * the current store record (`docSnapshot`), never from the closure copy the caller was handed,
   * so a line written after a restart, or outside the live run (an orphan's cancel, a resumed
   * job's failure), is shaped exactly like the run's own events (src/trace.ts).
   */
  private jobTrace(job: Job): JobTrace {
    return new JobTrace(job.id, job.kind, tracesDir(), (this.store.getJob(job.id) ?? job).docSnapshot === true);
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
    this.jobTrace(job).noteEnd(true, failureLabel(reason.kind), reason.detail);
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
      // Once a minute: the provider's own spend figure, so the cap and /spend stay current.
      await this.refreshSpend().catch(() => undefined);
      // A credit or key hold lifts itself once the provider really answers again (Paul's call, 15 Nov 2026).
      await this.tryAutoResume().catch((err) => console.warn(`auto-resume check failed: ${err instanceof Error ? err.message : err}`));
      const now = this.now();
      for (const [id, live] of [...this.live]) {
        if (live.stop || live.waiting || live.waitingForCopy || live.finishing) continue;
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
      for (const key of this.lockKeys()) {
        // A slot held by a job nothing is running frees itself.
        for (const held of this.holders.get(key) ?? []) if (!this.running.has(held)) this.free(key, held);
        await this.startNext(key);
        const holder = this.holders.get(key)?.[0];
        if (holder) for (const j of this.waiting(key)) if (j.waitingFor !== holder && !this.isHeld(j)) this.store.updateJob(j.id, { waitingFor: holder });
      }
    } finally {
      this.checking = false;
    }
  }

  /** Runs the watchdog every minute (by default) until the returned function is called. */
  startWatchdog(intervalMs = MINUTE): () => void {
    const timer = setInterval(() => {
      this.checkLiveness().catch((err) => console.warn(`liveness check failed: ${err instanceof Error ? err.message : err}`));
      // The plan driver's turn (src/plans.ts): it never throws.
      void this.plans.tick();
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
      if (live.waitingForCopy) return { ...info, alive: true, waitingForDeploy: false, summary: `${label} is alive, waiting for a working copy of its own in ${workerSpec(job.kind, job.target).cwd} before it starts (another job is in that checkout).` };
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
      if (key && this.holds(key, id)) await this.release(job);
      return `Cancelled ${label} before it started; it has left the queue.`;
    }
    if (this.live.has(id)) await this.stop(id, reason);
    else {
      // Marked running, but no worker here: nothing to stop, so record it and free its place.
      const orphan: LiveRun = { abort: new AbortController(), startedAt: 0, lastActivity: 0, persistedAt: 0, usagePersistedAt: 0, waiting: false, waitingForCopy: false, finishing: false, stop: reason, settled: Promise.resolve(), settle: () => {} };
      await this.recordStop(job, orphan);
      if (key && this.holds(key, id)) await this.release(job);
      else if (key && !this.full(key)) await this.startNext(key, id);
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
   * A run stopped for money, with the figures that say which measure stopped it and what it really
   * spent. The job's own cap is counted in the provider's money (src/realcost.ts); the SDK's guard is
   * counted in its own estimate, and is named as an estimate rather than quoted as a bill. On
   * Anthropic there is no per-call price to read and the SDK's list-price cost is the bill, so the
   * run's own cost is the figure and the measure is named as Anthropic's own list price. When the
   * figure cannot be read, that is said, and the estimate is not offered in its place.
   */
  private async budgetStop(result: RunResult, meter: JobCostWatch, limits: RunLimits, cap: RunCap): Promise<RunFailure | undefined> {
    const past = meter.exceededBy();
    const guard = result.error?.kind === "budget";
    if (!past && !guard) return undefined;
    if (!past && cap.onAnthropic) {
      // The SDK's list price is what is billed here, so the run's own cost is the honest figure and
      // there is no per-call endpoint to ask. The cap it passed is the one the SDK was given.
      const spentUsd = result.costUsd;
      const detail = `${result.error?.detail ?? "The run passed its budget."} Anthropic's own list-price cost for the run: ${spentUsd !== undefined ? `$${usdAmount(spentUsd)}` : "not reported"}.`;
      const budget: BudgetStop = { ...(spentUsd !== undefined ? { spentUsd } : {}), capUsd: cap.sdkUsd, measure: "anthropic", ...(cap.isGuard ? { guard: true } : {}) };
      return { kind: "budget", detail, budget };
    }
    const cost = await meter.settle();
    const spentUsd = cost.source === "provider" ? cost.usd : undefined;
    const unreadable = cost.source === "provider" ? Math.max(0, cost.calls - cost.read) : 0;
    const figures = { ...(spentUsd !== undefined ? { spentUsd } : {}), ...(unreadable ? { unreadable } : {}) };
    const budget: BudgetStop = past
      ? { ...figures, capUsd: limits.realBudgetUsd ?? 0, measure: "provider" }
      : { ...figures, capUsd: limits.maxBudgetUsd, measure: "estimate", guard: true };
    const detail = `${result.error?.detail ?? "The run passed the cap on what it had really spent."} The provider's own figure for the run: ${spentUsd !== undefined ? `$${usdAmount(spentUsd)}` : "could not be read"}.`;
    return { kind: "budget", detail, budget };
  }

  /**
   * A job that did no work: marked failed with the reason (job_status, /jobs and its saved output say
   * why), its design loop paused, and Paul told. API failures are batched into one message per burst;
   * credit and key failures also hold the engineering queues until Paul says /resume.
   */
  private async recordFailure(job: Job, failure: RunFailure): Promise<void> {
    const finishedAt = new Date().toISOString();
    const reason = failureReason(failure);
    this.jobTrace(job).noteEnd(false, failureLabel(failure.kind), failure.detail);
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
  private afterReview(review: Job, text: string, gone?: "merged" | "closed"): { chained: string; escalation?: string } {
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
    const target = lockKey(reviewed) ?? reviewed.target ?? "product";
    // A review that did not ask for changes has settled its pull request: what that job was handed to
    // fix is dropped (the maintainer wrote a new CARRY line for anything still wrong), and what this
    // review carried is held for the next engineer job on the repository. A review that did ask for
    // changes holds nothing: the fix round reads the whole review, its CARRY lines included.
    const held = verdict.outcome === "changes_requested" ? 0 : this.settleCarried(target, verdict.pr, review, text);
    const heldNote = held ? `${held === 1 ? "One smaller finding from the review is" : `${held} smaller findings from the review are`} held for the next engineer job on this repository, to be fixed in its pull request.` : "";
    if (verdict.outcome === "merged") return reviewed.designLoop ? this.nextDesignRound(reviewed, verdict.pr) : { chained: heldNote };
    const url = verdict.pr;
    if (verdict.outcome === "needs_founder") {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: heldNote,
        escalation: `Action needed from you on ${url}: ${verdict.detail ? shortText(verdict.detail, 400) : `the maintainer says only you can unblock it (show job ${review.id} has why).`}\nOnce that is done, tell me and I will have it re-reviewed.`,
      };
    }
    // Changes requested. Nothing is started on a pull request that is no longer open: a fix pushed to
    // its branch would reach nothing. Paul is told what the review found and where it now is.
    if (gone) {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: "",
        escalation:
          gone === "merged"
            ? `The maintainer asked for changes on ${url}, but it has been merged, so no fix round was started: a fix pushed to its branch would reach nothing. What the review found is in the default branch now (show job ${review.id}). Ask for a new change if you want it fixed.`
            : `The maintainer asked for changes on ${url}, but it has been closed, so no fix round was started. The review is saved (show job ${review.id}).`,
      };
    }
    const round = (reviewed.kind === "engineer" ? reviewed.fixRound ?? 0 : 0) + 1;
    // Dead ends: the earlier reviews of this same pull request. If this review raises what the last one
    // raised, the fix round between them changed nothing the reviewer could see, and another round on
    // the same instructions is a retry, not a repair: stop and put it to Paul with what is stuck.
    const earlier = this.earlierReviews(review, url);
    const last = earlier[earlier.length - 1];
    if (round > 1 && round <= MAX_FIX_ROUNDS && last && sameBlockers(last.text, text)) {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: "",
        escalation: `${url} is stuck: the last two reviews raised the same blocking issues, so fix round ${round - 1} did not move it and I have stopped rather than try the same thing again. Both reviews are saved (show job ${last.id} and show job ${review.id}). Give me a steer on the approach, reply "one more fix round on ${url}" to try again anyway, or close the pull request.`,
      };
    }
    // How many rounds start on their own is Paul's setting, and none by default (config.autoFixRounds):
    // past it the verdict goes to him, and one round is his to ask for. A design loop keeps its own count.
    const auto = Math.min(config.autoFixRounds, MAX_FIX_ROUNDS);
    // A plan's pull requests are the exception (Paul, 22 Nov 2026): a plan is not to stall on a
    // blocking review, so its steps get PLAN_FIX_ROUNDS on their own when the setting gives fewer
    // (src/plans.ts). Still never past MAX_FIX_ROUNDS.
    const allowed = reviewed.plan ? Math.max(auto, Math.min(PLAN_FIX_ROUNDS, MAX_FIX_ROUNDS)) : auto;
    if (!reviewed.designLoop && round > allowed && allowed < MAX_FIX_ROUNDS) {
      return {
        chained: "",
        escalation: `The maintainer asked for changes on ${url}${verdict.detail ? `: ${shortText(verdict.detail, 300)}` : "."}${verdict.detail && !/[.!?]$/.test(shortText(verdict.detail, 300)) ? "." : ""} No fix round was started, because ${allowed === 0 ? "automatic fix rounds are off" : `${allowed === 1 ? "the one automatic fix round has" : `the ${allowed} automatic fix rounds have`} been used`}. Reply "one more fix round on ${url}" to have an engineer fix it once, or merge or close it as it is. The whole review: show job ${review.id}.`,
      };
    }
    if (round > MAX_FIX_ROUNDS) {
      this.pauseLoop(reviewed.designLoop);
      return {
        chained: "",
        escalation: `${url} is still not mergeable after ${MAX_FIX_ROUNDS} automatic fix rounds, so I have stopped. The blocking issues are in the last review (show job ${review.id}). Reply "one more fix round on ${url}" to try again, give me a steer on where it is stuck, or close the pull request.`,
      };
    }
    const fix = this.startFix(reviewed, review, text, url, round, earlier);
    return { chained: `Changes requested on ${url}. Started ${jobLabel(fix)} to fix them (round ${round} of ${MAX_FIX_ROUNDS}${this.queuedText(fix)}); it is re-reviewed automatically.` };
  }

  /**
   * Hands an engineer job the held findings for its repository (src/carry.ts), oldest first and a few
   * at most, and records on each that this job has it. A fix round, a review-only job (no maintainer
   * review would ever settle them) and a resumed run of a job that already has its own are left as
   * they are. Returns what the job carries.
   */
  private takeCarried(job: Job): Array<{ pr: string; text: string }> | undefined {
    if (job.carried) return job.carried;
    if (job.kind !== "engineer" || job.fixRound || job.reviewOnly) return undefined;
    const target = lockKey(job) ?? job.target ?? "product";
    const all = this.store.settings().carried ?? [];
    const mine = all.filter((c) => c.target === target && carriedFree(c, (id) => this.store.getJob(id))).slice(0, CARRY_PER_JOB);
    if (!mine.length) return undefined;
    const ids = new Set(mine.map((c) => c.id));
    this.store.setSetting("carried", all.map((c) => (ids.has(c.id) ? { ...c, takenBy: job.id } : c)));
    const carried = mine.map((c) => ({ pr: c.pr, text: c.text }));
    this.store.updateJob(job.id, { carried });
    return carried;
  }

  /** What the engineer job behind a pull request was handed to fix: its own, or for a fix round, the job that opened the pull request. */
  private carriedFor(job: Job, pr: string | undefined): Array<{ pr: string; text: string }> | undefined {
    if (job.carried?.length) return job.carried;
    if (!pr) return undefined;
    return this.store.allJobs().find((j) => j.kind === "engineer" && !!j.carried?.length && !!j.pr && samePr(j.pr, pr))?.carried;
  }

  /**
   * Settles the held findings when a pull request's review did not ask for changes: drops the ones
   * the job behind that pull request was handed, and holds this review's own CARRY lines for the
   * repository. Returns how many it now holds from this review.
   */
  private settleCarried(target: JobTarget, pr: string, review: Job, text: string): number {
    const before = this.store.settings().carried ?? [];
    const kept = before.filter((c) => {
      const taker = c.takenBy ? this.store.getJob(c.takenBy) : undefined;
      return !(c.target === target && taker?.pr && samePr(taker.pr, pr));
    });
    const now = new Date().toISOString();
    const fresh: CarriedFinding[] = parseCarryLines(text)
      .filter((c) => samePr(c.pr, pr))
      .map((c) => ({ id: randomBytes(4).toString("hex").slice(0, 6), target, pr: c.pr, text: c.text, at: now, review: review.id }));
    if (!fresh.length && kept.length === before.length) return 0;
    const others = kept.filter((c) => c.target !== target);
    const here = [...kept.filter((c) => c.target === target), ...fresh].slice(-CARRY_MAX_PER_REPO);
    const next = [...others, ...here];
    this.store.setSetting("carried", next.length ? next : undefined);
    return fresh.length;
  }

  /** Starts one fix round on a reviewed pull request: an engineer job on the same branch, carrying the pull request and its round. */
  private startFix(reviewed: Job, review: Job, text: string, url: string, round: number, earlier: Array<{ id: string; text: string }>, asked?: { by: string; replyTo: string }): Job {
    const target = lockKey(reviewed) ?? reviewed.target ?? "product";
    const which = asked ? `fix round ${round}, asked for by the founder` : `automatic fix round ${round} of ${MAX_FIX_ROUNDS}`;
    return this.start(
      "engineer",
      `Address the maintainer's review on the existing pull request ${url} (${which}). Check out that pull request's branch, bring it up to date with the default branch, fix every blocking issue in the review, and its CARRY lines too so that nothing is left over for a later job, run the tests and typecheck, push to the same branch and reply to each review comment with gh. Read the review itself with gh pr view ${url} --comments. Do not open a new pull request. If a blocker can only be resolved by the founder (a secret, a GitHub or hosting setting, account access, a product decision), do everything else and say so plainly in your report.\n\nOriginal task:\n${originalTask(reviewed.brief)}\n\nMaintainer's review (job ${review.id}):\n${text}${deadEnds(earlier)}`,
      asked?.by ?? reviewed.requestedBy,
      target,
      asked?.replyTo ?? reviewed.replyTo,
      { title: fixTitle(jobTitle(reviewed), round), pr: url, fixRound: round, designLoop: reviewed.designLoop, designRound: reviewed.designRound, ...(reviewed.plan ? { plan: reviewed.plan } : {}) },
    );
  }

  /**
   * The one fix round Paul asks for with his own message "one more fix round on <address>" (the
   * orchestrator hands it here before any model). It is the same job an automatic round would be, so it
   * carries the pull request and its round, and both guards hold for it: GitHub is asked first, and
   * nothing is started on a pull request that is merged or closed; and when it finishes it is reviewed
   * only if the pull request is still open. Returns what to tell him.
   */
  async requestFixRound(url: string, by: string, replyTo: string): Promise<string> {
    const reviews = this.store
      .allJobs()
      .filter((j) => j.kind === "maintain" && j.status === "done" && !!j.reviewOf && (j.pr === url || this.store.getJob(j.reviewOf)?.pr === url))
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    const review = reviews[reviews.length - 1];
    const reviewed = review?.reviewOf ? this.store.getJob(review.reviewOf) : undefined;
    if (!review || !reviewed) return `I have no review by the maintainer of ${url}, so there is nothing for a fix round to fix. Ask me for the change in your own words if you want an engineer on it.`;
    const text = this.store.readOutput(review.id) ?? "";
    const verdict = parseReviewVerdicts(text).filter((v) => samePr(v.pr, url)).at(-1);
    if (verdict?.outcome !== "changes_requested") return `The last review of ${url} did not ask for changes, so there is nothing for a fix round to fix (show job ${review.id}).`;
    const running = this.store.allJobs().find((j) => j.kind === "engineer" && (j.status === "running" || j.status === "queued") && !!j.fixRound && j.pr === url);
    if (running) return `A fix round on ${url} is already ${running.status === "running" ? "running" : "queued"}: ${jobLabel(running)}. Nothing more was started.`;
    const gone = await this.gone(url);
    if (gone) return `${url} has been ${gone}, so no fix round was started: a fix pushed to its branch would reach nothing. ${gone === "merged" ? `What the review found is in the default branch now (show job ${review.id}). Ask for a new change if you want it fixed.` : `The review is saved (show job ${review.id}).`}`;
    const round = (reviewed.kind === "engineer" ? reviewed.fixRound ?? 0 : 0) + 1;
    const fix = this.startFix(reviewed, review, text, url, round, this.earlierReviews(review, url), { by, replyTo });
    return `Started ${jobLabel(fix)} to fix what the maintainer asked for on ${url}${this.queuedText(fix)}. It is reviewed once when it finishes, and nothing more follows unless you ask.`;
  }

  /** The finished maintainer reviews of this pull request before this one, oldest first, with their saved reports. */
  private earlierReviews(review: Job, url: string): Array<{ id: string; text: string }> {
    return this.store
      .allJobs()
      .filter((j) => j.kind === "maintain" && j.id !== review.id && j.status === "done" && j.pr && samePr(j.pr, url) && (j.finishedAt ?? "") <= (review.finishedAt ?? new Date().toISOString()))
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
      .map((j) => ({ id: j.id, text: this.store.readOutput(j.id) ?? "" }))
      .filter((r) => r.text.trim());
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
  const body = [message, next, reportPointer(job.id)].map((s) => s.trim()).filter(Boolean).join(" ");
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

/** What an interrupted job is told when it carries on its own conversation after a restart. Exported for tests. */
/** How many turns a job that ran out is given to write up what it has. It is told to use no tools; the spare turns are for a model that tries one anyway. */
export const WRITE_UP_TURNS = 3;

/** What a job that has used all its turns is told: write up what you have, now, and say what is missing. Exported for tests. */
export function writeUpNote(turns: number): string {
  return `You have used all ${turns} of the turns this job allows, so you cannot read, search or run anything more. Do not call any tool. Write your final report now, from what you have already found: lead with what you established, then say plainly what you did not get to. A partial report that is honest about its gaps is what is wanted here, so do not guess to fill them. End with your message to Paul as usual, and say in it that you ran out of turns and what is missing.`;
}

export function continueNote(attempt: number): string {
  return `The service restarted while you were working, which stopped you mid-task (this is attempt ${attempt}). Everything above is your own earlier work on this job. Your working folder is as you left it, but any command or tool call that was running when the restart happened did not finish. Check git status and the state of anything you were in the middle of, then carry on from where you were and finish the job, ending with your report as instructed. Do not start again from scratch.`;
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
  const main = workerSpec(job.kind, job.target).cwd;
  if (!main) return undefined;
  const dir = lockKey(job) && job.lane ? laneDir(main, job.lane) : main;
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

/* ---------- Working copies for engineering jobs that run side by side ---------- */

/** The working copy for lane n of a repository: a git worktree beside its checkout. */
export function laneDir(checkout: string, lane: number): string {
  return `${checkout.replace(/\/+$/, "")}.lane${lane}`;
}

/** True when there is a clone here: a directory with `.git` in it (a file, in a worktree, not a directory). */
export function hasGitDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * One working copy's set-up at a time per checkout. `git worktree add`, `git fetch` and `git worktree
 * prune` all write git state inside the same repository, and jobs starting together used to run them at
 * once, which git refuses when it cannot take a lock. Chained per checkout, so they run in turn; the
 * chain never rejects (each caller sees its own error) and the entry goes once the queue drains.
 */
const laneSetups = new Map<string, Promise<unknown>>();

export function serialiseLaneSetup<T>(checkout: string, work: () => Promise<T>): Promise<T> {
  const previous = laneSetups.get(checkout) ?? Promise.resolve();
  const mine = previous.then(work, work);
  const tail = mine.then(() => undefined, () => undefined);
  laneSetups.set(checkout, tail);
  void tail.then(() => {
    if (laneSetups.get(checkout) === tail) laneSetups.delete(checkout);
  });
  return mine;
}

/**
 * Makes sure lane n's working copy exists and, when it is clean, sits on the latest default branch, so a
 * second engineer starts from what is deployed, exactly as the checkout does (src/bootstrap.ts). Work an
 * earlier job left there (a resumed job) is kept. Set-up is serialised per checkout, and tried twice a
 * second apart, before it gives up and hands back the checkout itself: the caller (JobRunner) then makes
 * that job wait rather than let it write into a copy another job is using.
 */
export async function ensureLane(checkout: string, lane: number): Promise<string> {
  const dir = laneDir(checkout, lane);
  const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, ...args], { timeout: 120_000 }).then((r) => r.stdout.trim());
  const make = async (): Promise<string> => {
    await git(checkout, "fetch", "--quiet", "origin").catch(() => undefined);
    const head = await git(checkout, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").catch(() => "origin/main");
    const target = head.startsWith("origin/") ? head : "origin/main";
    if (!hasGitDir(dir)) {
      await git(checkout, "worktree", "prune").catch(() => undefined);
      await git(checkout, "worktree", "add", "--detach", dir, target);
      return dir;
    }
    const dirty = await git(dir, "status", "--porcelain");
    if (!dirty) await git(dir, "checkout", "--quiet", "--detach", target).catch(() => undefined);
    return dir;
  };
  return serialiseLaneSetup(checkout, async () => {
    try {
      return await make();
    } catch (first) {
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        return await make();
      } catch (err) {
        const why = err instanceof Error ? err.message : err;
        console.warn(`lane ${lane} for ${checkout}: ${why}; using the checkout itself`);
        return checkout;
      }
    }
  });
}

/** What an engineer in a second working copy is told. */
export function laneNote(checkout: string, lane: string): string {
  if (lane === checkout) return "";
  return `Working copy: another engineering job may be running on this repository at the same time, in ${checkout}. You have your own copy of the repository at ${lane}: it is your current directory, so do all your work, branches and commits here and never touch ${checkout}. It starts detached on the latest default branch: create your own branch from it as usual. If git refuses a branch because it is checked out in the other copy, use git checkout --ignore-other-worktrees <branch>.`;
}
