/**
 * One-use honest import of the already completed offboard Doubleshift draft (17 Nov 2026).
 *
 * It is an import, not a run: no worker is started, nothing is messaged, and no trigger, permit or
 * automatic follow-up is recorded. The record the import writes carries only what the offboard run's
 * own three files say: its status (completed), its timestamps, its model and its settled provider cost,
 * plus its artifact preserved verbatim as the job's saved output. No log, session transcript, prompt,
 * internal manual or secret is read or brought into anything a user sees.
 *
 * Scope is fixed in code: one directory, three named files in it, and a path check that refuses
 * anything resolving outside that directory. There is no parameter, chat command or tool input that
 * could point it elsewhere, so no untrusted source can widen what it reads. Called once from the
 * service's main entry (src/index.ts), never from buildApp, so no test or web request reaches it.
 */
import fs from "node:fs";
import path from "node:path";
import { shortId } from "./store.js";
import type { Job, Store } from "./store.js";

/** The only directory ever read: the offboard run's own, from the night of 17 Nov 2026. */
export const OFFBOARD_DIR = "/data/overnight-20261117";
/** The offboard run's own id, in every one of its files. */
export const OFFBOARD_RUN_ID = "strategy";
const STATUS_FILE = "strategy.status.json";
const RESULT_FILE = "strategy.result.json";
const OUTPUT_FILE = "strategy.output.md";

/** Who the record says asked for the run: the founder, in the service's own plain terms. */
const REQUESTER = "paul";

/** What the job is called everywhere it is shown. */
const TITLE = "Doubleshift strategy pack (imported)";

/** The run's own facts, read off its status and result files. */
interface OffboardFacts {
  model: string;
  startedAt: string;
  finishedAt: string;
  lastActivityAt?: string;
  costUsd: number;
  calls?: number;
}

/**
 * One of the run's three files. The name is fixed in code and the resolved path must stay inside the
 * directory, so nothing this module reads can be steered anywhere else.
 */
function readRunFile(dir: string, file: string): string {
  const resolved = path.resolve(dir, file);
  const root = path.resolve(dir);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${file} resolves outside ${dir}`);
  return fs.readFileSync(resolved, "utf8");
}

/** A timestamp from the run's own file, or a refusal when it is not one. */
function runDate(obj: Record<string, unknown>, file: string, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${file} has no valid ${field}`);
  return value;
}

/** One of the run's JSON files, or a refusal when it is not readable JSON. */
function readRunFileJson(dir: string, file: string): Record<string, unknown> {
  const text = readRunFile(dir, file);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** The run's own facts, from its status and result files and its preserved artifact. */
function readFacts(dir: string): { facts: OffboardFacts; output: string } {
  const status = readRunFileJson(dir, STATUS_FILE);
  const result = readRunFileJson(dir, RESULT_FILE);
  if (status.id !== OFFBOARD_RUN_ID) throw new Error(`${STATUS_FILE} is not the "${OFFBOARD_RUN_ID}" run`);
  if (status.state !== "completed") throw new Error(`${STATUS_FILE} says the run is not completed, so there is nothing finished to import`);
  if (typeof status.model !== "string" || !status.model.trim()) throw new Error(`${STATUS_FILE} has no model`);
  const cost = status.cost as { usd?: unknown; calls?: unknown } | undefined;
  if (typeof cost?.usd !== "number" || !Number.isFinite(cost.usd) || cost.usd < 0) {
    throw new Error(`${STATUS_FILE} has no settled provider cost`);
  }
  const startedAt = runDate(status, STATUS_FILE, "startedAt");
  // The status file calls it updatedAt; the result file names the finish itself.
  const finishedAt = runDate(result, RESULT_FILE, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error(`${STATUS_FILE} finishes before it starts`);
  const last = status.lastActivityAt;
  if (last !== undefined && (typeof last !== "string" || Number.isNaN(Date.parse(last)))) {
    throw new Error(`${STATUS_FILE} has no valid lastActivityAt`);
  }
  const facts: OffboardFacts = {
    model: status.model,
    startedAt,
    finishedAt,
    ...(typeof last === "string" ? { lastActivityAt: last } : {}),
    costUsd: cost.usd,
    ...(typeof cost.calls === "number" && Number.isFinite(cost.calls) ? { calls: cost.calls } : {}),
  };
  if (result.output !== OUTPUT_FILE) throw new Error(`${RESULT_FILE} does not name ${OUTPUT_FILE} as the run's output`);
  const output = readRunFile(dir, OUTPUT_FILE);
  if (!output.trim()) throw new Error(`${OUTPUT_FILE} is empty`);
  return { facts, output };
}

export interface OffboardImport {
  job: Job;
  /** True when this call wrote the record; false when an earlier import already had it. */
  created: boolean;
}

/**
 * The one-use import: reads the offboard run's three files and writes the job record for them through
 * the store (never state.json by hand). The record is born finished: its artifact is written first and
 * the record then lands in one atomic save, already `done` and already marked `importedRun`, so no
 * intermediate queued state ever exists for a restart to resume as a new run. Idempotent on the record
 * itself: once a job carries `importedRun: strategy`, a later call returns that job and writes nothing.
 * Refused files, or a write that fails at any point, mean nothing is created and the next boot tries
 * again. Never throws and never sends anything to anyone.
 */
export function importOffboardRun(store: Store, dir: string = OFFBOARD_DIR): OffboardImport | undefined {
  const existing = store.allJobs().find((j) => j.importedRun === OFFBOARD_RUN_ID);
  if (existing) return { job: existing, created: false };
  let facts: OffboardFacts;
  let output: string;
  try {
    ({ facts, output } = readFacts(dir));
  } catch (err) {
    console.warn(`offboard import: ${err instanceof Error ? err.message : err}. Nothing was imported.`);
    return undefined;
  }
  const settled = `${facts.calls ? `${facts.calls} provider calls, ` : ""}USD ${facts.costUsd} settled`;
  const brief = [
    `Imported record, not a run by this service: the completed offboard "${OFFBOARD_RUN_ID}" run, the Doubleshift strategy pack, which began ${facts.startedAt} and finished ${facts.finishedAt} on ${facts.model}, with ${settled}.`,
    "Nothing ran for it here and nothing was messaged for it. This record carries no trigger, permit or automatic follow-up, only the run's own status, timestamps, model and settled provider cost, and its preserved artifact as the saved output.",
    `Source: ${STATUS_FILE}, ${RESULT_FILE} and ${OUTPUT_FILE} in ${dir}. No log, session transcript, prompt, internal manual or secret is imported.`,
  ].join("\n\n");
  // The record is written whole or not at all, so it is never a queued job a restart could run. Its
  // artifact goes to disk first; the record itself is then created in one atomic store save
  // (`Store.importJob`), already finished and already marked as the import from its first and only
  // persisted state. A failure or a process death at any point leaves either nothing at all (the next
  // boot imports again) or the complete record (a later call writes nothing); no state exists from
  // which resume recovery could resume it as work, duplicate it, or run a new worker for it.
  let id = shortId();
  while (store.getJob(id)) id = shortId();
  try {
    store.writeOutput(id, output);
    const job = store.importJob({
      id,
      kind: "write",
      target: "doubleshift",
      title: TITLE,
      brief,
      requestedBy: REQUESTER,
      replyTo: REQUESTER,
      status: "done",
      importedRun: OFFBOARD_RUN_ID,
      model: facts.model,
      createdAt: facts.startedAt,
      startedAt: facts.startedAt,
      finishedAt: facts.finishedAt,
      ...(facts.lastActivityAt ? { lastActivityAt: facts.lastActivityAt } : {}),
      costUsd: facts.costUsd,
      summary: `Imported: the Doubleshift strategy pack from the completed offboard "${OFFBOARD_RUN_ID}" run (${facts.model}, ${settled}).`,
      outputPath: store.outputPath(id),
    });
    return { job, created: true };
  } catch (err) {
    console.warn(`offboard import: ${err instanceof Error ? err.message : err}. Nothing was imported.`);
    return undefined;
  }
}