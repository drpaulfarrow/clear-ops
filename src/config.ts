import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export type Channel = "telegram" | "whatsapp";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  channel: (process.env.CHANNEL ?? "telegram") as Channel,
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
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
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
  jobBudgetUsd: Number(process.env.JOB_BUDGET_USD ?? 5),
  engineerBudgetUsd: Number(process.env.ENGINEER_BUDGET_USD ?? 25),
  /** Max WhatsApp text length per message. Meta's limit is 4096. */
  maxMessageChars: 3900,
};

/** Everyone the workforce will answer, across channels. */
export function isAllowed(from: string): boolean {
  return config.allowedNumbers.includes(from) || config.allowedTelegramIds.includes(from);
}

/** Validate what production needs. Tests and the simulator skip this. */
export function assertProductionConfig(): void {
  req("ANTHROPIC_API_KEY");
  if (config.channel === "telegram") {
    req("TELEGRAM_BOT_TOKEN");
    if (config.allowedTelegramIds.length === 0) throw new Error("ALLOWED_TELEGRAM_IDS must list at least one Telegram id");
  } else {
    req("WHATSAPP_TOKEN");
    req("WHATSAPP_PHONE_NUMBER_ID");
    req("WHATSAPP_VERIFY_TOKEN");
    if (config.allowedNumbers.length === 0) throw new Error("ALLOWED_NUMBERS must list at least one phone number");
  }
}
