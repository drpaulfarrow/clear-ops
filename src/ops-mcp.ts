/**
 * A read-only window on ClearOps for Claude (Paul, 23 Nov 2026): an MCP server at /mcp, so the Claude that
 * builds this service can see the board, a job, its trace and what Marlo said, instead of Paul
 * relaying screenshots and pasted traces.
 *
 * What it guarantees:
 *  - Off unless OPS_MCP_ENABLED is exactly "true" and the web app's own GitHub sign-in is set up: every
 *    route here answers 404 as if it did not exist.
 *  - Read only, and no more than the signed-in web app shows: every tool answers from the same functions
 *    the app's own GET routes use (src/app-data.ts), nothing else. No tool starts, stops, retries,
 *    merges, approves, sends or changes anything, and none reaches a model: answering costs nothing.
 *  - Only Paul can connect it. Connecting is OAuth with PKCE (what Claude's connectors speak): the
 *    consent page answers only a browser holding the web app's own GitHub session for the one allowed
 *    account (checked with the app's own `sessionValid`), and only his tap on its form issues a code. Clients may register themselves, but only with a redirect
 *    address on Claude's own sites (MCP_REDIRECTS), so a code can never be sent anywhere else.
 *  - Tokens are random, kept only as their sha256, single-purpose (an access token reads /mcp for an
 *    hour; a refresh token, used once, gets the next pair), capped in number, and all revoked by
 *    `revokeAll` whenever the service starts with the setting off.
 *  - Approval words mean nothing here: nothing is parsed from a request but a tool's name and its few
 *    plain arguments.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Store } from "./store.js";

export const MCP_PATH = "/mcp";
export const MCP_REGISTER_PATH = "/mcp/oauth/register";
export const MCP_TOKEN_PATH = "/mcp/oauth/token";
/** The consent page: shown only to a browser holding the web app's own signed-in session. */
export const MCP_CONNECT_PATH = "/mcp/connect";

/** The only places a code may be sent: Claude's own connector callback. */
export const MCP_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
export const MCP_ACCESS_MINUTES = 60;
export const MCP_REFRESH_DAYS = 30;
export const MCP_CODE_MINUTES = 5;
/** At most this many registered clients and live tokens are kept; past it the oldest go. */
export const MCP_MAX_CLIENTS = 10;
export const MCP_MAX_TOKENS = 20;
/** Registrations and token requests together, per minute, for the whole service. */
export const MCP_AUTH_PER_MINUTE = 20;
/** The protocol versions this server answers in, newest first. */
export const MCP_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export interface OpsMcpState {
  clients: Array<{ id: string; name: string; redirectUris: string[]; at: string }>;
  tokens: Array<{ hash: string; kind: "access" | "refresh"; clientId: string; exp: number }>;
}

type McpStore = Pick<Store, "settings" | "setSetting">;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = () => randomBytes(32).toString("base64url");

/** The connection's own records: registered clients, codes in memory only, tokens by hash. */
export class OpsMcpAuth {
  private codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; exp: number }>();
  private asked: number[] = [];
  constructor(private store: McpStore, private now: () => number = Date.now) {}

  private state(): OpsMcpState {
    const s = this.store.settings().opsMcp;
    return { clients: s?.clients ?? [], tokens: (s?.tokens ?? []).filter((t) => t.exp > this.now()) };
  }
  private save(s: OpsMcpState): void {
    this.store.setSetting("opsMcp", { clients: s.clients.slice(-MCP_MAX_CLIENTS), tokens: s.tokens.slice(-MCP_MAX_TOKENS) });
  }

  /** True while under the rate limit, and counts this request. */
  allow(): boolean {
    const t = this.now();
    this.asked = this.asked.filter((at) => t - at < 60_000);
    if (this.asked.length >= MCP_AUTH_PER_MINUTE) return false;
    this.asked.push(t);
    return true;
  }

  /** Dynamic client registration (RFC 7591), for Claude's callback only. */
  register(body: unknown): { client_id: string; redirect_uris: string[] } | { error: string } {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || uris.some((u) => !MCP_REDIRECTS.includes(u))) return { error: "invalid_redirect_uri" };
    const id = `c_${randomBytes(12).toString("base64url")}`;
    const s = this.state();
    s.clients.push({ id, name: typeof b.client_name === "string" ? b.client_name.slice(0, 60) : "MCP client", redirectUris: uris, at: new Date(this.now()).toISOString() });
    this.save(s);
    return { client_id: id, redirect_uris: uris };
  }

  client(id: unknown): OpsMcpState["clients"][number] | undefined {
    return typeof id === "string" ? this.state().clients.find((c) => c.id === id) : undefined;
  }

  /**
   * Checks an authorization request as the consent page receives it. Undefined when it is sound, or why
   * not. Nothing is redirected anywhere until this passes, so a bad request never sends a browser away.
   */
  check(q: Record<string, unknown>): string | undefined {
    const c = this.client(q.client_id);
    if (!c) return "This connection is not registered here.";
    if (typeof q.redirect_uri !== "string" || !c.redirectUris.includes(q.redirect_uri) || !MCP_REDIRECTS.includes(q.redirect_uri)) return "That return address is not allowed.";
    if (q.response_type !== "code") return "Only the code flow is offered.";
    if (q.code_challenge_method !== "S256" || typeof q.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return "The request has no valid PKCE challenge.";
    return undefined;
  }

  /** Paul approved on the consent page: a single-use code bound to the client, its return address and its challenge. */
  issueCode(q: { client_id: string; redirect_uri: string; code_challenge: string }): string {
    const code = token();
    this.codes.set(sha(code), { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, exp: this.now() + MCP_CODE_MINUTES * 60_000 });
    return code;
  }

  private issuePair(clientId: string): { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number } {
    const access = token();
    const refresh = token();
    const s = this.state();
    s.tokens.push({ hash: sha(access), kind: "access", clientId, exp: this.now() + MCP_ACCESS_MINUTES * 60_000 }, { hash: sha(refresh), kind: "refresh", clientId, exp: this.now() + MCP_REFRESH_DAYS * 86_400_000 });
    this.save(s);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: MCP_ACCESS_MINUTES * 60 };
  }

  /** The token endpoint: a code and its verifier, or a refresh token (used once), for a new pair. */
  exchange(body: Record<string, unknown>): ReturnType<OpsMcpAuth["issuePair"]> | { error: string } {
    if (body.grant_type === "authorization_code") {
      if (typeof body.code !== "string" || typeof body.code_verifier !== "string") return { error: "invalid_request" };
      const key = sha(body.code);
      const held = this.codes.get(key);
      this.codes.delete(key);
      if (!held || held.exp < this.now()) return { error: "invalid_grant" };
      if (body.client_id !== held.clientId || body.redirect_uri !== held.redirectUri) return { error: "invalid_grant" };
      const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
      if (!safeEqual(challenge, held.challenge)) return { error: "invalid_grant" };
      return this.issuePair(held.clientId);
    }
    if (body.grant_type === "refresh_token") {
      if (typeof body.refresh_token !== "string") return { error: "invalid_request" };
      const hash = sha(body.refresh_token);
      const s = this.state();
      const found = s.tokens.find((t) => t.kind === "refresh" && t.hash === hash);
      if (!found || (typeof body.client_id === "string" && body.client_id !== found.clientId)) return { error: "invalid_grant" };
      s.tokens = s.tokens.filter((t) => t !== found);
      this.save(s);
      return this.issuePair(found.clientId);
    }
    return { error: "unsupported_grant_type" };
  }

  /** True for a live access token from the Authorization header. */
  authorised(header: string | undefined): boolean {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header ?? "");
    if (!m) return false;
    const hash = sha(m[1]!);
    return this.state().tokens.some((t) => t.kind === "access" && t.hash === hash);
  }

  /** Forgets every client and token, so nothing connected can read any more. */
  revokeAll(): void {
    this.codes.clear();
    this.store.setSetting("opsMcp", { clients: [], tokens: [] });
  }

  connected(): number {
    return new Set(this.state().tokens.map((t) => t.clientId)).size;
  }
}

/** One read-only tool: its name, what it is for, its arguments, and how it answers. */
export interface OpsMcpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: "string"; description: string }>; required?: string[] };
  read: (args: Record<string, string>) => unknown;
}

/** The longest answer a tool gives, in characters; past it the answer is cut and says so. */
export const MCP_ANSWER_MAX = 120_000;

function answer(value: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (value === undefined) return { content: [{ type: "text", text: "Not found." }], isError: true };
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length > MCP_ANSWER_MAX) text = `${text.slice(0, MCP_ANSWER_MAX)}\n[cut at ${MCP_ANSWER_MAX} characters]`;
  return { content: [{ type: "text", text }] };
}

/**
 * The MCP endpoint itself: JSON-RPC over HTTP POST (the streamable HTTP transport, answering in plain JSON,
 * with no sessions and no server-sent events). Only initialize, ping, tools/list and tools/call do anything.
 */
export function handleRpc(tools: OpsMcpTool[], msg: unknown): unknown {
  const m = (msg ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.id === undefined) return undefined; // a notification: no answer
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(-32600, "Invalid request");
  const params = (m.params ?? {}) as { protocolVersion?: unknown; name?: unknown; arguments?: unknown };
  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" && MCP_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOLS[0];
      return ok({
        protocolVersion: asked,
        capabilities: { tools: {} },
        serverInfo: { name: "clear-ops-read", version: "1" },
        instructions: "A read-only view of ClearOps: what Paul's signed-in web app shows. Nothing here changes anything or runs a model.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, "No such tool");
      const raw = (params.arguments ?? {}) as Record<string, unknown>;
      const args: Record<string, string> = {};
      for (const key of Object.keys(tool.inputSchema.properties)) if (typeof raw[key] === "string") args[key] = (raw[key] as string).slice(0, 200);
      for (const key of tool.inputSchema.required ?? []) if (!args[key]) return ok(answer(undefined));
      try {
        return ok(answer(tool.read(args)));
      } catch {
        return ok({ content: [{ type: "text", text: "That could not be read just now." }], isError: true });
      }
    }
    default:
      return fail(-32601, "Method not found");
  }
}

const CONNECT_FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state"] as const;

/** The routes outside /app: discovery, registration, tokens and the endpoint. All 404 when off. */
export function opsMcpRouter(o: { enabled: () => boolean; auth: OpsMcpAuth; publicUrl: string; tools: () => OpsMcpTool[]; signedIn: (cookie: string | undefined) => boolean; signInPath: string; headers?: (res: express.Response) => void }): express.Router {
  const r = express.Router();
  r.use((req, res, next) => {
    const ours = req.path === MCP_PATH || req.path.startsWith(`${MCP_PATH}/`) || req.path.startsWith("/.well-known/oauth-");
    if (!ours) return next();
    if (!o.enabled()) return void res.status(404).type("text/plain").send("Not found");
    res.set("Cache-Control", "no-store");
    next();
  });
  const resourceMeta = `${o.publicUrl}/.well-known/oauth-protected-resource`;
  r.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json({ resource: `${o.publicUrl}${MCP_PATH}`, authorization_servers: [o.publicUrl], bearer_methods_supported: ["header"] });
  });
  r.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: o.publicUrl,
      authorization_endpoint: `${o.publicUrl}${MCP_CONNECT_PATH}`,
      token_endpoint: `${o.publicUrl}${MCP_TOKEN_PATH}`,
      registration_endpoint: `${o.publicUrl}${MCP_REGISTER_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
  const small = [express.json({ limit: "16kb" }), express.urlencoded({ extended: false, limit: "16kb" })];
  r.post(MCP_REGISTER_PATH, ...small, (req, res) => {
    if (!o.auth.allow()) return void res.status(429).json({ error: "slow_down" });
    const out = o.auth.register(req.body);
    res.status("error" in out ? 400 : 201).json(out);
  });
  r.post(MCP_TOKEN_PATH, ...small, (req, res) => {
    if (!o.auth.allow()) return void res.status(429).json({ error: "slow_down" });
    const out = o.auth.exchange((req.body ?? {}) as Record<string, unknown>);
    res.status("error" in out ? 400 : 200).json(out);
  });
  // The consent page. A browser without the app's session is sent to sign in; nothing is issued.
  const fieldsOf = (src: Record<string, unknown>) => Object.fromEntries(CONNECT_FIELDS.map((k) => [k, typeof src[k] === "string" ? (src[k] as string) : ""])) as Record<(typeof CONNECT_FIELDS)[number], string>;
  r.get(MCP_CONNECT_PATH, (req, res) => {
    o.headers?.(res);
    if (!o.signedIn(req.headers.cookie)) return res.redirect(303, o.signInPath);
    const q = fieldsOf(req.query as Record<string, unknown>);
    const error = o.auth.check(q);
    res.type("html").send(connectPage(error ? { error } : { client: o.auth.client(q.client_id)?.name, fields: q }));
  });
  r.post(MCP_CONNECT_PATH, express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    o.headers?.(res);
    if (!o.signedIn(req.headers.cookie)) return res.redirect(303, o.signInPath);
    // Only this page's own form: a post from any other site, or one that names none, issues nothing.
    if (req.headers.origin !== new URL(o.publicUrl).origin) return void res.status(403).type("text/plain").send("Refused");
    const q = fieldsOf((req.body ?? {}) as Record<string, unknown>);
    const error = o.auth.check(q);
    if (error) return void res.type("html").send(connectPage({ error }));
    const back = new URL(q.redirect_uri);
    back.searchParams.set("code", o.auth.issueCode(q));
    if (q.state) back.searchParams.set("state", q.state.slice(0, 500));
    res.redirect(303, back.toString());
  });
  const unauthorised = (res: express.Response) => {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMeta}"`);
    res.status(401).json({ error: "unauthorized" });
  };
  r.post(MCP_PATH, express.json({ limit: "64kb" }), (req, res) => {
    if (!o.auth.authorised(req.headers.authorization)) return unauthorised(res);
    const body = req.body as unknown;
    const tools = o.tools();
    if (Array.isArray(body)) {
      const out = body.map((m) => handleRpc(tools, m)).filter((x) => x !== undefined);
      return void (out.length ? res.json(out) : res.status(202).end());
    }
    const out = handleRpc(tools, body);
    if (out === undefined) return void res.status(202).end();
    res.json(out);
  });
  r.all(MCP_PATH, (req, res) => {
    if (!o.auth.authorised(req.headers.authorization)) return unauthorised(res);
    res.set("Allow", "POST").status(405).end();
  });
  return r;
}

/** The consent page, shown only to Paul signed in to the web app. Plain HTML, everything escaped. */
export function connectPage(o: { client?: string; error?: string; fields?: Record<string, string> }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = o.error
    ? `<p>${esc(o.error)}</p>`
    : `<p><b>${esc(o.client ?? "A client")}</b> asks to read ClearOps: the board, jobs, their traces and reports, spend, and the app's chats.</p>
<p>It can read only. It cannot start, stop, merge, approve, send or change anything, and reading costs nothing.</p>
<form method="post" action="${MCP_CONNECT_PATH}">${Object.entries(o.fields ?? {})
        .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
        .join("")}<button type="submit">Allow read-only access</button></form>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ClearOps</title><body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>Connect ClearOps</h1>${body}</body>`;
}
