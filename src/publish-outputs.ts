import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { githubAuth } from "./github-auth.js";
import { londonYmd } from "./london.js";
import { classify, FOLDER_ORDER } from "./output-folders.js";
import { redact } from "./repos.js";
import type { Job, Store } from "./store.js";
import { jobTitle } from "./titles.js";

const exec = promisify(execFile);

/**
 * Publishes every finished job's saved output to a private GitHub repository as Markdown, so Paul can
 * read it in the GitHub mobile app. Only job outputs (the files in DATA_DIR/outputs) are ever read;
 * nothing from uploads, secrets or any checkout. Outputs can hold personal data, so nothing is pushed
 * unless GitHub says the repository is private right now. This is a convenience: every failure is
 * logged and swallowed, and a job never waits for it.
 */

export interface IndexEntry {
  id: string;
  title: string;
  kind: string;
  /** London date, YYYY-MM-DD. */
  date: string;
  /** ISO time used for ordering, newest first. */
  at: string;
  status: string;
  /** Path inside the repository, <folder>/<date>-<id>-<title>.md. */
  file: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const INDEX_JSON = "index.json";

export function slugify(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "output";
}

export function entryFor(job: Pick<Job, "id" | "title" | "brief" | "kind" | "status" | "createdAt" | "finishedAt">, folder = "outputs"): IndexEntry {
  const at = job.finishedAt ?? job.createdAt;
  const date = londonYmd(new Date(at));
  const title = jobTitle(job);
  return { id: job.id, title, kind: job.kind, date, at, status: job.status, file: `${folder}/${date}-${job.id}-${slugify(title)}.md` };
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/[\r\n]+/g, " ");

/** The index README: one table per folder, newest first, each row with a link. */
export function renderIndex(entries: IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const folderOf = (e: IndexEntry) => e.file.split("/")[0];
  const folders = [...new Set(sorted.map(folderOf))].sort((a, b) => (FOLDER_ORDER.indexOf(a) + 1 || 99) - (FOLDER_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const out = [
    "# clear-outputs",
    "",
    "Saved job outputs from the Clear Exchange workforce, in folders by type, newest first in each. Private: outputs can contain personal data, so assistant (ea) and CV outputs and anything derived from a file Paul uploaded are never copied here. This repository is written by the workforce service; do not edit it by hand.",
    "",
    "Folders: " + folders.map((f) => `[${f}](#${f}) (${sorted.filter((e) => folderOf(e) === f).length})`).join(", "),
    "",
  ];
  for (const f of folders) {
    out.push(`## ${f}`, "", "| Date | Id | Title | Kind | Output |", "| --- | --- | --- | --- | --- |");
    for (const e of sorted.filter((x) => folderOf(x) === f)) out.push(`| ${e.date} | ${e.id} | ${cell(e.title)} | ${e.kind} | [read](${e.file}) |`);
    out.push("");
  }
  return out.join("\n");
}

export type Fetch = typeof fetch;

export interface PublisherOptions {
  slug?: string;
  dir?: string;
  branch?: string;
  fetch?: Fetch;
  /** Makes sure the checkout exists and git is authorised. Defaults to bootstrap's prepareRepo. */
  prepare?: (slug: string, dir: string) => Promise<void>;
  /** Runs git in dir. Injected by tests. */
  git?: (dir: string, args: string[]) => Promise<string>;
  token?: () => Promise<string>;
  log?: (m: string) => void;
  /** Called once per distinct problem, with plain words for Paul. */
  onProblem?: (plain: string) => void;
}

const defaultGit = async (dir: string, args: string[]): Promise<string> => {
  try {
    return (await exec("git", args, { cwd: dir, maxBuffer: 20 * 1024 * 1024 })).stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(redact(e.stderr || e.message || String(err)).slice(0, 500));
  }
};

export class OutputsPublisher {
  private chain: Promise<unknown> = Promise.resolve();
  private privateUntil = 0;
  private told = "";
  /** Ids held back as personal this run, for the log and tests. */
  readonly excluded = new Set<string>();
  readonly slug: string;
  readonly dir: string;
  private readonly branch: string;
  private readonly o: PublisherOptions;

  constructor(private readonly store: Store, opts: PublisherOptions = {}) {
    this.o = opts;
    this.slug = opts.slug ?? config.outputsRepo;
    this.dir = opts.dir ?? path.join(config.reposDir, this.slug.split("/")[1] ?? "clear-outputs");
    this.branch = opts.branch ?? "main";
  }

  private log(m: string) {
    (this.o.log ?? console.warn)(`outputs repo: ${m}`);
  }

  private problem(plain: string) {
    this.log(plain);
    if (this.told !== plain) {
      this.told = plain;
      this.o.onProblem?.(plain);
    }
  }

  /** Queues the publication of one finished job. Returns at once and never throws. */
  publish(job: Job): void {
    this.enqueue([job]);
  }

  /** One-off: every output on disk, with its job record when there is one. Never throws. */
  backfill(): Promise<number> {
    const dir = path.join(this.store.dir, "outputs");
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return Promise.resolve(0);
    }
    const jobs: Job[] = [];
    for (const f of files) {
      const id = f.slice(0, -3);
      if (!ID.test(id)) continue;
      const known = this.store.getJob(id);
      if (known) {
        jobs.push(known);
        continue;
      }
      // An output whose job record is gone cannot be classified, so it is never copied.
      const t = fs.statSync(path.join(dir, f)).mtime.toISOString();
      jobs.push({ id, kind: "unknown", title: `Output ${id}`, brief: "", requestedBy: "", status: "done", createdAt: t, finishedAt: t } as unknown as Job);
    }
    return this.enqueue(jobs).then((n) => n);
  }

  private enqueue(jobs: Job[]): Promise<number> {
    const run = this.chain.then(() => this.pushJobs(jobs)).catch((err) => {
      this.log(`could not publish: ${redact(err instanceof Error ? err.message : String(err))}`);
      return 0;
    });
    this.chain = run;
    return run as Promise<number>;
  }

  /** True only when GitHub says the repository is private right now. Fails closed. */
  async isPrivate(): Promise<boolean> {
    if (Date.now() < this.privateUntil) return true;
    const doFetch = this.o.fetch ?? fetch;
    let token = "";
    try {
      token = await (this.o.token ?? (() => githubAuth.token()))();
    } catch {
      // handled below
    }
    if (!token) token = process.env.GH_TOKEN ?? "";
    try {
      const res = await doFetch(`https://api.github.com/repos/${this.slug}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "clear-ops" },
      });
      if (res.status === 404 || res.status === 403 || res.status === 401) {
        this.problem(`I cannot reach ${this.slug} with the GitHub token, so job outputs are not being copied there. Add ${this.slug} to the token's repository access (Contents read and write), or choose All repositories, then re-run the latest clear-ops deploy.`);
        return false;
      }
      const body = (await res.json()) as { private?: boolean };
      if (body.private !== true) {
        this.problem(`${this.slug} is not private, so I have stopped copying job outputs to it, because they can contain personal data. Make it private in its GitHub settings (Danger Zone, Change visibility) and I will carry on at the next finished job.`);
        return false;
      }
      this.privateUntil = Date.now() + 60 * 60 * 1000;
      this.told = "";
      return true;
    } catch (err) {
      this.log(`could not check visibility of ${this.slug}: ${redact(err instanceof Error ? err.message : String(err))}`);
      return false;
    }
  }

  private async pushJobs(jobs: Job[]): Promise<number> {
    if (!(await this.isPrivate())) return 0;
    const git = this.o.git ?? defaultGit;
    const prepare = this.o.prepare ?? (async (slug: string, dir: string) => (await import("./bootstrap.js")).prepareRepo(slug, dir));
    await prepare(this.slug, this.dir);
    await git(this.dir, ["pull", "--no-rebase", "--quiet", "origin", this.branch]).catch((err) => this.log(`pull failed: ${err.message}`));

    const indexFile = path.join(this.dir, INDEX_JSON);
    let entries: IndexEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(indexFile, "utf8")) as IndexEntry[];
    } catch {
      // first run
    }
    let written = 0;
    let removed = 0;
    for (const job of jobs) {
      if (!ID.test(job.id)) continue;
      const text = this.store.readOutput(job.id);
      if (text === undefined) continue;
      const verdict = classify(job, text);
      if ("excluded" in verdict) {
        // Never copied; and if an earlier version of this service already copied it, take it out of the tree.
        const old = entries.find((e) => e.id === job.id);
        if (old) {
          fs.rmSync(path.join(this.dir, old.file), { force: true });
          entries = entries.filter((e) => e.id !== job.id);
          removed++;
        }
        this.excluded.add(job.id);
        continue;
      }
      const entry = entryFor(job, verdict.folder);
      const old = entries.find((e) => e.id === entry.id);
      if (old && old.file !== entry.file) fs.rmSync(path.join(this.dir, old.file), { force: true });
      fs.mkdirSync(path.join(this.dir, verdict.folder), { recursive: true });
      const body = `# ${entry.title}\n\n_${entry.kind} job ${entry.id}, ${entry.date}, ${entry.status}_\n\n---\n\n${redact(text)}\n`;
      fs.writeFileSync(path.join(this.dir, entry.file), body);
      entries = [...entries.filter((e) => e.id !== entry.id), entry];
      written++;
    }
    if (!written && !removed) return 0;
    fs.writeFileSync(indexFile, JSON.stringify(entries, null, 2) + "\n");
    fs.writeFileSync(path.join(this.dir, "README.md"), renderIndex(entries));
    await git(this.dir, ["add", "-A", "."]);
    const status = (await git(this.dir, ["status", "--porcelain"])).trim();
    if (!status) return 0;
    const label = jobs.length === 1 ? `output of job ${jobs[0].id}` : `${written} job outputs`;
    await git(this.dir, ["commit", "--quiet", "-m", `docs: add ${label}`]);
    try {
      await git(this.dir, ["push", "--quiet", "origin", `HEAD:${this.branch}`]);
    } catch {
      await git(this.dir, ["pull", "--no-rebase", "--quiet", "origin", this.branch]);
      await git(this.dir, ["push", "--quiet", "origin", `HEAD:${this.branch}`]);
    }
    return written;
  }
}

/** The backfill runs once per layout: this setting records which one has run. */
export const LAYOUT = "folders-v1";

/** Runs once per layout: copies every output into its folder and takes out what must not be there. */
export async function backfillOnce(store: Store, publisher: OutputsPublisher): Promise<void> {
  if (store.settings().outputsBackfilled === LAYOUT) return;
  const n = await publisher.backfill();
  if (n > 0) store.setSetting("outputsBackfilled", LAYOUT);
}
