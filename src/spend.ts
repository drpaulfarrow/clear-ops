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
 * The SDK estimate is internal only (Paul's call, 13 Nov 2026: "Remove the agent sdk estimate it's
 * not helpful"). It never reaches a message: the only figure ever shown to a person is the
 * provider's, and where that cannot be read the reply says so and shows no substitute. Internally it
 * does two jobs: it is the stand-in the daily cap is judged on while the provider cannot be read
 * (never as zero, always with `spendDisplay` saying there is no figure), and the Agent SDK's own
 * per-run budget cap, which is what stops a single runaway run.
 *
 * An Anthropic-only deployment is unchanged: there is no usage endpoint to read, and the SDK's
 * list-price cost is the figure, labelled as Anthropic's own list price rather than as an estimate,
 * because on Anthropic that is what is billed.
 *
 * The provider is asked at most once a minute (`refresh()` is cached), a reading older than
 * `SPEND_MAX_AGE_MS` is treated as stale, and a failure, a rate limit or a non-numeric reply all
 * fall back to the internal stand-in rather than silently counting as zero.
 *
 * Known gap: a restart that spans midnight re-bases the day on the first reading after boot, so
 * spend between midnight and that reading is not counted. It is a soft cap: a single run is still
 * bounded by the per-run cap, and the estimate covers the day until the provider is read.
 */
import { config } from "./config.js";
import { OPENROUTER_BASE_URL } from "./llm.js";
import { londonYmd } from "./london.js";

/** At most one call to the provider a minute, however often the cap is checked. */
export const SPEND_REFRESH_MS = 60_000;
/** A reading older than this is stale: the internal stand-in is used instead, and nothing is shown. */
export const SPEND_MAX_AGE_MS = 5 * 60_000;
/** How long one usage call may take before it is abandoned. */
export const SPEND_TIMEOUT_MS = 5_000;

/**
 * Where a spend figure came from: OpenRouter's own account, Anthropic's own list prices (which is
 * the bill when the workforce runs on Anthropic directly), or our rounded-up price table, which is
 * an estimate, is never the bill, and is never shown to anyone.
 */
export type SpendSource = "provider" | "anthropic" | "estimate";

/** One reading of the provider's cumulative usage. */
export interface SpendReading {
  /** Cumulative USD charged to the key, as the provider reports it. */
  usd: number;
  /** When it was read, ms since the epoch. */
  at: number;
}

/** Spend for one London day, with its source. `usd` is shown only when `spendDisplay` calls it a figure. */
export interface RealSpend {
  usd: number;
  source: SpendSource;
  /** When the provider figure was read, when there is one. */
  asOf?: number;
  /** Why there is no provider figure, when there is none. */
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
      // Anthropic mode: the SDK prices every run from Anthropic's list prices, and that is the bill,
      // so this is not labelled an estimate (there is simply no usage endpoint to read).
      return { usd: estimateUsd, source: "anthropic" };
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
        this.warn(`${this.failure}; the cap falls back to the internal stand-in and nothing is shown.`);
        return;
      }
      const body = (await res.json()) as { data?: { usage?: unknown } };
      const usd = Number(body?.data?.usage);
      if (!Number.isFinite(usd) || usd < 0) {
        this.failure = "OpenRouter's usage reply was not a number";
        this.warn(`${this.failure}; the cap falls back to the internal stand-in and nothing is shown.`);
        return;
      }
      this.failure = undefined;
      const previous = this.reading;
      const reading: SpendReading = { usd, at: this.now() };
      this.reading = reading;
      this.rollBaseline(previous, reading);
    } catch (err) {
      this.failure = `OpenRouter could not be read (${err instanceof Error ? err.message : String(err)})`;
      this.warn(`${this.failure}; the cap falls back to the internal stand-in and nothing is shown.`);
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

/**
 * How one spend figure may reach a message: the provider's own number with the words that say whose
 * it is, or the plain fact that there is none. There is no third case, so no message can print the
 * SDK's estimate by accident.
 */
export type SpendDisplay =
  | { kind: "figure"; usd: number; label: string }
  | { kind: "unreadable"; reason: string };

/** The one way a spend figure reaches a person. An estimate becomes `unreadable`, never a number. */
export function spendDisplay(spend: RealSpend): SpendDisplay {
  if (spend.source === "provider") return { kind: "figure", usd: spend.usd, label: "OpenRouter's own figure" };
  if (spend.source === "anthropic") return { kind: "figure", usd: spend.usd, label: "Anthropic's own list price" };
  return { kind: "unreadable", reason: spend.note ?? "OpenRouter could not be read" };
}

/** A figure with its source, or that there is none: the SDK's estimate is never written as spend. */
export function spendPhrase(spend: RealSpend): string {
  if (spend.source === "provider") return `$${spend.usd.toFixed(2)} charged by OpenRouter`;
  if (spend.source === "anthropic") return `$${spend.usd.toFixed(2)} charged by Anthropic (list price)`;
  return `no spend figure (${spend.note ?? "OpenRouter could not be read"})`;
}

/** Why there is no provider figure, or undefined when there is one. Internal: the reason, never a number. */
export function spendCaveat(spend: RealSpend): string | undefined {
  return spend.source === "estimate" ? spend.note : undefined;
}

/** The meter the service uses: the store keeps the day's starting figure so a restart keeps it. */
export function storeMeter(store: { usageStart: () => SpendBaseline | undefined; setUsageStart: (b: SpendBaseline) => void }): SpendMeter {
  return new SpendMeter({ load: () => store.usageStart(), save: (b) => store.setUsageStart(b) });
}

/** One start-up log line: where the spend figure comes from. The SDK's estimate is internal and not shown. */
export function spendLine(): string {
  if (!config.openrouter.apiKey) return "Spend: the Agent SDK's cost at Anthropic's list prices (no provider usage endpoint to read). Nothing else is shown.";
  return `Spend: OpenRouter's own account usage (${OPENROUTER_BASE_URL}/v1/key, read at most once a minute) and only that figure; the Agent SDK's estimate is internal (the per-run cap and the stand-in the daily cap falls back to) and is never shown.`;
}
