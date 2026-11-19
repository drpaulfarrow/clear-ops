import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { assertProductionConfig, bookingLink, config, engineerSlotsLine } from "./config.js";
import { registerActAsMe, SitePolicy, termsWarning } from "./site-policy.js";
import { hostMatches, safeVaultDomains, vault, VAULT_ADD_PATH, VaultError, cardVault, VAULT_CARD_PATH, VAULT_LINK_MINUTES } from "./vault.js";
import type { Vault, CardVault } from "./vault.js";
import { escapeHtml, field, htmlPage, expiredPage } from "./page-style.js";
import { modelLine } from "./llm.js";
import { spendLine } from "./spend.js";
import { sdkRunner } from "./agents.js";
import { JobRunner } from "./jobs.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { Store, type EaPermit, type JobPermit } from "./store.js";
import { CloudApiMessenger, parseInbound, verifySignature, whatsappAttachment, type Messenger } from "./whatsapp.js";
import { TelegramMessenger, TelegramPoller } from "./telegram.js";
import { DiscordListener, inspectGuilds, readJobThread, readOwnerDm, soleDiscordOwner } from "./discord.js";
import { RouterMessenger } from "./channels.js";
import { isAllowed, isOversightSender } from "./config.js";
import { backfillOnce, OutputsPublisher } from "./publish-outputs.js";
import { importOffboardRun, OFFBOARD_RUN_ID } from "./offboard-import.js";
import { bootstrapRepos, githubProblemMessage, githubStatusLine, repoCredential, repoCredentialLine, repoProblemsMessage } from "./bootstrap.js";
import { githubAuth, startTokenRefresher } from "./github-auth.js";
import { repoRegistry } from "./repos.js";
import { REPO_SERVER, repoServer } from "./repo-tools.js";
import type { AgentRunner } from "./agents.js";
import { GoogleApi, GoogleAuth, GoogleError, type Fetch } from "./google.js";
import { OutboundGate } from "./outbound.js";
import { GoDaddyClient } from "./dns.js";
import { DnsGate, dnsServer, DNS_SERVER } from "./dns-gate.js";
import { BrowserSignupSubmitter } from "./signup.js";
import { SignupGate, signupServer, SIGNUP_SERVER } from "./signup-gate.js";
import { BrowseSession } from "./browse.js";
import { EA_SERVER, EaTools, eaServer, ensureEaSchedules, upgradeEaSchedules } from "./ea.js";
import cron from "node-cron";
import { nudgeStale } from "./followups.js";
import { HoldWatcher } from "./meetings.js";
import { VoiceBrain, VoiceTap, voiceEnabled } from "./voice.js";
import type { PurchaseAction } from "./store.js";
import { PURCHASE_PATH, PurchaseGate } from "./purchase.js";
import { OtpRelay } from "./otp.js";
import { GmailCodeReader, type CodeMailbox } from "./mail-code.js";
import { VoiceBridge } from "./voice-bridge.js";
import { BOARD_PATH, boardData, boardToken, boardTokenValid, refusedPage, renderBoard } from "./jobs-board.js";
import { PASSWORD_PATH, SIGN_IN_PATH, SIGN_OUT_PATH, noPasswordPage, passwordPage, passwordSavedPage, signIn as pageSignIn, signInPage, SignInError } from "./sign-in.js";
import type { SignIn } from "./sign-in.js";
import { FILE_CSP, PAGE_CSP, REPORTS_PATH, renderReportPage, renderReportsIndex, reportEntries, reportFor, reportsRefusedPage, reportsTokenValid } from "./reports.js";
import { UptimeLog } from "./uptime.js";
import { AppAuth, appAuth as serviceAppAuth, APP_AUTH_CALLBACK_PATH, APP_AUTH_START_PATH, APP_PATH, APP_SIGN_IN_PATH, APP_SIGN_OUT_PATH, REFUSAL_TEXT, type AppAuthRefusal } from "./app-auth.js";
import { appBoard, appSpend, appChat, appHistory, appJob, appWaiting, rerunRefusal, type AppSource } from "./app-data.js";
import { mintAppApproval } from "./app-approver.js";
import { PrStates } from "./pr-state.js";
import { AppPulls, PullError } from "./app-pulls.js";
import { applyLive, LiveSettingError, setLive } from "./live-settings.js";
import { repoLabel } from "./job-descriptions.js";
import { repoTokens } from "./repo-tokens.js";
import { jobTitle } from "./titles.js";
import { perJobModelError } from "./llm.js";
import { routeWeb, webChat as serviceWebChat, webRefusal, webThread, WEB_CODE_PLACEHOLDER, WEB_CONVERSATION, WEB_PREFIX, WEB_SENDER, WEB_TEXT_MAX, type WebChat } from "./web-chat.js";
import { parseCodeCommand } from "./otp.js";
import { APP_ASSETS_PATH, APP_CSP, appAsset, appShell, appSignInPage } from "./app-pages.js";
import { defaultProbes, HealthProbes } from "./health.js";
import { defaultCanary, type Canary } from "./auto-resume.js";
import { INSTINCT_PATH, instinctRouter } from "./instinct-bridge.js";
import { DocumentIngest } from "./documents.js";
import { DocReader, DOCS_READONLY_SCOPE } from "./doc-reader.js";
import { Uploads } from "./uploads.js";
import { DeviceBudget, DEVICE_PATH, DEVICE_TEXT_MAX_CHARS, DEVICE_TURNS_PER_DAY, DeviceRegistry, deviceRouter } from "./device.js";
import { BridgeChat, BRIDGE_REPLY_TO } from "./instinct-chat.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
  /** Where a one-time code is read from (Paul's mailbox). Tests inject a fake; the default reads his Gmail. */
  mailbox?: CodeMailbox;
  /** The time source for follow-up commands. Tests pin it. */
  clock?: () => Date;
  /** The /status line about GitHub auth. Tests inject one; defaults to a live check. */
  githubStatus?: () => Promise<string>;
  /** Copies each finished job's output to the private outputs repository. Absent in tests. */
  outputs?: OutputsPublisher;
  /** Paul's login vault. The singleton by default; the vault pages' test injects one with a pinned clock. */
  vault?: Vault;
  /** The card vault, for the same reason. */
  cardVault?: CardVault;
  /** The board's heartbeat log. Built from the data directory by default; a test injects one. */
  /** The web app's GitHub sign-in (src/app-auth.ts). Tests inject one with a fake GitHub. */
  appAuth?: AppAuth;
  /** What GitHub says of pull requests (src/pr-state.ts). Tests inject one with a fake GitHub. */
  prStates?: PrStates;
  /** A job's pull request shown in the app, and merged on Paul's own tap (src/app-pulls.ts). Tests inject one with a fake GitHub. */
  pulls?: AppPulls;
  /** The web app's chat transcript (src/web-chat.ts). Tests inject one of their own. */
  webChat?: WebChat;
  uptime?: UptimeLog;
  /** The board's dependency checks. Built from config by default; a test injects fakes. */
  probes?: HealthProbes;
  /** Checks whether the provider answers again after a credit or key hold (src/auto-resume.ts). Off unless given, so tests never call out. */
  canary?: Canary;
  /** The sign-in that stands in front of the browser pages. The singleton by default; tests pin its clock. */
  signIn?: SignIn;
}

export const GOOGLE_CALLBACK_PATH = "/google/callback";

/** A plain page for the browser after consent. Never echoes anything from the request. */
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;
/** Pages that carry secrets are never cached, framed or allowed to load anything from elsewhere. */
function noStore(res: express.Response): void {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
}

/**
 * The add-a-login form, in the service's house style (src/page-style.ts). The token rides in a hidden
 * field so it never reaches a referrer or a log line, and the only thing the link carries into the page
 * is the site's own name. No stored value is ever rendered here, and nothing typed is echoed back.
 */
function vaultForm(token: string, domain?: string): string {
  const body = `<form method="post" action="${VAULT_ADD_PATH}" autocomplete="off"><input type="hidden" name="t" value="${escapeHtml(token)}">${field({ label: "Site (domain)", name: "domain", value: domain, placeholder: "crunchbase.com", required: true, attrs: 'autocapitalize="none" spellcheck="false"' })}${field({ label: "Username or email", name: "username", required: true, attrs: 'autocapitalize="none" spellcheck="false"' })}${field({ label: "Password", name: "password", type: "password", required: true, lock: true, attrs: 'autocomplete="new-password"' })}${field({ label: "Two-factor setup key (optional)", name: "totp", placeholder: "the text code shown next to the QR code", hint: "Storing the two-factor key lets agents sign in without you, but the vault then holds both factors for this site." })}${field({ label: "Login page address (optional)", name: "loginUrl", type: "url", placeholder: "https://example.com/login", attrs: 'autocapitalize="none" spellcheck="false"' })}<button type="submit">Save login</button></form>`;
  return htmlPage({
    title: "Add a login",
    heading: "Save a login",
    icon: "lock",
    chip: domain,
    text: "Stored encrypted, and used only by the service itself: an agent asks to sign in and the service fills the form. No agent ever sees the password.",
    body,
    foot: `This link works once, and expires ${VAULT_LINK_MINUTES} minutes after it was sent.`,
  });
}

/** The add-a-card form, in the same house style. Nothing is echoed back; the token rides in a hidden field. */
function cardForm(token: string): string {
  const body = `<form method="post" action="${VAULT_CARD_PATH}" autocomplete="off"><input type="hidden" name="t" value="${escapeHtml(token)}">${field({ label: "Card number", name: "number", required: true, lock: true, attrs: 'inputmode="numeric" autocomplete="off"' })}${field({ label: "Expiry (MM/YY)", name: "expiry", required: true, placeholder: "08/28", attrs: 'autocomplete="off"' })}${field({ label: "Security code", name: "cvc", required: true, attrs: 'inputmode="numeric" autocomplete="off"' })}${field({ label: "Name on card", name: "name", required: true, attrs: 'autocomplete="off"' })}${field({ label: "Billing postcode (optional)", name: "postcode", attrs: 'autocomplete="off"' })}<button type="submit">Save card</button></form>`;
  return htmlPage({
    title: "Add a card",
    heading: "Save a card",
    icon: "card",
    text: "Use a virtual card with a low limit. It is stored encrypted, never shown to an agent, and entered only on a checkout you approve, order by order. Adding a card replaces any earlier one.",
    body,
    foot: `This link works once, and expires ${VAULT_LINK_MINUTES} minutes after it was sent.`,
  });
}

/** One purchase for Paul to approve. Everything shown is escaped page content the service read. */
function purchasePage(a: PurchaseAction, token: string, screenshot?: string): string {
  const img = screenshot ? `<img alt="The checkout page" src="data:image/jpeg;base64,${screenshot}" style="width:100%;border:1px solid #ccc;border-radius:6px;margin:1rem 0">` : "";
  const button = (decision: string, label: string, colour: string) =>
    `<form method="post" action="${PURCHASE_PATH}/${escapeHtml(a.id)}" style="display:inline"><input type="hidden" name="t" value="${escapeHtml(token)}"><input type="hidden" name="decision" value="${decision}"><button style="padding:.8rem 1.4rem;font-size:1.1rem;margin-right:.6rem;background:${colour};color:#fff;border:0;border-radius:6px">${label}</button></form>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve purchase ${escapeHtml(a.id)}</title><body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${escapeHtml(a.total)} on ${escapeHtml(a.host)}</h1>${a.why ? `<p>${escapeHtml(a.why)}</p>` : ""}<p>Approving presses "<b>${escapeHtml(a.button)}</b>" on this page${a.needsCard ? `, with the vault card ending ${escapeHtml(a.cardLast4 ?? "")}` : ""}. Nothing else is bought, and if the shop or the total has changed, nothing is pressed.</p>${img}<details><summary>What the page lists</summary><pre style="white-space:pre-wrap;font-size:.85rem">${escapeHtml(a.items)}</pre></details><p style="margin-top:1.5rem">${button("approve", "Approve", "#1a7f37")}${button("decline", "Decline", "#b42318")}</p><p style="font-size:.85rem;color:#555">Purchase ${escapeHtml(a.id)}. This link works once and expires at ${escapeHtml(a.expiresAt.slice(11, 16))} UTC.</p></body>`;
}

/** Builds the Express app. Dependencies are injectable so tests can run it without the network. */
/** The Discord gateway, once main() has started it, for the bridge's read-only guild look. */
const discordRef: { current?: DiscordListener } = {};

export function buildApp(given: AppDeps) {
  // The web app's chat is a channel of its own: anything addressed to it lands in its transcript, and
  // every other address goes to the messenger exactly as it was given (src/web-chat.ts).
  const chat = given.webChat ?? serviceWebChat;
  const deps: AppDeps = { ...given, messenger: routeWeb(given.messenger, chat) };
  // What Paul changed from the app's Spend page (src/live-settings.ts) is laid over the deploy's own
  // settings before anything here reads them.
  applyLive(deps.store);
  // Paul's login vault and the card vault: the service's own singletons, unless a test injects ones with
  // a pinned clock, which is how the one-time links' expiry is exercised through the pages themselves.
  const loginVault = deps.vault ?? vault;
  const cardStore = deps.cardVault ?? cardVault;
  // The sign-in in front of the browser pages, shared with the orchestrator's /password command so the
  // link that command sends opens this service's own page.
  const signIn = deps.signIn ?? pageSignIn;
  // Live voice: the chief's and the jobs' messages pass a tap, so replies to the voice channel can be spoken (src/voice.ts).
  const tap = new VoiceTap();
  const tapped = tap.wrap(deps.messenger);
  // Jobs started through the Instinct bridge report to a sink address no channel delivers: their result
  // lines are written to the bridge transcript (src/instinct-chat.ts) and go nowhere else, Paul's chat included.
  let bridgeChat: BridgeChat | undefined;
  const channelMessenger = tapped;
  const withBridgeSink: typeof tapped = new Proxy(channelMessenger, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0] === BRIDGE_REPLY_TO) {
          if (prop === "send" && typeof args[1] === "string") bridgeChat?.record("job", args[1]);
          return Promise.resolve(undefined);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
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
  // The approval gate for creating an account for Paul on a site he named: the job only PREPARES a plan,
  // and his own "signup apply <id>" is what fills the form in and submits it. The submission is the
  // service's own browser, opened for that one site alone: it may act only on the plan's own domain (the
  // act list does not widen it, so an untrusted sign-up page cannot reach anywhere else with Paul's
  // cookies), it carries only that domain's saved cookies, and it has the same containment and egress
  // proxy as the workers' browser.
  const sitePolicy = new SitePolicy(deps.store, safeVaultDomains);
  const signup = new SignupGate(
    deps.store,
    new BrowserSignupSubmitter((domain) => new BrowseSession({ policy: { mayAct: (host) => hostMatches(host, domain) }, cookiesFor: domain, vault: loginVault })),
    loginVault,
    sitePolicy,
    deps.messenger,
  );
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
        : // And a job the chief gave the signup permit (Paul asked in chat): the one tool that prepares
          // a sign-up plan for his approval. The tool exists only with the permit; nothing here approves.
          job.permits?.includes("signup")
          ? { [SIGNUP_SERVER]: signupServer({ gate: signup, jobId: job.id, replyTo: job.replyTo }) }
          : undefined;
  // Purchases: a buying job asks Paul to approve the exact order; only his tap on the one-time page or his
  // own "buy <id>" lets the service press the final button (src/purchase.ts).
  const purchase = new PurchaseGate(deps.store, cardVault, deps.messenger);
  // One-time codes: when a sign-in asks for a code, the service reads it from Paul's own mailbox (the
  // Google connection above) or asks him in chat, and types it into the page itself (src/otp.ts). No
  // model, log, output or stored session ever holds a code, and Paul's own message goes once it is used.
  const otp = new OtpRelay({ messenger: deps.messenger, ...(deps.mailbox ? { mailbox: deps.mailbox } : { mailbox: new GmailCodeReader(googleApi) }) });
  // The private Google Docs reader (src/doc-reader.ts): Paul's own "read doc <id or link>" reads one
  // document he identified, on the same Google connection as the assistant, and stages it as a
  // private source for the one writing job he starts with its handle. The reader itself carries the
  // gates (app-level allowlist, the grant's own scopes, no redirects, bounded reads); nothing else
  // here can read a document.
  const docs = new DocReader({ auth: google, dataDir: config.dataDir, allow: config.googleDocs.allow, ...(deps.googleFetch ? { fetch: deps.googleFetch } : {}) });
  const jobs = new JobRunner(deps.store, withBridgeSink, deps.runner, toolsFor, { onOutput: deps.outputs ? (j) => deps.outputs?.publish(j) : undefined, purchase, otp, docs, ...(deps.canary ? { canary: deps.canary } : {}) });
  const scheduler = new Scheduler(deps.store, jobs);
  // One private uploads store for the whole service: chat attachments and the documents the bridge takes in
  // (src/documents.ts) land in the same place, under the same name rules and the same size limit.
  const uploads = new Uploads();
  const documents = new DocumentIngest(uploads, path.join(config.dataDir, "bridge-documents.jsonl"));
  const orchestrator = new Orchestrator(deps.store, tapped, jobs, scheduler, deps.runner, {}, uploads, google, deps.clock, deps.githubStatus ?? (() => githubStatusLine()), outbound, dns, signup, purchase, otp, docs);
  scheduler.boot();
  const bridgeBudget = new DeviceBudget(path.join(config.dataDir, "bridge-chat-budget.json"), () => config.bridgeChatBudgetUsd, "the bridge chat");
  orchestrator.bridgeBudget = bridgeBudget;
  bridgeChat = new BridgeChat({ ask: (text) => orchestrator.askAsInstinct(text), logFile: path.join(config.dataDir, "instinct-bridge.jsonl"), gate: () => bridgeBudget.gate() });
  const deviceRegistry = new DeviceRegistry(path.join(config.dataDir, "devices.json"));
  orchestrator.devices = deviceRegistry;
  const deviceBudget = new DeviceBudget(path.join(config.dataDir, "device-budget.json"), () => config.deviceTestBudgetUsd);
  orchestrator.deviceBudget = deviceBudget;
  const deviceChat = new BridgeChat({ ask: (text) => orchestrator.askAsDevice(text), logFile: path.join(config.dataDir, "device-chat.jsonl"), turnsPerDay: DEVICE_TURNS_PER_DAY, maxChars: DEVICE_TEXT_MAX_CHARS, gate: () => deviceBudget.gate() });
  // Schedules made before follow-ups existed pick up the current brief, on the same cron.
  upgradeEaSchedules(scheduler);
  // Cleo, the voice brain: hands spoken requests to the chief as if typed in the voice channel's chat.
  const voice = new VoiceBrain({ ask: (sender, address, text) => orchestrator.handle(sender, text, { replyTo: address }), tap });
  const holdWatcher = new HoldWatcher(deps.store, googleApi, deps.messenger);
  // The board's health block (src/health.ts): one heartbeat a minute and a light probe of everything
  // the workforce depends on, every five. Neither touches a job: the probes are one small read-only
  // request each, and the page only ever reads the last pass. Both are started by the entry point, so
  // tests never open a file or reach the network, and the timers are unref'd.
  const uptime = deps.uptime ?? new UptimeLog({ dir: config.dataDir });
  const probes = deps.probes ?? new HealthProbes(defaultProbes({ githubToken: () => githubAuth.token(), google: { connected: () => google.connected(), profile: () => googleApi.request("gmail", "GET", "profile") } }));
  // The start is recorded here rather than above, so a process that only builds the app (a test)
  // leaves no mark: a heartbeat file is written by a running service, and by nothing else.
  const startHealth = () => {
    uptime.boot();
    const stopBeat = uptime.start();
    const stopProbes = probes.start();
    return () => {
      stopBeat();
      stopProbes();
    };
  };

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

  app.get("/health", (_req, res) => res.json({ ok: true, jobs: deps.store.listJobs(3).length }));
  // What the deploy waits on (.github/workflows/deploy.yml): how many workers are running right now.
  // A count only, nothing about the jobs themselves.
  app.get("/busy", (_req, res) => res.json({ running: jobs.activeCount() }));

  // Paul's assistant (src/instinct-bridge.ts, src/instinct-chat.ts): an authenticated door for status and for
  // a labelled conversation with the chief. Off (404) unless INSTINCT_BRIDGE_TOKEN is set. It cannot reach
  // Paul's own chat, approve anything, grant a permit or start anything but read-only research or write jobs.
  app.use(INSTINCT_PATH, instinctRouter({ store: deps.store, token: config.instinctBridgeToken, documents, chat: bridgeChat, isAllowed: isOversightSender, chatEnabled: config.instinctBridgeChat, guilds: () => (discordRef.current ? inspectGuilds(discordRef.current.client as never, config.oversightSenderIds.find((x) => x.startsWith("dc:u:"))?.slice(5) ?? "") : Promise.resolve(undefined)), dmHistory: (limit, before) => { const owner = soleDiscordOwner(config.oversightSenderIds); return discordRef.current && owner ? readOwnerDm(discordRef.current.client as never, owner, limit, before) : Promise.resolve(undefined); }, threadHistory: (threadId, limit, before) => { const owner = soleDiscordOwner(config.oversightSenderIds); const c = discordRef.current?.client as never as { user?: { id: string } } | undefined; return discordRef.current && owner && c?.user?.id ? readJobThread(discordRef.current.client as never, { ownerUserId: owner, botUserId: c.user.id, guildId: config.bridgeThreadGuildId, parentId: config.bridgeThreadParentId }, threadId, limit, before) : Promise.resolve(undefined); }, commissionAllow: config.instinctBridgeCommissions, commissionLogFile: path.join(config.dataDir, "bridge-commissions.json"), commissionBlocked: () => (jobs.capReached() ? "The daily spend cap is reached, so no commission starts from here." : undefined), commissionBrief: (id) => { try { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "commissions", `${id}.md`), "utf8"); } catch { return undefined; } }, commission: (id, brief) => { const owner = soleDiscordOwner(config.oversightSenderIds); if (!owner) throw new Error("No single Discord owner is configured."); const j = jobs.startCommission(id, brief, owner, `Commission ${id}`); return { id: j.id, status: j.status }; }, retryLogFile: path.join(config.dataDir, "bridge-retries.json"), retryAllow: config.instinctBridgeRetryAllow, retry: (id) => jobs.retry(id), retryBlocked: () => (jobs.capReached() ? "The daily spend cap is reached, so no retry runs from here." : undefined) }));

  // Keep the raw body for signature verification. Registered after the bridge above on purpose: the bridge's
  // own routes carry their own body limits (a document can be a few megabytes) and check the bearer token
  // before a body is read, so the app-wide 100 KB parser must never see one of them.
  app.use(express.json({ verify: (req, _res, buf) => ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));

  // The home talk-button device (src/device.ts): paired by the owner typing /pair, text only, no tools. 404 unless DEVICE_ENABLED=true.
  app.use(DEVICE_PATH, deviceRouter({ registry: deviceRegistry, chat: deviceChat, enabled: config.deviceEnabled }));

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
    // A denial (or any Google-side error) is reported plainly and changes nothing: no token is
    // exchanged, nothing is stored, and the existing grant is untouched.
    if (typeof req.query.error === "string" && req.query.error) {
      const denied = req.query.error === "access_denied";
      return res.status(400).type("html").send(page("Not connected", denied ? "You declined the permissions, so nothing was changed. Ask for a new link in chat whenever you want to try again." : "Google did not grant access. Ask for a new link in chat if you want to try again."));
    }
    if (!state || !code) {
      return res.status(400).type("html").send(page("Not connected", "Google did not grant access. Ask for a new link in chat if you want to try again."));
    }
    try {
      const r = await google.completeConsent(state, code);
      const docs = r.scopes.includes(DOCS_READONLY_SCOPE);
      res.type("html").send(
        page(
          "Connected",
          docs
            ? "Your assistant can now read your mail and calendars, write drafts and place holds, and read the Google Doc you name for a job you choose. It can send an email or invite people only after you approve that exact item in chat. You can close this tab."
            : "Your assistant can now read your mail and calendars, write drafts and place holds. It can send an email or invite people only after you approve that exact item in chat. You can close this tab.",
        ),
      );
      deps.store.setSetting("eaReplyTo", r.replyTo);
      const made = ensureEaSchedules(scheduler, r.requestedBy, r.replyTo);
      const lines = made.map((m) => `${m.name} ${m.cron} (${m.id}${m.created ? "" : ", already set"})`).join("; ");
      const docsNote = docs ? " You also approved the optional read-only Google Docs permission: a document you name can now be read for one job at a time." : "";
      await deps.messenger
        .send(r.replyTo, `Google connected as ${r.account}: drafts plus holds; it sends mail or invites people only when you approve each one in chat.${docsNote} Weekday briefs scheduled: ${lines}. Tell me to move or cancel either.`)
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
    const p = token ? loginVault.peek(token) : undefined;
    if (!p) return res.status(400).type("html").send(expiredPage("This link has expired or was already used. Ask ClearOps for a new one in chat.", "Nothing was saved."));
    res.type("html").send(vaultForm(token, p.domain));
  });
  app.post(VAULT_ADD_PATH, express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    noStore(res);
    const b = (req.body ?? {}) as Record<string, string>;
    try {
      const r = loginVault.add(String(b.t ?? ""), { domain: String(b.domain ?? ""), username: String(b.username ?? ""), password: String(b.password ?? ""), totp: String(b.totp ?? ""), loginUrl: String(b.loginUrl ?? "") });
      const warn = termsWarning(r.summary.domain);
      res.type("html").send(
        htmlPage({
          title: "Saved",
          heading: "Login saved",
          icon: "tick",
          tone: "ok",
          chip: r.summary.domain,
          text: `The login for ${r.summary.domain} is in the vault. Agents can now sign in there and act on the site, except paying, sending, posting and deleting.`,
          foot: "You can close this tab.",
        }),
      );
      await deps.messenger
        .send(r.replyTo, `Vault: saved the login for ${r.summary.domain} (${r.summary.username}${r.summary.twoFactor ? ", with two-factor" : ""}). Agents can now sign in and act there; paying, sending, posting and deleting still need you.${warn ? ` Note: ${warn}.` : ""} Say remove the ${r.summary.domain} login to delete it.`)
        .catch(() => undefined);
    } catch (err) {
      const msg = err instanceof VaultError ? err.message : "That could not be saved. Check the site and the login page address, and ask ClearOps for a new link if this one has expired.";
      res.status(400).type("html").send(htmlPage({ title: "Not saved", heading: "Not saved", icon: "alert", tone: "alert", text: msg, foot: "Nothing was saved. You can close this tab." }));
    }
  });

  // The one-time add-a-card page: the card is stored encrypted and never shown to a model or in chat.
  app.get(VAULT_CARD_PATH, (req, res) => {
    noStore(res);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!cardStore.valid(token)) return res.status(410).type("html").send(expiredPage("This link has expired or was already used. Ask ClearOps for a new one in chat.", "Nothing was saved."));
    res.type("html").send(cardForm(token));
  });
  app.post(VAULT_CARD_PATH, express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    noStore(res);
    const b = (req.body ?? {}) as Record<string, string>;
    try {
      const r = cardStore.add(String(b.t ?? ""), { number: String(b.number ?? ""), expiry: String(b.expiry ?? ""), cvc: String(b.cvc ?? ""), name: String(b.name ?? ""), postcode: String(b.postcode ?? "") });
      res.type("html").send(
        htmlPage({
          title: "Saved",
          heading: "Card saved",
          icon: "tick",
          tone: "ok",
          chip: `Card ending ${r.summary.last4}`,
          text: `The card ending ${r.summary.last4} is in the vault. It is used only for a purchase you approve, item by item.`,
          foot: "You can close this tab.",
        }),
      );
      await deps.messenger.send(r.replyTo, `Vault: saved the card ending ${r.summary.last4} (expires ${r.summary.expiry}). It is entered only on a checkout you approve, never shown to an agent. Say remove the card to delete it.`).catch(() => undefined);
    } catch (err) {
      const msg = err instanceof VaultError ? err.message : "That could not be saved. Ask ClearOps for a new link and try again.";
      res.status(400).type("html").send(htmlPage({ title: "Not saved", heading: "Not saved", icon: "alert", tone: "alert", text: msg, foot: "Nothing was saved. You can close this tab." }));
    }
  });

  // The approval page for one purchase: the picture, the shop, the items and the total, Approve or Decline.
  const purchaseHeaders = (res: express.Response) => {
    noStore(res);
    res.set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  };
  app.get(`${PURCHASE_PATH}/:id`, (req, res) => {
    purchaseHeaders(res);
    const id = String(req.params.id ?? "");
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const a = deps.store.getPurchase(id);
    if (!a || !purchase.tokenValid(id, token)) return res.status(410).type("html").send(page("Link expired", "This approval link has expired or was already used. Nothing was bought from it."));
    res.type("html").send(purchasePage(a, token, purchase.screenshot(id)));
  });
  app.post(`${PURCHASE_PATH}/:id`, express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    purchaseHeaders(res);
    const id = String(req.params.id ?? "");
    const b = (req.body ?? {}) as Record<string, string>;
    const verb = b.decision === "approve" ? "approve" : b.decision === "decline" ? "decline" : undefined;
    const said = verb ? purchase.decideWithToken(id, String(b.t ?? ""), verb) : undefined;
    if (!said) return res.status(410).type("html").send(page("Link expired", "This approval link has expired or was already used. Nothing was bought from it."));
    res.type("html").send(page(verb === "approve" ? "Approved" : "Declined", escapeHtml(said)));
  });

  /**
   * The sign-in that stands in front of the browser pages, and the one-time page that sets the
   * password. No model is involved anywhere here: the password is typed on Paul's own phone, hashed by
   * the service and compared in constant time, and never appears in chat, in a job brief, in a log
   * line, in an error message or on a page. `GET /password?t=<token>` opens the form from the link the
   * chief sends in chat when Paul sends /password; the link works once and expires like the vault's.
   * No password is ever echoed, and the only thing a request here writes is the session cookie.
   */
  const signInHeaders = (res: express.Response) => {
    noStore(res);
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  };
  /**
   * The browser pages the sign-in covers: the jobs board and the reports view, each at its own path,
   * taken from the module that serves it so the two can never drift apart. The gate is one place over
   * the path, so both the index and one item, and the board's JSON, are behind it alike.
   * Nothing else the service serves is behind it: no webhook, no callback and no health check.
   */
  const GATED_PATHS = [REPORTS_PATH, BOARD_PATH];
  /**
   * Whether a request path is one of those pages, matched the way Express matches the routes it guards:
   * case-insensitively (`case sensitive routing` is off, so `app.get(BOARD_PATH, ...)` also answers
   * `/Jobs` and `/JOBS`) and by whole segment, so `/jobshere` is not swept in. Comparing case-sensitively
   * here would let `GET /Jobs?t=<token>` serve the board with no session at all, and the token is in the
   * link, which is the whole reason the password exists.
   */
  const under = (path: string, base: string) => {
    const p = path.toLowerCase();
    const b = base.toLowerCase();
    return p === b || p.startsWith(`${b}/`);
  };
  /**
   * Where a signed-in visitor may be sent: one of those pages, never anywhere else. A path that leaves
   * the service, doubles a slash, climbs with `..` or carries anything but the query's own characters
   * is ignored, so the sign-in page cannot be used to send him somewhere else. Percent-encoding is
   * checked as well: a browser resolves `%2e%2e` as a dot segment, so the decoded path is tested again
   * (see below) rather than trusting the literal `..` check alone.
   */
  const SAFE_NEXT = /^\/[A-Za-z0-9._~/?&=%-]*$/;
  const safeNext = (value: unknown): string | undefined => {
    if (typeof value !== "string" || value.length > 300 || !SAFE_NEXT.test(value) || value.includes("//") || value.includes("..")) return undefined;
    const path = value.split("?")[0];
    if (!GATED_PATHS.some((p) => under(path, p))) return undefined;
    // The encoded form of a climb (`/jobs/%2e%2e/%2e%2e/evil`) passes the literal `..` check above but
    // resolves in the browser to `/evil`, so decode (best effort) and require the decoded path to be a
    // plain gated path too: no climb, no doubled slash, no backslash and no whitespace.
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    if (decoded.includes("..") || decoded.includes("//") || /[\\\s]/.test(decoded)) return undefined;
    return GATED_PATHS.some((p) => under(decoded, p)) ? value : undefined;
  };
  /** Where a signed-in visit with nowhere to go lands. */
  const landing = () => `${BOARD_PATH}?t=${boardToken(deps.store)}`;
  /**
   * The gate itself: a visit without a session is sent to the sign-in page, carrying the address it
   * asked for, so a bookmarked link still opens the page he wanted once he has signed in. A wrong or
   * missing token is refused afterwards exactly as it was before.
   *
   * It is one middleware over the gated paths, registered before any of their routes, rather than a
   * call at the top of each handler: a route added under those paths later cannot forget it, and the
   * rule is the same for the whole page, index, one item and the board's JSON alike.
   */
  const signedIn = (req: express.Request, res: express.Response): boolean => {
    if (signIn.sessionValid(deps.store, req.headers.cookie)) return true;
    res.redirect(303, `${SIGN_IN_PATH}?next=${encodeURIComponent(req.originalUrl)}`);
    return false;
  };
  app.use((req, res, next) => {
    if (!GATED_PATHS.some((p) => under(req.path, p))) return next();
    if (!signedIn(req, res)) return;
    next();
  });
  app.get(SIGN_IN_PATH, (req, res) => {
    signInHeaders(res);
    const next = safeNext(req.query.next);
    if (signIn.sessionValid(deps.store, req.headers.cookie)) return res.redirect(303, next ?? landing());
    if (!signIn.hasPassword(deps.store)) return res.type("html").send(noPasswordPage());
    res.type("html").send(signInPage(next ? { next } : {}));
  });
  app.post(SIGN_IN_PATH, express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    signInHeaders(res);
    const b = (req.body ?? {}) as Record<string, string>;
    const next = safeNext(b.next);
    // The address attempts are counted against. The app does not trust the proxy in front of it
    // (`trust proxy` is off), so this is the machine's own view of the caller and a forged
    // X-Forwarded-For cannot dodge the limit or pin it on someone else. For a service with one user
    // that means the limit is effectively per machine, which is exactly what is wanted here.
    const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!signIn.hasPassword(deps.store)) return res.status(400).type("html").send(noPasswordPage());
    // A short cool-off and a growing delay per address, never a lock-out: the /password link in chat
    // always gets him back in, and a right password after the cool-off clears the record.
    const limit = signIn.limit(address);
    if (!limit.allowed) {
      res.set("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).type("html").send(signInPage({ ...(next ? { next } : {}), error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterMs / 1000)} seconds.` }));
    }
    if (!signIn.checkPassword(deps.store, String(b.password ?? ""))) {
      const { delayMs } = signIn.failed(address);
      await signIn.pause(delayMs);
      return res.status(401).type("html").send(signInPage({ ...(next ? { next } : {}), error: "That is not the password. Try again." }));
    }
    signIn.succeeded(address);
    const cookie = signIn.sessionCookie(deps.store);
    if (cookie) res.set("Set-Cookie", cookie);
    res.redirect(303, next ?? landing());
  });
  app.get(SIGN_OUT_PATH, (req, res) => {
    signInHeaders(res);
    // Only a request that actually carried this service's session cookie clears it, so a link or an
    // image on another site (which sends no cookie under SameSite=Strict) cannot sign him out.
    if (signIn.sessionValid(deps.store, req.headers.cookie)) res.set("Set-Cookie", signIn.clearCookie());
    res.redirect(303, SIGN_IN_PATH);
  });
  // The one-time page that sets a new password: the password twice, POST only, nothing echoed back.
  app.get(PASSWORD_PATH, (req, res) => {
    signInHeaders(res);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!token || !signIn.peek(token)) return res.status(410).type("html").send(expiredPage("This link has expired or was already used. Send /password in chat for a new one.", "Nothing was changed."));
    res.type("html").send(passwordPage(token));
  });
  app.post(PASSWORD_PATH, express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    signInHeaders(res);
    const b = (req.body ?? {}) as Record<string, string>;
    const token = String(b.t ?? "");
    try {
      const r = signIn.setFromLink(deps.store, token, String(b.password ?? ""), String(b.confirm ?? ""));
      // Setting a new password ends every session on every device at once: the cookie is signed with a
      // key folded together with the password's hash (src/sign-in.ts), so nothing has to be swept.
      res.type("html").send(passwordSavedPage());
      await deps.messenger
        .send(r.replyTo, "Password saved. The reports and the jobs board are behind it now, and every device that was signed in with the old password has been signed out.")
        .catch(() => undefined);
    } catch (err) {
      const msg = err instanceof SignInError ? err.message : "That could not be saved. Send /password in chat for a new link.";
      if (!signIn.peek(token)) return res.status(410).type("html").send(expiredPage("This link has expired or was already used. Send /password in chat for a new one.", "Nothing was changed."));
      res.status(400).type("html").send(passwordPage(token, { error: msg }));
    }
  });

  /**
   * The jobs board: one read-only page Paul bookmarks and opens on his phone instead of typing /jobs.
   * GET only, behind a long-lived token the service minted itself (/board prints the link in chat) and
   * behind the sign-in above, so the token on its own is not enough. It changes nothing and shows no
   * spend, brief or output; with ?format=json the same data is JSON.
   */
  const boardHeaders = (res: express.Response) => {
    noStore(res);
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  };
  app.get(BOARD_PATH, (req, res) => {
    boardHeaders(res);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!boardTokenValid(deps.store, token)) return res.status(404).type("html").send(refusedPage());
    // The health block and the per-kind figures are read from what the service already knows: the
    // heartbeats this process writes, the last probe pass, the queue's own counts and the runner's
    // own view of whether a job's worker is alive. Nothing here waits for a request or a probe.
    const board = boardData({
      store: deps.store,
      queue: jobs,
      schedules: scheduler.upcoming(),
      uptime,
      probes,
      activeWorkers: () => jobs.activeCount(),
      liveness: (id) => jobs.liveness(id),
    });
    if (req.query.format === "json") return res.type("application/json").send(JSON.stringify(board));
    res.type("html").send(renderBoard(board, token));
  });

  /**
   * The reports view: every saved job output as a page Paul can read on his phone, at a stable
   * address. Two GET routes behind the same long-lived token /reports prints in chat, and nothing
   * else: no model call, no form and no write of any kind. Which outputs exist is decided by the same
   * rules as the copy in the private outputs repository (src/output-folders.ts), so an assistant, CV
   * or upload-derived output is not here either. The Markdown is rendered by src/reports.ts, which
   * escapes everything, and a saved .html file beside an output is served under a policy that allows
   * no script at all.
   */
  const reportHeaders = (res: express.Response, csp: string) => {
    noStore(res);
    res.set("Content-Security-Policy", csp);
    res.set("X-Content-Type-Options", "nosniff");
  };
  app.get(REPORTS_PATH, (req, res) => {
    reportHeaders(res, PAGE_CSP);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!reportsTokenValid(deps.store, token)) return res.status(404).type("html").send(reportsRefusedPage());
    res.type("html").send(renderReportsIndex(reportEntries(deps.store), token));
  });
  app.get(`${REPORTS_PATH}/:id`, (req, res) => {
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const report = reportsTokenValid(deps.store, token) ? reportFor(deps.store, String(req.params.id ?? "")) : undefined;
    if (!report) {
      reportHeaders(res, PAGE_CSP);
      return res.status(404).type("html").send(reportsRefusedPage());
    }
    if (report.htmlPath) {
      // A self-contained page the worker saved beside the Markdown, served as-is (the sandbox and
      // default-src 'none' mean anything script-shaped in it simply does not run).
      reportHeaders(res, FILE_CSP);
      let html: string;
      try {
        html = fs.readFileSync(report.htmlPath, "utf8");
      } catch {
        reportHeaders(res, PAGE_CSP);
        return res.status(404).type("html").send(reportsRefusedPage());
      }
      return res.type("html").send(html);
    }
    reportHeaders(res, PAGE_CSP);
    res.type("html").send(renderReportPage(report.entry, report.markdown ?? "", token));
  });

  /**
   * The web app (docs/APP.md): the interface Paul asked for on 18 Nov 2026 in place of Discord. This
   * first slice is read-only: the board in three views, the whole job history, and one job with its
   * trace and what it cost. It sits behind its own gate, GitHub's sign-in for one account
   * (src/app-auth.ts), and everything under /app is closed unless it is on the short open list below:
   * the sign-in page, the round trip to GitHub and the static files, which hold no data. A route added
   * under /app later is therefore behind the gate without anyone remembering to put it there.
   *
   * Every route that reads anything is a GET that writes nothing. The one POST ends the session.
   */
  const appAuthz = deps.appAuth ?? serviceAppAuth;
  const APP_OPEN = [APP_SIGN_IN_PATH, `${APP_PATH}/auth`, APP_ASSETS_PATH];
  const appHeaders = (res: express.Response) => {
    noStore(res);
    res.set("Content-Security-Policy", APP_CSP);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
  };
  // What GitHub says of each job's pull request (src/pr-state.ts): read-only, asked in the background
  // with the credential the service already uses for that repository, and never waited for.
  const prStates = deps.prStates ?? new PrStates({ token: async (slug) => repoTokens.get({ slug }) ?? (await githubAuth.token().catch(() => undefined)) });
  // A job's pull request, shown in the app and merged only on Paul's own tap (src/app-pulls.ts): only in
  // the managed repository the job works on, with the credential the service already holds for it.
  const pulls =
    deps.pulls ??
    new AppPulls({
      repos: () => repoRegistry.list().flatMap((r) => (r.slug ? [{ alias: r.alias, slug: r.slug, name: repoLabel(r.alias) }] : [])),
      repoOf: (job) => repoRegistry.find(job.target ?? "product")?.alias,
      token: async (repo) => (await repoCredential(repo).catch(() => undefined))?.token || undefined,
      selfAlias: "self",
    });
  const appSource = (): AppSource => ({ store: deps.store, queue: jobs, uptime, probes, activeWorkers: () => jobs.activeCount(), gates: { outbound, dns, signup, purchase }, prState: (url) => prStates.info(url), jobPull: (job) => pulls.forJob(job), openPulls: () => pulls.open(), threads: () => chat.threads() });
  /**
   * Whether a request that changes something came from this site's own script: a JSON body, and where
   * the browser says where the request came from, from here. A form, or a page on another site, fails
   * this even with Paul's cookie.
   */
  const ownScript = (req: express.Request): boolean => {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    return !!req.is("application/json") && (origin === undefined || origin === new URL(config.publicUrl).origin) && (site === undefined || site === "same-origin");
  };
  /** What an action in the app did, said in the app's conversation and, where it began elsewhere, there too. */
  const tell = (text: string, alsoTo?: string) => {
    if (!text) return;
    void chat.send(WEB_CONVERSATION, text);
    if (alsoTo && !alsoTo.startsWith(WEB_PREFIX)) void deps.messenger.send(alsoTo, text).catch(() => undefined);
  };
  app.use((req, res, next) => {
    if (!under(req.path, APP_PATH) || APP_OPEN.some((p) => under(req.path, p))) return next();
    if (appAuthz.sessionValid(deps.store, req.headers.cookie)) return next();
    appHeaders(res);
    if (under(req.path, `${APP_PATH}/api`)) return void res.status(401).json({ error: "signed out" });
    res.redirect(303, APP_SIGN_IN_PATH);
  });
  app.get(`${APP_ASSETS_PATH}/:name`, (req, res) => {
    const asset = appAsset(String(req.params.name ?? ""));
    res.set("X-Content-Type-Options", "nosniff");
    if (!asset) return void res.status(404).type("text/plain").send("Not found");
    res.set("Cache-Control", "public, max-age=300");
    res.type(asset.type).send(asset.body);
  });
  const refusalOf = (value: unknown): string | undefined => (typeof value === "string" && Object.hasOwn(REFUSAL_TEXT, value) ? REFUSAL_TEXT[value as AppAuthRefusal] : undefined);
  app.get(APP_SIGN_IN_PATH, (req, res) => {
    appHeaders(res);
    if (appAuthz.sessionValid(deps.store, req.headers.cookie)) return res.redirect(303, APP_PATH);
    const error = refusalOf(req.query.refused);
    res.type("html").send(appSignInPage({ enabled: appAuthz.enabled(), login: appAuthz.allowedLogin(), ...(error ? { error } : {}) }));
  });
  app.get(APP_AUTH_START_PATH, (_req, res) => {
    appHeaders(res);
    const started = appAuthz.start();
    if (!started) return res.redirect(303, `${APP_SIGN_IN_PATH}?refused=off`);
    res.set("Set-Cookie", started.cookie);
    res.redirect(303, started.url);
  });
  app.get(APP_AUTH_CALLBACK_PATH, async (req, res) => {
    appHeaders(res);
    const result = await appAuthz.finish(deps.store, { code: req.query.code, state: req.query.state, cookieHeader: req.headers.cookie });
    if ("refused" in result) {
      res.set("Set-Cookie", appAuthz.clearStateCookie());
      return res.redirect(303, `${APP_SIGN_IN_PATH}?refused=${result.refused}`);
    }
    res.set("Set-Cookie", [appAuthz.clearStateCookie(), result.cookie]);
    res.redirect(303, APP_PATH);
  });
  app.post(APP_SIGN_OUT_PATH, (_req, res) => {
    // Behind the gate, so only a request that carried this service's own session reaches here, and a
    // form on another site (which sends no SameSite=Lax cookie on a POST) cannot sign him out.
    appHeaders(res);
    res.set("Set-Cookie", appAuthz.clearCookie());
    res.redirect(303, APP_SIGN_IN_PATH);
  });
  app.get(APP_PATH, (_req, res) => {
    appHeaders(res);
    res.type("html").send(appShell());
  });
  app.get(`${APP_PATH}/api/board`, (_req, res) => {
    appHeaders(res);
    res.json(appBoard(appSource()));
  });
  app.get(`${APP_PATH}/api/history`, (req, res) => {
    appHeaders(res);
    res.json(appHistory(appSource(), typeof req.query.before === "string" ? req.query.before : undefined));
  });
  /**
   * Which of the app's conversations a request means: the main one when it names none, or the thread of
   * a job that exists or of a pull request in a repository ClearOps manages ("job:<id>",
   * "pull:<alias>:<number>"). Anything else is no conversation at all.
   */
  const appThread = (raw: unknown): string | undefined => {
    if (raw === undefined || raw === "") return WEB_CONVERSATION;
    if (typeof raw !== "string") return undefined;
    const job = /^job:([A-Za-z0-9_-]{1,64})$/.exec(raw);
    if (job) return deps.store.getJob(job[1]!) ? webThread({ job: job[1]! }) : undefined;
    const pull = /^pull:([A-Za-z0-9._-]{1,64}):([1-9]\d{0,8})$/.exec(raw);
    if (pull) return repoRegistry.list().some((r) => r.alias === pull[1] && r.slug) ? webThread({ pull: { repo: pull[1]!, number: Number(pull[2]) } }) : undefined;
    return undefined;
  };
  app.get(`${APP_PATH}/api/chat`, (req, res) => {
    appHeaders(res);
    const where = appThread(req.query.thread);
    if (!where) return void res.status(404).json({ error: "There is no such thread." });
    res.json(appChat(appSource(), chat, where));
  });
  /**
   * The one route under /app that does anything: Paul's message to the chief. It is behind the gate
   * above like everything else, and three more things hold. It must be this site's own script asking
   * (a JSON body, and where the browser says where the request came from, from here), so another site
   * cannot post as him even with his cookie. An approval word is refused before it is kept, and a
   * one-time code is never written down at all. And the message goes to the orchestrator as the app's
   * own sender, which no allowlist holds, so every approval gate refuses it for itself as well.
   */
  app.post(`${APP_PATH}/api/chat`, (req, res) => {
    appHeaders(res);
    if (!ownScript(req)) return void res.status(403).json({ error: "refused" });
    const text = typeof (req.body as { text?: unknown } | undefined)?.text === "string" ? (req.body as { text: string }).text.trim() : "";
    if (!text) return void res.status(400).json({ error: "empty" });
    if (text.length > WEB_TEXT_MAX) return void res.status(413).json({ error: "too long" });
    // The main conversation, or the thread of a job or a pull request: only ever one of the app's own.
    const where = appThread((req.body as { thread?: unknown } | undefined)?.thread);
    if (!where) return void res.status(404).json({ error: "There is no such thread." });
    const refused = webRefusal(text);
    chat.inbound(parseCodeCommand(text) ? WEB_CODE_PLACEHOLDER : text, where);
    if (refused) void chat.send(where, refused);
    else void orchestrator.handle(WEB_SENDER, text, { replyTo: where, web: true });
    res.status(202).json({ ok: true });
  });
  /**
   * Paul's decision on something waiting for him, from the app's own button (slice 3; his call on 18 Nov
   * 2026: one tap, for everything). It is the second way a gate takes a decision, and it is held to the
   * same things as the typed word. It is behind the gate above and taken from this site's own script
   * only. It names one item that is waiting now. It must carry the fingerprint of the exact text the
   * service showed for that item, so a tap on a stale card decides nothing. Only then is a single-use
   * grant minted (src/app-approver.ts) and handed to that item's own gate, which runs every check it
   * runs for a typed approval: expiry, caps, and that what was shown is still what is true.
   */
  app.post(`${APP_PATH}/api/approvals`, async (req, res) => {
    appHeaders(res);
    if (!ownScript(req)) return void res.status(403).json({ error: "refused" });
    const b = (req.body ?? {}) as { what?: unknown; id?: unknown; verb?: unknown; seen?: unknown };
    const verb = b.verb === "approve" || b.verb === "decline" ? b.verb : undefined;
    const item = appWaiting(deps.store, appSource().gates, Date.now()).find((w) => w.what === b.what && w.id === b.id);
    if (!verb || !item || !item.seen) return void res.status(404).json({ error: "That is no longer waiting." });
    const seen = typeof b.seen === "string" ? b.seen : "";
    if (seen.length !== item.seen.length || !timingSafeEqual(Buffer.from(seen), Buffer.from(item.seen))) return void res.status(409).json({ error: "This changed since it was shown. Look at it again before deciding." });
    const grant = mintAppApproval();
    let text: string;
    let replyTo: string | undefined;
    try {
      if (item.what === "email") {
        replyTo = deps.store.getOutbound(item.id)?.replyTo;
        text = verb === "approve" ? await outbound.approve(item.id, grant) : outbound.cancel(item.id, grant);
      } else if (item.what === "dns") {
        replyTo = deps.store.getDns(item.id)?.replyTo;
        text = verb === "approve" ? await dns.approve(item.id, grant) : dns.cancel(item.id, grant);
      } else if (item.what === "signup") {
        replyTo = deps.store.getSignup(item.id)?.replyTo;
        text = verb === "approve" ? await signup.approve(item.id, grant) : signup.cancel(item.id, grant);
      } else {
        replyTo = deps.store.getPurchase(item.id)?.replyTo;
        text = purchase.decideFromApp(item.id, verb, grant);
      }
    } catch (err) {
      text = `Nothing was done: ${err instanceof Error ? err.message : "it could not be decided just now"}`;
    }
    tell(text, replyTo);
    res.json({ ok: true, text });
  });
  /**
   * What Paul may do to a job from the app: say whether it did what he asked, stop it, move it to the
   * front of its queue, or run it again on one of the models a job may be pinned to. Each is the job runner's own operation, the one the
   * chief's tools call. A job run again keeps its brief, title and pull request and nothing else: no
   * permit is ever carried over or granted here.
   */
  app.post(`${APP_PATH}/api/jobs/:id/action`, async (req, res) => {
    appHeaders(res);
    if (!ownScript(req)) return void res.status(403).json({ error: "refused" });
    const id = String(req.params.id ?? "");
    const job = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? deps.store.getJob(id) : undefined;
    if (!job) return void res.status(404).json({ error: "There is no job with that id." });
    const b = (req.body ?? {}) as { action?: unknown; model?: unknown };
    try {
      // His own answer to "did this do what I asked?": kept on the job, and nothing else follows from it.
      if (b.action === "verdict") {
        if (job.status !== "done" && job.status !== "failed") return void res.status(409).json({ error: "It has not finished yet." });
        const met = (b as { met?: unknown }).met;
        if (met !== true && met !== false && met !== null) return void res.status(400).json({ error: "refused" });
        deps.store.updateJob(id, { verdict: met === null ? undefined : { met, at: new Date().toISOString() } });
        return void res.json({ ok: true, text: met === null ? "Cleared your answer." : met ? "Marked as done." : "Marked as not done." });
      }
      if (b.action === "cancel") {
        const text = await jobs.cancel(id);
        tell(text, job.replyTo);
        return void res.json({ ok: true, text });
      }
      if (b.action === "front") {
        const text = jobs.moveToFront(id);
        tell(text, job.replyTo);
        return void res.json({ ok: true, text });
      }
      if (b.action === "rerun") {
        const model = typeof b.model === "string" ? b.model : "";
        const refused = rerunRefusal(job) ?? perJobModelError(model);
        if (refused) return void res.status(409).json({ error: refused });
        if (job.status === "running" || job.status === "queued") await jobs.cancel(id);
        const again = jobs.start(job.kind, job.brief, WEB_SENDER, job.target, WEB_CONVERSATION, { model, ...(job.title ? { title: job.title } : {}), ...(job.pr ? { pr: job.pr } : {}), ...(job.depth ? { depth: job.depth } : {}), ...(job.doneWhen ? { doneWhen: job.doneWhen } : {}) });
        const text = `Running ${jobTitle(job)} again on ${model} as job ${again.id}.`;
        tell(text, job.replyTo);
        return void res.json({ ok: true, text, jobId: again.id });
      }
    } catch (err) {
      return void res.status(409).json({ error: err instanceof Error ? err.message : "That could not be done just now." });
    }
    res.status(400).json({ error: "refused" });
  });
  // A pull request as GitHub holds it now: read-only, and only in a repository ClearOps manages, named
  // by its alias and the pull request's own number.
  app.get(`${APP_PATH}/api/pulls/:repo/:number`, async (req, res) => {
    appHeaders(res);
    try {
      res.json(await pulls.view(String(req.params.repo ?? ""), String(req.params.number ?? "")));
    } catch (err) {
      res.status(err instanceof PullError ? err.status : 502).json({ error: err instanceof PullError ? err.message : "GitHub could not be asked just now." });
    }
  });
  // Paul's own tap on Merge, carrying the commit he was shown. The one place the service merges anything.
  app.post(`${APP_PATH}/api/pulls/:repo/:number/merge`, async (req, res) => {
    appHeaders(res);
    if (!ownScript(req)) return void res.status(403).json({ error: "refused" });
    try {
      const done = await pulls.merge(String(req.params.repo ?? ""), String(req.params.number ?? ""), (req.body as { sha?: unknown } | undefined)?.sha);
      prStates.forget(done.url);
      tell(done.text);
      res.json({ ok: true, text: done.text });
    } catch (err) {
      res.status(err instanceof PullError ? err.status : 502).json({ error: err instanceof PullError ? err.message : "That could not be done just now." });
    }
  });
  // The Spend page: today's figure, where the store can say it went, and the settings Paul may change.
  app.get(`${APP_PATH}/api/spend`, (_req, res) => {
    appHeaders(res);
    res.json(appSpend(appSource()));
  });
  // One setting changed from the Spend page (src/live-settings.ts): a cap or a role's model, or either
  // put back to the deploy's own. Paul's own tap, from this site's own script; nothing else writes these.
  app.post(`${APP_PATH}/api/settings`, (req, res) => {
    appHeaders(res);
    if (!ownScript(req)) return void res.status(403).json({ error: "refused" });
    const body = (req.body ?? {}) as { key?: unknown; value?: unknown };
    try {
      const text = setLive(deps.store, body.key, body.value);
      tell(text);
      res.json({ ok: true, text });
    } catch (err) {
      res.status(400).json({ error: err instanceof LiveSettingError ? err.message : "That could not be changed." });
    }
  });
  app.get(`${APP_PATH}/api/jobs/:id`, (req, res) => {
    appHeaders(res);
    const detail = appJob(appSource(), String(req.params.id ?? ""));
    if (!detail) return void res.status(404).json({ error: "no such job" });
    res.json(detail);
  });

  return { app, orchestrator, jobs, scheduler, google, holdWatcher, startEaTimers, startHealth, voice };
}

// Entry point when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  assertProductionConfig();
  console.log(modelLine());
  console.log(spendLine());
  // How much engineering work runs at once, in the log, so the machine's limit is visible rather than discovered.
  console.log(engineerSlotsLine());
  const store = new Store(config.dataDir);
  repoRegistry.load(store);
  // The sites Paul unlocked himself with "act as me on <site>" (src/site-policy.ts).
  registerActAsMe(() => store.settings().actAsMe ?? []);
  // With the GitHub App configured, keep its installation token fresh for git and gh during long jobs.
  startTokenRefresher();
  const repoProblems = await bootstrapRepos();
  const github = await githubProblemMessage().catch(() => ({ message: undefined, line: "GitHub: health check failed." }));
  console.log(github.line);
  // Which credential reaches each managed repository, one plain line: the variable's name, never a token.
  console.log(repoCredentialLine());

  // One messenger per channel, routed by address prefix; one orchestrator behind all of them.
  const routes: Array<{ prefix: string; messenger: Messenger }> = [];
  let discord: DiscordListener | undefined;
  if (config.channels.includes("telegram")) routes.push({ prefix: "tg:", messenger: new TelegramMessenger() });
  if (config.channels.includes("discord")) {
    discord = new DiscordListener((from, text, ctx) => orchestrator.handle(from, text, ctx), isAllowed);
    discordRef.current = discord;
    routes.push({ prefix: "dc:", messenger: discord.messenger() });
  }
  const messenger = new RouterMessenger(routes, config.channels.includes("whatsapp") ? new CloudApiMessenger() : undefined);

  const notifyPaul = (text: string) => {
    const to = config.allowedTelegramIds[0] ?? config.allowedDiscordIds[0] ?? config.allowedNumbers[0];
    if (to) void messenger.send(to, text).catch(() => undefined);
  };
  const outputs = new OutputsPublisher(store, { onProblem: notifyPaul });
  // One-off (17 Nov 2026): the completed offboard Doubleshift draft, imported as a truthful job record
  // carrying its own status, timestamps, model and settled provider cost, with its preserved artifact
  // as the saved output (src/offboard-import.ts). Idempotent: on a later boot the record is already in
  // the store and nothing is written, messaged or published again.
  const imported = importOffboardRun(store);
  if (imported) {
    console.log(imported.created ? `imported offboard run "${OFFBOARD_RUN_ID}" as job ${imported.job.id}` : `offboard run "${OFFBOARD_RUN_ID}" already imported as job ${imported.job.id}`);
    if (imported.created) outputs.publish(imported.job);
  }
  const { app, orchestrator, jobs, startEaTimers, startHealth, voice } = buildApp({ messenger, runner: sdkRunner, store, outputs, canary: defaultCanary() });
  // Fail closed before listening: the chief's ops server must advertise the shape its namespace is
  // pinned with (src/ops-schema.ts). A schema change that forgot its version bump stops the boot here,
  // so the deploy's health check keeps the previous version serving rather than resumed chief sessions
  // being advertised a stale schema.
  await orchestrator.opsSchemaGuard;
  startEaTimers();
  // The board's own timers: one heartbeat a minute and the dependency checks every five. Both are
  // read-only and unref'd, so neither holds the process open nor waits on anything.
  startHealth();
  app.listen(config.port, () => console.log(`clear-ops listening on :${config.port} (${config.channels.join(", ")})`));

  if (config.channels.includes("telegram")) {
    void new TelegramPoller((from, text, ctx) => orchestrator.handle(from, text, ctx), messenger, isAllowed).start();
  }
  // Live voice: Cleo joins Paul in a Discord voice channel. Must be wired before the gateway connects.
  if (discord && voiceEnabled()) {
    new VoiceBridge(discord.client, voice, { isAllowed, notify: (to, text) => messenger.send(to, text) }).start();
    console.log("voice: on");
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
