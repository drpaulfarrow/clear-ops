/**
 * How everything in this workforce talks to Paul. His rule (28 Oct 2026): write like a colleague on
 * WhatsApp, not like a pull request. A job report is three or four plain sentences saying what was
 * done, what he needs to do if anything, and a link. Full detail goes in the saved job output.
 *
 * Workers write two things in their final answer: the full report (saved as the job output, with any
 * machine-readable lines the job runner reads) and a short message between MESSAGE_OPEN and
 * MESSAGE_CLOSE, which is all Paul sees in chat. `splitReport` separates them and `plainMessage`
 * enforces the style on whatever reaches chat, so the rule holds even when a model forgets it.
 */

/** Paul's messaging rule, word for word in every agent prompt (the chief's and every worker's). */
export const PAUL_STYLE = `Messaging rule from Paul: write to him like a colleague on WhatsApp, not like a pull request. A message or job report to Paul is three or four plain sentences saying what was done, what Paul needs to do if anything, and a link. No headings, no "Outcome:", no "What changed", no bullet lists, no tables, no restating his brief. British English, no em dashes. Full detail goes in the saved job output, which he can ask for.`;

/** The names the web app gives the chief and four of the workers (public/app/app.js shows the same ones; a test holds the two together). */
export const AGENT_NAMES = { chief: "Marlo", engineer: "Fitz", maintain: "Vera", research: "Scout", design: "Pip" } as const;

/**
 * How the chief sounds in conversation (Paul's choice on 19 Nov 2026: warm, with character, after
 * finding its replies wooden). PAUL_STYLE still sets the limits (length, no lists, British English, no
 * em dashes); this is the voice inside them. It is the chief's alone: a worker's message is a report
 * and keeps the plain rule. The last sentences are the part that must not move: character never
 * changes what is true or how soon bad news is said.
 */
export const CHIEF_VOICE = `Your voice. You are ${AGENT_NAMES.chief}, and in conversation you sound like someone Paul works with and likes, not like a status page. Use contractions and the first person, and answer what he asked before anything else, in as few words as it takes: a quick question gets one line, and four sentences is a ceiling, not a target. React to what he actually said. Let some character through, a dry aside or a flash of enthusiasm when the moment has one, at most once a message and never forced. Call the workers by their names (${AGENT_NAMES.engineer} the engineer, ${AGENT_NAMES.maintain} the reviewer, ${AGENT_NAMES.research} the researcher, ${AGENT_NAMES.design} the designer) and say what they are doing in plain words ("${AGENT_NAMES.design}'s on it, I'll shout when the pictures land") rather than reading out a job's title, kind and settings. Give a job's id once, in passing, when you start it, and otherwise leave ids out unless he needs one to type. Do not open with "Started", "Understood", "Certainly" or his request said back to him, and do not list what you are not doing unless it changes what he gets. Character never bends the facts: bad news, a failed job, a cost, a limit you hit or anything waiting on his decision comes first and plainly, with no flattery, no softening and nothing made up to sound friendly. If you do not know, say so.`;

/**
 * How a finished job's message says where its report is: a command Paul can type on any channel. The
 * web app reads the same sentence back (`REPORT_POINTER`) and shows a link to the report in its place.
 */
export const reportPointer = (jobId: string): string => `Full report: show job ${jobId}.`;
export const REPORT_POINTER = /\s*Full report: show job ([A-Za-z0-9_-]{1,64})\.$/;

export const MESSAGE_OPEN = "<message_to_paul>";
export const MESSAGE_CLOSE = "</message_to_paul>";

/** Appended to every worker prompt (see workerSpec in agents.ts): the two-part final answer. */
export const REPORT_RULE = `${PAUL_STYLE}

Your final answer has two parts. First, your full report: everything the instructions above ask of your report, with all the detail, lists, tables and links it needs. It is saved as the job's output, which Paul, the chief of staff and other workers can read. Any lines the instructions above require in your report (REVIEW, DESIGN, IMAGE or VERDICT lines) stay in the report exactly as specified. End the report with one more line of its own, after any of those, that says honestly how it turned out: "GOAL: met", or "GOAL: not met: <the one reason>", or "GOAL: needs Paul: <the one thing he must do>". It is met only if the thing Paul asked for now exists or has happened. Trying, getting part of the way, or explaining why you could not is not met: if you were asked to buy, send, book, fix or change something and it did not happen, say not met and why. Then, last of all, your message to Paul in chat, on its own lines between ${MESSAGE_OPEN} and ${MESSAGE_CLOSE}: three or four plain sentences in one short paragraph saying what you did or found, what Paul needs to do if anything (or that nothing needs him), and the one most useful link (the pull request, the draft, the document). It must make sense on its own on a phone. No headings, labels, bullets, tables, markdown, job ids, costs or verdict lines in the message, and do not restate his brief. Paul sees only the message unless he asks for the full report.`;

/** At most this many sentences reach chat from a worker's message. */
export const MAX_SENTENCES = 4;
/** And at most this many characters. */
export const MAX_MESSAGE_CHARS = 600;

/** Lines the job runner reads from a report. They belong in the saved output, never in chat. */
const MACHINE_LINE = /^[ \t>*`_-]*(?:REVIEW[ \t]+\S+?[ \t]*:|DESIGN[ \t]*:|IMAGE[ \t]*:|VERDICT[ \t]*:|GOAL[ \t]*:[ \t]*(?:not met|needs Paul|met)\b)/i;

/** What a worker's own report says of how its job turned out. A claim to be shown as one, never evidence. */
export interface ClaimedOutcome {
  state: "met" | "not_met" | "needs_paul";
  /** The one reason, or the one thing Paul must do, in the worker's words. */
  detail?: string;
}

/** Reads the report's "GOAL: ..." line (REPORT_RULE). The last one counts; none means the worker said nothing. */
export function parseOutcome(report: string): ClaimedOutcome | undefined {
  let found: ClaimedOutcome | undefined;
  for (const m of (report ?? "").matchAll(/^[ \t>*`_-]*GOAL[ \t]*:[ \t]*(not met|needs Paul|met)\b[ \t:]*(.*)$/gim)) {
    const word = m[1].toLowerCase();
    const detail = m[2].replace(/[*`_]+$/, "").trim();
    found = { state: word === "met" ? "met" : word === "not met" ? "not_met" : "needs_paul", ...(detail ? { detail: detail.slice(0, 300) } : {}) };
  }
  return found;
}
/** The agent-creator's schedule recommendation fields, which follow its VERDICT line. */
const SCHEDULE_FIELD = /^[ \t>*_-]*(?:Kind|Cron|Brief|Why)[ \t]*:/;
/** Report-style labels at the start of a line: "Outcome:", "**What changed:**", "TL;DR:". */
const LABEL_BODY = String.raw`(?:\*\*|__)?(?:outcome|summary|tl;?dr|what changed|what was done|what i did|changes|status|result|results|next steps?|what you need to do|action(?: needed| for you| required)?|for you|why|how it was tested|testing|tests|files(?: changed)?|open questions|notes?|context|details|findings|key findings|recommendation)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*`;
const LABEL = new RegExp(`^${LABEL_BODY}`, "i");

/**
 * Adds a line to the end of a worker's report without touching the short message it sends: the line
 * goes just before the `<message_to_paul>` block, or at the end when there is none. An empty line
 * leaves the answer exactly as it was. Used for the one plain line saying which GitHub credential
 * reached the job's repository (src/repo-tokens.ts, src/jobs.ts).
 */
export function addToReport(text: string, line: string): string {
  const note = line.trim();
  if (!note) return text;
  const open = text.lastIndexOf(MESSAGE_OPEN);
  if (open < 0) return `${text.trimEnd()}\n\n${note}`;
  const head = text.slice(0, open).trimEnd();
  return head ? `${head}\n\n${note}\n\n${text.slice(open)}` : `${note}\n\n${text.slice(open)}`;
}

/**
 * Separates a worker's final answer into the full report (saved as the job output; verdict lines
 * included) and the message for Paul. Without a message block, the message is derived from the report.
 */
export function splitReport(text: string): { report: string; message: string } {
  const open = text.lastIndexOf(MESSAGE_OPEN);
  if (open < 0) return { report: text.trim(), message: plainMessage(text) };
  const after = text.slice(open + MESSAGE_OPEN.length);
  const close = after.indexOf(MESSAGE_CLOSE);
  const raw = close < 0 ? after : after.slice(0, close);
  const rest = close < 0 ? "" : after.slice(close + MESSAGE_CLOSE.length);
  const report = `${text.slice(0, open)}${rest}`.trim();
  const message = plainMessage(raw);
  // An empty or all-markup message block falls back to the report.
  return { report: report || text.trim(), message: message || plainMessage(report) };
}

/**
 * Turns any text into a short plain-prose chat message: no code, tables, headings, labels, bullets,
 * markdown emphasis, em dashes or machine-readable lines, at most `maxSentences` sentences and
 * `maxChars` characters. Links survive (they never contain spaces, so sentence splitting keeps them whole).
 */
export function plainMessage(text: string, o: { maxSentences?: number; maxChars?: number } = {}): string {
  const maxSentences = o.maxSentences ?? MAX_SENTENCES;
  const maxChars = o.maxChars ?? MAX_MESSAGE_CHARS;
  const pieces: string[] = [];
  let inFence = false;
  for (const rawLine of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let line = rawLine.trim();
    if (!line) {
      pieces.push("");
      continue;
    }
    if (line.includes(MESSAGE_OPEN) || line.includes(MESSAGE_CLOSE)) line = line.replaceAll(MESSAGE_OPEN, "").replaceAll(MESSAGE_CLOSE, "").trim();
    if (!line) continue;
    if (MACHINE_LINE.test(line) || SCHEDULE_FIELD.test(line)) continue;
    // Tables and horizontal rules.
    if (/^\|/.test(line) || /^[-=*_|:\s]{3,}$/.test(line)) continue;
    // Headings are labels, not content.
    if (/^#{1,6}\s/.test(line)) continue;
    // A line that is only a bold label ("**Outcome**") is a heading too.
    if (/^(\*\*|__)[^*_]{1,60}(\*\*|__):?$/.test(line)) continue;
    // Bullets and numbered items become sentences.
    line = line.replace(/^(?:[-*+•‣◦]|\d{1,2}[.)])\s+/, "");
    line = line.replace(/^>\s?/, "");
    for (let i = 0; i < 2; i++) line = line.replace(LABEL, "");
    line = stripMarkdown(line);
    if (!line) continue;
    // A list item or short line with no end punctuation is still its own sentence.
    if (!/[.!?:;,)\]"'’]$/.test(line)) line += ".";
    pieces.push(line);
  }
  // Paragraphs: keep the first few that carry content.
  const prose = pieces
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p))
    .join(" ");
  const sentences = splitSentences(prose).slice(0, maxSentences);
  let out = sentences.join(" ").trim();
  if (out.length > maxChars) {
    const cut = out.lastIndexOf(" ", maxChars - 1);
    out = `${out.slice(0, cut > maxChars / 2 ? cut : maxChars - 1).replace(/[\s,;:]+$/, "")}…`;
  }
  return out;
}

function stripMarkdown(line: string): string {
  return (
    line
      // [text](url) becomes "text (url)"; a bare link stays.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => (t === u ? u : `${t} (${u})`))
      .replace(/\*\*|__/g, "")
      .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
      .replace(/`/g, "")
      // No em dashes: Paul's rule.
      .replace(/\s*—\s*/g, ", ")
      .replace(/\s+–\s+/g, ", ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Sentences, split after . ! or ? followed by a space and a capital, digit, quote or bracket. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+(?=["'(‘“]?[\p{Lu}\p{N}])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The chief's own replies: the prompt asks for plain sentences, and this removes what slips through
 * (headings, report labels, bold, bullet glyphs, machine lines, em dashes). Numbered steps and line
 * breaks stay, because the chief sometimes relays steps Paul must follow himself.
 */
export function tidyReply(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      out.push(rawLine);
      continue;
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }
    let line = rawLine.trimEnd();
    if (MACHINE_LINE.test(line)) continue;
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue;
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      // A bare label heading ("## Outcome") goes; a heading with content becomes a plain line.
      const t = stripMarkdown(heading[1]).replace(/:$/, "");
      if (!t || LABEL.test(`${t}:`)) continue;
      line = t;
    }
    if (/^\s*(\*\*|__)[^*_]{1,60}(\*\*|__):?\s*$/.test(line) && LABEL.test(`${line.replace(/[*_:\s]/g, " ").trim()}:`)) continue;
    line = line.replace(/^(\s*)(?:[-*+•])\s+/, "$1");
    for (let i = 0; i < 2; i++) line = line.replace(new RegExp(`^(\\s*)${LABEL_BODY}`, "i"), "$1");
    line = line.replace(/\*\*|__/g, "").replace(/\s*—\s*/g, ", ");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A one-line, capped error or command output for chat; the full text stays in the store. */
export function shortText(text: string, max = 300): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}
