import express from "express";
import { assertProductionConfig, config } from "./config.js";
import { sdkRunner } from "./agents.js";
import { JobRunner } from "./jobs.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { CloudApiMessenger, parseInbound, verifySignature, type Messenger } from "./whatsapp.js";
import { TelegramMessenger, TelegramPoller } from "./telegram.js";
import { isAllowed } from "./config.js";
import { bootstrapRepos } from "./bootstrap.js";
import type { AgentRunner } from "./agents.js";

export interface AppDeps {
  messenger: Messenger;
  runner: AgentRunner;
  store: Store;
}

/** Builds the Express app. Dependencies are injectable so tests can run it without the network. */
export function buildApp(deps: AppDeps) {
  const jobs = new JobRunner(deps.store, deps.messenger, deps.runner);
  const scheduler = new Scheduler(deps.store, jobs);
  const orchestrator = new Orchestrator(deps.store, deps.messenger, jobs, scheduler, deps.runner);
  scheduler.boot();

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

  return { app, orchestrator, jobs, scheduler };
}

// Entry point when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  assertProductionConfig();
  await bootstrapRepos();
  const store = new Store(config.dataDir);
  const messenger: Messenger = config.channel === "telegram" ? new TelegramMessenger() : new CloudApiMessenger();
  const { app, orchestrator } = buildApp({ messenger, runner: sdkRunner, store });
  app.listen(config.port, () => console.log(`clear-ops listening on :${config.port} (${config.channel})`));
  if (config.channel === "telegram") {
    void new TelegramPoller((from, text) => orchestrator.handle(from, text), messenger, isAllowed).start();
  }
}
