/**
 * Project spaces of Paul's own (src/spaces.ts): a name, a chat, and some of the repositories the
 * service already manages. As much about what one cannot be as what it is: it names no repository the
 * registry does not hold, its id is never one he typed, and removing it removes no job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spaces-"));

const { Store } = await import("../src/store.js");
const { createSpace, updateSpace, removeSpace, spaceName, spaceRepos, inOwnSpace, ownSpaceAddress, SpaceError, OWN_SPACE_ID, SPACES_MAX, SPACE_NAME_MAX, SPACE_REPOS_MAX } = await import("../src/spaces.js");
const { appBoard, appHistory } = await import("../src/app-data.js");
const { isWebConversation } = await import("../src/web-chat.js");

const MANAGED = [{ alias: "product", name: "Clear Exchange" }, { alias: "self", name: "workforce" }, { alias: "site", name: "drpaulfarrow.com" }];
const fresh = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spaces-store-")));
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const PAUL = "tg:99887766";
const queue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: NOW }), capReached: () => false };

test("a space's name is his own words, tidied: one line, cut short, with no secret in it", () => {
  assert.equal(spaceName("  Launch   plan \n and more"), "Launch plan");
  assert.equal(spaceName("\n\n  Second line first\n"), "Second line first");
  for (const nothing of ["", "   ", "\n\n", undefined, null, 7, ["x"], {}]) assert.equal(spaceName(nothing), "", JSON.stringify(nothing));
  const long = spaceName("x".repeat(200));
  assert.equal(long.length, SPACE_NAME_MAX);
  assert.ok(long.endsWith("…"));
  const token = `ghp_${"a1B2".repeat(9)}`;
  assert.ok(!spaceName(`Deploy ${token}`).includes(token), "a token typed into a name is not kept");
});

test("a space takes only repositories the service manages, each once", () => {
  const managed = MANAGED.map((m) => m.alias);
  assert.deepEqual(spaceRepos(undefined, managed), []);
  assert.deepEqual(spaceRepos([], managed), []);
  assert.deepEqual(spaceRepos(["self", "site", "self"], managed), ["self", "site"]);
  for (const bad of ["self", [7], [null], ["nowhere"], ["self", "drpaulfarrow/clear-ops"], ["../self"], [["self"]], { 0: "self" }, Array(SPACE_REPOS_MAX + 1).fill("self")]) assert.equal(spaceRepos(bad, managed), undefined, JSON.stringify(bad));
});

test("making, changing and removing a space, and what is refused", () => {
  const s = fresh();
  const made = createSpace(s, { name: "Launch plan", repos: ["self", "site"] }, MANAGED, NOW);
  assert.match(made.id, OWN_SPACE_ID);
  assert.deepEqual(made, { id: made.id, name: "Launch plan", repos: ["self", "site"], createdAt: new Date(NOW).toISOString() });
  assert.deepEqual(s.spaces(), [made]);
  // Its chat is one of the app's own conversations, in the shape a repository's space has.
  assert.equal(ownSpaceAddress(made.id), `web:space:${made.id}`);
  assert.equal(isWebConversation(ownSpaceAddress(made.id)), true);
  // With no repositories at all: a subject of its own.
  const bare = createSpace(s, { name: "Reading list" }, MANAGED, NOW);
  assert.deepEqual(bare.repos, []);
  assert.notEqual(bare.id, made.id);

  const refused = (o: Record<string, unknown>, why: RegExp) => assert.throws(() => createSpace(s, o, MANAGED, NOW), (e: unknown) => e instanceof SpaceError && why.test(e.message), JSON.stringify(o));
  refused({}, /needs a name/);
  refused({ name: "   " }, /needs a name/);
  refused({ name: "launch PLAN" }, /already a space with that name/);
  refused({ name: "Workforce" }, /already a space with that name/);
  refused({ name: "Other", repos: ["nowhere"] }, /repositories ClearOps manages/);
  refused({ name: "Other", repos: "self" }, /repositories ClearOps manages/);
  assert.equal(s.spaces().length, 2, "nothing refused was kept");

  // Changing keeps its id and when it was made; a space may keep its own name.
  const next = updateSpace(s, made.id, { name: "Launch plan", repos: [] }, MANAGED)!;
  assert.deepEqual(next, { ...made, repos: [] });
  assert.equal(updateSpace(s, made.id, { name: "Launch", repos: ["product"] }, MANAGED)!.name, "Launch");
  assert.throws(() => updateSpace(s, made.id, { name: "Reading list" }, MANAGED), SpaceError);
  // No such space: not a repository's alias, not another shape.
  for (const bad of ["self", "own-00000000", "", undefined, 7, `web:space:${made.id}`]) {
    assert.equal(updateSpace(s, bad, { name: "X" }, MANAGED), undefined, JSON.stringify(bad));
    assert.equal(removeSpace(s, bad), undefined, JSON.stringify(bad));
  }
  assert.equal(removeSpace(s, made.id)!.id, made.id);
  assert.deepEqual(s.spaces().map((x) => x.name), ["Reading list"]);

  // Only so many are kept.
  const many = fresh();
  for (let i = 0; i < SPACES_MAX; i++) createSpace(many, { name: `Space ${i}` }, MANAGED, NOW);
  assert.throws(() => createSpace(many, { name: "One more" }, MANAGED, NOW), /Remove one first/);
  assert.equal(new Set(many.spaces().map((x) => x.id)).size, SPACES_MAX);
});

test("anything in the store's file that is not a space is left out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spaces-junk-"));
  const s = new Store(dir);
  s.setSpaces([{ id: "own-1a2b3c4d", name: "Kept", repos: ["self"], createdAt: at(1) }, { id: "self", name: "A repository's alias", repos: [], createdAt: at(1) }, { id: "own-XYZ", name: "Bad id", repos: [], createdAt: at(1) }, { id: "own-1a2b3c4e", name: "Bad repos", repos: [7] as never, createdAt: at(1) }]);
  assert.deepEqual(new Store(dir).spaces().map((x) => x.name), ["Kept"]);
});

test("a space of his own holds the jobs on its repositories and any started from its chat, and moves none", () => {
  const s = fresh();
  const mk = (kind: string, title: string, target: string, patch: Record<string, unknown>, replyTo?: string) => s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, target as never, replyTo ?? PAUL, { title } as never).id, patch as never);
  const space = createSpace(s, { name: "Launch plan", repos: ["site"] }, MANAGED, NOW);
  const here = ownSpaceAddress(space.id);
  const onRepo = mk("design", "On its repository", "site", { status: "running", startedAt: at(5) });
  const fromChat = mk("research", "Started from its chat", "product", { status: "queued" }, here);
  const elsewhere = mk("engineer", "Elsewhere", "self", { status: "queued" });
  const asks = mk("research", "Asks for him", "product", { status: "done", startedAt: at(30), finishedAt: at(20), claimed: { state: "needs_paul", detail: "which account" } }, here);
  assert.equal(inOwnSpace(space, s.getJob(onRepo.id)!, "site"), true);
  assert.equal(inOwnSpace(space, s.getJob(fromChat.id)!, "product"), true);
  assert.equal(inOwnSpace(space, s.getJob(elsewhere.id)!, "self"), false);

  const board = appBoard({ store: s, queue, now: NOW });
  const mine = board.spaces.find((sp) => sp.id === space.id)!;
  assert.deepEqual(mine, { id: space.id, name: "Launch plan", managed: true, own: true, repos: ["site"], active: 2, waiting: 1 });
  assert.equal(board.spaces.at(-1)!.id, space.id, "his own come after the repositories'");
  // A card says which of his spaces it was started from; its repository is unchanged.
  const card = (id: string) => board.jobs.find((j) => j.id === id)!;
  assert.deepEqual([card(fromChat.id).space, card(fromChat.id).repository], [space.id, "product"]);
  assert.equal(card(onRepo.id).space, undefined);
  assert.equal(card(elsewhere.id).space, undefined);
  // The repositories' own spaces count what they always did.
  assert.equal(board.spaces.find((sp) => sp.id === "product")!.active, 1);
  assert.equal(board.spaces.find((sp) => sp.id === "site")!.active, 1);

  // Its history goes by the same rule.
  mk("write", "Old, on its repository", "site", { status: "done", startedAt: at(900), finishedAt: at(890) });
  mk("write", "Old, elsewhere", "self", { status: "done", startedAt: at(800), finishedAt: at(790) });
  assert.deepEqual(appHistory({ store: s, queue, now: NOW }, undefined, undefined, space.id).jobs.map((j) => j.title), ["Asks for him", "Old, on its repository"]);

  // Removing it removes no job, and the cards simply stop saying they were started there.
  const before = appBoard({ store: s, queue, now: NOW }).jobs.length;
  removeSpace(s, space.id);
  const after = appBoard({ store: s, queue, now: NOW });
  assert.equal(after.jobs.length, before);
  assert.equal(after.spaces.some((sp) => sp.own), false);
  assert.equal(after.jobs.some((j) => j.space), false);
  assert.ok(s.getJob(asks.id));
});
