import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** A positive number from the environment, or the default when it is unset, zero or not a number. */
/** A money limit that is off unless set: Paul's call (13 Nov 2026), "remove all payment caps". */
function optionalUsd(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Engineering jobs at once on one repository when nothing says otherwise. */
export const ENGINEER_SLOTS_DEFAULT = 2;
/**
 * The hard ceiling on those slots: however ENGINEER_SLOTS is written, no more than this many engineering
 * jobs run on one repository at once. Anything above it is refused and the rest queue in order as before,
 * so the setting stays a plain number Paul can change while the machine still has a limit it enforces.
 */
export const ENGINEER_SLOTS_MAX = 8;

/**
 * The engineering slots in force, from ENGINEER_SLOTS: a plain number, so more jobs at once is a setting
 * and not a code change. Above ENGINEER_SLOTS_MAX the maximum is used and `asked` says what was written,
 * so the start-up log can say the number was refused rather than silently ignoring it.
 */
export function engineerSlots(raw: string | undefined = process.env.ENGINEER_SLOTS): { slots: number; asked: number } {
  const asked = Math.floor(positive(raw, ENGINEER_SLOTS_DEFAULT));
  return { slots: Math.min(asked, ENGINEER_SLOTS_MAX), asked };
}

/** The start-up log line naming the engineering slots in force, and saying when a bigger number was refused. */
export function engineerSlotsLine(raw: string | undefined = process.env.ENGINEER_SLOTS): string {
  const { slots, asked } = engineerSlots(raw);
  const copy = slots > 1 ? ", each in its own working copy" : "";
  const capped = asked > slots ? ` (ENGINEER_SLOTS=${asked} is above the maximum of ${ENGINEER_SLOTS_MAX}, so ${slots} is used)` : "";
  return `engineering: ${slots} job${slots === 1 ? "" : "s"} per repository at once${copy}, at most ${ENGINEER_SLOTS_MAX}${capped}`;
}

export type Channel = "telegram" | "discord" | "whatsapp";

const channels = (process.env.CHANNELS ?? process.env.CHANNEL ?? "telegram")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean) as Channel[];

export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** Channels to run at once, e.g. "telegram,discord". */
  channels,
  channel: channels[0],
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  repoDir: path.resolve(process.env.REPO_DIR ?? "./workspace"),
  /** A clone of this service's own repository, so the engineer can improve the workforce itself. */
  selfRepoDir: path.resolve(process.env.SELF_REPO_DIR ?? "./self"),
  /** Where managed repositories other than product and workforce are cloned: one folder per alias, on the data volume. */
  reposDir: path.resolve(process.env.REPOS_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "repos")),
  allowedNumbers: (process.env.ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  allowedTelegramIds: (process.env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => `tg:${id}`),
  allowedDiscordIds: (process.env.ALLOWED_DISCORD_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => `dc:u:${id}`),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
  },
  discord: {
    token: process.env.DISCORD_BOT_TOKEN ?? "",
  },
  /** GitHub "owner/name" slugs. Cloned automatically on first start when GH_TOKEN is set. */
  /** The private repository every finished job's output is copied to (src/publish-outputs.ts). */
  outputsRepo: process.env.OUTPUTS_REPO || "drpaulfarrow/clear-outputs",
  repos: {
    product: process.env.PRODUCT_REPO || undefined,
    self: process.env.SELF_REPO || "drpaulfarrow/clear-ops",
    /**
     * More managed repositories: comma-separated `alias=owner/name` (optionally `|another name` Paul
     * uses for it). Defaults to his personal site (alias "site") and the second project he wants pull
     * requests to (alias "doubleshift"). Repositories the workforce creates are kept in the store, not
     * here.
     */
    extra: process.env.MANAGED_REPOS || "site=drpaulfarrow/drpaulfarrowcom|drpaulfarrow.com,doubleshift=shftd2-pre/app-doubleshift",
    /** The GitHub account new repositories are created under. */
    owner: process.env.REPO_OWNER || "drpaulfarrow",
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    apiVersion: process.env.WHATSAPP_API_VERSION ?? "v21.0",
  },
  /**
   * OpenRouter instead of Anthropic: set OPENROUTER_API_KEY and every agent goes through OpenRouter
   * (src/llm.ts). The aliases the roles use map to OPENROUTER_HAIKU_MODEL, _SONNET_, _OPUS_ and
   * _FABLE_ (defaults in src/llm.ts); OPENROUTER_PRICES (JSON) prices models the defaults do not cover.
   */
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    models: {
      haiku: process.env.OPENROUTER_HAIKU_MODEL ?? "",
      sonnet: process.env.OPENROUTER_SONNET_MODEL ?? "",
      opus: process.env.OPENROUTER_OPUS_MODEL ?? "",
      fable: process.env.OPENROUTER_FABLE_MODEL ?? "",
    },
    prices: process.env.OPENROUTER_PRICES ?? "",
  },
  /** Web search the service runs itself (src/search.ts); a tool appears only when its key is set. */
  search: {
    braveKey: process.env.BRAVE_API_KEY ?? "",
    exaKey: process.env.EXA_API_KEY ?? "",
  },
  /**
   * Voice notes: audio Paul sends in chat, transcribed by the service before the chief sees it
   * (src/transcribe.ts). One plain HTTPS call to an OpenAI-compatible /audio/transcriptions
   * endpoint, OpenRouter by default: its key is already set for the models, so transcription needs
   * no second account. TRANSCRIBE_API_KEY (and TRANSCRIBE_BASE_URL) point it at another provider
   * instead. The key is read from the environment only, never logged, stored or sent to a worker.
   */
  transcribe: {
    enabled: (process.env.TRANSCRIBE ?? "on").toLowerCase() !== "off",
    apiKey: process.env.TRANSCRIBE_API_KEY ?? "",
    baseUrl: (process.env.TRANSCRIBE_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    model: process.env.TRANSCRIBE_MODEL || "openai/whisper-large-v3",
    /** Largest audio file sent for transcription, in megabytes, and the longest clip in seconds. */
    maxMb: positive(process.env.TRANSCRIBE_MAX_MB, 12),
    maxSeconds: positive(process.env.TRANSCRIBE_MAX_SECONDS, 300),
    timeoutMs: positive(process.env.TRANSCRIBE_TIMEOUT_MS, 60_000),
    /** ISO-639-1, e.g. "en"; empty lets the provider detect it. */
    language: process.env.TRANSCRIBE_LANGUAGE ?? "",
  },
  /**
   * Live voice with Cleo in a Discord voice channel (src/voice.ts, src/voice-bridge.ts). Everything goes
   * through OpenRouter: speech to text (the transcription settings above), the voice brain, and text to
   * speech. Nothing to warm up. On when OPENROUTER_API_KEY is set and VOICE is not "off".
   */
  voice: {
    enabled: (process.env.VOICE ?? "on").toLowerCase() !== "off",
    /** The model Cleo talks with, an alias or an OpenRouter id. Fast matters more than clever: ClearOps does the work. */
    model: process.env.VOICE_MODEL || "haiku",
    /** OpenRouter text-to-speech model and voice. Default: Mistral Voxtral, "Jane", British English. */
    ttsModel: process.env.VOICE_TTS_MODEL || "mistralai/voxtral-mini-tts-3-0",
    ttsVoice: process.env.VOICE_TTS_VOICE || "gb_jane_neutral",
    /** How long Paul must be quiet before his turn is over. */
    silenceMs: positive(process.env.VOICE_SILENCE_MS, 700),
    /** Leave the channel after this many minutes with nobody speaking. */
    idleMinutes: positive(process.env.VOICE_IDLE_MINUTES, 10),
    /** How long Cleo waits for ClearOps to answer before saying it is on it. */
    answerWaitSeconds: positive(process.env.VOICE_ANSWER_WAIT_SECONDS, 12),
  },
  /**
   * Purchases (src/purchase.ts): every one approved by Paul, no spending limit (his call, 13 Nov 2026).
   * How long a prepared purchase waits for his decision; the job waits with it, so this stays well under
   * JOB_STALL_MINUTES.
   */
  purchase: {
    waitMinutes: Math.min(positive(process.env.PURCHASE_WAIT_MINUTES, 20), 25),
  },
  /**
   * One-time codes (src/otp.ts): the code a site sends, which the service reads from Paul's mailbox or
   * asks him for in chat, and types into the page itself. Never shown to a model and never stored.
   */
  otp: {
    /** Minutes a request waits for Paul's own "code <id> <the code>"; the job waits with it. */
    waitMinutes: Math.min(positive(process.env.OTP_WAIT_MINUTES, 10), 15),
    /** How long the mailbox is watched for the site's own email before Paul is asked instead. */
    mailWaitMs: positive(process.env.OTP_MAIL_WAIT_SECONDS, 40) * 1000,
    /** Requests one job may make in a rolling hour. */
    maxPerJob: positive(process.env.OTP_MAX_PER_JOB, 3),
    /** The least gap between two requests for the same site, in seconds. */
    minGapSeconds: positive(process.env.OTP_MIN_GAP_SECONDS, 20),
  },
  /** The browsing tools (src/browse.ts): on unless BROWSE=off; actions per job. */
  browse: {
    enabled: (process.env.BROWSE ?? "on").toLowerCase() !== "off",
    maxActions: Number(process.env.BROWSE_MAX_ACTIONS ?? 60),
  },
  models: {
    chief: process.env.CHIEF_MODEL ?? "haiku",
    worker: process.env.WORKER_MODEL ?? "haiku",
    engineer: process.env.ENGINEER_MODEL ?? "haiku",
    /**
     * The executive assistant reads Paul's mail and calendar. Paul's call (13 Nov 2026): it runs on
     * Claude Sonnet on Anthropic's API directly, even when OPENROUTER_API_KEY sends everything else to
     * open models (src/llm.ts `runRoute`). Follow-up nudge drafts are the exception and use WORKER_MODEL.
     */
    ea: process.env.EA_MODEL || "sonnet",
  },
  /** The design worker: what it looks at, its browser, model and spend cap per job. */
  design: {
    siteUrl: process.env.DESIGN_SITE_URL || "https://clear-exchange.fly.dev",
    chromiumPath: process.env.CHROMIUM_PATH || "chromium",
    /** The unprivileged account the browser and branch previews run as (created in the Dockerfile). */
    user: process.env.DESIGN_USER || "designer",
    model: process.env.DESIGN_MODEL ?? "haiku",
    budgetUsd: optionalUsd(process.env.DESIGN_BUDGET_USD),
  },
  /**
   * Files the founder sends in chat. On the data volume, outside every git checkout, owner-only.
   * Override with UPLOADS_DIR; it must not sit inside REPO_DIR or SELF_REPO_DIR.
   */
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "uploads")),
  /** Largest single attachment accepted, in megabytes. Telegram bots cannot fetch more than 20. */
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB ?? 20),
  /**
   * Where this service is reachable from a browser, for the Google consent redirect. Fly sets
   * FLY_APP_NAME, so on Fly this is https://<app>.fly.dev unless PUBLIC_URL overrides it.
   */
  publicUrl: (process.env.PUBLIC_URL || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : `http://localhost:${process.env.PORT ?? 8080}`)).replace(/\/+$/, ""),
  /**
   * Paul's Google Workspace, for the executive assistant: an OAuth client for his own user account
   * (no service account, no domain-wide delegation). GOOGLE_ACCOUNT, when set, is the only account
   * that may be connected. GOOGLE_TOKEN_KEY encrypts the stored refresh token; without it the key is
   * derived from GOOGLE_CLIENT_SECRET, which also lives only in the secrets store, never on the volume.
   */
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    account: (process.env.GOOGLE_ACCOUNT ?? "").trim().toLowerCase(),
    tokenKey: process.env.GOOGLE_TOKEN_KEY ?? "",
  },
  /**
   * Paul's appointment-schedule booking link, offered in scheduling drafts. Not a secret, but kept out
   * of this public repository: set it as the EA_BOOKING_LINK Actions variable (or env var).
   */
  eaBookingLink: (process.env.EA_BOOKING_LINK ?? "").trim(),
  /** Sending mail and inviting people, only after Paul approves each one in chat (src/outbound.ts). */
  outbound: {
    dailyCap: positive(process.env.OUTBOUND_DAILY_CAP, 10),
    maxRecipients: positive(process.env.OUTBOUND_MAX_RECIPIENTS, 10),
    ttlHours: positive(process.env.OUTBOUND_TTL_HOURS, 24),
  },
  /**
   * GoDaddy DNS (src/dns.ts, src/dns-gate.ts). The token (or key and secret) exist only as service secrets; the
   * domain list is the allowlist of zones the DNS agent may touch (Paul edits it with the GODADDY_DOMAINS setting).
   */
  dns: {
    token: process.env.GODADDY_API_TOKEN ?? "",
    key: process.env.GODADDY_API_KEY ?? "",
    secret: process.env.GODADDY_API_SECRET ?? "",
    base: (process.env.GODADDY_API_BASE || "https://api.godaddy.com").replace(/\/+$/, ""),
    domains: (process.env.GODADDY_DOMAINS || "clearexchange.ai,drpaulfarrow.com")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    ttlHours: positive(process.env.DNS_TTL_HOURS, 2),
  },
  /**
   * Signing Paul up for a site he named in chat (src/signup.ts, src/signup-gate.ts). `emails` are the
   * addresses he named for sign-ups: with none, no sign-up can be prepared at all, which is the safe
   * default. `sites` is an extra allowlist of domains where a sign-up may be prepared, on top of the
   * sites agents may already act on; the never-list in src/site-policy.ts still blocks money sites,
   * email providers, Microsoft, password managers, government identity services and this service's own
   * infrastructure, whatever is set here. Nothing is ever submitted without Paul's own "signup apply <id>".
   */
  signup: {
    emails: (process.env.SIGNUP_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sites: (process.env.SIGNUP_SITES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    ttlHours: positive(process.env.SIGNUP_TTL_HOURS, 6),
    dailyCap: positive(process.env.SIGNUP_DAILY_CAP, 3),
  },
  /**
   * A job's own cap, counted in the provider's money (src/realcost.ts: the sum of what OpenRouter
   * charged for that job's calls, read call by call). Off unless set (Paul's call, 13 Nov 2026), and
   * never counted from the Agent SDK's estimate, so a job is never stopped while it has really spent
   * pennies. It is enforced by the service during the run; the SDK guard below is a separate thing.
   */
  jobBudgetUsd: optionalUsd(process.env.JOB_BUDGET_USD),
  /** The same cap for engineer, create_agent and maintain jobs, in the provider's money. Off unless set. */
  engineerBudgetUsd: optionalUsd(process.env.ENGINEER_BUDGET_USD),
  /** Spend cap per deep research job, in the provider's money. Off unless set. */
  deepResearchBudgetUsd: optionalUsd(process.env.DEEP_RESEARCH_BUDGET_USD),
  /**
   * The Agent SDK's own per-run guard, measured with its rounded-up estimate (src/llm.ts), which on
   * OpenRouter runs around fifty times the real charge. It is not a bill and never a job's cap: it is
   * deliberately far above any ordinary run's estimate, so it stops only a run that has gone badly
   * wrong, and every run is also bounded by its turn limit and by JOB_MAX_RUNTIME_MINUTES.
   */
  sdkRunawayBudgetUsd: positive(process.env.SDK_RUNAWAY_BUDGET_USD, 1000),
  /** Minutes a running job may show no activity from its worker before it is stopped as stalled. */
  /** The most the workforce spends in one London day; past it, new jobs wait. Off (undefined) unless DAILY_BUDGET_USD is set: Paul's call, 13 Nov 2026. */
  dailyBudgetUsd: optionalUsd(process.env.DAILY_BUDGET_USD),
  /**
   * Engineering jobs (engineer, create_agent) that may run at once on one repository, each in its own
   * working copy (the checkout, then git worktrees beside it). ENGINEER_SLOTS, a plain number: two by
   * default, at most ENGINEER_SLOTS_MAX (8), and anything above that is refused and queued instead.
   */
  engineerSlots: engineerSlots().slots,
  jobStallMinutes: positive(process.env.JOB_STALL_MINUTES, 30),
  /**
   * Reused installs for engineering jobs (src/setup.ts): one `npm ci` per package-lock.json, kept on
   * the data volume and hard-linked into each working copy, and the npm cache the workers use, so a
   * job does not install what another job already installed. SETUP=off leaves every job as it was.
   */
  setup: {
    enabled: (process.env.SETUP ?? "on").toLowerCase() !== "off",
    /** The store, outside every checkout. */
    dir: path.resolve(process.env.SETUP_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "setup")),
    /**
     * The floor: this much of the volume is left free for everything else on it (the store, the job
     * outputs, the sessions, the vault) after whatever setup is about to write. Nothing is written
     * below it, but the check is size-aware: an install must also fit (`SETUP_STORE_MB` or the size
     * this volume has measured for a store), so the first install on a volume needs both.
     */
    minFreeMb: positive(process.env.SETUP_MIN_FREE_MB, 512),
    /** What one store is assumed to need, in MB, until this volume has measured one. */
    storeMb: positive(process.env.SETUP_STORE_MB, 900),
    /** How many lockfile stores to keep besides the one in use, newest first, when the volume can. */
    keep: Math.max(1, Math.floor(positive(process.env.SETUP_KEEP, 4))),
    /** How long a job waits for another job already installing the same lockfile. */
    waitMs: positive(process.env.SETUP_WAIT_MINUTES, 10) * 60_000,
    /** The npm cache every worker install reads and writes, when the volume has room for it. */
    npmCacheDir: path.resolve(process.env.NPM_CACHE_DIR ?? path.join(process.env.DATA_DIR ?? "./data", "setup", "npm-cache")),
  },
  /** The longest any job may run, in minutes, before it is stopped. */
  jobMaxRuntimeMinutes: positive(process.env.JOB_MAX_RUNTIME_MINUTES, 240),
  /** Max WhatsApp text length per message. Meta's limit is 4096. */
  maxMessageChars: 3900,
};

/**
 * Paul's booking link for scheduling drafts: the one he set in chat (/booking), else EA_BOOKING_LINK.
 * Takes anything with settings() so config stays free of the store.
 */
export function bookingLink(store?: { settings(): { eaBookingLink?: string } }): string | undefined {
  return store?.settings().eaBookingLink || config.eaBookingLink || undefined;
}

/** Everyone the workforce will answer, across channels. */
export function isAllowed(from: string): boolean {
  return config.allowedNumbers.includes(from) || config.allowedTelegramIds.includes(from) || config.allowedDiscordIds.includes(from);
}

/** Validate what production needs. Tests and the simulator skip this. */
export function assertProductionConfig(): void {
  // One model provider: OpenRouter when its key is set (it wins), otherwise Anthropic.
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error("Missing required environment variable OPENROUTER_API_KEY or ANTHROPIC_API_KEY");
  // A channel whose token is missing is dropped with a warning rather than stopping the service,
  // so adding Discord to the list before its token exists cannot take Telegram down.
  const usable: Channel[] = [];
  for (const c of config.channels) {
    if (c === "telegram") {
      if (!config.telegram.token) { console.warn("TELEGRAM_BOT_TOKEN is not set; Telegram is off."); continue; }
      if (config.allowedTelegramIds.length === 0) console.warn("ALLOWED_TELEGRAM_IDS is empty. Message the bot to learn your id, then set it and redeploy.");
    } else if (c === "discord") {
      if (!config.discord.token) { console.warn("DISCORD_BOT_TOKEN is not set; Discord is off."); continue; }
      if (config.allowedDiscordIds.length === 0) console.warn("ALLOWED_DISCORD_IDS is empty. Message the bot to learn your id, then set it and redeploy.");
    } else if (c === "whatsapp") {
      if (!config.whatsapp.token || !config.whatsapp.phoneNumberId || !config.whatsapp.verifyToken) { console.warn("WhatsApp settings are incomplete; WhatsApp is off."); continue; }
      if (config.allowedNumbers.length === 0) console.warn("ALLOWED_NUMBERS is empty; WhatsApp will answer nobody.");
    } else {
      console.warn(`Unknown channel "${c}" ignored.`);
      continue;
    }
    usable.push(c);
  }
  if (usable.length === 0) throw new Error("No channel is configured: set TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN or the WhatsApp settings.");
  config.channels = usable;
}
