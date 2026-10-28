import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
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
  repos: {
    product: process.env.PRODUCT_REPO || undefined,
    self: process.env.SELF_REPO || "drpaulfarrow/clear-ops",
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    apiVersion: process.env.WHATSAPP_API_VERSION ?? "v21.0",
  },
  models: {
    chief: process.env.CHIEF_MODEL ?? "opus",
    worker: process.env.WORKER_MODEL ?? "sonnet",
    engineer: process.env.ENGINEER_MODEL ?? "opus",
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
  jobBudgetUsd: Number(process.env.JOB_BUDGET_USD ?? 5),
  engineerBudgetUsd: Number(process.env.ENGINEER_BUDGET_USD ?? 25),
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
  req("ANTHROPIC_API_KEY");
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
