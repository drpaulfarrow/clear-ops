/**
 * Uptime and downtime for the board: the arithmetic (a gap, a short blip below the threshold, a
 * restart, an empty history) is pure and tested with no timer, and the heartbeat file is tested
 * against a temporary directory so nothing real is touched. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { GAP_THRESHOLD_MS, HEARTBEAT_INTERVAL_MS, STRIP_CELLS, UptimeLog, gapsBetween, uptimeReport } = await import("../src/uptime.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");

/** A series of beats every minute from `from` up to (not including) `to`. */
function beatsEveryMinute(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += HEARTBEAT_INTERVAL_MS) out.push(t);
  return out;
}

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `clear-ops-${name}-`));

test("a run of even beats has no gaps, and only missed beats past the threshold are downtime", () => {
  assert.deepEqual(gapsBetween([]), []);
  assert.deepEqual(gapsBetween([NOW - 10 * MIN, NOW - 9 * MIN, NOW - 8 * MIN]), [], "even beats are not a gap");

  // One late beat: two minutes between beats is below the three minute threshold, so not downtime.
  assert.deepEqual(gapsBetween([NOW - 4 * MIN, NOW - 2 * MIN]), [], "a late beat is not downtime");
  // Three missed beats: the gap starts when the beat after the last one should have arrived.
  const gaps = gapsBetween([NOW - 5 * MIN, NOW - 1 * MIN]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, NOW - 5 * MIN + HEARTBEAT_INTERVAL_MS, "the gap starts at the beat that never came");
  assert.equal(gaps[0].to, NOW - 1 * MIN);
  assert.equal(gaps[0].ms, 4 * MIN - HEARTBEAT_INTERVAL_MS, "the gap is the silence less one ordinary interval");
  // Exactly the threshold is a late beat; a minute more is downtime.
  assert.equal(gapsBetween([NOW - 10 * MIN, NOW - 10 * MIN + GAP_THRESHOLD_MS]).length, 0);
  assert.equal(gapsBetween([NOW - 10 * MIN, NOW - 10 * MIN + GAP_THRESHOLD_MS + 1]).length, 1);
});

test("an empty history is said to be empty rather than shown as a figure", () => {
  const report = uptimeReport({ beats: [], now: NOW });
  assert.equal(report.empty, true);
  assert.equal(report.samples, 0);
  assert.equal(report.uptimePct24h, undefined, "no beats, so there is no figure to print");
  assert.equal(report.uptimePct7d, undefined);
  assert.equal(report.downtimeMinutes24h, 0);
  assert.equal(report.gaps.length, 0);
  assert.equal(report.lastRestart, undefined);
  assert.equal(report.strip.length, STRIP_CELLS);
  assert.deepEqual([...new Set(report.strip)], ["unknown"], "nothing is called up on a guess");
});

test("a full day of beats with one hole gives a figure, the day's strip, the gaps and the last restart", () => {
  // Beats every minute for 24 hours, with the twenty minutes from 06:00 missing.
  const holeFrom = NOW - 6 * HOUR;
  const beats = [...beatsEveryMinute(NOW - DAY, holeFrom), ...beatsEveryMinute(holeFrom + 20 * MIN, NOW + 1)];
  const report = uptimeReport({ beats, boots: [NOW - 2 * HOUR], now: NOW });

  assert.equal(report.empty, false);
  assert.equal(report.covers24h, true);
  assert.equal(report.covers7d, false, "a day of records does not claim a week");
  assert.equal(report.samples, beats.length);
  assert.equal(report.gaps24h, 1);
  assert.equal(report.gaps7d, 1);
  assert.equal(report.downtimeMinutes24h, 20);
  assert.equal(report.uptimePct24h, 98.6, "20 minutes of 1440 is 1.4%");
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].ms, 20 * MIN);
  assert.deepEqual([...new Set(report.strip)], ["up", "down"], "the strip is green and red once the day is covered");
  assert.equal(report.strip.filter((c) => c === "down").length, 1, "the hole falls in one half hour cell");
  assert.equal(report.strip[STRIP_CELLS - 1], "up", "the newest cell is up");
  assert.equal(report.lastRestartWords, "2 h ago");
  assert.equal(report.restarts24h, 1);
});

test("a short gap still shows in the strip: a cell is red wherever any downtime falls in it", () => {
  // Five minutes of silence (above the three minute threshold, well under the half hour cell) at
  // 08:00, which is a cell boundary: the cell it falls in is the only red one.
  const beats = [...beatsEveryMinute(NOW - DAY, NOW - 4 * HOUR), ...beatsEveryMinute(NOW - 4 * HOUR + 5 * MIN, NOW + 1)];
  const report = uptimeReport({ beats, now: NOW });
  assert.equal(report.gaps24h, 1);
  assert.equal(report.gaps[0]!.ms, 5 * MIN);
  const down = report.strip.map((c, i) => (c === "down" ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(down, [40], "the half hour the gap happened in, and no other");
});

test("a history shorter than the window says so and measures only what it has", () => {
  const beats = beatsEveryMinute(NOW - 2 * HOUR, NOW + 1);
  const report = uptimeReport({ beats, now: NOW });
  assert.equal(report.covers24h, false);
  assert.equal(report.uptimePct24h, 100, "everything that was recorded was recorded without a break");
  assert.equal(report.sinceWords, "2 h ago");
  assert.equal(report.uptimePct7d, undefined, "there is no week to measure");
  // The half hours before the records begin are grey rather than green.
  assert.ok(report.strip.slice(0, 43).every((c) => c === "unknown"), "hours with no records are unknown");
  assert.equal(report.strip[STRIP_CELLS - 1], "up");
});

test("the recent gaps are listed newest first, and only the starts inside the day are counted", () => {
  // One continuous series of beats with three ten minute holes, at 12, 6 and 2 hours ago.
  const holes = [12 * HOUR, 6 * HOUR, 2 * HOUR].map((h) => NOW - h);
  const beats: number[] = [];
  for (let t = NOW - 13 * HOUR; t <= NOW; t += MIN) {
    if (holes.some((h) => t > h && t <= h + 10 * MIN)) continue;
    beats.push(t);
  }
  const report = uptimeReport({ beats, boots: [NOW - 3 * DAY, NOW - 40 * MIN], now: NOW });
  assert.equal(report.gaps24h, 3);
  assert.equal(report.gaps7d, 3);
  assert.deepEqual(report.gaps.map((g) => g.ms), [10 * MIN, 10 * MIN, 10 * MIN]);
  assert.ok(report.gaps[0]!.to > report.gaps[1]!.to, "newest first");
  assert.equal(report.restarts24h, 1, "the start three days ago is not in the day");
  assert.equal(report.lastRestartWords, "40 min ago");
});

test("the heartbeat file: a beat is one line, a start is recorded, and a second process reads both back", () => {
  const dir = tmp("uptime");
  const log = new UptimeLog({ dir, now: () => NOW });
  assert.equal(fs.existsSync(log.path()), false, "nothing is written until something happens");

  log.boot(NOW - HOUR);
  log.beat(NOW - 2 * MIN);
  log.beat(NOW - MIN);
  const written = fs.readFileSync(log.path(), "utf8").trim().split("\n");
  assert.equal(written.length, 3, "one short line each");
  assert.ok(
    written.every((l) => l.length < 40),
    "a heartbeat is a few bytes",
  );
  assert.deepEqual(JSON.parse(written[0]!), { t: NOW - HOUR, b: true });

  const reopened = new UptimeLog({ dir, now: () => NOW });
  assert.deepEqual(reopened.beatsKept(), [NOW - 2 * MIN, NOW - MIN]);
  assert.deepEqual(reopened.bootsKept(), [NOW - HOUR]);
  assert.equal(reopened.report().samples, 2);
  assert.equal(reopened.report().lastRestartWords, "1 h ago");
});

test("retention bounds the memory and the file, and the rewrite is batched rather than paid per beat", () => {
  const dir = tmp("uptime-retention");
  // Records from three days ago, one a minute for an hour at a time, kept for one day only.
  const log = new UptimeLog({ dir, now: () => NOW, retentionMs: DAY, compactAfter: 10 });
  for (let t = NOW - 3 * DAY; t <= NOW; t += HOUR) log.beat(t);
  assert.ok(
    log.beatsKept().every((t) => t >= NOW - DAY),
    "nothing past retention is kept in memory",
  );
  const lines = fs.readFileSync(log.path(), "utf8").trim().split("\n");
  // Seventy-three beats were written and a day is kept: twenty-five of them. The rest are dropped in
  // batches, so the file is the day plus at most one unfinished batch, not the whole history.
  assert.ok(lines.length >= 24, `the day it keeps is still in the file (${lines.length} lines)`);
  assert.ok(lines.length <= 25 + 10, `the file is bounded (${lines.length} lines)`);

  // Fewer drops than a batch: the file is left alone rather than rewritten on the beat that crossed
  // the retention edge, which is what keeps a rewrite rare.
  const dir2 = tmp("uptime-batch");
  const batched = new UptimeLog({ dir: dir2, now: () => NOW, retentionMs: 10 * MIN, compactAfter: 100 });
  batched.beat(NOW - MIN); // kept
  batched.beat(NOW - 30 * MIN); // past retention, so dropped from memory at once
  assert.equal(fs.readFileSync(batched.path(), "utf8").trim().split("\n").length, 2, "one dropped line is not worth a rewrite");
  // A batch of them is: a hundred and twenty stale beats, and the file is rewritten once along the way.
  for (let i = 0; i < 120; i++) batched.beat(NOW - 40 * MIN - i * MIN);
  const after = fs.readFileSync(batched.path(), "utf8").trim().split("\n").length;
  assert.ok(after <= 30, `a batch of drops rewrote the file (${after} lines, not 122)`);
});

test("an unreadable or half-written line is skipped rather than stopping the service", () => {
  const dir = tmp("uptime-broken");
  const file = path.join(dir, "uptime.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ t: NOW - 5 * MIN })}\nnot json at all\n{"t":"soon"}\n\n`);
  const log = new UptimeLog({ dir, now: () => NOW });
  assert.deepEqual(log.beatsKept(), [NOW - 5 * MIN]);
  assert.equal(log.report().samples, 1);
});

test("the fixed-interval heartbeat writes at once and stops cleanly", () => {
  const dir = tmp("uptime-timer");
  const log = new UptimeLog({ dir, now: () => NOW, intervalMs: HOUR });
  const stop = log.start();
  assert.equal(log.beatsKept().length, 1, "the first beat lands straight away, so a restart always leaves a mark");
  stop();
  assert.equal(fs.readFileSync(log.path(), "utf8").trim().split("\n").length, 1);
});
