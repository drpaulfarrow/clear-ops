import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-design-"));

const d = await import("../src/design.js");
import type { CaptureRequest } from "../src/design.js";

const publicDns = async () => ["93.184.216.34"];

/** One plain http request through a forward proxy, as a browser behind --proxy-server sends it. */
function viaProxy(proxy: string, url: string): Promise<{ status: number; body: string }> {
  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT through the proxy, as for https: resolves with the status code it answers. */
function connectVia(proxy: string, target: string): Promise<number> {
  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), method: "CONNECT", path: target });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A local HTTP server answering every request with `body`. */
async function localServer(body: string) {
  const server = http.createServer((_req, res) => res.end(body));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * A capture that records what it was asked and fetches the page through the capture's egress proxy,
 * as Chromium does, so local servers and the proxy are exercised for real. `extra` URLs are fetched
 * too, standing in for what a page loads (an iframe, an image, a redirect target).
 */
function fakeCapture(extra: string[] = []) {
  const calls: Array<CaptureRequest & { body?: string; extra?: number[] }> = [];
  const capture = async (r: CaptureRequest) => {
    assert.ok(r.proxy, "every capture goes through the egress proxy");
    const body = r.url.startsWith("http://127.0.0.1") ? (await viaProxy(r.proxy!, r.url)).body : undefined;
    const statuses = await Promise.all(extra.map(async (u) => (await viaProxy(r.proxy!, u)).status));
    calls.push({ ...r, body, extra: statuses });
    fs.writeFileSync(r.out, "png");
  };
  return { calls, capture };
}

test("private, loopback and link-local addresses are recognised, v4 and v6", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fdaa:0:1::2", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.ok(d.isPrivateAddress(ip), `${ip} is private`);
  }
  for (const ip of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2a00:1450:4009::1"]) assert.ok(!d.isPrivateAddress(ip), `${ip} is public`);
});

test("only public http(s) pages can be screenshotted: no file://, no localhost, no private network", async () => {
  assert.equal(await d.checkPublicUrl("https://clear-exchange.fly.dev/", publicDns), "https://clear-exchange.fly.dev/");
  for (const bad of [
    "file:///etc/passwd",
    "file:///proc/self/environ",
    "javascript:alert(1)",
    "data:text/html,hi",
    "http://localhost:8080/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data",
    "http://clear-ops.internal/",
    "https://user:pw@example.com/",
    "not a url",
  ]) {
    await assert.rejects(d.checkPublicUrl(bad, publicDns), `${bad} must be refused`);
  }
  await assert.rejects(d.checkPublicUrl("https://sneaky.example/", async () => ["10.0.0.1"]), /private address/);
  await assert.rejects(d.checkPublicUrl("https://nowhere.example/", async () => []), /cannot resolve/);
});

test("branch names and asset names are validated before they reach git or the disk", () => {
  assert.equal(d.checkBranch("clear/restyle-shadcn"), "clear/restyle-shadcn");
  for (const bad of ["-x", "--upload-pack=evil", "a..b", "a b", "a;rm", "", "x/", "x.lock"]) assert.throws(() => d.checkBranch(bad), `${bad} refused`);
  assert.equal(d.checkAssetName("spec.md"), "spec.md");
  for (const bad of ["../spec.md", "a/b.svg", "/etc/x.md", "run.sh", "x.png", ".hidden.md", "spec"]) assert.throws(() => d.checkAssetName(bad), `${bad} refused`);
  assert.throws(() => d.inside("/data/design/abc", "../other/x.png"));
  assert.equal(d.inside("/data/design/abc", "x.png"), path.join("/data/design/abc", "x.png"));
});

test("save_asset writes only into the job's own design folder", () => {
  const p = d.saveAsset("job001", "palette.json", '{"ink":"#0b0f19"}');
  assert.equal(p, path.join(d.designDir("job001"), "palette.json"));
  assert.equal(fs.readFileSync(p, "utf8"), '{"ink":"#0b0f19"}');
  assert.throws(() => d.saveAsset("job001", "../../state.json", "{}"));
  assert.throws(() => d.saveAsset("job001", "big.md", "x".repeat(400_000)), /capped/);
});

test("a public URL is captured at desktop and mobile into the job's folder", async () => {
  const { calls, capture } = fakeCapture();
  const files = await d.takeScreenshots("job002", { url: "https://clear-exchange.fly.dev/" }, { capture, resolve: publicDns });
  assert.deepEqual(files, [path.join(d.designDir("job002"), "clear-exchange-fly-dev-desktop.png"), path.join(d.designDir("job002"), "clear-exchange-fly-dev-mobile.png")]);
  assert.deepEqual(calls.map((c) => [c.width, c.height, c.scale]), [[1440, 900, 1], [390, 844, 2]]);
  const again = await d.takeScreenshots("job002", { url: "https://clear-exchange.fly.dev/", viewports: ["mobile"], tall: true }, { capture, resolve: publicDns });
  assert.equal(again.length, 1);
  assert.match(again[0], /clear-exchange-fly-dev-2-mobile\.png$/, "earlier screenshots are never overwritten");
  assert.equal(calls.at(-1)!.height, 844 * 3);
  await assert.rejects(d.takeScreenshots("job002", { url: "file:///etc/passwd" }, { capture }));
  await assert.rejects(d.takeScreenshots("job002", { url: "https://a.example", branch: "main" }, { capture }), /exactly one/);
  await assert.rejects(d.takeScreenshots("job002", {}, { capture }), /exactly one/);
});

test("a saved board is rendered over loopback HTTP from the job's folder, never file://", async () => {
  const { calls, capture } = fakeCapture();
  d.saveAsset("job003", "board.html", "<h1>Direction A</h1>");
  const files = await d.takeScreenshots("job003", { asset: "board.html", viewports: ["desktop"] }, { capture });
  assert.equal(files.length, 1);
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/board\.html$/);
  assert.equal(calls[0].body, "<h1>Direction A</h1>");
  await assert.rejects(d.takeScreenshots("job003", { asset: "missing.html" }, { capture }), /no asset/);
  await assert.rejects(d.takeScreenshots("job003", { asset: "../job001/palette.json" }, { capture }));
});

test("a branch is previewed through a local server that is always stopped afterwards", async () => {
  const { calls, capture } = fakeCapture();
  let stopped = 0;
  const previewed: string[] = [];
  const preview = async (branch: string) => {
    previewed.push(branch);
    return { base: "http://127.0.0.1:9", stop: async () => void stopped++ };
  };
  const failing = async () => {
    throw new Error("render failed");
  };
  await d.takeScreenshots("job004", { branch: "clear/restyle", path: "/#publishers", viewports: ["desktop"] }, { capture: async (r) => void calls.push(r), preview });
  assert.deepEqual(previewed, ["clear/restyle"]);
  assert.equal(calls[0].url, "http://127.0.0.1:9/#publishers");
  await assert.rejects(d.takeScreenshots("job004", { branch: "clear/restyle" }, { capture: failing, preview }));
  assert.equal(stopped, 2, "the preview server is stopped on success and on failure");
  await assert.rejects(d.takeScreenshots("job004", { branch: "--upload-pack=x" }, { capture, preview }));
  assert.equal(previewed.length, 2, "a bad branch name never reaches the preview");
});

test("the design worker's MCP server offers exactly screenshot and save_asset", () => {
  const server = d.designServer("job005") as any;
  assert.deepEqual(Object.keys(server.instance._registeredTools).sort(), ["save_asset", "screenshot"]);
  assert.deepEqual(d.DESIGN_TOOLS, ["mcp__design__screenshot", "mcp__design__save_asset"]);
});

test("the design verdict and image lines are parsed; images outside the job's folder are dropped", () => {
  assert.deepEqual(d.parseDesignVerdict("Spec...\nDESIGN: spec ready"), { outcome: "spec", detail: undefined });
  assert.deepEqual(d.parseDesignVerdict("**DESIGN: no high-impact issues**"), { outcome: "done", detail: undefined });
  assert.deepEqual(d.parseDesignVerdict("DESIGN: needs Paul: pick A, B or C."), { outcome: "needs_founder", detail: "pick A, B or C." });
  assert.equal(d.parseDesignVerdict("no verdict here"), undefined);
  assert.equal(d.parseDesignVerdict("DESIGN: spec ready\nDESIGN: no high-impact issues")!.outcome, "done", "the last line wins");

  const dir = d.designDir("job006");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a-desktop.png"), "png");
  fs.writeFileSync(path.join(dir, "notes.md"), "x");
  const imgs = d.reportImages(
    "job006",
    `IMAGE: ${path.join(dir, "a-desktop.png")} | Direction A\nIMAGE: a-desktop.png\nIMAGE: /etc/passwd | nope\nIMAGE: ../job002/clear-exchange-fly-dev-desktop.png | other job\nIMAGE: notes.md | not an image\nIMAGE: missing.png | gone`,
  );
  assert.deepEqual(imgs, [
    { file: path.join(dir, "a-desktop.png"), caption: "Direction A" },
    { file: path.join(dir, "a-desktop.png"), caption: "" },
  ]);
});

/* ---------- The egress proxy: every browser request is checked, not only the first ---------- */

test("the egress proxy allows the capture's one local port and refuses every other loopback port", async () => {
  const board = await localServer("board");
  const other = await localServer("the service itself");
  const proxy = await d.startEgressProxy({ allow: `127.0.0.1:${board.port}`, resolve: publicDns });
  try {
    assert.deepEqual(await viaProxy(proxy.url, `http://127.0.0.1:${board.port}/x.html`), { status: 200, body: "board" });
    const refused = await viaProxy(proxy.url, `http://127.0.0.1:${other.port}/`);
    assert.equal(refused.status, 403);
    assert.ok(!refused.body.includes("the service itself"));
    assert.equal(await connectVia(proxy.url, `127.0.0.1:${other.port}`), 403);
    assert.equal(await connectVia(proxy.url, `127.0.0.1:${board.port}`), 200);
    assert.equal((await viaProxy(proxy.url, "http://localhost:8080/")).status, 403);
    assert.equal((await viaProxy(proxy.url, "http://[::1]:8080/")).status, 403);
    assert.equal((await viaProxy(proxy.url, "http://169.254.169.254/latest/meta-data")).status, 403);
  } finally {
    await proxy.stop();
    await board.close();
    await other.close();
  }
});

test("IPv4 written in IPv6 form, NAT64, 6to4 and multicast are private however they are spelled", async () => {
  const priv = ["::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:0:0:1", "::7f00:1", "64:ff9b::7f00:1", "ff02::1", "fdaa::3",
    "::ffff:8.8.8.8", "2002:7f00:1::", "[::ffff:7f00:1]", "fe80::1%eth0", "0000:0000:0000:0000:0000:ffff:7f00:0001", "not-an-address"];
  for (const ip of priv) assert.ok(d.isPrivateAddress(ip), `${ip} is private`);
  for (const ip of ["2606:4700::1111", "2a00:1450:4009::1", "2001:4860:4860::8888"]) assert.ok(!d.isPrivateAddress(ip), `${ip} is public`);
  assert.deepEqual(d.expandIPv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(d.expandIPv6("::ffff:7f00:1"), d.expandIPv6("::ffff:127.0.0.1"), "both spellings are the same address");
  assert.equal(new URL("http://[::ffff:127.0.0.1]:8080/").hostname, "[::ffff:7f00:1]", "URL parsing rewrites the mapped form to hex");
  for (const raw of ["http://[::ffff:127.0.0.1]:8080/", "http://[::ffff:7f00:1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data", "http://[64:ff9b::a00:1]/"]) {
    await assert.rejects(d.checkPublicUrl(raw, publicDns), /private/, raw);
  }
  await assert.rejects(d.checkPublicUrl("http://mapped.example/", async () => ["::ffff:7f00:1"]), /private/);
});

test("the egress proxy refuses IPv4-mapped IPv6 loopback, written either way, and dials nothing", async () => {
  const board = await localServer("board");
  const other = await localServer("the service itself");
  const dialled: string[] = [];
  const dns: Record<string, string[]> = { "mapped.example": ["::ffff:7f00:1"] };
  const proxy = await d.startEgressProxy({
    allow: `127.0.0.1:${board.port}`,
    resolve: async (h) => dns[h] ?? [],
    dial: (ip, port) => (dialled.push(ip), net.connect({ host: "127.0.0.1", port })),
  });
  try {
    for (const url of [`http://[::ffff:127.0.0.1]:${other.port}/`, `http://[::ffff:7f00:1]:${other.port}/`, `http://[::ffff:7f00:1]:${board.port}/`, "http://mapped.example/"]) {
      const r = await viaProxy(proxy.url, url);
      assert.equal(r.status, 403, url);
      assert.ok(!r.body.includes("the service itself"), url);
    }
    assert.equal(await connectVia(proxy.url, `[::ffff:7f00:1]:${other.port}`), 403);
    assert.equal(await connectVia(proxy.url, `[::ffff:127.0.0.1]:${other.port}`), 403);
    assert.equal(await connectVia(proxy.url, "mapped.example:443"), 403);
    assert.deepEqual(dialled, [], "nothing was dialled");
  } finally {
    await proxy.stop();
    await board.close();
    await other.close();
  }
});

test("the egress proxy refuses hostnames that resolve to private or Fly 6PN addresses", async () => {
  const dns: Record<string, string[]> = { "ten.example": ["10.0.0.7"], "sixpn.example": ["fdaa:0:1:a7b::2"], "mixed.example": ["93.184.216.34", "127.0.0.1"] };
  const dialled: string[] = [];
  const proxy = await d.startEgressProxy({ resolve: async (h) => dns[h] ?? [], dial: (ip, port) => (dialled.push(ip), net.connect({ host: "127.0.0.1", port })) });
  try {
    for (const host of Object.keys(dns)) {
      assert.equal((await viaProxy(proxy.url, `http://${host}/`)).status, 403, `${host} over http`);
      assert.equal(await connectVia(proxy.url, `${host}:443`), 403, `${host} over CONNECT`);
    }
    assert.equal((await viaProxy(proxy.url, "http://unresolvable.example/")).status, 403);
    assert.deepEqual(dialled, [], "nothing private was ever connected to");
  } finally {
    await proxy.stop();
  }
});

test("the egress proxy allows public hosts and connects to the address it checked, so DNS rebinding fails", async () => {
  const site = await localServer("public page");
  let lookups = 0;
  // First answer public, every later answer private: a rebinding resolver.
  const rebinding = async () => (lookups++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
  const dialled: string[] = [];
  const proxy = await d.startEgressProxy({ resolve: rebinding, dial: (ip) => (dialled.push(ip), net.connect({ host: "127.0.0.1", port: site.port })) });
  try {
    assert.deepEqual(await viaProxy(proxy.url, "http://rebind.example/"), { status: 200, body: "public page" });
    assert.equal(lookups, 1, "the host is resolved once, by the proxy");
    assert.deepEqual(dialled, ["93.184.216.34"], "the connection goes to the checked address, not a fresh lookup");
    assert.equal((await viaProxy(proxy.url, "http://rebind.example/")).status, 403, "the rebound answer is refused");
    assert.equal(await connectVia(proxy.url, "93.184.216.34:443"), 200, "a public address over CONNECT is allowed");
  } finally {
    await proxy.stop();
    await site.close();
  }
});

test("a board that frames another local port, or a page that redirects to one, gets nothing", async () => {
  const service = await localServer("secret status page");
  try {
    const { calls, capture } = fakeCapture([`http://127.0.0.1:${service.port}/`, "http://[fdaa::3]:8080/", "http://redirected.example/"]);
    d.saveAsset("job007", "board.html", `<iframe src="http://127.0.0.1:${service.port}/"></iframe>`);
    const resolve = async (h: string) => (h === "redirected.example" ? ["192.168.0.1"] : ["93.184.216.34"]);
    await d.takeScreenshots("job007", { asset: "board.html", viewports: ["desktop"] }, { capture, resolve });
    assert.match(calls[0].body!, /iframe/, "the board itself is served");
    assert.deepEqual(calls[0].extra, [403, 403, 403], "everything the page loads from the private network is refused");
    assert.match(calls[0].proxy!, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await service.close();
  }
});

test("Chromium is always launched behind the proxy, loopback included, and tries its sandbox first", () => {
  const r = { url: "https://a.example/", out: "/x.png", width: 1440, height: 900, scale: 1, proxy: "http://127.0.0.1:4000" };
  const withSandbox = d.chromiumArgs(r, "/tmp/p", "/tmp/p/shot.png", true);
  assert.ok(withSandbox.includes("--proxy-server=http://127.0.0.1:4000"));
  assert.ok(withSandbox.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(withSandbox.includes("--screenshot=/tmp/p/shot.png"), "the screenshot is written in the browser's own folder");
  assert.ok(!withSandbox.includes("--no-sandbox"));
  assert.ok(d.chromiumArgs(r, "/tmp/p", "/tmp/p/shot.png", false).includes("--no-sandbox"));
});

test("the browser's account is never root; with no designer user, root refuses to launch", () => {
  const root = { uid: 0, gid: 0 };
  const designer = { uid: 999, gid: 998 };
  assert.deepEqual(d.chooseIdentity(designer, root), designer);
  assert.throws(() => d.chooseIdentity(undefined, root), /designer user not found; refusing to run the browser as root/);
  assert.throws(() => d.chooseIdentity({ uid: 0, gid: 0 }, root), /must not be root/);
  assert.throws(() => d.chooseIdentity({ uid: 999, gid: 0 }, root), /must not be root/);
  assert.deepEqual(d.chooseIdentity(undefined, { uid: 1000, gid: 1000 }), { uid: 1000, gid: 1000 }, "an unprivileged service runs it as itself");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-lock-"));
  fs.chmodSync(dir, 0o755);
  d.lockDown([dir, path.join(dir, "missing")]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "the data folder is closed to other accounts");
});
