import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pdf-"));

const { pdfText, pdfTextNote, isPdfData, countWords, parseToUnicode } = await import("../src/pdf.js");
const { Uploads, describeUploads, receiptText } = await import("../src/uploads.js");

/**
 * The fixtures are built here, from scratch, without any of the reader's own code: a PDF written by
 * these helpers is what a real writer (a browser's print dialog, a word processor) produces, so a test
 * that passes because the reader and the fixture agree by accident is not possible.
 */

type Body = string | { dict: string; stream: Buffer };

/** A stream body as a writer emits one: Flate-compressed, with its own length. */
function streamOf(text: string, extraDict = ""): Body {
  const data = deflateSync(Buffer.from(text, "latin1"));
  return { dict: `<< /Length ${data.length} /Filter /FlateDecode${extraDict} >>`, stream: data };
}

/** A PDF from whole object bodies, with a real cross-reference table and a classic trailer. */
function buildPdf(bodies: Body[], trailerExtras = "", header = "%PDF-1.4\n"): Buffer {
  const out: Buffer[] = [Buffer.from(header, "latin1")];
  let at = out[0].length;
  const offsets: number[] = [];
  const push = (b: Buffer): void => {
    out.push(b);
    at += b.length;
  };
  bodies.forEach((body, i) => {
    offsets.push(at);
    if (typeof body === "string") push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1"));
    else
      push(
        Buffer.concat([
          Buffer.from(`${i + 1} 0 obj\n${body.dict}\nstream\n`, "latin1"),
          body.stream,
          Buffer.from("\nendstream\nendobj\n", "latin1"),
        ]),
      );
  });
  const xref = at;
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`;
  push(Buffer.from(`${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R${trailerExtras} >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(out);
}

/** A PDF whose objects carry the numbers they are given, with no cross-reference at all. */
function buildPdfNumbered(objects: Array<{ num: number; body: Body }>, header = "%PDF-1.5\n"): Buffer {
  const out: Buffer[] = [Buffer.from(header, "latin1")];
  for (const o of [...objects].sort((a, b) => a.num - b.num)) {
    if (typeof o.body === "string") out.push(Buffer.from(`${o.num} 0 obj\n${o.body}\nendobj\n`, "latin1"));
    else
      out.push(
        Buffer.concat([
          Buffer.from(`${o.num} 0 obj\n${o.body.dict}\nstream\n`, "latin1"),
          o.body.stream,
          Buffer.from("\nendstream\nendobj\n", "latin1"),
        ]),
      );
  }
  out.push(Buffer.from("%%EOF\n", "latin1"));
  return Buffer.concat(out);
}

/** An object stream, packed the way a PDF 1.5 writer does it: pairs of numbers, then the bodies. */
function objectStream(entries: Array<{ num: number; body: string }>): Body {
  let header = "";
  let payload = "";
  for (const e of entries) {
    header += `${e.num} ${Buffer.byteLength(payload, "latin1")} `;
    payload += `${e.body}\n`;
  }
  const first = Buffer.byteLength(header, "latin1");
  const data = deflateSync(Buffer.from(header + payload, "latin1"));
  return { dict: `<< /Type /ObjStm /N ${entries.length} /First ${first} /Length ${data.length} /Filter /FlateDecode >>`, stream: data };
}

/* --------------------------------- fixtures -------------------------------- */

/** One page, a classic xref table, WinAnsi text shown with Tj and TJ. */
const SIMPLE = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  streamOf(
    String.raw`BT /F1 12 Tf 72 720 Td (Hello world) Tj 0 -18 Td (Caf\351 and \222quotes\224) Tj ET` +
      "\n" +
      String.raw`BT /F1 12 Tf 72 680 Td [(Two) -250 (words) -250 (together)] TJ ET` +
      "\n" +
      String.raw`BT /F1 12 Tf 72 660 Td [(Wa) 20 (ter)] TJ ET` +
      "\n",
  ),
]);

/** Two pages, no classic trailer, its dictionaries packed into an object stream, and a subsetted font
 * whose glyph codes are two bytes that mean nothing without the ToUnicode CMap. */
const OBJECT_STREAM_PDF = (() => {
  const toUnicode = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange <0041> <0043> <0041> endbfrange
2 beginbfchar <0044> <00660069> <0045> <0020> endbfchar
endcmap end end`;
  const page1 = "BT /F1 14 Tf 72 700 Td <004100420043> Tj ET\n"; // ABC
  const page2 = "BT /F1 14 Tf 72 700 Td <0044004500410042> Tj 0 -18 Td <00410043> Tj ET\n"; // "fi AB", then "AC"
  const packed = objectStream([
    { num: 2, body: "<< /Type /Catalog /Pages 3 0 R >>" },
    { num: 3, body: "<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>" },
    { num: 4, body: "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>" },
    { num: 5, body: "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 10 0 R >>" },
  ]);
  // The cross-reference is a stream, as a PDF 1.5 file writes it, and this reader never consults one:
  // it finds every object by scanning, which is the property this fixture is here to hold.
  const xrefEntries = Buffer.alloc(48, 0);
  return buildPdfNumbered([
    { num: 1, body: packed },
    { num: 6, body: "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Test /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>" },
    { num: 7, body: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>" },
    { num: 8, body: streamOf(toUnicode) },
    { num: 9, body: streamOf(page1) },
    { num: 10, body: streamOf(page2) },
    { num: 11, body: { dict: `<< /Type /XRef /Size 12 /Root 2 0 R /W [1 2 1] /Length ${xrefEntries.length} >>`, stream: xrefEntries } },
  ]);
})();

/** A scan: a page that draws an image and has no text operators at all. */
const SCAN = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
  { dict: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length 9 >>", stream: deflateSync(Buffer.from([0, 255])) },
  streamOf("q 612 0 0 792 0 0 cm /Im1 Do Q\n"),
]);

/** Two pages where only the first has text: a partial read must never pass as a whole one. */
const PARTIAL = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
  streamOf("BT /F1 10 Tf 72 700 Td (Chapter one) Tj ET\n"),
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R >>",
  streamOf("q 1 0 0 1 0 0 cm Q\n"),
]);

/** A file whose trailer holds an /Encrypt dictionary: its strings are not readable here. */
const ENCRYPTED = buildPdf(
  ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>", "<< /Filter /Standard /V 2 /R 3 /O (x) /U (y) /P -1 >>"],
  " /Encrypt 3 0 R",
);

/** A font with `/Encoding /WinAnsiEncoding` and no ToUnicode: the ordinary single-byte case. */
const WIN_ANSI_ONLY = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding /FirstChar 65 /Widths [600 600 600] >>",
  streamOf(String.raw`BT /F1 12 Tf 72 700 Td (Price \2435 and \223word\224) Tj ET` + "\n"),
]);

/** A font with neither ToUnicode nor an encoding we can read: its codes must be counted, not guessed. */
const UNDECODABLE_FONT = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type0 /BaseFont /BBBBBB+Test /Encoding /Identity-H /DescendantFonts [6 0 R] >>",
  streamOf("BT /F1 12 Tf 72 700 Td <00410042> Tj ET\n"),
  "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BBBBBB+Test /DW 1000 >>",
]);

/* ----------------------------------- tests ---------------------------------- */

test("a PDF with one page of WinAnsi text is read whole, Tj and TJ alike", () => {
  const result = pdfText(SIMPLE);
  assert.equal(result.reason, undefined);
  assert.equal(result.pages, 1);
  assert.equal(result.pagesWithText, 1);
  assert.equal(result.pagesWithoutText.length, 0);
  // The TJ gaps become word spaces, and a positive (tightening) adjustment does not.
  assert.equal(result.text, "Hello world\nCafé and ’quotes”\nTwo words together\nWater");
  assert.equal(result.words, 9);
  assert.equal(result.chars, result.text.length);
  assert.equal(result.truncated, false);
  assert.equal(pdfTextNote(result), undefined);
});

test("a mixture of escaping and encodings never invents a character", () => {
  const result = pdfText(WIN_ANSI_ONLY);
  assert.equal(result.text, "Price £5 and “word”");
  assert.equal(result.undecoded, 0);
});

test("object streams, an xref stream, Identity-H codes and a ToUnicode CMap are all understood", () => {
  const result = pdfText(OBJECT_STREAM_PDF);
  assert.equal(result.reason, undefined);
  assert.equal(result.pages, 2);
  assert.equal(result.pagesWithText, 2);
  // A form feed separates the pages, and the CMap's two-byte codes, including a two-character
  // destination, come back as the characters it names.
  assert.equal(result.text, "ABC\ffi AB\nAC");
  assert.equal(result.undecoded, 0);
});

test("several pages keep their order and their page breaks", () => {
  const result = pdfText(PARTIAL);
  assert.equal(result.pages, 2);
  assert.equal(result.text, "Chapter one");
  assert.deepEqual(result.pagesWithoutText, [2]);
  assert.match(pdfTextNote(result) ?? "", /1 of 2 pages had no text \(page 2\)/);
});

test("a scan has no text layer at all, and says so instead of returning empty text as a success", () => {
  const result = pdfText(SCAN);
  assert.equal(result.text, "");
  assert.equal(result.chars, 0);
  assert.equal(result.pages, 1);
  assert.deepEqual(result.pagesWithoutText, [1]);
  assert.match(result.reason ?? "", /no text layer/);
  assert.match(pdfTextNote(result) ?? "", /no text layer/);
});

test("an encrypted PDF is refused plainly rather than read as gibberish", () => {
  const result = pdfText(ENCRYPTED);
  assert.equal(result.text, "");
  assert.match(result.reason ?? "", /encrypted/);
});

test("a font with no readable encoding is counted, never guessed", () => {
  const result = pdfText(UNDECODABLE_FONT);
  assert.equal(result.text, "");
  assert.ok(result.undecoded > 0);
  assert.match(result.reason ?? "", /font carries no encoding/); // not called a scan, which it is not
  assert.match(pdfTextNote(result) ?? "", /font carries no encoding/);
});

test("a file that is not a PDF, or is damaged, comes back with a reason and never throws", () => {
  assert.equal(pdfText(Buffer.from("just some text, not a PDF")).reason, "the file is not a readable PDF");
  const torn = pdfText(Buffer.concat([SIMPLE.subarray(0, 300)]));
  assert.equal(torn.text, "");
  assert.ok(torn.reason);
  assert.equal(isPdfData(SIMPLE), true);
  assert.equal(isPdfData(Buffer.from("no")), false);
});

test("a huge document stops at the character limit and says the text is partial", () => {
  const page = Array.from({ length: 40 }, (_, i) => `(word${i} filler filler filler) Tj 0 -14 Td`).join(" ");
  const big = buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamOf(`BT /F1 12 Tf 72 700 Td ${page} ET\n`),
  ]);
  const result = pdfText(big, { maxChars: 60 });
  assert.equal(result.chars, 60);
  assert.equal(result.truncated, true);
  assert.equal(countWords(result.text) > 0, true);
  assert.match(pdfTextNote(result) ?? "", /partial/);
});

test("the ToUnicode reader reads both CMap sections", () => {
  const cmap = parseToUnicode(
    `begincodespacerange <0000> <FFFF> endcodespacerange
     beginbfrange <0020> <0022> <0041> endbfrange
     beginbfchar <0041> <00660069> endbfchar`,
  );
  assert.equal(cmap.codeBytes, 2);
  assert.equal(cmap.map.get(0x20), "A");
  assert.equal(cmap.map.get(0x21), "B");
  assert.equal(cmap.map.get(0x22), "C");
  assert.equal(cmap.map.get(0x41), "fi");
});

const fixedDate = () => new Date("2026-11-16T09:00:00Z");
const freshDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pdfdir-")), "uploads");
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

test("saving a PDF writes its text beside it, owner-only, under the same date and stem", () => {
  const dir = freshDir();
  const uploads = new Uploads(dir, { maxBytes: 8_000_000, maxArchiveEntries: 100, maxArchiveBytes: 1000 }, fixedDate);
  const saved = uploads.save("book-submission.pdf", SIMPLE, "application/pdf");

  assert.equal(saved.name, "2026-11-16-book-submission.pdf");
  assert.ok(saved.text, "the extraction should be recorded on the saved upload");
  assert.equal(saved.text?.name, "2026-11-16-book-submission.pdf.txt");
  assert.equal(saved.text?.path, path.join(dir, "2026-11-16-book-submission.pdf.txt"));
  assert.equal(saved.text?.words, 9);
  assert.equal(fs.readFileSync(saved.text!.path, "utf8"), "Hello world\nCafé and ’quotes”\nTwo words together\nWater");
  assert.equal(modeOf(saved.text!.path), 0o600);
  assert.equal(modeOf(dir), 0o700);
  assert.equal(saved.note, undefined);

  const told = describeUploads([saved], [], 0);
  assert.match(told, /text read out of it is saved beside it/i);
  assert.match(told, /2026-11-16-book-submission\.pdf\.txt/);
  assert.match(receiptText([saved], []), /text read: 9 words/);
});

test("a scan writes no companion file and is reported plainly instead", () => {
  const dir = freshDir();
  const uploads = new Uploads(dir, { maxBytes: 8_000_000, maxArchiveEntries: 100, maxArchiveBytes: 1000 }, fixedDate);
  const saved = uploads.save("scan.pdf", SCAN, "application/pdf");

  assert.equal(saved.text, undefined);
  assert.match(saved.note ?? "", /no text layer/);
  assert.deepEqual(fs.readdirSync(dir), ["2026-11-16-scan.pdf"]);
  assert.match(describeUploads([saved], [], 0), /no text layer/);
  assert.match(receiptText([saved], []), /no text layer/);
});

test("a second upload of the same name gets its own companion, never overwriting an earlier one", () => {
  const dir = freshDir();
  const uploads = new Uploads(dir, { maxBytes: 8_000_000, maxArchiveEntries: 100, maxArchiveBytes: 1000 }, fixedDate);
  const first = uploads.save("book.pdf", SIMPLE, "application/pdf");
  const second = uploads.save("book.pdf", SIMPLE, "application/pdf");
  assert.equal(first.text?.name, "2026-11-16-book.pdf.txt");
  assert.equal(second.name, "2026-11-16-book-2.pdf");
  assert.equal(second.text?.name, "2026-11-16-book-2.pdf.txt");
  assert.equal(fs.readdirSync(dir).sort().join(","), "2026-11-16-book-2.pdf,2026-11-16-book-2.pdf.txt,2026-11-16-book.pdf,2026-11-16-book.pdf.txt");
  // Deleting the PDF takes its companion with it, as it does for an unpacked archive.
  const gone = uploads.delete("book.pdf");
  assert.deepEqual(gone.deleted.sort(), ["2026-11-16-book.pdf", "2026-11-16-book.pdf.txt"]);
});

test("a chat upload that is not a PDF is untouched by any of this", () => {
  const dir = freshDir();
  const uploads = new Uploads(dir, { maxBytes: 8_000_000, maxArchiveEntries: 100, maxArchiveBytes: 1000 }, fixedDate);
  const saved = uploads.save("notes.txt", Buffer.from("hello"), "text/plain");
  assert.equal(saved.text, undefined);
  assert.equal(saved.note, undefined);
  assert.deepEqual(fs.readdirSync(dir), ["2026-11-16-notes.txt"]);
});
