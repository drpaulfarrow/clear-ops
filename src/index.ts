import express from "express";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { assertProductionConfig, bookingLink, config } from "./config.js";
import { termsWarning } from "./site-policy.js";
import { vault, VAULT_ADD_PATH, VaultError } from "./vault.js";
import { modelLine } from "./llm.js";
import { sdkRunner } from "./agents.js";
import { JobRunner } from "./jobs.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { Store, type EaPermit, type JobPermit } from "./store.js";
import { CloudApiMessenger, parseInbound, verifySignature, whatsappAttachment, type Messenger } from "./whatsapp.js";
import { TelegramMessenger, TelegramPoller } from "./telegram.js";
import { DiscordListener } from "./discord.js";
import { RouterMessenger } from "./channels.js";
import { isAllowed } from "./config.js";
import { backfillOnce, OutputsPublisher } from "./publish-outputs.js";
import { bootstrapRepos, githubProblemMessage, githubStatusLine, repoProblemsMessage } from "./bootstrap.js";
import { startTokenRefresher } from "./github-auth.js";
import { repoRegistry } from "./repos.js";
import { REPO_SERVER, repoServer } from "./repo-tools.js";
import type { AgentRunner } from "./agents.js";
import { GoogleApi, GoogleAuth, GoogleError, type Fetch } from "./google.js";
import { OutboundGate } from "./outbound.js";
import { GoDaddyClient } from "./dns.js";
import { DnsGate, dnsServer, DNS_SERVER } from "./dns-gate.js";
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
  /** GitHub API calls and cloning for repository creation. Tests inject fakes. */
  repoFetch?: typeof fetch;
  repoClone?: (slug: string, dir: string) => Promise<void>;
  /** What Google API calls go through. Tests inject a fake. */
  googleFetch?: Fetch;
  /** Fetch for the GoDaddy client; tests inject a fake. */
  dnsFetch?: Fetch;
  /** The time source for follow-up commands. Tests pin it. */
  clock?: () => Date;
  /** The /status line about GitHub auth. Tests inject one; defaults to a live check. */
  githubStatus?: () => Promise<string>;
  /** Copies each finished job's output to the private outputs repository. Absent in tests. */
  outputs?: OutputsPublisher;
}

export const GOOGLE_CALLBACK_PATH = "/google/callback";

/** A plain page for the browser after consent. Never echoes anything from the request. */
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Pages that carry secrets are never cached, framed or allowed to load anything from elsewhere. */
function noStore(res: express.Response): void {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
}

/** The add-a-login form. The token rides in a hidden field so it never reaches a referrer or a log line. */
function vaultForm(token: string, domain?: string): string {
  const field = (label: string, name: string, type: string, extra = "") =>
    `<label style="display:block;margin:.8rem 0 .2rem">${label}</label><input name="${name}" type="${type}" ${extra} style="width:100%;padding:.5rem;font-size:1rem">`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Add a login</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">Add a login for ClearOps</h1><p>Stored encrypted. Agents use it to sign in to this site only; they never see the password.</p><form method="post" action="${VAULT_ADD_PATH}" autocomplete="off"><input type="hidden" name="t" value="${escapeHtml(token)}">${field("Site (domain)", "domain", "text", `required placeholder="crunchbase.com" value="${escapeHtml(domain ?? "")}"`)}${field("Username or email", "username", "text", "required")}${field("Password", "password", "password", 'required autocomplete="new-password"')}${field("Two-factor setup key (optional)", "totp", "text", 'placeholder="the text code shown next to the QR code"')}<p style="font-size:.85rem;color:#555">Storing the two-factor key lets agents sign in without you, but the vault then holds both factors for this site.</p>${field("Login page address (optional)", "loginUrl", "url", 'placeholder="https://example.com/login"')}<button style="margin-top:1rem;padding:.6rem 1rem;font-size:1rem">Save</button></form></body>`;
}

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
  // The approval gate for sending mail and inviting people: shared by the ea's prepare tools and the chat approval.
  const outbound = new OutboundGate(deps.store, googleApi, deps.messenger);
  // The approval gate for DNS changes: shared by the dns agent's prepare tool and the chat approval.
  const dnsClient = new GoDaddyClient(deps.dnsFetch);
  const dns = new DnsGate(deps.store, dnsClient, deps.messenger);
  // Repositories the workforce created in earlier runs are managed again from the first request.
  repoRegistry.load(deps.store);
  const toolsFor = (job: { id: string; kind: string; brief: string; replyTo?: string; permits?: JobPermit[] }): Record<string, McpServerConfig> | undefined =>
    job.kind === "ea"
      ? {
          [EA_SERVER]: eaServer(
            new EaTools(googleApi, { permits: (job.permits ?? []).filter((p): p is EaPermit => p === "drafts" || p === "holds" || p === "send"), brief: job.brief, store: deps.store, bookingLink: bookingLink(deps.store), account: account(), jobId: job.id, replyTo: job.replyTo, outbound }),
          ),
        }
      : job.kind === "dns"
        ? { [DNS_SERVER]: dnsServer({ client: dnsClient, gate: dns, permit: job.permits?.includes("dns") === true, jobId: job.id, replyTo: job.replyTo }) }
      : // Only an engineer job the chief gave the create_repo permit (Paul asked in chat) gets the tool.
        job.kind === "engineer" && job.permits?.includes("create_repo")
        ? { [REPO_SERVER]: repoServer({ store: deps.store, jobId: job.id, createDeps: { fetch: deps.repoFetch, clone: deps.repoClone } }) }
        : undefined;
  const jobs = new JobRunner(deps.store, deps.messenger, deps.runner, toolsFor, { onOutput: deps.outputs ? (j) => deps.outputs?.publish(j) : undefined });
  const scheduler = new Scheduler(deps.store, jobs);
  const orchestrator = new Orchestrator(deps.store, deps.messenger, jobs, scheduler, deps.runner, {}, undefined, google, deps.clock, deps.githubStatus ?? (() => githubStatusLine()), outbound, dns);
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
    // An audio message arrives as a media id; its bytes are fetched in the orchestrator, after the
    // allowlist check, like every other attachment.
    for (const m of parseInbound(req.body)) void orchestrator.handle(m.from, m.text, m.audio ? { attachments: [whatsappAttachment(m.audio)] } : {});
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
      res.type("html").send(page("Connected", "Your assistant can now read your mail and calendars, write drafts and place holds. It can send an email or invite people only after you approve that exact item in chat. You can close this tab."));
      deps.store.setSetting("eaReplyTo", r.replyTo);
      const made = ensureEaSchedules(scheduler, r.requestedBy, r.replyTo);
      const lines = made.map((m) => `${m.name} ${m.cron} (${m.id}${m.created ? "" : ", already set"})`).join("; ");
      await deps.messenger
        .send(r.replyTo, `Google connected as ${r.account}: drafts plus holds; it sends mail or invites people only when you approve each one in chat. Weekday briefs scheduled: ${lines}. Tell me to move or cancel either.`)
        .catch(() => undefined);
    } catch (err) {
      const msg = err instanceof GoogleError ? err.message : "Something went wrong talking to Google. Ask for a new link in chat.";
      res.status(400).type("html").send(page("Not connected", escapeHtml(msg)));
    }
  });

  // Paul's private page for adding a website login to the vault. Opened from a one-time link the chief
  // sent in chat; nothing typed here is echoed back or logged.
  app.get(VAULT_ADD_PATH, (req, res) => {
    noStore(res);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const p = token ? vault.peek(token) : undefined;
    if (!p) return res.status(400).type("html").send(page("Link expired", "This link has expired or was already used. Ask ClearOps for a new one."));
    res.type("html").send(vaultForm(token, p.domain));
  });
  app.post(VAULT_ADD_PATH, express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    noStore(res);
    const b = (req.body ?? {}) as Record<string, string>;
    try {
      const r = vault.add(String(b.t ?? ""), { domain: String(b.domain ?? ""), username: String(b.username ?? ""), password: String(b.password ?? ""), totp: String(b.totp ?? ""), loginUrl: String(b.loginUrl ?? "") });
      const warn = termsWarning(r.summary.domain);
      res.type("html").send(page("Saved", `The login for ${escapeHtml(r.summary.domain)} is in the vault. Agents can now sign in there and act on the site, except paying, sending, posting and deleting. You can close this tab.`));
      await deps.messenger
        .send(r.replyTo, `Vault: saved the login for ${r.summary.domain} (${r.summary.username}${r.summary.twoFactor ? ", with two-factor" : ""}). Agents can now sign in and act there; paying, sending, posting and deleting still need you.${warn ? ` Note: ${warn}.` : ""} Say remove the ${r.summary.domain} login to delete it.`)
        .catch(() => undefined);
    } catch (err) {
      const msg = err instanceof VaultError ? err.message : "That could not be saved. Check the site and the login page address, and ask ClearOps for a new link if this one has expired.";
      res.status(400).type("html").send(page("Not saved", escapeHtml(msg)));
    }
  });

  return { app, orchestrator, jobs, scheduler, google, holdWatcher, startEaTimers };
}

// Entry point when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  assertProductionConfig();
  console.log(modelLine());
  const store = new Store(config.dataDir);
  repoRegistry.load(store);
  // With the GitHub App configured, keep its installation token fresh for git and gh during long jobs.
  startTokenRefresher();
  const repoProblems = await bootstrapRepos();
  const github = await githubProblemMessage().catch(() => ({ message: undefined, line: "GitHub: health check failed." }));
  console.log(github.line);

  // One messenger per channel, routed by address prefix; one orchestrator behind all of them.
  const routes: Array<{ prefix: string; messenger: Messenger }> = [];
  let discord: DiscordListener | undefined;
  if (config.channels.includes("telegram")) routes.push({ prefix: "tg:", messenger: new TelegramMessenger() });
  if (config.channels.includes("discord")) {
    discord = new DiscordListener((from, text, ctx) => orchestrator.handle(from, text, ctx), isAllowed);
    routes.push({ prefix: "dc:", messenger: discord.messenger() });
  }
  const messenger = new RouterMessenger(routes, config.channels.includes("whatsapp") ? new CloudApiMessenger() : undefined);

  const notifyPaul = (text: string) => {
    const to = config.allowedTelegramIds[0] ?? config.allowedDiscordIds[0] ?? config.allowedNumbers[0];
    if (to) void messenger.send(to, text).catch(() => undefined);
  };
  const outputs = new OutputsPublisher(store, { onProblem: notifyPaul });
  const { app, orchestrator, jobs, startEaTimers } = buildApp({ messenger, runner: sdkRunner, store, outputs });
  startEaTimers();
  app.listen(config.port, () => console.log(`clear-ops listening on :${config.port} (${config.channels.join(", ")})`));

  if (config.channels.includes("telegram")) {
    void new TelegramPoller((from, text, ctx) => orchestrator.handle(from, text, ctx), messenger, isAllowed).start();
  }
  if (discord) await discord.start();

  // A repository that could not be cloned: tell Paul once, in plain English, exactly what to change.
  const problem = repoProblemsMessage(repoProblems);
  const told = problem ? repoProblems.map((p) => p.slug).join(",") : "";
  if (problem && store.settings().repoProblemsTold !== told) {
    const to = config.allowedTelegramIds[0] ?? config.allowedDiscordIds[0] ?? config.allowedNumbers[0];
    if (to) await messenger.send(to, problem).then(() => store.setSetting("repoProblemsTold", told)).catch(() => undefined);
  } else if (!problem && store.settings().repoProblemsTold) store.setSetting("repoProblemsTold", undefined);

  // GitHub auth: the App failing or a managed repository out of reach, told once per distinct problem. Skipped when the clone failure message above already covers it.
  if (github.message && !problem && store.settings().githubProblemTold !== github.message) {
    const to = config.allowedTelegramIds[0] ?? config.allowedDiscordIds[0] ?? config.allowedNumbers[0];
    if (to) await messenger.send(to, github.message).then(() => store.setSetting("githubProblemTold", github.message)).catch(() => undefined);
  } else if (!github.message && store.settings().githubProblemTold) store.setSetting("githubProblemTold", undefined);

  // Jobs a previous process left running are picked up again, now that channels can deliver.
  const resumed = await jobs.resumeInterrupted();
  if (resumed) console.log(`resumed ${resumed} interrupted job(s)`);
  // From now on, every minute: stalled or over-long jobs are stopped, orphaned ones restarted, queues kept moving.
  jobs.startWatchdog();
  // One-off: copy every output already on the volume to the outputs repository. In the background; never blocks boot.
  void backfillOnce(store, outputs).catch((err) => console.warn(`outputs backfill: ${err instanceof Error ? err.message : err}`));
}
