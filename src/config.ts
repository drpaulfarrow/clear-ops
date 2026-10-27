import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  repoDir: path.resolve(process.env.REPO_DIR ?? "./workspace"),
  allowedNumbers: (process.env.ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
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
  /** Max WhatsApp text length per message. Meta's limit is 4096. */
  maxMessageChars: 3900,
};

/** Validate what production needs. Tests and the simulator skip this. */
export function assertProductionConfig(): void {
  req("ANTHROPIC_API_KEY");
  req("WHATSAPP_TOKEN");
  req("WHATSAPP_PHONE_NUMBER_ID");
  req("WHATSAPP_VERIFY_TOKEN");
  if (config.allowedNumbers.length === 0) {
    throw new Error("ALLOWED_NUMBERS must list at least one phone number");
  }
}
