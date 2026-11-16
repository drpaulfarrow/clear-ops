/**
 * A real document from Paul or his assistant, turned into something a worker can read.
 *
 * The only other way in is a chat attachment (src/uploads.ts). This is the Instinct bridge's
 * `POST /api/instinct/documents` (src/instinct-bridge.ts): the sender posts the bytes base64 in a JSON
 * body, authenticated with the same bearer token as every other bridge route, and they are saved
 * through the same private uploads store, with the same limits, the same sanitised name, the same
 * owner-only permissions and the same rule that uploads live outside every git checkout. No new
 * service, host or account is involved, nothing is executed, and no model call is made.
 *
 * Every request is checked before anything is written, and a refusal says why in one short line the
 * chief can pass on: empty input, malformed base64, bytes over the size limit, a name that is not a
 * plain file name, bytes that contradict the type they claim (a ".docx" that is not a Word document,
 * a ".png" that is not an image), or a .docx with no readable body. A refused document saves nothing:
 * the checks run first, so a bad request leaves no half-saved file behind.
 *
 * A .docx is a zip whose text lives in `word/document.xml`, so its text is pulled out with the
 * repository's own zip reader (`readZipEntry` in src/uploads.ts) rather than a new dependency, and
 * saved as a `.txt` beside the .docx. That .txt is the path a worker reads; the receipt names it.
 *
 * Nothing here reads a document back: the bridge adds to the uploads store and never reads it out.
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { formatSize, readZipEntry, UploadError, Uploads, type SavedUpload } from "./uploads.js";

/** Mounted under the Instinct bridge's own path (src/instinct-bridge.ts). */
export const DOCUMENTS_ROUTE = "/documents";

const NAME_MAX = 200;
const NOTE_MAX = 500;
/** Room around the base64 for the name, the type and the note, in the request body. */
const JSON_SLACK_BYTES = 16 * 1024;
/** Most of `word/document.xml` an extracted .docx may inflate to. */
const DOCX_XML_MAX_BYTES = 8 * 1024 * 1024;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json", ".log", ".tsv", ".yaml", ".yml", ".xml", ".html", ".ics", ".vcf"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** A refusal whose message is short, safe and useful to hand to Paul. */
export class DocumentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** What the caller gets back: exactly what arrived, and where it can be read. */
export interface DocumentReceipt {
  /** The saved file name inside the uploads directory, e.g. `2026-11-16-pitch.docx`. */
  name: string;
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
  /** sha256 of the saved bytes, so the sender can confirm what arrived. */
  sha256: string;
  /** Text read out of a .docx, saved beside it as a .txt: the path a worker can read. */
  text?: { name: string; path: string; chars: number; sha256: string };
  /** What could not be done with these bytes, in plain words, when that is worth saying. */
  note?: string;
  /** Set for a zip archive, exactly as a chat upload reports one. */
  extracted?: SavedUpload["extracted"];
}

/**
 * A file name that is safe to put in the uploads directory as it stands, or a plain reason it is not.
 * A name that merely needs sanitising (spaces, a long stem) is fine: `Uploads.save` does that as it
 * always has. This refuses the names that are unsafe rather than quietly rewriting them.
 */
export function unsafeNameReason(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.trim()) return "the document needs a file name";
  if (name.length > NAME_MAX) return `the file name is longer than ${NAME_MAX} characters`;
  if (/[\\/]/.test(name)) return "the file name must be a plain name with no path in it";
  if (name.includes("..")) return "the file name must not climb out of the uploads folder";
  if (name.startsWith(".")) return "the file name must not start with a dot";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "the file name must not contain control characters";
  return undefined;
}

export type DocumentFamily = "docx" | "pdf" | "zip" | "image" | "text" | "unknown";

/** The family of bytes the name and the declared type point at, for the check that follows. */
export function familyOf(name: string, declared?: string): DocumentFamily {
  const ext = path.extname(name).toLowerCase();
  const mime = (declared ?? "").toLowerCase().split(";")[0]!.trim();
  if (ext === ".docx" || mime === DOCX_MIME) return "docx";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if (ext === ".zip" || mime === "application/zip") return "zip";
  if (IMAGE_EXTS.has(ext) || mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || TEXT_EXTS.has(ext)) return "text";
  return "unknown";
}

const isZip = (d: Buffer) => d.length >= 4 && d.readUInt32LE(0) === 0x04034b50;
const startsWith = (d: Buffer, bytes: number[]) => d.length >= bytes.length && bytes.every((b, i) => d[i] === b);
const isPdf = (d: Buffer) => d.subarray(0, 5).toString("latin1") === "%PDF-";
const isImage = (d: Buffer) =>
  startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || // PNG
  startsWith(d, [0xff, 0xd8, 0xff]) || // JPEG
  startsWith(d, [0x47, 0x49, 0x46, 0x38]) || // GIF
  (startsWith(d, [0x52, 0x49, 0x46, 0x46]) && d.subarray(8, 12).toString("latin1") === "WEBP");

/** Valid UTF-8 text with no NUL in it: what a file that says it is text should hold. */
function isText(d: Buffer): boolean {
  if (d.includes(0)) return false;
  const s = d.toString("utf8");
  return !s.includes("�") && Buffer.compare(Buffer.from(s, "utf8"), d) === 0;
}

/** Why these bytes are not what the name and the declared type say they are, or undefined when they are. */
export function contradictionReason(family: DocumentFamily, bytes: Buffer): string | undefined {
  switch (family) {
    case "docx":
      return isZip(bytes) ? undefined : "the file says it is a Word document (.docx) but the bytes are not one";
    case "zip":
      return isZip(bytes) ? undefined : "the file says it is a zip archive but the bytes are not one";
    case "pdf":
      return isPdf(bytes) ? undefined : "the file says it is a PDF but the bytes are not one";
    case "image":
      return isImage(bytes) ? undefined : "the file says it is an image but the bytes are not PNG, JPEG, GIF or WebP";
    case "text":
      return isText(bytes) ? undefined : "the file says it is text but the bytes are not readable text";
    default:
      // Nothing to compare against: an unknown type is saved as it is rather than guessed at.
      return undefined;
  }
}

function decodeXml(s: string): string {
  const fromCode = (hex: string, radix: number): string => {
    const n = Number.parseInt(hex, radix);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
    try {
      return String.fromCodePoint(n);
    } catch {
      return "";
    }
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCode(h, 16))
    .replace(/&#(\d+);/g, (_, d: string) => fromCode(d, 10))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text of one Word paragraph: its runs in order, with tabs and breaks kept. */
function paragraphText(para: string): string {
  const parts: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;
  for (let m = re.exec(para); m; m = re.exec(para)) {
    if (m[1] !== undefined) parts.push(decodeXml(m[1]));
    else if (m[0].startsWith("<w:tab")) parts.push("\t");
    else parts.push("\n");
  }
  return parts.join("");
}

/**
 * The readable text of a Word document's `word/document.xml`: one line per paragraph, blank runs of
 * lines collapsed, nothing invented. Runs inside deleted text are left in as they are written.
 */
export function docxText(xml: string): string {
  const lines = xml
    .split(/<\/w:p>/)
    .map((para) => paragraphText(para).replace(/[ \t]+$/g, ""))
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim() && kept.length && !kept[kept.length - 1]!.trim()) continue; // one blank line at most
    kept.push(line);
  }
  return kept.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

/** The text of a .docx, or a plain refusal when the archive has no readable body. */
export function docxTextFrom(data: Buffer): string {
  let xml: Buffer | undefined;
  try {
    xml = readZipEntry(data, "word/document.xml", DOCX_XML_MAX_BYTES);
  } catch {
    throw new DocumentError("the Word document is malformed or incomplete and could not be read");
  }
  if (!xml) throw new DocumentError("the Word document is incomplete: it has no readable body");
  return docxText(xml.toString("utf8"));
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * A body parser for the documents route. It carries real bytes, so it is the one place with a larger
 * limit than the app-wide JSON parser, and a body over it is refused in the same plain shape as every
 * other refusal rather than as an HTML error page.
 */
export function documentBodyParser(maxBytes: number) {
  const parse = express.json({ limit: Math.ceil(maxBytes / 3) * 4 + JSON_SLACK_BYTES });
  return (req: Request, res: Response, next: NextFunction): void => {
    parse(req, res, (err?: unknown) => {
      if (!err) return next();
      const e = err as { status?: number; statusCode?: number; type?: string };
      if (e.status === 413 || e.statusCode === 413 || e.type === "entity.too.large") {
        res.status(413).json({ ok: false, error: `too large (limit ${formatSize(maxBytes)})` });
        return;
      }
      res.status(400).json({ ok: false, error: "the request body is not readable JSON" });
    });
  };
}

/** The JSON body of one document request. */
export interface DocumentRequest {
  name?: unknown;
  mimeType?: unknown;
  note?: unknown;
  data?: unknown;
}

export class DocumentIngest {
  constructor(
    private readonly uploads: Uploads,
    /** One JSON line per accepted or refused document, never its bytes. Best effort: a failure is swallowed. */
    private readonly logFile?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The largest document this service takes, from the uploads store's own limit. */
  get maxBytes(): number {
    return this.uploads.limits.maxBytes;
  }

  /** Validate one request and save it, or throw a DocumentError with a message safe to show Paul. */
  ingest(input: unknown): DocumentReceipt {
    try {
      return this.accept((input ?? {}) as DocumentRequest);
    } catch (err) {
      if (err instanceof DocumentError) {
        this.log({ ok: false, name: typeof (input as DocumentRequest | undefined)?.name === "string" ? String((input as DocumentRequest).name).slice(0, NAME_MAX) : undefined, reason: err.message });
        throw err;
      }
      this.log({ ok: false, reason: "the document could not be saved" });
      throw new DocumentError("the document could not be saved", 500);
    }
  }

  private accept(body: DocumentRequest): DocumentReceipt {
    const bad = unsafeNameReason(body.name);
    if (bad) throw new DocumentError(bad);
    const name = body.name as string;
    if (typeof body.data !== "string" || !body.data.length) throw new DocumentError("the document has no bytes in it");

    const max = this.maxBytes;
    // Check the encoded size first, so an absurd body is refused before it is decoded into memory.
    const b64 = body.data.replace(/\s+/g, "");
    if (b64.length > Math.ceil(max / 3) * 4 + 4) throw new DocumentError(`too large (limit ${formatSize(max)})`, 413);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new DocumentError("the data is not valid base64");
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) throw new DocumentError("the document has no bytes in it");
    if (bytes.length > max) throw new DocumentError(`too large (${formatSize(bytes.length)}; limit ${formatSize(max)})`, 413);

    const declared = typeof body.mimeType === "string" && body.mimeType.trim() ? body.mimeType.trim() : undefined;
    // Both what the name says and what the declared type says are held against the bytes, so a
    // document that is one thing by name and another by declaration is refused rather than saved
    // under a type it is not.
    const byName = familyOf(name);
    const byType = declared ? familyOf("", declared) : "unknown";
    for (const family of new Set<DocumentFamily>([byName, byType])) {
      const contradiction = contradictionReason(family, bytes);
      if (contradiction) throw new DocumentError(contradiction);
    }

    // Read the text out before anything is written, so a document we refuse leaves nothing behind.
    const isDocx = byName === "docx" || byType === "docx";
    const text = isDocx ? docxTextFrom(bytes) : undefined;

    const callerNote = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, NOTE_MAX) : undefined;
    let saved: SavedUpload;
    try {
      saved = this.uploads.save(name, bytes, declared, callerNote);
    } catch (err) {
      throw new DocumentError(err instanceof UploadError ? err.message : "the document could not be saved");
    }

    let textFile: DocumentReceipt["text"];
    if (text !== undefined && text.trim()) {
      const data = Buffer.from(text, "utf8");
      try {
        // Beside the .docx, under the original name, so the two share a stem and the store's own
        // naming keeps them from ever overwriting an earlier upload.
        const t = this.uploads.save(`${name}.txt`, data, "text/plain");
        textFile = { name: t.name, path: t.path, chars: text.length, sha256: sha256(data) };
      } catch {
        // The document itself is saved: a missing companion file is reported, never hidden.
        textFile = undefined;
      }
    }
    let note: string | undefined;
    if (text !== undefined) note = text.trim() ? undefined : "no text could be read from the document (it may hold only images)";
    else if (byName === "pdf" || byType === "pdf") note = "a PDF is saved as it is; text is not extracted from PDFs";
    else if (byName === "unknown" && byType === "unknown") note = "this type is saved as it is; no text was extracted from it";

    const receipt: DocumentReceipt = {
      name: saved.name,
      path: saved.path,
      originalName: name,
      mimeType: saved.mimeType,
      size: saved.size,
      sha256: sha256(bytes),
      ...(textFile ? { text: textFile } : {}),
      ...(note ? { note } : {}),
      ...(saved.extracted ? { extracted: saved.extracted } : {}),
    };
    this.log({ ok: true, name: saved.name, bytes: saved.size, sha256: receipt.sha256, ...(textFile ? { text: textFile.name, chars: textFile.chars } : {}), ...(text !== undefined && !textFile ? { text: "none" } : {}) });
    return receipt;
  }

  /** One JSON line per document, owner-only, never the bytes: what arrived, and what was refused and why. */
  private log(line: Record<string, unknown>): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, `${JSON.stringify({ at: this.now().toISOString(), ...line })}\n`, { mode: 0o600 });
    } catch {
      // Best effort only: a log that cannot be written never fails a document that arrived.
    }
  }
}
