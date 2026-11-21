/**
 * An HTML upload has its words read out and saved beside it (src/html-text.ts, src/uploads.ts), as a PDF
 * does, so nobody pages through megabytes of markup for a few thousand words. On 21 Nov 2026 the chief
 * spent every step of two turns doing that, and all Paul saw was "It ran out of turns".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-html-"));
process.env.PDFTOTEXT_PATH = "/nonexistent/pdftotext-for-the-html-tests";

const { htmlToText, isHtml } = await import("../src/html-text.js");
const { Uploads, describeUploads, CHIEF_READ_BYTES, CHIEF_READ_CHARS } = await import("../src/uploads.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator, CHIEF_OUT_OF_TURNS, CHIEF_MAX_TURNS } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { PAUL_STYLE } = await import("../src/messages.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const text = (html: string, max = 1_000_000) => htmlToText(Buffer.from(html, "utf8"), max);
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-html-up-"));
/** A page like an exported document: a little text under a great deal of styling, script and picture. */
const exported = (words: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lusana &amp; friends</title><style>${"body{color:red}".repeat(20_000)}</style></head><body>` +
  `<script>window.__DATA__=${JSON.stringify({ blob: "x".repeat(600_000) })}</script>` +
  `<h1>Product&nbsp;requirements</h1><p>${words}</p><img alt="logo" src="data:image/png;base64,${"A".repeat(900_000)}">` +
  `<ul><li>Sign in with email</li><li>A shared&#8209;calendar view &lt;weekly&gt;</li></ul><h2>Out of scope</h2><p>Payments.<br>Native apps.</p></body></html>`;

test("the words of a page are read out, with its title, headings and lists, and none of its markup", () => {
  const page = exported("Lusana lets a family plan the week together.");
  assert.ok(page.length > 1_700_000, "the page is as heavy as the one that went wrong");
  const out = text(page);
  assert.equal(out.text, ["Lusana & friends", "", "# Product requirements", "", "Lusana lets a family plan the week together.", "", "- Sign in with email", "- A shared‑calendar view <weekly>", "", "## Out of scope", "", "Payments.", "Native apps."].join("\n"));
  assert.deepEqual([out.chars, out.words, out.truncated], [out.text.length, 31, false]);
  assert.doesNotMatch(out.text, /color:red|__DATA__|base64|AAAA|xxxx|<h1|<li|&amp;|&nbsp;/);
});

test("nothing in the file is run, and nothing it leaves unclosed can make the reader stall or spill", () => {
  // Script, style and the rest are dropped unread, however they are written.
  assert.equal(text(`<p>Before</p><SCRIPT type="module">alert("in script")</SCRIPT><p>After</p><style>p{}</style><svg><text>drawn</text></svg><template><p>hidden</p></template>`).text, "Before\n\nAfter");
  assert.equal(text("<p>Kept</p><!-- a comment with <p>markup</p> --><p>Also kept</p>").text, "Kept\n\nAlso kept");
  // Left open, they take the rest of the file with them rather than letting it through as words.
  assert.equal(text("<p>Seen</p><script>var secret = 1; <p>not words</p>").text, "Seen");
  assert.equal(text("<p>Seen</p><!-- never closed <p>not words</p>").text, "Seen");
  assert.equal(text("<p>Seen</p><div class='never closed").text, "Seen");
  // A "<" that opens nothing is a character like any other.
  assert.equal(text("<p>if a < b and c > d</p>").text, "if a < b and c > d");
  // Letters whose lower case is a different length do not put the reader out of step.
  assert.equal(text("<p>İstanbul İİİ</p><SCRIPT>x</SCRIPT><P>after</P>").text, "İstanbul İİİ\n\nafter");
  // Odd numeric references are left as written, and control characters are not words.
  assert.equal(text("<p>a&#0;b&#x1F600;c&#99999999;d&bogus;e&#7;</p>").text, "a&#0;b😀c&#99999999;d&bogus;e&#7;");
  // Thousands of openings that never close cost one pass, not one pass each.
  const began = Date.now();
  for (const nasty of ["<script ".repeat(300_000), "<div><".repeat(400_000), "<!--".repeat(500_000), "&".repeat(2_000_000), "<a ".repeat(300_000) + ">"]) text(nasty);
  assert.ok(Date.now() - began < 4000, `the reader took ${Date.now() - began} ms on hostile pages`);
});

test("a long page is cut at the limit and says so, and a page with no words says that", () => {
  const long = text(`<p>${"word ".repeat(5000)}</p>`, 1000);
  assert.deepEqual([long.chars, long.truncated], [1000, true]);
  assert.deepEqual(text(`<html><head><title></title></head><body><div id="root"></div><script src="app.js"></script></body></html>`), { text: "", chars: 0, words: 0, truncated: false });
});

test("only a file that is named or typed as HTML, and starts like it, is read this way", () => {
  const page = Buffer.from("<!doctype html><html><body><p>Hi</p></body></html>");
  assert.equal(isHtml("lusana.html", "text/html", page), true);
  assert.equal(isHtml("page.HTM", "application/octet-stream", page), true);
  assert.equal(isHtml("page", "text/html; charset=utf-8", page), true);
  assert.equal(isHtml("notes.txt", "text/plain", page), false);
  assert.equal(isHtml("data.html", "text/html", Buffer.from("name,email\nAda,ada@example.org\n")), false);
});

test("an HTML upload is saved whole with its text beside it, and the chief is told to read the text", async () => {
  const up = new Uploads(freshDir());
  const saved = await up.save("lusana.html", Buffer.from(exported("Lusana lets a family plan the week together.")), "text/html");
  assert.equal(saved.size > 1_700_000, true);
  assert.ok(saved.text, "its text was read out");
  assert.equal(saved.text.name, `${saved.name}.txt`);
  assert.equal(saved.text.words, 31);
  assert.match(fs.readFileSync(saved.text.path, "utf8"), /^Lusana & friends\n\n# Product requirements\n/);
  assert.equal(fs.statSync(saved.text.path).mode & 0o777, 0o600, "owner-only, like the file it came from");
  assert.equal(saved.note, undefined);
  const told = describeUploads([saved], [], 0);
  assert.match(told, new RegExp(`Text read out of it is saved beside it at ${saved.text.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(31 words\\): read that file, not the HTML\\.`));
  assert.doesNotMatch(told, /do not Read it whole|That text is long/, "a short text is the chief's to read");
  // The companion goes when the page does.
  assert.deepEqual(up.delete("lusana.html").deleted.sort(), [saved.name, saved.text.name].sort());
  assert.equal(fs.existsSync(saved.text.path), false);
});

test("a page drawn by its script has no words to save, and that is said rather than left to be found out", async () => {
  const up = new Uploads(freshDir());
  const saved = await up.save("app.html", Buffer.from(`<!doctype html><html><head><title></title></head><body><div id="root"></div><script>${"render();".repeat(50_000)}</script></body></html>`), "text/html");
  assert.equal(saved.text, undefined);
  assert.match(saved.note ?? "", /no readable text was found in the HTML.*ask Paul for the same thing as a PDF or as Markdown/);
  const told = describeUploads([saved], [], 0);
  assert.match(told, /no readable text was found in the HTML/);
  assert.match(told, /It is large \(\d+\.\d KB\): do not Read it whole yourself in this turn\. Use Grep for a quick look-up, and for anything more put its full path in a worker's brief\./);
});

test("the chief is told when a file or its text is too big for its own turn, and not otherwise", () => {
  const u = (o: Record<string, unknown>) => ({ name: "2026-11-21-x", path: "/data/uploads/2026-11-21-x", originalName: "x", mimeType: "text/csv", size: 1000, ...o }) as Parameters<typeof describeUploads>[0][number];
  const big = /do not Read it whole yourself in this turn/;
  assert.doesNotMatch(describeUploads([u({ size: CHIEF_READ_BYTES })], [], 0), big);
  assert.match(describeUploads([u({ size: CHIEF_READ_BYTES + 1 })], [], 0), big);
  // A picture is shown to it, a voice note is transcribed and an archive is unpacked: none is "read whole".
  for (const o of [{ mimeType: "image/png" }, { mimeType: "audio/ogg" }, { extracted: { dir: "/data/uploads/x.unpacked", files: 3, skipped: 0 } }]) assert.doesNotMatch(describeUploads([u({ size: 5_000_000, ...o })], [], 0), big, JSON.stringify(o));
  const withText = (chars: number) => describeUploads([u({ size: 5_000_000, mimeType: "application/pdf", text: { name: "x.txt", path: "/data/uploads/x.txt", chars, words: 10, sha256: "0" } })], [], 0);
  assert.doesNotMatch(withText(CHIEF_READ_CHARS), /That text is long|do not Read it whole/);
  assert.match(withText(CHIEF_READ_CHARS + 1), /That text is long: for more than a quick look, put its full path in a worker's brief rather than reading it all yourself\./);
  assert.match(withText(10), /read that file, not the PDF\./, "a PDF is still called a PDF");
});

test("when the chief runs out of steps Paul is told what happened and what to ask for, and the attempt is not carried on", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-html-chief-")));
  const m = new ConsoleMessenger();
  const seen: RunOptions[] = [];
  let outOfTurns = true;
  const runner: AgentRunner = async (o) => {
    seen.push(o);
    return outOfTurns ? { text: "The agent stopped early (error_max_turns).", sessionId: "clogged-session", outOfTurns: true } : { text: "All good.", sessionId: "fresh-session" };
  };
  const jobs = new JobRunner(store, m, runner);
  const orch = new Orchestrator(store, m, jobs, new Scheduler(store, jobs), runner);
  store.setSession(FOUNDER, "earlier-session");
  await orch.handle(FOUNDER, "turn that file into requirements");
  assert.equal(seen[0]!.maxTurns, CHIEF_MAX_TURNS);
  assert.equal(seen[0]!.resume, "earlier-session");
  assert.equal(m.sent.at(-1)!.text, CHIEF_OUT_OF_TURNS);
  assert.ok(!m.sent.some((s) => /stopped early|error_max_turns|before writing a report/.test(s.text)), "the runner's stop line is not a reply");
  assert.equal(store.getSession(FOUNDER), undefined, "neither the clogged session nor the one before it is kept");
  // The next message starts clean, and an ordinary answer is kept as before.
  outOfTurns = false;
  await orch.handle(FOUNDER, "hello");
  assert.equal(seen[1]!.resume, undefined);
  assert.equal(m.sent.at(-1)!.text, "All good.");
  assert.equal(store.getSession(FOUNDER), "fresh-session");
  // It is written the way Paul is written to.
  assert.match(CHIEF_OUT_OF_TURNS, new RegExp(`^I used all ${CHIEF_MAX_TURNS} of my steps on that and did not get to an answer`));
  assert.doesNotMatch(CHIEF_OUT_OF_TURNS, /[—–]|\n|^\s*[-*#]/m);
  assert.ok(CHIEF_OUT_OF_TURNS.split(/(?<=\.)\s/).length <= 4, "three or four sentences");
  assert.ok(PAUL_STYLE.length > 0);
});
