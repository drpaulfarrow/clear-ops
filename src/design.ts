/**
 * The design worker's eyes and hands: headless-browser screenshots of the live site, of a branch of
 * the product run locally, or of its own HTML/SVG boards, and a save_asset tool confined to the
 * job's own folder. Nothing here sends, posts, merges or touches the repositories' working trees.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "./config.js";

const exec = promisify(execFile);

/** Where every design job keeps its screenshots and assets: DATA_DIR/design/<job id>. */
export const designRoot = () => path.join(config.dataDir, "design");
export const designDir = (jobId: string) => path.join(designRoot(), jobId);

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2 },
} as const;
export type Viewport = keyof typeof VIEWPORTS;

export interface CaptureRequest {
  url: string;
  out: string;
  width: number;
  height: number;
  scale: number;
  /** The egress proxy every request of this capture must go through, e.g. http://127.0.0.1:41234. */
  proxy?: string;
}
/** Renders one URL to a PNG. The real one drives headless Chromium; tests inject a fake. */
export type Capture = (r: CaptureRequest) => Promise<void>;

/* ---------- Who the browser and previews run as ---------- */

export interface Identity {
  uid: number;
  gid: number;
}

/**
 * The account the browser and branch previews run as. Never root: a root process could read the
 * service's environment through /proc/<pid>/environ, the data folder and the git credentials. When
 * the service runs as root (the container), that is the unprivileged `designer` user; with no such
 * user it refuses rather than fall back to root. When the service is already unprivileged (local
 * development, tests), it is the service's own account. Pure, so tests can drive every case.
 */
export function chooseIdentity(designer: Identity | undefined, current: Identity): Identity {
  const who = current.uid === 0 ? designer : designer ?? current;
  if (!who) throw new Error(`${config.design.user} user not found; refusing to run the browser as root`);
  if (who.uid === 0 || who.gid === 0) throw new Error(`"${config.design.user}" must not be root`);
  return who;
}

/** Makes the service's own folders unreadable to any other account, the designer included. */
export function lockDown(dirs: string[]): void {
  for (const d of dirs) if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
}

let identity: Promise<Identity> | undefined;

/** Looked up once. Before anything runs as the designer, the data and repository folders are locked down. */
export function designIdentity(): Promise<Identity> {
  identity ??= (async () => {
    const id = async (flag: string) => Number((await exec("id", [flag, config.design.user], { timeout: 5000 })).stdout.trim());
    const designer = await Promise.all([id("-u"), id("-g")]).then(([uid, gid]) => ({ uid, gid })).catch(() => undefined);
    const current = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const who = chooseIdentity(designer && Number.isInteger(designer.uid) && Number.isInteger(designer.gid) ? designer : undefined, current);
    if (current.uid === 0) lockDown([config.dataDir, config.repoDir, config.selfRepoDir]);
    // UPLOADS_DIR may sit outside DATA_DIR; uploads can hold personal data and the browser runs untrusted pages.
    if (current.uid === 0) lockDown([config.uploadsDir]);
    return who;
  })().catch((err) => {
    identity = undefined;
    throw err;
  });
  return identity;
}

/** A fresh temporary folder owned by the designer, so the browser or preview can write only there. */
function designerTemp(prefix: string, who: Identity): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (process.getuid?.() === 0) fs.chownSync(dir, who.uid, who.gid);
  return dir;
}

/* ---------- Headless Chromium ---------- */

/** Chromium's own sandbox, until it has been seen not to start on this machine. */
let sandboxWorks = true;
const SANDBOX_FAILURE = /sandbox|namespace|zygote/i;

/** Chromium's flags for one capture. Every request goes through the egress proxy, loopback included. */
export function chromiumArgs(r: CaptureRequest, profile: string, shot: string, sandbox: boolean): string[] {
  return [
    "--headless=new",
    ...(sandbox ? [] : ["--no-sandbox"]),
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--mute-audio",
    "--disable-background-networking",
    `--proxy-server=${r.proxy}`,
    // Without this Chromium sends loopback requests straight past the proxy.
    "--proxy-bypass-list=<-loopback>",
    // WebRTC must not open UDP around the proxy.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--user-data-dir=${path.join(profile, "data")}`,
    `--window-size=${r.width},${r.height}`,
    `--force-device-scale-factor=${r.scale}`,
    "--virtual-time-budget=8000",
    `--screenshot=${shot}`,
    r.url,
  ];
}

/**
 * Headless Chromium from its command line: no npm dependency. It runs as the unprivileged designer
 * with a scrubbed environment, writes only into its own temporary folder (the screenshot is copied
 * into the job's folder afterwards), and reaches the network only through the egress proxy. Its
 * sandbox is tried first; it is switched off only if it cannot start here, and that is logged.
 */
export const chromiumCapture: Capture = async (r) => {
  if (!r.proxy) throw new Error("the browser only runs behind the egress proxy");
  const who = await designIdentity();
  const profile = designerTemp("clear-design-chrome-", who);
  const shot = path.join(profile, "shot.png");
  const run = (sandbox: boolean) =>
    exec(config.design.chromiumPath, chromiumArgs(r, profile, shot, sandbox), {
      timeout: 90_000,
      uid: who.uid,
      gid: who.gid,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile },
    });
  try {
    try {
      await run(sandboxWorks);
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      if (!sandboxWorks || !SANDBOX_FAILURE.test(stderr)) throw err;
      sandboxWorks = false;
      console.warn(`[design] Chromium's sandbox would not start, so screenshots run without it from now on (still as ${config.design.user}, behind the proxy): ${stderr.split("\n").find((l) => SANDBOX_FAILURE.test(l))?.trim() ?? ""}`);
      await run(false);
    }
    if (!fs.existsSync(shot)) throw new Error("the browser produced no screenshot");
    fs.copyFileSync(shot, r.out);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
};

/* ---------- What may be screenshotted ---------- */

function isPrivateV4(v4: string): boolean {
  const [a, b] = v4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** An IPv6 address as its 8 hextets, whatever way it is written (`::`, embedded dotted IPv4, zone id). */
export function expandIPv6(ip: string): number[] | undefined {
  const s = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (!net.isIPv6(s)) return undefined;
  let groups = s;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    groups = s.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = groups.includes("::") ? groups.split("::") : [groups, undefined];
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0");
  const all = [...h, ...fill, ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : undefined;
}

/**
 * Loopback, private, link-local, carrier-grade NAT, multicast and unique-local addresses, v4 and v6.
 * IPv6 is checked on the parsed address, not its spelling, so `::ffff:7f00:1` is as private as
 * `127.0.0.1`. IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses are refused whatever
 * they carry, and so are NAT64 (64:ff9b::/96) and 6to4 (2002::/16): the browser needs none of them.
 * Anything that is not a valid address counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const h = expandIPv6(ip);
  if (!h) return true;
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(6)) return true; // ::, ::1 and IPv4-compatible ::/96
  if (zeros(5) && h[5] === 0xffff) return true; // IPv4-mapped ::ffff:0:0/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return true; // NAT64
  if (h[0] === 0x2002) return true; // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

export type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * A public http(s) page only. No file://, no loopback or private network (the machine's own
 * services, Fly's private network), so a screenshot can never show anything Read could not.
 */
export async function checkPublicUrl(raw: string, resolve: Lookup = dnsLookup): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http and https pages can be screenshotted");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  await publicAddresses(url.hostname, resolve);
  return url.toString();
}

/** The addresses of a public host, refusing local names and any host with a private address. */
async function publicAddresses(hostname: string, resolve: Lookup): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error(`${host} is not a public host`);
  const addrs = net.isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addrs.length) throw new Error(`cannot resolve ${host}`);
  if (addrs.some(isPrivateAddress)) throw new Error(`${host} resolves to a private address`);
  return addrs;
}

/* ---------- The egress proxy: the browser's only way out ---------- */

export type Dial = (ip: string, port: number) => net.Socket;
const netDial: Dial = (ip, port) => net.connect({ host: ip, port });

export interface EgressProxy {
  /** For Chromium's --proxy-server. */
  url: string;
  /** Every destination refused, for tests and logs. */
  refused: string[];
  stop: () => Promise<void>;
}

/**
 * Where one browser request may go, as the IP to connect to. Exactly one loopback host:port (the
 * capture's own board or branch server) is allowed; anything else must be a public host, and the
 * proxy connects to the very address it checked here, so a redirect to a private address, a page
 * loading one, or DNS that changes between the check and the connection all fail the same way.
 */
export async function checkDestination(hostname: string, port: number, allow: string | undefined, resolve: Lookup = dnsLookup): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allow && `${host}:${port}` === allow) return host;
  return (await publicAddresses(host, resolve))[0];
}

/**
 * A forward proxy on loopback for one capture. It handles CONNECT (https and WebSockets) and
 * absolute-URI http requests, checks each destination with checkDestination, and refuses the rest
 * with 403. Chromium is launched with --proxy-server pointing here and --proxy-bypass-list=<-loopback>.
 */
export async function startEgressProxy(o: { allow?: string; resolve?: Lookup; dial?: Dial } = {}): Promise<EgressProxy> {
  const resolve = o.resolve ?? dnsLookup;
  const dial = o.dial ?? netDial;
  const refused: string[] = [];
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    let url: URL;
    let ip: string;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("only absolute http URLs are proxied");
      ip = await checkDestination(url.hostname, Number(url.port || 80), o.allow, resolve);
    } catch (err) {
      refused.push(req.url ?? "");
      res.writeHead(403, { "content-type": "text/plain" }).end(`Refused: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) if (h.startsWith("proxy-")) delete headers[h];
    const port = Number(url.port || 80);
    const up = http.request({ method: req.method, path: url.pathname + url.search, headers, createConnection: () => dial(ip, port) }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(up);
  });

  server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const m = (req.url ?? "").match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
    let ip: string;
    try {
      if (!m) throw new Error("bad CONNECT target");
      ip = await checkDestination(m[1], Number(m[2]), o.allow, resolve);
    } catch {
      refused.push(req.url ?? "");
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const up = dial(ip, Number(m[2]));
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    up.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => {
      client.destroy();
      up.destroy();
    });
    client.on("close", () => up.destroy());
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    refused,
    stop: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A branch name safe to hand to git: no options, no ranges, no odd characters. */
export function checkBranch(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) throw new Error(`not a valid branch name: ${ref}`);
  return ref;
}

/** A file name for save_asset: one level, a text format an engineer or browser can use. */
export function checkAssetName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(md|svg|html|css|json|txt)$/i.test(name) || name.includes("..")) {
    throw new Error("asset names are one plain file name ending .md, .svg, .html, .css, .json or .txt");
  }
  return name;
}

/** Resolves `name` inside `dir`, refusing anything that would land outside it. */
export function inside(dir: string, name: string): string {
  const root = path.resolve(dir);
  const p = path.resolve(root, name);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`${name} is outside the design folder`);
  return p;
}

/* ---------- Local servers: a branch of the product, and the job's own boards ---------- */

export interface Served {
  base: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(base: string, child: ChildProcess | undefined, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child && child.exitCode !== null) throw new Error(`the preview server exited with code ${child.exitCode}`);
    const ok = await fetch(base, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the preview server did not start in time");
}

/** The product's server entry point, run exactly as its `npm start` does. */
export const PREVIEW_ENTRY = "src/server.ts";

/**
 * Runs one branch of the product locally so it can be screenshotted before it merges. The branch is
 * exported with git archive into a temporary folder (the engineer's checkout is never touched),
 * unpacked and started as the unprivileged designer with a scrubbed environment: no API keys, no
 * tokens, in development mode, unable to read the service's environment, data or git credentials.
 */
export async function previewBranch(branch: string): Promise<Served> {
  checkBranch(branch);
  const who = await designIdentity();
  const tmp = designerTemp("clear-design-preview-", who);
  const tar = path.join(tmp, "src.tar");
  const app = path.join(tmp, "app");
  const remote = `refs/remotes/origin/${branch}`;
  try {
    await exec("git", ["-C", config.repoDir, "fetch", "--quiet", "origin", `+refs/heads/${branch}:${remote}`], { timeout: 120_000 });
    await exec("git", ["-C", config.repoDir, "archive", "--format=tar", "-o", tar, remote], { timeout: 60_000 });
    fs.chmodSync(tar, 0o644);
    await exec("sh", ["-c", 'mkdir "$1" && tar -xf "$2" -C "$1"', "unpack", app, tar], { timeout: 60_000, uid: who.uid, gid: who.gid });
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const port = await freePort();
  const child = spawn(process.execPath, [PREVIEW_ENTRY], {
    cwd: app,
    uid: who.uid,
    gid: who.gid,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, HOST: "127.0.0.1", PORT: String(port), VAR_DIR: path.join(tmp, "var") },
    stdio: "ignore",
  });
  child.on("error", (err) => console.warn(`[design] preview of ${branch} could not start: ${err.message}`));
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(`http://127.0.0.1:${port}/`, child, 30_000);
  } catch (err) {
    await stop();
    throw err;
  }
  return { base: `http://127.0.0.1:${port}`, stop };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

/** Serves one folder over loopback HTTP (never file://), so a board can only load what is in it. */
export async function serveDir(dir: string): Promise<Served> {
  const server = http.createServer((req, res) => {
    try {
      const name = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
      const p = inside(dir, name);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("missing");
      res.writeHead(200, { "content-type": TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream" });
      res.end(fs.readFileSync(p));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

/* ---------- The design worker's tools ---------- */

export interface DesignDeps {
  capture?: Capture;
  resolve?: Lookup;
  preview?: (branch: string) => Promise<Served>;
  /** How the egress proxy opens a connection to a checked address. Tests point it at a local server. */
  dial?: Dial;
}

const slug = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "page";

function nextFree(dir: string, base: string): string {
  for (let i = 1; ; i++) {
    const p = path.join(dir, `${base}${i === 1 ? "" : `-${i}`}`);
    if (!fs.existsSync(`${p}-desktop.png`) && !fs.existsSync(`${p}-mobile.png`)) return p;
  }
}

/** One screenshot request: exactly one of url, branch or asset. Exported for tests. */
export async function takeScreenshots(
  jobId: string,
  input: { url?: string; branch?: string; asset?: string; path?: string; viewports?: Viewport[]; tall?: boolean; name?: string },
  deps: DesignDeps = {},
): Promise<string[]> {
  const capture = deps.capture ?? chromiumCapture;
  const given = [input.url, input.branch, input.asset].filter((x) => x !== undefined && x !== "");
  if (given.length !== 1) throw new Error("give exactly one of url, branch or asset");
  const dir = designDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const pagePath = (input.path ?? "/").startsWith("/") ? input.path ?? "/" : `/${input.path}`;
  if (/^\/\//.test(pagePath) || /[\s\\]/.test(pagePath)) throw new Error("path must be a plain path such as / or /ui/#publishers");

  let served: Served | undefined;
  let url: string;
  let label: string;
  if (input.url) {
    url = await checkPublicUrl(input.url, deps.resolve);
    label = input.url;
  } else if (input.branch) {
    served = await (deps.preview ?? previewBranch)(checkBranch(input.branch));
    url = served.base + pagePath;
    label = `branch-${input.branch}`;
  } else {
    const file = inside(dir, checkAssetName(input.asset!));
    if (!fs.existsSync(file)) throw new Error(`no asset ${input.asset}; save it with save_asset first`);
    served = await serveDir(dir);
    url = `${served.base}/${encodeURIComponent(input.asset!)}`;
    label = `asset-${input.asset}`;
  }
  let proxy: EgressProxy | undefined;
  try {
    // The browser's only way out: the one local server for this capture, or public hosts.
    proxy = await startEgressProxy({ allow: served ? new URL(served.base).host : undefined, resolve: deps.resolve, dial: deps.dial });
    const base = nextFree(dir, slug(input.name ?? label));
    const out: string[] = [];
    for (const v of input.viewports?.length ? input.viewports : (["desktop", "mobile"] as Viewport[])) {
      const vp = VIEWPORTS[v];
      const file = `${base}-${v}.png`;
      await capture({ url, out: file, width: vp.width, height: input.tall ? vp.height * 3 : vp.height, scale: vp.scale, proxy: proxy.url });
      out.push(file);
    }
    if (proxy.refused.length) console.warn(`[design] job ${jobId}: the egress proxy refused ${[...new Set(proxy.refused)].slice(0, 5).join(", ")}`);
    return out;
  } finally {
    await proxy?.stop().catch(() => undefined);
    await served?.stop().catch(() => undefined);
  }
}

/** Writes a spec, palette, SVG logo concept or HTML board into the job's own folder, nowhere else. */
export function saveAsset(jobId: string, name: string, content: string): string {
  checkAssetName(name);
  if (Buffer.byteLength(content) > 300_000) throw new Error("assets are capped at 300 KB");
  const dir = designDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const p = inside(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

export const DESIGN_TOOLS = ["mcp__design__screenshot", "mcp__design__save_asset"];

/** The design job's MCP server. Every call is scoped to the job's own folder. */
export function designServer(jobId: string, deps: DesignDeps = {}) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  return createSdkMcpServer({
    name: "design",
    version: "1.0.0",
    tools: [
      tool(
        "screenshot",
        `Capture PNG screenshots (desktop 1440x900 and mobile 390x844 by default) with a headless browser and save them in your design folder. Give exactly one of: url (a public http(s) page, e.g. the live site ${config.design.siteUrl}), branch (a branch of the product repository, run locally so you can see it before it merges; add path for the page, default "/"), or asset (an .html or .svg file you saved with save_asset, to render a board or logo concept as an image). Returns the file paths; open each with Read to see it.`,
        {
          url: z.string().optional(),
          branch: z.string().optional(),
          asset: z.string().optional(),
          path: z.string().optional().describe('Page path for branch previews, e.g. "/" or "/#publishers".'),
          viewports: z.array(z.enum(["desktop", "mobile"])).optional(),
          tall: z.boolean().optional().describe("Three screens tall, to see more of a long page."),
          name: z.string().optional().describe("A short label for the file names."),
        },
        async (input) => {
          try {
            const files = await takeScreenshots(jobId, input, deps);
            return text(`Saved:\n${files.join("\n")}\nOpen each with Read to look at it.`);
          } catch (err) {
            return { ...text(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`), isError: true };
          }
        },
      ),
      tool(
        "save_asset",
        "Save a design asset (spec .md, palette .json or .css, logo concept .svg, board .html) in your design folder, where the engineer and Paul can see it. One plain file name; nothing outside the folder.",
        { name: z.string(), content: z.string() },
        async ({ name, content }) => {
          try {
            return text(`Saved ${saveAsset(jobId, name, content)}`);
          } catch (err) {
            return { ...text(`Not saved: ${err instanceof Error ? err.message : String(err)}`), isError: true };
          }
        },
      ),
    ],
  });
}

/* ---------- The design report's machine-readable lines ---------- */

/** Design rounds that end in an engineer job, per loop. A final critique-only round follows the last. */
export const MAX_DESIGN_ROUNDS = 3;

export interface DesignVerdict {
  outcome: "spec" | "done" | "needs_founder";
  detail?: string;
}

/** The last "DESIGN: ..." line of a design report (see DESIGN_VERDICT_RULES in agents.ts). */
export function parseDesignVerdict(text: string): DesignVerdict | undefined {
  let last: DesignVerdict | undefined;
  for (const m of text.matchAll(/^[ \t>*`_-]*DESIGN[ \t]*:[ \t]*(spec ready|no high-impact issues|needs Paul)\b[ \t:]*(.*)$/gim)) {
    const w = m[1].toLowerCase();
    const outcome = w === "spec ready" ? "spec" : w === "needs paul" ? "needs_founder" : "done";
    last = { outcome, detail: m[2].replace(/[*`_]+$/, "").trim() || undefined };
  }
  return last;
}

/**
 * Images the design report asks to show Paul ("IMAGE: <path> | <caption>"), kept only when they are
 * PNG or JPEG files inside that job's own design folder. At most six.
 */
export function reportImages(jobId: string, text: string): Array<{ file: string; caption: string }> {
  const dir = designDir(jobId);
  const out: Array<{ file: string; caption: string }> = [];
  for (const m of text.matchAll(/^[ \t>*`_-]*IMAGE[ \t]*:[ \t]*([^|\n]+?)[ \t]*(?:\|[ \t]*(.*))?$/gim)) {
    try {
      const file = inside(dir, path.isAbsolute(m[1]) ? path.relative(dir, m[1]) : m[1]);
      if (!/\.(png|jpe?g)$/i.test(file) || !fs.existsSync(file)) continue;
      out.push({ file, caption: (m[2] ?? "").replace(/[*`_]+$/, "").trim() });
    } catch {
      // Outside the folder: ignored.
    }
    if (out.length === 6) break;
  }
  return out;
}

/* ---------- Waiting for the product deploy before the next round ---------- */

/** Resolves once a deploy that started after `since` has finished (or a bounded wait has passed). */
export type DeployWait = (since: Date) => Promise<void>;

/**
 * After a design-loop pull request merges, the product's CI tests and deploys main. Polls the latest
 * push run on main with gh until it completes, then allows the rolling deploy a minute to settle.
 * Falls back to a fixed wait when gh or the repository name is unavailable. Never longer than 40 minutes.
 */
export const waitForProductDeploy: DeployWait = async (since) => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const repo = config.repos.product;
  const deadline = Date.now() + 40 * 60_000;
  if (!repo) return sleep(10 * 60_000);
  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec("gh", ["run", "list", "--repo", repo, "--branch", "main", "--event", "push", "--limit", "5", "--json", "status,createdAt"], { timeout: 30_000 });
      const runs = (JSON.parse(stdout) as Array<{ status: string; createdAt: string }>).filter((r) => Date.parse(r.createdAt) >= since.getTime() - 5 * 60_000);
      if (runs.length && runs.every((r) => r.status === "completed")) return sleep(60_000);
    } catch {
      return sleep(10 * 60_000);
    }
    await sleep(30_000);
  }
};
