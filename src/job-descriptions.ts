/**
 * What a job's card on the jobs board says about it (src/jobs-board.ts): two or three lines on a phone
 * on what the job is and why, one line explaining the kind of worker and the repository it runs in, and
 * one line on what a finished job produced.
 *
 * Nothing here invents anything. Every word comes from the job's own record, above all its brief, and a
 * brief that yields nothing usable says so rather than showing filler. This is the one module that reads
 * a brief for the board: it is a read-only page, so the text is redacted here (the service's own
 * redaction, src/repos.ts, not a second one), stripped of its markup and of the machine sections a
 * generated brief carries, capped, and escaped as text by the board. A brief is never rendered whole,
 * and a job's output, transcript, mail, calendar or upload is never read for any of this.
 */
import { repoRegistry, redact } from "./repos.js";
import { splitSentences } from "./messages.js";
import type { Job, JobKind } from "./store.js";

/** At most this many characters in a card's description: two or three lines on a phone. */
export const DESCRIPTION_MAX_CHARS = 240;
/** And in the longer detail behind the expand control. */
export const DETAIL_MAX_CHARS = 600;
/** Fewer words or characters than this and a brief cannot describe anything. */
const MIN_WORDS = 3;
const MIN_CHARS = 12;
/** Shown instead of a description when there is nothing to read: honest, not filler. */
export const NO_DESCRIPTION = "No description: this job's brief is empty or unreadable.";

/* ---------- What the kind of worker and the repository mean ---------- */

/** What Paul calls this kind of worker, in one word: the card says "maintainer", not "maintain". */
const KIND_NAMES: Record<JobKind, string> = {
  research: "researcher",
  write: "writer",
  engineer: "engineer",
  maintain: "maintainer",
  analyse: "analyst",
  create_agent: "agent-creator",
  ea: "assistant",
  design: "designer",
  ideate: "ideas scout",
  cv: "CV writer",
  dns: "DNS agent",
  advisor: "pitch advisor",
  prebid: "Prebid expert",
};

/** What each kind of worker does, in one short line, so "engineer, workforce" needs no decoding. */
const KIND_LINES: Record<JobKind, string> = {
  research: "researches on the web and writes a sourced brief",
  write: "drafts a document, spec or email in your voice",
  engineer: "writes the change on a branch and opens a pull request",
  maintain: "reviews the pull request and is the only one that merges",
  analyse: "answers a question from earlier outputs and saved data",
  create_agent: "turns a request for a new agent into a change to the workforce",
  ea: "works over your Gmail and Google Calendar, within its permits",
  design: "looks at the live site in a browser and writes a design spec",
  ideate: "lists ranked improvement ideas with the cheapest test for each",
  cv: "keeps your facts and master CV and tailors them for a role",
  dns: "reads and prepares GoDaddy DNS changes for you to approve",
  advisor: "builds publisher, buyer and investor pitches in your voice",
  prebid: "answers Prebid questions from primary sources, inventing nothing",
};

/** Paul's own name for a repository, so the card never shows an internal alias such as "self". */
export function repoLabel(alias: string | undefined): string {
  if (!alias || alias === "product") return "Clear Exchange";
  if (alias === "self") return "workforce";
  const repo = repoRegistry.find(alias);
  return repo?.names[0] ?? repo?.alias ?? alias;
}

/** "engineer on the workforce repo: writes the change on a branch and opens a pull request". */
export function kindLine(kind: JobKind | string, repository: string | undefined): string {
  const name = KIND_NAMES[kind as JobKind] ?? kind;
  const what = KIND_LINES[kind as JobKind] ?? "does a piece of the workforce's work";
  return `${name} on the ${repoLabel(repository)} repo: ${what}`;
}

/* ---------- A short description, read off the job's own brief ---------- */

/** A generated brief's own section headings: nothing from one of these onwards is a description. */
const MACHINE_SECTION = /^(?:engineer'?s report|agent-?creator'?s report|maintainer'?s report|original task|review comments?|comments|the report|report|saved output|output|verdict|design spec|review)\s*:?\s*$/i;
/** The same heading with the pasted text on the line itself, which the system never writes but a brief may carry. */
const MACHINE_HEADING = /^(?:engineer|agent-?creator|maintainer)'?s report\s*:\s*\S/i;
/** The scheduler's own note at the end of a scheduled run's brief. */
const SCHEDULED_NOTE = /\(this is the scheduled run [a-f0-9]{6}\.\)/gi;
/** A label a brief may open with, which says what the brief is rather than what the job does. */
const LEADING_LABEL = /^[\s>*_#-]*(?:outcome|task|goal|brief|context|request|engineer|research|write|design|ideate|cv|advisor|prebid|analyse|ea)\s*:\s*/i;

/** The host of a URL, without "www.": what a link in a brief is reduced to, so no query string rides along. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** One line of a brief as plain words: no markup, no link targets, no query strings. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:```|~~~).*$/, "")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*(?:[-*+•‣◦]|\d{1,2}[.)])\s+/, "")
    .replace(/^\s*>\s?/, "")
    // [words](url) keeps the words; <url> and a bare url become their host, so no query string rides along.
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_, words: string, url: string) => words.trim() || hostOf(url) || "")
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) => hostOf(url) ?? "")
    .replace(/https?:\/\/[^\s<>()]+/g, (url) => hostOf(url) ?? "")
    // A well-formed tag goes; "under < 50 ms" and "a < b" are left alone, since neither is a tag.
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fewer words, characters or letters than this and there is nothing to say about the job. */
function usable(text: string): boolean {
  return text.length >= MIN_CHARS && text.split(" ").filter(Boolean).length >= MIN_WORDS && /[\p{L}\p{N}]/u.test(text);
}

/** `text` cut at a word boundary, at most `max` characters, and how much of `text` that used. */
function clipWords(text: string, max: number): { text: string; used: number } {
  if (text.length <= max) return { text, used: text.length };
  const cut = text.lastIndexOf(" ", max - 1);
  const used = cut > max / 2 ? cut : max - 1;
  return { text: `${text.slice(0, used).replace(/[\s,;:]+$/, "")}…`, used };
}

/** As many whole sentences as fit, or a word-boundary cut when the first sentence is itself too long. */
function firstChunk(text: string, max: number): { text: string; used: number } {
  let out = "";
  for (const sentence of splitSentences(text)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  if (!out) return clipWords(text, max);
  if (out.length >= text.length) return { text: out, used: text.length };
  return { text: `${out.replace(/[.,;:]$/, "")}…`, used: out.length };
}

const capitalise = (text: string) => (/^\p{Ll}/u.test(text) ? text[0].toUpperCase() + text.slice(1) : text);

export interface BriefDescription {
  /** The card's description: two or three lines on a phone. */
  description?: string;
  /** The longer detail from the same brief, behind the card's expand control. */
  more?: string;
  /** Set when the brief yields nothing usable: the card says so instead of showing filler. */
  unavailable?: boolean;
}

/**
 * A job's brief as a short plain description. Redaction comes last, over text already stripped, so the
 * "***" it leaves is not mistaken for markdown emphasis: the machine sections of a generated brief are
 * dropped, the markup and the link targets come off, then the service's own redaction runs, then the
 * text is capped at whole sentences up to DESCRIPTION_MAX_CHARS for the card, with the rest, up to
 * DETAIL_MAX_CHARS, for the expand control. Nothing is ever invented or paraphrased by a model.
 */
export function describeBrief(brief: string): BriefDescription {
  const kept: string[] = [];
  for (const raw of (brief ?? "").replace(/\r\n?/g, "\n").replace(SCHEDULED_NOTE, "").split("\n")) {
    if (MACHINE_SECTION.test(raw.trim()) || MACHINE_HEADING.test(raw.trim())) break;
    const line = plainLine(raw);
    if (line) kept.push(line);
  }
  // The markup comes off first, so a redacted secret's "***" is not mistaken for markdown emphasis.
  let text = redact(kept.join(" ").replace(/\s+/g, " ").trim());
  for (let i = 0; i < 3; i++) text = text.replace(LEADING_LABEL, "");
  text = text.replace(/^[\s:;,.\-]+/, "").trim();
  if (!usable(text)) return { unavailable: true };
  const first = firstChunk(text, DESCRIPTION_MAX_CHARS);
  const rest = text.slice(first.used).replace(/^[\s…]+/, "").trim();
  const more = rest ? clipWords(rest, DETAIL_MAX_CHARS).text : undefined;
  return { description: capitalise(first.text), ...(more ? { more: capitalise(more) } : {}) };
}

/* ---------- The whole description of a card ---------- */

export interface JobFacts {
  /** The job already has a pull request the board links to. */
  hasPullRequest?: boolean;
  /** Its output is one the board links to in the private outputs repository. */
  hasSavedOutput?: boolean;
}

export interface JobDescription extends BriefDescription {
  /** What the kind of worker and the repository mean, in one plain line. */
  kindLine: string;
  /** A finished job: one line on what it produced, from the record only (never its output text). */
  produced?: string;
}

/**
 * A finished job's one line on what it produced. Read from the job's own record only: the pull request
 * it opened, the output the board already links to, its kind. The text of an output is never read, so
 * an assistant job's report never contributes a word.
 */
function producedLine(job: Pick<Job, "kind" | "status" | "fixRound" | "reviewOf">, facts: JobFacts): string | undefined {
  if (job.status !== "done") return undefined;
  const report = facts.hasSavedOutput ? "the report is linked below" : "the report is in your chat";
  switch (job.kind) {
    case "engineer":
    case "create_agent":
      if (!facts.hasPullRequest) return `Finished without a pull request; ${report}.`;
      return job.fixRound ? "Updated the pull request for the round of fixes." : "Opened the pull request.";
    case "maintain":
      return job.reviewOf ? `Reviewed its pull request; ${report}.` : `Reviewed the open pull requests; ${report}.`;
    case "ea":
      return "Worked over your mail and calendar; the report is in your chat.";
    case "design":
      return `Wrote a design report; ${report}.`;
    default:
      return `Wrote a report; ${report}.`;
  }
}

/** Everything a card says, from the job's own record. `repository` is its queue's alias. */
export function describeJob(job: Pick<Job, "kind" | "target" | "brief" | "status" | "fixRound" | "reviewOf" | "pr">, facts: JobFacts = {}, repository?: string): JobDescription {
  const brief = describeBrief(job.brief);
  const produced = producedLine(job, facts);
  return {
    ...brief,
    kindLine: kindLine(job.kind, repository ?? job.target),
    ...(produced ? { produced } : {}),
  };
}

/** A running job's latest step in plain words (src/status.ts describeWorkerTool), redacted and clipped. */
export function liveStep(step: string | undefined): string | undefined {
  const text = redact(step ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}
