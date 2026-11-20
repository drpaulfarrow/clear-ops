/**
 * The web app's rail (docs/APP.md): the project spaces and who is on shift.
 *
 * Both are read off the same job cards the board shows, so neither can say something the board does
 * not. A space narrows the board's jobs and pull requests and nothing else: what waits on Paul's own
 * decision is never narrowed away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-rail-"));

const { Store } = await import("../src/store.js");
const { appBoard, appHistory } = await import("../src/app-data.js");
const { appAsset, appShell, appSignInPage, APP_CSP } = await import("../src/app-pages.js");
const { AGENT_NAMES } = await import("../src/messages.js");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const PAUL = "tg:99887766";
const PR = "https://github.com/drpaulfarrow/clear-ops/pull/108";

function world(o: { quiet?: string[]; held?: boolean; capReached?: boolean } = {}) {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-rail-store-")));
  const mk = (kind: string, title: string, target: string, patch: Record<string, unknown>) => s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, target as never, PAUL, { title } as never).id, patch as never);
  const quiet = new Set<string>(o.quiet ?? []);
  const queue = {
    isHeld: () => !!o.held,
    queuePosition: () => undefined,
    latestStep: () => undefined,
    liveness: (id: string) => (quiet.has(id) ? ({ id, status: "running", alive: false, summary: "stalled" } as never) : undefined),
    spendState: () => ({ usd: 1, source: "provider" as const, asOf: NOW }),
    capReached: () => !!o.capReached,
  };
  const board = () => appBoard({ store: s, queue, now: NOW });
  return { s, mk, quiet, board };
}

test("a space is a managed repository, with what is active there and what waits on Paul", () => {
  const { s, mk, board } = world();
  mk("engineer", "Running", "self", { status: "running", startedAt: at(5) });
  mk("engineer", "Queued", "self", { status: "queued" });
  const change = mk("engineer", "A change", "self", { status: "done", startedAt: at(60), finishedAt: at(50), pr: PR });
  const review = mk("maintain", "Review: A change", "self", { status: "done", startedAt: at(49), finishedAt: at(40), reviewOf: change.id });
  s.writeOutput(review.id, `REVIEW ${PR}: needs Paul: merge when ready`);
  mk("research", "Asks for him", "product", { status: "done", startedAt: at(30), finishedAt: at(20), claimed: { state: "needs_paul", detail: "which account to use" } });
  mk("research", "Plain", "product", { status: "done", startedAt: at(30), finishedAt: at(25) });
  mk("write", "Elsewhere", "an-old-alias", { status: "queued" });
  const spaces = board().spaces;
  const of = (id: string) => spaces.find((sp) => sp.id === id);
  assert.deepEqual(of("self"), { id: "self", name: "workforce", active: 2, waiting: 1, managed: true });
  assert.deepEqual(of("product"), { id: "product", name: "Clear Exchange", active: 0, waiting: 1, managed: true });
  // A repository with nothing happening is still a space, so it can be chosen before its first job.
  assert.deepEqual(of("site"), { id: "site", name: "drpaulfarrow.com", active: 0, waiting: 0, managed: true });
  // A card whose repository is not a managed one still has somewhere to be found.
  assert.equal(of("an-old-alias")!.active, 1);
  // It has no chat of its own, though: only a repository the service manages does.
  assert.equal(of("an-old-alias")!.managed, false);
  assert.equal(new Set(spaces.map((sp) => sp.id)).size, spaces.length, "each space once");
  // The counts are the board's own cards, so the rail never disagrees with it.
  for (const sp of spaces) {
    const mine = board().jobs.filter((j) => j.repository === sp.id);
    assert.equal(sp.active, mine.filter((j) => j.status === "running" || j.status === "queued").length);
    assert.equal(sp.waiting, mine.filter((j) => j.outcome?.state === "waiting").length);
  }
});

test("the roster says what each named worker is doing, and nothing the board does not show", () => {
  const line = (r: { name?: string; role: string; state: string; line: string }) => `${r.name ?? r.role}: ${r.state}: ${r.line}`;
  // Nothing in hand: the chief and the four named workers, idle.
  const empty = world().board().roster;
  assert.deepEqual(empty.map(line), ["Marlo: here: With you", "Fitz: idle: Idle", "Vera: idle: Idle", "Scout: idle: Idle", "Pip: idle: Idle"]);
  assert.deepEqual(empty.map((r) => r.name), [AGENT_NAMES.chief, AGENT_NAMES.engineer, AGENT_NAMES.maintain, AGENT_NAMES.research, AGENT_NAMES.design]);

  const w = world({ capReached: true });
  const building = w.mk("engineer", "Telemetry", "self", { status: "running", startedAt: at(5), pr: "https://github.com/drpaulfarrow/clear-ops/pull/111" });
  w.mk("engineer", "Second", "self", { status: "running", startedAt: at(2) });
  const change = w.mk("engineer", "A change", "self", { status: "done", startedAt: at(60), finishedAt: at(50), pr: PR });
  const review = w.mk("maintain", "Review: A change", "self", { status: "done", startedAt: at(49), finishedAt: at(40), reviewOf: change.id });
  w.s.writeOutput(review.id, `REVIEW ${PR}: needs Paul: merge when ready`);
  const held = w.mk("research", "Held one", "product", { status: "queued", capBlocked: true });
  const drawing = w.mk("design", "Homepage", "site", { status: "running", startedAt: at(40) });
  w.quiet.add(drawing.id);
  const writing = w.mk("write", "A memo", "product", { status: "queued" });
  const roster = w.board().roster;
  assert.deepEqual(roster.map(line), [
    "Marlo: here: With you",
    "Fitz: working: Building #111 and 1 more",
    // Reviewed and left for Paul is the maintainer's hand-off, not the engineer's wait.
    "Vera: waiting: Waiting on you: #108",
    "Scout: held: Held by the cap",
    "Pip: stuck: Gone quiet on Homepage",
    // A kind with no name of its own is on the roster only while it has work in hand.
    "writer: queued: Next up: A memo",
  ]);
  assert.deepEqual(roster.map((r) => r.jobId), [undefined, building.id, change.id, held.id, drawing.id, writing.id]);
  // Every job the roster points at is a card on the board.
  const ids = new Set(w.board().jobs.map((j) => j.id));
  for (const r of roster) if (r.jobId) assert.ok(ids.has(r.jobId));

  // Held without the cap: the queue is paused. And a worker that says it needs him waits under its own name.
  const p = world({ held: true });
  p.mk("engineer", "Paused", "self", { status: "queued" });
  p.mk("research", "Which account", "product", { status: "done", startedAt: at(30), finishedAt: at(20), claimed: { state: "needs_paul", detail: "which account to use" } });
  assert.deepEqual(p.board().roster.slice(1, 4).map(line), ["Fitz: held: Held until the queue is resumed", "Vera: idle: Idle", "Scout: waiting: Waiting on you: Which account"]);
});

test("the history can be read one space at a time", () => {
  const { s, mk } = world();
  for (let i = 0; i < 4; i++) mk("research", `Product ${i}`, "product", { status: "done", startedAt: at(100 + i * 10), finishedAt: at(95 + i * 10) });
  for (let i = 0; i < 3; i++) mk("engineer", `Self ${i}`, "self", { status: "done", startedAt: at(200 + i * 10), finishedAt: at(195 + i * 10) });
  const q = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: NOW }), capReached: () => false };
  const all = appHistory({ store: s, queue: q, now: NOW }, undefined);
  assert.equal(all.jobs.length, 7);
  const self = appHistory({ store: s, queue: q, now: NOW }, undefined, undefined, "self");
  assert.deepEqual(self.jobs.map((j) => j.repository), ["self", "self", "self"]);
  assert.equal(self.next, undefined);
  // A page at a time, within the space.
  const first = appHistory({ store: s, queue: q, now: NOW }, undefined, 2, "product");
  assert.deepEqual(first.jobs.map((j) => j.title), ["Product 0", "Product 1"]);
  const second = appHistory({ store: s, queue: q, now: NOW }, first.next, 2, "product");
  assert.deepEqual(second.jobs.map((j) => j.title), ["Product 2", "Product 3"]);
  assert.deepEqual(appHistory({ store: s, queue: q, now: NOW }, undefined, undefined, "nowhere").jobs, []);
  // The route takes a space only in the shape of an alias.
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /typeof req\.query\.space === "string" && \/\^\[A-Za-z0-9\._-\]\{1,64\}\$\/\.test\(req\.query\.space\) \? req\.query\.space : undefined/);
});

test("narrowing the board to a space never hides what waits on Paul's decision", () => {
  const js = fs.readFileSync("public/app/app.js", "utf8");
  // The narrowed board is the whole board with two lists replaced: its jobs and its pull requests.
  assert.match(js, /const scoped = \(board\) => \(spaceOf\(\) \? \{ \.\.\.board, jobs: board\.jobs\.filter\(\(j\) => j\.repository === state\.space\), pulls: \(board\.pulls \?\? \[\]\)\.filter\(\(p\) => p\.repo === state\.space\) \} : board\);/);
  assert.doesNotMatch(js, /waiting: board\.waiting\.filter/);
  // The chat's own waiting items are drawn from the board as it arrived, not the narrowed one.
  const chatItems = js.slice(js.indexOf("function chatItems()"), js.indexOf("const seen = (() => {"));
  assert.doesNotMatch(chatItems, /scoped\(/);
  // A space the board no longer lists is forgotten, so a stale choice cannot leave the board empty.
  assert.match(js, /if \(state\.space && !\(state\.board\.spaces \?\? \[\]\)\.some\(\(sp\) => sp\.id === state\.space\)\) \{ state\.space = "";/);
  // The rail is drawn only with what the board sent, as text.
  const rail = js.slice(js.indexOf("function rail(board)"), js.indexOf("/* ---------- Board views ---------- */"));
  assert.doesNotMatch(rail, /innerHTML|rendered\(/);
});

test("in a space the chat on screen is that space's own, and decisions stay where they were", () => {
  const js = fs.readFileSync("public/app/app.js", "utf8");
  // Only a managed repository has a chat; any other space narrows the board and leaves the chat alone.
  assert.match(js, /const spaceChat = \(\) => \(state\.space && \(!state\.board \|\| spaceOf\(\)\?\.managed\) \? state\.space : ""\);/);
  assert.match(js, /const threadOnScreen = \(\) => \(spaceChat\(\) \? `space:\$\{spaceChat\(\)\}` : /);
  // What is sent and what is read both name the conversation on screen, so a reply cannot land in another.
  assert.match(js, /const where = threadOnScreen\(\);\s*const said = await postMessage\(\{ text, \.\.\.\(where \? \{ thread: where \} : \{\}\)/);
  assert.match(js, /const text = await getJson\(where \? `\/chat\?thread=\$\{encodeURIComponent\(where\)\}` : "\/chat"\);\s*if \(threadOnScreen\(\) !== where\) return false;/);
  // The things waiting on his decision are listed in the main conversation only, as before.
  assert.match(js, /const waiting = state\.own \|\| spaceChat\(\) \? \[\] : state\.board\?\.waiting \?\? \[\];/);
});

test("the app has an icon of its own, served from the fixed table of files", () => {
  for (const [name, type] of [["icon.svg", "image/svg+xml"], ["icon-32.png", "image/png"], ["icon-180.png", "image/png"]] as const) {
    const asset = appAsset(name);
    assert.ok(asset && asset.body.length > 100, name);
    assert.equal(asset.type, type);
  }
  const svg = appAsset("icon.svg")!.body.toString("utf8");
  assert.doesNotMatch(svg, /<script|href=|url\(|<foreignObject|on\w+=/i, "a drawing and nothing else");
  assert.deepEqual([...appAsset("icon-32.png")!.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  for (const page of [appShell(), appSignInPage({ enabled: true, login: "drpaulfarrow" })]) {
    assert.match(page, /<link rel="icon" href="\/app\/assets\/icon\.svg" type="image\/svg\+xml">/);
    assert.match(page, /<link rel="apple-touch-icon" href="\/app\/assets\/icon-180\.png">/);
  }
  assert.match(APP_CSP, /img-src 'self' data:/);
});
