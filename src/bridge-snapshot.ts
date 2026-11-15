/**
 * A job started through the Instinct bridge does not read the live repository directories. It gets a
 * throwaway copy that has only source: no .git directory (a remote URL there can carry a credential), no
 * .env files, no symlinks (which could point out of the copy), no node_modules, no large files. The copy
 * is the job's working directory and its only readable directory, so what it may read is decided by what
 * is on disk, not by a permission rule.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", ".venv"]);
const SKIP_FILE = /^(\.env.*|.*\.pem|.*\.key|id_rsa.*|.*\.p12|.*\.pfx|\.npmrc|\.netrc|.*credentials.*|.*secret.*)$/i;

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const src = path.join(from, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      copyTree(src, path.join(to, e.name));
    } else if (e.isFile()) {
      if (SKIP_FILE.test(e.name)) continue;
      if (fs.statSync(src).size > MAX_FILE_BYTES) continue;
      fs.copyFileSync(src, path.join(to, e.name));
    }
  }
}

/** Copies each repository (alias to directory) under a fresh directory and returns it. */
export function snapshotRepos(repos: Array<{ alias: string; dir: string }>, base = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(base, "bridge-snapshot-"));
  for (const r of repos) if (fs.existsSync(r.dir)) copyTree(r.dir, path.join(root, r.alias));
  return root;
}

export function removeSnapshot(root: string | undefined): void {
  if (root && path.basename(root).startsWith("bridge-snapshot-")) fs.rmSync(root, { recursive: true, force: true });
}
