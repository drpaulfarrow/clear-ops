import path from "node:path";
import { config } from "./config.js";
import { githubAuth } from "./github-auth.js";
import type { Store } from "./store.js";

/**
 * The repositories the workforce manages. "product" (Clear Exchange) and "self" (this workforce) are
 * always the first two and keep their own settings (PRODUCT_REPO, SELF_REPO, REPO_DIR, SELF_REPO_DIR).
 * More come from MANAGED_REPOS (default: Paul's personal site, alias "site", and app-doubleshift, alias
 * "doubleshift") and from repositories the workforce creates when Paul asks (kept in the store, loaded on
 * boot). Every agent can read every
 * managed repository; an engineering job writes to one.
 */
export interface ManagedRepo {
  /** Short stable name used as the job target: "product", "self", "site". */
  alias: string;
  /** GitHub "owner/name", when known. */
  slug?: string;
  /** Local checkout. */
  dir: string;
  /** Other names Paul uses for it ("drpaulfarrow.com"). */
  names: string[];
  /** Created by the workforce rather than configured. */
  created?: boolean;
}

const ALIAS = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** GitHub repository names: letters, digits, dots, dashes, underscores. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const norm = (s: string) => s.trim().toLowerCase();

/** Parses MANAGED_REPOS: `alias=owner/name|other name, alias2=owner/name2`. Bad entries are ignored. */
export function parseManagedRepos(raw: string): Array<{ alias: string; slug: string; names: string[] }> {
  const out: Array<{ alias: string; slug: string; names: string[] }> = [];
  for (const entry of raw.split(",")) {
    const [left, right] = entry.split("=");
    if (!left || !right) continue;
    const alias = norm(left);
    const [slug, ...names] = right.split("|").map((s) => s.trim());
    if (!ALIAS.test(alias) || alias === "product" || alias === "self" || !/^[\w.-]+\/[\w.-]+$/.test(slug)) continue;
    if (out.some((o) => o.alias === alias)) continue;
    out.push({ alias, slug, names: names.filter(Boolean) });
  }
  return out;
}

export class RepoRegistry {
  private repos: ManagedRepo[] = [];

  constructor(opts: { product?: string; self?: string; extra?: string; productDir?: string; selfDir?: string; reposDir?: string } = {}) {
    const reposDir = opts.reposDir ?? config.reposDir;
    this.repos.push({ alias: "product", slug: "product" in opts ? opts.product : config.repos.product, dir: opts.productDir ?? config.repoDir, names: ["clear exchange", "clear-exchange"] });
    this.repos.push({ alias: "self", slug: "self" in opts ? opts.self : config.repos.self, dir: opts.selfDir ?? config.selfRepoDir, names: ["workforce", "clear-ops"] });
    for (const r of parseManagedRepos(opts.extra ?? config.repos.extra)) this.repos.push({ ...r, dir: path.join(reposDir, r.alias) });
    this.reposDir = reposDir;
  }

  private readonly reposDir: string;

  list(): ManagedRepo[] {
    return [...this.repos];
  }

  aliases(): string[] {
    return this.repos.map((r) => r.alias);
  }

  /** Finds a repository by alias, full owner/name, bare repository name or one of Paul's names for it. */
  find(name: string | undefined): ManagedRepo | undefined {
    const n = norm(name ?? "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
    if (!n) return undefined;
    return (
      this.repos.find((r) => r.alias === n) ??
      this.repos.find((r) => r.slug && norm(r.slug) === n) ??
      this.repos.find((r) => r.slug && norm(r.slug.split("/")[1]) === n) ??
      this.repos.find((r) => r.names.some((x) => norm(x) === n))
    );
  }

  /** The local folder of a job's repository. An unknown alias falls back to the product, as jobs always did. */
  dir(alias: string | undefined): string {
    return (this.find(alias ?? "product") ?? this.repos[0]).dir;
  }

  /** What Paul can ask for, for prompts and errors: "product, self, site". */
  describe(): string {
    return this.repos.map((r) => `${r.alias}${r.slug ? ` (${r.slug})` : ""}`).join(", ");
  }

  /** Adds a repository. Returns the existing entry when the alias or slug is already managed. */
  add(repo: Omit<ManagedRepo, "dir" | "names"> & { names?: string[]; dir?: string }): ManagedRepo {
    const existing = this.repos.find((r) => r.alias === repo.alias || (repo.slug && r.slug && norm(r.slug) === norm(repo.slug)));
    if (existing) return existing;
    const entry: ManagedRepo = { names: [], ...repo, dir: repo.dir ?? path.join(this.reposDir, repo.alias) };
    this.repos.push(entry);
    return entry;
  }

  /** Loads the repositories the workforce created in earlier runs. */
  load(store: Pick<Store, "createdRepos">): void {
    for (const [alias, r] of Object.entries(store.createdRepos())) this.add({ alias, slug: r.slug, created: true });
  }

  /** An alias for a new repository name that is free and valid ("my-app" for "My_App"). */
  freeAlias(name: string): string {
    const base = norm(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
    let alias = base;
    for (let i = 2; this.repos.some((r) => r.alias === alias) || alias === "product" || alias === "self"; i++) alias = `${base}-${i}`;
    return alias;
  }
}

/** The one registry the service uses. Tests build their own with `new RepoRegistry(...)`. */
export const repoRegistry = new RepoRegistry();

/* ---------- GitHub access: plain-English failures ---------- */

const SETTINGS_PATH = "In GitHub open Settings, Developer settings, Personal access tokens, then";
const REPLACE_SECRET = "then replace the GH_TOKEN secret in the clear-ops repository (Settings, Secrets and variables, Actions) and re-run the latest deploy workflow so the service picks it up.";

/**
 * Removes the token (and any token-bearing URL) from text before it is logged, returned or shown.
 * The key shapes below are the ones a brief, a report or a tool result is most likely to carry
 * (GitHub, JWTs and private keys, bearer tokens, and the common provider prefixes), because the text
 * being redacted is now also rendered on the jobs board (src/job-descriptions.ts).
 */
export function redact(text: string, token = process.env.GH_TOKEN ?? ""): string {
  let out = text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@").replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, "***")
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "***")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***")
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "***")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "***")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "***")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "***");
  out = out.replace(/\b(Bearer|sso-key) +[\w.~+/=:-]{6,}/gi, "$1 ***");
  for (const t of [token, process.env.GODADDY_API_TOKEN ?? ""]) if (t.length >= 6) out = out.split(t).join("***");
  return out;
}

/** A failure Paul can act on: `plain` says in plain English what he must change. Never contains the token. */
export class RepoError extends Error {
  constructor(
    readonly plain: string,
    readonly fixable = true,
  ) {
    super(plain);
    this.name = "RepoError";
  }
}

/**
 * What Paul must change when GitHub refuses to create a repository. A fine-grained token cannot
 * create repositories under a personal account at all (GitHub limits that to classic tokens), so
 * a refusal with a fine-grained token means: use a classic token with the repo scope.
 */
export function explainCreateFailure(status: number, owner: string, name: string, apiMessage = ""): string {
  const app = githubAuth.mode() === "app" ? " The GitHub App does the rest of the work, but GitHub does not let an App create repositories on a personal account, so this one step needs the classic GH_TOKEN." : "";
  if (status === 401) {
    return `GitHub rejected the token (GH_TOKEN), so I could not create ${owner}/${name}. Make a new token (${SETTINGS_PATH} Tokens (classic), Generate new token, tick "repo" and "workflow"), ${REPLACE_SECRET}${app}`;
  }
  if (status === 403 || status === 404) {
    return `GitHub would not let the token create ${owner}/${name}. Fine-grained tokens cannot create repositories under a personal account, so I need a classic token. ${SETTINGS_PATH} Tokens (classic), Generate new token, tick "repo" and "workflow", copy it, ${REPLACE_SECRET}${app}`;
  }
  if (status === 422) {
    return /already exists/i.test(apiMessage)
      ? `A repository called ${owner}/${name} already exists, so I did not create it. Pick another name, or if you meant that one, ask me to add it to the managed repositories.`
      : `GitHub refused the repository name or settings for ${owner}/${name} (${redact(apiMessage) || "validation failed"}). Try a different name.`;
  }
  return `GitHub returned an error (${status}) creating ${owner}/${name}: ${redact(apiMessage) || "no detail"}. Nothing was created; ask me to try again in a few minutes.`;
}

/**
 * What Paul must change when a clone or push fails. With a fine-grained token this is almost always
 * missing repository access: a token only reaches the repositories it was granted.
 */
export function explainCloneFailure(slug: string, detail = ""): string {
  const d = detail.toLowerCase();
  const perms = /not found|403|401|authentication|could not read|denied|permission|repository access/.test(d) || !d;
  if (perms && githubAuth.mode() === "app") {
    const owner = slug.split("/")[0] ?? "";
    // A repository in someone else's account (an organisation) needs the App installed there, not on Paul's own account.
    const where =
      owner && norm(owner) !== norm(config.repos.owner)
        ? `It belongs to the ${owner} organisation, so the App has to be installed there: on GitHub open ${owner}'s Settings, GitHub Apps, Configure, and give the App access to this repository (or to all of ${owner}'s repositories).`
        : `On GitHub open Settings, Applications, Installed GitHub Apps, Configure on the App, and choose All repositories (or add ${slug}).`;
    return `I could not reach ${slug} with the GitHub App, most likely because the App is not installed on it. ${where} Nothing needs changing in the code or the secrets.`;
  }
  if (perms) {
    return `I could not reach ${slug} with the GitHub token (GH_TOKEN), most likely because the token has no access to it. ${SETTINGS_PATH} Fine-grained tokens, open the token, under Repository access add ${slug} (or choose All repositories), and make sure Contents and Pull requests are Read and write and Workflows is Read and write (a classic token needs "repo" and "workflow"). Nothing needs changing in the code. If you changed the token, ${REPLACE_SECRET}`;
  }
  return `I could not clone ${slug}: ${redact(detail).slice(0, 200)}. Ask me to try again in a few minutes.`;
}

export interface CreateRepoOptions {
  /** Repository name under the configured owner. */
  name: string;
  description?: string;
  /** Public only when Paul said so. Private by default. */
  public?: boolean;
  /** The job creating it. */
  jobId?: string;
}

export interface CreateRepoDeps {
  registry?: RepoRegistry;
  store: Pick<Store, "addCreatedRepo">;
  fetch?: typeof fetch;
  /** Clones and configures a checkout. Defaults to bootstrap's. */
  clone: (slug: string, dir: string) => Promise<void>;
  token?: string;
  owner?: string;
}

export interface CreatedRepoInfo {
  alias: string;
  slug: string;
  url: string;
  dir: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * Creates a repository under the configured owner, private unless asked otherwise, with a README and
 * an initial commit on the default branch (GitHub's own auto_init, so nothing is pushed by us), adds
 * it to the managed list, persists it and clones it so it can be worked on straight away. It changes
 * nothing else: no settings, no visibility change, no deletion. The caller decides when this is
 * allowed (a "create_repo" permit from Paul's chat); this function does not check intent.
 */
export async function createRepo(opts: CreateRepoOptions, deps: CreateRepoDeps): Promise<CreatedRepoInfo> {
  const registry = deps.registry ?? repoRegistry;
  const owner = deps.owner ?? config.repos.owner;
  // Always the personal token, never the App: GitHub does not let an App installation create repositories on a personal account.
  const token = deps.token ?? process.env.GH_TOKEN ?? "";
  const name = opts.name.trim();
  if (!REPO_NAME.test(name) || name === "." || name === ".." || name.endsWith(".git")) {
    throw new RepoError(`"${name}" is not a valid GitHub repository name. Use letters, numbers, dots, dashes and underscores.`, false);
  }
  if (!token) {
    throw new RepoError(`I cannot create repositories because GH_TOKEN is not set.${githubAuth.mode() === "app" ? " The GitHub App covers everything else, but GitHub does not let an App create repositories on a personal account." : ""} Add a classic GitHub token with the "repo" and "workflow" scopes as the GH_TOKEN secret in the clear-ops repository (it is used only to create repositories when you ask), then re-run the latest deploy workflow.`);
  }
  const slug = `${owner}/${name}`;
  const known = registry.find(slug);
  if (known) throw new RepoError(`${slug} is already a managed repository (alias "${known.alias}"), so I did not create it again.`, false);
  const isPublic = opts.public === true;
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "clear-ops" },
      body: JSON.stringify({ name, description: (opts.description ?? "").slice(0, 300) || undefined, private: !isPublic, auto_init: true }),
    });
  } catch (err) {
    throw new RepoError(`I could not reach GitHub to create ${slug}: ${redact(err instanceof Error ? err.message : String(err), token)}. Nothing was created; ask me to try again.`, false);
  }
  let body: { message?: string; default_branch?: string; full_name?: string; html_url?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // no body
  }
  if (!res.ok) throw new RepoError(explainCreateFailure(res.status, owner, name, body.message ?? ""));
  const created = body.full_name && /^[\w.-]+\/[\w.-]+$/.test(body.full_name) ? body.full_name : slug;
  const alias = registry.freeAlias(name);
  const entry = registry.add({ alias, slug: created, created: true });
  deps.store.addCreatedRepo(alias, { slug: created, private: !isPublic, description: opts.description?.slice(0, 300), createdAt: new Date().toISOString(), jobId: opts.jobId });
  try {
    await deps.clone(created, entry.dir);
  } catch (err) {
    // The repository exists and is registered; only the local copy failed, usually for lack of access.
    throw new RepoError(`I created ${created} (${isPublic ? "public" : "private"}) but could not clone it. ${explainCloneFailure(created, err instanceof Error ? err.message : String(err))}`);
  }
  return { alias, slug: created, url: body.html_url ?? `https://github.com/${created}`, dir: entry.dir, private: !isPublic, defaultBranch: body.default_branch ?? "main" };
}
