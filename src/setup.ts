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
 * - One install per repository and `package-lock.json`, kept in a store on the data volume, outside
 *   every checkout. The store is named after both, so the three managed repositories do not evict
 *   each other's stores.
 * - A working copy that has none is given the store's tree by hard links, which costs no disk and
 *   almost no time, so a job starts with its dependencies already there.
 * - A lock around the store, so two jobs never write one at the same time.
 * - The npm cache the workers use, so the install that does happen downloads nothing twice.
 * - These are shared, so the volume can fill. The store is the size of this repository's tree (about
 *   700MB), so the guard is size-aware: it needs the measured size of a store (or `SETUP_STORE_MB`
 *   for the first one) plus `SETUP_MIN_FREE_MB` free before it writes anything, it gives up the npm
 *   cache before it refuses, it removes a store it has just built if the volume still fell below the
 *   floor, and it keeps no more stores than `SETUP_KEEP` and the free space can afford.
 *
 * Nothing here may break a job. Every path that fails (no room, an install that did not finish, a
 * filesystem that cannot hard-link) falls back to exactly what happened before: the worker installs
 * what it needs itself. The store never deletes a working copy's own `node_modules`.
 *
 * The tree in a store is hard-linked, not copied, so a worker that writes inside its own
 * `node_modules` writes the store every later job links. Workers are told not to (BUILD_TEST_DISCIPLINE
 * in src/agents.ts); nothing stronger is worth a hash of 11,000 files on every job.
 */
export interface SetupOptions {
  /** The data volume: the store and the npm cache live here, outside every checkout. */
  root?: string;
  /** Keep at least this much of the volume free, in MB, after whatever we are about to write. */
  minFreeMb?: number;
  /** What one store is assumed to need, in MB, until this volume has measured one. */
  storeMb?: number;
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

/**
 * A store's directory name: the repository it is for, then the lockfile. Two repositories sharing a
 * volume therefore never evict each other's store, and two lockfiles of one repository stay apart.
 */
export function storeName(repo: string | undefined, key: string): string {
  const slug = (repo ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug ? `${slug}-${key}` : key;
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

/** Megabytes a directory tree actually occupies, in disk blocks, following no symlink out of it. */
export function treeMb(dir: string): number {
  let blocks = 0;
  const walk = (p: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      try {
        const st = fs.lstatSync(child);
        if (st.isSymbolicLink()) continue;
        blocks += st.blocks ? Number(st.blocks) : Math.ceil(Number(st.size) / 512);
      } catch {
        // Something else is removing it; it does not matter to the estimate.
      }
    }
  };
  walk(dir);
  return Math.ceil((blocks * 512) / (1024 * 1024));
}

/**
 * The environment npm is given.
 *
 * Not the service's own environment: a dependency's install script (esbuild's postinstall today,
 * anything a future lockfile brings) runs inside `npm ci`, and it must not be able to read
 * `VAULT_KEY`, the Google or GitHub keys. Only what npm needs to run, plus proxy settings, and the
 * development-mode variables of `workerBuildEnv`.
 */
export const INSTALLER_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "LANG",
  "LC_ALL",
  "CI",
  "SHELL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function installerEnv(source: NodeJS.ProcessEnv, cacheDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INSTALLER_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...workerBuildEnv(cacheDir) };
}

/**
 * The npm settings a worker needs to build and test what it wrote.
 *
 * The service itself runs with NODE_ENV=production (Dockerfile), and npm follows it: `npm ci` then
 * installs the runtime packages only, so `tsc` and `tsx` are missing and every build and test fails.
 * A worker's own installs are development installs, so it gets NODE_ENV=development and an explicit
 * --include=dev, plus the shared cache when the volume has room for one. Only the kinds that build
 * get this, and only for their run (src/jobs.ts), not every worker and not the chief.
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
  /** True when the lock directory exists and is not older than the stale window. */
  private static fresh(dir: string, now: number, staleMs: number): boolean {
    try {
      return now - fs.statSync(dir).mtimeMs <= staleMs;
    } catch {
      return false;
    }
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

  /** True when some other process is inside the lock directory right now. */
  static isFresh(dir: string, staleMs = 30 * 60_000): boolean {
    return DirLock.fresh(dir, Date.now(), staleMs);
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

/** The default install: `npm ci` in the store, with the shared cache and nothing else of ours. */
async function npmCi(dir: string, cacheDir: string): Promise<void> {
  await exec("npm", ["ci", "--include=dev", "--no-audit", "--no-fund", "--cache", cacheDir], {
    cwd: dir,
    timeout: 15 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
    env: installerEnv(process.env, cacheDir),
  });
}

/** The default link: hard links (no disk, no copy), falling back to a real copy when that is refused. */
async function hardLink(from: string, to: string, copy: boolean): Promise<void> {
  await exec("cp", copy ? ["-a", from, to] : ["-al", from, to], { timeout: 10 * 60_000 });
}

/** What a store build did: ready, no room to write it, an install that failed, or one removed again. */
type BuildOutcome = "ready" | "no-room" | "failed" | "removed";

export class PreparedCopies {
  private readonly root: string;
  private readonly minFreeMb: number;
  private readonly storeMb: number;
  private readonly waitMs: number;
  private readonly keep: number;
  private readonly npmCacheDir: string;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly free: (dir: string) => number;
  private readonly install: (dir: string, cacheDir: string) => Promise<void>;
  private readonly link: (from: string, to: string, copy: boolean) => Promise<void>;
  /** What a store on this volume has been measured to need; undefined until one is known. */
  private measuredMb: number | undefined;

  constructor(opts: SetupOptions = {}) {
    this.root = opts.root ?? config.setup.dir;
    this.minFreeMb = opts.minFreeMb ?? config.setup.minFreeMb;
    this.storeMb = opts.storeMb ?? config.setup.storeMb;
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

  private get locks() {
    return path.join(this.root, "locks");
  }

  /** The npm cache to give a worker, or undefined when there is no room for one. */
  npmCache(): string | undefined {
    if (!this.enabled || !this.npmCacheDir) return undefined;
    if (this.free(path.dirname(this.npmCacheDir)) < this.minFreeMb) return undefined;
    return this.npmCacheDir;
  }

  /**
   * Gives `dir` the dependencies its lockfile calls for, when they are already installed elsewhere.
   * `repo` is the repository the working copy belongs to, so its store is not the one another
   * repository's jobs evict. Returns what happened; a job carries on regardless.
   */
  async prepare(dir: string, repo?: string): Promise<Prepared> {
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
    const store = path.join(this.stores, storeName(repo, key));
    if (!this.fill(store)) {
      // The size of the tree this would write, not a flat number, and checked here as well as under
      // the lock so a refusal writes nothing at all, not even a lock directory.
      if (!this.roomFor(this.neededMb())) this.pruneCache(`${key}.lock`);
      if (!this.roomFor(this.neededMb())) return { status: "skipped", detail: this.noRoomDetail() };
      const outcome = await this.build(key, store, dir);
      if (outcome === "no-room") return { status: "skipped", detail: this.noRoomDetail() };
      if (outcome === "removed") {
        return { status: "failed", detail: "the store was removed again because the volume was nearly full after installing it" };
      }
      if (outcome === "failed") return { status: "failed", detail: "the shared install did not finish; the worker installs its own" };
    }
    const how = await this.materialise(path.join(store, "node_modules"), modules, key);
    if (!how) return { status: "failed", detail: "the shared install could not be copied into the working copy" };
    await this.housekeeping(store).catch(() => undefined);
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

  /** What one store costs on this volume: what a store here measured, else the configured estimate. */
  private neededMb(): number {
    if (this.measuredMb !== undefined) return this.measuredMb;
    let measured: number | undefined;
    try {
      for (const entry of fs.readdirSync(this.stores)) {
        const store = path.join(this.stores, entry);
        if (!fs.existsSync(path.join(store, "node_modules"))) continue;
        const size = this.recordedMb(store) ?? treeMb(path.join(store, "node_modules"));
        measured = Math.max(measured ?? 0, size);
      }
    } catch {
      // No stores yet on this volume: the estimate below is what we have.
    }
    if (measured !== undefined && measured > 0) this.measuredMb = measured;
    return measured && measured > 0 ? measured : this.storeMb;
  }

  private recordedMb(store: string): number | undefined {
    try {
      const ready = JSON.parse(fs.readFileSync(path.join(store, "ready"), "utf8")) as { mb?: unknown };
      return typeof ready.mb === "number" && ready.mb > 0 ? Math.ceil(ready.mb) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether the volume can take a store of `mb` megabytes and still keep the floor free. */
  private roomFor(mb: number): boolean {
    return this.free(this.root) >= this.minFreeMb + mb;
  }

  private noRoomDetail(): string {
    return `only ${this.free(this.root)}MB free on the data volume, and a store needs about ${this.neededMb()}MB more than the ${this.minFreeMb}MB floor`;
  }

  /** Installs the store for a lockfile, once, under a lock. */
  private async build(key: string, store: string, dir: string): Promise<BuildOutcome> {
    const lockName = `${key}.lock`;
    const lock = new DirLock(path.join(this.locks, lockName), { now: this.now });
    if (!(await lock.acquire(this.waitMs))) {
      // Another job is still installing it: whoever we are, we do our own rather than wait longer.
      this.log(`timed out waiting for the shared install of ${key}; leaving this job to install its own`);
      return "failed";
    }
    try {
      if (this.fill(store)) return "ready";
      // The size of the tree this is about to write, not a flat number: at 500MB free the store of
      // this repository cannot fit, and filling the volume leaves nowhere for the store, the job
      // outputs and the sessions to be written.
      if (!this.roomFor(this.neededMb())) {
        // The cache is only worth what it saves; give it up before refusing to install.
        this.pruneCache(lockName);
        if (!this.roomFor(this.neededMb())) return "no-room";
      }
      fs.mkdirSync(store, { recursive: true, mode: 0o700 });
      for (const f of ["package.json", "package-lock.json", ".npmrc"]) {
        if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(store, f));
      }
      // An install that will not fit is refused a page in the cache too, so the estimate above is
      // about the tree alone and the cache can never grow past what the volume has room for.
      const cache = this.npmCache() ?? path.join(this.root, "npm-cache");
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      await this.install(store, cache);
      const mb = treeMb(path.join(store, "node_modules"));
      this.measuredMb = Math.max(this.measuredMb ?? 0, mb);
      fs.writeFileSync(path.join(store, "ready"), `${JSON.stringify({ key, at: new Date(this.now()).toISOString(), mb })}\n`, { mode: 0o600 });
      if (this.free(this.root) < this.minFreeMb) {
        // Other writers filled the volume while we installed (or the estimate was low): what we just
        // built is the biggest thing we own, so it goes, and the cache with it. The worker installs
        // its own, as it did before.
        this.pruneCache(lockName);
        this.remove(store, "removed the store it had just built because the volume was nearly full");
        return "removed";
      }
      return "ready";
    } catch (err) {
      this.log(`shared install of ${key} failed (${err instanceof Error ? err.message.slice(0, 200) : "error"}); the worker installs its own`);
      // A half-finished tree is of no use to anyone and only takes up room.
      try {
        fs.rmSync(path.join(store, "node_modules"), { recursive: true, force: true });
      } catch {
        // Nothing more to do: without `ready` it is never used.
      }
      return "failed";
    } finally {
      lock.release();
    }
  }

  /** Hard-links (or copies) a prepared tree into the working copy, and marks which lockfile it is for. */
  private async materialise(from: string, to: string, key: string): Promise<"linked" | "copied" | undefined> {
    for (const copy of [false, true]) {
      try {
        await this.link(from, to, copy);
        const marker = path.join(to, ".clear-ops-lock");
        try {
          fs.writeFileSync(marker, `${JSON.stringify({ key })}\n`, { mode: 0o600 });
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

  /**
   * Housekeeping, best effort and never in a job's way: the store in use is always kept, the others
   * go once `SETUP_KEEP` or the free space says so, and the npm cache goes with them.
   */
  private async housekeeping(keepStore: string): Promise<void> {
    const lock = new DirLock(path.join(this.locks, "prune.lock"), { now: this.now });
    if (!(await lock.acquire(2_000))) return;
    try {
      let removed = false;
      let entries: string[];
      try {
        entries = fs.readdirSync(this.stores);
      } catch {
        return;
      }
      const stores = entries
        .filter((e) => e !== path.basename(keepStore))
        .map((e) => ({ name: e, at: this.mtimeOf(path.join(this.stores, e)) }))
        .sort((a, b) => b.at - a.at);
      let kept = 0;
      for (const store of stores) {
        // Keeping a store is only worth it while the volume can still take the next install.
        if (kept < this.keep - 1 && this.roomFor(this.neededMb())) {
          kept += 1;
          continue;
        }
        removed = this.remove(path.join(this.stores, store.name), `removed the old dependency store ${store.name}`) || removed;
      }
      if (removed || this.free(this.root) < this.minFreeMb) this.pruneCache("prune.lock");
    } finally {
      lock.release();
    }
  }

  private remove(dir: string, message: string): boolean {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.log(message);
      return true;
    } catch {
      // It will be removed next time; never fail a job over housekeeping.
      return false;
    }
  }

  /**
   * Bounds the npm cache, which otherwise keeps every tarball it has ever fetched on a volume that
   * is the service's only disk. Only our own cache directory, only when the volume is tight, and
   * never while another job is installing from it.
   */
  private pruneCache(except: string): boolean {
    if (!this.enabled || !this.npmCacheDir) return false;
    const dir = path.resolve(this.npmCacheDir);
    // Only a cache we own: strictly inside the setup directory or the data directory, never the
    // directory itself, so a mis-set NPM_CACHE_DIR cannot have a whole tree deleted.
    const inside = (base: string) => dir !== base && dir.startsWith(`${base}${path.sep}`);
    if (!inside(path.resolve(this.root)) && !inside(path.resolve(config.dataDir))) return false;
    if (this.installing(except)) return false;
    if (!fs.existsSync(dir)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.log(`removed the shared npm cache (${dir}) to keep the data volume free`);
      return true;
    } catch {
      return false;
    }
  }

  /** True when another install is running right now, so nothing it is reading may be deleted. */
  private installing(except: string): boolean {
    try {
      return fs
        .readdirSync(this.locks)
        .some((entry) => entry !== except && entry.endsWith(".lock") && DirLock.isFresh(path.join(this.locks, entry), this.staleMs()));
    } catch {
      return false;
    }
  }

  private staleMs(): number {
    // The same window DirLock takes a lock over: a lock older than this is not a running install.
    return 30 * 60_000;
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
