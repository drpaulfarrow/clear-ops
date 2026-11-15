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
 *
 * What it cannot do, by construction: reach Paul's own conversation, parse an approval word, start any
 * job but a read-only research or write job, grant a permit, schedule, cancel, resume, read a secret, an
 * upload or the data directory, or act as Paul anywhere.
 */
import { createHash, timingSafeEqual } from "node:crypto";
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

  router.get("/transcript", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ entries: deps.chat.transcript() });
  });

  return router;
}
