/**
 * The suite, run the way a review needs it.
 *
 * `npm test` runs everything, and CI runs it on every push and pull request. A review runs this
 * instead: it looks at what the branch changed against the default branch and, when every changed
 * file is a documentation file, says what it saw and stops without running the suite. A documentation
 * diff cannot change a source or a test file, and the full suite has already run on the pull request
 * in CI, which the maintainer checks.
 *
 * Anything else, including a diff it cannot read, runs the whole suite exactly as CI does. It never
 * skips silently: it always prints what it looked at and what it decided.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation only: a documentation extension, wherever the file lives. The extension is what
 * decides, not the folder, because nothing under `docs/` is documentation by definition
 * (`docs/install.sh` and `docs/x.ts` are neither documentation nor part of the suite's own tree).
 */
const DOCUMENTATION = /\.(md|markdown|mdx|txt|rst|adoc)$/i;

export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => DOCUMENTATION.test(p));
}

function git(args: string[], dir: string): string {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** The default branch to compare against, as a ref, e.g. origin/main. */
export function defaultRef(dir: string): string {
  const head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], dir).trim();
  if (head) return head;
  return git(["rev-parse", "--verify", "--quiet", "origin/main"], dir).trim() ? "origin/main" : "main";
}

/** Every file this branch changed: committed against the default branch, plus anything uncommitted. */
export function changedFiles(ref: string, dir: string): string[] {
  const base = git(["merge-base", "HEAD", ref], dir).trim();
  const lines = [
    base ? git(["diff", "--name-only", base, "HEAD"], dir) : "",
    git(["diff", "--name-only", "HEAD"], dir),
    git(["ls-files", "--others", "--exclude-standard"], dir),
  ]
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

/** What a review should do about this branch: run the suite, or say why not. */
export interface ReviewPlan {
  ref: string;
  files: string[];
  /** True when the suite can be left to CI: every changed file is documentation. */
  docsOnly: boolean;
}

export function reviewPlan(dir: string = process.cwd()): ReviewPlan {
  const ref = defaultRef(dir);
  const files = changedFiles(ref, dir);
  return { ref, files, docsOnly: docsOnly(files) };
}

function main(dir: string = process.cwd()): void {
  const plan = reviewPlan(dir);
  if (plan.docsOnly) {
    console.log(`Documentation only (${plan.files.length} file${plan.files.length === 1 ? "" : "s"} against ${plan.ref}): ${plan.files.join(", ")}`);
    console.log("Not running the suite: a documentation diff cannot change a source or test file, and CI runs the full suite on the pull request.");
    return;
  }
  console.log(plan.files.length ? `Changed against ${plan.ref}: ${plan.files.join(", ")}` : `No changed files found against ${plan.ref}.`);
  console.log("Running the full suite, as CI does.");
  execFileSync("npm", ["test"], { cwd: dir, stdio: "inherit" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
