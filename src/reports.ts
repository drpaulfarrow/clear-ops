/**
 * The reports view: every saved job output, and every deck or one-pager, as a page Paul can read on his
 * phone. Paul's call, 16 November 2026: an output should always be handed to him in a form he can click
 * to view, never only as a file path or by typing "show job".
 *
 * Long reports are written as Markdown and saved in DATA_DIR/outputs/<id>.md; decks and one-pagers are
 * saved in DATA_DIR/decks. This serves both as proper pages at a stable address, so a deep research
 * report, a review, an analysis, a deck or a one-pager can be read in a browser rather than as raw
 * Markdown on a volume.
 *
 * Three shapes of page, one gate and one long-lived token:
 *
 *  - `/reports?t=<token>` is the index: every saved output, newest first, with its title, kind, London
 *    date, job id and a link, plus a link to the decks.
 *  - `/reports/<id>?t=<token>` is one output. When the worker also wrote a self-contained
 *    `<id>.html` beside the Markdown (the brief asks for one in some jobs), that file is served
 *    as-is under a strict Content-Security-Policy; otherwise the Markdown is rendered here.
 *  - `/decks?t=<token>` lists the files in the private decks folder and `/decks/<name>?t=<token>`
 *    opens one. The folder is read on each request, so a file a worker has just saved appears without
 *    a restart.
 *
 * What it will not do. The Markdown is rendered by this file and nothing else: every character of the
 * output is escaped before any markup is added, so raw HTML, a script tag or an event attribute in a
 * report or a deck is shown as text and never runs. The pages carry no script, no cookie, no form and no
 * request to anywhere (the Content-Security-Policy is `default-src 'none'`). Nothing here writes: there
 * is no route that changes a job, a queue or a schedule, and no token, path or secret of the service's
 * own ever reaches the page.
 *
 * Every finished job's saved output is served, whatever its kind or provenance: an assistant (ea) or CV
 * output and anything derived from a file Paul uploaded are here too. This is deliberately wider than
 * the copy in the private outputs repository (src/output-folders.ts `classify`), which is unchanged: what
 * is copied into a repository and what Paul may open in a browser behind his own password are two
 * different questions. An output with no job record still cannot be listed (there is no title, kind or
 * date for it), and nothing from the decks folder or an upload ever leaves this view.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { deckDir } from "./decks.js";
import { londonYmd } from "./london.js";
import { jobTitle } from "./titles.js";
import { SIGN_OUT_PATH } from "./sign-in.js";
import type { Job, Store } from "./store.js";

export const REPORTS_PATH = "/reports";
/** The decks and one-pagers the advisor and CV kinds save, listed and opened behind the same token. */
export const DECKS_PATH = "/decks";
/** The index refreshes itself slowly, so a report that lands while Paul is looking appears in time. */
export const REPORTS_REFRESH_SECONDS = 60;
/** The index is a list of links, not an archive: the newest this many saved outputs. */
const MAX_ENTRIES = 200;
/** A saved .html page bigger than this is treated as not there rather than served. */
const MAX_HTML_BYTES = 4 * 1024 * 1024;
/** A deck file bigger than this is treated as not there rather than served (the writer caps at 200 KB). */
const MAX_DECK_BYTES = 2 * 1024 * 1024;
/** An output is named after its job id; anything else is never read, so no path can escape the folder. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A deck is one plain file name, Markdown or plain text: no directory, no climb, nothing else. */
const DECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(md|txt)$/i;

/* ---------- The token: minted once by the service, kept in the store, never logged ---------- */

type TokenStore = Pick<Store, "settings" | "setSetting">;

/** The reports view's own long-lived token, minted on first use and kept in the store. */
export function reportsToken(store: TokenStore): string {
  const existing = store.settings().reportsToken;
  if (existing) return existing;
  const token = randomBytes(24).toString("base64url");
  store.setSetting("reportsToken", token);
  return token;
}

/** The bookmarkable reports link, printed in chat by /reports. The token rides in the query string. */
export function reportsUrl(store: TokenStore): string {
  return `${config.publicUrl}${REPORTS_PATH}?t=${reportsToken(store)}`;
}

/** True only for the exact token the service minted, compared in constant time. */
export function reportsTokenValid(store: TokenStore, token: string): boolean {
  const expected = store.settings().reportsToken;
  if (!expected || !token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/* ---------- Which saved outputs may be served ---------- */

export interface ReportEntry {
  id: string;
  title: string;
  /** The worker kind, raw ("research"). */
  kind: string;
  /** London date the job finished, YYYY-MM-DD. */
  date: string;
  /** ISO time, for ordering newest first. */
  at: string;
  /** A self-contained .html page was saved beside the Markdown, so that is what the link opens. */
  html: boolean;
}

export interface ReportPage {
  entry: ReportEntry;
  /** The saved Markdown, rendered here. Absent when a saved .html page is served instead. */
  markdown?: string;
  /** The saved .html page to serve as-is. Absent when the Markdown is rendered. */
  htmlPath?: string;
}

/**
 * The saved output of a finished job. Every finished job's saved output is served, whatever its kind or
 * provenance. Only what is not a finished job with a saved output is missing: a job still running, a
 * failed job, or a job whose report was never written.
 */
function servable(store: Store, job: Job): string | undefined {
  if (job.status !== "done") return undefined;
  return store.readOutput(job.id);
}

/** The self-contained .html page saved beside a job's output, when there is one and it is a sane size. */
export function savedHtmlPath(store: Pick<Store, "dir">, id: string): string | undefined {
  if (!ID.test(id)) return undefined;
  const p = path.join(store.dir, "outputs", `${id}.html`);
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0 || st.size > MAX_HTML_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return p;
}

function entryFor(job: Job, html: boolean): ReportEntry {
  const at = job.finishedAt ?? job.createdAt;
  return { id: job.id, title: jobTitle(job), kind: job.kind, date: londonYmd(new Date(at)), at, html };
}

const newestFirst = (a: Job, b: Job) =>
  (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt) || b.id.localeCompare(a.id);

/** Every saved output that may be served, newest first. */
export function reportEntries(store: Store): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const job of store.allJobs().filter((j) => j.status === "done").sort(newestFirst)) {
    if (out.length >= MAX_ENTRIES) break;
    if (servable(store, job) === undefined) continue;
    out.push(entryFor(job, savedHtmlPath(store, job.id) !== undefined));
  }
  return out;
}

/** One saved output, ready to serve: the .html page beside it when there is one, else its Markdown. */
export function reportFor(store: Store, id: string): ReportPage | undefined {
  if (!ID.test(id)) return undefined;
  const job = store.getJob(id);
  if (!job) return undefined;
  const text = servable(store, job);
  if (text === undefined) return undefined;
  const htmlPath = savedHtmlPath(store, id);
  return { entry: entryFor(job, htmlPath !== undefined), ...(htmlPath ? { htmlPath } : { markdown: text }) };
}

/**
 * The clickable link to one saved output, with the token, or undefined when that output is not served
 * (a job still running, a failed job, no saved output). This is what a job's finish message, the chief's
 * `get_output` and `show job` hand Paul, so an output is never given to him as a file path alone.
 */
export function reportUrlFor(store: Store, id: string): string | undefined {
  if (!reportFor(store, id)) return undefined;
  return `${config.publicUrl}${REPORTS_PATH}/${id}?t=${reportsToken(store)}`;
}

/* ---------- Decks and one-pagers (DATA_DIR/decks), read on each request ---------- */

export interface DeckEntry {
  /** The file name exactly as it is on disk. */
  name: string;
  /** A heading for the page: the name without its extension, dashes and underscores as spaces. */
  title: string;
  /** London date it was last written, YYYY-MM-DD. */
  date: string;
  /** ISO time, for ordering newest first. */
  at: string;
}

export interface DeckPage {
  entry: DeckEntry;
  /** The file's text, rendered here. */
  content: string;
}

/** True only for one plain Markdown or text file name in the decks folder: never a path, never a climb. */
export function deckNameOk(name: string): boolean {
  return DECK_NAME.test(name) && !name.includes("..");
}

/** The path of one deck file, only when its name is one plain file and it resolves inside the folder. */
export function deckFilePath(name: string): string | undefined {
  if (!deckNameOk(name)) return undefined;
  const root = path.resolve(deckDir());
  const p = path.resolve(root, name);
  return p.startsWith(root + path.sep) ? p : undefined;
}

const deckTitle = (name: string): string => name.replace(/\.(?:md|txt)$/i, "").replace(/[-_]+/g, " ").trim() || name;

function deckStat(name: string): { path: string; stat: fs.Stats } | undefined {
  const p = deckFilePath(name);
  if (!p) return undefined;
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_DECK_BYTES) return undefined;
    return { path: p, stat };
  } catch {
    return undefined;
  }
}

const deckEntry = (name: string, stat: fs.Stats): DeckEntry => ({
  name,
  title: deckTitle(name),
  date: londonYmd(stat.mtime),
  at: stat.mtime.toISOString(),
});

/**
 * Every deck or one-pager in the private folder, newest first. The directory is read here on each call,
 * so a file a worker saved a moment ago is listed without a restart; a file that is too big, empty, not
 * a plain Markdown or text file, or not a regular file is simply not listed.
 */
export function deckEntries(): DeckEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(deckDir());
  } catch {
    return [];
  }
  const out: DeckEntry[] = [];
  for (const name of names) {
    const found = deckStat(name);
    if (found) out.push(deckEntry(name, found.stat));
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
}

/** One deck or one-pager, ready to serve. Undefined for a name that is not one file in the folder. */
export function deckFor(name: string): DeckPage | undefined {
  const found = deckStat(name);
  if (!found) return undefined;
  try {
    return { entry: deckEntry(name, found.stat), content: fs.readFileSync(found.path, "utf8") };
  } catch {
    return undefined;
  }
}

/* ---------- Markdown, rendered here ---------- */

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Only these address shapes ever become a link. Everything else, a `javascript:` or `data:` above all, is left as plain text. */
const SAFE_URL = /^(?:https?:\/\/|mailto:)[^\s]*$/i;

/** A list item's marker, with its indentation: a bullet, or a number and a dot or bracket. */
const MARKER = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

const indentOf = (line: string): number => (line.match(/^ */)?.[0].length ?? 0);
const blank = (line: string): boolean => !line.trim();

const isRule = (line: string): boolean => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);

/** The cells of a table row: the outer pipes are dropped and each cell is trimmed. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** The row under a table's header: `| --- | :---: |`, and nothing else. */
function isSeparatorRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const cs = cells(line);
  return cs.length > 0 && cs.every((c) => /^:?-+:?$/.test(c));
}

/**
 * One line of prose: code spans, links, bold and italic, on text that is escaped first, so nothing an
 * output contains can become markup or an attribute. Code spans are lifted out before the escaping so
 * a backtick's contents are never read as anything but code.
 */
export function inline(raw: string): string {
  const codes: string[] = [];
  const held = raw.replace(/`+([^`]+)`+/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  let s = escapeHtml(held);
  // [text](address) and <address>. The address is used exactly as it was escaped, so it can never
  // break out of the attribute, and it must be http(s) or mailto to become a link at all.
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, text: string, inside: string) => {
    const url = inside.trim().split(/\s+/)[0] ?? "";
    return SAFE_URL.test(url) ? `<a href="${url}" rel="noopener noreferrer">${text}</a>` : text;
  });
  s = s.replace(/&lt;((?:https?|mailto):[^\s&]*?)&gt;/g, (_m, url: string) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^\s*][^*]*?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^\s*][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^\s_][^_]*?)_(?!_)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => `<code>${escapeHtml(codes[Number(n)] ?? "")}</code>`);
}

/** A line that ends the paragraph above it: a fence, a heading, a rule, a quote, a list or a table. */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(l)) return true;
  if (/^ {0,3}#{1,6}\s/.test(l)) return true;
  if (isRule(l)) return true;
  if (/^ {0,3}>/.test(l)) return true;
  if (MARKER.test(l)) return true;
  return l.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]);
}

/** One list item: its lead-in line, then whatever blocks follow it (usually a nested list). */
function listItem(text: string): string {
  const lines = text.split("\n");
  const first = (lines.shift() ?? "").trim();
  const rest = lines.join("\n").trim();
  return `${first ? inline(first) : ""}${rest ? blocks(rest.split("\n")) : ""}`;
}

/** A list, with the indent of its first marker as the level: deeper markers nest inside the item. */
function list(lines: string[], start: number): [string, number] {
  const first = lines[start].match(MARKER)!;
  const base = first[1].length;
  const ordered = first[3] !== undefined;
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(MARKER);
    if (m && m[1].length <= base && (m[3] !== undefined) === ordered) {
      items.push(m[4]);
      i++;
      continue;
    }
    if (blank(lines[i])) {
      // A blank line ends the list unless something indented follows it.
      let j = i + 1;
      while (j < lines.length && blank(lines[j])) j++;
      if (j < lines.length && indentOf(lines[j]) > base) {
        items[items.length - 1] += "\n";
        i++;
        continue;
      }
      break;
    }
    if (indentOf(lines[i]) > base) {
      // A wrapped line or a nested list: keep it with the item, its extra indent trimmed back.
      items[items.length - 1] += `\n${lines[i].slice(Math.min(indentOf(lines[i]), base + 2))}`;
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && first[3] !== "1" ? ` start="${first[3]}"` : "";
  const html = `<${tag}${startAttr}>${items.map((it) => `<li>${listItem(it)}</li>`).join("")}</${tag}>`;
  return [html, i];
}

function table(head: string[], rows: string[][]): string {
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const body = rows.map((r) => `<tr>${head.map((_h, n) => `<td>${inline(r[n] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The blocks of a Markdown document. Every branch consumes at least one line; every value is escaped. */
function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{3,}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence, or the end of the document
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2].toLowerCase())}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const n = heading[1].length;
      out.push(`<h${n}>${inline(heading[2])}</h${n}>`);
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !isSeparatorRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(table(head, rows));
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (blank(lines[i]) && i + 1 < lines.length && /^ {0,3}>/.test(lines[i + 1])))) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push(`<blockquote>${blocks(inner)}</blockquote>`);
      continue;
    }
    if (MARKER.test(line)) {
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  return out.join("\n");
}

/** The saved Markdown as clean HTML. This is the only renderer, and it executes nothing. */
export function renderMarkdown(src: string): string {
  return blocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/**
 * A saved report often opens with its own title as a heading, and the page already shows it above the
 * report. That one repeated heading is dropped; anything else the report says is left exactly as it is.
 */
export function dropRepeatedTitle(markdown: string, title: string): string {
  const same = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want = same(title);
  if (!want) return markdown;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const heading = lines[i]?.match(/^ {0,3}#\s+(.*?)\s*#*\s*$/);
  return heading && same(heading[1]) === want ? lines.slice(i + 1).join("\n") : markdown;
}

/* ---------- The pages ---------- */

/**
 * One stylesheet for the reading pages, inline and fetched from nowhere (the policy is
 * `default-src 'none'`). Same palette and type as the service's other pages
 * (src/page-style.ts), laid out for a long read rather than a form.
 */
const STYLE = `:root{--bg:#faf7f2;--ink:#221e1a;--muted:#6e665e;--line:#e8e0d5;--code:#f2ece2}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:1rem;line-height:1.6}
main{max-width:40rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h1,h2,h3,h4,h5,h6{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;font-weight:500;line-height:1.25;letter-spacing:-.01em;margin:1.6em 0 .5em}
h1{font-size:1.6rem;margin-top:.2em}
h2{font-size:1.3rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
h3{font-size:1.12rem}
h4,h5,h6{font-size:1rem}
p{margin:.8em 0}
a{color:#2f4a3f;text-underline-offset:2px}
ul,ol{margin:.7em 0;padding-left:1.4em}
li{margin:.25em 0}
li>ul,li>ol{margin:.25em 0}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;background:var(--code);border-radius:4px;padding:.1em .3em;overflow-wrap:anywhere}
pre{background:var(--code);border-radius:10px;padding:.8rem .9rem;overflow-x:auto;line-height:1.45}
pre code{background:none;padding:0;font-size:.8rem}
blockquote{margin:.9em 0;padding:.1em 0 .1em .9em;border-left:3px solid var(--line);color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9rem;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
.crumb{font-size:.85rem;margin:0 0 1rem}
.meta{color:var(--muted);font-size:.85rem;margin:.3rem 0 1.5rem}
.id{font-family:ui-monospace,Menlo,Consolas,monospace}
.report{border:1px solid var(--line);border-radius:10px;padding:.65rem .8rem;margin:.5rem 0;background:#fff}
.report .t{font-weight:600}
.report .t a{text-decoration:none}
.report .m{font-size:.82rem;color:var(--muted);margin-top:.15rem}
.badge{display:inline-block;font-size:.72rem;padding:.05rem .4rem;border-radius:999px;background:var(--code);color:#4a423a;margin-left:.35rem;vertical-align:middle}
.note{color:var(--muted);font-size:.85rem;margin:.2rem 0 1rem}
.empty{color:var(--muted)}
footer{max-width:40rem;margin:0 auto;padding:0 1.25rem 3rem;color:var(--muted);font-size:.85rem}`;

const document_ = (title: string, body: string, refresh?: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""
  }<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

/** The link to one report, with the token so the page opens without anything else. */
function reportHref(id: string, token: string): string {
  return `${REPORTS_PATH}/${id}?t=${escapeHtml(token)}`;
}

/** The link to the decks listing, with the token. */
function decksHref(token: string): string {
  return `${DECKS_PATH}?t=${escapeHtml(token)}`;
}

/** The link to one deck file. The name is percent-encoded, so a space or a dot cannot break the address. */
function deckHref(name: string, token: string): string {
  return `${DECKS_PATH}/${encodeURIComponent(name)}?t=${escapeHtml(token)}`;
}

/** The index: every saved output, newest first. Titles, kind, date and id only, never any text. */
export function renderReportsIndex(entries: ReportEntry[], token: string): string {
  const rows = entries
    .map(
      (e) =>
        `<div class="report"><div class="t"><a href="${reportHref(e.id, token)}">${escapeHtml(e.title)}</a>${e.html ? `<span class="badge">formatted</span>` : ""}</div>` +
        `<div class="m">${escapeHtml(e.kind)} &middot; ${escapeHtml(e.date)} &middot; <span class="id">${escapeHtml(e.id)}</span></div></div>`,
    )
    .join("");
  const body =
    `<main><h1>Saved reports</h1>` +
    `<p class="note">Every saved job output, newest first. Read only; the pages carry no script and fetch nothing. ` +
    `Also here: <a href="${decksHref(token)}">decks and one-pagers</a>. <a href="${SIGN_OUT_PATH}">Sign out</a>.</p>` +
    (rows || `<p class="empty">Nothing saved yet.</p>`) +
    `</main>`;
  return document_("Saved reports", body, `${REPORTS_REFRESH_SECONDS}; url=${REPORTS_PATH}?t=${escapeHtml(token)}`);
}

/** One report: the Markdown as HTML, with a way back to the index without retyping anything. */
export function renderReportPage(entry: ReportEntry, markdown: string, token: string): string {
  const crumb = `<p class="crumb"><a href="${REPORTS_PATH}?t=${escapeHtml(token)}">&larr; All reports</a> &middot; <a href="${SIGN_OUT_PATH}">Sign out</a></p>`;
  const body =
    `<main>${crumb}<h1>${escapeHtml(entry.title)}</h1>` +
    `<p class="meta">${escapeHtml(entry.kind)} &middot; ${escapeHtml(entry.date)} &middot; <span class="id">${escapeHtml(entry.id)}</span></p>` +
    `${renderMarkdown(dropRepeatedTitle(markdown, entry.title))}</main>`;
  return document_(entry.title, body);
}

/** The decks listing: name, date and a link each, never any text from a file. */
export function renderDecksIndex(entries: DeckEntry[], token: string): string {
  const rows = entries
    .map(
      (e) =>
        `<div class="report"><div class="t"><a href="${deckHref(e.name, token)}">${escapeHtml(e.title)}</a></div>` +
        `<div class="m">${escapeHtml(e.date)} &middot; <span class="id">${escapeHtml(e.name)}</span></div></div>`,
    )
    .join("");
  const body =
    `<main><h1>Decks and one-pagers</h1>` +
    `<p class="note">Every file the advisor and CV writers saved, newest first. Read only; the pages carry no script and fetch nothing. ` +
    `<a href="${REPORTS_PATH}?t=${escapeHtml(token)}">All reports</a> &middot; <a href="${SIGN_OUT_PATH}">Sign out</a>.</p>` +
    (rows || `<p class="empty">Nothing saved yet.</p>`) +
    `</main>`;
  return document_("Decks and one-pagers", body, `${REPORTS_REFRESH_SECONDS}; url=${decksHref(token)}`);
}

/** One deck or one-pager: Markdown rendered here, a plain text file shown escaped in a block. */
export function renderDeckPage(entry: DeckEntry, content: string, token: string): string {
  const crumb = `<p class="crumb"><a href="${decksHref(token)}">&larr; Decks and one-pagers</a> &middot; <a href="${SIGN_OUT_PATH}">Sign out</a></p>`;
  const rendered = /\.md$/i.test(entry.name)
    ? renderMarkdown(dropRepeatedTitle(content, entry.title))
    : `<pre>${escapeHtml(content)}</pre>`;
  const body =
    `<main>${crumb}<h1>${escapeHtml(entry.title)}</h1>` +
    `<p class="meta">${escapeHtml(entry.date)} &middot; <span class="id">${escapeHtml(entry.name)}</span></p>` +
    `${rendered}</main>`;
  return document_(entry.title, body);
}

/** A plain page for a refused or missing link. Never echoes the token or anything from the request. */
export function reportsRefusedPage(): string {
  return document_("Not found", `<main><h1>Not found</h1><p class="note">That link is not valid.</p></main>`);
}

/**
 * The headers a page of this view is served with. Both are `default-src 'none'` with no script of any
 * kind allowed; the pages the service renders need inline styles, and a saved .html file is given the
 * stricter policy plus a sandbox, so it cannot run a script, post a form or reach anywhere, even if
 * the worker that wrote it put one in.
 */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";
