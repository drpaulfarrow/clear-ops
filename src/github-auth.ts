import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * How the workforce authenticates to GitHub.
 *
 * - "app": a GitHub App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, optional GITHUB_APP_INSTALLATION_ID).
 *   The service signs an RS256 JWT, exchanges it for a one-hour installation token and caches it
 *   until shortly before it expires. Repositories added to the installation ("All repositories")
 *   are reachable with no token edits.
 * - "token": the classic or fine-grained personal token GH_TOKEN, as before.
 * - "none": neither is set.
 *
 * Creating a repository is the one thing the App cannot do for a personal account: that endpoint
 * (POST /user/repos) acts as a user, and an installation token is not a user. Repo creation keeps
 * using GH_TOKEN (a classic token) and nothing here changes that.
 */
export type AuthMode = "app" | "token" | "none";

const API = "https://api.github.com";
/** Re-mint this long before GitHub's expiry. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const GH_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "clear-ops" };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Accepts a PEM with real newlines, or one pasted with literal "\n" sequences or quotes, as secrets often are. */
export function normalisePem(raw: string): string {
  let pem = raw.trim().replace(/^["']|["']$/g, "");
  if (!pem.includes("\n") && pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return pem.trim() + "\n";
}

/** A GitHub App JWT: RS256, issued 60 seconds in the past for clock drift, valid ten minutes at most. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60 + 60, iss: appId }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), normalisePem(privateKeyPem));
  return `${header}.${payload}.${b64url(signature)}`;
}

/** A failure to authenticate as the App, in words Paul can act on. Never carries a token or key. */
export class AppAuthError extends Error {
  constructor(readonly plain: string) {
    super(plain);
    this.name = "AppAuthError";
  }
}

export interface GithubAuthOptions {
  appId?: string;
  privateKey?: string;
  installationId?: string;
  /** The fallback personal token. */
  token?: string;
  owner?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where the current installation token is kept for git and gh (owner-only, outside every checkout). */
  tokenFile?: string;
}

interface Cached {
  token: string;
  expiresAt: number;
}

export class GithubAuth {
  private cached?: Cached;
  private installationId?: string;
  private inflight?: Promise<string>;
  private readonly opts: GithubAuthOptions;

  constructor(opts: GithubAuthOptions = {}) {
    this.opts = opts;
    this.installationId = (opts.installationId ?? process.env.GITHUB_APP_INSTALLATION_ID ?? "").trim() || undefined;
  }

  private get appId() {
    return (this.opts.appId ?? process.env.GITHUB_APP_ID ?? "").trim();
  }
  private get privateKey() {
    return this.opts.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY ?? "";
  }
  private get pat() {
    return this.opts.token ?? process.env.GH_TOKEN ?? "";
  }
  private get doFetch() {
    return this.opts.fetch ?? fetch;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  get owner() {
    return this.opts.owner ?? config.repos.owner;
  }
  get tokenFile() {
    return this.opts.tokenFile ?? path.join(config.dataDir, "secrets", "github-installation-token");
  }

  /** Which credentials are in use: the App when fully configured, else GH_TOKEN, else none. */
  mode(): AuthMode {
    if (this.appId && this.privateKey.trim()) return "app";
    return this.pat ? "token" : "none";
  }

  /** True when GH_TOKEN is set, whatever the mode: it is what creates repositories. */
  hasCreateToken(): boolean {
    return Boolean(this.pat);
  }

  private async api(pathname: string, init: RequestInit & { bearer: string }): Promise<{ status: number; body: Record<string, unknown> }> {
    const { bearer, ...rest } = init;
    let res: Response;
    try {
      res = await this.doFetch(`${API}${pathname}`, { ...rest, headers: { ...GH_HEADERS, authorization: `Bearer ${bearer}` } });
    } catch {
      throw new AppAuthError("I could not reach GitHub to sign in as the GitHub App. This is usually brief; ask me to try again in a few minutes.");
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // no body
    }
    return { status: res.status, body };
  }

  /** The installation to mint tokens for: the configured id, else the App's installation on the owner's account. */
  private async resolveInstallation(jwt: string): Promise<string> {
    if (this.installationId) return this.installationId;
    const r = await this.api(`/users/${encodeURIComponent(this.owner)}/installation`, { bearer: jwt });
    if (r.status === 200 && (typeof r.body.id === "number" || typeof r.body.id === "string")) {
      this.installationId = String(r.body.id);
      return this.installationId;
    }
    if (r.status === 401) throw new AppAuthError(APP_REJECTED);
    if (r.status === 404) throw new AppAuthError(`The GitHub App is not installed on ${this.owner}. Open the App's page on GitHub, choose Install App, pick ${this.owner} and choose All repositories. Nothing else needs changing.`);
    throw new AppAuthError(`GitHub returned an error (${r.status}) looking up the App's installation. Ask me to try again in a few minutes.`);
  }

  private async mint(): Promise<Cached> {
    if (!this.appId || !this.privateKey.trim()) throw new AppAuthError("The GitHub App is not configured.");
    let jwt: string;
    try {
      jwt = signAppJwt(this.appId, this.privateKey, this.now());
    } catch {
      throw new AppAuthError("The GitHub App private key (GITHUB_APP_PRIVATE_KEY) is not a valid PEM. Paste the whole .pem file, including the BEGIN and END lines, into that secret in the clear-ops repository and re-run the latest deploy workflow.");
    }
    const id = await this.resolveInstallation(jwt);
    const r = await this.api(`/app/installations/${encodeURIComponent(id)}/access_tokens`, { method: "POST", bearer: jwt });
    if (r.status === 201 && typeof r.body.token === "string") {
      const exp = typeof r.body.expires_at === "string" ? Date.parse(r.body.expires_at) : NaN;
      return { token: r.body.token, expiresAt: Number.isFinite(exp) ? exp : this.now() + 55 * 60_000 };
    }
    if (r.status === 401) throw new AppAuthError(APP_REJECTED);
    if (r.status === 404) {
      this.installationId = this.opts.installationId ?? undefined;
      throw new AppAuthError(`GitHub could not find the App installation${this.opts.installationId || process.env.GITHUB_APP_INSTALLATION_ID ? " (check GITHUB_APP_INSTALLATION_ID, or delete that secret and I will find it)" : ""}. Check the App is installed on ${this.owner}.`);
    }
    throw new AppAuthError(`GitHub returned an error (${r.status}) giving the App a token. Ask me to try again in a few minutes.`);
  }

  /** A valid installation token, minted if there is none or it expires within five minutes. */
  async appToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > REFRESH_MARGIN_MS) return this.cached.token;
    // One mint at a time, however many jobs ask at once.
    this.inflight ??= this.mint()
      .then((c) => {
        this.cached = c;
        return c.token;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /**
   * The token to use for git and gh now, or "" with none configured. The App when configured; if the
   * App cannot sign in, falls back to GH_TOKEN so work carries on, and the problem is reported by
   * `health()`.
   */
  async token(): Promise<string> {
    if (this.mode() === "app") {
      try {
        return await this.appToken();
      } catch (err) {
        console.error(`GitHub App sign-in failed${this.pat ? ", falling back to GH_TOKEN" : ""}: ${err instanceof AppAuthError ? err.plain : "unexpected error"}`);
        return this.pat;
      }
    }
    return this.pat;
  }

  /** Mints if due and writes the token where git's credential helper and the gh wrapper read it. Returns whether the App is in use. */
  async refreshFile(): Promise<boolean> {
    if (this.mode() !== "app") return false;
    let token: string;
    try {
      token = await this.appToken();
    } catch (err) {
      console.error(`GitHub App token refresh failed: ${err instanceof AppAuthError ? err.plain : "unexpected error"}`);
      return false;
    }
    const file = this.tokenFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  }

  /** Forgets the cached token (tests, or after GitHub rejects it). */
  reset(): void {
    this.cached = undefined;
  }

  /**
   * Which auth is active and which of the given repositories it can reach. Checks each with a cheap
   * GET /repos/{slug}. Never returns or logs a secret.
   */
  async health(slugs: string[]): Promise<AuthHealth> {
    const mode = this.mode();
    const out: AuthHealth = { mode, createRepos: this.hasCreateToken(), repos: [] };
    if (mode === "app") {
      try {
        await this.appToken();
      } catch (err) {
        out.appError = err instanceof AppAuthError ? err.plain : "The GitHub App could not sign in.";
      }
    }
    const token = out.appError ? this.pat : await this.token();
    const effective: AuthMode = out.appError ? (this.pat ? "token" : "none") : mode;
    out.effective = effective;
    for (const slug of slugs) {
      if (!token) {
        out.repos.push({ slug, reachable: false, detail: "no credentials" });
        continue;
      }
      try {
        const r = await this.api(`/repos/${slug}`, { bearer: token });
        out.repos.push({ slug, reachable: r.status === 200, detail: r.status === 200 ? undefined : r.status === 404 || r.status === 403 ? "no access" : `error ${r.status}` });
      } catch {
        out.repos.push({ slug, reachable: false, detail: "GitHub unreachable" });
      }
    }
    return out;
  }
}

const APP_REJECTED = "GitHub rejected the App's private key or App ID. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY in the clear-ops repository secrets match the App, generate a new private key if unsure, then re-run the latest deploy workflow.";

export interface AuthHealth {
  /** Configured mode. */
  mode: AuthMode;
  /** What is actually being used: differs from mode when the App fails and GH_TOKEN takes over. */
  effective?: AuthMode;
  /** GH_TOKEN present, so repositories can be created. */
  createRepos: boolean;
  appError?: string;
  repos: Array<{ slug: string; reachable: boolean; detail?: string }>;
}

/** One line for /status and the start-up log. No secrets. */
export function healthLine(h: AuthHealth): string {
  const use = h.effective ?? h.mode;
  const auth = h.mode === "app" ? (use === "app" ? "GitHub App" : "GitHub App failing, using GH_TOKEN instead") : h.mode === "token" ? "GH_TOKEN" : "no GitHub credentials";
  const ok = h.repos.filter((r) => r.reachable).map((r) => r.slug);
  const bad = h.repos.filter((r) => !r.reachable).map((r) => `${r.slug} (${r.detail ?? "unreachable"})`);
  const create = h.createRepos ? "creating repos: GH_TOKEN" : "creating repos: off (needs a classic GH_TOKEN)";
  return `GitHub: ${auth}. Reachable: ${ok.length ? ok.join(", ") : "none"}.${bad.length ? ` Not reachable: ${bad.join(", ")}.` : ""} ${create}.`;
}

/** One plain message for Paul when the App is failing or a managed repository cannot be reached, else undefined. */
export function healthProblem(h: AuthHealth): string | undefined {
  const bad = h.repos.filter((r) => !r.reachable);
  if (h.appError) {
    return `${h.appError}${h.effective === "token" ? " Meanwhile I am using the old GH_TOKEN." : " Until that is fixed I cannot reach GitHub."}`;
  }
  if (!bad.length) return undefined;
  const names = bad.map((r) => r.slug).join(", ");
  if (h.mode === "app") {
    return `The GitHub App cannot reach ${names}. Open the App's installation on GitHub (Settings, Applications, Installed GitHub Apps, Configure) and choose All repositories so every repository, including new ones, is covered. Nothing else needs changing.`;
  }
  if (h.mode === "token") return `The GitHub token (GH_TOKEN) cannot reach ${names}. Give it access to those repositories, or set up the GitHub App (docs/GITHUB_APP.md) so you never need to edit token access again.`;
  return `I have no GitHub credentials, so I cannot reach ${names}. Set up the GitHub App (docs/GITHUB_APP.md) or add a GH_TOKEN secret in the clear-ops repository, then re-run the latest deploy workflow.`;
}

/** The one instance the service uses. Tests build their own. */
export const githubAuth = new GithubAuth();

/** Environment variables that must never reach a worker. */
const WORKER_STRIPPED = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GODADDY_API_KEY", "GODADDY_API_SECRET"];

/** Directory of the `gh` wrapper that reads the current token from the token file, so long jobs never hold a stale one. */
export function wrapperDir(): string {
  return path.join(config.dataDir, "bin");
}

/** Writes the `gh` wrapper: it sets GH_TOKEN from the token file, then runs the real gh. */
export function installGhWrapper(auth: GithubAuth = githubAuth, dir = wrapperDir()): void {
  const real = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((p) => p && path.resolve(p) !== path.resolve(dir))
    .map((p) => path.join(p, "gh"))
    .find((p) => fs.existsSync(p)) ?? "/usr/bin/gh";
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, "gh");
  fs.writeFileSync(file, `#!/bin/sh\nf=${q(auth.tokenFile)}\nif [ -r "$f" ]; then GH_TOKEN=$(cat "$f"); export GH_TOKEN; GITHUB_TOKEN=$GH_TOKEN; export GITHUB_TOKEN; fi\nexec ${q(real)} "$@"\n`, { mode: 0o755 });
}

/**
 * The environment for a worker run: process.env with the App's key removed always. With the App in use
 * (and signed in), GH_TOKEN is removed too (it may be the classic token kept only to create
 * repositories) and PATH starts with the gh wrapper, so gh uses a token that is fresh at every call.
 * Git reads the same file through its credential helper. Otherwise GH_TOKEN stays as it was.
 */
export async function workerGithubEnv(base: NodeJS.ProcessEnv = process.env, auth: GithubAuth = githubAuth): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of WORKER_STRIPPED) delete env[k];
  if (auth.mode() !== "app") return env;
  try {
    if (!(await auth.refreshFile())) return env;
    installGhWrapper(auth);
  } catch (err) {
    console.error(`Could not prepare GitHub App credentials for a worker: ${err instanceof Error ? err.message.replace(/ghs_\w+/g, "***") : "error"}`);
    return env;
  }
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  env.PATH = `${wrapperDir()}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

/** Keeps the token file fresh for long jobs. Returns the timer so tests can stop it. */
export function startTokenRefresher(auth: GithubAuth = githubAuth, everyMs = 10 * 60_000): NodeJS.Timeout {
  const t = setInterval(() => void auth.refreshFile().catch(() => undefined), everyMs);
  t.unref();
  return t;
}
