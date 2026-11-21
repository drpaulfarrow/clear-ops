import { CLEO, type AppSource } from "./app-data.js";
import { kindName, repoLabel } from "./job-descriptions.js";
import { lockKey } from "./jobs.js";
import { appReportText } from "./reports.js";
import { repoRegistry } from "./repos.js";
import type { Job, Store } from "./store.js";
import { jobTitle } from "./titles.js";
import { PRIVATE_KINDS } from "./trace.js";
import { WEB_CONVERSATION, webTopic, type WebChat, type WebMessage } from "./web-chat.js";

/**
 * The web app's search (docs/APP.md): jobs, their saved reports, and what has been said in the app's
 * own conversations, found by the words Paul types.
 *
 * It finds nothing the app does not already show him, and reads nothing new:
 *
 *  - A job is found by its title, and by its brief unless it is a kind that works over his mail,
 *    calendar, CV or zones (PRIVATE_KINDS) or over a document of his. Those are found by title alone,
 *    as their cards show them.
 *  - A report is searched only where src/reports.ts would serve it (`reportText`), so an assistant, CV
 *    or upload-derived output is never read here either.
 *  - A message is one the app's own transcript keeps (src/web-chat.ts), found by its words, by what
 *    was heard in a voice note, or by the name of a file sent with it. A file's contents are not read.
 *
 * Plain words, all of which must appear, in any order and any case. No pattern is built from what he
 * types. Nothing is written, and nothing here reaches a model.
 */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;
export const SEARCH_WORDS = 6;
export const SEARCH_JOBS = 8;
export const SEARCH_REPORTS = 8;
export const SEARCH_CHATS = 12;
/** How many of the newest finished jobs have their reports looked through. */
export const SEARCH_REPORTS_SCANNED = 400;
/** How much of one report is looked through. */
export const SEARCH_REPORT_CHARS = 200_000;
const SNIPPET_EACH_SIDE = 70;

export interface SearchJob {
  id: string;
  title: string;
  kind: string;
  who: string;
  repositoryName: string;
  status: Job["status"];
  at: string;
  /** Where the words were found in its brief, when it was not the title. */
  snippet?: string;
}

export interface SearchReport {
  /** The job whose report it is. */
  id: string;
  title: string;
  kind: string;
  at: string;
  snippet: string;
}

/** Which of the app's conversations a message is in, in the terms the app opens one by. */
export type SearchWhere = { in: "main" } | { in: "chat"; id: string } | { in: "space"; id: string } | { in: "job"; id: string } | { in: "pull"; repo: string; number: number } | { in: "cleo" };
/** One of the chief's feeds: everywhere but Cleo's own conversation. */
export type FeedWhere = Exclude<SearchWhere, { in: "cleo" }>;

/** Where a thread of the web chat is, and what the app calls it. Undefined: that conversation is gone. */
export function feedPlace(store: Pick<Store, "spaces" | "getJob">, chat: Pick<WebChat, "chat">, thread: string | undefined): { where: FeedWhere; title: string } | undefined {
  if (!thread || thread === WEB_CONVERSATION) return { where: { in: "main" }, title: "Main" };
  const own = /^web:chat:([a-f0-9]{8})$/.exec(thread);
  if (own) return chat.chat(own[1]!) ? { where: { in: "chat", id: own[1]! }, title: chat.chat(own[1]!)!.title } : undefined;
  const topic = webTopic(thread);
  if (!topic) return undefined;
  if ("space" in topic) {
    const mine = store.spaces().find((sp) => sp.id === topic.space);
    if (mine) return { where: { in: "space", id: mine.id }, title: mine.name };
    return repoRegistry.list().some((r) => r.alias === topic.space) ? { where: { in: "space", id: topic.space }, title: repoLabel(topic.space) } : undefined;
  }
  if ("pull" in topic) return { where: { in: "pull", repo: topic.pull.repo, number: topic.pull.number }, title: `Pull request #${topic.pull.number}, ${repoLabel(topic.pull.repo)}` };
  const job = store.getJob(topic.job);
  return job ? { where: { in: "job", id: job.id }, title: `Thread: ${jobTitle(job)}` } : undefined;
}

export interface SearchMessage {
  where: SearchWhere;
  /** The conversation's name, as the app shows it. */
  title: string;
  from: "paul" | "clearops";
  at: string;
  snippet: string;
}

export interface AppSearch {
  q: string;
  /** The words searched for, lower case, so the app can mark them. Empty: there was too little to search for. */
  words: string[];
  jobs: SearchJob[];
  reports: SearchReport[];
  messages: SearchMessage[];
  /** Whether each list was cut short. */
  more: { jobs: boolean; reports: boolean; messages: boolean };
}

/** The words to look for: lower case, a few at most. Empty when what was typed is too short to search for. */
export function searchWords(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const q = raw.slice(0, SEARCH_MAX).toLowerCase().trim();
  if (q.length < SEARCH_MIN) return [];
  return [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, SEARCH_WORDS);
}

const has = (low: string, words: readonly string[]): boolean => words.every((w) => low.includes(w));

/** A line of plain text around the first of the words, with an ellipsis where it was cut. */
export function snippet(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  const at = Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0), flat.length);
  const from = Math.max(0, (at === flat.length ? 0 : at) - SNIPPET_EACH_SIDE);
  const to = Math.min(flat.length, (at === flat.length ? 0 : at) + SNIPPET_EACH_SIDE * 2);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
}

/**
 * A finished job's report as it is searched: lower case and cut to a sane length, kept per job until it
 * finishes again. A report does not change once saved, and a search reads many of them.
 */
type KnownReport = { at: string; text?: string; low?: string };
const reportsKnown = new WeakMap<Store, Map<string, KnownReport>>();

/** A report's words without its Markdown marks (headings, bullets, emphasis, table bars), so a snippet reads as a sentence. */
export const plainReport = (markdown: string): string => markdown.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, "").replace(/[*`|]+/g, " ");

function reportOf(store: Store, job: Job): KnownReport {
  const known = reportsKnown.get(store) ?? new Map<string, KnownReport>();
  reportsKnown.set(store, known);
  const at = job.finishedAt ?? "";
  const kept = known.get(job.id);
  if (kept?.at === at) return kept;
  if (known.size > SEARCH_REPORTS_SCANNED * 2) known.clear();
  const text = appReportText(store, job.id)?.slice(0, SEARCH_REPORT_CHARS);
  const plain = text === undefined ? undefined : plainReport(text);
  const now: KnownReport = { at, ...(plain !== undefined ? { text: plain, low: plain.toLowerCase() } : {}) };
  known.set(job.id, now);
  return now;
}

const when = (j: Job): string => j.finishedAt ?? j.startedAt ?? j.createdAt;

export function appSearch(source: Pick<AppSource, "store">, chat: Pick<WebChat, "kept" | "chat">, raw: unknown): AppSearch {
  const q = typeof raw === "string" ? raw.slice(0, SEARCH_MAX).trim() : "";
  const words = searchWords(raw);
  const out: AppSearch = { q, words, jobs: [], reports: [], messages: [], more: { jobs: false, reports: false, messages: false } };
  if (!words.length) return out;
  const store = source.store;
  const all = store.allJobs().sort((a, b) => when(b).localeCompare(when(a)));

  for (const job of all) {
    const title = jobTitle(job);
    const open = !PRIVATE_KINDS.includes(job.kind) && !job.docSnapshot;
    const inTitle = has(title.toLowerCase(), words);
    if (!inTitle && !(open && has(`${title}\n${job.brief}`.toLowerCase(), words))) continue;
    if (out.jobs.length >= SEARCH_JOBS) {
      out.more.jobs = true;
      break;
    }
    out.jobs.push({ id: job.id, title, kind: job.kind, who: kindName(job.kind), repositoryName: repoLabel(lockKey(job) ?? job.target ?? "product"), status: job.status, at: when(job), ...(inTitle ? {} : { snippet: snippet(job.brief, words) }) });
  }

  for (const job of all.filter((j) => j.status === "done").slice(0, SEARCH_REPORTS_SCANNED)) {
    const { text, low } = reportOf(store, job);
    if (text === undefined || low === undefined || !has(low, words)) continue;
    if (out.reports.length >= SEARCH_REPORTS) {
      out.more.reports = true;
      break;
    }
    out.reports.push({ id: job.id, title: jobTitle(job), kind: job.kind, at: when(job), snippet: snippet(text, words) });
  }

  // What was said aloud is found in Cleo's conversation, whichever feed was open; the rest where it was written.
  const place = (m: WebMessage): { where: SearchWhere; title: string } | undefined => (m.spoken ? { where: { in: "cleo" }, title: CLEO } : feedPlace(store, chat, m.thread));
  for (const m of [...chat.kept()].reverse()) {
    const body = [m.text, m.heard ?? "", ...(m.files ?? [])].join("\n");
    if (!has(body.toLowerCase(), words)) continue;
    const at = place(m);
    // A message whose conversation is gone has nowhere to be opened, so it is not offered.
    if (!at) continue;
    if (out.messages.length >= SEARCH_CHATS) {
      out.more.messages = true;
      break;
    }
    out.messages.push({ ...at, from: m.from, at: m.at, snippet: snippet(body, words) });
  }
  return out;
}

/* ---------- Cleo's conversation: what was said aloud, apart from the chief's feeds ---------- */

export interface AppCleo {
  generatedAt: string;
  /** She can be talked to: the voice is switched on. */
  on: boolean;
  /**
   * What was said, oldest first: his words as transcribed, and hers. Plain text. `feed` is on what she
   * said on coming back from the chief: where his written answer is, when that feed is still there.
   */
  messages: Array<{ id: string; at: string; from: "paul" | "clearops"; text: string; feed?: { where: FeedWhere; title: string } }>;
}

export function appCleo(source: AppSource, chat: Pick<WebChat, "cleo" | "chat">): AppCleo {
  return {
    generatedAt: new Date(source.now ?? Date.now()).toISOString(),
    on: !!source.voice?.(),
    messages: chat.cleo().map((m) => {
      const feed = m.back ? feedPlace(source.store, chat, m.thread) : undefined;
      return { id: m.id, at: m.at, from: m.from, text: m.text, ...(feed ? { feed } : {}) };
    }),
  };
}
