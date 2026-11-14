/**
 * What one job really cost, from the provider's own per-call figures.
 *
 * The Agent SDK's `total_cost_usd` is priced from the deliberately rounded-up table in src/llm.ts, and
 * on OpenRouter it bears no relation to the bill: jobs were recorded at about $10 each while the whole
 * key was charged a couple of dollars for the day. That estimate is now internal only (src/spend.ts)
 * and drives exactly one thing: the SDK's own per-run guard, set high enough that it can only catch a
 * run that has gone badly wrong.
 *
 * A job's own cap is counted here instead, in the money the provider actually charged. OpenRouter
 * reports the cost of each request at `GET /api/v1/generation?id=<generation id>`, which takes the same
 * inference key the models already use, so there is no new secret and no new dependency. The id is the
 * `request_id` on the reply the SDK hands us (`gen-...`; `message.id` is the Anthropic-shaped
 * `msg_...` and is not a generation id): it is recorded for every model call in the run and priced once
 * each, and the job's spend so far is the sum of the figures that have been read.
 *
 * Three rules, all deliberate. A figure is only ever the provider's, so a call it will not price (or
 * an endpoint that cannot be reached) leaves that call uncounted, makes the total a lower bound and is
 * said plainly in the reading, rather than falling back to the estimate. A call the provider has not
 * published yet (404: its record appears a little after the call finishes) is not given up on: it stays
 * pending, is read again every `GENERATION_PENDING_SWEEP_MS` while a cap is counting, and is given
 * several passes over tens of seconds at the end of a run before the figure is called unreadable, so a
 * cap Paul sets actually fires. And because the sum can only under-count, a cap counted this way can
 * never stop a job that has really spent pennies: a job is stopped for money when the provider's own
 * figures have passed the cap, or when the SDK's guard fires, and then the message names the measure
 * that actually stopped it.
 *
 * Reading every call is one request per call, so nothing is read unless a cap needs a running total;
 * when a run ends for money its calls are priced once, there and then.
 */
import { config } from "./config.js";
import { OPENROUTER_BASE_URL } from "./llm.js";

/** How long one generation call may take before it is abandoned. */
export const GENERATION_TIMEOUT_MS = 5_000;
/** The shortest gap between two reads, so a burst of calls cannot trip the endpoint's rate limit. */
export const GENERATION_GAP_MS = 120;
/** How long one pass over a job's calls may take at the end of a run. */
export const GENERATION_SETTLE_MS = 20_000;
/** How long to wait between those passes, while the provider publishes the records it had not yet. */
export const GENERATION_SETTLE_PASS_MS = 15_000;
/** How many passes the end of a run makes over calls the provider had not priced yet. */
export const GENERATION_SETTLE_PASSES = 3;
/** While a cap is counting, how often a call the provider had not priced yet is read again. */
export const GENERATION_PENDING_SWEEP_MS = 15_000;
/** How many times one call may be read before it is given up on, so a sweep cannot run for ever. */
export const GENERATION_MAX_ATTEMPTS = 4;
/** The most calls one run may have priced: a guard on the queue, far above any real run. */
export const MAX_GENERATION_READS = 2_000;

/** What a job's calls have cost, as far as the provider could be read. */
export interface RealCost {
  /** The provider's own charges for the calls it priced, summed, in USD. */
  usd: number;
  /** The model calls this run made, as the provider reported them. */
  calls: number;
  /** How many of those the provider priced. */
  read: number;
  /** "provider" when at least one call was priced, otherwise "unavailable". */
  source: "provider" | "unavailable";
  /** Why there is no figure, or why the figure is a lower bound, in one plain clause. */
  note?: string;
}

/** What the SDK loop tells the meter: the generation id of each model call it sees. */
export interface CostMeter {
  note(generationId: string | undefined): void;
}

/** What the job runner uses: the meter, the cap check and the settled total. */
export interface JobCostWatch extends CostMeter {
  /** The reading that passed the job's cap, when one did. */
  exceededBy(): RealCost | undefined;
  /** Waits (bounded) for the outstanding reads and returns what is known about this job's calls. */
  settle(): Promise<RealCost>;
  /** Stops the in-run sweeps: the job has ended, so nothing more is read for it. */
  stop(): void;
}

export interface RealCostOptions {
  /** The OpenRouter key. Defaults to the one the models run on; empty means there is no provider to ask. */
  apiKey?: string;
  /** The generation endpoint. Defaults to `<OPENROUTER_BASE_URL>/v1/generation`. */
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
  timeoutMs?: number;
  gapMs?: number;
  settleMs?: number;
  settlePassMs?: number;
  settlePasses?: number;
  pendingSweepMs?: number;
  maxAttempts?: number;
  /** The job's cap in the provider's money. Unset: nothing is read until the run ends for money. */
  capUsd?: number;
  /** Called once, when the sum of what has been read passes the cap. The runner stops the run. */
  onExceeded?: (cost: RealCost) => void;
}

/**
 * Sums what OpenRouter charged for one job's calls. Never throws and never waits longer than its
 * timeouts, so it can never hold up a job; it only ever reports figures the provider gave it.
 */
export class RealCostMeter implements JobCostWatch {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warn: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly gapMs: number;
  private readonly settleMs: number;
  private readonly settlePassMs: number;
  private readonly settlePasses: number;
  private readonly pendingSweepMs: number;
  private readonly maxAttempts: number;
  private readonly capUsd?: number;
  private readonly onExceeded?: (cost: RealCost) => void;
  private readonly seen = new Set<string>();
  private readonly ids: string[] = [];
  private readonly amounts = new Map<string, number>();
  /** Calls the provider has not published a figure for yet: read again, never given up on at once. */
  private readonly pending = new Set<string>();
  /** Calls there is no figure for and no point asking again about. */
  private readonly unpriced = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private live: boolean;
  /** Set when the endpoint will not price these ids at all, so the rest of the run does not ask again. */
  private hopeless?: string;
  private exceeded?: RealCost;
  private warned = false;
  /** Reads made, so a sweep over ids the provider never publishes cannot go on for ever. */
  private reads = 0;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: RealCostOptions = {}) {
    this.apiKey = options.apiKey ?? config.openrouter.apiKey;
    this.url = options.url ?? `${OPENROUTER_BASE_URL}/v1/generation`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.warn = options.warn ?? ((message: string) => console.warn(`realcost: ${message}`));
    this.timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
    this.gapMs = options.gapMs ?? GENERATION_GAP_MS;
    this.settleMs = options.settleMs ?? GENERATION_SETTLE_MS;
    this.settlePassMs = options.settlePassMs ?? GENERATION_SETTLE_PASS_MS;
    this.settlePasses = options.settlePasses ?? GENERATION_SETTLE_PASSES;
    this.pendingSweepMs = options.pendingSweepMs ?? GENERATION_PENDING_SWEEP_MS;
    this.maxAttempts = options.maxAttempts ?? GENERATION_MAX_ATTEMPTS;
    this.capUsd = options.capUsd;
    this.onExceeded = options.onExceeded;
    // A running total is only needed while a cap is being counted against it.
    this.live = this.enabled && options.capUsd !== undefined && options.capUsd > 0;
  }

  /** True when there is a provider to ask. In Anthropic mode the SDK's list-price cost is the bill. */
  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** One model call: the generation id the provider put on its reply. Read at once when a cap is counting. */
  note(generationId: string | undefined): void {
    const id = (generationId ?? "").trim();
    if (!id || this.seen.has(id)) return;
    this.seen.add(id);
    this.ids.push(id);
    if (this.live && !this.closed && !this.hopeless && this.reads < MAX_GENERATION_READS) this.enqueue(id);
  }

  exceededBy(): RealCost | undefined {
    return this.exceeded;
  }

  /** Stops the in-run sweeps. Called when the job's run is over, however it ended. */
  stop(): void {
    this.closed = true;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** The figures read so far. Cheap: no call is made here. */
  cost(): RealCost {
    const calls = this.ids.length;
    let usd = 0;
    for (const amount of this.amounts.values()) usd += amount;
    const read = this.amounts.size;
    if (!this.enabled) {
      return { usd: 0, calls, read: 0, source: "unavailable", note: "the provider bills one figure for the whole key and reports none per call here" };
    }
    if (read === 0) {
      return {
        usd: 0,
        calls,
        read: 0,
        source: "unavailable",
        note: this.hopeless ?? (calls ? `OpenRouter has not priced this job's ${calls === 1 ? "call" : `${calls} calls`} yet` : "this run made no model calls"),
      };
    }
    // Rounded to the cent up, like every other figure the provider gives us, and a fraction of a cent
    // is never lost in the workforce's favour.
    const rounded = Math.ceil(usd * 100) / 100;
    return {
      usd: rounded,
      calls,
      read,
      source: "provider",
      ...(read < calls ? { note: `OpenRouter priced ${read} of this job's ${calls} calls, so the figure is a lower bound` } : {}),
    };
  }

  /**
   * Prices every call this run has not been charged for yet, waits (bounded) for the answers, and
   * reads again, in bounded passes over tens of seconds, whatever the provider had not published yet
   * (its record for a call appears a little after the call finishes). Never throws.
   */
  async settle(): Promise<RealCost> {
    this.stop();
    if (!this.enabled || this.hopeless) return this.cost();
    for (const id of this.ids) if (!this.amounts.has(id) && !this.unpriced.has(id)) this.enqueue(id);
    await this.awaitChain(this.settleMs);
    for (let pass = 0; pass < this.settlePasses && !this.hopeless; pass++) {
      const waiting = [...this.pending];
      if (!waiting.length) break;
      await this.sleep(this.settlePassMs);
      for (const id of waiting) {
        this.pending.delete(id);
        this.enqueue(id);
      }
      await this.awaitChain(this.settleMs);
    }
    return this.cost();
  }

  /** Waits for everything queued, but never longer than `ms`. */
  private async awaitChain(ms: number): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.chain;
      await Promise.race([chain.catch(() => undefined), this.sleep(ms)]);
    } while (chain !== this.chain);
  }

  /** Queues one read. One at a time, so the endpoint is never hammered by a busy run. */
  private enqueue(id: string): void {
    this.chain = this.chain.then(() => this.read(id)).catch(() => undefined);
  }

  /** One generation read. Records the figure, or why there is not one, and never throws. */
  private async read(id: string): Promise<void> {
    if (this.amounts.has(id) || this.unpriced.has(id) || this.hopeless) return;
    if (this.reads >= MAX_GENERATION_READS) {
      this.unpriced.add(id);
      return;
    }
    if (this.gapMs > 0) await this.sleep(this.gapMs);
    if (this.amounts.has(id) || this.unpriced.has(id) || this.hopeless) return;
    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    this.reads++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}?id=${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 400: not a generation id at all, so nothing this run sends will ever be priced. 429: the
        // endpoint is rate limiting the reads. Both are said once and the asking stops. 404: the
        // record is simply not published yet, which is normal right after a call, so the id stays
        // pending and is read again rather than being counted as unpriceable.
        if (res.status === 400 || res.status === 429) {
          this.unpriced.add(id);
          this.giveUp(res.status);
          return;
        }
        // A 404 is the ordinary case right after a call, so it is not worth a warning; anything else is.
        this.notYet(id, attempt, res.status === 404 ? undefined : `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { data?: { total_cost?: unknown } };
      const amount = Number(body?.data?.total_cost);
      if (!Number.isFinite(amount) || amount < 0) {
        this.unpriced.add(id);
        return;
      }
      this.pending.delete(id);
      this.amounts.set(id, amount);
      this.checkCap();
    } catch (err) {
      this.notYet(id, attempt, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The provider has not priced this call yet: keep it pending and read it again later, until it has
   * been tried enough times to say plainly that there is no figure for it.
   */
  private notYet(id: string, attempt: number, why?: string): void {
    if (attempt >= this.maxAttempts) {
      this.unpriced.add(id);
      return;
    }
    this.pending.add(id);
    if (why) this.warnOnce(`a generation could not be priced yet (${why}).`);
    this.scheduleSweep();
  }

  /**
   * While a cap is counting, reads again the calls the provider had not published, so the running
   * total keeps up and the cap can actually fire on a job that has really spent the money.
   */
  private scheduleSweep(): void {
    if (!this.live || this.closed || this.sweepTimer || this.hopeless || !this.pending.size) return;
    const timer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
    }, this.pendingSweepMs);
    // A price read must never hold the process open.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.sweepTimer = timer;
  }

  /** One sweep: read again everything the provider had not published, then wait for the next one. */
  private sweep(): void {
    if (this.closed || this.hopeless) return;
    for (const id of [...this.pending]) {
      this.pending.delete(id);
      if (this.reads < MAX_GENERATION_READS) this.enqueue(id);
      else this.unpriced.add(id);
    }
    this.scheduleSweep();
  }

  /** The endpoint will not price this run's calls: stop asking, and say why. */
  private giveUp(status: number): void {
    if (this.hopeless) return;
    this.hopeless =
      status === 429
        ? "OpenRouter rate-limited the per-call price reads, so this job's real figure could not be read"
        : "OpenRouter did not recognise this run's call ids, so it could not price them";
    this.warnOnce(`${this.hopeless} (HTTP ${status}).`);
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(`${message} The job's cap falls back to the provider's figures only, and a budget message says no figure rather than quoting the estimate.`);
  }

  /** Past the cap: never by the estimate, only by the provider's own figures. */
  private checkCap(): void {
    if (this.capUsd === undefined || this.exceeded) return;
    const cost = this.cost();
    if (cost.source !== "provider" || cost.usd <= this.capUsd) return;
    this.exceeded = cost;
    this.onExceeded?.(cost);
  }
}

/** A money amount as it is written in a message: two decimals, or four for a fraction of a cent. */
export function usdAmount(usd: number): string {
  return usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
}
