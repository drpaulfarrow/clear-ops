import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** A positive number from the environment, or the default when it is unset, zero or not a number. */
function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
     * uses for it). Defaults to his personal site. Repositories the workforce creates are kept in the
     * store, not here.
     */
    extra: process.env.MANAGED_REPOS || "site=drpaulfarrow/drpaulfarrowcom|drpaulfarrow.com",
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
    budgetUsd: Number(process.env.DESIGN_BUDGET_USD ?? 10),
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
  jobBudgetUsd: Number(process.env.JOB_BUDGET_USD ?? 5),
  engineerBudgetUsd: Number(process.env.ENGINEER_BUDGET_USD ?? 25),
  /** Spend cap per deep research job (start_job with depth "deep", or a brief that asks for deep research). */
  deepResearchBudgetUsd: Number(process.env.DEEP_RESEARCH_BUDGET_USD ?? 20),
  /** Minutes a running job may show no activity from its worker before it is stopped as stalled. */
  /** The most the workforce spends on jobs finished in one London day; past it, new jobs wait. */
  dailyBudgetUsd: positive(process.env.DAILY_BUDGET_USD, 20),
  jobStallMinutes: positive(process.env.JOB_STALL_MINUTES, 30),
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
