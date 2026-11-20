/**
 * The web app's search (src/app-search.ts). It finds jobs, their saved reports and what has been said in
 * the app's chats, and it finds nothing the app does not already show: a private job by its title alone,
 * a report only where it would be served, a message only in a conversation that still exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-search-"));

const { Store } = await import("../src/store.js");
const { WebChat } = await import("../src/web-chat.js");
const { appSearch, searchWords, snippet, plainReport, SEARCH_JOBS, SEARCH_MAX, SEARCH_WORDS, SEARCH_CHATS } = await import("../src/app-search.js");
const { createSpace, ownSpaceAddress } = await import("../src/spaces.js");
const { reportFor, reportText } = await import("../src/reports.js");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const PAUL = "tg:99887766";

function world() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-search-store-")));
  const chat = new WebChat();
  const mk = (kind: string, title: string, brief: string, patch: Record<string, unknown> = {}, target = "product") => s.updateJob(s.createJob(kind as never, brief, PAUL, target as never, PAUL, { title } as never).id, patch as never);
  const find = (q: unknown) => appSearch({ store: s }, chat, q);
  return { s, chat, mk, find };
}

test("what is typed becomes a few plain words, or nothing when it is too short", () => {
  assert.deepEqual(searchWords("  Billing   IDEMPOTENCY billing "), ["billing", "idempotency"]);
  for (const none of ["", " ", "a", " b ", undefined, null, 7, ["billing"], { q: "billing" }]) assert.deepEqual(searchWords(none), [], JSON.stringify(none));
  assert.equal(searchWords("a b c d e f g h").length, SEARCH_WORDS);
  assert.ok(searchWords("x".repeat(500))[0]!.length <= SEARCH_MAX);
  // A pattern typed in is looked for as the letters it is.
  assert.deepEqual(searchWords(".* (a+)+$"), [".*", "(a+)+$"]);
  assert.doesNotMatch(fs.readFileSync("src/app-search.ts", "utf8"), /new RegExp\(/, "no pattern is ever built from what he types");
});

test("a snippet is one line around the first word found, cut with an ellipsis", () => {
  const long = `${"before ".repeat(40)}the NEEDLE is here ${"after ".repeat(60)}`;
  const cut = snippet(long, ["needle"]);
  assert.ok(cut.startsWith("…") && cut.endsWith("…"));
  assert.ok(cut.includes("NEEDLE") && cut.length < 240);
  assert.equal(snippet("short\n\n  and   spaced", ["spaced"]), "short and spaced");
  assert.equal(snippet("no match at all", ["zzz"]), "no match at all");
});

test("jobs are found by title, and by brief unless they work over his private things", () => {
  const { mk, find } = world();
  const a = mk("research", "Venue shortlist", "Find three venues in Bury St Edmunds for the launch.", { status: "done", startedAt: at(60), finishedAt: at(50) });
  const b = mk("engineer", "Billing retries", "Add an idempotency key to charge creation.", { status: "running", startedAt: at(5) }, "self");
  const mail = mk("ea", "Morning brief", "Summarise the thread with the solicitor about the Hamburg sale.", { status: "done", startedAt: at(30), finishedAt: at(20) });
  const doc = mk("research", "Notes from a document", "Read the solicitor's letter he uploaded.", { status: "done", startedAt: at(40), finishedAt: at(35), docSnapshot: { id: "x" } });

  assert.deepEqual(find("venue").jobs.map((j) => [j.id, j.snippet]), [[a.id, undefined]], "in the title, so no snippet is needed");
  const byBrief = find("idempotency KEY").jobs;
  assert.deepEqual(byBrief.map((j) => j.id), [b.id]);
  assert.match(byBrief[0]!.snippet!, /idempotency key to charge creation/);
  assert.deepEqual([byBrief[0]!.who, byBrief[0]!.repositoryName, byBrief[0]!.status], ["engineer", "workforce", "running"]);
  // Every word has to be there, in any order.
  assert.deepEqual(find("edmunds venues").jobs.map((j) => j.id), [a.id]);
  assert.deepEqual(find("venues tokyo").jobs, []);
  // A private kind, or a job over a document of his, is found by its title and never by its brief.
  assert.deepEqual(find("solicitor").jobs, []);
  assert.deepEqual(find("hamburg").jobs, []);
  assert.deepEqual(find("morning brief").jobs.map((j) => j.id), [mail.id]);
  assert.deepEqual(find("notes document").jobs.map((j) => j.id), [doc.id]);
  assert.ok(!JSON.stringify(find("morning")).includes("solicitor"), "and its brief is not sent as a snippet either");

  // Too little to search for finds nothing, and says so by sending no words.
  assert.deepEqual([find("v").words, find("v").jobs.length, find(undefined).jobs.length], [[], 0, 0]);
  // Only so many are sent, newest first, and the rest are owned up to.
  for (let i = 0; i < SEARCH_JOBS + 3; i++) mk("write", `Memo ${i}`, "A memo about widgets.", { status: "done", startedAt: at(500 + i), finishedAt: at(499 + i) });
  const many = find("memo");
  assert.equal(many.jobs.length, SEARCH_JOBS);
  assert.equal(many.more.jobs, true);
  assert.equal(many.jobs[0]!.title, "Memo 0");
});

test("a report is searched only where it would be served", () => {
  const { s, mk, find } = world();
  const served = mk("research", "GLM licensing", "Map who licenses GLM.", { status: "done", startedAt: at(60), finishedAt: at(50) });
  s.writeOutput(served.id, "# GLM licensing\n\nThree licensors matter. The cheapest is Zhipu's own platform, at a tenth of the price.");
  const mail = mk("ea", "Inbox sweep", "Sweep the inbox.", { status: "done", startedAt: at(40), finishedAt: at(30) });
  s.writeOutput(mail.id, "Zhipu wrote to you about the invoice.");
  const failed = mk("research", "Half done", "Look into Zhipu.", { status: "failed", startedAt: at(20), finishedAt: at(10) });
  s.writeOutput(failed.id, "Zhipu, partly.");
  assert.ok(reportFor(s, served.id) && !reportFor(s, mail.id) && !reportFor(s, failed.id), "the reports module's own rule");
  assert.deepEqual([reportText(s, served.id)?.includes("Zhipu"), reportText(s, mail.id), reportText(s, failed.id), reportText(s, "../etc"), reportText(s, "nope")], [true, undefined, undefined, undefined, undefined]);

  const found = find("zhipu");
  assert.deepEqual(found.reports.map((r) => [r.id, r.title]), [[served.id, "GLM licensing"]]);
  assert.match(found.reports[0]!.snippet, /cheapest is Zhipu's own platform/);
  assert.ok(found.reports[0]!.snippet.startsWith("GLM licensing Three licensors"), "its Markdown marks are not part of what is shown");
  assert.equal(plainReport("## What is **sound**\n\n- The `queue` | fine\n1. First\n> quoted\nsnake_case stays").replace(/ +/g, " "), "What is sound \n\nThe queue fine\nFirst\nquoted\nsnake_case stays");
  assert.ok(!JSON.stringify(found).includes("invoice"), "the assistant's output is never read into a result");
  // A report saved after a search is found by the next one.
  const late = mk("research", "Later", "Something else.", { status: "done", startedAt: at(5), finishedAt: at(4) });
  assert.equal(find("quokka").reports.length, 0);
  s.writeOutput(late.id, "A quokka appears.");
  s.updateJob(late.id, { finishedAt: at(3) } as never);
  assert.deepEqual(find("quokka").reports.map((r) => r.id), [late.id]);
});

test("messages are found in the conversations that still exist, and say which one", async () => {
  const { s, chat, mk, find } = world();
  const job = mk("research", "Venue shortlist", "Find venues.", { status: "done", startedAt: at(60), finishedAt: at(50) });
  const space = createSpace(s, { name: "Launch plan" }, [{ alias: "self", name: "workforce" }], NOW);
  const own = chat.open("Holiday ideas");
  chat.inbound("Where is the pangolin report?");
  await chat.send("web:main", "The pangolin report is with Scout.");
  chat.inbound("pangolin in my own chat", `web:chat:${own.id}`);
  chat.inbound("pangolin for the launch", ownSpaceAddress(space.id));
  chat.inbound("pangolin in the workforce space", "web:space:self");
  chat.inbound("pangolin about this job", `web:job:${job.id}`);
  chat.inbound("pangolin on the pull request", "web:pull:self:111");
  chat.inbound("see attached", undefined, ["pangolin-notes.pdf"]);
  const sent = chat.inbound("", undefined, ["voice-note.webm"]);
  await chat.heard("web:main", sent.id, ["the pangolin said hello"]);
  await chat.sendEditable("web:main", "Reading about the pangolin");

  const found = find("pangolin");
  assert.deepEqual(found.messages.map((m) => [m.where, m.title, m.from]), [
    [{ in: "main" }, "Main", "paul"],
    [{ in: "main" }, "Main", "paul"],
    [{ in: "pull", repo: "self", number: 111 }, "Pull request #111, workforce", "paul"],
    [{ in: "job", id: job.id }, "Thread: Venue shortlist", "paul"],
    [{ in: "space", id: "self" }, "workforce", "paul"],
    [{ in: "space", id: space.id }, "Launch plan", "paul"],
    [{ in: "chat", id: own.id }, "Holiday ideas", "paul"],
    [{ in: "main" }, "Main", "clearops"],
    [{ in: "main" }, "Main", "paul"],
  ], "newest first; the chief's status line is not a message");
  // Found by a file's name and by what was heard in a voice note, as well as by its words.
  assert.match(found.messages[0]!.snippet, /the pangolin said hello/);
  assert.match(found.messages[1]!.snippet, /pangolin-notes\.pdf/);
  // A conversation that is gone has nowhere to be opened, so what was said in it is not offered.
  chat.close(own.id);
  s.setSpaces([]);
  assert.deepEqual(find("pangolin").messages.map((m) => m.where.in), ["main", "main", "pull", "job", "space", "main", "main"]);
  // Only so many, and the rest owned up to.
  for (let i = 0; i < SEARCH_CHATS + 2; i++) chat.inbound(`quokka ${i}`);
  const many = find("quokka");
  assert.deepEqual([many.messages.length, many.more.messages, many.messages[0]!.snippet], [SEARCH_CHATS, true, `quokka ${SEARCH_CHATS + 1}`]);
});

test("searching writes nothing, reaches no model, and the page shows what it found as text", () => {
  const code = fs.readFileSync("src/app-search.ts", "utf8");
  assert.doesNotMatch(code, /\.(updateJob|createJob|writeOutput|setSpaces|setSetting|save|send|inbound|open|close|forget)\(/, "it only reads");
  assert.doesNotMatch(code, /orchestrator|runner|readFileSync|readOutput\(|fetch\(/, "a report is read through the reports module's own rule and nothing else");
  assert.match(code, /const text = reportText\(store, job\.id\)\?\.slice\(0, SEARCH_REPORT_CHARS\);/);
  const index = fs.readFileSync("src/index.ts", "utf8");
  assert.match(index, /app\.get\(`\$\{APP_PATH\}\/api\/search`, \(req, res\) => \{\s*appHeaders\(res\);\s*res\.json\(appSearch\(appSource\(\), chat, req\.query\.q\)\);\s*\}\);/);
  const js = fs.readFileSync("public/app/app.js", "utf8");
  const page = js.slice(js.indexOf("/* ---------- Search ---------- */"), js.indexOf("/* ---------- Board views ---------- */"));
  assert.doesNotMatch(page, /innerHTML|rendered\(|new RegExp\(/, "a result is text and elements, never markup, and no pattern is built from what was typed");
  assert.match(page, /out\.push\(h\("mark", \{\}, text\.slice\(at, at \+ len\)\)\);/);
  // Only the answer to what is in the box now is shown.
  assert.match(js, /if \(mine !== searchAsked\) return;/);
});
