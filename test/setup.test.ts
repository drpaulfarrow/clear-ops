/**
 * Reused installs (src/setup.ts): one npm ci per package-lock.json, hard-linked into each working
 * copy, with a lock so two jobs never install into the store at once, a free-space guard so a nearly
 * full volume is left alone, and a note that only ever says what actually happened. Plus the
 * review's documentation-only fast path (scripts/test-changed.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-setup-"));
// A product checkout the tests control, so a job's working copy is a real directory.
process.env.REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-setup-repo-"));

const { DirLock, PreparedCopies, installableAlone, lockfileKey, freeMb, setupNote, workerBuildEnv } = await import("../src/setup.js");
const { docsOnly, reviewPlan } = await import("../scripts/test-changed.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunResult } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-setup-"));

/** A directory that looks like a checkout: a manifest and a lockfile, and nothing installed. */
function project(pkg: Record<string, unknown> = {}): string {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "example", version: "1.0.0", ...pkg }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify({ name: "example", lockfileVersion: 3, ...pkg }, null, 2)}\n`);
  return dir;
}

const boom = async () => {
  throw new Error("should not be called");
};

/** A stand-in for npm ci: it writes the tree the real one would. */
function installer(log: string[]) {
  return async (dir: string) => {
    log.push(path.basename(dir));
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "left-pad.js"), "module.exports = 1;\n");
  };
}

/** A stand-in for the hard-link (or copy) of a prepared tree. */
const linker = (how: "link" | "fail") => async (from: string, to: string) => {
  if (how === "fail") throw new Error("no hard links here");
  fs.cpSync(from, to, { recursive: true });
};

test("the lockfile decides the store: the same bytes reuse it, a change makes a new one", () => {
  const a = lockfileKey('{"lockfileVersion":3}');
  assert.equal(a, lockfileKey('{"lockfileVersion":3}'));
  assert.notEqual(a, lockfileKey('{"lockfileVersion":3,"packages":{}}'));
  assert.equal(a.length, 16);
});

test("only a manifest npm can install from the lockfile alone is prepared", () => {
  assert.equal(installableAlone(project()), true);
  assert.equal(installableAlone(project({ scripts: { test: "node --test" } })), true);
  assert.equal(installableAlone(project({ scripts: { postinstall: "node scripts/x.js" } })), false);
  assert.equal(installableAlone(project({ workspaces: ["packages/*"] })), false);
  assert.equal(installableAlone(tmp()), false, "a directory with no manifest is left alone");
});

test("a working copy with no node_modules gets the store's tree, and the store is installed once", async () => {
  const root = tmp();
  const installs: string[] = [];
  const copies = new PreparedCopies({ root, minFreeMb: 1, freeMb: () => 10_000, install: installer(installs), link: linker("link") });
  const first = await copies.prepare(project());
  assert.equal(first.status, "linked");
  assert.equal(installs.length, 1);
  assert.ok(first.from);

  const second = await copies.prepare(project());
  assert.equal(second.status, "linked");
  assert.equal(installs.length, 1, "the second working copy reuses the store instead of installing again");
  assert.equal(second.from, first.from);
});

test("a working copy that already has node_modules is never touched, and is recognised when it is ours", async () => {
  const root = tmp();
  const copies = new PreparedCopies({ root, minFreeMb: 1, freeMb: () => 10_000, install: installer([]), link: linker("link") });
  const dir = project();
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "theirs.js"), "x");
  const unknown = await copies.prepare(dir);
  assert.equal(unknown.status, "present");
  assert.equal(unknown.detail, "unknown", "an install we did not make is not claimed as matching the lockfile");
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "theirs.js")));

  const fresh = project();
  assert.equal((await copies.prepare(fresh)).status, "linked");
  const again = await copies.prepare(fresh);
  assert.equal(again.status, "present");
  assert.equal(again.detail, "ready", "a tree we linked for this lockfile is known to match it");
});

test("nothing is written when the volume has too little free space", async () => {
  const copies = new PreparedCopies({ root: tmp(), minFreeMb: 300, freeMb: () => 5, install: boom, link: boom });
  const dir = project();
  const p = await copies.prepare(dir);
  assert.equal(p.status, "skipped");
  assert.match(p.detail ?? "", /only 5MB free/);
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
});

test("a directory with no lockfile, and the off switch, do nothing at all", async () => {
  const copies = new PreparedCopies({ root: tmp(), freeMb: () => 10_000, install: boom, link: boom });
  assert.equal((await copies.prepare(tmp())).status, "skipped");
  const off = new PreparedCopies({ root: tmp(), enabled: false, freeMb: () => 10_000, install: boom, link: boom });
  assert.equal((await off.prepare(project())).status, "skipped");
  assert.equal(off.npmCache(), undefined);
});

test("an install that does not finish leaves the worker to install its own", async () => {
  const root = tmp();
  const copies = new PreparedCopies({
    root,
    freeMb: () => 10_000,
    install: async (dir: string) => {
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      throw new Error("npm said no");
    },
    link: linker("link"),
  });
  const dir = project();
  const p = await copies.prepare(dir);
  assert.equal(p.status, "failed");
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
  const store = path.join(root, "deps", fs.readdirSync(path.join(root, "deps"))[0]);
  assert.equal(fs.existsSync(path.join(store, "ready")), false, "a half-finished install is never used");
  assert.equal(fs.existsSync(path.join(store, "node_modules")), false, "and its remains are removed");
});

test("a filesystem that cannot hard-link still gets a copy", async () => {
  const root = tmp();
  const installs: string[] = [];
  let links = 0;
  const copies = new PreparedCopies({
    root,
    freeMb: () => 10_000,
    install: installer(installs),
    link: async (from, to, copy) => {
      links += 1;
      if (!copy) throw new Error("cross-device link");
      fs.cpSync(from, to, { recursive: true });
    },
  });
  const dir = project();
  const p = await copies.prepare(dir);
  assert.equal(p.status, "copied");
  assert.equal(links, 2, "it tried the hard link first");
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "left-pad.js")));
});

test("only the newest dependency stores are kept", async () => {
  const root = tmp();
  const copies = new PreparedCopies({ root, keep: 2, freeMb: () => 10_000, install: installer([]), link: linker("link") });
  const dirs = [project({ version: "1.0.0" }), project({ version: "1.0.1" }), project({ version: "1.0.2" })];
  for (const d of dirs) await copies.prepare(d);
  const stores = fs.readdirSync(path.join(root, "deps"));
  assert.equal(stores.length, 2, "the store in use and one spare");
  assert.ok(stores.includes(lockfileKey(fs.readFileSync(path.join(dirs[2], "package-lock.json")))), "the store in use is never removed");
});

test("the install lock lets one writer in at a time, and is taken over when it is stale", async () => {
  const dir = path.join(tmp(), "lock");
  const a = new DirLock(dir, { now: () => 0 });
  const b = new DirLock(dir, { now: () => 0, wait: async () => {} });
  assert.equal(await a.acquire(10), true);
  assert.equal(await b.acquire(0), false, "a second job waits and gives up rather than installing at the same time");
  a.release();
  assert.equal(await b.acquire(10), true);
  b.release();
  assert.equal(fs.existsSync(dir), false, "the lock is gone once it is released");

  // A lock left behind by a killed process must not block the store for ever.
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(dir, old, old);
  const c = new DirLock(dir);
  assert.equal(await c.acquire(1_000), true);
  c.release();
});

test("a worker is told only what actually happened", () => {
  assert.match(setupNote({ status: "linked", from: "/data/setup/deps/abc" }, "/w"), /already installed for this exact package-lock\.json/);
  assert.match(setupNote({ status: "copied" }, "/w"), /already installed for this exact package-lock\.json/);
  assert.match(setupNote({ status: "present", detail: "ready" }, "/w"), /node_modules is already installed in \/w/);
  assert.match(setupNote({ status: "present" }, "/w"), /could not confirm/);
  assert.equal(setupNote({ status: "failed" }, "/w"), "");
  assert.equal(setupNote({ status: "skipped" }, "/w"), "");
});

test("a worker's npm installs are development installs, from the shared cache", () => {
  const env = workerBuildEnv("/data/setup/npm-cache");
  assert.equal(env.NODE_ENV, "development", "the service runs NODE_ENV=production, which would leave tsc and tsx out of the install");
  assert.equal(env.npm_config_include, "dev");
  assert.equal(env.npm_config_cache, "/data/setup/npm-cache");
  assert.equal(env.npm_config_prefer_offline, "true");
  assert.equal(workerBuildEnv(undefined).npm_config_cache, undefined);
});

test("free space is read from the volume a path is on", () => {
  const free = freeMb(tmp());
  assert.ok(Number.isFinite(free) && free >= 0);
  assert.equal(freeMb("/no/such/path/anywhere/at/all"), freeMb("/"), "an unknown path falls back to the filesystem root");
});

test("a review runs the suite unless every changed file is documentation", () => {
  assert.equal(docsOnly(["README.md", "docs/WORKFORCE.md", "notes.txt"]), true);
  assert.equal(docsOnly([]), false, "an empty diff is never a reason to skip");
  assert.equal(docsOnly(["README.md", "src/jobs.ts"]), false);
  assert.equal(docsOnly(["test/setup.test.ts"]), false);
  assert.equal(docsOnly([".github/workflows/deploy.yml"]), false);
  assert.equal(docsOnly(["package-lock.json"]), false);

  const dir = tmp();
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  sh("init", "-b", "main", ".");
  fs.writeFileSync(path.join(dir, "README.md"), "one\n");
  sh("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one");
  fs.writeFileSync(path.join(dir, "NOTES.md"), "two\n");
  const docs = reviewPlan(dir);
  assert.equal(docs.docsOnly, true);
  assert.deepEqual(docs.files, ["NOTES.md"]);
  fs.writeFileSync(path.join(dir, "src.ts"), "export const x = 1;\n");
  const code = reviewPlan(dir);
  assert.equal(code.docsOnly, false);
  assert.ok(code.files.includes("src.ts"));
});

test("an engineering job's worker is told the dependencies are already installed", async () => {
  const checkout = project();
  const root = tmp();
  const installs: string[] = [];
  const copies = new PreparedCopies({ root, freeMb: () => 10_000, install: installer(installs), link: linker("link") });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-setup-store-")));
  const prompts: string[] = [];
  const runner: AgentRunner = async (o): Promise<RunResult> => {
    prompts.push(o.systemPrompt ?? "");
    return { text: "done" };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner, undefined, { setup: copies });
  // config.repoDir is the directory the tests set as REPO_DIR; make it the prepared checkout.
  const { config } = await import("../src/config.js");
  fs.cpSync(checkout, config.repoDir, { recursive: true });

  jobs.start("engineer", "Speed up setup", FOUNDER, "product");
  for (let i = 0; i < 800 && !prompts.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(prompts.length, "the worker ran");
  assert.match(prompts[0], /Dependencies: .*node_modules is already installed/);
  assert.ok(fs.existsSync(path.join(config.repoDir, "node_modules", "left-pad.js")), "the working copy was prepared before the worker started");
});
