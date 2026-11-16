/**
 * Reading a PDF's text off the main thread, with the installed parser where there is one (src/pdf-extract.ts).
 *
 * poppler-utils is in the deployed image (Dockerfile) but not on every machine that runs these tests, so
 * the parser's half is driven with a stand-in: a small shell script that is given the PDF on stdin and
 * answers on stdout exactly as `pdftotext` would. That is how the wiring is held - the arguments, the
 * environment, the user it runs as, its exit code, its silence, its slowness - without depending on
 * whether the real thing is installed here. It is not installed on this machine, so nothing in this file
 * claims to have run it: what the parser is given, and what is done with what it says, is held with the
 * stand-in, and the pull request says the same.
 *
 * This service's own reader is the fallback on a machine without the parser, and it runs in a worker
 * thread. It is held here too, and at length in test/pdf.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pdfx-"));

const { extractPdfText, findPdftotext, PDF_MAX_BYTES } = await import("../src/pdf-extract.js");
const { pdfTextNote } = await import("../src/pdf.js");
const { Uploads, receiptText } = await import("../src/uploads.js");
import type { Attachment } from "../src/uploads.js";

/* --------------------------------- fixtures --------------------------------- */

/** One page of WinAnsi text, built here from scratch: a real PDF for the reader's own path. */
const SIMPLE = (() => {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const text = "BT /F1 12 Tf 72 720 Td (Hello from the reader) Tj ET\n";
  const stream = deflateSync(Buffer.from(text, "latin1"));
  const out = [Buffer.from("%PDF-1.4\n", "latin1")];
  let at = out[0].length;
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(at);
    const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    out.push(b);
    at += b.length;
  });
  offsets.push(at);
  const dict = `<< /Length ${stream.length} /Filter /FlateDecode >>`;
  const head = Buffer.from(`5 0 obj\n${dict}\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\n", "latin1");
  out.push(head, stream, tail);
  at += head.length + stream.length + tail.length;
  const xref = at;
  let table = "xref\n0 6\n0000000000 65535 f \n";
  for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`;
  out.push(Buffer.from(`${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(out);
})();

/** A scan: a page with no text operators at all, so no reader of any kind can find words in it. */
const SCAN = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>\nendobj\n%%EOF\n",
  "latin1",
);

/* ------------------------------ a stand-in parser ----------------------------- */

interface Stub {
  /** The path to hand to the extractor. */
  path: string;
  /** Where the stand-in writes what it saw of its arguments, its environment and its user. */
  log: string;
  /** The text it writes to stdout, exactly as the real tool writes a form feed after each page. */
  output: string;
  /** Whether it writes that and then hangs, so a read can be caught mid-flight. */
  hang: boolean;
  /** What it exits with. */
  exit: number;
  /** Whether it was run at all. */
  ran: boolean;
  /** True once it has written everything it was going to write, so a hang can be waited for. */
  written: string;
}

const STUBS: Stub[] = [];

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A `pdftotext` stand-in: it drains the PDF from stdin (counting the bytes), records its arguments, its
 * environment and its user in a file, writes what it was told to stdout, and exits with the code it was
 * given. It lives in a world-writable directory because the real tool runs as the unprivileged
 * `designer` user, which must be able to write its record there too.
 *
 * Its output is written from a file rather than echoed, so the form feeds are real bytes.
 */
function stub(opts: { output?: string; exit?: number; hang?: boolean } = {}): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-stub-"));
  fs.chmodSync(dir, 0o777);
  const out = path.join(dir, "output.bin");
  fs.writeFileSync(out, opts.output ?? "", { mode: 0o644 });
  const log = path.join(dir, "seen.txt");
  const s: Stub = { path: path.join(dir, "pdftotext"), log, output: opts.output ?? "", hang: opts.hang ?? false, exit: opts.exit ?? 0, ran: false, written: opts.output ?? "" };
  const script = [
    "#!/bin/sh",
    `log=${quote(log)}`,
    `out=${quote(out)}`,
    "bytes=$(wc -c)",
    '{ printf \'args=%s\\n\' "$*"; printf \'uid=%s\\n\' "$(id -u)"; printf \'stdin=%s\\n\' "$bytes"; env | sort | sed \'s/^/env=/\' ; } >> "$log" 2>/dev/null',
    'printf "%s" ran >> "$log" 2>/dev/null',
    'cat "$out"',
    // `exec` so the hang is the shell itself: the service kills that one process and nothing is left behind.
    s.hang ? "exec sleep 5" : `exit ${s.exit}`,
  ].join("\n");
  fs.writeFileSync(s.path, `${script}\n`, { mode: 0o755 });
  STUBS.push(s);
  return s;
}

/** What the stand-in saw: its arguments, its environment and its user. */
function seen(s: Stub): { args: string[]; env: string[]; uid: string; stdin: number } {
  const lines = fs.readFileSync(s.log, "utf8").split("\n");
  const value = (key: string): string => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  return {
    args: value("args").split(" ").filter(Boolean),
    env: lines.filter((l) => l.startsWith("env=")).map((l) => l.slice(4)),
    uid: value("uid"),
    stdin: Number(value("stdin")),
  };
}

/** Waits until the stand-in has recorded its run, so a hung one is caught after it wrote its record. */
async function ran(s: Stub): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(s.log) && fs.readFileSync(s.log, "utf8").includes("ran")) {
      s.ran = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("the stand-in never ran");
}

/* ---------------------------------- the parser -------------------------------- */

test("the installed parser is used, given the arguments it needs, and only when it can be run", async () => {
  const s = stub({ output: "Chapter one\fChapter two\f" });
  const result = await extractPdfText(SIMPLE, { maxChars: 10_000 }, { pdftotext: s.path });

  assert.equal(result.source, "pdftotext");
  assert.equal(result.text, "Chapter one\fChapter two");
  assert.equal(result.pages, 2);
  assert.equal(result.pagesWithText, 2);
  assert.equal(result.words, 4);
  assert.equal(result.truncated, false);
  assert.equal(pdfTextNote(result), undefined);

  const what = seen(s);
  assert.deepEqual(what.args, ["-enc", "UTF-8", "-", "-"], "UTF-8 out, the PDF in on stdin, the text out on stdout");
  assert.equal(what.stdin, SIMPLE.length, "the PDF is handed to it on stdin, so it needs no access to the uploads directory");
  assert.equal(what.uid === "0", false, "never root: a tool parsing someone else's file runs as the designer user");
  // What the tool is given is what the service set for it, plus the PWD the shell itself adds. Nothing else.
  for (const name of what.env.map((e) => e.split("=")[0])) {
    assert.ok(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "PWD"].includes(name), `the child carries an environment of its own, not the service's: saw ${name}`);
  }
  for (const secret of ["VAULT_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GH_TOKEN", "GITHUB_APP_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN"]) {
    assert.equal(what.env.some((e) => e.startsWith(`${secret}=`)), false, `${secret} must never reach the parser`);
  }
});

test("a page the parser left empty is counted, never called a complete read", async () => {
  const s = stub({ output: "Chapter one\f\fChapter three\f" });
  const result = await extractPdfText(SIMPLE, {}, { pdftotext: s.path });
  assert.equal(result.source, "pdftotext");
  assert.equal(result.pages, 3);
  assert.deepEqual(result.pagesWithoutText, [2]);
  assert.match(pdfTextNote(result) ?? "", /1 of 3 pages had no text \(page 2\)/);
});

test("a parser that fails, says nothing, or is not there leaves this service's own reader to decide", async () => {
  const failed = stub({ exit: 3, output: "garbage that is not the document" });
  const byReader = await extractPdfText(SIMPLE, {}, { pdftotext: failed.path });
  assert.equal(byReader.source, "reader", "a tool that failed is not believed");
  assert.equal(byReader.text, "Hello from the reader");

  // Silence from a tool that exited cleanly is not "the document has no text": the reader is asked.
  const silent = stub({ output: "" });
  const readerSays = await extractPdfText(SIMPLE, {}, { pdftotext: silent.path });
  assert.equal(readerSays.source, "reader");
  assert.equal(readerSays.text, "Hello from the reader", "the reader found what the silent tool did not");

  // A scan is a scan whoever looks at it, and the reader is the one that says so in plain words.
  const scan = await extractPdfText(SCAN, {}, { pdftotext: silent.path });
  assert.equal(scan.text, "");
  assert.match(scan.reason ?? "", /no text layer/);

  // No parser at all: the fallback, on its own.
  const none = await extractPdfText(SIMPLE, {}, { pdftotext: null });
  assert.equal(none.source, "reader");
  assert.equal(none.text, "Hello from the reader");
});

test("a parser that answers with text and then hangs is stopped, and its text is called partial", async () => {
  const s = stub({ output: "Half a page\f, and then", hang: true });
  const reading = extractPdfText(SIMPLE, {}, { pdftotext: s.path, timeoutMs: 1000 });
  await ran(s);
  const result = await reading;
  assert.equal(result.text, "Half a page\f, and then");
  assert.equal(result.source, "pdftotext");
  assert.equal(result.truncated, true, "a read that was stopped is never called complete");
  assert.match(pdfTextNote(result) ?? "", /stopped after 1 second/);
  assert.match(pdfTextNote(result) ?? "", /may cover only part of the file/);
});

test("a parser that hangs with nothing to show is reported as stopped, not as a document with no text", async () => {
  const s = stub({ output: "", hang: true });
  const reading = extractPdfText(SCAN, {}, { pdftotext: s.path, timeoutMs: 1000 });
  await ran(s);
  const result = await reading;
  assert.equal(result.text, "");
  assert.equal(result.truncated, true);
  assert.match(result.reason ?? "", /stopped after 1 second/);
});

test("more text than the caller's cap allows stops the parser, and is never passed off as complete", async () => {
  const s = stub({ output: `${"x".repeat(2000)}\f` });
  const result = await extractPdfText(SIMPLE, { maxChars: 100 }, { pdftotext: s.path });
  assert.equal(result.source, "pdftotext");
  assert.equal(result.truncated, true);
  assert.equal(result.chars, 100, "the cap holds");
  assert.match(pdfTextNote(result) ?? "", /only part of the file/);
});

test("a path that is not a runnable pdftotext is not used, and findPdftotext trusts nothing it cannot run", async () => {
  assert.equal(findPdftotext({ PATH: "/nonexistent-dir", PDFTOTEXT_PATH: "/nonexistent/pdftotext" }), undefined);
  const s = stub({ output: "from the stand-in\f" });
  assert.equal(findPdftotext({ PATH: path.dirname(s.path) }), s.path, "found on PATH");
  assert.equal(findPdftotext({ PATH: "/nonexistent-dir", PDFTOTEXT_PATH: s.path }), s.path, "or named outright");
  // Named but not runnable: the reader is used rather than a failure.
  const result = await extractPdfText(SIMPLE, {}, { pdftotext: path.join(os.tmpdir(), "no-such-pdftotext") });
  assert.equal(result.source, "reader");
  assert.equal(result.text, "Hello from the reader");
});

test("no PDF is read above the size the caller allows, and the reason says so", async () => {
  const s = stub({ output: "should never run\f" });
  const result = await extractPdfText(SIMPLE, {}, { pdftotext: s.path, maxBytes: 32 });
  assert.equal(result.text, "");
  assert.match(result.reason ?? "", /larger than 0 MB/);
  assert.equal(fs.existsSync(s.log), false, "the parser is not even run");
  assert.ok(PDF_MAX_BYTES >= 20 * 1024 * 1024, "the default is above the upload limit, so it never bites in practice");
});

test("a file that is not a PDF is refused before anything else happens", async () => {
  const s = stub({ output: "never\f" });
  const result = await extractPdfText(Buffer.from("just some text"), {}, { pdftotext: s.path });
  assert.equal(result.text, "");
  assert.equal(result.reason, "the file is not a readable PDF");
  assert.equal(fs.existsSync(s.log), false);
});

/* -------------------------------- the upload store ------------------------------- */

test("an upload takes the parser's path through the store and writes its text beside the PDF", async () => {
  const s = stub({ output: "One\fTwo\f" });
  const previous = process.env.PDFTOTEXT_PATH;
  process.env.PDFTOTEXT_PATH = s.path;
  try {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pdfx-dir-")), "uploads");
    const uploads = new Uploads(dir, { maxBytes: 8_000_000, maxArchiveEntries: 10, maxArchiveBytes: 1000 }, () => new Date("2026-11-16T09:00:00Z"));
    const attachment: Attachment = { name: "book.pdf", mimeType: "application/pdf", size: SIMPLE.length, download: async () => SIMPLE };
    const saved = await uploads.ingest(attachment);
    assert.equal(saved.text?.name, "2026-11-16-book.pdf.txt");
    assert.equal(fs.readFileSync(saved.text!.path, "utf8"), "One\fTwo");
    assert.equal(saved.note, undefined);
    assert.match(receiptText([saved], []), /text read: 2 words/);
  } finally {
    if (previous === undefined) delete process.env.PDFTOTEXT_PATH;
    else process.env.PDFTOTEXT_PATH = previous;
  }
});

test("the stand-ins all ran in a directory of their own", () => {
  assert.ok(STUBS.length >= 8, "the parser's own cases all ran");
  for (const s of STUBS) assert.equal(fs.existsSync(path.dirname(s.path)), true);
});
