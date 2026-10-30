import type { Job, JobKind, Schedule } from "./store.js";

/**
 * Every job has a short human title ("Fly deploy", "TollBit research"), and that title is what Paul
 * sees in every message about the job. The chief picks it for the jobs it starts; jobs the system
 * starts (reviews, fix rounds, design rounds, scheduled runs) get a title derived from their parent's.
 * The full brief stays on the job, unchanged, for the worker.
 */

export const TITLE_MAX_WORDS = 5;
export const TITLE_MAX_CHARS = 40;
/** Derived system titles add a prefix ("Fix round 2: ") to a chosen title, so they may run longer. */
const DERIVED_MAX_CHARS = 80;

/** Whitespace-collapsed, single line, no control characters, quotes or trailing punctuation. */
function tidy(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`\u2018\u2019\u201c\u201d]+|["'`\u2018\u2019\u201c\u201d]+$/g, "")
    .replace(/[\s.,;:!?-]+$/, "")
    .trim();
}

/** Checks a title the chief chose: five words or fewer, at most 40 characters, with at least one letter or digit. */
export function validateTitle(raw: unknown): { title: string } | { error: string } {
  const title = typeof raw === "string" ? tidy(raw) : "";
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return { error: 'A job needs a title: five words or fewer, specific to the task, e.g. "Fly deploy" or "TollBit research".' };
  const words = title.split(" ").length;
  if (words > TITLE_MAX_WORDS) return { error: `Title "${title}" has ${words} words; use ${TITLE_MAX_WORDS} or fewer, e.g. "Web UI restyle".` };
  if (title.length > TITLE_MAX_CHARS) return { error: `Title "${title}" is ${title.length} characters; keep it to ${TITLE_MAX_CHARS} or fewer.` };
  return { title };
}

const KIND_NAMES: Record<JobKind, string> = {
  research: "Research",
  write: "Writing",
  engineer: "Engineering",
  maintain: "Review",
  analyse: "Analysis",
  create_agent: "New agent",
  ea: "Assistant",
  design: "Design",
  ideate: "Ideas",
};

/** Words a derived title should not end on. */
const DANGLING = new Set("a an and as at by for from in into of on or the this that to with via our its their your".split(" "));

/**
 * A short title read off a brief, for jobs nobody titled (old jobs, schedules made before titles).
 * Drops a leading label ("Outcome:", "Engineer:"), keeps the first sentence's first five words.
 */
export function deriveTitle(brief: string, kind?: JobKind): string {
  let text = (brief ?? "").replace(/[#*_`>[\]]+/g, " ");
  const firstLine = text.split(/\n/).map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  text = firstLine;
  for (let i = 0; i < 3; i++) text = text.replace(/^\s*(outcome|task|goal|brief|context|engineer|research|write|design|ideate|analyse|ea|request)\s*:\s*/i, "");
  // First sentence: a full stop, ! or ? followed by a space or the end ("Fly.io" stays whole).
  text = text.split(/[.!?;:](?:\s|$)|\s[-\u2013\u2014]\s|,\s/)[0] ?? "";
  let words = tidy(text).split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS);
  while (words.join(" ").length > TITLE_MAX_CHARS && words.length > 1) words = words.slice(0, -1);
  while (words.length > 1 && DANGLING.has(words.at(-1)!.toLowerCase())) words = words.slice(0, -1);
  let title = tidy(words.join(" ")).slice(0, TITLE_MAX_CHARS).trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return kind ? `${KIND_NAMES[kind]} job` : "Untitled job";
  title = title[0].toUpperCase() + title.slice(1);
  return title;
}

/** A title with a system prefix: "Review: Fly deploy", "Fix round 2: Fly deploy". */
export function prefixed(prefix: string, base: string): string {
  const t = `${prefix}: ${tidy(base) || "job"}`;
  return t.length <= DERIVED_MAX_CHARS ? t : `${t.slice(0, DERIVED_MAX_CHARS - 1).trimEnd()}…`;
}

/** The chosen part of a review or fix-round title, so a fix of a fix is "Fix round 2: X", not "Fix round 2: Fix round 1: X". */
export function baseTitle(title: string): string {
  return title.replace(/^(?:Review|Re-review \d+|Fix round \d+): /, "");
}

/** The title of the maintainer's review of an engineering job. */
export function reviewTitle(reviewed: Pick<Job, "title" | "brief" | "kind" | "fixRound">): string {
  const base = baseTitle(jobTitle(reviewed));
  return reviewed.fixRound ? prefixed(`Re-review ${reviewed.fixRound}`, base) : prefixed("Review", base);
}

export const fixTitle = (base: string, round: number) => prefixed(`Fix round ${round}`, baseTitle(base));
export const designRoundTitle = (loop: string, round: number, final?: boolean) => (final ? prefixed("Closing critique", loop) : prefixed(`Design round ${round}`, loop));
export const buildTitle = (loop: string, round: number) => prefixed(`Build round ${round}`, loop);
export const nudgeTitle = (followUpId: string) => `Draft nudge ${followUpId}`;

/** The title to show for a job, stored or (for a job from before titles) derived. */
export function jobTitle(job: Pick<Job, "title" | "brief" | "kind">): string {
  return job.title?.trim() || deriveTitle(job.brief, job.kind);
}

/** "Fly deploy · engineer · 16d5d3", with "workforce" for jobs on this repository. */
export function jobLabel(job: Pick<Job, "id" | "title" | "brief" | "kind" | "target">): string {
  const kind = job.target === "self" && job.kind !== "create_agent" ? `${job.kind}, workforce` : job.kind;
  return `${jobTitle(job)} · ${kind} · ${job.id}`;
}

/** "Fly deploy (16d5d3)", for pointing at another job: "queued behind Fly deploy (16d5d3)". */
export function jobRef(job: Pick<Job, "id" | "title" | "brief" | "kind"> | undefined, id: string): string {
  return job ? `${jobTitle(job)} (${id})` : `job ${id}`;
}

export function scheduleTitle(s: Pick<Schedule, "title" | "brief" | "kind">): string {
  return s.title?.trim() || deriveTitle(s.brief, s.kind);
}

/** The title for a schedule stored before titles existed. The assistant's default briefs keep their names. */
export function legacyScheduleTitle(s: Pick<Schedule, "brief" | "kind">): string {
  if (s.kind === "ea" && /^EA morning brief\b/i.test(s.brief)) return "Morning brief";
  if (s.kind === "ea" && /^EA end-of-day wrap\b/i.test(s.brief)) return "End-of-day wrap";
  return deriveTitle(s.brief, s.kind);
}

/**
 * The title for a job nobody titled (one stored before titles existed, a scheduled run, a nudge),
 * worked out from what the job records: a review or fix round from the job it belongs to, a design
 * round from its loop, a scheduled run from its schedule, a nudge from its follow-up id, otherwise
 * read off the brief. Jobs this one points at should already be titled.
 */
export function derivedJobTitle(job: Job, getJob: (id: string) => Job | undefined, jobs: Job[], schedules: Schedule[]): string {
  if (job.kind === "maintain" && job.reviewOf) {
    const reviewed = getJob(job.reviewOf);
    if (reviewed) return reviewTitle(reviewed);
  }
  if (job.designLoop && job.designLoop !== job.id && !job.fixRound) {
    const loop = getJob(job.designLoop);
    const loopTitle = loop ? jobTitle(loop) : "Design loop";
    if (job.kind === "design") return designRoundTitle(loopTitle, job.designRound ?? 1, job.designFinal);
    if (job.kind === "engineer") return buildTitle(loopTitle, job.designRound ?? 1);
  }
  if (job.kind === "design" && job.designLoop === job.id && job.designGoal) return deriveTitle(job.designGoal, "design");
  if (job.kind === "engineer" && job.fixRound) {
    const original = job.pr ? jobs.find((j) => j.id !== job.id && j.kind === "engineer" && !j.fixRound && j.pr && samePrRef(j.pr, job.pr!)) : undefined;
    const fromBrief = job.brief.split(/\nOriginal task:\n/)[1];
    const base = original ? jobTitle(original) : fromBrief ? deriveTitle(fromBrief, "engineer") : "pull request";
    return fixTitle(base, job.fixRound);
  }
  // The scheduler ends each run's brief with "(This is the scheduled run <id>.)".
  const scheduled = job.brief.match(/\(This is the scheduled run ([a-f0-9]{6})\.\)\s*$/);
  const schedule = scheduled && schedules.find((s) => s.id === scheduled[1]);
  if (schedule) return scheduleTitle(schedule);
  const nudge = job.kind === "ea" && job.brief.match(/^Follow-up ([a-f0-9]{6}), thread /);
  if (nudge) return nudgeTitle(nudge[1]);
  return deriveTitle(job.brief, job.kind);
}

function samePrRef(a: string, b: string): boolean {
  const n = (s: string) => s.match(/(?:\/pull\/|#)(\d+)/)?.[1];
  return n(a) !== undefined && n(a) === n(b);
}
