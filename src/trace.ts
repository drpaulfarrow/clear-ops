import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { redact } from "./repos.js";
import type { JobKind } from "./store.js";

/**
 * The durable trace of a job (17 Nov 2026): one JSON line per step under DATA_DIR/traces/<jobId>.jsonl,
 * so that "why did this job fail" is answered from a record and not from a guess. The thread commentary
 * (src/status.ts) shows the latest step and then disappears; this is what stays.
 *
 * What a line holds: the tool a worker called and a clipped, redacted summary of its input; whether the
 * tool answered or failed, with a clipped excerpt of what a built-in tool said (a failing test's output,
 * a refused command); the worker's own short remarks; and how the run ended. What it never holds:
 * anything from a kind that works over Paul's mail, calendar, CV or DNS (PRIVATE_KINDS: tool names and
 * outcomes only), the same from every job that carries a bound private source (a staged Google Doc,
 * `src/doc-reader.ts`), whatever its kind - the source's own text reached that job's worker, so no
 * command, tail or remark that could quote it is kept to outlive the one job the source is bound to,
 * nor any terminal detail: how the run ended is an outcome like any other, so for those jobs the SDK's
 * own end event and the service's stop and failure lines keep a generic outcome with its kind only,
 * never the SDK's result or errors or the stop or failure detail -,
 * the input or output of any service tool (`mcp__...`: names and outcomes only, because
 * those carry mail, pages, logins and search results), a one-time code, a password or a card (those never
 * reach a model, so they cannot reach here), and every token `redact` knows.
 *
 * It is read by `/trace <id>` (no model call) and, since 18 Nov 2026 on Paul's instruction, by the
 * signed-in web app's job page (src/app-data.ts, as stored, behind src/app-auth.ts). Nothing else
 * reads it: no other page, no model, no bridge.
 */

/** What the runner reports for a trace (src/agents.ts `RunOptions.onTrace`), before shaping. */
export type RawTraceEvent =
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; sub?: boolean }
  | { type: "tool_result"; id: string; isError: boolean; text: string; sub?: boolean }
  | { type: "text"; text: string; sub?: boolean }
  | { type: "end"; outcome: string; turns?: number; isError?: boolean };

/** One stored line. */
export interface TraceLine {
  /** ISO time. */
  t: string;
  ev: "start" | "tool" | "result" | "say" | "end";
  /** Tool name (tool, result). */
  name?: string;
  /** Clipped, redacted input summary (tool) or output excerpt (result), or the remark (say), or the outcome (end, start). */
  text?: string;
  /** result: the tool reported an error. */
  error?: boolean;
  /** From a subagent rather than the worker itself. */
  sub?: boolean;
  /** end: turns the run took, where the SDK said. */
  turns?: number;
}

/** Kinds whose tools read Paul's mail, calendar, CV facts or zones: names and outcomes only. */
export const PRIVATE_KINDS: JobKind[] = ["ea", "cv", "dns"];

/** Built-in tools whose input and output are ordinary engineering text and may be excerpted. */
const DETAILED_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "Task", "TodoWrite", "NotebookEdit"]);

export const TRACE_INPUT_MAX = 300;
export const TRACE_OUTPUT_MAX = 700;
export const TRACE_SAY_MAX = 400;
/** A trace stops growing here; one line says so. A runaway job cannot fill the volume. */
export const TRACE_MAX_LINES = 3000;
export const TRACE_RETENTION_DAYS = 14;
export const TRACE_KEEP_FILES = 400;

export function tracesDir(dataDir: string = config.dataDir): string {
  return path.join(dataDir, "traces");
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** The end of a long output is where a failing test or a refused command says why. */
function clipTail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/** The one field of a built-in tool's input worth keeping, in plain text. */
function inputSummary(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (name === "Bash") return s("command");
  if (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit") return s("file_path") || s("notebook_path");
  if (name === "Glob") return s("pattern");
  if (name === "Grep") return [s("pattern"), s("path")].filter(Boolean).join(" in ");
  if (name === "WebFetch") return s("url").split("?")[0];
  if (name === "Task") return s("description");
  return "";
}

/** Shapes one raw event into the line that is stored, or nothing when the kind or tool keeps it out. */
export function shapeTrace(
  e: RawTraceEvent,
  kind: JobKind,
  names: Map<string, string>,
  /** A private source is bound to this job (src/doc-reader.ts): names and outcomes only, whatever its kind. */
  sourceBound = false,
  now: Date = new Date(),
): TraceLine | undefined {
  const t = now.toISOString();
  // Names and outcomes only: the private kinds (Paul's mail, calendar, CV and zones), and every job
  // carrying a bound private source whatever its kind, because that job's worker was handed the
  // source's own text and `redact` knows token shapes, not a document's words - so a clipped quote
  // kept here would outlive the one job the source is bound to (its intended lifetime).
  const priv = PRIVATE_KINDS.includes(kind) || sourceBound;
  const sub = "sub" in e && e.sub ? { sub: true } : {};
  if (e.type === "tool") {
    names.set(e.id, e.name);
    const detail = !priv && DETAILED_TOOLS.has(e.name) ? clip(redact(inputSummary(e.name, e.input)), TRACE_INPUT_MAX) : "";
    return { t, ev: "tool", name: e.name, ...(detail ? { text: detail } : {}), ...sub };
  }
  if (e.type === "tool_result") {
    const name = names.get(e.id) ?? "tool";
    names.delete(e.id);
    // A built-in tool's words are kept: all of a short failure, the tail of a long one, and for Bash the
    // tail either way (that is where "12 passing, 1 failing" lives). A service tool keeps its outcome only.
    const detailed = !priv && DETAILED_TOOLS.has(name);
    const keep = detailed && (e.isError || name === "Bash");
    const text = keep ? clipTail(redact(e.text), TRACE_OUTPUT_MAX) : "";
    return { t, ev: "result", name, ...(e.isError ? { error: true } : {}), ...(text ? { text } : {}), ...sub };
  }
  if (e.type === "text") {
    if (priv) return undefined;
    const text = clip(redact(e.text), TRACE_SAY_MAX);
    return text ? { t, ev: "say", text, ...sub } : undefined;
  }
  // The end of the run is an outcome, so it is kept for every job - for a private or bound one in the
  // generic only: the SDK's own result or errors (an API error's text, why a run stopped mid-flight)
  // may quote the source that job's worker was handed, or private data, and no trace line may carry
  // those past the run they belong to.
  const outcome = priv ? (e.isError ? "failed" : "finished") : clip(redact(e.outcome), TRACE_OUTPUT_MAX);
  return { t, ev: "end", text: outcome, ...(e.isError ? { error: true } : {}), ...(e.turns !== undefined ? { turns: e.turns } : {}) };
}

/** Appends a job's trace. Every failure here is swallowed: a trace must never break or slow a job. */
export class JobTrace {
  private readonly file: string;
  private readonly names = new Map<string, string>();
  private lines = 0;
  private full = false;

  constructor(
    readonly jobId: string,
    private readonly kind: JobKind,
    dir: string = tracesDir(),
    /** A private source is bound to this job (src/doc-reader.ts): its trace keeps names and outcomes only. */
    private readonly sourceBound = false,
  ) {
    this.file = path.join(dir, `${jobId.replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      prune(dir);
      // A resumed or retried job carries on its own file, so the whole story is in one place.
      if (fs.existsSync(this.file)) this.lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).length;
    } catch {
      // No trace this time.
    }
  }

  /** Names and outcomes only: a private kind (Paul's mail, calendar, CV and zones), or any job carrying a bound private source. */
  private get priv(): boolean {
    return PRIVATE_KINDS.includes(this.kind) || this.sourceBound;
  }

  /**
   * A line the service itself writes: the run starting, with what it is. Only names (kind,
   * repository, model, resume and fix round) ever come through here, so it is kept alike for every
   * job; a start line never carries source or private content.
   */
  note(text: string): void {
    this.write({ t: new Date().toISOString(), ev: "start", text: clip(redact(text), TRACE_OUTPUT_MAX) });
  }

  /**
   * How the service itself ended the run: stopped, or failed. Every job keeps the outcome and its
   * kind; the detail (a stop reason, a thrown or API error) is kept only for a job that is neither
   * private nor bound to a source, because it may quote the source that worker was handed, or
   * private data, and no trace line may carry those past the run they belong to.
   */
  noteEnd(stopped: boolean, label: string, detail: string): void {
    const head = stopped ? "stopped by the service" : "failed";
    const kind = label ? ` (${label})` : "";
    const text = this.priv ? `${head}${kind}` : `${head}${kind}: ${detail}`;
    this.write({ t: new Date().toISOString(), ev: "end", text: clip(redact(text), TRACE_OUTPUT_MAX), error: true });
  }

  event(e: RawTraceEvent): void {
    let line: TraceLine | undefined;
    try {
      line = shapeTrace(e, this.kind, this.names, this.sourceBound);
    } catch {
      return;
    }
    if (line) this.write(line);
  }

  private write(line: TraceLine): void {
    if (this.full && line.ev !== "end") return;
    try {
      if (this.lines >= TRACE_MAX_LINES && !this.full) {
        this.full = true;
        fs.appendFileSync(this.file, `${JSON.stringify({ t: line.t, ev: "say", text: `Trace stopped at ${TRACE_MAX_LINES} lines; the job carried on.` })}\n`, { mode: 0o600 });
        if (line.ev !== "end") return;
      }
      fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      this.lines++;
    } catch {
      // Never the job's problem.
    }
  }
}

/** Old traces go: past the retention, and beyond the newest TRACE_KEEP_FILES. */
function prune(dir: string, now = Date.now()): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  files.forEach((x, i) => {
    if (i >= TRACE_KEEP_FILES || now - x.m > TRACE_RETENTION_DAYS * 86_400_000) fs.rmSync(path.join(dir, x.f), { force: true });
  });
}

export function readTrace(jobId: string, dir: string = tracesDir()): TraceLine[] {
  const file = path.join(dir, `${jobId.replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: TraceLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as TraceLine);
    } catch {
      // A torn last line after a crash is skipped.
    }
  }
  return out;
}

export interface TraceFigures {
  steps: number;
  errors: number;
  minutes: number;
  /** The same failing step seen more than once: the tool and how often. */
  repeats: Array<{ what: string; times: number }>;
}

export function traceFigures(lines: TraceLine[]): TraceFigures {
  const tools = lines.filter((l) => l.ev === "tool");
  const failed = lines.filter((l) => l.ev === "result" && l.error);
  const first = lines[0] ? Date.parse(lines[0].t) : 0;
  const last = lines.length ? Date.parse(lines[lines.length - 1].t) : 0;
  const seen = new Map<string, number>();
  for (const f of failed) {
    const key = `${f.name}: ${(f.text ?? "").slice(-160)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeats = [...seen].filter(([, n]) => n > 1).map(([what, times]) => ({ what, times })).sort((a, b) => b.times - a.times).slice(0, 3);
  return { steps: tools.length, errors: failed.length, minutes: Math.max(0, Math.round((last - first) / 60_000)), repeats };
}

/** How many of the last steps `/trace <id>` shows. */
export const TRACE_SHOW = 12;

/**
 * The trace as Paul reads it in chat: one line of figures, any step that failed the same way more than
 * once, the last failures in the tools' own words, and the last few steps. Plain text, no model.
 */
export function traceText(label: string, status: string, lines: TraceLine[]): string {
  if (!lines.length) return `No trace is saved for ${label}. Traces started on 17 Nov 2026 and are kept ${TRACE_RETENTION_DAYS} days.`;
  const f = traceFigures(lines);
  const out: string[] = [`${label}: ${status}. ${f.steps} steps over ${f.minutes} min, ${f.errors} of them failed.`];
  for (const r of f.repeats) out.push(`Failed the same way ${r.times} times: ${clip(r.what, 220)}`);
  const failures = lines.filter((l) => l.ev === "result" && l.error && l.text).slice(-3);
  if (failures.length) {
    out.push("Last failures:");
    for (const x of failures) out.push(`${time(x.t)} ${x.name}: ${clip(x.text ?? "", 300)}`);
  }
  out.push(`Last ${Math.min(TRACE_SHOW, lines.length)} lines:`);
  for (const l of lines.slice(-TRACE_SHOW)) out.push(lineText(l));
  return out.join("\n");
}

function time(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function lineText(l: TraceLine): string {
  const who = l.sub ? " (subagent)" : "";
  if (l.ev === "tool") return `${time(l.t)} ${l.name}${who}${l.text ? `: ${clip(l.text, 160)}` : ""}`;
  if (l.ev === "result") return `${time(l.t)} ${l.error ? "FAILED" : "ok"} ${l.name}${l.text ? `: ${clip(l.text, 200)}` : ""}`;
  if (l.ev === "say") return `${time(l.t)} said${who}: ${clip(l.text ?? "", 200)}`;
  return `${time(l.t)} ${l.ev === "start" ? "started" : "ended"}: ${clip(l.text ?? "", 240)}`;
}
