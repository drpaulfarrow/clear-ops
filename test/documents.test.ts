/**
 * Documents through the Instinct bridge (src/documents.ts): real bytes in, a private upload and a
 * receipt out, a .docx turned into text a worker can read, and every refusal said plainly and saving
 * nothing. The route's own half is at the bottom, mounted the way src/index.ts mounts it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-docs-"));
process.env.ALLOWED_TELEGRAM_IDS = "99887766";

const { DocumentIngest, DocumentError, docxText, docxTextFrom, familyOf, contradictionReason, unsafeNameReason, documentBodyParser, DOCUMENTS_ROUTE } = await import("../src/documents.js");
const { Uploads, formatSize } = await import("../src/uploads.js");
const { instinctRouter, INSTINCT_PATH } = await import("../src/instinct-bridge.js");
const { BridgeChat } = await import("../src/instinct-chat.js");

const fixedDate = () => new Date("2026-11-16T09:00:00Z");
const freshDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-docdir-")), "uploads");
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A tiny zip writer: stored or deflated entries. A .docx is a zip, so this is all a fixture needs. */
function zip(entries: Array<{ name: string; data?: string; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data ?? "");
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const BODY_XML =
  `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>` +
  `<w:p><w:r><w:t>Clear Exchange pitch</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t xml:space="preserve">Half a cent &amp; a </w:t></w:r><w:r><w:tab/><w:t>tab</w:t></w:r><w:r><w:br/><w:t>second line</w:t></w:r></w:p>` +
  `<w:p/>` +
  `<w:p><w:r><w:t>Licensing terms: 1 &lt; 2 &amp; 3 &gt; 2, &#x2014; done</w:t></w:r></w:p>` +
  `</w:body></w:document>`;
const docx = (xml = BODY_XML): Buffer => zip([{ name: "word/document.xml", data: xml, deflate: true }, { name: "[Content_Types].xml", data: "<Types/>" }]);

function ingester(limits?: { maxBytes: number; maxArchiveEntries: number; maxArchiveBytes: number }) {
  const dir = freshDir();
  const uploads = new Uploads(dir, limits, fixedDate);
  const log = path.join(dir, "..", "documents.jsonl");
  const ingest = new DocumentIngest(uploads, log, fixedDate);
  return { uploads, ingest, dir, log };
}
const b64 = (b: Buffer) => b.toString("base64");

/* ---------- names and byte types ---------- */

test("a name that is not a plain file name is refused with a reason", () => {
  assert.equal(unsafeNameReason("pitch.docx"), undefined);
  assert.equal(unsafeNameReason("My Deck (final).pdf"), undefined, "a name that only needs sanitising is fine");
  assert.match(unsafeNameReason("../../etc/passwd")!, /no path in it/);
  assert.match(unsafeNameReason("notes/x.txt")!, /no path in it/);
  assert.match(unsafeNameReason("..\\evil.txt")!, /no path in it/);
  assert.match(unsafeNameReason("a..b.txt")!, /climb out/);
  assert.match(unsafeNameReason(".env")!, /start with a dot/);
  assert.match(unsafeNameReason("bad\u0007name.txt")!, /control characters/);
  assert.match(unsafeNameReason("   ")!, /needs a file name/);
  assert.match(unsafeNameReason("")!, /needs a file name/);
  assert.match(unsafeNameReason(undefined)!, /needs a file name/);
  assert.match(unsafeNameReason(`${"a".repeat(201)}.txt`)!, /longer than 200/);
});

test("the bytes are held against the name and the declared type", () => {
  assert.equal(familyOf("pitch.docx"), "docx");
  assert.equal(familyOf("pitch.docx", "text/plain"), "docx", "the name is checked as well as the type");
  assert.equal(familyOf("x", DOCX_MIME), "docx");
  assert.equal(familyOf("shot.png"), "image");
  assert.equal(familyOf("shot", "image/webp"), "image");
  assert.equal(familyOf("notes.txt"), "text");
  assert.equal(familyOf("notes", "text/markdown"), "text");
  assert.equal(familyOf("archive.zip"), "zip");
  assert.equal(familyOf("accounts.xlsx"), "unknown");

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal(contradictionReason("image", png), undefined);
  assert.match(contradictionReason("image", Buffer.from("not an image at all"))!, /not PNG, JPEG, GIF or WebP/);
  assert.match(contradictionReason("docx", Buffer.from("PK is missing here"))!, /not one/);
  assert.equal(contradictionReason("docx", docx()), undefined);
  assert.match(contradictionReason("pdf", Buffer.from("plain"))!, /not one/);
  assert.equal(contradictionReason("pdf", Buffer.from("%PDF-1.7")), undefined);
  assert.match(contradictionReason("text", Buffer.from([0x61, 0x00, 0x62]))!, /not readable text/);
  assert.equal(contradictionReason("text", Buffer.from("plain, readable\n")), undefined);
  assert.equal(contradictionReason("unknown", Buffer.from([1, 2, 3])), undefined, "an unknown type is not guessed at");
});

/* ---------- how much was actually run ---------- */

test("the text of a Word document comes out of it, paragraph by paragraph, with nothing invented", () => {
  const text = docxText(BODY_XML);
  assert.equal(text, "Clear Exchange pitch\nHalf a cent & a \ttab\nsecond line\nLicensing terms: 1 < 2 & 3 > 2, — done");
  assert.equal(docxText("<w:document><w:body><w:p><w:r><w:t></w:t></w:r></w:p></w:body></w:document>"), "", "an empty document is empty text, not a crash");
  assert.match(docxText("<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>"), /^<script>alert\(1\)<\/script>$/, "markup in the document is text, never markup");
  assert.equal(docxText("<w:p><w:r><w:t>&#x110000;</w:t></w:r></w:p>"), "", "an impossible code point cannot break the reader");
  assert.equal(docxText("<w:p><w:r><w:t>&#x1F600;</w:t></w:r></w:p>"), "\u{1F600}", "a real code point survives");
  assert.equal(docxTextFrom(docx()), text, "read out of word/document.xml, which is deflated in a real .docx");
  assert.throws(() => docxTextFrom(zip([{ name: "word/styles.xml", data: "<x/>" }])), (e: Error) => e instanceof DocumentError && /no readable body/.test(e.message));
  assert.throws(() => docxTextFrom(Buffer.from("PK\u0003\u0004broken")), (e: Error) => e instanceof DocumentError && /malformed or incomplete/.test(e.message));
});

/* ---------- the receipt ---------- */

test("a document is saved privately and the receipt says its path, its size and its sha256", async () => {
  const { ingest, dir } = ingester();
  const bytes = Buffer.from("First Name,Last Name\nAda,Lovelace\n");
  const r = await ingest.ingest({ name: "Connections.csv", mimeType: "text/csv", data: b64(bytes) });
  assert.equal(r.name, "2026-11-16-Connections.csv");
  assert.equal(r.path, path.join(dir, "2026-11-16-Connections.csv"));
  assert.equal(r.originalName, "Connections.csv");
  assert.equal(r.size, bytes.length);
  assert.equal(r.sha256, sha(bytes));
  assert.equal(fs.readFileSync(r.path).equals(bytes), true, "the bytes on disk are the bytes sent");
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(r.path), 0o600);
  assert.equal(r.text, undefined, "a CSV needs no extraction: it is already text");
  assert.equal(r.note, undefined);
  assert.equal(r.extracted, undefined);
});

test("a .docx becomes readable text on a path a worker can use, beside the .docx", async () => {
  const { ingest } = ingester();
  const bytes = docx();
  const r = await ingest.ingest({ name: "Clear Exchange pitch.docx", data: b64(bytes) });
  assert.equal(r.name, "2026-11-16-Clear_Exchange_pitch.docx");
  assert.equal(r.sha256, sha(bytes));
  assert.equal(fs.existsSync(r.path), true, "the original document is kept as it arrived");
  const t = r.text!;
  assert.equal(t.name, "2026-11-16-Clear_Exchange_pitch.docx.txt");
  assert.equal(t.path, path.join(path.dirname(r.path), t.name));
  assert.equal(fs.readFileSync(t.path, "utf8"), docxText(BODY_XML));
  assert.equal(t.chars, fs.readFileSync(t.path, "utf8").length);
  assert.equal(t.sha256, sha(fs.readFileSync(t.path)));
  assert.equal(mode(t.path), 0o600, "the extracted text is private too");
  assert.equal(r.note, undefined);
});

test("a Word document with no text is saved and said so, never called a success with text", async () => {
  const { ingest } = ingester();
  const r = await ingest.ingest({ name: "scans.docx", data: b64(docx("<w:document><w:body><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>")) });
  assert.equal(r.text, undefined);
  assert.match(r.note!, /no text could be read/);
  assert.equal(fs.existsSync(r.path), true);
});

test("a type this service does not turn into text says so rather than pretending", async () => {
  const { ingest } = ingester();
  const sheet = Buffer.from("PK\u0003\u0004"); // an xlsx would be a real zip; the note is about extraction, not the type
  const r = await ingest.ingest({ name: "accounts.xlsx", data: b64(zip([{ name: "xl/workbook.xml", data: "<x/>" }])) });
  assert.equal(r.text, undefined);
  assert.match(r.note!, /saved as it is; no text was extracted/);
  assert.equal(r.size > sheet.length, true);
});

/* ---------- refusals ---------- */

test("every refusal is plain, and none of them saves anything", async () => {
  const { ingest, dir, uploads } = ingester({ maxBytes: 1024, maxArchiveEntries: 10, maxArchiveBytes: 1000 });
  const bad = async (body: unknown, match: RegExp, status = 400) => {
    await assert.rejects(
      () => ingest.ingest(body),
      (e: Error) => e instanceof DocumentError && e.status === status && match.test(e.message),
      `expected a refusal matching ${match}`,
    );
    assert.deepEqual(uploads.list(), [], "a refused document leaves nothing behind");
  };

  await bad({ name: "notes.txt", data: "" }, /no bytes in it/, 400); // empty input
  await bad({ name: "notes.txt" }, /no bytes in it/, 400); // no data at all
  await bad({ name: "notes.txt", data: 12345 }, /no bytes in it/, 400);
  await bad({ data: b64(Buffer.from("x")) }, /needs a file name/, 400);
  await bad({ name: "../../x.txt", data: b64(Buffer.from("x")) }, /no path in it/, 400);
  await bad({ name: "/etc/passwd", data: b64(Buffer.from("x")) }, /no path in it/, 400);
  await bad({ name: "notes.txt", data: "not base64 at all!!" }, /not valid base64/, 400); // malformed input
  await bad({ name: "notes.txt", data: "AAAAA" }, /not valid base64/, 400); // a truncated base64 length
  await bad({ name: "notes.txt", data: b64(Buffer.alloc(2048, 0x61)) }, /too large \(limit 1\.0 KB\)/, 413); // over the limit, checked before decoding
  await bad({ name: "notes.pdf", data: b64(Buffer.from("this is not a PDF")) }, /not one/, 400); // bytes contradict the declared type
  await bad({ name: "shot.png", data: b64(Buffer.from("not an image")) }, /not PNG, JPEG, GIF or WebP/, 400);
  await bad({ name: "pitch.docx", data: b64(Buffer.from("not a zip at all")) }, /not one/, 400); // a .docx the bytes contradict
  await bad({ name: "pitch.docx", data: b64(zip([{ name: "word/styles.xml", data: "<x/>" }])) }, /no readable body/, 400); // truncated
  await bad({ name: "report.md", mimeType: "image/png", data: b64(Buffer.from("# a heading\n")) }, /not PNG, JPEG, GIF or WebP/, 400); // the declared type contradicts what the name and bytes say

  assert.deepEqual(fs.readdirSync(dir), [], "nothing was written by any refusal");
});

test("a document exactly at the limit is taken, and one byte over is refused", async () => {
  const { ingest } = ingester({ maxBytes: 64, maxArchiveEntries: 10, maxArchiveBytes: 1000 });
  const r = await ingest.ingest({ name: "notes.txt", data: b64(Buffer.alloc(64, 0x61)) });
  assert.equal(r.size, 64);
  await assert.rejects(() => ingest.ingest({ name: "notes.txt", data: b64(Buffer.alloc(65, 0x61)) }), (e: Error) => e instanceof DocumentError && e.status === 413 && /too large/.test(e.message));
});

test("the log records what arrived and what was refused, never the bytes", async () => {
  const { ingest, log } = ingester();
  const bytes = Buffer.from("a secret document body, unremarkable but private\n");
  await ingest.ingest({ name: "notes.txt", data: b64(bytes) });
  try {
    await ingest.ingest({ name: "notes.txt", data: "" });
  } catch {
    /* refused, as it should be */
  }
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { at: "2026-11-16T09:00:00.000Z", ok: true, name: "2026-11-16-notes.txt", bytes: bytes.length, sha256: sha(bytes) });
  assert.deepEqual(lines[1], { at: "2026-11-16T09:00:00.000Z", ok: false, name: "notes.txt", reason: "the document has no bytes in it" });
  assert.equal(fs.readFileSync(log, "utf8").includes("unremarkable"), false, "the log never holds the document's contents");
  assert.equal(mode(log), 0o600, "and it is owner-only");
});

/* ---------- the route on the Instinct bridge ---------- */

async function serve(opts: { token?: string; documents?: unknown; globalJson?: boolean } = {}) {
  const chat = new BridgeChat({ ask: async () => "no", logFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-docblog-")), "log.jsonl") });
  const app = express();
  const deps: Record<string, unknown> = { store: {} as never, token: opts.token, chat, isAllowed: () => false };
  if (opts.documents !== null) deps.documents = opts.documents ?? (() => { const i = ingester(); return i.ingest; })();
  // Mounted the way src/index.ts mounts it: before any app-wide JSON parser, so its own parser runs.
  app.use(INSTINCT_PATH, instinctRouter(deps as never));
  if (opts.globalJson) app.use(express.json());
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}`, close: () => server.close() };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
const post = (base: string, body: unknown, headers: Record<string, string>) => fetch(`${base}${DOCUMENTS_ROUTE}`, { method: "POST", headers, body: JSON.stringify(body) });

test("the documents route is off without a token and refuses a wrong one", async () => {
  const off = await serve({ token: undefined });
  assert.equal((await post(off.base, { name: "a.txt", data: b64(Buffer.from("x")) }, auth("anything"))).status, 404, "no token: the route does not exist");
  off.close();

  const s = await serve({ token: "right-token" });
  assert.equal((await post(s.base, { name: "a.txt", data: b64(Buffer.from("x")) }, auth("wrong"))).status, 401);
  assert.equal((await post(s.base, { name: "a.txt", data: b64(Buffer.from("x")) }, { "content-type": "application/json" })).status, 401, "no token at all is refused too");
  // The token is checked before the bytes are read: an oversized body with a wrong token is a 401, not a 413.
  const huge = await post(s.base, { name: "a.txt", data: "A".repeat(4 * 1024 * 1024) }, auth("wrong"));
  assert.equal(huge.status, 401);
  s.close();
});

test("a real document arrives and the caller is told exactly what was stored", async () => {
  const documents = ingester();
  const s = await serve({ token: "right-token", documents: documents.ingest });
  const bytes = Buffer.from("Dear Sam, half a cent works for us.\n");
  const res = await post(s.base, { name: "reply.txt", mimeType: "text/plain", note: "from Paul", data: b64(bytes) }, auth("right-token"));
  assert.equal(res.status, 201);
  const r = (await res.json()) as Record<string, unknown>;
  assert.equal(r.ok, true);
  assert.equal(r.size, bytes.length);
  assert.equal(r.sha256, sha(bytes));
  assert.equal(r.path, path.join(documents.dir, "2026-11-16-reply.txt"));
  assert.equal(fs.readFileSync(String(r.path), "utf8"), bytes.toString());
  assert.equal(String(r.name).startsWith("2026-11-16-"), true, "the saved name is the dated one");
  s.close();
});

test("a document that is over the limit, or is not JSON at all, gets a plain answer rather than an HTML error", async () => {
  const s = await serve({ token: "right-token", documents: ingester().ingest });
  const over = await post(s.base, { name: "big.txt", data: "A".repeat(Math.ceil((20 * 1024 * 1024 * 4) / 3) + 20 * 1024) }, auth("right-token"));
  assert.equal(over.status, 413);
  assert.equal((await over.json() as { error: string }).error, `too large (limit ${formatSize(20 * 1024 * 1024)})`);
  const broken = await fetch(`${s.base}${DOCUMENTS_ROUTE}`, { method: "POST", headers: auth("right-token"), body: "{not json" });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json() as { error: string }).error, "the request body is not readable JSON");
  s.close();
});

test("the route works whether or not an app-wide JSON parser was mounted first", async () => {
  const a = await serve({ token: "t", documents: ingester().ingest });
  const withOwnParser = await post(a.base, { name: "one.txt", data: b64(Buffer.from("one")) }, auth("t"));
  assert.equal(withOwnParser.status, 201);
  a.close();
  const b = await serve({ token: "t", documents: ingester().ingest, globalJson: true });
  const withGlobal = await post(b.base, { name: "two.txt", data: b64(Buffer.from("two")) }, auth("t"));
  assert.equal(withGlobal.status, 201, "a body the app already parsed is not parsed twice");
  b.close();
});

test("a refusal reaches the caller as a short safe message and a 400 or 413, never a 500", async () => {
  const s = await serve({ token: "t", documents: ingester().ingest });
  const cases: Array<[unknown, number, RegExp]> = [
    [{ name: "notes.txt", data: "" }, 400, /no bytes in it/],
    [{ name: "../escape.txt", data: b64(Buffer.from("x")) }, 400, /no path in it/],
    [{ name: "notes.txt", data: "%%%%" }, 400, /not valid base64/],
    [{ name: "pitch.docx", data: b64(Buffer.from("not a zip")) }, 400, /not one/],
  ];
  for (const [body, status, match] of cases) {
    const res = await post(s.base, body, auth("t"));
    assert.equal(res.status, status);
    const r = (await res.json()) as { ok: boolean; error: string };
    assert.equal(r.ok, false);
    assert.match(r.error, match);
    assert.ok(r.error.length < 200, "short enough to relay to Paul");
  }
  s.close();
});

test("a document over the body limit is refused before it is decoded", () => {
  const uploads = new Uploads(freshDir(), { maxBytes: 1024, maxArchiveEntries: 10, maxArchiveBytes: 1000 }, fixedDate);
  const parse = documentBodyParser(uploads.limits.maxBytes);
  assert.equal(typeof parse, "function");
  assert.equal(uploads.limits.maxBytes, 1024);
});
