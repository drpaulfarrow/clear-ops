import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

/**
 * Prepares the two working folders on startup so the operator only has to supply GH_TOKEN:
 * clones each repository if its folder is missing, points git at the token for pushes,
 * and sets a commit identity for the agents. Safe to run on every start.
 */
export async function bootstrapRepos(log: (m: string) => void = console.log): Promise<void> {
  const token = process.env.GH_TOKEN ?? "";
  const targets: Array<[string, string | undefined, string]> = [
    [config.repoDir, config.repos.product, "product"],
    [config.selfRepoDir, config.repos.self, "workforce"],
  ];
  for (const [dir, slug, label] of targets) {
    if (!slug) {
      log(`${label} repository not configured (set ${label === "product" ? "PRODUCT_REPO" : "SELF_REPO"}); engineer jobs on it will fail until it is.`);
      continue;
    }
    if (!fs.existsSync(dir)) {
      if (!token) {
        log(`${label} repository folder ${dir} is missing and GH_TOKEN is not set, so it cannot be cloned.`);
        continue;
      }
      log(`Cloning ${slug} into ${dir}`);
      await exec("git", ["clone", "--quiet", `https://x-access-token:${token}@github.com/${slug}`, dir]);
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
      log(`Could not configure git in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
