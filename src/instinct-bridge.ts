/**
 * Instinct bridge: an authenticated door for Paul's assistant (Instinct) to the workforce, so Paul does
 * not have to relay screenshots between the two. The conversation half is src/instinct-chat.ts.
 *
 * Off unless INSTINCT_BRIDGE_TOKEN is set; when it is unset every route answers 404 as if it did not
 * exist. Every route needs `Authorization: Bearer <token>`, compared in constant time, and wrong
 * attempts are slowed per process.
 *
 *  - GET  /api/instinct/status       what the board already shows: queue hold and the latest jobs (no briefs,
 *    outputs, paths, spend or secrets).
 *  - GET  /api/instinct/context[/:id] read-only, no model: jobs Paul started, his captured message, capped report.
 *  - POST /api/instinct/chat (404 unless BRIDGE_CHAT_ENABLED=true; paid model turn)         {"text"} to the chief as Paul's assistant, answered 202 with an id.
 *  - GET  /api/instinct/chat/:id     {status, reply} for that message.
 *  - GET  /api/instinct/jobs/:id     status, and the report once done, of a job this bridge started only.
 *  - GET  /api/instinct/transcript   what was said each way and the result lines of the bridge's jobs.
 *  - GET  /api/instinct/context/:id/thread  (404 unless bound) read-only: one job thread of the configured guild and parent channel, Paul's and this bot's own messages only; other authors are counted, never read out.
 *  - GET  /api/instinct/discord/guilds  (404 unless a gateway is connected) read-only: guild and channel names, the
 *    bot's Manage Channels permission, whether the owner is guild owner or administrator. No messages, no token.
 *  - GET  /api/instinct/dm-history?limit=1..100&before=<message id>  (404 unless a gateway is connected) read-only, no
 *    model: the bot's own DM channel with the owner, oldest first, text only, secrets masked, long messages cut.
 *    The channel is fixed by configuration; nothing in the request can pick another one.
 *  - POST /api/instinct/retry        {"id"} rerun ONE failed job, only if its id is in BRIDGE_RETRY_ALLOW (empty by
 *    default, so the route is a 404), only while the daily spend cap is not reached, at most BRIDGE_RETRY_PER_DAY
 *    a day, counted in a log that is written before the retry runs; an unreadable or unwritable log refuses the
 *    retry instead of running it. It never lifts the queue hold and never runs resume; every other queued job stays where it is.
 *
 * What it cannot do, by construction: reach Paul's own conversation, parse an approval word, start any
 * job but a read-only research or write job, grant a permit, schedule, cancel, resume, retry a job that is not
 * on the owner's allowlist, read a secret, an
 * upload or the data directory, or act as Paul anywhere.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Request, Response, Router as ExpressRouter } from "express";
import { Router } from "express";
import { failureLabel } from "./failures.js";
import { jobTitle } from "./titles.js";
import type { Store } from "./store.js";
import type { BridgeChat } from "./instinct-chat.js";
import { bridgeJobView } from "./instinct-chat.js";
import { CONTEXT_LIST_MAX, isPaulsJob, jobContextView, maskSecrets } from "./bridge-context.js";

export const INSTINCT_PATH = "/api/instinct";
const OUTPUT_MAX_CHARS = 60_000;
const STATUS_JOBS = 15;
const DM_PAGE_MAX = 100;
const DM_TEXT_MAX = 2_000;
const MISS_LIMIT = 5;
const MISS_WINDOW_MS = 60_000;

export interface InstinctBridgeDeps {
  store: Pick<Store, "allJobs" | "queueHold" | "getJob" | "readOutput">;
  chat: BridgeChat;
  /** The shared secret; the bridge is off when empty. */
  token?: string;
  /** Who counts as Paul's own sender (for the read-only context routes). */
  isAllowed?: (sender: string) => boolean;
  /** The model-backed chat routes. Off unless set: the read-only routes need no model and cost nothing. */
  chatEnabled?: boolean;
  now?: () => number;
  /**
   * Scoped retry. Both must be set for the route to exist: `retryAllow` is the owner's list of failed job ids
   * the bridge may rerun (empty means 404), `retry` reruns one job by id the way the owner's own retry
   * command does. `retryBlocked` says why a retry must not run now (the daily spend cap), or returns undefined.
   */
  retryAllow?: readonly string[];
  retry?: (id: string) => { id: string; status: string };
  retryBlocked?: () => string | undefined;
  retryPerDay?: number;
  /** Read-only guild look from the Discord gateway. Absent, or resolving to undefined (no gateway connected), means 404; a read that throws is a 502. */
  guilds?: () => Promise<unknown | undefined>;
  /** Read-only page of the owner's DM with the bot. Absent or resolving to undefined means 404; a throw is a 502. */
  /** One job thread, by thread id taken from the job record. Undefined when it is not bound or not a job thread of the configured guild and parent. */
  threadHistory?: (threadId: string, limit: number, before?: string) => Promise<({ readable: boolean; messages?: Array<{ text: string }> } & Record<string, unknown>) | undefined>;
  dmHistory?: (limit: number, before?: string) => Promise<{ messages: Array<{ text: string }> } & Record<string, unknown> | undefined>;
  /** Where the retry timestamps are kept, so the daily limit survives a restart. Without it they live in memory only. */
  retryLogFile?: string;
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Only jobs Paul started or the bridge started: another initiator's job titles are not shown. */
export function statusData(store: InstinctBridgeDeps["store"], now = Date.now(), isAllowed: (sender: string) => boolean = () => false) {
  const hold = store.queueHold();
  const jobs = store
    .allJobs()
    .filter((j) => j.origin === "instinct" || isPaulsJob(j, isAllowed))
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.startedAt ?? a.createdAt))
    .slice(0, STATUS_JOBS)
    .map((j) => ({
      id: j.id,
      title: jobTitle(j),
      kind: j.kind,
      status: j.status,
      ...(j.status === "failed" && j.failure ? { failure: j.failure, failureLabel: failureLabel(j.failure) } : {}),
      ...(j.pr ? { pr: j.pr } : {}),
      createdAt: j.createdAt,
      ...(j.startedAt ? { startedAt: j.startedAt } : {}),
      ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
    }));
  return {
    generatedAt: new Date(now).toISOString(),
    queueHeld: hold ? { kind: hold.kind, label: failureLabel(hold.kind), since: hold.since, jobId: hold.jobId } : null,
    jobs,
  };
}

export function instinctRouter(deps: InstinctBridgeDeps): ExpressRouter {
  const router = Router();
  const now = deps.now ?? Date.now;
  const misses: number[] = [];
  const recent = (list: number[], windowMs: number) => {
    const cutoff = now() - windowMs;
    while (list.length && list[0] < cutoff) list.shift();
    return list.length;
  };

  // Off means invisible. Everything else needs the exact bearer token.
  router.use((req: Request, res: Response, next) => {
    if (!deps.token) return void res.sendStatus(404);
    if (recent(misses, MISS_WINDOW_MS) >= MISS_LIMIT) return void res.sendStatus(429);
    const header = req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!given || !sameToken(given, deps.token)) {
      misses.push(now());
      return void res.sendStatus(401);
    }
    next();
  });

  router.get("/status", (_req, res) => {
    res.set("Cache-Control", "no-store").json(statusData(deps.store, now(), deps.isAllowed));
  });

  // Chat routes start a paid model turn, so they answer 404 unless explicitly enabled.
  router.use(["/chat", "/chat/:id"], (_req, res, next) => (deps.chatEnabled ? next() : void res.sendStatus(404)));

  // Read-only, no model: jobs Paul started himself, with his captured message, the brief (not his words) and a capped report.
  router.get("/context", (_req, res) => {
    const isAllowed = deps.isAllowed ?? (() => false);
    const list = deps.store.allJobs().filter((j) => isPaulsJob(j, isAllowed)).slice(-CONTEXT_LIST_MAX).map((j) => ({ ...jobContextView(j, (x) => deps.store.readOutput(x)), output: undefined }));
    res.set("Cache-Control", "no-store").json({ jobs: list });
  });
  router.get("/context/:id", (req, res) => {
    const isAllowed = deps.isAllowed ?? (() => false);
    const j = deps.store.getJob(String(req.params.id));
    if (!j || !isPaulsJob(j, isAllowed)) return void res.sendStatus(404);
    res.set("Cache-Control", "no-store").json(jobContextView(j, (x) => deps.store.readOutput(x)));
  });

  router.get("/context/:id/thread", async (req, res) => {
    if (!deps.threadHistory) return void res.sendStatus(404);
    const isAllowed = deps.isAllowed ?? (() => false);
    const j = deps.store.getJob(String(req.params.id));
    if (!j || !isPaulsJob(j, isAllowed)) return void res.sendStatus(404);
    const m = /^dc:c:(\d{15,25})$/.exec(j.replyTo ?? "");
    if (!m) return void res.sendStatus(404);
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > DM_PAGE_MAX) return void res.status(400).json({ ok: false, error: `limit must be a whole number from 1 to ${DM_PAGE_MAX}` });
    const before = req.query.before === undefined ? undefined : String(req.query.before);
    if (before !== undefined && !/^\d{15,25}$/.test(before)) return void res.status(400).json({ ok: false, error: "before must be a message id" });
    try {
      const page = await deps.threadHistory(m[1]!, rawLimit, before);
      if (page === undefined) return void res.sendStatus(404);
      const messages = (page.messages ?? []).map((x) => {
        const text = maskSecrets(String(x.text));
        return { ...x, text: text.length > DM_TEXT_MAX ? text.slice(0, DM_TEXT_MAX) : text, ...(text.length > DM_TEXT_MAX ? { truncated: true } : {}) };
      });
      res.set("Cache-Control", "no-store").json({ jobId: j.id, ...page, ...(page.messages ? { messages } : {}) });
    } catch {
      res.status(502).json({ ok: false, error: "Discord could not be read just now." });
    }
  });
  router.post("/chat", (req, res) => {
    const r = deps.chat.submit((req.body as { text?: unknown } | undefined)?.text);
    if (!r.ok) return void res.status(r.status).json({ ok: false, error: r.error });
    res.status(202).json({ ok: true, id: r.id });
  });

  router.get("/chat/:id", (req, res) => {
    const r = deps.chat.reply(String(req.params.id));
    if (!r) return void res.sendStatus(404);
    res.set("Cache-Control", "no-store").json(r);
  });

  router.get("/jobs/:id", (req, res) => {
    const j = deps.store.getJob(String(req.params.id));
    if (!j || j.origin !== "instinct") return void res.sendStatus(404);
    const out = j.status === "done" ? deps.store.readOutput(j.id) : undefined;
    res.set("Cache-Control", "no-store").json({ ...bridgeJobView(j), ...(out ? { output: maskSecrets(out.slice(0, OUTPUT_MAX_CHARS)) } : {}) });
  });

  router.get("/discord/guilds", async (_req, res) => {
    if (!deps.guilds) return void res.sendStatus(404);
    try {
      const g = await deps.guilds();
      if (g === undefined) return void res.sendStatus(404);
      res.set("Cache-Control", "no-store").json(g);
    } catch {
      res.status(502).json({ ok: false, error: "Discord could not be read just now." });
    }
  });

  router.get("/dm-history", async (req, res) => {
    if (!deps.dmHistory) return void res.sendStatus(404);
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > DM_PAGE_MAX) return void res.status(400).json({ ok: false, error: `limit must be a whole number from 1 to ${DM_PAGE_MAX}` });
    const before = req.query.before === undefined ? undefined : String(req.query.before);
    if (before !== undefined && !/^\d{15,25}$/.test(before)) return void res.status(400).json({ ok: false, error: "before must be a message id" });
    try {
      const page = await deps.dmHistory(rawLimit, before);
      if (page === undefined) return void res.sendStatus(404);
      const messages = page.messages.map((m) => {
        const text = maskSecrets(String(m.text));
        return { ...m, text: text.length > DM_TEXT_MAX ? text.slice(0, DM_TEXT_MAX) : text, ...(text.length > DM_TEXT_MAX ? { truncated: true } : {}) };
      });
      res.set("Cache-Control", "no-store").json({ ...page, messages });
    } catch {
      res.status(502).json({ ok: false, error: "Discord could not be read just now." });
    }
  });

  const retried: number[] = [];
  // The log must be trustworthy before any retry runs. Missing file means none yet; anything else wrong
  // (unreadable, not a list of numbers) closes the route until the owner looks at it.
  let retryLogBroken = false;
  if (deps.retryLogFile) {
    try {
      const saved = JSON.parse(readFileSync(deps.retryLogFile, "utf8")) as unknown;
      if (!Array.isArray(saved) || !saved.every((x) => typeof x === "number" && Number.isFinite(x))) retryLogBroken = true;
      else retried.push(...(saved as number[]).sort((a, b) => a - b));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") retryLogBroken = true;
    }
  }
  /** Writes the list to a temporary file and renames it over the log, so a crash leaves the old or the new one, never half. */
  const persistRetries = (): boolean => {
    if (!deps.retryLogFile) return true;
    try {
      const tmp = `${deps.retryLogFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(retried));
      renameSync(tmp, deps.retryLogFile);
      return true;
    } catch {
      return false;
    }
  };

  router.post("/retry", (req, res) => {
    const allow = deps.retryAllow ?? [];
    if (!deps.retry || allow.length === 0) return void res.sendStatus(404);
    const id = String((req.body as { id?: unknown } | undefined)?.id ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{6}$/.test(id) || !allow.includes(id)) return void res.status(403).json({ ok: false, error: "That job is not on the retry allowlist." });
    const job = deps.store.getJob(id);
    if (!job) return void res.status(404).json({ ok: false, error: "No such job." });
    if (job.status !== "failed") return void res.status(409).json({ ok: false, error: `That job is ${job.status}, not failed.` });
    if (recent(retried, 24 * 3_600_000) >= (deps.retryPerDay ?? 2)) return void res.status(429).json({ ok: false, error: "Retry limit for today reached." });
    const blocked = deps.retryBlocked?.();
    if (blocked) return void res.status(423).json({ ok: false, error: blocked });
    if (retryLogBroken) return void res.status(503).json({ ok: false, error: "The retry log is unreadable, so no retry runs until the owner checks it." });
    try {
      // Count and save it before the job is touched; if it cannot be saved, nothing runs.
      retried.push(now());
      if (!persistRetries()) {
        retried.pop();
        return void res.status(503).json({ ok: false, error: "The retry could not be recorded, so it did not run." });
      }
      const r = deps.retry(id);
      res.status(202).json({ ok: true, id: r.id, status: r.status });
    } catch (err) {
      res.status(409).json({ ok: false, error: err instanceof Error ? err.message : "Retry refused." });
    }
  });

  router.get("/transcript", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ entries: deps.chat.transcript() });
  });

  return router;
}
