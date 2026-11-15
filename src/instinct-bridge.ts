/**
 * Instinct bridge: a small, read-mostly door for Paul's assistant (Instinct), so Paul does not have to
 * relay screenshots between the two.
 *
 * Off unless INSTINCT_BRIDGE_TOKEN is set; when it is unset every route answers 404 as if it did not
 * exist. Both routes need `Authorization: Bearer <token>`, compared in constant time, and wrong
 * attempts are slowed per process.
 *
 *  - GET  /api/instinct/status  what the board already shows and no more: whether the queue is held and
 *    why, and for the latest jobs their id, title, kind, status, a plain failure label, timings and a
 *    pull request link. Never a brief, an output, a transcript, a path, spend, or a secret.
 *  - POST /api/instinct/note    {"text": "..."} is forwarded to Paul's own chat, labelled as coming from
 *    his assistant and not typed by him. It never reaches the chief or a worker, starts no job and
 *    approves nothing. Paul decides whether to act on it by typing in his own chat.
 *
 * What it cannot do, by construction: start, retry, cancel or resume a job, change a schedule, approve
 * or decline anything (send, YES, buy, dns apply, code), read a secret or any file, or reach any
 * channel other than Paul's own chat.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router as ExpressRouter } from "express";
import { Router } from "express";
import { failureLabel } from "./failures.js";
import { jobTitle } from "./titles.js";
import type { Store } from "./store.js";

export const INSTINCT_PATH = "/api/instinct";
export const NOTE_MAX_CHARS = 1500;
const NOTES_PER_HOUR = 12;
const STATUS_JOBS = 15;
const MISS_LIMIT = 5;
const MISS_WINDOW_MS = 60_000;

export interface InstinctBridgeDeps {
  store: Pick<Store, "allJobs" | "queueHold">;
  /** Sends text to Paul's own chat. Never to anyone else. */
  notifyPaul: (text: string) => void;
  /** The shared secret; the bridge is off when empty. */
  token?: string;
  now?: () => number;
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Plain text only: control characters out, whitespace tidied, capped. */
export function cleanNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, NOTE_MAX_CHARS);
}

export function statusData(store: InstinctBridgeDeps["store"], now = Date.now()) {
  const hold = store.queueHold();
  const jobs = store
    .allJobs()
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
  const notes: number[] = [];
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
    res.set("Cache-Control", "no-store").json(statusData(deps.store, now()));
  });

  router.post("/note", (req, res) => {
    const text = cleanNote((req.body as { text?: unknown } | undefined)?.text);
    if (!text) return void res.status(400).json({ ok: false, error: "text is required" });
    if (recent(notes, 60 * 60_000) >= NOTES_PER_HOUR) return void res.status(429).json({ ok: false, error: "too many notes this hour" });
    notes.push(now());
    deps.notifyPaul(`Note from your assistant (Instinct). You did not type this, and it has not been acted on:\n\n${text}`);
    res.json({ ok: true });
  });

  return router;
}
