/**
 * The text of an HTML file Paul uploaded, read out so the chief and the workers can read it.
 *
 * A saved web page or an exported document is mostly not words: styles, script, drawings and pictures
 * written into the file itself can make a few thousand words weigh megabytes, on a handful of enormous
 * lines that an agent's Read tool cannot page through. On 21 Nov 2026 the chief spent every step of two
 * turns trying. So an HTML upload gets the same treatment as a PDF (src/uploads.ts): its text is saved
 * beside it, and that is what is read.
 *
 * This is a reader, not a browser. Nothing in the file is run, fetched or followed: script and style
 * are dropped unread, tags are dropped, and what is left is the words, with headings and list items
 * kept as plain marks. A page that is drawn by its script has no words to find, and that is said.
 *
 * The file is untrusted, so one pass, always forwards: no pattern here can be made to look at the same
 * stretch of the file twice, whatever is left unclosed in it.
 */

export interface HtmlText {
  text: string;
  chars: number;
  words: number;
  /** The text was cut at the caller's limit. */
  truncated: boolean;
}

/** Elements whose contents are not words: dropped whole, up to their closing tag. */
const DROPPED = new Set(["script", "style", "svg", "template", "noscript", "iframe", "object", "canvas", "head", "math", "select", "textarea"]);
/** Elements that end a line. */
const BLOCKS = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "table", "tr", "blockquote", "pre", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "hr", "form", "body", "html"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: "-", middot: "·", copy: "(c)", reg: "(R)", trade: "(TM)", times: "x", rarr: "->", larr: "<-", pound: "£", euro: "€", deg: "°" };

export const isHtmlName = (name: string, mimeType: string) => /\.x?html?$/i.test(name) || /^(text\/html|application\/xhtml\+xml)\b/i.test(mimeType);

/** Whether an upload is an HTML page: by its name or type, and by starting like one. */
export function isHtml(name: string, mimeType: string, data: Buffer): boolean {
  if (!isHtmlName(name, mimeType)) return false;
  return /<(?:!doctype\s+html|html|head|body|div|p|h[1-6]|meta|title)\b/i.test(data.subarray(0, 4096).toString("utf8"));
}

function entity(name: string): string | undefined {
  if (name[0] === "#") {
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    // Control characters are not words, and a code point that does not exist is left as it was written.
    if (!Number.isInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    return code === 160 ? " " : String.fromCodePoint(code);
  }
  return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : undefined;
}

/** The title of the page, from its head, as one plain line. */
function titleOf(html: string, lower: string): string {
  const open = lower.indexOf("<title");
  if (open < 0 || open > 200_000) return "";
  const from = html.indexOf(">", open);
  const close = from < 0 ? -1 : lower.indexOf("</title", from);
  return close < 0 || close - from > 500 ? "" : html.slice(from + 1, close).replace(/\s+/g, " ").trim();
}

export function htmlToText(data: Buffer, maxChars: number): HtmlText {
  const html = data.toString("utf8").replace(/^﻿/, "");
  // Only the plain letters are lowered, so every position in one string is the same position in the other.
  const lower = html.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const out: string[] = [];
  let kept = 0;
  const push = (s: string) => {
    if (!s) return;
    out.push(s);
    kept += s.length;
  };
  const title = titleOf(html, lower);
  if (title) push(`${title}\n\n`);
  let i = 0;
  // Twice the limit is gathered before tidying, since tidying only ever shortens.
  while (i < html.length && kept < maxChars * 2) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      push(html.slice(i));
      break;
    }
    if (lt > i) push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = /^<(\/?)([a-z][a-z0-9-]*)/.exec(lower.slice(lt, lt + 48));
    if (!tag) {
      // A "<" that opens nothing ("a < b", "<!doctype", "<?xml"): a declaration is skipped, anything else is text.
      if (lower[lt + 1] === "!" || lower[lt + 1] === "?") {
        const end = html.indexOf(">", lt);
        i = end < 0 ? html.length : end + 1;
      } else {
        push("<");
        i = lt + 1;
      }
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2]!;
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    i = gt + 1;
    if (!closing && DROPPED.has(name) && html[gt - 1] !== "/") {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) break;
      const endGt = html.indexOf(">", end);
      i = endGt < 0 ? html.length : endGt + 1;
      continue;
    }
    if (name === "br") push("\n");
    else if (name === "li") push(closing ? "" : "\n- ");
    else if (name === "td" || name === "th") push(closing ? " " : "");
    else if (/^h[1-6]$/.test(name)) push(closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `);
    else if (BLOCKS.has(name)) push("\n");
  }
  const tidy = out
    .join("")
    .replace(/&(#x?[0-9a-f]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => entity(name.startsWith("#") ? name : name.toLowerCase()) ?? whole)
    .replace(/\r\n?/g, "\n")
    // Anything that is not a printable character, a tab or a line break is not words.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = tidy.length > maxChars || kept >= maxChars * 2;
  const text = tidy.length > maxChars ? tidy.slice(0, maxChars) : tidy;
  return { text, chars: text.length, words: text ? text.split(/\s+/).filter(Boolean).length : 0, truncated };
}
