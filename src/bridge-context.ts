/**
 * Read-only context about Paul's own jobs, for the Instinct bridge's chief (tool `get_job_context`).
 *
 * Two kinds of text come back and they are labelled differently:
 *  - `triggerMessage`: the verbatim message from Paul's own chat turn in which the chief started the job,
 *    captured by the service (never by a model), with its channel address, message id and time. It is not
 *    necessarily the whole of his intent (the chief may have been working from earlier turns), and jobs
 *    started before this field existed, by a schedule, or automatically by another job have none.
 *  - `brief`: written by the chief for the worker. It is an agent's rewrite, not Paul's words.
 * Output text is capped and marked incomplete when cut. Obvious secrets are masked, which is a second
 * layer: workers are not given secrets in the first place.
 */
import type { Job } from "./store.js";
import { jobTitle } from "./titles.js";

export const CONTEXT_TRIGGER_MAX = 2_000;
export const CONTEXT_BRIEF_MAX = 4_000;
export const CONTEXT_OUTPUT_MAX = 8_000;
export const CONTEXT_LIST_MAX = 10;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9])/g,
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, k, sep) => (typeof k === "string" && typeof sep === "string" ? `${k}${sep}[masked]` : "[masked]"));
  return out;
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Jobs Paul himself started: not the bridge's own, and requested by an allowed sender (not a schedule or the bridge). */
export function isPaulsJob(j: Job, isAllowed: (sender: string) => boolean): boolean {
  return j.origin !== "instinct" && isAllowed(j.requestedBy);
}

export function jobContextView(j: Job, readOutput: (id: string) => string | undefined) {
  const trig = j.triggerMessage;
  const trigger = trig ? cap(maskSecrets(trig.text), CONTEXT_TRIGGER_MAX) : undefined;
  const brief = cap(maskSecrets(j.brief), CONTEXT_BRIEF_MAX);
  const raw = readOutput(j.id);
  const output = raw === undefined ? undefined : cap(maskSecrets(raw), CONTEXT_OUTPUT_MAX);
  return {
    id: j.id,
    title: jobTitle(j),
    kind: j.kind,
    status: j.status,
    createdAt: j.createdAt,
    ...(j.startedAt ? { startedAt: j.startedAt } : {}),
    ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
    ...(j.status === "failed" && j.failure ? { failure: j.failure } : {}),
    ...(j.pr ? { pr: j.pr } : {}),
    triggerMessage: trig && trigger
      ? { source: "Paul's own chat turn, captured verbatim by the service", kind: trig.kind, conversation: trig.conversation, messageId: trig.messageId ?? null, receivedAt: trig.receivedAt, text: trigger.text, truncated: trigger.truncated }
      : "not recorded (started before capture, by a schedule, automatically by another job, or by a path that does not capture it). Do not treat the brief as his words.",
    brief: { source: "written by the chief for the worker, not Paul's words", text: brief.text, truncated: brief.truncated },
    output: output
      ? { text: output.text, truncated: output.truncated, note: output.truncated ? `Cut at ${CONTEXT_OUTPUT_MAX} characters: this is incomplete.` : "Complete (secrets masked)." }
      : { text: null, note: j.status === "done" ? "No saved output." : "No output yet." },
  };
}
