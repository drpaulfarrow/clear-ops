/**
 * A report made from a file Paul uploaded is his to read in the signed-in app (src/reports.ts
 * `appReportFor`). It is still withheld from the report links and never copied to the outputs
 * repository. On 21 Nov 2026 a requirements document written from an upload finished and the app showed
 * no link and no report, though `show job` in the same chat printed it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-upload-report-"));

const { Store } = await import("../src/store.js");
const { WebChat } = await import("../src/web-chat.js");
const { reportFor, reportText, appReportFor, appReportText, reportEntries } = await import("../src/reports.js");
const { classify, FROM_UPLOAD } = await import("../src/output-folders.js");
const { appChat, appJob, appSpace } = await import("../src/app-data.js");
const { appSearch } = await import("../src/app-search.js");
const { reportPointer } = await import("../src/messages.js");

const PAUL = "tg:99887766";
const NOW = Date.parse("2026-11-21T11:30:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const queue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: NOW }), capReached: () => false };

function world() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-upload-report-store-")));
  const done = (kind: string, title: string, brief: string, output: string, patch: Record<string, unknown> = {}) => {
    const job = store.updateJob(store.createJob(kind as never, brief, PAUL, "product", PAUL, { title }).id, { status: "done", startedAt: at(20), finishedAt: at(5), ...patch });
    store.writeOutput(job.id, output);
    return job;
  };
  const fromUpload = done("write", "Lusana replica requirements", "Turn the text at /data/uploads/2026-11-21-lusana.html.txt into numbered product requirements.", "# Lusana replica requirements\n\n1. A family signs in with email.\n2. A shared weekly calendar. <script>alert(1)</script>\n");
  const plain = done("research", "Licensing map", "Map who licenses the models.", "# Licensing map\n\nThree licensors matter.\n");
  const mail = done("ea", "Morning brief", "Check the inbox, and see /data/uploads/2026-11-21-notes.txt.", "SECRET MAIL from someone.\n");
  const cv = done("cv", "CV for the board role", "Use /data/uploads/2026-11-21-cv.pdf.txt.", "SECRET CV.\n");
  const doc = done("write", "From the private doc", "Write it up, with /data/uploads/2026-11-21-x.txt beside it.", "SECRET DOC.\n", { docSnapshot: true });
  return { store, fromUpload, plain, mail, cv, doc, source: { store, queue, now: NOW } };
}

test("a report made from his upload is shown in the app, marked private, and nowhere else", () => {
  const w = world();
  assert.deepEqual(classify(w.fromUpload, w.store.readOutput(w.fromUpload.id)!), { excluded: FROM_UPLOAD });
  // The report links and the list behind them are exactly as they were: it is not there.
  assert.equal(reportFor(w.store, w.fromUpload.id), undefined);
  assert.equal(reportText(w.store, w.fromUpload.id), undefined);
  assert.deepEqual(reportEntries(w.store).map((r) => r.id), [w.plain.id]);
  // The app is given it, as Markdown to render here, and told why it is private.
  const shown = appReportFor(w.store, w.fromUpload.id)!;
  assert.equal(shown.private, "upload");
  assert.match(shown.markdown!, /^# Lusana replica requirements/);
  assert.equal(shown.htmlPath, undefined);
  assert.match(appReportText(w.store, w.fromUpload.id)!, /A shared weekly calendar/);
  // An ordinary report is the same in both, and not marked.
  assert.deepEqual(appReportFor(w.store, w.plain.id), reportFor(w.store, w.plain.id));
  assert.equal(appReportFor(w.store, w.plain.id)!.private, undefined);
});

test("what is withheld for any other reason stays withheld from the app too, even when it also names an upload", () => {
  const w = world();
  for (const job of [w.mail, w.cv, w.doc]) {
    assert.equal(appReportFor(w.store, job.id), undefined, job.kind);
    assert.equal(appReportText(w.store, job.id), undefined, job.kind);
    assert.equal(appJob(w.source, job.id)!.outputHtml, undefined, job.kind);
  }
  for (const bad of ["nope", "../state", "", "constructor"]) assert.equal(appReportFor(w.store, bad), undefined, bad);
  // Not finished, or nothing saved: there is nothing to show.
  const running = w.store.createJob("write", "Use /data/uploads/x.txt", PAUL, "product", PAUL, { title: "Still going" });
  w.store.updateJob(running.id, { status: "running", startedAt: at(1) });
  assert.equal(appReportFor(w.store, running.id), undefined);
  const silent = w.store.updateJob(w.store.createJob("write", "Use /data/uploads/y.txt", PAUL, "product", PAUL, { title: "Wrote nothing" }).id, { status: "done", finishedAt: at(1) });
  assert.equal(appReportFor(w.store, silent.id), undefined);
});

test("the chat links to it, the job's page shows it with the note, and the app's search finds it", async () => {
  const w = world();
  const chat = new WebChat();
  await chat.send("web:main", `Finished: Lusana replica requirements. Drafted the full build spec.${" "}${reportPointer(w.fromUpload.id)}`);
  await chat.send("web:main", `Finished: Morning brief. ${reportPointer(w.mail.id)}`);
  const [upload, mail] = appChat(w.source, chat).messages;
  // The command to type is taken off and the message carries the job, so the app shows a link to the report.
  assert.deepEqual(upload!.report, { job: w.fromUpload.id, title: "Lusana replica requirements" });
  assert.doesNotMatch(upload!.html!, /show job/);
  // An assistant's message keeps the words exactly as they were sent, as before.
  assert.equal(mail!.report, undefined);
  assert.match(mail!.html!, /Full report: show job/);
  const page = appJob(w.source, w.fromUpload.id)!;
  assert.equal(page.outputPrivate, "upload");
  assert.match(page.outputHtml!, /<h1[^>]*>Lusana replica requirements<\/h1>/);
  assert.doesNotMatch(page.outputHtml!, /<script>/, "it is escaped by the service like any report");
  assert.equal(appJob(w.source, w.plain.id)!.outputPrivate, undefined);
  const found = appSearch(w.source, chat, "weekly calendar");
  assert.deepEqual(found.reports.map((r) => r.id), [w.fromUpload.id]);
  assert.deepEqual(appSearch(w.source, chat, "SECRET").reports, [], "nothing withheld for another reason is found");
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.match(js, /detail\.outputPrivate === "upload" \? h\("p", \{ class: "muted report-private" \}, "Made from a file you uploaded, so it is shown only here in the app: it has no report link and is not copied to the outputs repository\."\) : null,/);
  assert.equal(appSpace(w.source, chat, "nowhere"), undefined);
});
