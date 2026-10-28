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

export const MESSAGE_OPEN = "<message_to_paul>";
export const MESSAGE_CLOSE = "</message_to_paul>";

/** Appended to every worker prompt (see workerSpec in agents.ts): the two-part final answer. */
export const REPORT_RULE = `${PAUL_STYLE}

Your final answer has two parts. First, your full report: everything the instructions above ask of your report, with all the detail, lists, tables and links it needs. It is saved as the job's output, which Paul, the chief of staff and other workers can read. Any lines the instructions above require in your report (REVIEW, DESIGN, IMAGE or VERDICT lines) stay in the report exactly as specified. Then, last of all, your message to Paul in chat, on its own lines between ${MESSAGE_OPEN} and ${MESSAGE_CLOSE}: three or four plain sentences in one short paragraph saying what you did or found, what Paul needs to do if anything (or that nothing needs him), and the one most useful link (the pull request, the draft, the document). It must make sense on its own on a phone. No headings, labels, bullets, tables, markdown, job ids, costs or verdict lines in the message, and do not restate his brief. Paul sees only the message unless he asks for the full report.`;

/** At most this many sentences reach chat from a worker's message. */
export const MAX_SENTENCES = 4;
/** And at most this many characters. */
export const MAX_MESSAGE_CHARS = 600;

/** Lines the job runner reads from a report. They belong in the saved output, never in chat. */
const MACHINE_LINE = /^[ \t>*`_-]*(?:REVIEW[ \t]+\S+?[ \t]*:|DESIGN[ \t]*:|IMAGE[ \t]*:|VERDICT[ \t]*:)/i;
/** The agent-creator's schedule recommendation fields, which follow its VERDICT line. */
const SCHEDULE_FIELD = /^[ \t>*_-]*(?:Kind|Cron|Brief|Why)[ \t]*:/;
/** Report-style labels at the start of a line: "Outcome:", "**What changed:**", "TL;DR:". */
const LABEL_BODY = String.raw`(?:\*\*|__)?(?:outcome|summary|tl;?dr|what changed|what was done|what i did|changes|status|result|results|next steps?|what you need to do|action(?: needed| for you| required)?|for you|why|how it was tested|testing|tests|files(?: changed)?|open questions|notes?|context|details|findings|key findings|recommendation)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*`;
const LABEL = new RegExp(`^${LABEL_BODY}`, "i");

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
