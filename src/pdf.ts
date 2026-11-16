/**
 * The text of a PDF, using nothing but Node's own zlib.
 *
 * A PDF Paul or his assistant sends lands in the uploads directory as bytes no worker here can read:
 * the page text sits inside Flate-compressed streams, and no PDF tool (pdftotext, pdftoppm) exists in
 * this image. So this module reads the file itself and hands back the text, which is saved as a
 * plain-text companion beside the PDF (src/uploads.ts) so a worker can read it with its ordinary file
 * tools.
 *
 * What it handles, which is what generated PDFs actually use: a classic xref table or none at all
 * (every object is found by scanning the file, so a broken, absent or stream-based cross-reference
 * costs nothing), objects packed into object streams (`/Type /ObjStm`), page content streams with the
 * text operators (`Tj`, `TJ`, `'`, `"`), the ordinary encodings (WinAnsi, Standard and `/Differences`)
 * and the `ToUnicode` CMap that a subsetted font carries (the usual case for anything printed from a
 * browser: `/Encoding /Identity-H` two-byte glyph codes with no meaning at all without that CMap),
 * several pages, text inside Form XObjects, and inline images, which are skipped.
 *
 * What it will not do is pretend. A PDF with no text layer at all (a scan) yields no text and a plain
 * reason rather than an empty string called a success; a page that yielded nothing is counted and
 * named, so a partial read is never reported as a complete one; an encrypted file says so; and
 * characters run through a font with no usable encoding are counted as undecoded rather than silently
 * dropped. Nothing is invented: every character comes from the file.
 *
 * Known gaps, all reported rather than hidden: an LZW or JBIG2 stream is not decoded (both are rare in
 * anything generated today), a font with neither `ToUnicode` nor an encoding we know leaves its text
 * undecoded, and a CID font written with an embedded CMap file falls back to two-byte codes.
 */
import { inflateRawSync, inflateSync } from "node:zlib";

/** A name object (`/Pages`). Kept apart from a plain string so the parser can tell them apart. */
class PdfName {
  constructor(readonly name: string) {}
}

/** An indirect reference (`12 0 R`). */
interface PdfRef {
  num: number;
  gen: number;
}

type PdfDict = Map<string, PdfValue>;
type PdfValue = PdfName | PdfRef | Buffer | number | boolean | null | PdfValue[] | PdfDict;

interface StoredObject {
  value: PdfValue;
  /** Raw stream bytes as they sit in the file, still filtered. */
  stream?: Buffer;
}

/** What reading one PDF produced. */
export interface PdfText {
  /** The text, pages separated by a form feed. Empty when there is none. */
  text: string;
  /** Pages the reader looked at. */
  pages: number;
  pagesWithText: number;
  /** 1-based numbers of the pages that yielded no text at all. */
  pagesWithoutText: number[];
  chars: number;
  words: number;
  /** Why there is no text, in plain words, when there is none. */
  reason?: string;
  /** True when a limit stopped the read rather than the end of the document: the text is partial. */
  truncated: boolean;
  /** Characters that ran through a font with no usable encoding, so could not be read. */
  undecoded: number;
}

export interface PdfLimits {
  maxPages?: number;
  maxChars?: number;
  /** Model-free work budget: content-stream tokens and objects. */
  maxSteps?: number;
}

const DEFAULT_PAGES = 2000;
const DEFAULT_CHARS = 4_000_000;
const DEFAULT_STEPS = 6_000_000;
/** A single decompressed stream we will look at, as a guard against a decompression bomb. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_FORM_DEPTH = 6;

/** True when these bytes are a PDF, by the file's own magic rather than its name. */
export function isPdfData(data: Buffer): boolean {
  return data.length >= 5 && data.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Words in extracted text, counted the ordinary way: runs of non-space characters. */
export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/* --------------------------------- reading --------------------------------- */

const isWhite = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelimiter = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number): boolean => !isWhite(c) && !isDelimiter(c);
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

type Token =
  | { k: "num"; n: number }
  | { k: "str"; bytes: Buffer }
  | { k: "name"; n: string }
  | { k: "arr"; a: PdfValue[] }
  | { k: "dict"; d: PdfDict }
  | { k: "bool"; b: boolean }
  | { k: "null" }
  | { k: "op"; o: string }
  | { k: "end" };

/**
 * The PDF object grammar, read as latin1 so one character is always one byte and offsets stay true.
 * Comments, whitespace, literal strings with their escapes, hex strings, names with `#xx` escapes,
 * arrays, dictionaries, numbers, booleans, null and bare keywords (which the content interpreter
 * reads as operators).
 */
class Reader {
  at: number;

  constructor(readonly src: string, at = 0) {
    this.at = at;
  }

  skip(): void {
    while (this.at < this.src.length) {
      const c = this.src.charCodeAt(this.at);
      if (isWhite(c)) {
        this.at++;
        continue;
      }
      if (c === 0x25) {
        while (this.at < this.src.length && this.src.charCodeAt(this.at) !== 0x0a) this.at++;
        continue;
      }
      break;
    }
  }

  next(): Token {
    this.skip();
    if (this.at >= this.src.length) return { k: "end" };
    const c = this.src.charCodeAt(this.at);
    if (c === 0x2f) return { k: "name", n: this.name() };
    if (c === 0x28) return { k: "str", bytes: this.literalString() };
    if (c === 0x3c) {
      if (this.src.charCodeAt(this.at + 1) === 0x3c) return { k: "dict", d: this.dict() };
      return { k: "str", bytes: this.hexString() };
    }
    if (c === 0x5b) return { k: "arr", a: this.array() };
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const n = this.number();
      if (n !== undefined) return { k: "num", n };
    }
    const word = this.word();
    if (word === "true") return { k: "bool", b: true };
    if (word === "false") return { k: "bool", b: false };
    if (word === "null") return { k: "null" };
    return { k: "op", o: word };
  }

  /** An object as a value, following references only where the grammar says so (`12 0 R`). */
  value(): PdfValue | undefined {
    const t = this.next();
    switch (t.k) {
      case "num": {
        const save = this.at;
        const second = this.next();
        if (second.k === "num" && Number.isInteger(t.n) && Number.isInteger(second.n)) {
          const third = this.next();
          if (third.k === "op" && third.o === "R") return { num: t.n, gen: second.n };
        }
        this.at = save;
        return t.n;
      }
      case "str":
        return t.bytes;
      case "name":
        return new PdfName(t.n);
      case "arr":
        return t.a;
      case "dict":
        return t.d;
      case "bool":
        return t.b;
      case "null":
        return null;
      default:
        return undefined;
    }
  }

  private word(): string {
    const start = this.at;
    while (this.at < this.src.length && isRegular(this.src.charCodeAt(this.at))) this.at++;
    return this.src.slice(start, this.at);
  }

  private number(): number | undefined {
    const start = this.at;
    if (this.src[this.at] === "+" || this.src[this.at] === "-") this.at++;
    let digits = 0;
    while (this.at < this.src.length && isDigit(this.src.charCodeAt(this.at))) {
      this.at++;
      digits++;
    }
    if (this.src[this.at] === ".") {
      this.at++;
      while (this.at < this.src.length && isDigit(this.src.charCodeAt(this.at))) {
        this.at++;
        digits++;
      }
    }
    if (!digits) {
      this.at = start;
      return undefined;
    }
    const n = Number(this.src.slice(start, this.at));
    return Number.isFinite(n) ? n : undefined;
  }

  private name(): string {
    this.at++; // the slash
    let out = "";
    while (this.at < this.src.length && isRegular(this.src.charCodeAt(this.at))) {
      const c = this.src.charCodeAt(this.at);
      if (c === 0x23 && this.at + 2 < this.src.length) {
        const hex = this.src.slice(this.at + 1, this.at + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.at += 3;
          continue;
        }
      }
      out += this.src[this.at];
      this.at++;
    }
    return out;
  }

  private literalString(): Buffer {
    this.at++; // the opening paren
    const out: number[] = [];
    let depth = 1;
    while (this.at < this.src.length) {
      const c = this.src.charCodeAt(this.at);
      if (c === 0x5c) {
        this.at++;
        const e = this.src.charCodeAt(this.at);
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0a) {
          // A backslash before a newline is a continuation and adds nothing.
          this.at++;
          continue;
        }
        else if (e === 0x0d) {
          this.at++;
          if (this.src.charCodeAt(this.at) === 0x0a) this.at++;
          continue;
        } else if (e >= 0x30 && e <= 0x37) {
          let oct = "";
          while (oct.length < 3 && this.src.charCodeAt(this.at) >= 0x30 && this.src.charCodeAt(this.at) <= 0x37) oct += this.src[this.at++];
          out.push(Number.parseInt(oct, 8) & 0xff);
          continue;
        } else out.push(e & 0xff);
        this.at++;
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29) {
        depth--;
        if (!depth) {
          this.at++;
          break;
        }
      }
      out.push(c & 0xff);
      this.at++;
    }
    return Buffer.from(out);
  }

  private hexString(): Buffer {
    this.at++; // the opening angle
    let hex = "";
    while (this.at < this.src.length && this.src.charCodeAt(this.at) !== 0x3e) {
      const ch = this.src[this.at];
      if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
      this.at++;
    }
    this.at++; // the closing angle
    if (hex.length % 2) hex += "0";
    return Buffer.from(hex, "hex");
  }

  private array(): PdfValue[] {
    this.at++; // the opening bracket
    const out: PdfValue[] = [];
    for (let guard = 0; guard < 200_000; guard++) {
      this.skip();
      if (this.at >= this.src.length || this.src.charCodeAt(this.at) === 0x5d) {
        this.at++;
        break;
      }
      const v = this.value();
      if (v === undefined) {
        // A bare keyword inside an array (a name in the wrong place): skip it rather than spin.
        const before = this.at;
        this.word();
        if (this.at === before) this.at++;
        continue;
      }
      out.push(v);
    }
    return out;
  }

  private dict(): PdfDict {
    this.at += 2; // the opening angle brackets
    const out: PdfDict = new Map();
    for (let guard = 0; guard < 100_000; guard++) {
      this.skip();
      if (this.at >= this.src.length) break;
      if (this.src.charCodeAt(this.at) === 0x3e && this.src.charCodeAt(this.at + 1) === 0x3e) {
        this.at += 2;
        break;
      }
      const t = this.next();
      if (t.k === "end") break;
      if (t.k !== "name") continue;
      const v = this.value();
      if (v !== undefined) out.set(t.n, v);
    }
    return out;
  }

  /** Skip an inline image (`BI ... ID <bytes> EI`) without reading its data as text. */
  skipInlineImage(): void {
    const end = this.src.indexOf("EI", this.at);
    this.at = end < 0 ? this.src.length : end + 2;
  }
}

/* ------------------------------- the document ------------------------------ */

/** A matrix [a b c d e f], the PDF's own arrangement. */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function isRef(v: unknown): v is PdfRef {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof PdfName) &&
    !Buffer.isBuffer(v) &&
    !Array.isArray(v) &&
    !(v instanceof Map) &&
    typeof (v as PdfRef).num === "number" &&
    typeof (v as PdfRef).gen === "number"
  );
}

class PdfDoc {
  readonly objects = new Map<number, StoredObject>();
  trailer?: PdfDict;
  encrypted = false;
  /** Raised when a step budget stopped the read. */
  truncated = false;
  steps = 0;

  constructor(readonly maxSteps: number) {}

  /** Add every object the file holds directly, skipping over stream bytes so none is read as one. */
  scan(src: string): void {
    const finder = /(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = finder.exec(src))) {
      const num = Number(m[1]);
      const gen = Number(m[2]);
      const r = new Reader(src, m.index + m[0].length);
      const value = (() => {
        const v = r.value();
        return v;
      })();
      if (value === undefined) continue;
      const obj: StoredObject = { value };
      r.skip();
      if (src.startsWith("stream", r.at)) {
        const read = this.readStream(src, r.at + 6, value);
        if (read) {
          obj.stream = read.data;
          finder.lastIndex = read.end;
        } else {
          finder.lastIndex = r.at + 6;
        }
      } else {
        finder.lastIndex = r.at;
      }
      if (!this.objects.has(num)) this.objects.set(num, obj);
      void gen;
      if (this.objects.size > 500_000) break;
    }
    this.trailer = this.findTrailer(src);
  }

  /**
   * The bytes of a stream: the declared length when it is a plain number and the file really holds
   * that much, otherwise everything up to `endstream`. The end offset lets the object scan carry on
   * after the data rather than reading it as more objects.
   */
  private readStream(src: string, afterKeyword: number, value: PdfValue): { data: Buffer; end: number } | undefined {
    let at = afterKeyword;
    if (src[at] === "\r") at++;
    if (src[at] === "\n") at++;
    const dict = value instanceof Map ? value : undefined;
    const declared = dict ? dict.get("Length") : undefined;
    const length = typeof declared === "number" ? declared : undefined;
    if (length !== undefined && length >= 0 && at + length <= src.length) {
      let after = at + length;
      while (after < src.length && isWhite(src.charCodeAt(after))) after++;
      if (src.startsWith("endstream", after)) {
        return { data: Buffer.from(src.slice(at, at + length), "latin1"), end: after + "endstream".length };
      }
    }
    const end = src.indexOf("endstream", at);
    if (end < 0) return undefined;
    let stop = end;
    if (stop > at && src[stop - 1] === "\n") stop--;
    if (stop > at && src[stop - 1] === "\r") stop--;
    return { data: Buffer.from(src.slice(at, stop), "latin1"), end: end + "endstream".length };
  }

  /** The trailer dictionary, from the last `trailer` that parses as one, or the xref stream's own dict. */
  private findTrailer(src: string): PdfDict | undefined {
    let best: PdfDict | undefined;
    const re = /\btrailer\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const r = new Reader(src, m.index + m[0].length);
      const v = r.value();
      if (v instanceof Map) best = v as PdfDict;
    }
    if (best?.has("Root")) return best;
    // No classic trailer (a PDF 1.5 file whose cross-reference is a stream): the xref stream's dict
    // carries /Root and /Encrypt, so take the last object that looks like one.
    for (const obj of this.objects.values()) {
      const d = obj.value instanceof Map ? (obj.value as PdfDict) : undefined;
      if (!d || !d.has("Root")) continue;
      if (this.nameOf(d.get("Type")) === "XRef" || !best) best = best ?? d;
    }
    return best;
  }

  /** Follow indirect references to the value itself. */
  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let cur = v;
    for (let hops = 0; hops < 16 && isRef(cur); hops++) cur = this.objects.get(cur.num)?.value;
    return cur;
  }

  dictOf(v: PdfValue | undefined): PdfDict | undefined {
    const r = this.resolve(v);
    return r instanceof Map ? (r as PdfDict) : undefined;
  }

  arrayOf(v: PdfValue | undefined): PdfValue[] | undefined {
    const r = this.resolve(v);
    return Array.isArray(r) ? r : undefined;
  }

  numOf(v: PdfValue | undefined): number | undefined {
    const r = this.resolve(v);
    return typeof r === "number" ? r : undefined;
  }

  nameOf(v: PdfValue | undefined): string | undefined {
    const r = this.resolve(v);
    return r instanceof PdfName ? r.name : undefined;
  }

  stringOf(v: PdfValue | undefined): Buffer | undefined {
    const r = this.resolve(v);
    return Buffer.isBuffer(r) ? r : undefined;
  }

  /** The bytes of a stream object, filters applied, or undefined when it cannot be decoded. */
  stream(obj: StoredObject | undefined): Buffer | undefined {
    if (!obj?.stream) return undefined;
    const dict = obj.value instanceof Map ? (obj.value as PdfDict) : undefined;
    return decodeStream(this, dict, obj.stream);
  }

  object(num: number): StoredObject | undefined {
    return this.objects.get(num);
  }

  /** Objects packed inside object streams (`/Type /ObjStm`), which a PDF 1.5 file uses for nearly all of them. */
  loadObjectStreams(): void {
    for (const [num, obj] of [...this.objects]) {
      if (this.steps++ > this.maxSteps) return;
      const d = obj.value instanceof Map ? (obj.value as PdfDict) : undefined;
      if (!d || this.nameOf(d.get("Type")) !== "ObjStm") continue;
      const data = this.stream(obj);
      if (!data) continue;
      const count = this.numOf(d.get("N")) ?? 0;
      const first = this.numOf(d.get("First")) ?? 0;
      if (count <= 0 || first < 0 || first > data.length) continue;
      const header = data.subarray(0, first).toString("latin1");
      const nums = header.match(/-?\d+/g) ?? [];
      for (let i = 0; i + 1 < nums.length && i < count * 2; i += 2) {
        const onum = Number(nums[i]);
        const offset = Number(nums[i + 1]);
        if (!Number.isFinite(onum) || !Number.isFinite(offset) || first + offset > data.length) continue;
        const r = new Reader(data.toString("latin1"), first + offset);
        const v = r.value();
        if (v !== undefined && !this.objects.has(onum)) this.objects.set(onum, { value: v });
      }
      void num;
    }
  }
}

/** Apply a stream's filters. Anything that is an image or a codec we do not implement gives undefined. */
function decodeStream(doc: PdfDoc, dict: PdfDict | undefined, raw: Buffer): Buffer | undefined {
  if (!dict) return undefined;
  const filters = doc.arrayOf(dict.get("Filter")) ?? (doc.resolve(dict.get("Filter")) !== undefined ? [dict.get("Filter") as PdfValue] : []);
  const parmsRaw = doc.resolve(dict.get("DecodeParms") ?? dict.get("DP"));
  const parms = Array.isArray(parmsRaw) ? parmsRaw : [dict.get("DecodeParms")];
  let data = raw;
  const names = filters.map((f) => doc.nameOf(f)).filter((n): n is string => Boolean(n));
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const parm = doc.dictOf(parms[i] ?? parms[0]);
    if (name === "FlateDecode" || name === "Fl") {
      const out = inflate(data);
      if (!out) return undefined;
      data = out;
      if (parm) data = applyPredictor(doc, parm, data) ?? data;
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      data = asciiHex(data);
    } else if (name === "ASCII85Decode" || name === "A85") {
      const out = ascii85(data);
      if (!out) return undefined;
      data = out;
    } else {
      return undefined; // DCTDecode, JPXDecode, CCITTFaxDecode, LZWDecode, JBIG2Decode, RunLengthDecode
    }
  }
  return data.length > MAX_STREAM_BYTES ? data.subarray(0, MAX_STREAM_BYTES) : data;
}

function inflate(data: Buffer): Buffer | undefined {
  try {
    return inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
  } catch {
    // Some writers omit the zlib header; a raw stream is worth one more try.
  }
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES });
  } catch {
    return undefined;
  }
}

/** The PNG predictor some streams (nearly always cross-reference streams) use. */
function applyPredictor(doc: PdfDoc, parm: PdfDict, data: Buffer): Buffer | undefined {
  const predictor = doc.numOf(parm.get("Predictor")) ?? 1;
  if (predictor <= 1) return data;
  const colors = doc.numOf(parm.get("Colors")) ?? 1;
  const bits = doc.numOf(parm.get("BitsPerComponent")) ?? 8;
  const columns = doc.numOf(parm.get("Columns")) ?? 1;
  const rowBytes = Math.ceil((colors * bits * columns) / 8);
  if (predictor === 2) return data; // TIFF: rows are already contiguous
  if (rowBytes <= 0 || data.length < rowBytes) return data;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(rowBytes);
  let at = 0;
  while (at + 1 + rowBytes <= data.length) {
    const type = data[at];
    const row = Buffer.from(data.subarray(at + 1, at + 1 + rowBytes));
    at += 1 + rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const left = i > 0 ? row[i - 1] : 0;
      const up = prev[i];
      const upLeft = i > 0 ? prev[i - 1] : 0;
      if (type === 1) row[i] = (row[i] + left) & 0xff;
      else if (type === 2) row[i] = (row[i] + up) & 0xff;
      else if (type === 3) row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      }
    }
    rows.push(row);
    prev = row;
  }
  return Buffer.concat(rows);
}

function asciiHex(data: Buffer): Buffer {
  const text = data.toString("latin1").split(">")[0] ?? "";
  let hex = "";
  for (const ch of text) if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
  if (hex.length % 2) hex += "0";
  return Buffer.from(hex, "hex");
}

function ascii85(data: Buffer): Buffer | undefined {
  let text = data.toString("latin1");
  const start = text.indexOf("<~");
  if (start >= 0) text = text.slice(start + 2);
  const end = text.indexOf("~>");
  if (end >= 0) text = text.slice(0, end);
  const out: number[] = [];
  let group: number[] = [];
  const flush = (): void => {
    if (!group.length) return;
    const n = group.length;
    for (let i = n; i < 5; i++) group.push(84);
    let value = 0;
    for (const g of group) value = value * 85 + (g - 33);
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, n - 1));
    group = [];
  };
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (isWhite(c)) continue;
    if (ch === "z" && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) return undefined;
    group.push(c);
    if (group.length === 5) flush();
  }
  flush();
  return Buffer.from(out);
}

/* --------------------------------- fonts ---------------------------------- */

interface Font {
  /** The codes in one string, one or two bytes each as this font writes them. */
  codes(bytes: Buffer): number[];
  /** The character a code stands for, or "" when this font cannot say. */
  glyph(code: number): string;
  /** Advance width in thousandths of an em, and whether it came from the file rather than a guess. */
  width(code: number): { w: number; real: boolean };
}

/** WinAnsiEncoding is code page 1252: the high range differs from Latin-1 in these places. */
const CP1252_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
  0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
  0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function winAnsiTable(): string[] {
  const table: string[] = [];
  for (let code = 0; code < 256; code++) {
    if (code >= 0x80 && code <= 0x9f) table.push(CP1252_HIGH[code] ?? "");
    else table.push(String.fromCharCode(code));
  }
  return table;
}

/** StandardEncoding agrees with WinAnsi except at these codes. */
const STANDARD_OVERRIDES: Record<number, string> = {
  0x27: "’", 0x60: "‘", 0xa4: "⁄", 0xa6: "ƒ", 0xa8: "¤", 0xb4: "·", 0xb8: "¸",
  0xbc: "œ", 0xbd: "Œ", 0xc0: "†", 0xc1: "‡", 0xc2: "·", 0xc5: "¸", 0xc8: "­",
  0xc9: "ˆ", 0xca: "˜", 0xcb: "ˇ", 0xcd: "″", 0xce: "′", 0xcf: "‾", 0xd0: "˘",
  0xd1: "˝", 0xd4: "⁄", 0xec: "¸", 0xed: "ˇ", 0xee: "ˆ", 0xef: "˜", 0xf0: "˘",
  0xf1: "˝", 0xf4: "⁄",
};

/** The glyph names a `/Differences` array uses, for the ones that carry text. */
const GLYPH_NAMES: Record<string, string> = (() => {
  const out: Record<string, string> = { space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘" };
  const ascii = "()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  const names = ["parenleft", "parenright", "asterisk", "plus", "comma", "hyphen", "period", "slash", "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "colon", "semicolon", "less", "equal", "greater", "question", "at", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "bracketleft", "backslash", "bracketright", "asciicircum", "underscore", "grave", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "braceleft", "bar", "braceright", "asciitilde"];
  names.forEach((n, i) => {
    out[n] = ascii[i] ?? out[n] ?? "";
  });
  const latin: Array<[string, number]> = [
    ["exclamdown", 0xa1], ["cent", 0xa2], ["sterling", 0xa3], ["currency", 0xa4], ["yen", 0xa5], ["brokenbar", 0xa6],
    ["section", 0xa7], ["dieresis", 0xa8], ["copyright", 0xa9], ["ordfeminine", 0xaa], ["guillemotleft", 0xab],
    ["logicalnot", 0xac], ["registered", 0xae], ["macron", 0xaf], ["degree", 0xb0], ["plusminus", 0xb1],
    ["twosuperior", 0xb2], ["threesuperior", 0xb3], ["acute", 0xb4], ["mu", 0xb5], ["paragraph", 0xb6],
    ["periodcentered", 0xb7], ["cedilla", 0xb8], ["onesuperior", 0xb9], ["ordmasculine", 0xba],
    ["guillemotright", 0xbb], ["onequarter", 0xbc], ["onehalf", 0xbd], ["threequarters", 0xbe],
    ["questiondown", 0xbf], ["Agrave", 0xc0], ["Aacute", 0xc1], ["Acircumflex", 0xc2], ["Atilde", 0xc3],
    ["Adieresis", 0xc4], ["Aring", 0xc5], ["AE", 0xc6], ["Ccedilla", 0xc7], ["Egrave", 0xc8], ["Eacute", 0xc9],
    ["Ecircumflex", 0xca], ["Edieresis", 0xcb], ["Igrave", 0xcc], ["Iacute", 0xcd], ["Icircumflex", 0xce],
    ["Idieresis", 0xcf], ["Eth", 0xd0], ["Ntilde", 0xd1], ["Ograve", 0xd2], ["Oacute", 0xd3], ["Ocircumflex", 0xd4],
    ["Otilde", 0xd5], ["Odieresis", 0xd6], ["multiply", 0xd7], ["Oslash", 0xd8], ["Ugrave", 0xd9], ["Uacute", 0xda],
    ["Ucircumflex", 0xdb], ["Udieresis", 0xdc], ["Yacute", 0xdd], ["Thorn", 0xde], ["germandbls", 0xdf],
    ["agrave", 0xe0], ["aacute", 0xe1], ["acircumflex", 0xe2], ["atilde", 0xe3], ["adieresis", 0xe4], ["aring", 0xe5],
    ["ae", 0xe6], ["ccedilla", 0xe7], ["egrave", 0xe8], ["eacute", 0xe9], ["ecircumflex", 0xea], ["edieresis", 0xeb],
    ["igrave", 0xec], ["iacute", 0xed], ["icircumflex", 0xee], ["idieresis", 0xef], ["eth", 0xf0], ["ntilde", 0xf1],
    ["ograve", 0xf2], ["oacute", 0xf3], ["ocircumflex", 0xf4], ["otilde", 0xf5], ["odieresis", 0xf6], ["divide", 0xf7],
    ["oslash", 0xf8], ["ugrave", 0xf9], ["uacute", 0xfa], ["ucircumflex", 0xfb], ["udieresis", 0xfc], ["yacute", 0xfd],
    ["thorn", 0xfe], ["ydieresis", 0xff],
  ];
  for (const [name, code] of latin) out[name] = String.fromCharCode(code);
  const extra: Record<string, string> = {
    Euro: "€", euro: "€", florin: "ƒ", dagger: "†", daggerdbl: "‡", ellipsis: "…",
    perthousand: "‰", fraction: "⁄", minus: "−", endash: "–", emdash: "—",
    quotedblleft: "“", quotedblright: "”", quotedblbase: "„", guilsinglleft: "‹",
    guilsinglright: "›", bullet: "•", trademark: "™", oe: "œ", OE: "Œ",
    Scaron: "Š", scaron: "š", Zcaron: "Ž", zcaron: "ž", Ydieresis: "Ÿ",
    nbspace: " ", quotesinglbase: "‚", sfthyphen: "­", dotlessi: "ı", Lslash: "Ł",
    lslash: "ł", hungarumlaut: "˝", circumflex: "ˆ", tilde: "˜", caron: "ˇ",
    breve: "˘", dotaccent: "˙", ring: "˚", ogonek: "˛", gravecomb: "̀", acutecomb: "́",
  };
  return { ...out, ...extra };
})();

/** Unicode for one glyph name, including the `uniXXXX` form subsetted fonts use. */
function glyphName(name: string): string | undefined {
  if (GLYPH_NAMES[name] !== undefined) return GLYPH_NAMES[name];
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) {
    const n = Number.parseInt(uni[1], 16);
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
  }
  return undefined;
}

/** `0041` or `00410042` as UTF-16BE text, which is how a ToUnicode CMap writes its destination. */
function hexToText(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  if (!clean.length) return "";
  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, "hex");
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = bytes.readUInt16BE(i);
    if (unit === 0 && i + 2 >= bytes.length) continue; // a trailing pad
    out += String.fromCharCode(unit);
  }
  if (bytes.length === 1) out += String.fromCharCode(bytes[0]);
  return out;
}

interface CMap {
  map: Map<number, string>;
  /** 1 or 2: how many bytes one code takes. */
  codeBytes: number;
}

/** A `ToUnicode` CMap: the `bfchar` and `bfrange` sections, which is all a generated PDF writes. */
export function parseToUnicode(text: string): CMap {
  const map = new Map<number, string>();
  let codeBytes = 2;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space) {
    const first = /<([0-9A-Fa-f]+)>/.exec(space[1] ?? "");
    if (first) codeBytes = Math.max(1, Math.round(first[1].length / 2));
  }
  const chars = /beginbfchar([\s\S]*?)endbfchar/g;
  for (let m = chars.exec(text); m; m = chars.exec(text)) {
    for (const line of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(Number.parseInt(line[1], 16), hexToText(line[2]));
    }
  }
  const ranges = /beginbfrange([\s\S]*?)endbfrange/g;
  for (let m = ranges.exec(text); m; m = ranges.exec(text)) {
    const body = m[1];
    for (const tri of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = Number.parseInt(tri[1], 16);
      const hi = Number.parseInt(tri[2], 16);
      const start = Buffer.from(tri[3].length % 2 ? `${tri[3]}0` : tri[3], "hex");
      if (hi < lo || hi - lo > 65535) continue;
      for (let code = lo; code <= hi; code++) {
        const inc = code - lo;
        const bytes = Buffer.from(start);
        let carry = inc;
        for (let i = bytes.length - 1; i >= 0 && carry > 0; i--) {
          const sum = bytes[i] + (carry & 0xff);
          bytes[i] = sum & 0xff;
          carry = (carry >> 8) + (sum > 0xff ? 1 : 0);
        }
        map.set(code, hexToText(bytes.toString("hex")));
      }
    }
    for (const list of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = Number.parseInt(list[1], 16);
      let code = lo;
      for (const item of list[3].matchAll(/<([0-9A-Fa-f]+)>/g)) {
        map.set(code++, hexToText(item[1]));
      }
    }
  }
  return { map, codeBytes };
}

/** One font of a page's resources, ready to turn codes into characters and widths. */
function buildFont(doc: PdfDoc, dict: PdfDict): Font {
  const subtype = doc.nameOf(dict.get("Subtype")) ?? "";
  const toUnicodeStream = doc.stream(doc.object((dict.get("ToUnicode") as PdfRef | undefined)?.num ?? -1));
  const cmap = toUnicodeStream ? parseToUnicode(toUnicodeStream.toString("latin1")) : undefined;
  const composite = subtype === "Type0";
  const descendant = composite ? doc.dictOf((doc.arrayOf(dict.get("DescendantFonts")) ?? [])[0]) : undefined;
  const metrics = descendant ?? dict;
  const codeBytes = composite ? (cmap?.codeBytes ?? 2) : 1;

  // Widths: /Widths over /FirstChar for a simple font, /W and /DW for a composite one.
  const widths = new Map<number, number>();
  let defaultWidth: number | undefined;
  const first = doc.numOf(metrics.get("FirstChar"));
  const array = doc.arrayOf(metrics.get("Widths"));
  if (array && first !== undefined) {
    array.forEach((w, i) => {
      const n = doc.numOf(w);
      if (typeof n === "number") widths.set(first + i, n);
    });
  }
  const w = doc.arrayOf(metrics.get("W"));
  if (w) {
    for (let i = 0; i < w.length; i++) {
      const start = doc.numOf(w[i]);
      const next = w[i + 1];
      if (start === undefined) continue;
      if (Array.isArray(next)) {
        next.forEach((value, k) => {
          const n = doc.numOf(value as PdfValue);
          if (typeof n === "number") widths.set(start + k, n);
        });
        i++;
      } else {
        const end = doc.numOf(next as PdfValue);
        const value = doc.numOf(w[i + 2]);
        if (end !== undefined && value !== undefined) {
          for (let code = start; code <= end && code - start < 65536; code++) widths.set(code, value);
          i += 2;
        }
      }
    }
  }
  const dw = doc.numOf(metrics.get("DW"));
  if (typeof dw === "number") defaultWidth = dw;

  // Encoding: a ToUnicode map where there is one, otherwise the font's own encoding table.
  const table: string[] = winAnsiTable();
  let simple = false;
  if (!composite) {
    simple = true;
    const encoding = dict.get("Encoding");
    const resolvedEncoding = doc.resolve(subtype === "Type3" ? undefined : encoding);
    const encName = doc.nameOf(encoding) ?? doc.nameOf(doc.dictOf(encoding)?.get("BaseEncoding")) ?? "WinAnsiEncoding";
    if (encName === "StandardEncoding") for (const [code, ch] of Object.entries(STANDARD_OVERRIDES)) table[Number(code)] = ch;
    if (encName === "MacRomanEncoding" || encName === "MacExpertEncoding" || encName === "PDFDocEncoding") {
      // Not decoded properly anywhere in this service: Latin-1 is the closest honest approximation.
      for (let code = 0; code < 256; code++) table[code] = code < 0x80 || code > 0x9f ? String.fromCharCode(code) : "";
    }
    const differences = resolvedEncoding instanceof Map ? doc.arrayOf((resolvedEncoding as PdfDict).get("Differences")) : undefined;
    if (differences) {
      let code = 0;
      for (const entry of differences) {
        if (typeof entry === "number") {
          code = entry;
          continue;
        }
        const name = entry instanceof PdfName ? entry.name : undefined;
        if (name !== undefined) table[code] = glyphName(name) ?? "";
        code++;
      }
    }
  }

  return {
    codes(bytes: Buffer): number[] {
      const out: number[] = [];
      if (codeBytes === 1) {
        for (const byte of bytes) out.push(byte);
      } else {
        for (let i = 0; i + 1 < bytes.length; i += 2) out.push(bytes.readUInt16BE(i));
      }
      return out;
    },
    glyph(code: number): string {
      const mapped = cmap?.map.get(code);
      if (mapped !== undefined) return mapped;
      if (cmap && cmap.map.size) return ""; // the font has a ToUnicode map and does not know this code
      if (simple && code >= 0 && code < 256) return table[code] ?? "";
      return "";
    },
    width(code: number): { w: number; real: boolean } {
      const w = widths.get(code);
      if (w !== undefined) return { w, real: true };
      if (defaultWidth !== undefined) return { w: defaultWidth, real: true };
      return { w: 500, real: false };
    },
  };
}

/* ------------------------------ content streams ---------------------------- */

/** Where the last shown text sat, so lines and spaces can be read off the geometry. */
class PageText {
  private lines: string[] = [];
  private line = "";
  private lastY?: number;
  private lastEndX?: number;
  private lastSize = 0;

  /** One string's worth of text, at its place on the page. */
  add(text: string, x: number, y: number, size: number, width: number): void {
    if (!text) return;
    const big = Math.max(size, this.lastSize, 1);
    if (this.lastY === undefined) {
      this.line = "";
    } else if (Math.abs(y - this.lastY) > 0.35 * big) {
      this.push();
    } else if (this.lastEndX !== undefined && x - this.lastEndX > 0.16 * big && this.line && !this.line.endsWith(" ")) {
      this.line += " ";
    }
    this.line += text;
    this.lastY = y;
    this.lastEndX = x + width;
    this.lastSize = size;
  }

  private push(): void {
    this.lines.push(this.line.replace(/[ \t]+$/g, ""));
    this.line = "";
  }

  text(): string {
    if (this.line) this.push();
    const kept: string[] = [];
    for (const line of this.lines) {
      if (!line.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue; // one blank line at most
      kept.push(line);
    }
    return kept.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  }
}

interface PageResult {
  text: string;
  images: number;
  undecoded: number;
}

class ContentReader {
  private readonly stack: PdfValue[] = [];
  private tm: Matrix = IDENTITY;
  private tlm: Matrix = IDENTITY;
  private ctm: Matrix = IDENTITY;
  private font?: Font;
  private fontSize = 0;
  private leading = 0;
  private charSpacing = 0;
  private wordSpacing = 0;
  private horizontalScale = 100;
  private stateStack: Array<{ ctm: Matrix; tm: Matrix; tlm: Matrix; font?: Font; fontSize: number }> = [];
  images = 0;
  undecoded = 0;

  constructor(
    private readonly doc: PdfDoc,
    private readonly out: PageText,
    private fonts: Map<string, Font>,
    private readonly budget: () => boolean,
    private readonly depth = 0,
  ) {}

  /** Interpret one content stream, with the resources in force for it. */
  run(content: string): void {
    const r = new Reader(content);
    for (;;) {
      if (!this.budget()) return;
      r.skip();
      if (r.at >= content.length) return;
      const token = r.next();
      if (token.k === "end") return;
      switch (token.k) {
        case "op":
          if (token.o === "BI") {
            r.skipInlineImage();
            this.images++;
          } else this.operator(token.o);
          break;
        case "num":
          this.stack.push(token.n);
          break;
        case "str":
          this.stack.push(token.bytes);
          break;
        case "name":
          this.stack.push(new PdfName(token.n));
          break;
        case "arr":
        case "dict":
        case "bool":
        case "null":
          this.stack.push(token.k === "arr" ? token.a : token.k === "dict" ? token.d : token.k === "null" ? null : token.b);
          break;
      }
      if (this.stack.length > 64) this.stack.splice(0, this.stack.length - 64);
    }
  }

  private pop(): PdfValue | undefined {
    return this.stack.pop();
  }

  private num(): number {
    const v = this.doc.resolve(this.pop());
    return typeof v === "number" ? v : 0;
  }

  private name(): string | undefined {
    const v = this.doc.resolve(this.pop());
    return v instanceof PdfName ? v.name : undefined;
  }

  private operator(op: string): void {
    switch (op) {
      case "q":
        this.stateStack.push({ ctm: this.ctm, tm: this.tm, tlm: this.tlm, font: this.font, fontSize: this.fontSize });
        if (this.stateStack.length > 64) this.stateStack.splice(0, this.stateStack.length - 64);
        this.stack.length = 0;
        return;
      case "Q": {
        const s = this.stateStack.pop();
        if (s) {
          this.ctm = s.ctm;
          this.tm = s.tm;
          this.tlm = s.tlm;
          this.font = s.font;
          this.fontSize = s.fontSize;
        }
        this.stack.length = 0;
        return;
      }
      case "cm": {
        const f = this.num();
        const e = this.num();
        const d = this.num();
        const c = this.num();
        const b = this.num();
        const a = this.num();
        this.ctm = multiply([a, b, c, d, e, f], this.ctm);
        this.stack.length = 0;
        return;
      }
      case "BT":
        this.tm = IDENTITY;
        this.tlm = IDENTITY;
        this.stack.length = 0;
        return;
      case "ET":
        this.stack.length = 0;
        return;
      case "Tf": {
        const size = this.num();
        const name = this.name();
        this.font = name !== undefined ? this.fonts.get(name) : undefined;
        this.fontSize = size;
        this.stack.length = 0;
        return;
      }
      case "Td":
      case "TD": {
        const ty = this.num();
        const tx = this.num();
        if (op === "TD") this.leading = -ty;
        this.tlm = multiply([1, 0, 0, 1, tx, ty], this.tlm);
        this.tm = [...this.tlm] as Matrix;
        this.stack.length = 0;
        return;
      }
      case "Tm": {
        const f = this.num();
        const e = this.num();
        const d = this.num();
        const c = this.num();
        const b = this.num();
        const a = this.num();
        this.tlm = [a, b, c, d, e, f];
        this.tm = [a, b, c, d, e, f];
        this.stack.length = 0;
        return;
      }
      case "T*":
        this.tlm = multiply([1, 0, 0, 1, 0, -this.leading], this.tlm);
        this.tm = [...this.tlm] as Matrix;
        this.stack.length = 0;
        return;
      case "TL":
        this.leading = this.num();
        this.stack.length = 0;
        return;
      case "Tc":
        this.charSpacing = this.num();
        this.stack.length = 0;
        return;
      case "Tw":
        this.wordSpacing = this.num();
        this.stack.length = 0;
        return;
      case "Tz":
        this.horizontalScale = this.num();
        this.stack.length = 0;
        return;
      case "Ts":
      case "Tr":
        this.num();
        this.stack.length = 0;
        return;
      case "Tj": {
        const raw = this.doc.resolve(this.pop());
        if (Buffer.isBuffer(raw)) this.show(raw);
        this.stack.length = 0;
        return;
      }
      case "'":
      case '"': {
        const bytes = this.pop();
        if (op === '"') {
          // The operands are pushed word spacing, then character spacing, then the string.
          const wordSpace = this.num();
          const charSpace = this.num();
          this.wordSpacing = wordSpace;
          this.charSpacing = charSpace;
        }
        this.tlm = multiply([1, 0, 0, 1, 0, -this.leading], this.tlm);
        this.tm = [...this.tlm] as Matrix;
        const raw = this.doc.resolve(bytes);
        if (Buffer.isBuffer(raw)) this.show(raw);
        this.stack.length = 0;
        return;
      }
      case "TJ": {
        const arr = this.doc.resolve(this.pop());
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const resolved = this.doc.resolve(item);
            if (Buffer.isBuffer(resolved)) this.show(resolved);
            else if (typeof resolved === "number") {
              // A negative adjustment widens the gap between glyphs, which is a word space in every
              // practical PDF that writes its text as a TJ array.
              const gap = (-resolved / 1000) * this.fontSize * (this.horizontalScale / 100);
              if (gap > 0.2 * Math.max(this.fontSize, 1)) {
                const p = this.here();
                this.out.add(" ", p.x, p.y, p.size, 0);
              }
              if (gap) this.tm = multiply([1, 0, 0, 1, gap, 0], this.tm);
            }
          }
        }
        this.stack.length = 0;
        return;
      }
      case "Do": {
        const name = this.name();
        this.stack.length = 0;
        const ref = name !== undefined ? this.resource("XObject", name) : undefined;
        const xobject = this.doc.dictOf(ref);
        if (!xobject) return;
        const kind = this.doc.nameOf(xobject.get("Subtype"));
        if (kind !== "Form") {
          this.images++;
          return;
        }
        if (this.depth >= MAX_FORM_DEPTH) return;
        const data = this.doc.stream(this.doc.object(isRef(ref) ? ref.num : -1));
        if (!data) return;
        const fonts = this.fontsFor(this.doc.dictOf(xobject.get("Resources")));
        const matrix = this.doc.arrayOf(xobject.get("Matrix"));
        const m: Matrix = matrix && matrix.length >= 6 ? [this.doc.numOf(matrix[0]) ?? 1, this.doc.numOf(matrix[1]) ?? 0, this.doc.numOf(matrix[2]) ?? 0, this.doc.numOf(matrix[3]) ?? 1, this.doc.numOf(matrix[4]) ?? 0, this.doc.numOf(matrix[5]) ?? 0] : IDENTITY;
        const inner = new ContentReader(this.doc, this.out, fonts, this.budget, this.depth + 1);
        inner.ctm = multiply(m, this.ctm);
        inner.tm = this.tm;
        inner.tlm = this.tlm;
        inner.fontSize = this.fontSize;
        inner.run(data.toString("latin1"));
        this.undecoded += inner.undecoded;
        return;
      }
      default:
        this.stack.length = 0;
    }
  }

  /** Where the pen sits right now, in points on the page: the text matrix against the current CTM. */
  private here(): { x: number; y: number; size: number } {
    const m = multiply(this.tm, this.ctm);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    return { x: m[4], y: m[5], size: this.fontSize * scale };
  }

  /** One shown string: its characters, where it sits, and where the pen goes next. */
  private show(bytes: Buffer): void {
    const font = this.font;
    if (!font) {
      this.undecoded += bytes.length;
      return;
    }
    const codes = font.codes(bytes);
    let text = "";
    let em = 0;
    let spaces = 0;
    for (const code of codes) {
      const ch = font.glyph(code);
      if (ch) text += ch;
      else this.undecoded += 1;
      const w = font.width(code);
      em += (w.real ? w.w : 500) / 1000; // half an em is the estimate when the file gives no width
      if (code === 32) spaces++;
    }
    const p = this.here();
    this.out.add(text, p.x, p.y, p.size, em * p.size * (this.horizontalScale / 100));
    // Advance the pen as the text operators say: glyph widths, character spacing, word spacing, scaling.
    const advance = (em * this.fontSize + this.charSpacing * codes.length + this.wordSpacing * spaces) * (this.horizontalScale / 100);
    if (advance) this.tm = multiply([1, 0, 0, 1, advance, 0], this.tm);
  }

  /** One entry of the resources in force (a font, or an XObject for a form). */
  private resource(kind: string, name: string): PdfValue | undefined {
    const dict = this.doc.dictOf(this.currentResources?.get(kind));
    return dict?.get(name);
  }

  currentResources?: PdfDict;

  /** The resources in force for the next stream, and the fonts they name. */
  useResources(resources: PdfDict | undefined): void {
    this.currentResources = resources;
    this.fonts = this.fontsFor(resources);
  }

  /** The fonts a resources dictionary names, built once per resources object. */
  fontsFor(resources: PdfDict | undefined): Map<string, Font> {
    const out = new Map<string, Font>();
    const fonts = this.doc.dictOf(resources?.get("Font"));
    if (!fonts) return out;
    for (const [name, value] of fonts) {
      const dict = this.doc.dictOf(value);
      if (dict) out.set(name, buildFont(this.doc, dict));
    }
    return out;
  }
}

/* --------------------------------- reading --------------------------------- */

/** The pages of the document, in order, with the resources each inherits. */
function collectPages(doc: PdfDoc, maxPages: number): Array<{ dict: PdfDict; resources?: PdfDict }> {
  const out: Array<{ dict: PdfDict; resources?: PdfDict }> = [];
  const root = doc.dictOf(doc.trailer?.get("Root"));
  const walk = (node: PdfValue | undefined, inherited: PdfDict | undefined, depth: number): void => {
    if (out.length >= maxPages || depth > 64) return;
    const dict = doc.dictOf(node);
    if (!dict) return;
    const resources = doc.dictOf(dict.get("Resources")) ?? inherited;
    if (doc.nameOf(dict.get("Type")) === "Page" || (!dict.has("Kids") && (dict.has("Contents") || dict.has("MediaBox")))) {
      out.push({ dict, ...(resources ? { resources } : {}) });
      return;
    }
    for (const kid of doc.arrayOf(dict.get("Kids")) ?? []) walk(kid, resources, depth + 1);
  };
  walk(root?.get("Pages"), doc.dictOf(root?.get("Resources")), 0);
  if (!out.length) {
    // No working page tree: every object that says it is a page, in the order the file lists them.
    const numbered = [...doc.objects.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, obj] of numbered) {
      if (out.length >= maxPages) break;
      const dict = doc.dictOf(obj.value);
      if (dict && doc.nameOf(dict.get("Type")) === "Page") out.push({ dict, ...(doc.dictOf(dict.get("Resources")) ? { resources: doc.dictOf(dict.get("Resources")) } : {}) });
    }
  }
  return out;
}

/** One page's text: its own content streams and every form XObject they draw, in call order. */
function pageText(doc: PdfDoc, page: { dict: PdfDict; resources?: PdfDict }, budget: () => boolean): PageResult {
  const out = new PageText();
  const contents = doc.arrayOf(page.dict.get("Contents")) ?? (page.dict.has("Contents") ? [page.dict.get("Contents") as PdfValue] : []);
  const reader = new ContentReader(doc, out, new Map(), budget);
  reader.useResources(page.resources);
  for (const item of contents) {
    const obj = isRef(item) ? doc.object(item.num) : undefined;
    const data = doc.stream(obj);
    if (data) reader.run(data.toString("latin1"));
  }
  return { text: out.text(), images: reader.images, undecoded: reader.undecoded };
}

/** The text of a PDF, page by page. Never throws: a file it cannot read comes back with a reason. */
export function pdfText(data: Buffer, limits: PdfLimits = {}): PdfText {
  const maxPages = limits.maxPages ?? DEFAULT_PAGES;
  const maxChars = limits.maxChars ?? DEFAULT_CHARS;
  const maxSteps = limits.maxSteps ?? DEFAULT_STEPS;
  const nothing = (reason: string): PdfText => ({ text: "", pages: 0, pagesWithText: 0, pagesWithoutText: [], chars: 0, words: 0, reason, truncated: false, undecoded: 0 });
  if (!isPdfData(data)) return nothing("the file is not a readable PDF");
  try {
    const doc = new PdfDoc(maxSteps);
    doc.scan(data.toString("latin1"));
    doc.loadObjectStreams();
    if (doc.trailer?.has("Encrypt") && doc.resolve(doc.trailer.get("Encrypt")) !== null) {
      return nothing("the PDF is encrypted, so its text cannot be read");
    }
    const pages = collectPages(doc, maxPages);
    if (!pages.length) return nothing("the PDF has no pages this reader could find");
    const budget = (): boolean => doc.steps++ < maxSteps;
    const parts: string[] = [];
    const pagesWithoutText: number[] = [];
    let chars = 0;
    let undecoded = 0;
    let truncated = false;
    for (let i = 0; i < pages.length; i++) {
      const result = pageText(doc, pages[i], budget);
      undecoded += result.undecoded;
      const text = result.text;
      if (!text.trim()) pagesWithoutText.push(i + 1);
      if (chars + text.length > maxChars) {
        parts.push(text.slice(0, Math.max(0, maxChars - chars)));
        chars = maxChars;
        truncated = true;
        break;
      }
      parts.push(text);
      chars += text.length;
    }
    if (doc.steps >= maxSteps) truncated = true;
    const text = parts.join("\f").replace(/\f+$/, "");
    if (!text.trim()) {
      return {
        text: "",
        pages: pages.length,
        pagesWithText: 0,
        pagesWithoutText,
        chars: 0,
        words: 0,
        reason:
          undecoded > 0
            ? "the PDF holds text, but its font carries no encoding this reader can read, so none of it came out"
            : "the PDF has no text layer: it looks like a scan or images of pages, with no text to read",
        truncated,
        undecoded,
      };
    }
    return {
      text,
      pages: pages.length,
      pagesWithText: pages.length - pagesWithoutText.length,
      pagesWithoutText,
      chars: text.length,
      words: countWords(text),
      truncated,
      undecoded,
    };
  } catch {
    return nothing("the PDF could not be read (it may be damaged)");
  }
}

/**
 * What to say about a PDF read, in plain words, or undefined when the read was complete: a file with
 * no text layer, a read a limit stopped, a page that gave nothing, or characters that could not be
 * decoded. A partial read is never called a success.
 */
export function pdfTextNote(result: PdfText): string | undefined {
  if (result.reason) return result.reason;
  const parts: string[] = [];
  if (result.pagesWithoutText.length) {
    const pages = result.pagesWithoutText.slice(0, 8).join(", ");
    parts.push(`${result.pagesWithoutText.length} of ${result.pages} pages had no text (page${result.pagesWithoutText.length === 1 ? "" : "s"} ${pages})`);
  }
  if (result.undecoded > 0) parts.push(`${result.undecoded} character${result.undecoded === 1 ? "" : "s"} could not be decoded (a font with no readable encoding)`);
  if (result.truncated) parts.push("the read stopped at a limit, so the text is partial");
  return parts.length ? parts.join("; ") : undefined;
}
