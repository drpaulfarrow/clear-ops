/**
 * Uptime and downtime, for the jobs board.
 *
 * Uptime here means one thing only and the page says so: the service was recording its own heartbeat.
 * Nothing outside this machine is probed to decide whether the service is up, and a gap means the
 * service was not sampling, which on Fly usually means it was restarting or being redeployed. The
 * board never claims the site was down for the public, because this cannot know that.
 *
 * A heartbeat is one short line appended to `uptime.jsonl` in the data directory on a fixed interval
 * (one minute), so a write is a few bytes and the file is bounded: lines older than
 * `RETENTION_MS` (14 days) are dropped whenever the file is read or rewritten, and the file itself is
 * rewritten only when it has grown past `MAX_LINES` or when retention has dropped a whole batch of
 * lines since the last rewrite, so a rewrite is rare rather than a cost paid every minute.
 *
 * A gap counts as downtime only when the beats stop for longer than `GAP_FACTOR` intervals (3), well
 * above the handful of seconds a timer can drift by; one or two missed beats are not downtime. The
 * length of a gap is the time from the beat that should have followed the last one we saw to the beat
 * that ended the gap, so a gap is never claimed to start or end more precisely than the beating
 * itself allows.
 *
 * The report is a pure function of the beats, the boots and the clock, so its arithmetic (a gap, a
 * blip below the threshold, a restart, an empty history) is tested without any timers.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** How often the service writes a heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** How many intervals the beats may miss before it counts as downtime rather than a late beat. */
export const GAP_FACTOR = 3;
/** The gap threshold itself: a run of missed beats longer than this is downtime. */
export const GAP_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * GAP_FACTOR;
/** How long heartbeats are kept. Enough for a week's figure with room to spare. */
export const RETENTION_MS = 14 * 24 * 60 * 60_000;
/** The strip on the page covers the last 24 hours in this many cells (30 minutes each). */
export const STRIP_CELLS = 48;
/** How many recent gaps the page lists. */
export const RECENT_GAPS = 5;
/** The most lines the file may hold before it is rewritten without the ones past retention. */
export const MAX_LINES = 25_000;
/**
 * How many lines retention must have dropped before the file is rewritten to match. Without it every
 * beat past the retention edge would rewrite the whole file; with it a rewrite happens about once a
 * week, and the file never holds more than retention plus this many lines.
 */
export const COMPACT_AFTER = 5_000;
/** The file itself, in the data directory beside the store (never inside a checkout). */
export const UPTIME_FILE = "uptime.jsonl";

/** The honest sentence about what is measured, shown on the page beside the figures. */
export const UPTIME_NOTE =
  "A heartbeat is written every minute. A gap is downtime only when the beats stop for more than three minutes, so a late beat or a two minute blip is not counted. Uptime therefore means the service was recording, not that the page answered from outside.";

/** One gap between heartbeats: the service was not sampling for this long. */
export interface UptimeGap {
  /** When the missing beat should have arrived, ms since the epoch. */
  from: number;
  /** The beat that ended the gap. */
  to: number;
  /** How long the service went without recording, in ms (the gap less one ordinary interval). */
  ms: number;
}

/** What the board shows about uptime: figures, the day's strip, the recent gaps and the last restart. */
export interface UptimeReport {
  /** The oldest heartbeat still kept, ISO, and how long ago that is in words. */
  since?: string;
  sinceWords?: string;
  /** Heartbeats kept. */
  samples: number;
  /** Share of the last 24 hours the service was recording, one decimal place. Absent with no history. */
  uptimePct24h?: number;
  /** True when the records really reach back 24 hours; otherwise the figure is over what they cover. */
  covers24h: boolean;
  /** The same over the last 7 days, where the history reaches that far. */
  uptimePct7d?: number;
  /** True when the records reach back a full week. */
  covers7d: boolean;
  /** How much of the last 24 hours was downtime, in minutes. */
  downtimeMinutes24h: number;
  /** One cell per half hour for the last 24 hours, oldest first. */
  strip: Array<"up" | "down" | "unknown">;
  /** The most recent gaps, newest first. */
  gaps: UptimeGap[];
  /** How many gaps were recorded in the last 24 hours and in the last 7 days. */
  gaps24h: number;
  gaps7d: number;
  /** When the service last started, ISO, and how long ago in words. */
  lastRestart?: string;
  lastRestartWords?: string;
  /** Starts recorded in the last 24 hours: a restart is one of these. */
  restarts24h: number;
  /** True when there is nothing to read yet, so the page can say that rather than show zeroes. */
  empty: boolean;
}

/** The option set, so a test can pin the clock, the interval and the file. */
export interface UptimeOptions {
  /** The data directory the file lives in. */
  dir?: string;
  /** The file itself, relative to the directory. */
  file?: string;
  now?: () => number;
  intervalMs?: number;
  retentionMs?: number;
  maxLines?: number;
  /** How many dropped lines justify a rewrite. Tests set it small; the default is a week's beats. */
  compactAfter?: number;
  /** One line to the log on a problem. Never carries a secret: there is none here. */
  warn?: (message: string) => void;
}

interface Line {
  t: number;
  /** Present on a line written at start-up, so restarts can be counted apart from heartbeats. */
  b?: boolean;
}

/**
 * The heartbeat file: beats and the starts that interrupted them, read once, appended one line at a
 * time, and rewritten only when it has grown past what retention keeps.
 */
export class UptimeLog {
  private readonly file: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly maxLines: number;
  private readonly compactAfter: number;
  private readonly warn: (message: string) => void;
  private beats: number[] = [];
  private boots: number[] = [];
  private lines = 0;
  /** Lines retention has dropped since the last rewrite, so the file is not rewritten per beat. */
  private dropped = 0;

  constructor(options: UptimeOptions = {}) {
    this.dir = options.dir ?? config.dataDir;
    this.file = path.join(this.dir, options.file ?? UPTIME_FILE);
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
    this.maxLines = options.maxLines ?? MAX_LINES;
    this.compactAfter = options.compactAfter ?? COMPACT_AFTER;
    this.warn = options.warn ?? ((message) => console.warn(`uptime: ${message}`));
    this.load();
  }

  /** The file, for a test that wants to look at what was written. */
  path(): string {
    return this.file;
  }

  private load(): void {
    let raw = "";
    try {
      raw = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    } catch (err) {
      // An unreadable file starts a fresh history rather than stopping the service.
      this.warn(`could not read ${UPTIME_FILE}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    let lines = 0;
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      lines++;
      const parsed = parseLine(text);
      if (!parsed) continue;
      (parsed.b ? this.boots : this.beats).push(parsed.t);
    }
    this.lines = lines;
    this.beats.sort((a, b) => a - b);
    this.boots.sort((a, b) => a - b);
    // Anything past retention goes now, and a file longer than the cap with it.
    this.trim();
    this.maybeCompact();
  }

  /**
   * Drops what retention no longer keeps, and, if that still leaves more lines than the cap, the
   * oldest of what remains. Everything dropped here is counted, so the file can be rewritten in a
   * batch rather than on the beat that happened to cross the edge.
   */
  private trim(): void {
    const floor = this.now() - this.retentionMs;
    const beats = this.beats.filter((t) => t >= floor);
    const boots = this.boots.filter((t) => t >= floor);
    this.dropped += this.beats.length - beats.length + this.boots.length - boots.length;
    this.beats = beats;
    this.boots = boots;
    while (this.beats.length + this.boots.length > this.maxLines) {
      // The cap is a backstop; retention is what normally bounds the file.
      if (this.beats.length >= this.boots.length) this.beats.shift();
      else this.boots.shift();
      this.dropped++;
    }
  }

  /** Rewrites the file when it has grown past the cap or retention has dropped a batch since last time. */
  private maybeCompact(): boolean {
    if (this.lines > this.maxLines || this.dropped >= this.compactAfter) {
      this.compact();
      return true;
    }
    return false;
  }

  private compact(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const lines = [
        ...this.beats.map((t) => JSON.stringify({ t } satisfies Line)),
        ...this.boots.map((t) => JSON.stringify({ t, b: true } satisfies Line)),
      ];
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
      fs.renameSync(tmp, this.file);
      this.lines = lines.length;
      this.dropped = 0;
    } catch (err) {
      this.warn(`could not rewrite ${UPTIME_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private append(line: Line): void {
    const text = `${JSON.stringify(line)}\n`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, text);
      this.lines++;
    } catch (err) {
      // The figure is still kept in memory for this process; the file is best effort.
      this.warn(`could not write a heartbeat: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Records one heartbeat now and returns it. Public so a test can beat without a timer. */
  beat(at = this.now()): number {
    this.beats.push(at);
    this.append({ t: at });
    this.trim();
    this.maybeCompact();
    return at;
  }

  /** Records a start. Called once at boot, which is the last restart the page reports. */
  boot(at = this.now()): number {
    this.boots.push(at);
    this.append({ t: at, b: true });
    this.trim();
    this.maybeCompact();
    return at;
  }

  /**
   * Starts the fixed-interval heartbeat. The first beat is written straight away, so a service that
   * restarts often still leaves a mark of every life it had. Returns the stop function, which clears
   * the timer; the timer is unref'd so it never holds the process open on its own.
   */
  start(): () => void {
    this.beat();
    const timer = setInterval(() => this.beat(), this.intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The beats kept, oldest first. */
  beatsKept(): number[] {
    return [...this.beats];
  }

  /** The starts kept, oldest first. */
  bootsKept(): number[] {
    return [...this.boots];
  }

  /** The whole picture, from the beats kept and the clock. */
  report(at = this.now()): UptimeReport {
    return uptimeReport({ beats: this.beats, boots: this.boots, now: at, intervalMs: this.intervalMs });
  }
}

/** One line of the file, or undefined when it is not one (a truncated tail, a hand-edited line). */
function parseLine(text: string): Line | undefined {
  try {
    const v = JSON.parse(text) as Partial<Line>;
    return typeof v?.t === "number" && Number.isFinite(v.t) ? { t: v.t, ...(v.b ? { b: true } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** The gaps between beats that are longer than the threshold, oldest first. Pure. */
export function gapsBetween(beats: readonly number[], intervalMs = HEARTBEAT_INTERVAL_MS): UptimeGap[] {
  const gaps: UptimeGap[] = [];
  const threshold = intervalMs * GAP_FACTOR;
  const sorted = [...beats].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    const delta = next - prev;
    if (delta <= threshold) continue;
    // The beat after prev should have arrived at prev + interval; the service was recording up to that.
    gaps.push({ from: prev + intervalMs, to: next, ms: delta - intervalMs });
  }
  return gaps;
}

/** How much of the window [from, to] the gaps cover, in ms. Any part of a gap outside it is ignored. */
function downtimeIn(gaps: readonly UptimeGap[], from: number, to: number): number {
  let total = 0;
  for (const g of gaps) {
    const start = Math.max(g.from, from);
    const end = Math.min(g.to, to);
    if (end > start) total += end - start;
  }
  return total;
}

/** Share of a window the service was recording, to one decimal place, or undefined with no beats in it. */
function percentage(gaps: readonly UptimeGap[], from: number, to: number): number | undefined {
  const span = to - from;
  if (span <= 0) return undefined;
  const down = downtimeIn(gaps, from, to);
  return Math.round(Math.max(0, 1 - down / span) * 1000) / 10;
}

/** "3 hours 10 minutes", "12 minutes": a length in plain words, from a board's own millisecond figure. */
function words(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / HEARTBEAT_INTERVAL_MS);
  if (mins < 1) return "under a minute";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${mins} min`;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/**
 * The uptime picture from beats, starts and a clock: figures for 24 hours and 7 days, one strip cell
 * per half hour for the last day, the recent gaps and the last restart. Pure, so every case
 * (a gap, a blip below the threshold, a restart, an empty history) is tested without a timer.
 *
 * The measured span is capped by the history: a service that has been recording for two hours has an
 * "up" figure for two hours, and the page says how far back the records go rather than implying a day.
 */
export function uptimeReport(source: { beats: readonly number[]; boots?: readonly number[]; now: number; intervalMs?: number }): UptimeReport {
  const intervalMs = source.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const { now } = source;
  const beats = [...source.beats].sort((a, b) => a - b);
  const boots = [...(source.boots ?? [])].sort((a, b) => a - b);
  const first = beats[0];
  const gaps = gapsBetween(beats, intervalMs);
  const strip = stripCells(beats, gaps, now);
  const lastRestart = boots[boots.length - 1];
  const covers24h = first !== undefined && now - first >= DAY_MS;
  const covers7d = first !== undefined && now - first >= WEEK_MS;
  return {
    ...(first !== undefined ? { since: new Date(first).toISOString(), sinceWords: `${words(now - first)} ago` } : {}),
    samples: beats.length,
    ...(first !== undefined && now > first
      ? {
          uptimePct24h: percentage(gaps, Math.max(now - DAY_MS, first), now),
          ...(covers7d ? { uptimePct7d: percentage(gaps, Math.max(now - WEEK_MS, first), now) } : {}),
        }
      : {}),
    covers24h,
    covers7d,
    downtimeMinutes24h: Math.round(downtimeIn(gaps, Math.max(now - DAY_MS, first ?? now), now) / HEARTBEAT_INTERVAL_MS),
    strip,
    gaps: [...gaps].reverse().slice(0, RECENT_GAPS),
    gaps24h: gaps.filter((g) => g.to >= now - DAY_MS).length,
    gaps7d: gaps.filter((g) => g.to >= now - WEEK_MS).length,
    ...(lastRestart !== undefined ? { lastRestart: new Date(lastRestart).toISOString(), lastRestartWords: `${words(now - lastRestart)} ago` } : {}),
    restarts24h: boots.filter((t) => t >= now - DAY_MS).length,
    empty: beats.length === 0,
  };
}

/**
 * One cell per half hour for the last 24 hours, oldest first. A cell is "down" when any recorded gap
 * reaches into it (a gap is known from the beats on either side of it, whatever the records reach
 * back to, so the strip can show one outside the beats it keeps), "unknown" when it starts before the
 * oldest heartbeat kept and no gap explains it, and "up" otherwise. A cell is never called up on a
 * guess: the strip is only as wide as the records, and the half hour is the strip's own precision.
 */
function stripCells(beats: readonly number[], gaps: readonly UptimeGap[], now: number): Array<"up" | "down" | "unknown"> {
  const cellMs = DAY_MS / STRIP_CELLS;
  const first = beats[0];
  const cells: Array<"up" | "down" | "unknown"> = [];
  for (let i = 0; i < STRIP_CELLS; i++) {
    const from = now - DAY_MS + i * cellMs;
    const to = from + cellMs;
    if (downtimeIn(gaps, from, to) > 0) {
      cells.push("down");
      continue;
    }
    cells.push(first === undefined || from < first ? "unknown" : "up");
  }
  return cells;
}
