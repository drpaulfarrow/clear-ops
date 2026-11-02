import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ghapp-"));
delete process.env.GH_TOKEN;
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.GITHUB_APP_INSTALLATION_ID;

const { GithubAuth, signAppJwt, normalisePem, healthLine, healthProblem, workerGithubEnv, installGhWrapper, AppAuthError } = await import("../src/github-auth.js");
const { RepoRegistry, createRepo, explainCreateFailure, explainCloneFailure, redact } = await import("../src/repos.js");
const { githubStatusLine, prepareRepo } = await import("../src/bootstrap.js");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PAT = "ghp_CLASSICTOKENSECRET9999";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ghapp-t-"));

/** A fake GitHub: installation lookup, token minting, repo reads. Records every call. */
function fakeGithub(opts: { reject?: number; repos?: Record<string, number>; ttlMs?: number; clock?: () => number } = {}) {
  const calls: Array<{ url: string; method: string; auth: string }> = [];
  let minted = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    calls.push({ url: u, method: init?.method ?? "GET", auth });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (opts.reject) return json(opts.reject, { message: "Bad credentials" });
    if (u.endsWith("/installation")) return json(200, { id: 4242 });
    if (u.includes("/access_tokens")) {
      minted++;
      const now = opts.clock?.() ?? Date.now();
      return json(201, { token: `ghs_installation${minted}`, expires_at: new Date(now + (opts.ttlMs ?? 3_600_000)).toISOString() });
    }
    const m = u.match(/\/repos\/(.+)$/);
    if (m) return json(opts.repos?.[m[1]] ?? 200, {});
    return json(404, {});
  }) as typeof fetch;
  return { fetchFn, calls, minted: () => minted };
}

test("the App JWT is RS256, verifies with the public key and carries the App id", () => {
  const jwt = signAppJwt("12345", privateKey, 1_700_000_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.iss, "12345");
  assert.equal(claims.iat, 1_700_000_000 - 60);
  assert.ok(claims.exp - claims.iat <= 600, "GitHub allows at most ten minutes");
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")));
  // A key pasted into a secret with literal \n sequences or quotes still works.
  const pasted = `"${privateKey.trim().replace(/\n/g, "\\n")}"`;
  assert.equal(normalisePem(pasted), privateKey);
  assert.ok(signAppJwt("1", pasted));
});

test("modes: App when configured, GH_TOKEN as the fallback, none otherwise", () => {
  assert.equal(new GithubAuth({ appId: "1", privateKey, token: PAT }).mode(), "app");
  assert.equal(new GithubAuth({ appId: "1", privateKey: "", token: PAT }).mode(), "token");
  assert.equal(new GithubAuth({ appId: "", privateKey, token: "" }).mode(), "none");
  assert.equal(new GithubAuth({ token: "" }).mode(), "none");
});

test("discovers the installation once, mints a token and caches it", async () => {
  const gh = fakeGithub();
  const auth = new GithubAuth({ appId: "1", privateKey, token: "", fetch: gh.fetchFn, owner: "drpaulfarrow" });
  assert.equal(await auth.token(), "ghs_installation1");
  assert.equal(await auth.token(), "ghs_installation1");
  assert.equal(gh.minted(), 1);
  assert.equal(gh.calls.filter((c) => c.url.endsWith("/users/drpaulfarrow/installation")).length, 1);
  const mint = gh.calls.find((c) => c.url.includes("/app/installations/4242/access_tokens"));
  assert.equal(mint?.method, "POST");
  assert.match(mint!.auth, /^Bearer eyJ/, "the mint call is signed with the JWT");
});

test("a configured installation id skips discovery", async () => {
  const gh = fakeGithub();
  const auth = new GithubAuth({ appId: "1", privateKey, installationId: "77", token: "", fetch: gh.fetchFn });
  await auth.token();
  assert.ok(!gh.calls.some((c) => c.url.includes("/installation") && !c.url.includes("access_tokens")));
  assert.ok(gh.calls.some((c) => c.url.includes("/app/installations/77/access_tokens")));
});

test("re-mints shortly before expiry, and concurrent callers share one mint", async () => {
  let now = 1_800_000_000_000;
  const gh = fakeGithub({ clock: () => now, ttlMs: 3_600_000 });
  const auth = new GithubAuth({ appId: "1", privateKey, token: "", fetch: gh.fetchFn, now: () => now });
  const [a, b, c] = await Promise.all([auth.token(), auth.token(), auth.token()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(gh.minted(), 1);
  now += 54 * 60_000; // six minutes left: still cached
  assert.equal(await auth.token(), "ghs_installation1");
  now += 2 * 60_000; // four minutes left: inside the five minute margin
  assert.equal(await auth.token(), "ghs_installation2");
  assert.equal(gh.minted(), 2);
});

test("falls back to GH_TOKEN when the App cannot sign in, and says so", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const auth = new GithubAuth({ appId: "1", privateKey, token: PAT, fetch: fakeGithub({ reject: 401 }).fetchFn });
    assert.equal(await auth.token(), PAT);
    const h = await auth.health(["drpaulfarrow/clear-ops"]);
    assert.equal(h.mode, "app");
    assert.equal(h.effective, "token");
    assert.match(h.appError ?? "", /rejected the App's private key/);
    assert.match(healthProblem(h) ?? "", /Meanwhile I am using the old GH_TOKEN/);
    assert.match(healthLine(h), /GitHub App failing, using GH_TOKEN instead/);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.length >= 1);
  for (const line of errors) assert.ok(!line.includes(PAT) && !line.includes("PRIVATE KEY"), "logs carry no secret");
});

test("with no App, GH_TOKEN is used exactly as before and no file is written", async () => {
  const dir = tmp();
  const auth = new GithubAuth({ token: PAT, tokenFile: path.join(dir, "t") });
  assert.equal(await auth.token(), PAT);
  assert.equal(await auth.refreshFile(), false);
  assert.ok(!fs.existsSync(path.join(dir, "t")));
  const env = await workerGithubEnv({ GH_TOKEN: PAT, PATH: "/usr/bin", GITHUB_APP_PRIVATE_KEY: "x" }, auth);
  assert.equal(env.GH_TOKEN, PAT);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GITHUB_APP_PRIVATE_KEY, undefined, "the App key never reaches a worker");
});

test("worker env with the App: fresh token file, wrapper first on PATH, no classic token, no key", async () => {
  const dir = tmp();
  const gh = fakeGithub();
  const file = path.join(dir, "secrets", "tok");
  const auth = new GithubAuth({ appId: "1", privateKey, token: PAT, fetch: gh.fetchFn, tokenFile: file });
  const env = await workerGithubEnv({ GH_TOKEN: PAT, GITHUB_TOKEN: PAT, PATH: "/usr/bin", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_ID: "1" }, auth);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(env.GITHUB_APP_ID, undefined);
  assert.ok(env.PATH!.startsWith(path.join(process.env.DATA_DIR!, "bin")));
  assert.equal(fs.readFileSync(file, "utf8"), "ghs_installation1");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "owner-only");
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(env).includes("ghs_installation"), "the token is not in the environment either");
  // The wrapper reads the file at call time and holds no token itself.
  const wrapper = fs.readFileSync(path.join(process.env.DATA_DIR!, "bin", "gh"), "utf8");
  assert.ok(!wrapper.includes("ghs_") && !wrapper.includes(PAT));
  assert.match(wrapper, /cat /);
});

test("the gh wrapper hands gh the file's current token", () => {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  const real = path.join(dir, "realbin");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "gh"), '#!/bin/sh\necho "token=$GH_TOKEN"\n', { mode: 0o755 });
  const file = path.join(dir, "tok");
  fs.writeFileSync(file, "ghs_one");
  const auth = new GithubAuth({ appId: "1", privateKey, tokenFile: file });
  const oldPath = process.env.PATH;
  process.env.PATH = `${real}${path.delimiter}${oldPath}`;
  try {
    installGhWrapper(auth, bin);
  } finally {
    process.env.PATH = oldPath;
  }
  const run = () => execFileSync(path.join(bin, "gh"), [], { env: { PATH: "/usr/bin:/bin", GH_TOKEN: "stale" } }).toString().trim();
  assert.equal(run(), "token=ghs_one");
  fs.writeFileSync(file, "ghs_two"); // a refresh during a long job
  assert.equal(run(), "token=ghs_two");
});

test("git's credential helper reads the token file, so no token is stored in the checkout", async () => {
  const dir = tmp();
  const work = path.join(dir, "checkout");
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q"], { cwd: work });
  const file = path.join(dir, "secrets", "tok");
  const auth = new GithubAuth({ appId: "1", privateKey, token: "", fetch: fakeGithub().fetchFn, tokenFile: file });
  await prepareRepo("drpaulfarrow/clear-ops", work, undefined, () => undefined, auth);
  const config = fs.readFileSync(path.join(work, ".git", "config"), "utf8");
  assert.ok(!config.includes("ghs_"), "no token in .git/config");
  assert.ok(config.includes(file));
  const out = execFileSync("git", ["credential", "fill"], { cwd: work, input: "protocol=https\nhost=github.com\n\n" }).toString();
  assert.match(out, /username=x-access-token/);
  assert.match(out, /password=ghs_installation1/);
});

test("reachability report: which repositories the active auth can reach, without secrets", async () => {
  const gh = fakeGithub({ repos: { "drpaulfarrow/secret-repo": 404 } });
  const auth = new GithubAuth({ appId: "1", privateKey, token: PAT, fetch: gh.fetchFn });
  const registry = new RepoRegistry({ product: "drpaulfarrow/clear-exchange", self: "drpaulfarrow/clear-ops", extra: "x=drpaulfarrow/secret-repo" });
  const line = await githubStatusLine(registry, auth);
  assert.match(line, /GitHub: GitHub App\./);
  assert.match(line, /Reachable: drpaulfarrow\/clear-exchange, drpaulfarrow\/clear-ops\./);
  assert.match(line, /Not reachable: drpaulfarrow\/secret-repo \(no access\)\./);
  assert.match(line, /creating repos: GH_TOKEN/);
  for (const secret of [PAT, "ghs_", "eyJ", "PRIVATE KEY"]) assert.ok(!line.includes(secret));
  const h = await auth.health(["drpaulfarrow/clear-ops", "drpaulfarrow/secret-repo"]);
  const msg = healthProblem(h)!;
  assert.match(msg, /cannot reach drpaulfarrow\/secret-repo/);
  assert.match(msg, /All repositories/);
  assert.ok(!msg.includes(PAT));
  assert.equal(healthProblem({ ...h, repos: [{ slug: "a/b", reachable: true }] }), undefined);
});

test("status line for token mode and for no credentials", async () => {
  const tokenAuth = new GithubAuth({ token: PAT, fetch: fakeGithub().fetchFn });
  assert.match(healthLine(await tokenAuth.health(["a/b"])), /GitHub: GH_TOKEN\. Reachable: a\/b\./);
  const none = new GithubAuth({ token: "", fetch: fakeGithub().fetchFn });
  const h = await none.health(["a/b"]);
  assert.match(healthLine(h), /no GitHub credentials/);
  assert.match(healthProblem(h)!, /docs\/GITHUB_APP\.md/);
});

test("an App that is not installed tells Paul exactly what to do", async () => {
  const fetchFn = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  const auth = new GithubAuth({ appId: "1", privateKey, token: "", fetch: fetchFn, owner: "drpaulfarrow" });
  await assert.rejects(auth.appToken(), (e: unknown) => e instanceof AppAuthError && /not installed on drpaulfarrow.*All repositories/.test(e.plain));
});

test("a bad private key is a plain error that never echoes the key", async () => {
  const auth = new GithubAuth({ appId: "1", privateKey: "-----BEGIN PRIVATE KEY-----\nnotakey\n-----END PRIVATE KEY-----", token: "", fetch: fakeGithub().fetchFn });
  await assert.rejects(auth.appToken(), (e: unknown) => e instanceof AppAuthError && /not a valid PEM/.test(e.plain) && !e.plain.includes("notakey"));
});

test("repo creation still uses GH_TOKEN, never the App, and the error says why", async () => {
  const gh = fakeGithub();
  const auth = new GithubAuth({ appId: "1", privateKey, token: PAT, fetch: gh.fetchFn });
  await auth.token(); // the App is live and has a token
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  try {
    const seen: string[] = [];
    const registry = new RepoRegistry({ product: "o/p", self: "o/s", extra: "" });
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).authorization));
      return new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      createRepo({ name: "pitch" }, { registry, store: { addCreatedRepo() {} }, fetch: fetchFn, clone: async () => {}, token: PAT, owner: "drpaulfarrow" }),
      (e: Error & { plain?: string }) => /classic token/.test(e.plain ?? "") && /GitHub does not let an App create repositories on a personal account/.test(e.plain ?? ""),
    );
    assert.deepEqual(seen, [`Bearer ${PAT}`]);
    assert.match(explainCloneFailure("drpaulfarrow/x", "Repository not found"), /GitHub App.*All repositories/);
    assert.match(explainCreateFailure(401, "o", "n"), /GitHub App/);
    // No GH_TOKEN at all: says plainly what is needed.
    await assert.rejects(
      createRepo({ name: "pitch" }, { registry, store: { addCreatedRepo() {} }, fetch: fetchFn, clone: async () => {}, token: "", owner: "o" }),
      (e: Error & { plain?: string }) => /GH_TOKEN is not set/.test(e.plain ?? "") && /does not let an App create repositories/.test(e.plain ?? ""),
    );
  } finally {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  }
});

test("redact strips installation tokens, JWTs and PEM keys from text", () => {
  const jwt = signAppJwt("1", privateKey);
  const text = `failed with ghs_abcdef123456 and ${jwt} and ${privateKey}`;
  const out = redact(text, "");
  assert.ok(!out.includes("ghs_abcdef") && !out.includes(jwt) && !out.includes("BEGIN PRIVATE KEY"));
});
