import { GoogleError, isHold, type GoogleApi } from "./google.js";
import { fmt, londonTime, londonYmd } from "./london.js";
import type { HoldGroup, Store } from "./store.js";
import type { Interval } from "./ea.js";
import { eaHome } from "./followups.js";

/**
 * Scheduling a meeting: pick two or three proposed times from free windows, and once a real meeting
 * with that person is confirmed on Paul's calendar, release the other holds.
 *
 * The release runs in the service, not in a model: it removes only events recorded in a hold group
 * (holds placed by an ea job Paul granted the holds permit to), and every removal still goes through
 * GoogleApi, which re-checks the event is the assistant's own hold with nobody invited.
 */

/** The private property tying a hold to its group, beside the hold marker. */
export const HOLD_GROUP = "clearOpsHoldGroup";

const STEP = 30 * 60_000;

/**
 * Up to `count` meeting times of `minutes` from free windows: on different days where possible,
 * on the half hour, preferring 10:00 to 16:00 London time.
 */
export function pickSlots(free: Interval[], minutes: number, count: number): Interval[] {
  const dur = minutes * 60_000;
  const candidates: Interval[] = [];
  for (const w of free) {
    let t = Math.ceil(w.start.getTime() / STEP) * STEP;
    while (t + dur <= w.end.getTime()) {
      candidates.push({ start: new Date(t), end: new Date(t + dur) });
      t += STEP;
    }
  }
  const hourOf = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(d));
  const core = (s: Interval) => hourOf(s.start) >= 10 && hourOf(s.start) < 16;
  const picked: Interval[] = [];
  const overlaps = (s: Interval) => picked.some((p) => s.start < p.end && p.start < s.end);
  const days = new Set<string>();
  // Pass 1: one per day, core hours. Pass 2: one per day, any hour. Pass 3: anything that does not overlap.
  for (const pass of [1, 2, 3]) {
    for (const s of candidates) {
      if (picked.length >= count) break;
      const day = londonYmd(s.start);
      if (overlaps(s) || (pass < 3 && days.has(day)) || (pass === 1 && !core(s))) continue;
      picked.push(s);
      days.add(day);
    }
  }
  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The paragraph for the draft: the proposed times and, if Paul has one, his booking link. */
export function slotsParagraph(slots: Interval[], bookingLink?: string): string {
  const times = slots.map((s) => fmt(s.start)).join("; ");
  const link = bookingLink ? ` If none of those suit, pick any time that works for you here: ${bookingLink}` : "";
  return `Would any of these work (London time)? ${times}.${link}`;
}

/** Google Calendar appointment-schedule links only: these go into drafts Paul sends. */
export function validBookingLink(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    if (u.hostname === "calendar.app.google" || (u.hostname === "calendar.google.com" && u.pathname.startsWith("/calendar/appointments/"))) return u.toString();
  } catch {
    // not a URL
  }
  return undefined;
}

interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  created?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

/**
 * A real meeting with one of the group's people, made after the holds were placed, that Paul has
 * confirmed: he organised it (an appointment-schedule booking does that) or accepted the invitation.
 */
export function confirms(ev: CalEvent, g: HoldGroup): boolean {
  if (ev.status === "cancelled" || isHold(ev as unknown as Record<string, unknown>) || !ev.start?.dateTime) return false;
  if (g.holds.some((h) => h.eventId === ev.id)) return false;
  if (ev.created && ev.created < g.createdAt) return false;
  const people = new Set([...(ev.attendees ?? []).map((a) => a.email?.toLowerCase()), ev.organizer?.email?.toLowerCase()].filter(Boolean) as string[]);
  if (!g.with.some((w) => people.has(w))) return false;
  const me = (ev.attendees ?? []).find((a) => a.self);
  return ev.organizer?.self === true || me?.responseStatus === "accepted" || me?.responseStatus === "tentative";
}

/** Watches open hold groups and releases the holds once the meeting is confirmed. */
export class HoldWatcher {
  constructor(
    private readonly store: Store,
    private readonly api: GoogleApi,
    private readonly messenger: { send(to: string, text: string): Promise<void> },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One pass. Returns what it reported. */
  async tick(): Promise<string[]> {
    const now = this.now();
    const open = this.store.listHoldGroups().filter((g) => g.status === "open");
    if (!open.length) return [];
    const reports: string[] = [];
    // Groups whose proposed times have all passed with no meeting: nothing left to release.
    const live = open.filter((g) => {
      if (g.holds.length && g.holds.every((h) => h.end < now.toISOString())) {
        this.store.updateHoldGroup(g.id, { status: "expired", closedAt: now.toISOString() });
        return false;
      }
      return g.with.length > 0;
    });
    if (!live.length) return [];
    const r = await this.api.request<{ items?: CalEvent[] }>("calendar", "GET", "calendars/primary/events", {
      query: {
        timeMin: new Date(now.getTime() - 86_400_000).toISOString(),
        timeMax: londonTime(londonYmd(new Date(now.getTime() + 90 * 86_400_000)), 23).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
      },
    });
    const events = r.items ?? [];
    for (const g of live) {
      const meeting = events.find((ev) => confirms(ev, g));
      if (!meeting) continue;
      const released: string[] = [];
      const kept: string[] = [];
      for (const h of g.holds) {
        try {
          await this.api.request("calendar", "DELETE", `calendars/primary/events/${encodeURIComponent(h.eventId)}`, { query: { sendUpdates: "none" } });
          released.push(fmt(new Date(h.start)));
        } catch (err) {
          // Already deleted by Paul, or no longer a hold (he turned it into something else): leave it.
          if (!(err instanceof GoogleError)) throw err;
          if (!/404|410|not found|deleted/i.test(err.message)) kept.push(fmt(new Date(h.start)));
        }
      }
      this.store.updateHoldGroup(g.id, { status: "confirmed", confirmedEventId: meeting.id, closedAt: now.toISOString() });
      const when = meeting.start?.dateTime ? fmt(new Date(meeting.start.dateTime)) : "";
      const text = `Meeting confirmed: ${(meeting.summary ?? g.title).replace(/[\r\n]+/g, " ").slice(0, 80)}, ${when}. ${released.length ? `Released ${released.length} hold(s): ${released.join("; ")}.` : "No holds left to release."}${kept.length ? ` Left alone (no longer the assistant's holds): ${kept.join("; ")}.` : ""}`;
      reports.push(text);
      const to = g.replyTo ?? eaHome(this.store);
      if (to) await this.messenger.send(to, text).catch(() => undefined);
    }
    return reports;
  }
}
