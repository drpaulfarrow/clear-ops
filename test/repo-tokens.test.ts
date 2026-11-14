import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-repotok-"));
process.env.GH_TOKEN = "ghp_GLOBALTOKENSECRET1234";
process.env.DOUBLESHIFT_TOKEN = "ghp_DOUBLESHIFTSECRET5678";
process.env.REPO_TOKENS = JSON.stringify({ "shftd2-pre/app-doubleshift": "ghp_FROMTHEMAP9999", blog: "ghp_BLOGSECRET1111" });
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY = "";

const { RepoTokens, parseRepoTokenMap, repoTokenEnvName, repoTokenFile, repoTokens, REPO_TOKENS_ENV, credentialLabel } = await import("../src/repo-tokens.js");
const { RepoRegistry, redact, explainCloneFailure, perRepoTokenFix } = await import("../src/repos.js");
const { GithubAuth, healthLine, workerGithubEnv } = await import("../src/github-auth.js");
const { repoCredential, repoCredentialLine, jobCredentialNote, bootstrapRepos, prepareRepo, githubStatusLine } = await import("../src/bootstrap.js");

const DOUBLE = "ghp_DOUBLESHIFTSECRET5678";
const GLOBAL = "ghp_GLOBALTOKENSECRET1234";
const DOUBLE_REPO = { alias: "doubleshift", slug: "shftd2-pre/app-doubleshift" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-repotok-t-"));

/* ---------- the naming style and the map ---------- */

test("a repository's own token is read from FOO_TOKEN, from its alias", () => {
  assert.equal(repoTokenEnvName("doubleshift"), "DOUBLESHIFT_TOKEN");
  assert.equal(repoTokenEnvName("my-site"), "MY_SITE_TOKEN");
  assert.equal(repoTokenEnvName("Site_2"), "SITE_2_TOKEN");
  assert.equal(repoTokenEnvName("doubleshift"), repoTokenEnvName("DOUBLESHIFT"));
});

test("the general map is JSON, and a malformed one is ignored rather than guessed at", () => {
  assert.deepEqual([...parseRepoTokenMap('{"a":"t1","B":"t2"}')], [["a", "t1"], ["b", "t2"]]);
  for (const bad of ["", "not json", "[]", '"x"', "null", '{"a":123}', '{"":""}']) assert.deepEqual([...parseRepoTokenMap(bad)], [], bad);
});

test("per alias: the environment variable wins, then the map by alias, slug or repository name, then nothing", () => {
  const t = new RepoTokens({ env: { DOUBLESHIFT_TOKEN: DOUBLE, BLOG_TOKEN: "ghp_BLOGSECRET1111" }, map: process.env.REPO_TOKENS });
  assert.equal(t.get({ alias: "doubleshift" }), DOUBLE, "the alias variable wins over the map entry for the same repository");
  assert.equal(t.get({ alias: "blog" }), "ghp_BLOGSECRET1111");
  assert.equal(t.get({ slug: "shftd2-pre/app-doubleshift" }), "ghp_FROMTHEMAP9999", "the map can name the full owner/name");
  assert.equal(t.get({ slug: "shftd2-pre/APP-DoubleShift" }), "ghp_FROMTHEMAP9999", "case does not matter");
  assert.equal(t.get({ alias: "product" }), undefined, "a repository without its own token uses the global credentials");
  assert.equal(t.get(undefined), undefined);
  assert.equal(t.has(undefined), false);
  // The name of the variable, never the token.
  assert.equal(t.source({ alias: "doubleshift" }), "DOUBLESHIFT_TOKEN");
  assert.equal(t.source({ slug: "shftd2-pre/app-doubleshift" }), REPO_TOKENS_ENV);
  assert.equal(t.source({ alias: "product" }), undefined);
});

test("no token is ever in the words a message or a log uses", () => {
  const t = new RepoTokens({ env: process.env });
  assert.equal(credentialLabel("repo-token", t.source({ alias: "doubleshift" })), "its own token (DOUBLESHIFT_TOKEN)");
  assert.equal(credentialLabel("app"), "the GitHub App");
  assert.equal(credentialLabel("token"), "GH_TOKEN");
  assert.equal(credentialLabel("none"), "no credentials");
});

/* ---------- precedence: its own token, then the App, then GH_TOKEN ---------- */

test("a repository with its own token is reached with it and never with the App or GH_TOKEN", async () => {
  let minted = 0;
  const fetchFn = (async () => {
    minted++;
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const auth = new GithubAuth({ appId: "1", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----", token: GLOBAL, fetch: fetchFn });
  const own = await repoCredential(DOUBLE_REPO, auth);
  assert.equal(own.token, DOUBLE);
  assert.equal(own.kind, "repo-token");
  assert.equal(own.source, "DOUBLESHIFT_TOKEN");
  assert.equal(minted, 0, "the App is not even asked: this repository's own token is the only credential for it");
  // A repository without its own token is unchanged: the App when configured, else GH_TOKEN.
  const other = await repoCredential({ alias: "product", slug: "drpaulfarrow/clear-exchange" }, new GithubAuth({ token: GLOBAL }));
  assert.deepEqual(other, { token: GLOBAL, kind: "token" });
  const none = await repoCredential({ alias: "product" }, new GithubAuth({ token: "" }));
  assert.equal(none.kind, "none");
  assert.equal(none.token, "");
});

test("the health report checks a repository with its own token using that token", async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    seen.push(`${url} ${auth}`);
    // The global credential has no access to the doubleshift repository; its own token does.
    return new Response("{}", { status: auth === `Bearer ${DOUBLE}` ? 200 : 404 });
  }) as unknown as typeof fetch;
  const auth = new GithubAuth({ token: GLOBAL, fetch: fetchFn });
  const h = await auth.health([{ slug: DOUBLE_REPO.slug!, alias: "doubleshift" }, "drpaulfarrow/clear-exchange"]);
  assert.deepEqual(
    h.repos.map((r) => [r.slug, r.reachable]),
    [[DOUBLE_REPO.slug, true], ["drpaulfarrow/clear-exchange", false]],
  );
  assert.equal(h.repos[0].credential, "its own token (DOUBLESHIFT_TOKEN)");
  assert.equal(h.repos[1].credential, undefined, "a repository on the global credential is reported as before");
  assert.ok(seen[0].endsWith(`Bearer ${DOUBLE}`));
  assert.ok(seen[1].endsWith(`Bearer ${GLOBAL}`));
  assert.ok(!healthLine(h).includes(DOUBLE) && !healthLine(h).includes(GLOBAL));
});

/* ---------- the one plain line ---------- */

test("the credential line names every repository's credential, in words, never a token", async () => {
  const registry = new RepoRegistry({ product: "drpaulfarrow/clear-exchange", self: "drpaulfarrow/clear-ops", extra: "doubleshift=shftd2-pre/app-doubleshift", reposDir: "/tmp/r" });
  const line = repoCredentialLine(registry, new GithubAuth({ token: GLOBAL }));
  assert.match(line, /^GitHub credentials by repository: /);
  assert.match(line, /product \(drpaulfarrow\/clear-exchange\) via GH_TOKEN/);
  assert.match(line, /doubleshift \(shftd2-pre\/app-doubleshift\) via its own token \(DOUBLESHIFT_TOKEN\)/);
  assert.equal(line.split("\n").length, 1, "one plain line");
  assert.ok(!line.includes(DOUBLE) && !line.includes(GLOBAL));
  const note = jobCredentialNote("doubleshift", registry, new GithubAuth({ token: GLOBAL }));
  assert.equal(note, "Reached doubleshift (shftd2-pre/app-doubleshift) with its own token (DOUBLESHIFT_TOKEN).");
  assert.equal(jobCredentialNote("product", registry, new GithubAuth({ token: GLOBAL })), "", "a repository on the global credential adds no line to a job's report");
  const status = await githubStatusLine(registry, new GithubAuth({ token: GLOBAL, fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch }));
  assert.match(status, /GitHub credentials by repository: /);
  assert.ok(!status.includes(DOUBLE));
});

/* ---------- redaction ---------- */

test("redact strips a per-repository token however it was set", () => {
  const t = new RepoTokens({ env: { BLOG_TOKEN: "ghp_BLOGSECRET1111" }, map: process.env.REPO_TOKENS });
  for (const secret of t.secrets(["doubleshift", "blog"])) {
    const out = redact(`fatal: ${secret} refused`, GLOBAL);
    assert.ok(!out.includes(secret), secret);
    assert.match(out, /\*\*\*/);
  }
  const out = redact(`token ${GLOBAL} and ${DOUBLE} and ${GLOBAL}`);
  assert.ok(!out.includes(GLOBAL) && !out.includes(DOUBLE));
  assert.ok(redact(`https://x-access-token:${DOUBLE}@github.com/x/y`).includes("x-access-token:***@"));
});

/* ---------- the clone, the push and the checkout ---------- */

test("a clone of a repository with its own token uses that token, and no token is written into the checkout", async () => {
  const dir = tmp();
  const work = path.join(dir, "doubleshift");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "git.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const said: string[] = [];
  try {
    await prepareRepo(DOUBLE_REPO.slug!, work, undefined, (m) => said.push(m), new GithubAuth({ token: GLOBAL }), "doubleshift");
  } finally {
    process.env.PATH = oldPath;
  }
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, new RegExp(`clone --quiet https://x-access-token:${DOUBLE}@github.com/shftd2-pre/app-doubleshift`));
  assert.ok(!calls.includes(GLOBAL), "the global token is not used for this repository");
  assert.ok(!said.join("\n").includes(DOUBLE) && !said.join("\n").includes(GLOBAL), "nothing logged carries a token");
  // The token is kept owner-only outside the checkout, and git reads it at call time.
  const file = repoTokenFile("doubleshift");
  assert.equal(fs.readFileSync(file, "utf8"), DOUBLE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(file.startsWith(process.env.DATA_DIR!) && !file.startsWith(work), "outside the checkout");
});

test("git's credential helper reads the repository's own token file, so no token sits in .git/config", async () => {
  const dir = tmp();
  const work = path.join(dir, "checkout");
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q"], { cwd: work });
  await prepareRepo(DOUBLE_REPO.slug!, work, undefined, () => undefined, new GithubAuth({ token: GLOBAL }), "doubleshift");
  const config = fs.readFileSync(path.join(work, ".git", "config"), "utf8");
  assert.ok(!config.includes(DOUBLE) && !config.includes(GLOBAL), "no token in .git/config");
  assert.ok(config.includes(repoTokenFile("doubleshift")));
  const out = execFileSync("git", ["credential", "fill"], { cwd: work, input: "protocol=https\nhost=github.com\n\n" }).toString();
  assert.match(out, /username=x-access-token/);
  assert.match(out, new RegExp(`password=${DOUBLE}`));
});

test("a repository without its own token is unchanged: the global token still clones it", async () => {
  const dir = tmp();
  const work = path.join(dir, "product");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "git.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    await prepareRepo("drpaulfarrow/clear-exchange", work, undefined, () => undefined, new GithubAuth({ token: GLOBAL }), "product");
  } finally {
    process.env.PATH = oldPath;
  }
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, new RegExp(`x-access-token:${GLOBAL}@github.com/drpaulfarrow/clear-exchange`));
  assert.ok(!calls.includes(DOUBLE));
});

/* ---------- the worker's environment ---------- */

test("the worker for a repository with its own token gets that token and nothing else's", async () => {
  const auth = new GithubAuth({ token: GLOBAL });
  const base = { GH_TOKEN: GLOBAL, GITHUB_TOKEN: GLOBAL, PATH: "/usr/bin", DOUBLESHIFT_TOKEN: DOUBLE, BLOG_TOKEN: "ghp_BLOGSECRET1111", [REPO_TOKENS_ENV]: "{}" };
  const env = await workerGithubEnv(base, auth, DOUBLE_REPO, ["product", "self", "site", "doubleshift", "blog"]);
  assert.equal(env.GH_TOKEN, DOUBLE);
  assert.equal(env.GITHUB_TOKEN, DOUBLE);
  assert.equal(env.PATH, "/usr/bin", "no App wrapper: the App may have no access to this repository");
  // No other repository's token travels with this job.
  for (const k of ["DOUBLESHIFT_TOKEN", "BLOG_TOKEN", REPO_TOKENS_ENV]) assert.equal(env[k], undefined, k);
  // Another repository's worker never gets this one's token.
  const other = await workerGithubEnv({ ...base, GH_TOKEN: GLOBAL }, auth, { alias: "product", slug: "drpaulfarrow/clear-exchange" }, ["doubleshift", "blog"]);
  assert.equal(other.GH_TOKEN, GLOBAL);
  assert.equal(other.DOUBLESHIFT_TOKEN, undefined);
  assert.equal(other.BLOG_TOKEN, undefined);
  assert.ok(!JSON.stringify(other).includes(DOUBLE));
});

/* ---------- the job's own report ---------- */

test("a job in a repository with its own token says which credential reached it, and the chat message is untouched", async () => {
  const { addToReport, splitReport, MESSAGE_OPEN, MESSAGE_CLOSE } = await import("../src/messages.js");
  const note = "Reached doubleshift (shftd2-pre/app-doubleshift) with its own token (DOUBLESHIFT_TOKEN).";
  const answer = `Pushed the branch and opened the pull request.\n\n${MESSAGE_OPEN}\nIt is up for review, nothing needs you.\n${MESSAGE_CLOSE}`;
  const withNote = addToReport(answer, note);
  const { report, message } = splitReport(withNote);
  assert.equal(report, `Pushed the branch and opened the pull request.\n\n${note}`);
  assert.equal(message, "It is up for review, nothing needs you.", "Paul's short message never grows the credential line");
  // A worker that sends no message block keeps the line at the end of its report.
  assert.equal(splitReport(addToReport("Done.", note)).report, `Done.\n\n${note}`);
  // An empty note (a repository on the App or GH_TOKEN) leaves the answer exactly as it was.
  assert.equal(addToReport(answer, ""), answer);
});

test("an engineering job's prompt names the credential for its repository, and never a token", async () => {
  const { workerSpec } = await import("../src/agents.js");
  const { repoRegistry } = await import("../src/repos.js");
  repoRegistry.add({ alias: "doubleshift", slug: "shftd2-pre/app-doubleshift" });
  const p = workerSpec("engineer", "doubleshift").prompt;
  assert.match(p, /GitHub access: you reach doubleshift \(shftd2-pre\/app-doubleshift\) with its own token \(DOUBLESHIFT_TOKEN\)/);
  assert.match(p, /say which credential you used in one line of your report/);
  assert.ok(!p.includes(DOUBLE) && !p.includes(GLOBAL));
  assert.match(workerSpec("engineer", "product").prompt, /you reach product[^.]* with GH_TOKEN/, "the global credential is named too");
  assert.doesNotMatch(workerSpec("research", "product").prompt, /GitHub access:/, "a read-only kind is not told about credentials");
});

/* ---------- honest failure ---------- */

test("a failure on a repository with its own token names that secret, and never a vague fallback", () => {
  const msg = explainCloneFailure(DOUBLE_REPO.slug!, "remote: Repository not found", DOUBLE_REPO);
  assert.match(msg, /its own token \(DOUBLESHIFT_TOKEN\), which is the only credential I use for it/);
  assert.match(msg, /replace the DOUBLESHIFT_TOKEN secret in the clear-ops repository/);
  assert.match(msg, /re-run the latest deploy workflow/);
  assert.doesNotMatch(msg, /GH_TOKEN\)? cannot reach|using the old GH_TOKEN/);
  assert.ok(!msg.includes(DOUBLE));
});

test("a repository that no credential reaches is told the per-repo option, with the secret, the scopes and the deploy", () => {
  const msg = explainCloneFailure("o/notes", "Repository not found", { alias: "notes", slug: "o/notes" });
  assert.match(msg, /add it as the NOTES_TOKEN secret in the clear-ops repository/);
  assert.match(msg, /classic token with the "repo" and "workflow" scopes/);
  assert.match(msg, /re-run the latest deploy workflow/);
  assert.ok(!msg.includes(DOUBLE));
  // The same sentence without an alias, derived from the repository name.
  assert.match(perRepoTokenFix("o/notes"), /NOTES_TOKEN/);
  assert.match(perRepoTokenFix("o/notes", "notes"), /NOTES_TOKEN/);
});

test("start-up: a repository reached with its own token clones with it, and the log says which credential", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-repotok-boot-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "git.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`, { mode: 0o755 });
  const registry = new RepoRegistry({ extra: "doubleshift=shftd2-pre/app-doubleshift", reposDir: path.join(dir, "repos"), productDir: path.join(dir, "product"), selfDir: path.join(dir, "self"), product: undefined, self: undefined });
  const lines: string[] = [];
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const problems = await bootstrapRepos((m) => lines.push(m), registry);
    assert.deepEqual(problems, []);
  } finally {
    process.env.PATH = oldPath;
  }
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, new RegExp(`x-access-token:${DOUBLE}@github.com/shftd2-pre/app-doubleshift`));
  const all = lines.join("\n");
  assert.ok(!all.includes(DOUBLE) && !all.includes(GLOBAL), "the start-up log carries no token");
  assert.match(repoCredentialLine(registry, new GithubAuth({ token: GLOBAL })), /doubleshift \(shftd2-pre\/app-doubleshift\) via its own token \(DOUBLESHIFT_TOKEN\)/);
});

test("a repository nothing can reach keeps the plain message and adds the per-repo fix", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-repotok-boot2-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "remote: Repository not found." >&2\nexit 128\n`, { mode: 0o755 });
  // One repository the App and GH_TOKEN cannot reach, and one that has its own token and is refused with it.
  const registry = new RepoRegistry({ extra: "notes=o/notes,doubleshift=shftd2-pre/app-doubleshift", reposDir: path.join(dir, "repos"), productDir: path.join(dir, "product"), selfDir: path.join(dir, "self"), product: undefined, self: undefined });
  const lines: string[] = [];
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const problems = await bootstrapRepos((m) => lines.push(m), registry);
    assert.deepEqual(problems.map((p) => p.alias), ["notes", "doubleshift"]);
    assert.match(problems[0].plain, /add it as the NOTES_TOKEN secret in the clear-ops repository/);
    assert.match(problems[0].plain, /classic token with the "repo" and "workflow" scopes/);
    assert.match(problems[0].plain, /re-run the latest deploy workflow/);
    assert.match(problems[1].plain, /its own token \(DOUBLESHIFT_TOKEN\), which is the only credential I use for it/);
    assert.ok(!problems.some((p) => p.plain.includes(DOUBLE)) && !lines.join("\n").includes(DOUBLE));
  } finally {
    process.env.PATH = oldPath;
  }
});
