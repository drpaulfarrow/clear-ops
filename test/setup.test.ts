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

const { DirLock, PreparedCopies, installableAlone, installerEnv, lockfileKey, freeMb, setupNote, storeName, treeMb, workerBuildEnv } =
  await import("../src/setup.js");
const { docsOnly, reviewPlan } = await import("../scripts/test-changed.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunOptions, RunResult } from "../src/agents.js";

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

test("the guard is the size of the tree, not a flat number", async () => {
  // 1000MB free, but a store needs about 900MB and the floor is 300MB. The old flat guard passed
  // here and the install then filled the volume this machine keeps its store, outputs and sessions on.
  const root = path.join(tmp(), "setup");
  const flat = new PreparedCopies({ root, minFreeMb: 300, storeMb: 900, freeMb: () => 1_000, install: boom, link: boom });
  const refused = await flat.prepare(project(), "self");
  assert.equal(refused.status, "skipped");
  assert.match(refused.detail ?? "", /only 1000MB free .*needs about 900MB/);
  assert.equal(fs.existsSync(root), false, "nothing is written at all when the tree would not fit, not even a lock directory");

  // A store measured on this volume is what the next job's guard uses, not the estimate.
  const store = path.join(root, "deps", storeName("self", "0123456789abcdef"));
  fs.mkdirSync(path.join(store, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(store, "ready"), JSON.stringify({ key: "0123456789abcdef", at: new Date().toISOString(), mb: 500 }));
  const tight = new PreparedCopies({ root, minFreeMb: 300, storeMb: 900, freeMb: () => 700, install: boom, link: boom });
  const p = await tight.prepare(project(), "self");
  assert.equal(p.status, "skipped");
  assert.match(p.detail ?? "", /needs about 500MB/, "the measured size of a store, not the 900MB estimate");

  const roomy = new PreparedCopies({ root, minFreeMb: 300, storeMb: 900, freeMb: () => 900, install: installer([]), link: linker("link") });
  const built = await roomy.prepare(project(), "self");
  assert.equal(built.status, "linked", "900MB free does fit a 500MB store on top of the 300MB floor");
  const ready = JSON.parse(fs.readFileSync(path.join(built.from as string, "ready"), "utf8")) as { mb?: number };
  assert.ok((ready.mb ?? 0) > 0, "the size of a store is recorded when it is built");
  assert.ok(treeMb(path.join(built.from as string, "node_modules")) >= 1, "and a tree is measured in the disk blocks it takes");
});

test("a store built on a volume that is full afterwards is removed again, and the cache with it", async () => {
  const root = tmp();
  const cache = path.join(root, "npm-cache");
  const logs: string[] = [];
  let free = 10_000;
  const copies = new PreparedCopies({
    root,
    npmCacheDir: cache,
    minFreeMb: 300,
    storeMb: 900,
    freeMb: () => free,
    log: (m) => logs.push(m),
    // The install fills the cache as it goes, and other jobs fill the volume with it.
    install: async (dir: string) => {
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, "tarball.tgz"), "x".repeat(1_000));
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "left-pad.js"), "module.exports = 1;\n");
      free = 100;
    },
    link: linker("link"),
  });
  const dir = project();
  const p = await copies.prepare(dir, "self");
  assert.equal(p.status, "failed");
  assert.match(p.detail ?? "", /removed again because the volume was nearly full/);
  assert.equal(fs.existsSync(path.join(root, "deps", storeName("self", lockfileKey(fs.readFileSync(path.join(dir, "package-lock.json")))))), false, "the store it just built is gone");
  assert.equal(fs.existsSync(cache), false, "and so is the cache that came with it");
  assert.ok(logs.some((m) => /just built because the volume was nearly full/.test(m)), "and the log says so");
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, "the worker is left to install for itself");
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

test("a store belongs to a repository, so the three managed ones do not evict each other", async () => {
  const root = tmp();
  const copies = new PreparedCopies({ root, keep: 4, freeMb: () => 10_000, install: installer([]), link: linker("link") });
  const keys: Record<string, string> = {};
  for (const repo of ["self", "product", "site"]) {
    const dir = project({ name: repo });
    keys[repo] = lockfileKey(fs.readFileSync(path.join(dir, "package-lock.json")));
    assert.equal((await copies.prepare(dir, repo)).status, "linked");
  }
  const stores = fs.readdirSync(path.join(root, "deps")).sort();
  assert.deepEqual(stores, [storeName("product", keys.product), storeName("self", keys.self), storeName("site", keys.site)].sort());
  assert.equal(storeName(undefined, "abc"), "abc", "a working copy with no repository keeps the plain lockfile name");
  assert.equal(storeName("Paul's Site", "abc"), "paul-s-site-abc", "a name is nothing but a safe directory name");
});

test("the npm cache is bounded: given up when the volume is tight, and never under a running install", async () => {
  const root = tmp();
  const cache = path.join(root, "npm-cache");
  const fill = () => {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "tarball.tgz"), "x".repeat(100));
  };

  // No room for the store: the tarballs go first, and only then is the install refused.
  fill();
  const logs: string[] = [];
  const tight = new PreparedCopies({ root, npmCacheDir: cache, minFreeMb: 300, storeMb: 900, freeMb: () => 400, install: boom, link: boom, log: (m) => logs.push(m) });
  assert.equal((await tight.prepare(project(), "self")).status, "skipped");
  assert.equal(fs.existsSync(cache), false, "the cache is given up before the install is refused");
  assert.ok(logs.some((m) => /removed the shared npm cache/.test(m)));
  assert.equal(new PreparedCopies({ root, npmCacheDir: cache, minFreeMb: 300, freeMb: () => 100 }).npmCache(), undefined, "and a worker is not handed one when the volume is below the floor");

  // Pruning a store prunes the cache with it.
  const copies = new PreparedCopies({ root, npmCacheDir: cache, keep: 1, minFreeMb: 300, storeMb: 900, freeMb: () => 10_000, install: installer([]), link: linker("link") });
  for (const v of ["1.0.0", "1.0.1"]) await copies.prepare(project({ version: v }), "self");
  fill();
  await copies.prepare(project({ version: "1.0.2" }), "self");
  assert.equal(fs.existsSync(cache), false, "the cache of tarballs nobody will need again goes with the store");

  // But not while another job is installing: its tarballs are in there.
  fill();
  fs.mkdirSync(path.join(root, "locks", "someone-else.lock"), { recursive: true });
  await copies.prepare(project({ version: "1.0.3" }), "self");
  assert.equal(fs.existsSync(cache), true, "a running install's cache is left alone");

  // And never a directory we do not own: outside the setup and data directories nothing is deleted.
  const elsewhere = path.join(tmp(), "npm-cache");
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "not-ours.txt"), "keep me");
  const strange = new PreparedCopies({ root: tmp(), npmCacheDir: elsewhere, minFreeMb: 300, storeMb: 900, freeMb: () => 400, install: boom, link: boom });
  assert.equal((await strange.prepare(project(), "self")).status, "skipped");
  assert.ok(fs.existsSync(path.join(elsewhere, "not-ours.txt")), "a directory outside our own is never removed, however it is configured");
});

test("the installer gets the environment npm needs and none of the service's secrets", () => {
  const env = installerEnv(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      CI: "true",
      VAULT_KEY: "vault",
      GOOGLE_CLIENT_SECRET: "google",
      GOOGLE_TOKEN_KEY: "token",
      TELEGRAM_BOT_TOKEN: "telegram",
      DISCORD_BOT_TOKEN: "discord",
      VOICE_KEY: "voice",
      GITHUB_APP_PRIVATE_KEY: "app-key",
      GH_TOKEN: "gh",
      ANTHROPIC_API_KEY: "anthropic",
      OPENROUTER_API_KEY: "openrouter",
      GODADDY_API_TOKEN: "godaddy",
      NPM_TOKEN: "npm",
      npm_config_registry: "https://example.invalid",
    },
    "/data/setup/npm-cache",
  );
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "LANG", "NODE_ENV", "PATH", "npm_config_cache", "npm_config_include", "npm_config_prefer_offline"]);
  assert.equal(env.PATH, "/usr/bin:/bin", "npm still runs, and finds its own tools");
  assert.equal(env.NODE_ENV, "development", "and installs the dev dependencies, as before");
  assert.equal(env.npm_config_cache, "/data/setup/npm-cache");
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
  assert.equal(docsOnly(["docs/install.sh"]), false, "a script under docs/ is not documentation");
  assert.equal(docsOnly(["docs/x.ts"]), false, "nor is a source file that happens to live there");
  assert.equal(docsOnly(["docs/tables.json"]), false);
  assert.equal(docsOnly(["CHANGELOG.rst", "adr/0001.md"]), true, "the extension decides, not the folder");
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
  const runs: RunOptions[] = [];
  const runner: AgentRunner = async (o): Promise<RunResult> => {
    runs.push(o);
    return { text: "done" };
  };
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner, undefined, { setup: copies });
  // config.repoDir is the directory the tests set as REPO_DIR; make it the prepared checkout.
  const { config } = await import("../src/config.js");
  fs.cpSync(checkout, config.repoDir, { recursive: true });

  jobs.start("engineer", "Speed up setup", FOUNDER, "product");
  for (let i = 0; i < 800 && !runs.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(runs.length, "the worker ran");
  assert.match(runs[0].systemPrompt, /Dependencies: .*node_modules is already installed/);
  assert.ok(fs.existsSync(path.join(config.repoDir, "node_modules", "left-pad.js")), "the working copy was prepared before the worker started");
  // The npm development-mode settings go to the kinds that build, not to every worker and not to the chief.
  assert.equal(runs[0].env?.NODE_ENV, "development");
  assert.equal(runs[0].env?.npm_config_include, "dev");
  assert.match(runs[0].env?.npm_config_cache ?? "", /npm-cache$/, "and the shared cache, when the volume has room for one");

  // The review of that pull request builds and tests too, so it gets them as well.
  const maintain = runs.find((r) => /the maintainer for Clear Exchange/.test(r.systemPrompt ?? ""));
  assert.ok(maintain, "the maintainer reviewed the engineer's pull request");
  assert.equal(maintain.env?.NODE_ENV, "development");

  jobs.start("write", "Summarise the notes", FOUNDER, "self");
  const writer = /the writer for Clear Exchange/;
  for (let i = 0; i < 800 && !runs.some((r) => writer.test(r.systemPrompt ?? "")); i += 1) await new Promise((r) => setTimeout(r, 10));
  const write = runs.find((r) => writer.test(r.systemPrompt ?? ""));
  assert.ok(write, "the write job ran");
  assert.equal(write.env, undefined, "a kind that does not build is given no npm settings at all");
});
