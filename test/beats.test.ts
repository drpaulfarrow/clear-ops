/**
 * The beat maker: Paul's Stable Audio account, its free credits only, turned into a private track.
 *
 * No network and no model: every generation here goes to a fake Stable Audio API the test controls,
 * and every key is a fake one this test writes into its own temporary data dir. The real key file on
 * the volume is never read, never sent and never appears in any result or error. The tests cover a
 * full generation saved privately with the link that reaches Paul (A1), the key used only as a
 * request header and never echoed anywhere (A2), a path with no paid endpoint that fails closed
 * when the account has no free credits (A3), and the serving route that exposes the beats folder
 * alone, behind the same access the reports view uses (A4).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-beats-"));
process.env.PUBLIC_URL = "https://ops.example.test";

const {
  BEAT_CREDITS,
  BEAT_SERVER,
  BEAT_TOOLS,
  MAX_BEATS_PER_JOB,
  STABILITY_TEXT_TO_AUDIO,
  beatLink,
  beatsDir,
  checkBeatName,
  runGenerateBeat,
  saveBeat,
  sniffAudio,
  stabilityResultsPath,
} = await import("../src/beats.js");
const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { REPORTS_PATH, reportsToken } = await import("../src/reports.js");
const { signIn, SIGN_IN_PATH, SESSION_COOKIE } = await import("../src/sign-in.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { BROWSE_KINDS } = await import("../src/web-tools.js");
import type { AgentRunner } from "../src/agents.js";

/** This test's own fake key, written by the test into its own data dir. No test reads a real one. */
const KEY = "sk-fake-never-a-real-key-0123456789";
const keyFile = config.stabilityKeyFile;
const writeKey = () => fs.writeFileSync(keyFile, `${KEY}\n`);

/** A few bytes that really are an MP3 (an ID3 tag, then padding). */
const mp3 = (n = 64) => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(n)]);
const kind = () => sniffAudio(mp3())!;

/** What the fake Stable Audio API saw: every request, whole. */
interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}
/** A fake Stable Audio API: it records every request and answers from the script. */
function fakeStability(script: (req: Recorded, calls: number) => { status: number; contentType?: string; body: Buffer }) {
  const seen: Recorded[] = [];
  const call = async (req: Recorded) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { seen, call };
}

const store = new Store(process.env.DATA_DIR!);
const runner: AgentRunner = async () => {
  throw new Error("the beats tests must not run any worker");
};
const messenger = new ConsoleMessenger();
let server: import("node:http").Server;
let base: string;
let session = "";
const PASSWORD = "the beats test password";
const get = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), cookie: session } });

before(async () => {
  const built = buildApp({ messenger, runner, store });
  await new Promise<void>((r) => (server = built.app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  signIn.setPassword(store, PASSWORD);
  const signedIn = await fetch(`${base}${SIGN_IN_PATH}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  });
  session = (signedIn.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0];
  if (!session) throw new Error(`the beats test could not sign in: ${signedIn.status}`);
});

after(() => {
  server.close();
});

test("the key file lives inside the data dir, so no test ever touches a real key", () => {
  assert.ok(path.resolve(keyFile).startsWith(path.resolve(process.env.DATA_DIR!) + path.sep), keyFile);
  assert.equal(keyFile, path.join(process.env.DATA_DIR!, "stability-api.key"), "the default is DATA_DIR/stability-api.key");
});

test("A1: a generation against the fake Stable Audio API saves the track privately and returns Paul's private link", async () => {
  writeKey();
  let polls = 0;
  const api = fakeStability((req, calls) => {
    if (req.method === "POST") return { status: 202, contentType: "application/json", body: Buffer.from(JSON.stringify({ id: "gen_01" })) };
    polls += 1;
    return polls < 2
      ? { status: 202, contentType: "application/json", body: Buffer.from(JSON.stringify({ status: "in-progress" })) }
      : { status: 200, contentType: "audio/mpeg", body: mp3(2048) };
  });
  const out = await runGenerateBeat(
    { name: "boom-bap-90bpm-2026-11-19-01.mp3", prompt: "boom bap hip hop instrumental, 90 bpm, dusty drums, upright bass, no vocals", duration: 60, bpm: 90 },
    { store, call: api.call, pollMs: 1 },
  );
  assert.ok(!out.isError, out.content.map((c: { text?: string }) => c.text).join(" "));
  // The track is in the private beats folder, owner-only, byte for byte what the API returned.
  const file = path.join(beatsDir(), "boom-bap-90bpm-2026-11-19-01.mp3");
  assert.ok(fs.existsSync(file), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the track is owner-only");
  assert.equal(fs.statSync(beatsDir()).mode & 0o777, 0o700);
  assert.deepEqual(fs.readFileSync(file), mp3(2048), "the bytes are saved as they came");
  const note = JSON.parse(fs.readFileSync(path.join(beatsDir(), "boom-bap-90bpm-2026-11-19-01.json"), "utf8")) as Record<string, unknown>;
  assert.equal(note.prompt, "boom bap hip hop instrumental, 90 bpm, dusty drums, upright bass, no vocals");
  assert.equal(note.service, "Stable Audio");
  assert.equal(note.seconds, 60);
  assert.equal(note.bpm, 90);
  assert.equal(note.credits, BEAT_CREDITS, "the note says what each generation costs in free credits");
  assert.match(fs.readFileSync(path.join(beatsDir(), "index.md"), "utf8"), /boom-bap-90bpm-2026-11-19-01\.mp3/);
  // The result the worker puts in its report carries the private link, and it opens the track (below).
  const text = out.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  const link = `${config.publicUrl}${REPORTS_PATH}/beat/boom-bap-90bpm-2026-11-19-01.mp3?t=${reportsToken(store)}`;
  assert.ok(text.includes(link), `the report result must carry ${link}, got: ${text}`);
  assert.equal(beatLink(store, "boom-bap-90bpm-2026-11-19-01.mp3"), link);
});

test("A2: the key is used only as a request header, and never appears in any result, error or saved note", async () => {
  writeKey();
  let polls = 0;
  const api = fakeStability((req) => {
    if (req.method === "POST") return { status: 202, contentType: "application/json", body: Buffer.from(JSON.stringify({ id: "gen_02" })) };
    polls += 1;
    return { status: 200, contentType: "audio/mpeg", body: mp3(512) };
  });
  const out = await runGenerateBeat({ name: "key-check-88bpm-2026-11-19-02.mp3", prompt: "lo-fi instrumental, 88 bpm" }, { store, call: api.call, pollMs: 1 });
  assert.ok(!out.isError);
  assert.ok(api.seen.length >= 2, "the POST and at least one poll");
  for (const req of api.seen) {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`, "the key is the bearer header on every request");
    assert.ok(!req.path.includes(KEY), "never in the path");
    assert.ok(!(req.body ? req.body.toString() : "").includes(KEY), "never in the request body");
  }
  const text = out.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  assert.ok(!text.includes(KEY), "never in the result the worker reports");
  for (const f of fs.readdirSync(beatsDir())) {
    const content = fs.readFileSync(path.join(beatsDir(), f));
    assert.ok(!content.toString().includes(KEY), `never in the saved ${f}`);
  }
  // A server that echoes the key back in an error body still cannot get it into the error text.
  const leaky = fakeStability(() => ({ status: 401, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: `key ${KEY} was refused` })) }));
  const refused = await runGenerateBeat({ name: "key-check-88bpm-2026-11-19-03.mp3", prompt: "lo-fi instrumental" }, { store, call: leaky.call, pollMs: 1 });
  assert.ok(refused.isError, "a refused key is an error, not a beat");
  const refusedText = refused.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  assert.ok(!refusedText.includes(KEY), "the error never echoes the key");
  assert.match(refusedText, /refused/i);
  // A missing or empty key file fails closed with a plain reason, and nothing is sent anywhere.
  fs.rmSync(keyFile);
  const noKey = await runGenerateBeat({ name: "key-check-88bpm-2026-11-19-04.mp3", prompt: "lo-fi instrumental" }, { store, call: api.call, pollMs: 1 });
  assert.ok(noKey.isError);
  assert.equal(api.seen.filter((r) => r.method === "POST").length, 1, "no request was made for the missing key");
  assert.match(noKey.content.map((c: { text?: string }) => c.text ?? "").join("\n"), /key/i);
});

test("A3: no paid endpoint is ever called, and the path fails closed when the account has no free credits", async () => {
  writeKey();
  let polls = 0;
  const api = fakeStability((req) => {
    if (req.method === "POST") return { status: 202, contentType: "application/json", body: Buffer.from(JSON.stringify({ id: "gen_03" })) };
    polls += 1;
    return { status: 200, contentType: "audio/mpeg", body: mp3(256) };
  });
  await runGenerateBeat({ name: "endpoints-check-90bpm-2026-11-19-01.mp3", prompt: "trap instrumental, 140 bpm" }, { store, call: api.call, pollMs: 1 });
  const paths = api.seen.map((r) => `${r.method} ${r.path}`);
  const allowed = new Set<string>([`POST ${STABILITY_TEXT_TO_AUDIO}`, `GET ${stabilityResultsPath("gen_03")}`]);
  for (const p of paths) assert.ok(allowed.has(p), `only the two documented endpoints, got ${p}`);
  assert.ok(!api.seen.some((r) => /top-?up|subscription|card|checkout|purchase|payment|billing/i.test(r.path)), "no paid endpoint exists on the path");
  // The credits are flat and named, so the worker can tell Paul what each one costs.
  assert.equal(BEAT_CREDITS, 8);
  // The write kind that carries the tool is not a browsing kind, so it can never be granted the purchase permit.
  assert.ok(!BROWSE_KINDS.includes("write"), "write never gets the purchase server");
  assert.deepEqual(BEAT_TOOLS, [`mcp__${BEAT_SERVER}__generate_beat`], "the one tool, and no way to buy anything");

  // The account has no free credits: the API says 402, the path says so and stops.
  const before = fs.existsSync(beatsDir()) ? fs.readdirSync(beatsDir()).length : 0;
  const broke = fakeStability(() => ({ status: 402, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: "insufficient_credits" })) }));
  const out = await runGenerateBeat({ name: "broke-check-90bpm-2026-11-19-01.mp3", prompt: "boom bap instrumental" }, { store, call: broke.call, pollMs: 1 });
  assert.ok(out.isError, "no credits is an error, never a purchase");
  const text = out.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  assert.match(text, /no free credits/i);
  assert.match(text, /nothing was bought/i);
  assert.equal(broke.seen.length, 1, "the poll endpoint was never touched after the refusal");
  assert.equal(fs.existsSync(beatsDir()) ? fs.readdirSync(beatsDir()).length : 0, before, "nothing was saved");

  // The same refusal mid-poll: the generation was accepted, the answer came back empty.
  const brokeLate = fakeStability((req) =>
    req.method === "POST"
      ? { status: 202, contentType: "application/json", body: Buffer.from(JSON.stringify({ id: "gen_04" })) }
      : { status: 402, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: "insufficient_credits" })) },
  );
  const late = await runGenerateBeat({ name: "broke-check-90bpm-2026-11-19-02.mp3", prompt: "boom bap instrumental" }, { store, call: brokeLate.call, pollMs: 1 });
  assert.ok(late.isError);
  assert.match(late.content.map((c: { text?: string }) => c.text ?? "").join("\n"), /no free credits/i);
  assert.equal(brokeLate.seen.length, 2, "the POST and one poll, then stop");

  // A per-job cap keeps one worker from burning the account's whole balance.
  const meter = { made: 0, max: 2 };
  const capped = fakeStability((req) =>
    req.method === "POST"
      ? { status: 202, contentType: "application/json", body: Buffer.from(JSON.stringify({ id: "gen_05" })) }
      : { status: 200, contentType: "audio/mpeg", body: mp3(64) },
  );
  for (let i = 0; i < 3; i++) {
    const one = await runGenerateBeat({ name: `cap-check-90bpm-2026-11-19-0${i + 1}.mp3`, prompt: "drill instrumental, 140 bpm" }, { store, call: capped.call, pollMs: 1, meter });
    if (i < 2) assert.ok(!one.isError, `generation ${i + 1} of the cap should work`);
    else {
      assert.ok(one.isError, "past the cap the tool refuses");
      assert.match(one.content.map((c: { text?: string }) => c.text ?? "").join("\n"), /at most 2/);
    }
  }
  assert.equal(capped.seen.filter((r) => r.method === "POST").length, 2, "the API was asked for exactly the capped number of generations");
  assert.equal(MAX_BEATS_PER_JOB, 3, "the service's own cap is three per job");
});

test("A4: the serving route exposes the beats folder alone, behind the same access the reports view uses", async () => {
  const saved = saveBeat("serve-me-90bpm-2026-11-19-01.mp3", mp3(256), kind(), { prompt: "boom bap instrumental" });
  // A file with a perfectly good beat name that lives in the CV folder, not the beats folder.
  fs.mkdirSync(path.join(process.env.DATA_DIR!, "cv"), { recursive: true });
  fs.writeFileSync(path.join(process.env.DATA_DIR!, "cv", "escape-90bpm.mp3"), mp3(99));
  const token = reportsToken(store);
  const url = (name: string) => `${base}${REPORTS_PATH}/beat/${encodeURIComponent(name)}?t=${token}`;

  // Without the sign-in session: not the track and not a 404, the sign-in page, like the reports view.
  const out = await fetch(`${base}${REPORTS_PATH}/beat/serve-me-90bpm-2026-11-19-01.mp3?t=${token}`, { redirect: "manual" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), `${SIGN_IN_PATH}?next=${encodeURIComponent(`${REPORTS_PATH}/beat/serve-me-90bpm-2026-11-19-01.mp3?t=${token}`)}`);

  // Signed in but no token, or the wrong one: refused exactly like the reports view.
  assert.equal((await get(`${base}${REPORTS_PATH}/beat/serve-me-90bpm-2026-11-19-01.mp3`)).status, 404);
  assert.equal((await get(`${base}${REPORTS_PATH}/beat/serve-me-90bpm-2026-11-19-01.mp3?t=not-the-token`)).status, 404);

  // Signed in with the token: the track itself, as audio, with the view's own headers.
  const good = await get(url("serve-me-90bpm-2026-11-19-01.mp3"));
  assert.equal(good.status, 200);
  assert.match(good.headers.get("content-type") ?? "", /^audio\//);
  assert.equal(good.headers.get("x-content-type-options"), "nosniff");
  assert.match(good.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(good.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), mp3(256), "the bytes as they were saved");

  // Nothing else is reachable through it: not the CV folder, not a climb out of the folder, not the
  // notes or the index beside the track, not a name that does not exist.
  for (const bad of ["escape-90bpm.mp3", "../../cv/escape-90bpm.mp3", "..%2F..%2Fcv%2Fescape-90bpm.mp3", "serve-me-90bpm-2026-11-19-01.json", "index.md", "no-such-beat.mp3"]) {
    const res = await get(`${base}${REPORTS_PATH}/beat/${encodeURIComponent(bad)}?t=${token}`);
    assert.equal(res.status, 404, `${bad} is never served`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(!body.equals(mp3(99)), `${bad} is not the CV folder's file`);
    assert.ok(!body.includes(fs.readFileSync(saved.file).subarray(0, 3)), `${bad} is not the track either when it must not be`);
  }
  // Only a GET: nothing on the route can write.
  assert.equal((await get(url("serve-me-90bpm-2026-11-19-01.mp3"), { method: "POST" })).status, 404);
});

test("a beat file name is one plain audio name: no paths, no other extensions", () => {
  assert.equal(checkBeatName("boom-bap-90bpm-2026-11-19-01.mp3"), "boom-bap-90bpm-2026-11-19-01.mp3");
  assert.equal(checkBeatName("Dusty_Loop-2.WAV"), "Dusty_Loop-2.WAV");
  for (const bad of ["../etc/passwd.mp3", "a/b.mp3", "beat.mp3.txt", "beat.exe", ".mp3", "x", "beat.mp3\n.mp3"]) assert.throws(() => checkBeatName(bad), bad);
  // Only real audio is ever saved, so an error page is never written as a track.
  assert.equal(sniffAudio(Buffer.from("<!doctype html><html>sign in</html>")), undefined);
  assert.equal(sniffAudio(mp3())?.ext, "mp3");
  assert.equal(sniffAudio(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]))?.ext, "wav");
});
