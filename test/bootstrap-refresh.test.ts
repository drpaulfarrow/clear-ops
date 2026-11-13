import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-refresh-"));
const { refreshCheckout } = await import("../src/bootstrap.js");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-git-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  fs.writeFileSync(path.join(origin, "a.txt"), "1");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "one");
  const clone = path.join(root, "clone");
  git(root, "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  const advance = () => {
    fs.writeFileSync(path.join(origin, "a.txt"), String(Date.now()));
    git(origin, "commit", "-qam", "next");
  };
  return { origin, clone, advance };
}

test("a clean checkout on the default branch is fast-forwarded to what is deployed", async () => {
  const { origin, clone, advance } = setup();
  assert.equal(await refreshCheckout(clone, () => undefined), "current");
  advance();
  assert.equal(await refreshCheckout(clone, () => undefined), "updated");
  assert.equal(git(clone, "rev-parse", "HEAD"), git(origin, "rev-parse", "HEAD"));
});

test("an engineer's branch or uncommitted work is never touched", async () => {
  const { origin, clone, advance } = setup();
  advance();
  git(clone, "checkout", "-qb", "clear/work");
  assert.equal(await refreshCheckout(clone, () => undefined), "skipped");
  git(clone, "checkout", "-q", "main");
  fs.writeFileSync(path.join(clone, "a.txt"), "local edit");
  assert.equal(await refreshCheckout(clone, () => undefined), "skipped");
  assert.equal(fs.readFileSync(path.join(clone, "a.txt"), "utf8"), "local edit");
  assert.notEqual(git(clone, "rev-parse", "HEAD"), git(origin, "rev-parse", "HEAD"));
});
