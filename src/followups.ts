import { addDays, fmtDay, londonTime, londonWeekday, londonYmd } from "./london.js";
import type { FollowUp, FollowUpKind, Store } from "./store.js";

/**
 * Follow-up tracking for the executive assistant: who is waiting on Paul, what Paul promised, and who
 * Paul is waiting on. The detectors here are plain text heuristics over his mail (the assistant's
 * model refines the list); the tracker keeps the list in the store with due and stale dates; the
 * nudger tells Paul in chat when items go stale. Nothing here touches Google: the scan that feeds it
 * reads mail through the same GoogleApi door as every other assistant tool (EaTools.scanFollowUps).
 */

/* ---------- Dates ---------- */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** n working days (Mon to Fri) after an instant, at `hour` London time. */
export function addWorkingDays(from: Date, n: number, hour = 17): Date {
  let ymd = londonYmd(from);
  let left = n;
  while (left > 0) {
    ymd = addDays(ymd, 1);
    const wd = londonWeekday(ymd);
    if (wd !== 0 && wd !== 6) left--;
  }
  return londonTime(ymd, hour);
}

/** The next London date after `ymd` falling on weekday `wd` (strictly after). */
function nextWeekday(ymd: string, wd: number): string {
  let d = addDays(ymd, 1);
  while (londonWeekday(d) !== wd) d = addDays(d, 1);
  return d;
}

/**
 * A day mentioned in text, relative to `from`: "today", "tomorrow", "Friday", "end of the week",
 * "next week", "in 3 days", "3d", "2w", "3 Nov", "Nov 3", "2026-11-03". Mode "due" gives the end of
 * that working day (17:00 London) and reads "next week" as its Friday; mode "snooze" gives 09:00 and
 * reads "next week" as its Monday. Undefined when no day is mentioned.
 */
export function parseWhen(text: string, from: Date, mode: "due" | "snooze" = "due"): Date | undefined {
  const t = text.toLowerCase();
  const today = londonYmd(from);
  const hour = mode === "due" ? 17 : 9;
  const at = (ymd: string) => londonTime(ymd, hour);
  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return at(`${m[1]}-${m[2]}-${m[3]}`);
  if ((m = t.match(/^\s*(\d{1,3})\s*(h|d|w)\s*$/))) {
    const n = Number(m[1]);
    if (m[2] === "h") return new Date(from.getTime() + n * 3_600_000);
    return at(addDays(today, m[2] === "w" ? n * 7 : n));
  }
  if ((m = t.match(/\bin (\d{1,3}|a|one|two|three) (day|week)s?\b/))) {
    const n = ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[m[1]] ?? Number(m[1]);
    return at(addDays(today, m[2] === "week" ? n * 7 : n));
  }
  const monthDay = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS.join("|")})[a-z]*\\b`)) ?? t.match(new RegExp(`\\b(${MONTHS.join("|")})[a-z]* (\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (monthDay) {
    const [day, mon] = /\d/.test(monthDay[1]) ? [Number(monthDay[1]), monthDay[2]] : [Number(monthDay[2]), monthDay[1]];
    const month = MONTHS.indexOf(mon.slice(0, 3));
    if (day >= 1 && day <= 31) {
      let year = Number(today.slice(0, 4));
      const ymd = (y: number) => `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (ymd(year) < today) year++;
      return at(ymd(year));
    }
  }
  if (/\b(today|tonight|eod|end of (the )?day|this (afternoon|evening))\b/.test(t)) return mode === "snooze" ? new Date(from.getTime() + 3 * 3_600_000) : at(today);
  if (/\btomorrow\b/.test(t)) return at(addDays(today, 1));
  if (/\bnext week\b/.test(t)) {
    const monday = nextWeekday(today, 1);
    return at(mode === "due" ? addDays(monday, 4) : monday);
  }
  if (/\b(eow|end of (the )?week|this week|by the weekend)\b/.test(t)) {
    const wd = londonWeekday(today);
    return at(wd >= 1 && wd <= 4 ? nextWeekday(today, 5) : wd === 5 ? today : nextWeekday(today, 5));
  }
  const wd = t.match(/\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b/);
  if (wd) {
    const idx = WEEKDAYS.findIndex((d) => d.startsWith(wd[1].slice(0, 3)));
    if (idx >= 0) return at(nextWeekday(today, idx));
  }
  return undefined;
}

/* ---------- Text heuristics ---------- */

/** What the writer actually wrote: quoted replies, forwarded headers and signatures cut off. */
export function ownText(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/i.test(line) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line) || /^-- ?$/.test(line) || /^_{5,}$/.test(line)) break;
    if (/^From: .+/i.test(line) && out.length) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const BOILERPLATE = /let me know if you (have|need) any|any questions,? (please )?let me know|please find attached|please see (the )?attached|please do not reply|unsubscribe|view (this|it) in your browser|if you no longer wish/i;
const REQUEST = /\b(could|can|would|will) you\b|\bplease\b|\blet me know\b|\bany (update|news|thoughts)\b|\bthoughts\b|\bare you (free|available|able|around|up for)\b|\bwhen (can|could|would) (we|you)\b|\bkindly\b|\bwaiting (on|for) (you|your)\b|\bget back to me\b|\bneed (you|your)\b/i;

/** The first sentence that asks the reader something, or undefined. */
export function asksSomething(text: string): string | undefined {
  for (const s of sentences(text)) {
    if (BOILERPLATE.test(s)) continue;
    if (s.endsWith("?") || REQUEST.test(s)) return clip(s);
  }
  return undefined;
}

const COMMIT =
  /\b(i'?ll|i will|i'?m going to|i am going to|i shall|let me|we'?ll|we will|i can)\b[^.?!]{0,60}?\b(send|share|forward|get back|come back|revert|follow up|circle back|check|confirm|look into|look at|find out|dig into|intro(?:duce)?|connect you|put you in touch|draft|write up|review|update you|let you know|loop (?:you )?in|set up|book|schedule|sort out|ping you)\b/i;

/** Things Paul said he would do, with a due date read from the sentence or two working days after he wrote. */
export function findCommitments(text: string, sentAt: Date): Array<{ excerpt: string; due: Date }> {
  const out: Array<{ excerpt: string; due: Date }> = [];
  for (const s of sentences(text)) {
    const probe = s.replace(/\blet me know\b/gi, "");
    if (!COMMIT.test(probe) || s.endsWith("?")) continue;
    out.push({ excerpt: clip(s), due: parseWhen(s, sentAt, "due") ?? addWorkingDays(sentAt, 2) });
  }
  return out;
}

/** Newsletters, notifications and other mail no person is waiting on an answer to. */
export function isAutomated(get: (name: string) => string): boolean {
  if (get("List-Unsubscribe") || get("List-Id")) return true;
  if (/^(bulk|list|junk)$/i.test(get("Precedence").trim())) return true;
  const auto = get("Auto-Submitted").trim();
  if (auto && !/^no$/i.test(auto)) return true;
  return /\b(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|alerts?|calendar-notification)@/i.test(get("From"));
}

/* ---------- The tracker ---------- */

export interface FollowUpCandidate {
  key: string;
  kind: FollowUpKind;
  threadId: string;
  messageId?: string;
  subject: string;
  who: string;
  excerpt: string;
  since: Date;
  dueAt: Date;
  staleAt: Date;
  source: FollowUp["source"];
}

/** Due and stale dates for each kind, from when the email was sent. */
export function datesFor(kind: FollowUpKind, since: Date, due?: Date): { dueAt: Date; staleAt: Date } {
  if (kind === "owed") return { dueAt: addWorkingDays(since, 1), staleAt: addWorkingDays(since, 3) };
  if (kind === "waiting") return { dueAt: addWorkingDays(since, 3), staleAt: addWorkingDays(since, 5) };
  const d = due ?? addWorkingDays(since, 2);
  return { dueAt: d, staleAt: d };
}

export const KIND_LABEL: Record<FollowUpKind, string> = {
  owed: "waiting on you",
  promised: "you promised",
  waiting: "you are waiting on them",
};

/** The follow-up list in the store. */
export class FollowUps {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Adds a new item or refreshes a known one. Something Paul closed stays closed unless newer mail reopens it. */
  upsert(c: FollowUpCandidate): { item: FollowUp; change: "added" | "updated" | "reopened" | "unchanged" } {
    const fields = {
      kind: c.kind,
      threadId: c.threadId,
      messageId: c.messageId,
      subject: c.subject,
      who: c.who,
      excerpt: c.excerpt,
      since: c.since.toISOString(),
      dueAt: c.dueAt.toISOString(),
      staleAt: c.staleAt.toISOString(),
    };
    const found = this.store.findFollowUp(c.key);
    if (!found) return { item: this.store.createFollowUp({ ...fields, key: c.key, status: "open", source: c.source }), change: "added" };
    const newer = fields.since > found.since;
    if (found.status === "done") {
      if (!newer) return { item: found, change: "unchanged" };
      return { item: this.store.updateFollowUp(found.id, { ...fields, status: "open", doneAt: undefined, closedReason: undefined, nudgedAt: undefined, snoozedUntil: undefined }), change: "reopened" };
    }
    if (!newer && found.excerpt === fields.excerpt && found.dueAt === fields.dueAt) return { item: found, change: "unchanged" };
    return { item: this.store.updateFollowUp(found.id, { ...fields, ...(newer ? { nudgedAt: undefined } : {}) }), change: "updated" };
  }

  /** Open items, including snoozed ones whose snooze has run out (they are reopened). Oldest due first. */
  active(): FollowUp[] {
    const now = this.now().toISOString();
    for (const f of this.store.listFollowUps()) {
      if (f.status === "snoozed" && f.snoozedUntil && f.snoozedUntil <= now) this.store.updateFollowUp(f.id, { status: "open" });
    }
    return this.store
      .listFollowUps()
      .filter((f) => f.status === "open")
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  snoozed(): FollowUp[] {
    this.active();
    return this.store.listFollowUps().filter((f) => f.status === "snoozed");
  }

  /** An item by id, or by a unique prefix of its id. */
  find(id: string): FollowUp | undefined {
    const q = id.trim().toLowerCase();
    const exact = this.store.getFollowUp(q);
    if (exact) return exact;
    const hits = this.store.listFollowUps().filter((f) => f.id.startsWith(q));
    return q.length >= 3 && hits.length === 1 ? hits[0] : undefined;
  }

  close(id: string, reason = "done"): FollowUp | undefined {
    const f = this.find(id);
    if (!f) return undefined;
    return this.store.updateFollowUp(f.id, { status: "done", doneAt: this.now().toISOString(), closedReason: reason });
  }

  /** Closes the open item with this key, if any (the thread moved on). */
  closeKey(key: string, reason: string): FollowUp | undefined {
    const f = this.store.findFollowUp(key);
    if (!f || f.status === "done") return undefined;
    return this.store.updateFollowUp(f.id, { status: "done", doneAt: this.now().toISOString(), closedReason: reason });
  }

  snooze(id: string, until: Date): FollowUp | undefined {
    const f = this.find(id);
    if (!f) return undefined;
    return this.store.updateFollowUp(f.id, { status: "snoozed", snoozedUntil: until.toISOString(), nudgedAt: undefined, doneAt: undefined, closedReason: undefined });
  }

  isStale(f: FollowUp): boolean {
    return f.status === "open" && f.staleAt <= this.now().toISOString();
  }

  /**
   * Stale items Paul has not been nudged about yet. An item is nudged once when it goes stale, and
   * once more each time a snooze on it runs out.
   */
  toNudge(): FollowUp[] {
    const now = this.now().toISOString();
    return this.active().filter((f) => {
      const staleFrom = f.snoozedUntil && f.snoozedUntil > f.staleAt ? f.snoozedUntil : f.staleAt;
      return staleFrom <= now && (!f.nudgedAt || f.nudgedAt < staleFrom);
    });
  }

  markNudged(items: FollowUp[]): void {
    const now = this.now().toISOString();
    for (const f of items) this.store.updateFollowUp(f.id, { nudgedAt: now });
  }

  /** One line per item, for chat and for the assistant (who sees it fenced, since it quotes email). */
  line(f: FollowUp): string {
    const stale = this.isStale(f) ? " · STALE" : "";
    const snooze = f.status === "snoozed" && f.snoozedUntil ? ` · snoozed to ${fmtDay(new Date(f.snoozedUntil))}` : "";
    const who = f.kind === "promised" ? `to ${f.who}` : f.who;
    return `${f.id} · ${KIND_LABEL[f.kind]} · ${who} · "${f.subject}" · ${f.kind === "waiting" ? "chase" : "due"} ${fmtDay(new Date(f.dueAt))}${stale}${snooze}\n   ${f.excerpt} (thread ${f.threadId})`;
  }

  text(items: FollowUp[] = this.active()): string {
    if (!items.length) return "No open follow-ups.";
    const groups: FollowUpKind[] = ["owed", "promised", "waiting"];
    const head: Record<FollowUpKind, string> = { owed: "Waiting on you", promised: "You promised", waiting: "You are waiting on" };
    return groups
      .map((k) => {
        const g = items.filter((f) => f.kind === k);
        return g.length ? `${head[k]}:\n${g.map((f) => this.line(f)).join("\n")}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
}

export const FOLLOWUP_COMMANDS = `Reply "done <id>", "snooze <id> 2d" (or monday, next week, 3 Nov), or "draft nudge <id>" for someone you are waiting on.`;

/** The chat message for items that have just gone stale. */
export function nudgeText(items: FollowUp[]): string {
  // Plain sentences, like a colleague would say it: the first few items, then a pointer to the rest.
  const shown = items.slice(0, 4);
  const parts = shown.map((f) => {
    const what =
      f.kind === "owed" ? `${f.who} is waiting on you` : f.kind === "promised" ? `you promised ${f.who} "${clip(f.excerpt.replace(/\s+/g, " ").trim(), 80)}"` : `no reply from ${f.who} yet`;
    return `${f.id} ${what} ("${clip(f.subject.replace(/\s+/g, " ").trim(), 60)}", since ${fmtDay(new Date(f.since))})`;
  });
  const more = items.length > shown.length ? ` There ${items.length - shown.length === 1 ? "is 1 more" : `are ${items.length - shown.length} more`} in /followups.` : "";
  const head = items.length === 1 ? "One follow-up has gone stale" : `${items.length} follow-ups have gone stale`;
  return `${head}: ${parts.join("; ")}.${more} ${FOLLOWUP_COMMANDS}`;
}

/** Where follow-up nudges and hold releases go: the chat Google was connected from, else the morning brief's. */
export function eaHome(store: Store): string | undefined {
  return store.settings().eaReplyTo ?? store.listSchedules().find((s) => s.enabled && s.kind === "ea")?.replyTo;
}

/** Sends one nudge for everything newly stale. Returns how many items it covered. */
export async function nudgeStale(store: Store, messenger: { send(to: string, text: string): Promise<void> }, now: () => Date = () => new Date()): Promise<number> {
  const to = eaHome(store);
  if (!to) return 0;
  const tracker = new FollowUps(store, now);
  const items = tracker.toNudge();
  if (!items.length) return 0;
  await messenger.send(to, nudgeText(items));
  tracker.markNudged(items);
  return items.length;
}
