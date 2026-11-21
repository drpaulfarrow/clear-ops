/**
 * Installing the app to a phone's home screen (docs/APP.md): a description of the app the browser reads,
 * its icons, and a "Talk to Cleo" shortcut. All of it is fixed files with no data in them. There is no
 * service worker: nothing is kept offline and nothing runs when the app is closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-install-"));

const { appAsset, appShell, appSignInPage, APP_CSP, APP_ASSETS_PATH } = await import("../src/app-pages.js");
const { APP_PATH } = await import("../src/app-auth.js");

type Icon = { src: string; sizes: string; type: string; purpose?: string };
const manifest = JSON.parse(appAsset("manifest.webmanifest")!.body.toString("utf8")) as {
  id: string; name: string; short_name: string; start_url: string; scope: string; display: string; background_color: string; theme_color: string;
  icons: Icon[]; shortcuts: Array<{ name: string; url: string; icons: Icon[] }>;
};
/** The width and height a PNG says it has. */
const pngSize = (body: Buffer) => `${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`;
const named = (src: string) => src.slice(`${APP_ASSETS_PATH}/`.length);

test("the app says what it is, so a phone can install it to the home screen as its own app", () => {
  assert.equal(appAsset("manifest.webmanifest")!.type, "application/manifest+json; charset=utf-8");
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope, manifest.display, manifest.name, manifest.short_name], [APP_PATH, APP_PATH, APP_PATH, "standalone", "ClearOps", "ClearOps"]);
  // It opens on the app's own dark ground, like the page.
  assert.deepEqual([manifest.background_color, manifest.theme_color], ["#0B0E13", "#0B0E13"]);
  assert.match(appShell(), /<meta name="theme-color" content="#0B0E13">/);
  // Both pages point to it, and the page's own policy lets it be read from here and nowhere else.
  for (const page of [appShell(), appSignInPage({ enabled: true, login: "drpaulfarrow" })]) assert.match(page, /<link rel="manifest" href="\/app\/assets\/manifest\.webmanifest">/);
  assert.match(APP_CSP, /manifest-src 'self'/);
  // It is a description and nothing else: no data, no address outside the app, nothing about Paul's work.
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /https?:|\/\/|token|key|drpaulfarrow|@/i);
  for (const url of [manifest.start_url, ...manifest.shortcuts.map((s) => s.url), ...manifest.icons.map((i) => i.src), ...manifest.shortcuts.flatMap((s) => s.icons.map((i) => i.src))]) assert.ok(url === APP_PATH || url.startsWith(`${APP_PATH}/`) || url.startsWith(`${APP_PATH}#`), url);
});

test("its icons are files in the fixed table, in the sizes a phone asks for and the size each says it is", () => {
  // The two sizes Chrome asks for before it will install, and one a launcher may cut to its own shape.
  assert.deepEqual(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`), ["192x192 any", "512x512 any", "512x512 maskable"]);
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons)]) {
    const asset = appAsset(named(icon.src));
    assert.ok(asset, `${icon.src} is served`);
    assert.equal(asset.type, "image/png");
    assert.deepEqual([...asset.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], icon.src);
    assert.equal(pngSize(asset.body), icon.sizes, icon.src);
  }
});

test("the Talk to Cleo shortcut opens her conversation, and nothing is listened to until he taps", () => {
  assert.deepEqual(manifest.shortcuts.map((s) => [s.name, s.url, s.icons.map((i) => i.sizes)]), [["Talk to Cleo", "/app#/cleo", ["96x96", "192x192"]]]);
  const js = fs.readFileSync("public/app/app.js", "utf8");
  const opened = js.slice(js.indexOf("function fromShortcut() {"), js.indexOf('window.addEventListener("hashchange"'));
  assert.match(opened, /if \(location\.hash !== "#\/cleo"\) return false;\s*history\.replaceState\(null, "", "#\/"\);/, "the address is put back, so going back or reloading does not open her again");
  assert.match(opened, /state\.cleoOpen = true;\s*void refreshCleo\(\);/);
  // Opening her is not talking to her: the microphone is asked for only by his tap on her button.
  assert.doesNotMatch(opened, /startTalking|getUserMedia|MediaRecorder|AudioContext/);
  assert.match(js, /fromShortcut\(\);\s*draw\(\);/, "it is looked for when the app starts");
  assert.match(js, /window\.addEventListener\("hashchange", \(\) => \{\s*fromShortcut\(\);/, "and when an app that is already open is sent there");
});

test("nothing runs when the app is closed: there is no service worker, and so no offline copy and no push", () => {
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.doesNotMatch(js, /serviceWorker|caches\.|PushManager|Notification\./);
  assert.equal(appAsset("sw.js"), undefined);
  assert.equal(appAsset("service-worker.js"), undefined);
  assert.doesNotMatch(APP_CSP, /worker-src/);
});
