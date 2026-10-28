/** Paul works in London: wall-clock helpers for Europe/London, shared by the assistant's tools. */

/** Minutes east of UTC for Europe/London at an instant (0 in winter, 60 in summer). */
function londonOffsetMinutes(at: Date): number {
  const tz = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** A London wall-clock time on a London date, as a UTC instant. */
export function londonTime(ymd: string, hh: number, mm = 0): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60_000);
}

/** The London date of an instant, as YYYY-MM-DD. */
export function londonYmd(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** 0 Sunday to 6 Saturday, for a London date. */
export function londonWeekday(ymd: string): number {
  return londonTime(ymd, 12).getUTCDay();
}

/** The London date n calendar days after ymd. */
export function addDays(ymd: string, n: number): string {
  const d = londonTime(ymd, 12);
  d.setUTCDate(d.getUTCDate() + n);
  return londonYmd(d);
}

/** "Thu 29 Oct, 14:00" in London time. */
export const fmt = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);

/** "Thu 29 Oct" in London time. */
export const fmtDay = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).format(d);
