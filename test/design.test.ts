import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-design-"));

const d = await import("../src/design.js");
import type { CaptureRequest } from "../src/design.js";

const publicDns = async () => ["93.184.216.34"];

/** A capture that records what it was asked and fetches the page, so local servers are exercised for real. */
function fakeCapture() {
  const calls: Array<CaptureRequest & { body?: string }> = [];
  const capture = async (r: CaptureRequest) => {
    const body = r.url.startsWith("http://127.0.0.1") ? await (await fetch(r.url)).text() : undefined;
    calls.push({ ...r, body });
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
