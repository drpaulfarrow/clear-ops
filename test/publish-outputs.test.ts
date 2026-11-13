import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pub-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { classify } = await import("../src/output-folders.js");
const { OutputsPublisher, renderIndex, slugify, entryFor, backfillOnce } = await import("../src/publish-outputs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { Job } from "../src/store.js";

const FOUNDER = "tg:99887766";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const waitFor = async (pred: () => boolean, ms = 20000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A bare "GitHub" and a clone of it, so real git runs offline. */
function remote() {
  const bare = tmp("pub-bare-");
  sh(bare, "init", "--bare", "-b", "main", ".");
  const dir = tmp("pub-clone-");
  sh(dir, "init", "-b", "main", ".");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "remote", "add", "origin", bare);
  fs.writeFileSync(path.join(dir, "README.md"), "# clear-outputs\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-m", "init");
  sh(dir, "push", "origin", "main");
  return { bare, dir };
}

const visibility = (isPrivate: boolean | number) => (async () => (typeof isPrivate === "number" ? new Response("{}", { status: isPrivate }) : new Response(JSON.stringify({ private: isPrivate })))) as unknown as typeof fetch;

function setup(opts: { isPrivate?: boolean | number } = {}) {
  const store = new Store(tmp("pub-store-"));
  const { bare, dir } = remote();
  const problems: string[] = [];
  const pub = new OutputsPublisher(store, { slug: "acme/clear-outputs", dir, fetch: visibility(opts.isPrivate ?? true), prepare: async () => {}, token: async () => "tok", log: () => {}, onProblem: (m) => problems.push(m) });
  const job = (id: string, title: string, text: string, createdAt = "2026-11-02T10:00:00.000Z"): Job => {
    const j = { id, kind: "research", title, brief: "b", requestedBy: FOUNDER, status: "done", createdAt, finishedAt: createdAt } as Job;
    (store as unknown as { state: { jobs: Record<string, Job> } }).state.jobs[id] = j;
    store.writeOutput(id, text);
    return j;
  };
  const remoteFiles = () => {
    // A clone can race the publisher's own push into the bare repository (git moves objects into place
    // while we copy them): take a fresh directory and try again rather than fail on the race.
    let c = "";
    for (let attempt = 0; ; attempt++) {
      c = tmp("pub-check-");
      try {
        sh(c, "clone", "-q", bare, ".");
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    return { c, read: (f: string) => fs.readFileSync(path.join(c, f), "utf8"), has: (f: string) => fs.existsSync(path.join(c, f)) };
  };
  return { store, pub, job, problems, remoteFiles, dir };
}

test("layout: file name from date, id and title, and an index newest first", () => {
  assert.equal(slugify("Fly deploy: £5 & more!"), "fly-deploy-5-more");
  const e = entryFor({ id: "1b88d9", kind: "research", title: "Profile review", brief: "", status: "done", createdAt: "2026-11-02T10:00:00Z" } as Job);
  assert.equal(e.file, "outputs/2026-11-02-1b88d9-profile-review.md", "default folder");
  assert.equal(entryFor({ id: "1b88d9", kind: "research", title: "Profile review", brief: "", status: "done", createdAt: "2026-11-02T10:00:00Z" } as Job, "research").file, "research/2026-11-02-1b88d9-profile-review.md");
  const idx = renderIndex([e, { ...e, id: "aaaaaa", at: "2026-11-03T10:00:00Z", date: "2026-11-03", file: "research/x.md", title: "A | B" }]);
  assert.ok(idx.indexOf("aaaaaa") < idx.indexOf("1b88d9"), "newest first");
  assert.match(idx, /\| 2026-11-02 \| 1b88d9 \| Profile review \| research \| \[read\]\(outputs\/2026-11-02-1b88d9-profile-review\.md\) \|/);
  assert.ok(!idx.includes("A | B"), "pipes in titles cannot break the table");
});

test("a finished job's output is pushed as Markdown with an index", async () => {
  const s = setup();
  s.pub.publish(s.job("1b88d9", "Profile review", "Full report text"));
  await waitFor(() => s.remoteFiles().has("research/2026-11-02-1b88d9-profile-review.md"));
  const r = s.remoteFiles();
  assert.match(r.read("research/2026-11-02-1b88d9-profile-review.md"), /Full report text/);
  assert.match(r.read("README.md"), /1b88d9/);
});

test("backfill publishes every existing output, including ones with no job record, once", async () => {
  const s = setup();
  s.job("1b88d9", "One", "a");
  s.job("23ea1b", "Two", "b");
  s.store.writeOutput("002189", "orphan with no job record");
  fs.writeFileSync(path.join(s.store.dir, "outputs", "notes.txt"), "not markdown");
  fs.writeFileSync(path.join(s.store.dir, "outputs", "bad name.md"), "bad id is skipped");
  await backfillOnce(s.store, s.pub);
  const r = s.remoteFiles();
  const index = r.read("README.md");
  for (const id of ["1b88d9", "23ea1b"]) assert.ok(index.includes(id), id);
  assert.ok(!index.includes("002189"), "an output with no job record cannot be classified, so it is not copied");
  assert.ok(!index.includes("bad name") && !index.includes("notes"));
  assert.ok(s.store.settings().outputsBackfilled);
  const before = sh(s.dir, "rev-list", "--count", "HEAD");
  await backfillOnce(s.store, s.pub);
  assert.equal(sh(s.dir, "rev-list", "--count", "HEAD"), before, "second run does nothing");
});

test("nothing is pushed unless the repository is private, and Paul is told how to fix it", async () => {
  const s = setup({ isPrivate: false });
  s.pub.publish(s.job("1b88d9", "T", "personal data"));
  await s.pub.backfill();
  assert.equal(s.remoteFiles().has("README.md") && s.remoteFiles().read("README.md").includes("1b88d9"), false);
  assert.equal(s.problems.length, 1, "told once");
  assert.match(s.problems[0], /not private/);
  assert.match(s.problems[0], /make it private/i);
});

test("an unreachable repository (404) or a failing check also pushes nothing and says what to change", async () => {
  const s = setup({ isPrivate: 404 });
  await s.pub.backfill();
  assert.match(s.problems[0], /repository access/);
  const t = setup();
  const failing = new OutputsPublisher(t.store, { slug: "a/b", dir: t.dir, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, prepare: async () => {}, token: async () => "t", log: () => {} });
  t.job("1b88d9", "T", "x");
  assert.equal(await failing.backfill(), 0, "fails closed");
});

test("secrets in an output are redacted before they are pushed", async () => {
  const s = setup();
  s.pub.publish(s.job("1b88d9", "T", "token ghp_ABCDEFGHIJKLMNOP1234 here"));
  await waitFor(() => s.remoteFiles().has("research/2026-11-02-1b88d9-t.md"));
  assert.ok(!s.remoteFiles().read("research/2026-11-02-1b88d9-t.md").includes("ghp_ABC"));
});

test("a push failure never fails or delays a job or its message", async () => {
  const store = new Store(tmp("pub-job-store-"));
  const messenger = new ConsoleMessenger();
  let called = 0;
  const jobs = new JobRunner(store, messenger, async () => ({ text: "Full report.\n\n<message_to_paul>All done, see the report.</message_to_paul>" }), undefined, {
    onOutput: () => {
      called++;
      throw new Error("github is down");
    },
  });
  const j = jobs.start("research", "Look into X", FOUNDER);
  await waitFor(() => store.getJob(j.id)!.status === "done" && messenger.sent.length > 0);
  assert.equal(called, 1);
  assert.equal(store.getJob(j.id)!.status, "done");
  assert.ok(messenger.sent.some((m) => m.text.includes("All done")));

  // And a publisher whose git always fails swallows it.
  const s = setup();
  const bad = new OutputsPublisher(s.store, { slug: "a/b", dir: s.dir, fetch: visibility(true), prepare: async () => { throw new Error("no clone"); }, token: async () => "t", log: () => {} });
  const job = s.job("1b88d9", "T", "x");
  bad.publish(job);
  assert.equal(await bad.backfill(), 0);
});

test("only the outputs folder is read: the publisher never touches uploads, and a hostile id is ignored", async () => {
  const s = setup();
  const uploads = path.join(process.env.DATA_DIR!, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, "secret.md"), "PERSONAL CONNECTIONS");
  s.pub.publish({ id: "../uploads/secret", kind: "research", title: "x", brief: "", status: "done", createdAt: "2026-11-02T10:00:00Z" } as Job);
  await s.pub.backfill();
  const r = s.remoteFiles();
  assert.ok(!fs.existsSync(path.join(r.c, "outputs")) || fs.readdirSync(path.join(r.c, "outputs")).every((f) => !f.includes("secret")));
  const src = fs.readFileSync(new URL("../src/publish-outputs.ts", import.meta.url), "utf8");
  assert.ok(!/uploads/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "the module never names uploads in code");
});


test("outputs go into folders by type, and a research job titled as a design goes to designs", async () => {
  const s = setup();
  const mk = (id: string, kind: string, title: string, text = "body") => {
    const j = s.job(id, title, text);
    j.kind = kind as Job["kind"];
    return j;
  };
  const jobs = [
    mk("aaaaa1", "design", "Publisher and buyer platforms spec"),
    mk("dfa5d1", "research", "Two-way Prebid module design"),
    mk("aaaaa2", "research", "Market scan"),
    mk("aaaaa3", "advisor", "Publisher pitch"),
    mk("aaaaa4", "maintain", "Review: X"),
    mk("aaaaa5", "engineer", "Build X"),
  ];
  for (const j of jobs) s.pub.publish(j);
  await waitFor(() => s.remoteFiles().has("reviews/2026-11-02-aaaaa4-review-x.md") && s.remoteFiles().has("engineering/2026-11-02-aaaaa5-build-x.md"));
  const r = s.remoteFiles();
  assert.ok(r.has("designs/2026-11-02-aaaaa1-publisher-and-buyer-platforms-spec.md"));
  assert.ok(r.has("designs/2026-11-02-dfa5d1-two-way-prebid-module-design.md"));
  assert.ok(r.has("research/2026-11-02-aaaaa2-market-scan.md"));
  assert.ok(r.has("advice/2026-11-02-aaaaa3-publisher-pitch.md"));
  const idx = r.read("README.md");
  for (const f of ["designs", "research", "advice", "engineering", "reviews"]) assert.match(idx, new RegExp(`## ${f}\\n`));
  assert.match(idx, /\[read\]\(designs\/2026-11-02-dfa5d1/);
});

test("ea, cv and upload-derived outputs are never copied, and are removed if an earlier layout copied them", async () => {
  const s = setup();
  const ea = s.job("bbbbb1", "Morning brief", "mailbox summary");
  ea.kind = "ea";
  const cv = s.job("bbbbb2", "Master CV", "cv text");
  cv.kind = "cv";
  const up = s.job("bbbbb3", "Warm paths", "ranked from /data/uploads/2026-11-02-Connections.csv");
  const up2 = s.job("bbbbb4", "Prospects", "x");
  up2.brief = "cross-reference Connections.csv with targets";
  const ok = s.job("bbbbb5", "Market scan", "public research");
  assert.deepEqual(classify(ea, "x"), { excluded: "ea outputs are not copied" });
  for (const j of [ea, cv, up, up2, ok]) s.pub.publish(j);
  await waitFor(() => s.remoteFiles().has("research/2026-11-02-bbbbb5-market-scan.md"));
  const r = s.remoteFiles();
  const all = r.read("README.md") + r.read("index.json");
  for (const id of ["bbbbb1", "bbbbb2", "bbbbb3", "bbbbb4"]) assert.ok(!all.includes(id), id);
  assert.ok(!fs.existsSync(path.join(r.c, "ea")) && !fs.existsSync(path.join(r.c, "cv")));

  // Migration: an earlier flat layout had copied the ea output; the next run takes it out of the tree.
  fs.mkdirSync(path.join(s.dir, "outputs"), { recursive: true });
  const old = "outputs/2026-11-02-bbbbb1-morning-brief.md";
  fs.writeFileSync(path.join(s.dir, old), "mailbox summary");
  const idxFile = path.join(s.dir, "index.json");
  const entries = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  entries.push({ id: "bbbbb1", title: "Morning brief", kind: "ea", date: "2026-11-02", at: "2026-11-02T10:00:00.000Z", status: "done", file: old });
  fs.writeFileSync(idxFile, JSON.stringify(entries));
  sh(s.dir, "add", "-A");
  sh(s.dir, "commit", "-m", "old layout");
  sh(s.dir, "push", "origin", "main");
  await s.pub.backfill();
  const after = s.remoteFiles();
  assert.ok(!after.has(old), "removed from the tree");
  assert.ok(!after.read("index.json").includes("bbbbb1"));
});

test("an old flat-layout backfill record does not stop the folder migration", async () => {
  const s = setup();
  s.store.setSetting("outputsBackfilled", "2026-11-02T10:00:00.000Z");
  s.job("ccccc1", "Market scan", "public");
  await backfillOnce(s.store, s.pub);
  assert.ok(s.remoteFiles().has("research/2026-11-02-ccccc1-market-scan.md"));
});
