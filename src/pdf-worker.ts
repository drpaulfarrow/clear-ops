/**
 * This service's own PDF reader, run in a thread of its own.
 *
 * `pdfText` (src/pdf.ts) is synchronous from end to end: it inflates and parses streams, and on a big
 * or awkward file that takes seconds. Called on the message path it would stop the service's event loop
 * for that whole time, taking `/health` (Fly's own check, and the outside watchdog), `/busy` (which the
 * deploy's wait-for-quiet polls), the channel listeners and the minute watchdog with it. So
 * src/pdf-extract.ts loads this file with `node:worker_threads`, hands it the bytes and the budgets,
 * and gets the result back as a message: the read happens somewhere else, and the service keeps
 * answering while it runs.
 *
 * Nothing else happens here. The thread reads no file, writes none, reaches no network and opens no
 * environment: the bytes it reads arrive as a message and its answer is one message back.
 *
 * The reader is imported by the name this file itself was loaded under: `./pdf.ts` when the service is
 * running from source (the tests, `npm run dev`), `./pdf.js` when it is the compiled tree in the image.
 * A worker thread does not inherit a loader (`tsx` and the like register in the thread that started
 * them, not in this one), so it is Node's own type stripping that reads the source here, and nothing in
 * src/pdf.ts may use the syntax that stripping cannot handle - no parameter properties, no enum.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { PdfLimits, PdfText } from "./pdf.js";

const { data, limits } = (workerData ?? {}) as { data?: Uint8Array; limits?: PdfLimits };
const source = import.meta.url.endsWith(".ts");
const { pdfText } = (await import(source ? "./pdf.ts" : "./pdf.js")) as { pdfText: (data: Buffer, limits?: PdfLimits) => PdfText };

parentPort?.postMessage(data ? pdfText(Buffer.from(data), limits ?? {}) : undefined);
