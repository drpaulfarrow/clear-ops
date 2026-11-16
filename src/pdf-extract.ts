/**
 * A PDF's text, read with an established parser where one is installed, and off the main thread either way.
 *
 * Paul's rule of 16 November 2026: extraction uses an established parser or `pdftotext` where feasible,
 * and a partial extraction is never reported as a success. So `pdftotext` is the first choice whenever
 * it is on PATH (poppler-utils, one word on the Dockerfile's apt line: it ships in the image, built by
 * CI, so it costs no room on the data volume). Being a child process, it cannot stop the event loop
 * while it works. This service's own reader (src/pdf.ts) stays as the fallback for a machine without
 * `pdftotext` - local development, a bare runner - and it runs in a worker thread, so it cannot stop the
 * event loop either (src/pdf-worker.ts).
 *
 * Both paths are bounded, by more than the caller's character cap:
 *   - a file larger than PDF_MAX_BYTES is not read at all and says so;
 *   - the reader's own budgets (steps and stream bytes) scale with the size of the file itself
 *     (`readerLimitsFor`, src/pdf.ts), so a few kilobytes cannot ask for bomb-scale work;
 *   - each read has a hard timeout, after which it is stopped and the text is reported as partial;
 *   - the reader runs in a thread with a memory ceiling of its own;
 *   - and `pdftotext` runs as the unprivileged `designer` user with an environment of its own
 *     (PATH, HOME, TMPDIR, the locale), never the service's secrets, on bytes handed to it over stdin.
 *
 * Nothing here turns a partial or a failed read into a success. The text comes back only when it really
 * is the document's text; every way it can be less than that - no text layer at all, a limit, a
 * timeout, a font with no readable encoding - comes back as a plain reason that `pdfTextNote`
 * (src/pdf.ts) turns into a note for Paul and the chief, and a file it cannot read comes back with a
 * reason rather than an empty string called a success. This function never throws.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { designIdentity, designerTemp, type Identity } from "./design.js";
import { countWords, isPdfData, readerLimitsFor, type PdfLimits, type PdfText } from "./pdf.js";

/** Where a read's text came from: the installed parser, or this service's own reader. */
export type PdfTextSource = "pdftotext" | "reader";

/** What reading one PDF produced, and which reader produced it. */
export interface PdfExtraction extends PdfText {
  source: PdfTextSource;
}

export interface PdfExtractOptions {
  /** How long one read may take before it is stopped and called partial. */
  timeoutMs?: number;
  /**
   * The `pdftotext` to use, or null to read with this service's own reader. The default looks it up on
   * PATH; PDFTOTEXT_PATH names one explicitly (a test, or a machine that keeps it somewhere else).
   */
  pdftotext?: string | null;
  /** Most bytes of a PDF worth reading at all. PDF_MAX_BYTES unless a caller says otherwise. */
  maxBytes?: number;
}

/** Most bytes of a PDF this will read at all. Far above the upload limit (UPLOAD_MAX_MB, 20 MB). */
export const PDF_MAX_BYTES = 64 * 1024 * 1024;
/** How long `pdftotext` and the fallback reader may run, by default. */
const TOOL_TIMEOUT_MS = 30_000;
const READER_TIMEOUT_MS = 20_000;
/** Bytes of `pdftotext` output kept beyond the character cap, so a multi-byte character is never cut. */
const OUTPUT_SLACK = 1 << 16;
/** Memory this service's own reader, in its own thread, may use: a decompression bomb cannot take the machine down. */
const READER_MEMORY_MB = 512;

/** A plain reason with no text at all, in the same shape the reader itself uses (src/pdf.ts). */
function nothing(reason: string): PdfText {
  return { text: "", pages: 0, pagesWithText: 0, pagesWithoutText: [], chars: 0, words: 0, reason, truncated: false, undecoded: 0 };
}

/** Plain words for each way this can turn out short of a whole document. */
const tooLargeReason = (maxBytes: number): string => `the PDF is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, so its text was not read`;
const stoppedReason = (timeoutMs: number): string => `the read was stopped after ${Math.round(timeoutMs / 1000)} seconds, so it may cover only part of the file`;
const cappedReason = "the read stopped at this service's limit, so the text covers only part of the file";
const noReaderReason = "the PDF's text could not be read (this service's own reader could not be started)";

/* --------------------------------- the tool --------------------------------- */

/** True when this path names a file we could run. */
function runnable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `pdftotext` to use: PDFTOTEXT_PATH when it names one (and only when that file can be run), else
 * the first `pdftotext` on PATH, else undefined - which is not a failure, it is the fallback reader.
 */
export function findPdftotext(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.PDFTOTEXT_PATH?.trim();
  if (named) return runnable(named) ? named : undefined;
  for (const dir of (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "pdftotext");
    if (runnable(candidate)) return candidate;
  }
  return undefined;
}

let identity: Promise<Identity | undefined> | undefined;

/**
 * Who a tool that parses a file a third party produced may run as: the unprivileged `designer` user the
 * design browser already runs as, never root. Undefined when there is no such user - and then nothing
 * runs, because a root child could read the service's environment through /proc.
 */
function toolIdentity(): Promise<Identity | undefined> {
  identity ??= designIdentity()
    .then((who) => who)
    .catch(() => undefined);
  return identity;
}

/** What one `pdftotext` run produced. `failed` set means its output is not to be trusted as the text. */
interface ToolRun {
  text: string;
  truncated: boolean;
  failed?: "timeout" | "spawn" | "exit";
}

/** Runs `pdftotext` over the bytes, as the designer user, with an environment of its own and a hard timeout. */
function runPdftotext(bin: string, data: Buffer, maxChars: number, timeoutMs: number, who: Identity | undefined): Promise<ToolRun> {
  return new Promise((resolve) => {
    // UTF-8 is at most four bytes a character, so this is the caller's cap with room to spare: past it
    // the read is stopped and called partial rather than being poured into memory.
    const limit = maxChars * 4 + OUTPUT_SLACK;
    let home: string | undefined;
    try {
      home = who ? designerTemp("clear-ops-pdftotext-", who) : undefined;
    } catch {
      home = undefined;
    }
    const scratch = home ?? os.tmpdir();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["-enc", "UTF-8", "-", "-"], {
        // Its own environment and nothing of the service's: a third-party parser gets no secret of ours.
        // It reads the PDF from stdin and writes the text to stdout, so it needs no access to /data.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        ...(who ? { uid: who.uid, gid: who.gid } : {}),
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      resolve({ text: "", truncated: false, failed: "spawn" });
      return;
    }
    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let settled = false;
    const finish = (r: ToolRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (home) fs.rmSync(home, { recursive: true, force: true });
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish({ text: Buffer.concat(chunks).toString("utf8"), truncated: true, failed: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (kept >= limit) return;
      const room = limit - kept;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      kept += Math.min(chunk.length, room);
      if (kept >= limit) finish({ text: Buffer.concat(chunks).toString("utf8"), truncated: true });
    });
    // A tool that will not take its input may never write anything: a broken pipe is not a crash here.
    child.stdin?.on("error", () => undefined);
    child.on("error", () => finish({ text: "", truncated: false, failed: "spawn" }));
    child.on("close", (code) => {
      if (timedOut || settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      // Only a clean exit is this tool's own word that it read the whole file. Anything else is a
      // failure, and the text it did write is not used: this service's own reader gets its turn.
      if (code === 0) finish({ text, truncated: false });
      else finish({ text, truncated: false, failed: "exit" });
    });
    child.stdin?.end(data);
  });
}

/**
 * The tool's text in the shape the rest of this service reads. `pdftotext` writes a form feed after each
 * page, so the pages are its own page breaks and a page whose section is blank is a page that gave
 * nothing - the same accounting as this service's own reader.
 */
function fromTool(text: string, reason?: string): PdfText {
  const sections = text.split("\f");
  if (sections.length > 1 && !sections[sections.length - 1].trim()) sections.pop();
  const pages = Math.max(1, sections.length);
  const pagesWithoutText = sections.map((s, i) => (s.trim() ? 0 : i + 1)).filter((n) => n > 0);
  const body = sections.join("\f").replace(/\f+$/, "");
  return {
    text: body,
    pages,
    pagesWithText: pages - pagesWithoutText.length,
    pagesWithoutText,
    chars: body.length,
    words: countWords(body),
    truncated: reason !== undefined,
    ...(reason ? { reason } : {}),
    undecoded: 0,
  };
}

/* ------------------------------- the fallback ------------------------------- */

/** What one run of this service's own reader produced, in its own thread. */
type ReaderRun = { result: PdfText } | { failed: "timeout" | "start" | "error" };

/**
 * The reader in a worker thread. The loader this process was started with is passed on (tsx under the
 * tests and `npm run dev`, nothing in the deployed image), so the worker reads the same source the
 * service does; in the image it is the compiled file beside this one.
 */
function runReader(data: Buffer, limits: PdfLimits, timeoutMs: number): Promise<ReaderRun> {
  return new Promise((resolve) => {
    const entry = new URL(import.meta.url.endsWith(".ts") ? "./pdf-worker.ts" : "./pdf-worker.js", import.meta.url);
    let worker: Worker;
    try {
      worker = new Worker(entry, {
        execArgv: process.execArgv,
        workerData: { data, limits },
        resourceLimits: { maxOldGenerationSizeMb: READER_MEMORY_MB, maxYoungGenerationSizeMb: 64 },
      });
    } catch {
      resolve({ failed: "start" });
      return;
    }
    let settled = false;
    const finish = (r: ReaderRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ failed: "timeout" }), timeoutMs);
    worker.on("message", (message: unknown) => finish({ result: message as PdfText }));
    worker.on("error", () => finish({ failed: "error" }));
    // A worker that died without answering is a failure. The result is deferred a tick, so a message
    // that its exit overtook is still read as the answer it was.
    worker.on("exit", () => setTimeout(() => finish({ failed: "error" }), 0));
  });
}

/* ---------------------------------- the read --------------------------------- */

/**
 * The text of a PDF, read off the main thread, never throwing.
 *
 * `pdftotext` when it is installed; where it is not, or where it gave nothing, this service's own reader
 * (in a worker thread) decides - its pages, its counts and its plain reasons are what is reported. The
 * tool's output is used only when it really holds text, and a read either path stopped early is marked
 * partial and said so in words.
 */
export async function extractPdfText(data: Buffer, limits: PdfLimits = {}, opts: PdfExtractOptions = {}): Promise<PdfExtraction> {
  if (!isPdfData(data)) return { ...nothing("the file is not a readable PDF"), source: "reader" };
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES;
  if (data.length > maxBytes) return { ...nothing(tooLargeReason(maxBytes)), source: "reader" };

  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS;
  // The reader's own budgets, scaled to this file's size; anything the caller set itself still wins.
  const readerLimits: PdfLimits = { ...readerLimitsFor(data.length, limits.maxChars), ...limits };
  const maxChars = readerLimits.maxChars ?? 1_000_000;
  const bin = opts.pdftotext === undefined ? findPdftotext() : (opts.pdftotext ?? undefined);
  const who = bin ? await toolIdentity() : undefined;
  // As root, a tool parsing a file a third party produced runs as the designer user or not at all.
  const runTool = Boolean(bin) && !(process.getuid?.() === 0 && !who);

  const tool = runTool && bin ? await runPdftotext(bin, data, maxChars, timeoutMs, who) : undefined;
  // Text from a tool that failed or could not be started is not the document's text and is thrown away,
  // whatever it says. Text from one that was stopped for time is the document's text as far as it got,
  // and is kept with the words that say so.
  if (tool?.text.trim() && tool.failed !== "exit" && tool.failed !== "spawn") {
    // The caller's character cap is enforced here as well as in the pipe, so a document that produces
    // more text than was asked for is cut and said to be partial rather than poured into memory.
    const overCap = tool.text.length > maxChars;
    const text = overCap ? tool.text.slice(0, maxChars) : tool.text;
    const reason = tool.failed === "timeout" ? stoppedReason(timeoutMs) : tool.truncated || overCap ? cappedReason : undefined;
    return { ...fromTool(text, reason), source: "pdftotext" };
  }

  const readerTimeoutMs = Math.min(timeoutMs, READER_TIMEOUT_MS);
  const reader = await runReader(data, readerLimits, readerTimeoutMs);
  if ("result" in reader && reader.result.text.trim()) return { ...reader.result, source: "reader" };
  if ("failed" in reader) {
    return {
      ...(reader.failed === "timeout" ? { ...nothing(stoppedReason(readerTimeoutMs)), truncated: true } : nothing(noReaderReason)),
      source: "reader",
    };
  }
  // Neither found any text. A tool that ran out of time is worth saying plainly; otherwise the reader's
  // own reason is the honest one (no text layer, a font with no readable encoding, a damaged file).
  if (tool?.failed === "timeout") return { ...nothing(stoppedReason(timeoutMs)), truncated: true, source: "pdftotext" };
  return { ...reader.result, source: "reader" };
}
