import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { githubAuth, healthLine, healthProblem, type AuthHealth, type AuthMode, type GithubAuth } from "./github-auth.js";
import { explainCloneFailure, perRepoTokenFix, redact, repoRegistry, type ManagedRepo, type RepoRegistry } from "./repos.js";
import { credentialLabel, repoCredentialLabel, repoTokens, repoTokenFile, writeRepoTokenFile, type CredentialKind } from "./repo-tokens.js";

const exec = promisify(execFile);

/** A managed repository that could not be prepared, and what Paul must change (plain English, no token). */
export interface RepoProblem {
  alias: string;
  slug: string;
  plain: string;
}

/**
 * Which credential one repository is reached with: its own token when one is set for it, else the
 * GitHub App, else GH_TOKEN, else nothing. The token itself never leaves this function.
 */
export async function repoCredential(repo: { alias?: string; slug?: string } | undefined, auth: GithubAuth = githubAuth): Promise<{ token: string; kind: CredentialKind; source?: string }> {
  const own = repoTokens.get(repo);
  if (own) return { token: own, kind: "repo-token", source: repoTokens.source(repo) };
  const mode = auth.mode();
  const token = await auth.token();
  return { token, kind: token ? (mode === "app" ? "app" : "token") : "none" };
}

/**
 * Clones a repository into dir if the folder is missing, then points git at the token and sets the
 * commit identity. `alias` names the managed repository, so a repository with its own token
 * (`DOUBLESHIFT_TOKEN`, src/repo-tokens.ts) uses it for the clone, the fetch and every push, and never
 * falls back to a credential that may have no access. No token is written into the checkout: git reads
 * it from an owner-only file under DATA_DIR at each operation, as it does with the App's token.
 */
export async function prepareRepo(slug: string, dir: string, tokenArg?: string, log: (m: string) => void = console.log, auth: GithubAuth = githubAuth, alias?: string): Promise<void> {
  const own = tokenArg === undefined ? repoTokens.get({ alias, slug }) : undefined;
  if (own && alias) writeRepoTokenFile(alias, own);
  // With the GitHub App configured, git reads the current installation token from its owner-only file at
  // every operation, so a long job never holds an expired one. An explicit token (or no App) uses GH_TOKEN as before.
  const useFile = tokenArg === undefined && !own && (await auth.refreshFile());
  const token = tokenArg ?? own ?? (await auth.token());
  if (!fs.existsSync(dir)) {
    if (!token) throw new Error(`folder ${dir} is missing and GH_TOKEN is not set, so it cannot be cloned.`);
    log(`Cloning ${slug} into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      await exec("git", ["clone", "--quiet", `https://x-access-token:${token}@github.com/${slug}`, dir]);
    } catch (err) {
      // git's own message can carry the clone URL, token included.
      const stderr = (err as { stderr?: string }).stderr ?? "";
      throw new Error(redact(stderr || (err instanceof Error ? err.message : String(err)), token));
    }
  }
  try {
    await exec("git", ["config", "user.name", "Clear Exchange agents"], { cwd: dir });
    await exec("git", ["config", "user.email", "agents@clear.exchange"], { cwd: dir });
    if (token) {
      // Keep the token out of the stored remote URL; supply it through a credential helper instead.
      const url = `https://github.com/${slug}`;
      await exec("git", ["remote", "set-url", "origin", url], { cwd: dir }).catch(() => exec("git", ["remote", "add", "origin", url], { cwd: dir }));
      const q = (s: string) => s.replace(/'/g, `'\\''`);
      const password = own && alias ? `$(cat '${q(repoTokenFile(alias))}')` : useFile ? `$(cat '${q(auth.tokenFile)}')` : token;
      await exec("git", ["config", "credential.helper", `!f() { echo username=x-access-token; echo password=${password}; }; f`], { cwd: dir });
    }
  } catch (err) {
    log(`Could not configure git in ${dir}: ${redact(err instanceof Error ? err.message : String(err), token)}`);
  }
  await refreshCheckout(dir, (m) => log(redact(m, token)));
}

/**
 * Brings an existing checkout up to date with its default branch on start, so agents that read it (the
 * chief answering questions about the workforce, research, review) see the code that is actually
 * deployed rather than the clone from the first boot. Only fast-forwards, and only when the checkout is
 * on the default branch with no local changes: an engineer's branch or uncommitted work is never touched.
 */
export async function refreshCheckout(dir: string, log: (m: string) => void = console.log): Promise<"updated" | "current" | "skipped"> {
  try {
    await exec("git", ["fetch", "--quiet", "origin"], { cwd: dir });
    const head = (await exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: dir }).catch(() => ({ stdout: "origin/main" }))).stdout.trim();
    const def = head.replace(/^origin\//, "");
    const branch = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).stdout.trim();
    const dirty = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout.trim();
    if (branch !== def || dirty) return "skipped";
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    await exec("git", ["merge", "--ff-only", "--quiet", `origin/${def}`], { cwd: dir });
    const after = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    if (before === after) return "current";
    log(`Updated ${dir} to the latest ${def}.`);
    return "updated";
  } catch (err) {
    log(`Could not update ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return "skipped";
  }
}

/**
 * Prepares every managed repository's working folder on startup so the operator only has to supply
 * GH_TOKEN: clones each repository whose folder is missing, points git at the token for pushes, and
 * sets a commit identity for the agents. Safe to run on every start. A repository that cannot be
 * prepared does not stop the rest; it is returned with plain-English instructions for Paul, and the
 * token is never logged.
 */
export async function bootstrapRepos(log: (m: string) => void = console.log, registry: RepoRegistry = repoRegistry, auth: GithubAuth = githubAuth): Promise<RepoProblem[]> {
  const problems: RepoProblem[] = [];
  for (const repo of registry.list()) {
    const { alias, slug, dir } = repo;
    if (!slug) {
      const env = alias === "product" ? "PRODUCT_REPO" : "SELF_REPO";
      log(`${alias} repository not configured (set ${env}); engineer jobs on it will fail until it is.`);
      continue;
    }
    const credential = await repoCredential(repo, auth);
    if (!fs.existsSync(dir) && !credential.token) {
      log(`${alias} repository folder ${dir} is missing and no GitHub credential is set for it, so it cannot be cloned.`);
      problems.push({ alias, slug, plain: `I have no GitHub credential for ${slug}, so I cannot clone it. Set up the GitHub App (docs/GITHUB_APP.md) or add GH_TOKEN, or give this repository its own token.${perRepoTokenFix(slug, alias)}` });
      continue;
    }
    try {
      await prepareRepo(slug, dir, undefined, log, auth, alias);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`Could not prepare ${alias} (${slug}): ${redact(detail, credential.token).slice(0, 300)}`);
      problems.push({ alias, slug, plain: explainCloneFailure(slug, detail, repo) });
    }
  }
  return problems;
}

/**
 * Which credential each managed repository is reached with, in one plain line for the start-up log and
 * /status. A repository with its own token is named with the variable it came from; every other one
 * says which global credential covers it. Never a token, only its variable name.
 */
export function repoCredentialLine(registry: RepoRegistry = repoRegistry, auth: GithubAuth = githubAuth, effective?: AuthMode): string {
  const global = credentialLabel(effective ?? auth.mode());
  const parts = registry
    .list()
    .filter((r) => r.slug)
    .map((r) => {
      const own = repoTokens.source(r);
      return `${r.alias} (${r.slug}) via ${own ? credentialLabel("repo-token", own) : global}`;
    });
  return `GitHub credentials by repository: ${parts.join("; ")}.`;
}

/**
 * The same, for the repository one job works in: one plain line for that job's saved report. Empty
 * unless the repository has a token of its own, which is the case Paul has to be able to see; a
 * repository on the App or GH_TOKEN is already described by the start-up line and /status.
 */
export function jobCredentialNote(target: string | undefined, registry: RepoRegistry = repoRegistry, auth: GithubAuth = githubAuth): string {
  const repo: ManagedRepo | undefined = registry.find(target ?? "product");
  if (!repoTokens.has(repo)) return "";
  const what = repo?.slug ? `${repo.alias} (${repo.slug})` : (repo?.alias ?? target ?? "the product");
  return `Reached ${what} with ${repoCredentialLabel(repo, auth.mode())}.`;
}

/** One message for Paul about repositories that could not be prepared, or undefined when there are none. */
export function repoProblemsMessage(problems: RepoProblem[]): string | undefined {
  if (!problems.length) return undefined;
  if (problems.length === 1) return problems[0].plain;
  const names = problems.map((p) => p.slug).join(", ");
  const perRepo = problems.map((p) => perRepoTokenFix(p.slug, p.alias)).join("");
  return `I could not clone ${names} with the GitHub token (GH_TOKEN). In GitHub open Settings, Developer settings, Personal access tokens, open the token and under Repository access add those repositories (or choose All repositories) with Contents, Pull requests and Workflows set to Read and write. If you change the secret, replace GH_TOKEN in the clear-ops repository and re-run the latest deploy workflow.${perRepo}`;
}

/** Which GitHub auth is active and which managed repositories it reaches. No secrets in it. */
export async function githubHealth(registry: RepoRegistry = repoRegistry, auth: GithubAuth = githubAuth): Promise<AuthHealth> {
  return auth.health(registry.list().flatMap((r) => (r.slug ? [{ slug: r.slug, alias: r.alias }] : [])));
}

/** The /status line and the start-up log line: the active auth, which repositories it reaches, and with what. */
export async function githubStatusLine(registry: RepoRegistry = repoRegistry, auth: GithubAuth = githubAuth): Promise<string> {
  const h = await githubHealth(registry, auth);
  return `${healthLine(h)} ${repoCredentialLine(registry, auth, h.effective ?? h.mode)}`;
}

/** One plain message for Paul when the App cannot sign in or a managed repository cannot be reached, else undefined. */
export async function githubProblemMessage(registry: RepoRegistry = repoRegistry, auth: GithubAuth = githubAuth): Promise<{ message?: string; line: string }> {
  const h = await githubHealth(registry, auth);
  return { message: healthProblem(h), line: healthLine(h) };
}
