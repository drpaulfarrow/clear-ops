/**
 * What the workforce actually spends, from the provider's own numbers.
 *
 * Every run's cost has always been the Agent SDK's `total_cost_usd`, priced from the table in
 * src/llm.ts. On OpenRouter that table is a deliberately rounded-up guess, so it bears no relation
 * to what OpenRouter bills and the daily cap used to trip on fiction. This module reads OpenRouter's
 * own figure instead: `GET /api/v1/key`, whose `usage` field OpenRouter documents as the total
 * credit usage in USD for the API key. That endpoint takes an ordinary inference key, which the
 * workforce already has (OpenRouter's `/api/v1/credits`, by contrast, needs a management key, so it
 * is not used and no new secret is needed). It also reports `usage_daily`, but for the current UTC
 * day, and the rest of the workforce counts the London day, so a London-day figure here is the
 * difference between the cumulative reading and the usage recorded when the day began, kept in the
 * store so a restart does not lose it.
 *
 * The SDK estimate is kept and used only as a fallback, and every message says which figure it is.
 * An Anthropic-only deployment is unchanged: there is no usage endpoint to read, the SDK's
 * list-price cost is the figure, and it is labelled as coming from the price table.
 *
 * The provider is asked at most once a minute (`refresh()` is cached), a reading older than
 * `SPEND_MAX_AGE_MS` is treated as stale and the estimate is used instead, and a failure, a rate
 * limit or a non-numeric reply all fall back rather than silently counting as zero.
 */
import { config } from "./config.js";
import { OPENROUTER_BASE_URL } from "./llm.js";
import { londonYmd } from "./london.js";

/** At most one call to the provider a minute, however often the cap is checked. */
export const SPEND_REFRESH_MS = 60_000;
/** A reading older than this is stale: the estimate is used instead, and said so. */
export const SPEND_MAX_AGE_MS = 5 * 60_000;
/** How long one usage call may take before it is abandoned. */
export const SPEND_TIMEOUT_MS = 5_000;

/** Where a spend figure came from: the provider's own account, or our price table. */
export type SpendSource = "provider" | "estimate";

/** One reading of the provider's cumulative usage. */
export interface SpendReading {
  /** Cumulative USD charged to the key, as the provider reports it. */
  usd: number;
  /** When it was read, ms since the epoch. */
  at: number;
}

/** Spend for one London day, with its source, so an estimate is never passed off as the bill. */
export interface RealSpend {
  usd: number;
  source: SpendSource;
  /** When the provider figure was read, when there is one. */
  asOf?: number;
  /** Why this is only an estimate, when it is. */
  note?: string;
}

/** The provider's cumulative usage when a London day began, so today's spend is a difference. */
export interface SpendBaseline {
  ymd: string;
  usd: number;
  at: string;
}

export interface SpendOptions {
  /** The OpenRouter key. Defaults to the one the models run on; empty means Anthropic mode. */
  apiKey?: string;
  /** The usage endpoint. Defaults to `<OPENROUTER_BASE_URL>/v1/key`. */
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  refreshMs?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
  /** Reads the day's baseline back (from the store); absent means in-memory only. */
  load?: () => SpendBaseline | undefined;
  save?: (baseline: SpendBaseline) => void;
  warn?: (message: string) => void;
}

/**
 * Reads the provider's own spend figure and turns it into a London-day figure.
 * Never throws: anything it cannot read becomes the estimate, with the reason kept.
 */
export class SpendMeter {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;
  private readonly load?: () => SpendBaseline | undefined;
  private readonly save?: (baseline: SpendBaseline) => void;
  private readonly warn: (message: string) => void;
  private reading?: SpendReading;
  private failure?: string;
  private attemptedAt?: number;
  private inflight?: Promise<void>;
  private baseline?: SpendBaseline;

  constructor(options: SpendOptions = {}) {
    this.apiKey = options.apiKey ?? config.openrouter.apiKey;
    this.url = options.url ?? `${OPENROUTER_BASE_URL}/v1/key`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? SPEND_REFRESH_MS;
    this.maxAgeMs = options.maxAgeMs ?? SPEND_MAX_AGE_MS;
    this.timeoutMs = options.timeoutMs ?? SPEND_TIMEOUT_MS;
    this.load = options.load;
    this.save = options.save;
    this.warn = options.warn ?? ((message: string) => console.warn(`spend: ${message}`));
  }

  /** True when there is a provider to ask. Anthropic mode keeps the SDK's list-price cost. */
  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** The last reading of the provider's cumulative usage, if any. */
  usage(): SpendReading | undefined {
    return this.reading;
  }

  /** Why the last usage check failed, in plain words, or undefined when it worked. */
  lastFailure(): string | undefined {
    return this.failure;
  }

  /**
   * Reads the provider's usage, at most once per interval (and at most one call in flight).
   * Never throws and never waits longer than the timeout, so a check can never hold up a job.
   */
  async refresh(force = false): Promise<void> {
    if (!this.enabled) return;
    const now = this.now();
    if (!force && this.attemptedAt !== undefined && now - this.attemptedAt < this.refreshMs) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.read().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Spend so far on a London day: the provider's own figure where it has been read recently, else
   * `estimateUsd`. Never treats an unread or stale provider figure as zero.
   */
  today(estimateUsd: number, ymd = londonYmd(new Date(this.now()))): RealSpend {
    if (!this.enabled) {
      return { usd: estimateUsd, source: "estimate", note: "the Agent SDK's list price, with no usage endpoint to read" };
    }
    const reading = this.reading;
    const fresh = reading !== undefined && this.now() - reading.at <= this.maxAgeMs;
    if (fresh && reading && this.baseline && this.baseline.ymd === ymd) {
      // Difference of two cumulative readings: rounded UP to the cent, so a fraction of a cent is
      // never lost in the workforce's favour.
      return { usd: Math.max(0, Math.ceil((reading.usd - this.baseline.usd) * 100) / 100), source: "provider", asOf: reading.at };
    }
    return { usd: estimateUsd, source: "estimate", note: this.becauseStale(reading) };
  }

  /** Why the provider figure is not being used, in one plain clause. */
  private becauseStale(reading: SpendReading | undefined): string {
    if (this.failure) return this.failure;
    if (reading && this.baseline && this.baseline.ymd !== londonYmd(new Date(reading.at))) return "the day's starting figure has not been read yet";
    if (reading) return "the last reading from OpenRouter is too old to trust";
    return "OpenRouter has not been read yet";
  }

  /** One usage call. Updates the reading, or the failure, and never throws. */
  private async read(): Promise<void> {
    this.attemptedAt = this.now();
    const controller = new AbortController();
    // Node's fetch needs a reason to stop; the timer is cleared as soon as the call settles.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        this.failure = res.status === 401 || res.status === 403 ? "OpenRouter rejected the key on the usage check" : res.status === 429 ? "OpenRouter rate-limited the usage check" : `OpenRouter returned ${res.status} on the usage check`;
        this.warn(`${this.failure}; the cap falls back to the estimate.`);
        return;
      }
      const body = (await res.json()) as { data?: { usage?: unknown } };
      const usd = Number(body?.data?.usage);
      if (!Number.isFinite(usd) || usd < 0) {
        this.failure = "OpenRouter's usage reply was not a number";
        this.warn(`${this.failure}; the cap falls back to the estimate.`);
        return;
      }
      this.failure = undefined;
      const previous = this.reading;
      const reading: SpendReading = { usd, at: this.now() };
      this.reading = reading;
      this.rollBaseline(previous, reading);
    } catch (err) {
      this.failure = `OpenRouter could not be read (${err instanceof Error ? err.message : String(err)})`;
      this.warn(`${this.failure}; the cap falls back to the estimate.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Keeps the day's starting figure in step with the calendar. A new London day starts from the last
   * reading of the day before (the closest thing to midnight we have), or from this reading when the
   * day's first is also the first ever. A figure that went backwards (a new key, a reset) starts again.
   */
  private rollBaseline(previous: SpendReading | undefined, reading: SpendReading): void {
    if (!this.baseline) this.baseline = this.load?.();
    const ymd = londonYmd(new Date(reading.at));
    const backwards = this.baseline !== undefined && this.baseline.ymd === ymd && reading.usd < this.baseline.usd;
    if (this.baseline && this.baseline.ymd === ymd && !backwards) return;
    const fromDayBefore = previous && londonYmd(new Date(previous.at)) < ymd ? previous.usd : reading.usd;
    this.baseline = { ymd, usd: fromDayBefore, at: new Date(reading.at).toISOString() };
    this.save?.(this.baseline);
  }
}

/** A figure with its source, for chat: an estimate is never written as the bill. */
export function spendPhrase(spend: RealSpend): string {
  return spend.source === "provider" ? `$${spend.usd.toFixed(2)} charged by OpenRouter` : `$${spend.usd.toFixed(2)} estimated`;
}

/** Why a figure is only an estimate, or undefined when it is the provider's own. */
export function spendCaveat(spend: RealSpend): string | undefined {
  return spend.source === "provider" ? undefined : spend.note;
}

/** The meter the service uses: the store keeps the day's starting figure so a restart keeps it. */
export function storeMeter(store: { usageStart: () => SpendBaseline | undefined; setUsageStart: (b: SpendBaseline) => void }): SpendMeter {
  return new SpendMeter({ load: () => store.usageStart(), save: (b) => store.setUsageStart(b) });
}

/** One start-up log line: where the spend figure comes from. */
export function spendLine(): string {
  if (!config.openrouter.apiKey) return "Spend: the Agent SDK's cost at Anthropic's list prices (no provider usage endpoint to read).";
  return `Spend: OpenRouter's own account usage (${OPENROUTER_BASE_URL}/v1/key, read at most once a minute); the Agent SDK's price table is the fallback and never the bill.`;
}
