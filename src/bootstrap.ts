import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { explainCloneFailure, redact, repoRegistry, type RepoRegistry } from "./repos.js";

const exec = promisify(execFile);

/** A managed repository that could not be prepared, and what Paul must change (plain English, no token). */
export interface RepoProblem {
  alias: string;
  slug: string;
  plain: string;
}

/** Clones a repository into dir if the folder is missing, then points git at the token and sets the commit identity. */
export async function prepareRepo(slug: string, dir: string, token = process.env.GH_TOKEN ?? "", log: (m: string) => void = console.log): Promise<void> {
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
      await exec("git", ["config", "credential.helper", `!f() { echo username=x-access-token; echo password=${token}; }; f`], { cwd: dir });
    }
  } catch (err) {
    log(`Could not configure git in ${dir}: ${redact(err instanceof Error ? err.message : String(err), token)}`);
  }
}

/**
 * Prepares every managed repository's working folder on startup so the operator only has to supply
 * GH_TOKEN: clones each repository whose folder is missing, points git at the token for pushes, and
 * sets a commit identity for the agents. Safe to run on every start. A repository that cannot be
 * prepared does not stop the rest; it is returned with plain-English instructions for Paul, and the
 * token is never logged.
 */
export async function bootstrapRepos(log: (m: string) => void = console.log, registry: RepoRegistry = repoRegistry): Promise<RepoProblem[]> {
  const token = process.env.GH_TOKEN ?? "";
  const problems: RepoProblem[] = [];
  for (const repo of registry.list()) {
    const { alias, slug, dir } = repo;
    if (!slug) {
      const env = alias === "product" ? "PRODUCT_REPO" : "SELF_REPO";
      log(`${alias} repository not configured (set ${env}); engineer jobs on it will fail until it is.`);
      continue;
    }
    if (!fs.existsSync(dir) && !token) {
      log(`${alias} repository folder ${dir} is missing and GH_TOKEN is not set, so it cannot be cloned.`);
      problems.push({ alias, slug, plain: `GH_TOKEN is not set, so I cannot clone ${slug}. Add it as a secret and re-run the latest deploy workflow.` });
      continue;
    }
    try {
      await prepareRepo(slug, dir, token, log);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`Could not prepare ${alias} (${slug}): ${redact(detail, token).slice(0, 300)}`);
      problems.push({ alias, slug, plain: explainCloneFailure(slug, detail) });
    }
  }
  return problems;
}

/** One message for Paul about repositories that could not be prepared, or undefined when there are none. */
export function repoProblemsMessage(problems: RepoProblem[]): string | undefined {
  if (!problems.length) return undefined;
  if (problems.length === 1) return problems[0].plain;
  const names = problems.map((p) => p.slug).join(", ");
  return `I could not clone ${names} with the GitHub token (GH_TOKEN). In GitHub open Settings, Developer settings, Personal access tokens, open the token and under Repository access add those repositories (or choose All repositories) with Contents, Pull requests and Workflows set to Read and write. If you change the secret, replace GH_TOKEN in the clear-ops repository and re-run the latest deploy workflow.`;
}
