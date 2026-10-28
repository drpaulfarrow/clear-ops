import express from "express";
import { assertProductionConfig, bookingLink, config } from "./config.js";
import { sdkRunner } from "./agents.js";
import { JobRunner } from "./jobs.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { CloudApiMessenger, parseInbound, verifySignature, type Messenger } from "./whatsapp.js";
import { TelegramMessenger, TelegramPoller } from "./telegram.js";
import { DiscordListener } from "./discord.js";
import { RouterMessenger } from "./channels.js";
import { isAllowed } from "./config.js";
import { bootstrapRepos } from "./bootstrap.js";
import type { AgentRunner } from "./agents.js";
import { GoogleApi, GoogleAuth, GoogleError, type Fetch } from "./google.js";
import { EA_SERVER, EaTools, eaServer, ensureEaSchedules, upgradeEaSchedules } from "./ea.js";
import cron from "node-cron";
import { nudgeStale } from "./followups.js";
import { HoldWatcher } from "./meetings.js";

export interface AppDeps {
  messenger: Messenger;
  runner: AgentRunner;
  store: Store;
  /** Paul's Google connection. Built from config when absent; tests inject one with a fake fetch. */
  google?: GoogleAuth;
  /** What Google API calls go through. Tests inject a fake. */
  googleFetch?: Fetch;
}

export const GOOGLE_CALLBACK_PATH = "/google/callback";

/** A plain page for the browser after consent. Never echoes anything from the request. */
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Builds the Express app. Dependencies are injectable so tests can run it without the network. */
export function buildApp(deps: AppDeps) {
  const google =
    deps.google ??
    new GoogleAuth({ ...config.google, redirectUri: `${config.publicUrl}${GOOGLE_CALLBACK_PATH}`, dataDir: config.dataDir, fetch: deps.googleFetch });
  const googleApi = new GoogleApi(google, deps.googleFetch);
  // The executive assistant's Google tools, built per job so its permits (drafts, holds) apply.
  const account = () => {
    try {
      return google.account();
    } catch {
      return undefined;
    }
  };
  const toolsFor = (job: { id: string; kind: string; brief: string; replyTo?: string; permits?: Array<"drafts" | "holds"> }) =>
    job.kind === "ea"
      ? {
          [EA_SERVER]: eaServer(
            new EaTools(googleApi, { permits: job.permits ?? [], brief: job.brief, store: deps.store, bookingLink: bookingLink(deps.store), account: account(), jobId: job.id, replyTo: job.replyTo }),
          ),
        }
      : undefined;
  const jobs = new JobRunner(deps.store, deps.messenger, deps.runner, toolsFor);
  const scheduler = new Scheduler(deps.store, jobs);
  const orchestrator = new Orchestrator(deps.store, deps.messenger, jobs, scheduler, deps.runner, {}, undefined, google);
  scheduler.boot();
  // Schedules made before follow-ups existed pick up the current brief, on the same cron.
  upgradeEaSchedules(scheduler);
  const holdWatcher = new HoldWatcher(deps.store, googleApi, deps.messenger);

  /**
   * The assistant's background checks, run by the service itself (no model): stale follow-ups are
   * nudged in chat on weekdays at 11:00 and 16:00, and confirmed meetings release their other holds
   * every 15 minutes from 07:00 to 21:00. Both do nothing until Google is connected. Started by the
   * entry point, not by tests.
   */
  const startEaTimers = () => {
    const safely = (what: string, f: () => Promise<unknown>) => () => {
      if (!google.connected()) return;
      f().catch((err) => console.error(`${what} failed:`, err instanceof Error ? err.message : err));
    };
    return [
      cron.schedule("0 11,16 * * 1-5", safely("follow-up nudge", () => nudgeStale(deps.store, deps.messenger)), { timezone: "Europe/London" }),
      cron.schedule("*/15 7-21 * * *", safely("hold watcher", () => holdWatcher.tick()), { timezone: "Europe/London" }),
    ];
  };

  const app = express();
  // Keep the raw body for signature verification.
  app.use(express.json({ verify: (req, _res, buf) => ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));

  app.get("/health", (_req, res) => res.json({ ok: true, jobs: deps.store.listJobs(3).length }));

  // Meta webhook verification handshake
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === config.whatsapp.verifyToken && typeof challenge === "string") {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Inbound messages. Acknowledge immediately; process in the background.
  app.post("/webhook", (req, res) => {
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    if (!verifySignature(raw, req.header("x-hub-signature-256"), config.whatsapp.appSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    for (const m of parseInbound(req.body)) void orchestrator.handle(m.from, m.text);
  });

  // Google's redirect after Paul consents. The single-use state ties it to the allowlisted chat that
  // asked for the link; nothing from the request is echoed back to the page.
  app.get(GOOGLE_CALLBACK_PATH, async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code) {
      return res.status(400).type("html").send(page("Not connected", "Google did not grant access. Ask for a new link in chat if you want to try again."));
    }
    try {
      const r = await google.completeConsent(state, code);
      res.type("html").send(page("Connected", "Your assistant can now read your mail and calendars, write drafts and place holds. It can never send email or invite anyone. You can close this tab."));
      deps.store.setSetting("eaReplyTo", r.replyTo);
      const made = ensureEaSchedules(scheduler, r.requestedBy, r.replyTo);
      const lines = made.map((m) => `${m.name} ${m.cron} (${m.id}${m.created ? "" : ", already set"})`).join("; ");
      await deps.messenger
        .send(r.replyTo, `Google connected as ${r.account}: drafts plus holds, never send. Weekday briefs scheduled: ${lines}. Tell me to move or cancel either.`)
        .catch(() => undefined);
    } catch (err) {
      const msg = err instanceof GoogleError ? err.message : "Something went wrong talking to Google. Ask for a new link in chat.";
      res.status(400).type("html").send(page("Not connected", escapeHtml(msg)));
    }
  });

  return { app, orchestrator, jobs, scheduler, google, holdWatcher, startEaTimers };
}

// Entry point when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  assertProductionConfig();
  await bootstrapRepos();
  const store = new Store(config.dataDir);

  // One messenger per channel, routed by address prefix; one orchestrator behind all of them.
  const routes: Array<{ prefix: string; messenger: Messenger }> = [];
  let discord: DiscordListener | undefined;
  if (config.channels.includes("telegram")) routes.push({ prefix: "tg:", messenger: new TelegramMessenger() });
  if (config.channels.includes("discord")) {
    discord = new DiscordListener((from, text, ctx) => orchestrator.handle(from, text, ctx), isAllowed);
    routes.push({ prefix: "dc:", messenger: discord.messenger() });
  }
  const messenger = new RouterMessenger(routes, config.channels.includes("whatsapp") ? new CloudApiMessenger() : undefined);

  const { app, orchestrator, jobs, startEaTimers } = buildApp({ messenger, runner: sdkRunner, store });
  startEaTimers();
  app.listen(config.port, () => console.log(`clear-ops listening on :${config.port} (${config.channels.join(", ")})`));

  if (config.channels.includes("telegram")) {
    void new TelegramPoller((from, text, ctx) => orchestrator.handle(from, text, ctx), messenger, isAllowed).start();
  }
  if (discord) await discord.start();

  // Jobs a previous process left running are picked up again, now that channels can deliver.
  const resumed = await jobs.resumeInterrupted();
  if (resumed) console.log(`resumed ${resumed} interrupted job(s)`);
  // From now on, every minute: stalled or over-long jobs are stopped, orphaned ones restarted, queues kept moving.
  jobs.startWatchdog();
}
