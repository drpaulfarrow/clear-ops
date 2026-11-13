import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

/**
 * Prepared working copies: the install-and-compile phase every engineering job used to repeat.
 *
 * Every engineer and maintainer works in its own copy of a repository (the checkout, then a git
 * worktree beside it), and each one used to install the dependencies from scratch, so a machine
 * running two jobs downloaded and unpacked the same tree twice at once and the tests of one job
 * fought the other job's install for four shared cores. Instead:
 *
 * - One install per `package-lock.json`, kept in a store on the data volume, outside every checkout.
 * - A working copy that has none is given the store's tree by hard links, which costs no disk and
 *   almost no time, so a job starts with its dependencies already there.
 * - A lock around the store, so two jobs never write one at the same time.
 * - The npm cache the workers use, so the install that does happen downloads nothing twice.
 * - These are shared, so the volume can fill: nothing is written when it has too little free space,
 *   and only the two newest stores are kept.
 *
 * Nothing here may break a job. Every path that fails (no room, an install that did not finish, a
 * filesystem that cannot hard-link) falls back to exactly what happened before: the worker installs
 * what it needs itself. The store never deletes a working copy's own `node_modules`.
 */
export interface SetupOptions {
  /** The data volume: the store and the npm cache live here, outside every checkout. */
  root?: string;
  /** Keep at least this much of the volume free, in MB; below it nothing is written. */
  minFreeMb?: number;
  /** How long a job waits for another job already preparing the same lockfile. */
  waitMs?: number;
  /** Lockfile stores to keep besides the one in use, newest first. */
  keep?: number;
  /** Where the worker's npm cache lives (an empty string turns the cache off). */
  npmCacheDir?: string;
  /** Whether any of this happens at all. */
  enabled?: boolean;
  now?: () => number;
  log?: (m: string) => void;
  /** Free megabytes on the filesystem holding a path. Injectable so tests need no volume. */
  freeMb?: (dir: string) => number;
  /** The install itself. Injectable so tests never reach the network. */
  install?: (dir: string, cacheDir: string) => Promise<void>;
  /** Links (or, on failure, copies) a prepared tree. Injectable for tests. */
  link?: (from: string, to: string, copy: boolean) => Promise<void>;
}

/** What happened to a working copy's dependencies. */
export type PrepareStatus = "present" | "linked" | "copied" | "skipped" | "failed";

export interface Prepared {
  status: PrepareStatus;
  /** One short line saying why, for the log and for what the worker is told. */
  detail?: string;
  /** The store the tree came from, when it was reused. */
  from?: string;
}

/** Lifecycle scripts and workspaces need the whole checkout, not just the lockfile: leave those alone. */
const OWN_TREE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublishOnly", "prepack"];

/**
 * True when a directory's dependencies can be installed from its manifest and lockfile alone, in a
 * folder of their own. A workspace install or a lifecycle script could need the repository itself,
 * so it is left to the worker exactly as before.
 */
export function installableAlone(dir: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): boolean {
  try {
    const pkg = JSON.parse(readFile(path.join(dir, "package.json"))) as Record<string, unknown>;
    if (pkg.workspaces) return false;
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    return !OWN_TREE_SCRIPTS.some((s) => typeof scripts[s] === "string" && (scripts[s] as string).trim() !== "");
  } catch {
    // No manifest, or one that will not parse: not a directory we can prepare on its own.
    return false;
  }
}

/** The key a lockfile's store is named after: its own bytes, so a changed lockfile is a new store. */
export function lockfileKey(lockfile: Buffer | string): string {
  return crypto.createHash("sha256").update(lockfile).digest("hex").slice(0, 16);
}

/** Free megabytes where a path lives, found by walking up to something that exists. */
export function freeMb(dir: string): number {
  let p = path.resolve(dir);
  for (;;) {
    try {
      const s = fs.statfsSync(p);
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    } catch {
      const up = path.dirname(p);
      if (up === p) return Number.POSITIVE_INFINITY;
      p = up;
    }
  }
}

/**
 * The npm settings a worker needs to build and test what it wrote.
 *
 * The service itself runs with NODE_ENV=production (Dockerfile), and npm follows it: `npm ci` then
 * installs the runtime packages only, so `tsc` and `tsx` are missing and every build and test fails.
 * A worker's own installs are development installs, so it gets NODE_ENV=development and an explicit
 * --include=dev, plus the shared cache when the volume has room for one.
 */
export function workerBuildEnv(cache: string | undefined): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    npm_config_include: "dev",
    ...(cache ? { npm_config_cache: cache, npm_config_prefer_offline: "true" } : {}),
  };
}

/** What a worker is told about the working copy it starts in. Never claims more than actually happened. */
export function setupNote(p: Prepared, dir: string): string {
  const lead = "Dependencies:";
  if (p.status === "linked" || p.status === "copied") {
    return `${lead} ${dir}/node_modules is already installed for this exact package-lock.json (reused, so there is no download and no install to wait for). Do not run npm ci or npm install unless you change package.json or package-lock.json. npm run build and npm test work as they are.`;
  }
  if (p.status === "present" && p.detail === "ready") {
    return `${lead} node_modules is already installed in ${dir}. Do not run npm ci or npm install unless you change package.json or package-lock.json. npm run build and npm test work as they are.`;
  }
  if (p.status === "present") {
    return `${lead} ${dir}/node_modules exists but I could not confirm it matches package-lock.json. Try npm run build and npm test first; if either fails on a missing module, run npm ci once.`;
  }
  return "";
}

/** Waits for the lock by polling; the deadline is the caller's. */
const POLL_MS = 250;

/**
 * A lock another process can see: making a directory is atomic, so the first writer wins and the
 * others poll. One left behind by a killed process is taken over once it is older than `staleMs`.
 * Exported so the concurrency guard is tested on its own.
 */
export class DirLock {
  private held = false;
  constructor(
    private readonly dir: string,
    private readonly opts: { staleMs?: number; pollMs?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private wait(ms: number) {
    return (this.opts.wait ?? ((m: number) => new Promise((r) => setTimeout(r, m))))(ms);
  }

  /** True once this process holds it. Waits up to `waitMs`, and never waits for ever. */
  async acquire(waitMs: number): Promise<boolean> {
    const stale = this.opts.staleMs ?? 30 * 60_000;
    const deadline = this.now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(path.dirname(this.dir), { recursive: true });
        // Not recursive: an existing lock must be EEXIST, which is the whole point of mkdir here.
        fs.mkdirSync(this.dir);
        fs.writeFileSync(path.join(this.dir, "owner"), `${process.pid} ${new Date(this.now()).toISOString()}\n`, { mode: 0o600 });
        this.held = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const age = this.now() - this.mtime();
      if (age > stale) {
        // The holder is gone: take it over rather than wait for ever.
        try {
          fs.rmSync(this.dir, { recursive: true, force: true });
        } catch {
          // Another waiter got there first; loop and try to take it.
        }
        continue;
      }
      if (this.now() >= deadline) return false;
      await this.wait(Math.min(this.opts.pollMs ?? POLL_MS, Math.max(1, deadline - this.now())));
    }
  }

  private mtime(): number {
    try {
      return fs.statSync(this.dir).mtimeMs;
    } catch {
      return this.now();
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // A lock that cannot be removed goes stale and is taken over; never fail a job over it.
    }
  }
}

/** The default install: `npm ci` in the store, with the shared cache. */
async function npmCi(dir: string, cacheDir: string): Promise<void> {
  await exec("npm", ["ci", "--include=dev", "--no-audit", "--no-fund", "--cache", cacheDir], {
    cwd: dir,
    timeout: 15 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...workerBuildEnv(cacheDir) },
  });
}

/** The default link: hard links (no disk, no copy), falling back to a real copy when that is refused. */
async function hardLink(from: string, to: string, copy: boolean): Promise<void> {
  await exec("cp", copy ? ["-a", from, to] : ["-al", from, to], { timeout: 10 * 60_000 });
}

export class PreparedCopies {
  private readonly root: string;
  private readonly minFreeMb: number;
  private readonly waitMs: number;
  private readonly keep: number;
  private readonly npmCacheDir: string;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly free: (dir: string) => number;
  private readonly install: (dir: string, cacheDir: string) => Promise<void>;
  private readonly link: (from: string, to: string, copy: boolean) => Promise<void>;

  constructor(opts: SetupOptions = {}) {
    this.root = opts.root ?? config.setup.dir;
    this.minFreeMb = opts.minFreeMb ?? config.setup.minFreeMb;
    this.waitMs = opts.waitMs ?? config.setup.waitMs;
    this.keep = opts.keep ?? config.setup.keep;
    this.npmCacheDir = opts.npmCacheDir ?? config.setup.npmCacheDir;
    this.enabled = opts.enabled ?? config.setup.enabled;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.free = opts.freeMb ?? freeMb;
    this.install = opts.install ?? npmCi;
    this.link = opts.link ?? hardLink;
  }

  private get stores() {
    return path.join(this.root, "deps");
  }

  /** The npm cache to give a worker, or undefined when there is no room for one. */
  npmCache(): string | undefined {
    if (!this.enabled || !this.npmCacheDir) return undefined;
    if (this.free(path.dirname(this.npmCacheDir)) < this.minFreeMb) return undefined;
    return this.npmCacheDir;
  }

  /**
   * Gives `dir` the dependencies its lockfile calls for, when they are already installed elsewhere.
   * Returns what happened; a job carries on regardless.
   */
  async prepare(dir: string): Promise<Prepared> {
    if (!this.enabled) return { status: "skipped", detail: "reuse is off (SETUP=off)" };
    const lockfile = path.join(dir, "package-lock.json");
    if (!fs.existsSync(lockfile) || !fs.existsSync(path.join(dir, "package.json"))) return { status: "skipped", detail: "no package-lock.json" };
    const modules = path.join(dir, "node_modules");
    if (fs.existsSync(modules)) {
      // Never touch a working copy's own install: it may belong to a job using the same checkout.
      return { status: "present", detail: this.matches(modules, lockfile) ? "ready" : "unknown" };
    }
    if (!installableAlone(dir)) return { status: "skipped", detail: "workspaces or install scripts: left to the worker" };

    const key = lockfileKey(fs.readFileSync(lockfile));
    const store = path.join(this.stores, key);
    if (!this.fill(store)) {
      const free = this.free(this.root);
      if (free < this.minFreeMb) return { status: "skipped", detail: `only ${free}MB free on the data volume` };
      if (!(await this.build(key, store, dir))) return { status: "failed", detail: "the shared install did not finish; the worker installs its own" };
    }
    const how = await this.materialise(path.join(store, "node_modules"), modules);
    if (!how) return { status: "failed", detail: "the shared install could not be copied into the working copy" };
    await this.prune(key).catch(() => undefined);
    this.log(`prepared ${dir}: node_modules ${how === "linked" ? "linked" : "copied"} from the shared store`);
    return { status: how, from: store };
  }

  /** True when the store holds a complete tree for that key. */
  private fill(store: string): boolean {
    return fs.existsSync(path.join(store, "ready")) && fs.existsSync(path.join(store, "node_modules"));
  }

  /** True when node_modules was linked here for this lockfile by an earlier job. */
  private matches(modules: string, lockfile: string): boolean {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(modules, ".clear-ops-lock"), "utf8")) as { key?: string };
      return marker.key === lockfileKey(fs.readFileSync(lockfile));
    } catch {
      return false;
    }
  }

  /** Installs the store for a lockfile, once, under a lock. False when it did not finish. */
  private async build(key: string, store: string, dir: string): Promise<boolean> {
    const lock = new DirLock(path.join(this.root, "locks", `${key}.lock`), { now: this.now });
    if (!(await lock.acquire(this.waitMs))) {
      // Another job is still installing it: whoever we are, we do our own rather than wait longer.
      this.log(`timed out waiting for the shared install of ${key}; leaving this job to install its own`);
      return false;
    }
    try {
      if (this.fill(store)) return true;
      fs.mkdirSync(store, { recursive: true, mode: 0o700 });
      for (const f of ["package.json", "package-lock.json", ".npmrc"]) {
        if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(store, f));
      }
      const cache = this.npmCache() ?? path.join(this.root, "npm-cache");
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      await this.install(store, cache);
      fs.writeFileSync(path.join(store, "ready"), `${JSON.stringify({ key, at: new Date(this.now()).toISOString() })}\n`, { mode: 0o600 });
      return true;
    } catch (err) {
      this.log(`shared install of ${key} failed (${err instanceof Error ? err.message.slice(0, 200) : "error"}); the worker installs its own`);
      // A half-finished tree is of no use to anyone and only takes up room.
      try {
        fs.rmSync(path.join(store, "node_modules"), { recursive: true, force: true });
      } catch {
        // Nothing more to do: without `ready` it is never used.
      }
      return false;
    } finally {
      lock.release();
    }
  }

  /** Hard-links (or copies) a prepared tree into the working copy, and marks which lockfile it is for. */
  private async materialise(from: string, to: string): Promise<"linked" | "copied" | undefined> {
    for (const copy of [false, true]) {
      try {
        await this.link(from, to, copy);
        const key = path.join(to, ".clear-ops-lock");
        try {
          fs.writeFileSync(key, `${JSON.stringify({ key: path.basename(path.dirname(from)) })}\n`, { mode: 0o600 });
        } catch {
          // The marker is only what a later job reads to decide whether to trust the tree.
        }
        return copy ? "copied" : "linked";
      } catch {
        try {
          fs.rmSync(to, { recursive: true, force: true });
        } catch {
          // Leave whatever is there for the next attempt.
        }
      }
    }
    return undefined;
  }

  /** Keeps the store in use and the newest ones, and removes older stores for lockfiles nobody needs. */
  private async prune(keepKey: string): Promise<void> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.stores);
    } catch {
      return;
    }
    const stores = entries
      .filter((e) => e !== keepKey)
      .map((e) => ({ name: e, at: this.mtimeOf(path.join(this.stores, e)) }))
      .sort((a, b) => b.at - a.at);
    for (const store of stores.slice(Math.max(0, this.keep - 1))) {
      try {
        fs.rmSync(path.join(this.stores, store.name), { recursive: true, force: true });
        this.log(`removed the old dependency store ${store.name}`);
      } catch {
        // It will be removed next time; never fail a job over housekeeping.
      }
    }
  }

  private mtimeOf(p: string): number {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/** The one instance the service uses. Tests build their own. */
export const preparedCopies = new PreparedCopies();

/** The npm settings for a worker run (src/agents.ts). */
export function setupWorkerEnv(): NodeJS.ProcessEnv {
  return workerBuildEnv(preparedCopies.npmCache());
}
