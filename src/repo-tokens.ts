import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Per-repository GitHub tokens.
 *
 * One managed repository can live in an organisation the workforce's GitHub App is not installed on
 * and may never be, so waiting for an owner to install it would block Paul indefinitely. A repository
 * can instead carry its own personal access token, read from the environment in the service's usual
 * naming style: the alias `doubleshift` is `DOUBLESHIFT_TOKEN`. `REPO_TOKENS` (a JSON object mapping
 * an alias or a full `owner/name` to a token) is the general map for anything that does not fit an
 * environment variable name.
 *
 * Precedence, per repository: its own token, else the GitHub App, else GH_TOKEN. A repository with its
 * own token never falls back to another credential, because a failure has to name the secret that is
 * actually wrong rather than report a vague error about a token that may have no access.
 *
 * Nothing here prints, logs or stores a token. `source()` returns the name of the variable a token
 * came from, which is what every message and log line says instead of the token itself.
 */

/** The environment variable a repository's own token is read from: alias "doubleshift" -> DOUBLESHIFT_TOKEN. */
export function repoTokenEnvName(alias: string): string {
  return `${alias.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_TOKEN`;
}

/** The general map variable: a JSON object of alias (or owner/name) to token. */
export const REPO_TOKENS_ENV = "REPO_TOKENS";

/** Parses REPO_TOKENS. A malformed value is ignored rather than throwing: no repository may be reached with a guess. */
export function parseRepoTokenMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim() || !key.trim()) continue;
    out.set(key.trim().toLowerCase(), value.trim());
  }
  return out;
}

export interface RepoTokenOptions {
  env?: NodeJS.ProcessEnv;
  /** Raw REPO_TOKENS value. */
  map?: string;
  /** Registered aliases, so their own variables can be stripped from every worker. */
  aliases?: string[];
}

export class RepoTokens {
  private readonly env: NodeJS.ProcessEnv;
  private readonly aliases: string[];
  private readonly map: Map<string, string>;

  constructor(opts: RepoTokenOptions = {}) {
    this.env = opts.env ?? process.env;
    this.aliases = opts.aliases ?? [];
    this.map = parseRepoTokenMap(opts.map ?? this.env[REPO_TOKENS_ENV] ?? "");
  }

  /** The repository's own token, or undefined when it has none and must use the global credentials. */
  get(repo: { alias?: string; slug?: string } | undefined): string | undefined {
    if (!repo) return undefined;
    const alias = (repo.alias ?? "").trim().toLowerCase();
    if (alias) {
      const own = (this.env[repoTokenEnvName(alias)] ?? "").trim();
      if (own) return own;
      const fromMap = this.map.get(alias);
      if (fromMap) return fromMap;
    }
    const slug = (repo.slug ?? "").trim().toLowerCase();
    if (slug) {
      const bySlug = this.map.get(slug) ?? this.map.get(slug.split("/").pop() ?? "");
      if (bySlug) return bySlug;
    }
    return undefined;
  }

  /** Where a repository's own token comes from, for a log line or a message: the variable name, never the token. */
  source(repo: { alias?: string; slug?: string } | undefined): string | undefined {
    if (!repo || !this.get(repo)) return undefined;
    const alias = (repo.alias ?? "").trim().toLowerCase();
    if (alias && (this.env[repoTokenEnvName(alias)] ?? "").trim()) return repoTokenEnvName(alias);
    return REPO_TOKENS_ENV;
  }

  has(repo: { alias?: string; slug?: string } | undefined): boolean {
    return Boolean(this.get(repo));
  }

  /** Every per-repository token value, for redaction. Never logged, never returned to a caller that shows it. */
  secrets(aliases: string[] = this.aliases): string[] {
    const out = new Set<string>(this.map.values());
    for (const alias of aliases) {
      const value = (this.env[repoTokenEnvName(alias)] ?? "").trim();
      if (value) out.add(value);
    }
    return [...out];
  }

  /** The variables a per-repository token may sit in, so none of them reaches a worker by accident. */
  names(aliases: string[] = this.aliases): string[] {
    return [REPO_TOKENS_ENV, ...aliases.map((a) => repoTokenEnvName(a))];
  }
}

/** The one instance the service uses. Tests build their own with `new RepoTokens({ env, map })`. */
export const repoTokens = new RepoTokens();

/**
 * Where a repository's own token is kept for git, owner-only and outside every checkout, so no token
 * is written into a working copy's `.git/config` (exactly as the App's installation token is kept).
 */
export function repoTokenFile(alias: string): string {
  return path.join(config.dataDir, "secrets", `github-${alias.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-token`);
}

/** Writes a repository's token to its owner-only file and returns the path. The token is never logged. */
export function writeRepoTokenFile(alias: string, token: string): string {
  const file = repoTokenFile(alias);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * The repository's own-token option, for a failure message: the exact secret to add, the scopes it
 * needs and the deploy to re-run. A repository in an organisation that will not install the App is
 * reached this way, so this is the specific fix rather than "ask an owner to change something".
 */
export function perRepoTokenFix(slug: string, alias?: string): string {
  const name = repoTokenEnvName(alias || slug.split("/").pop() || "repo");
  return ` If GitHub will not give the App or GH_TOKEN access to it, this repository can have its own token instead: create a classic token with the "repo" and "workflow" scopes, add it as the ${name} secret in the clear-ops repository (Settings, Secrets and variables, Actions) and re-run the latest deploy workflow. Then the workforce clones, fetches and pushes ${slug} with that token, and nothing else changes.`;
}

/**
 * Which credential one repository is reached with, in plain words: its own token when one is set for
 * it, else the global credential in force. Never the token, only the name of the variable it came from.
 */
export function repoCredentialLabel(repo: { alias?: string; slug?: string } | undefined, globalMode: CredentialKind = "none"): string {
  const own = repoTokens.source(repo);
  return own ? credentialLabel("repo-token", own) : credentialLabel(globalMode);
}

/** The plain words for how a repository is reached: its own token, the App, GH_TOKEN or nothing. */
export type CredentialKind = "repo-token" | "app" | "token" | "none";

/** What a repository is reached with, in plain words, with the variable name instead of any token. */
export function credentialLabel(kind: CredentialKind, source?: string): string {
  if (kind === "repo-token") return `its own token (${source ?? REPO_TOKENS_ENV})`;
  if (kind === "app") return "the GitHub App";
  if (kind === "token") return "GH_TOKEN";
  return "no credentials";
}
