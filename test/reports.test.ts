/**
 * The reports view: every saved job output as a page Paul can read on his phone.
 *
 * No network and no model: the fake runner is never invoked, because the view only reads files that
 * are already saved. The tests cover the token gate, the Markdown renderer (headings, paragraphs,
 * lists, tables, code and links, and the escaping of raw HTML and a script), the exclusions the
 * outputs publisher applies, the self-contained .html file served instead when one was saved beside
 * the Markdown, and that nothing on the view can write.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-reports-"));

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { reportsToken, reportsTokenValid, reportsUrl, reportEntries, reportFor, renderMarkdown, renderReportPage, renderReportsIndex, dropRepeatedTitle, REPORTS_PATH, PAGE_CSP, FILE_CSP } = await import("../src/reports.js");
const { signIn, SIGN_IN_PATH, SIGN_OUT_PATH, SESSION_COOKIE } = await import("../src/sign-in.js");
const { londonYmd } = await import("../src/london.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";
import type { JobRunner } from "../src/jobs.js";
import type { Scheduler } from "../src/scheduler.js";
import type { Job } from "../src/store.js";

/** The view reads the store, so the runner must never be called. It fails the test loudly if it is. */
const runner: AgentRunner = async () => {
  throw new Error("the reports view must not run any worker");
};

const messenger = new ConsoleMessenger();
const PAUL = "tg:99887766";
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

/**
 * The reports view sits behind the browser sign-in (src/sign-in.ts), so every request here carries the
 * session cookie of a signed-in Paul. The password is set in `before` and signed in with once, through
 * the real route; the one-time link and the cookie's own rules are covered by test/sign-in.test.ts.
 */
const PASSWORD = "the reports test password";
let session = "";
const get = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), cookie: session } });

/** An output with something of everything the renderer has to handle. */
const MARKDOWN = `# Deep review

Opening paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com/page).

## Findings

- first finding
- second finding
  - nested detail
1. numbered one
2. numbered two

> A quoted line from the report.

| Repo | Tests | Note |
| --- | --- | --- |
| clear-ops | 450 | \`npm test\` |
| site | 0 | none |

\`\`\`ts
const risky = "<script>alert(1)</script>";
\`\`\`

<script>alert("SECRET SCRIPT")</script>

<div onclick="SECRET()">SECRET HTML</div>

---

Last line.
`;

let store: InstanceType<typeof Store>;
let scheduler: Scheduler;
let queue: JobRunner;
let server: import("node:http").Server;
let base: string;
let reportJob: Job;
let olderJob: Job;
let eaJob: Job;
let cvJob: Job;
let uploadJob: Job;
let noOutputJob: Job;
let runningJob: Job;
let htmlJob: Job;
const SAVED_HTML = "<!doctype html><html><head><title>Review</title></head><body><h1>Saved page</h1><script>alert(1)</script></body></html>";

before(async () => {
  store = new Store(process.env.DATA_DIR!);

  const job = (kind: Job["kind"], title: string, brief: string) => store.createJob(kind, brief, PAUL, "self", undefined, { title });

  // Newest first on the index: reportJob (1 min ago) then olderJob (40 min ago).
  olderJob = store.updateJob(job("research", "TollBit research", "what did TollBit do").id, { status: "done", finishedAt: at(40 * MIN) });
  store.writeOutput(olderJob.id, "# TollBit\n\nOlder report.\n");
  reportJob = store.updateJob(job("research", "Deep codebase review", "review every repository").id, { status: "done", finishedAt: at(1 * MIN) });
  store.writeOutput(reportJob.id, MARKDOWN);

  // Withheld, exactly as src/publish-outputs.ts withholds them: assistant and CV outputs, and
  // anything derived from a file Paul uploaded.
  eaJob = store.updateJob(job("ea", "Inbox triage", "what needs me today").id, { status: "done", finishedAt: at(2 * MIN) });
  store.writeOutput(eaJob.id, "Mail from jo@example.com says SECRET MAIL\n");
  cvJob = store.updateJob(job("cv", "Tailored CV", "tailor my CV").id, { status: "done", finishedAt: at(2 * MIN) });
  store.writeOutput(cvJob.id, "SECRET CV\n");
  uploadJob = store.updateJob(job("research", "Warm paths", "cross-reference the LinkedIn Connections.csv export with the publisher list").id, { status: "done", finishedAt: at(3 * MIN) });
  store.writeOutput(uploadJob.id, "SECRET CONTACTS\n");

  // A finished job with no saved output, a job still running, and an output whose job record is gone.
  noOutputJob = store.updateJob(job("research", "No output", "nothing saved").id, { status: "done", finishedAt: at(4 * MIN) });
  runningJob = store.updateJob(job("research", "Still running", "in flight").id, { status: "running", startedAt: at(1 * MIN) });
  store.writeOutput(runningJob.id, "SECRET RUNNING\n");
  fs.writeFileSync(path.join(store.dir, "outputs", "orphan1.md"), "SECRET ORPHAN\n");

  // A job whose worker also saved a self-contained HTML page beside the Markdown.
  htmlJob = store.updateJob(job("research", "Review with a page", "write a page beside it").id, { status: "done", finishedAt: at(5 * MIN) });
  store.writeOutput(htmlJob.id, "# Review\n\nSECRET MARKDOWN\n");
  fs.writeFileSync(path.join(store.dir, "outputs", `${htmlJob.id}.html`), SAVED_HTML);

  const built = buildApp({ messenger, runner, store });
  scheduler = built.scheduler;
  queue = built.jobs;
  await new Promise<void>((r) => (server = built.app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Signed in as Paul would be: set the password through the class, then the real sign-in route.
  signIn.setPassword(store, PASSWORD);
  const signedIn = await fetch(`${base}${SIGN_IN_PATH}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  });
  session = (signedIn.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0];
  if (!session) throw new Error(`the reports test could not sign in: ${signedIn.status}`);
});

after(() => {
  scheduler.stopAll();
  server.close();
});

test("the token is minted once, kept in the store, and accepted only when it matches exactly", () => {
  const token = reportsToken(store);
  assert.ok(token.length >= 20);
  assert.equal(reportsToken(store), token, "the same link every time, so it can be bookmarked");
  assert.equal(store.settings().reportsToken, token);
  assert.notEqual(token, store.settings().jobsBoardToken, "its own token, never the jobs board's");
  assert.ok(reportsTokenValid(store, token));
  assert.ok(!reportsTokenValid(store, ""));
  assert.ok(!reportsTokenValid(store, token.slice(0, -1)));
  assert.ok(!reportsTokenValid(store, `${token}x`));
  assert.match(reportsUrl(store), new RegExp(`^https?://[^/]+${REPORTS_PATH}\\?t=${token}$`), "the link carries the token in the query string");
});

test("the view sits behind the sign-in: signed out it sends him to sign in, signed in it opens, and both pages can sign out", async () => {
  const token = reportsToken(store);
  // Signed out: not the content and not a 404 — the sign-in page, carrying the page he asked for.
  const out = await fetch(`${base}${REPORTS_PATH}?t=${token}`, { redirect: "manual" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), `${SIGN_IN_PATH}?next=${encodeURIComponent(`${REPORTS_PATH}?t=${token}`)}`);
  const outOne = await fetch(`${base}${REPORTS_PATH}/${reportJob.id}?t=${token}`, { redirect: "manual" });
  assert.equal(outOne.status, 303, "one report is gated too");
  // The token alone is no longer enough: with the session, it still is what opens the page.
  assert.equal((await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=${token}`)).status, 200);
  // Both pages offer a way out.
  const index = await (await get(`${base}${REPORTS_PATH}?t=${token}`)).text();
  const one = await (await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=${token}`)).text();
  for (const html of [index, one]) assert.match(html, new RegExp(`<a href="${SIGN_OUT_PATH}">Sign out</a>`), "a Sign out link");
});

test("the index is served only with the token, is never cached, and cannot be written to", async () => {
  assert.equal((await get(`${base}${REPORTS_PATH}`)).status, 404);
  assert.equal((await get(`${base}${REPORTS_PATH}?t=not-the-token`)).status, 404);
  const token = reportsToken(store);
  const ok = await get(`${base}${REPORTS_PATH}?t=${token}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
  assert.match(ok.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(ok.headers.get("x-content-type-options") ?? "", /nosniff/);
  const html = await ok.text();
  assert.match(html, /name="viewport"/, "reads on a phone");
  assert.match(html, /Saved reports/);
  assert.match(html, /Deep codebase review/);
  assert.match(html, /TollBit research/);
  assert.match(html, /href="\/reports\/[A-Za-z0-9_-]+\?t=/, "each report is linked with the token");
  // Read only: no route of any other method exists, so nothing on the view can act.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await get(`${base}${REPORTS_PATH}?t=${token}`, { method })).status, 404, `${method} is not a route`);
    assert.equal((await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=${token}`, { method })).status, 404, `${method} is not a route`);
  }
});

test("the index lists saved outputs newest first, with title, kind, London date and id", () => {
  const entries = reportEntries(store);
  assert.deepEqual(entries.map((e) => e.id), [reportJob.id, htmlJob.id, olderJob.id], "only what the outputs publisher would copy, newest first");
  const first = entries[0];
  assert.equal(first.title, "Deep codebase review");
  assert.equal(first.kind, "research");
  assert.equal(first.date, londonYmd(new Date(at(1 * MIN))));
  assert.equal(first.id, reportJob.id);
  assert.equal(first.html, false);
  assert.equal(entries.find((e) => e.id === htmlJob.id)!.html, true, "a saved .html page is marked");
  const html = renderReportsIndex(entries, "token");
  assert.match(html, new RegExp(reportJob.id));
  assert.match(html, /research/);
  assert.match(html, /href="\/reports\/[A-Za-z0-9_-]+\?t=token"/);
});

test("the assistant, CV and upload-derived outputs, a running job and a job with no output are never served", async () => {
  const token = reportsToken(store);
  for (const job of [eaJob, cvJob, uploadJob, noOutputJob, runningJob]) {
    assert.equal(reportFor(store, job.id), undefined, `${job.kind} output must not be served`);
    assert.equal((await get(`${base}${REPORTS_PATH}/${job.id}?t=${token}`)).status, 404);
  }
  assert.equal(reportFor(store, "orphan1"), undefined, "an output with no job record cannot be classified");
  const index = await (await get(`${base}${REPORTS_PATH}?t=${token}`)).text();
  for (const id of [eaJob.id, cvJob.id, uploadJob.id, runningJob.id]) assert.ok(!index.includes(id), `${id} must not be linked`);
  assert.ok(!index.includes("orphan1"));
});

test("one report renders as a page: headings, paragraphs, lists, tables, code and links", async () => {
  const token = reportsToken(store);
  const res = await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /<h1>Deep review<\/h1>/);
  assert.match(html, /<h2>Findings<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/page" rel="noopener noreferrer">link<\/a>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>first finding/);
  assert.match(html, /<ol>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table><thead><tr><th>Repo<\/th><th>Tests<\/th><th>Note<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>clear-ops<\/td>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /<hr>/);
  assert.match(html, /All reports/, "a way back to the index");
  assert.match(html, new RegExp(reportJob.id));
});

test("raw HTML and a script in a saved output are shown as text and never become markup", async () => {
  const token = reportsToken(store);
  const html = await (await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=${token}`)).text();
  assert.ok(!/<script/i.test(html), "a script tag in an output must never be markup");
  assert.ok(!/<div/i.test(html), "raw HTML in an output must never be markup");
  assert.match(html, /&#60;script&#62;alert\(&#34;SECRET SCRIPT&#34;\)&#60;\/script&#62;/, "it is shown, escaped");
  assert.match(html, /&#60;div onclick=&#34;SECRET\(\)&#34;&#62;SECRET HTML&#60;\/div&#62;/, "an event attribute stays text");
  assert.ok(!html.includes('<script>alert("SECRET SCRIPT")</script>'), "the raw tag is never in the response");
  // The fenced block keeps its own characters, escaped, inside <pre><code>.
  assert.match(html, /const risky = &#34;&#60;script&#62;alert\(1\)&#60;\/script&#62;&#34;;/);
});

test("a report whose own heading is its title is not headed twice, and nothing else is changed", () => {
  const strip = (md: string, title: string) => renderReportPage({ id: "aaaaa1", title, kind: "research", date: "2026-11-14", at: "2026-11-14T09:00:00.000Z", html: false }, md, "token");
  const once = strip("# Deep codebase review\n\nThe findings.\n", "Deep codebase review");
  assert.equal((once.match(/<h1>Deep codebase review<\/h1>/g) ?? []).length, 1, "the title is the page's heading once");
  assert.match(once, /<h1>Deep codebase review<\/h1>/);
  assert.match(once, /The findings\./);
  // A different opening heading is the report's own and stays.
  const both = strip("# Something else entirely\n\nBody.\n", "Deep codebase review");
  assert.match(both, /<h1>Deep codebase review<\/h1>/);
  assert.match(both, /<h1>Something else entirely<\/h1>/);
  assert.equal(dropRepeatedTitle("# Something else\n\nBody.\n", "Deep codebase review"), "# Something else\n\nBody.\n");
  assert.equal(dropRepeatedTitle("# Deep codebase review\n\nBody.\n", "Deep codebase review"), "\nBody.\n");
});

test("the Markdown renderer: a link that is not http(s) or mailto is left as plain text", () => {
  const html = renderMarkdown("[click](javascript:alert(1))\n\n[mail](mailto:paul@example.com)\n\n![picture](https://example.com/x.png)\n");
  assert.ok(!html.includes(`href="javascript`), "a javascript: address never becomes a link");
  assert.match(html, /<a href="mailto:paul@example\.com" rel="noopener noreferrer">mail<\/a>/);
  assert.ok(!/<img/i.test(html), "nothing in an output is ever turned into an image request");
  assert.match(html, /click/);
});

test("a self-contained .html page saved beside the Markdown is served as-is, and the Markdown is not", async () => {
  const token = reportsToken(store);
  const res = await get(`${base}${REPORTS_PATH}/${htmlJob.id}?t=${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/, "the saved page cannot run a script");
  assert.ok(!/script-src[^;]*unsafe/.test(csp), "no exception for scripts anywhere in the policy");
  assert.match(res.headers.get("x-content-type-options") ?? "", /nosniff/);
  const html = await res.text();
  assert.equal(html, SAVED_HTML, "the saved page, served directly");
  assert.ok(!html.includes("SECRET MARKDOWN"), "the Markdown is not rendered when a page was saved beside it");
});

test("an empty or oversize saved .html falls back to the rendered Markdown rather than being served", async () => {
  const token = reportsToken(store);
  const empty = store.createJob("research", "Empty page", PAUL, "self", undefined, { title: "Empty page" });
  store.updateJob(empty.id, { status: "done", finishedAt: at(6 * MIN) });
  store.writeOutput(empty.id, "# Empty page\n\nFallback body.\n");
  fs.writeFileSync(path.join(store.dir, "outputs", `${empty.id}.html`), "");
  const res = await get(`${base}${REPORTS_PATH}/${empty.id}?t=${token}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>Empty page<\/h1>/, "the Markdown is rendered instead");
  assert.equal(reportFor(store, empty.id)!.entry.html, false);
});

test("a report page is reached only through the token, and an id that is not a saved output is refused", async () => {
  const token = reportsToken(store);
  assert.equal((await get(`${base}${REPORTS_PATH}/${reportJob.id}`)).status, 404);
  assert.equal((await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=wrong`)).status, 404);
  assert.equal((await get(`${base}${REPORTS_PATH}/../../../state.json?t=${token}`)).status, 404);
  assert.equal((await get(`${base}${REPORTS_PATH}/..%2Fstate.json?t=${token}`)).status, 404);
  assert.equal((await get(`${base}${REPORTS_PATH}/state.json?t=${token}`)).status, 404);
  const refused = await (await get(`${base}${REPORTS_PATH}/${reportJob.id}?t=wrong`)).text();
  assert.ok(!refused.includes("wrong"), "the refused page never echoes the token");
  assert.ok(!refused.includes(token));
});

test("the index shows metadata only: no output text, brief or personal file name reaches it", async () => {
  const token = reportsToken(store);
  const res = await get(`${base}${REPORTS_PATH}?t=${token}`);
  const html = await res.text();
  for (const text of ["SECRET SCRIPT", "SECRET HTML", "SECRET MAIL", "SECRET CV", "SECRET CONTACTS", "SECRET ORPHAN", "jo@example.com", "SECRET MARKDOWN", "Connections.csv"]) {
    assert.ok(!html.includes(text), `the index leaked: ${text}`);
  }
  const entries = JSON.stringify(reportEntries(store));
  assert.ok(!entries.includes("SECRET"), "no saved output text is read into the entry list");
});

test("the view holds no script, no cookie, no form and no third-party request", () => {
  const page = renderReportsIndex([], "token");
  assert.match(page, /<meta name="viewport"/, "laid out for a phone");
  assert.ok(!/<script/i.test(page));
  assert.ok(!/<iframe|<form|document\.cookie|<link |<img /i.test(page));
  assert.ok(!/(?:src|href)="https?:\/\//.test(page), "the index fetches nothing from anywhere");
  assert.ok(!/script-src[^;]*unsafe/.test(PAGE_CSP), "the pages the service renders allow no script either");
  // A saved page is sandboxed as well as script-less.
  assert.match(FILE_CSP, /sandbox/);
  assert.match(FILE_CSP, /default-src 'none'/);
});
