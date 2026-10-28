import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.ALLOWED_DISCORD_IDS = "424242";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-up-"));
process.env.TELEGRAM_BOT_TOKEN = "123:SECRET-TOKEN";

const { Uploads, sanitiseName, fetchCapped, UploadError, describeUploads, inlineImages, receiptText } = await import("../src/uploads.js");
const { config, isAllowed } = await import("../src/config.js");
const { parseUpdates, telegramAttachment } = await import("../src/telegram.js");
const { DiscordListener, discordAttachment } = await import("../src/discord.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { workerSpec, JOB_KINDS, readableDirs, UPLOADS_RULE } = await import("../src/agents.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";
import type { Attachment } from "../src/uploads.js";

const fixedDate = () => new Date("2026-10-28T09:00:00Z");
const freshDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-updir-")), "uploads");
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const att = (name: string, data: Buffer, mimeType?: string, size?: number): Attachment & { calls: number } => {
  const a = { name, mimeType, size, calls: 0, download: async () => (a.calls++, data) };
  return a;
};

/** A small zip writer for tests: stored or deflated entries, optional symlink and directory entries. */
function zip(entries: Array<{ name: string; data?: string; deflate?: boolean; symlink?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data ?? "");
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ---------- naming and sanitisation ---------- */

test("file names are sanitised so nothing escapes the uploads directory", () => {
  assert.equal(sanitiseName("../../etc/passwd"), "passwd");
  assert.equal(sanitiseName("..\\..\\windows\\evil.csv"), "evil.csv");
  assert.equal(sanitiseName(".."), "file");
  assert.equal(sanitiseName(""), "file");
  assert.equal(sanitiseName(".env"), "env", "no hidden files");
  assert.equal(sanitiseName("Connections.csv"), "Connections.csv");
  assert.equal(sanitiseName("My Deck (final).pdf"), "My_Deck_final_.pdf");
  assert.equal(sanitiseName("a;rm -rf $(x)`.sh"), "a_rm_-rf_x_.sh");
  assert.equal(sanitiseName("x..csv"), "x.csv");
  const long = sanitiseName(`${"a".repeat(300)}.xlsx`);
  assert.ok(long.length <= 120 && long.endsWith(".xlsx"));
});

test("an upload is saved as <date>-<name>, owner-only, never overwriting an earlier one", () => {
  const up = new Uploads(freshDir(), undefined, fixedDate);
  const a = up.save("../Connections.csv", Buffer.from("First Name,Last Name\nAda,Lovelace\n"), "text/csv", "my LinkedIn export");
  assert.equal(a.name, "2026-10-28-Connections.csv");
  assert.equal(a.path, path.join(up.dir, a.name));
  assert.equal(a.originalName, "../Connections.csv");
  assert.equal(a.size, 34);
  assert.equal(a.caption, "my LinkedIn export");
  assert.equal(mode(up.dir), 0o700);
  assert.equal(mode(a.path), 0o600);
  const b = up.save("Connections.csv", Buffer.from("second"));
  assert.equal(b.name, "2026-10-28-Connections-2.csv");
  assert.equal(b.mimeType, "text/csv", "type guessed from the extension");
  assert.equal(fs.readFileSync(a.path, "utf8").startsWith("First Name"), true, "the first file is untouched");
});

test("the uploads directory may never sit inside a git checkout", () => {
  assert.throws(() => new Uploads(path.join(config.repoDir, "uploads")), /must not be inside the git checkout/);
  assert.throws(() => new Uploads(path.join(config.selfRepoDir, "data", "uploads")), /must not be inside the git checkout/);
  assert.throws(() => new Uploads(config.selfRepoDir), /must not be inside the git checkout/);
});

/* ---------- size limits and download ---------- */

test("an attachment over the size limit is refused before downloading, and a download that grows past it is cut off", async () => {
  const up = new Uploads(freshDir(), { maxBytes: 10, maxArchiveEntries: 10, maxArchiveBytes: 100 }, fixedDate);
  const big = att("big.csv", Buffer.alloc(5), "text/csv", 1024);
  await assert.rejects(() => up.ingest(big), (e: Error) => e instanceof UploadError && /too large/.test(e.message));
  assert.equal(big.calls, 0, "never downloaded");
  const lying = att("lying.csv", Buffer.alloc(50), "text/csv", 5);
  await assert.rejects(() => up.ingest(lying), /too large/);
  assert.equal(fs.readdirSync(up.dir).length, 0, "nothing written");

  const okFetch = (async () => new Response("hello world, this is long")) as unknown as typeof fetch;
  await assert.rejects(() => fetchCapped("https://cdn.discordapp.com/x", 10, okFetch), /too large/);
  const declared = (async () => new Response("x", { headers: { "content-length": "999999" } })) as unknown as typeof fetch;
  await assert.rejects(() => fetchCapped("https://cdn.discordapp.com/x", 10, declared), /too large/);
  await assert.rejects(() => fetchCapped("http://example.com/x", 10, okFetch), /non-https/);
  assert.equal((await fetchCapped("https://cdn.discordapp.com/x", 100, okFetch)).toString(), "hello world, this is long");
});

test("Telegram files download through getFile, and the bot token never appears in an error", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url).endsWith("/getFile")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { file_id: "F1" });
      return Response.json({ ok: true, result: { file_path: "documents/file_1.csv", file_size: 5 } });
    }
    return new Response("a,b\n1");
  }) as unknown as typeof fetch;
  const a = telegramAttachment({ fileId: "F1", name: "Connections.csv", mimeType: "text/csv", size: 5 }, fakeFetch);
  assert.equal((await a.download(100)).toString(), "a,b\n1");
  assert.equal(urls[1], "https://api.telegram.org/file/bot123:SECRET-TOKEN/documents/file_1.csv");

  const failing = (async (url: string) =>
    String(url).endsWith("/getFile") ? Response.json({ ok: true, result: { file_path: "x" } }) : new Response("no", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(
    () => telegramAttachment({ fileId: "F2", name: "x" }, failing).download(100),
    (e: Error) => !e.message.includes("SECRET-TOKEN") && /download failed/.test(e.message),
  );
});

test("Telegram updates carry documents, the largest photo and the caption as the text", () => {
  const msgs = parseUpdates([
    { update_id: 1, message: { message_id: 7, caption: "cross-reference this", chat: { id: 99887766, type: "private" }, document: { file_id: "D", file_name: "Connections.csv", mime_type: "text/csv", file_size: 1200 } } },
    { update_id: 2, message: { message_id: 8, chat: { id: 99887766, type: "private" }, photo: [{ file_id: "small", file_size: 100 }, { file_id: "large", file_size: 9000 }, { file_id: "mid", file_size: 900 }] } },
    { update_id: 3, message: { message_id: 9, chat: { id: 5, type: "group" }, document: { file_id: "G" } } },
    { update_id: 4, message: { message_id: 10, text: "hi", chat: { id: 99887766, type: "private" } } },
  ]);
  assert.equal(msgs.length, 3, "group messages are ignored");
  assert.deepEqual(msgs[0], { from: "tg:99887766", text: "cross-reference this", files: [{ fileId: "D", name: "Connections.csv", mimeType: "text/csv", size: 1200 }] });
  assert.deepEqual(msgs[1].files, [{ fileId: "large", name: "photo-8.jpg", mimeType: "image/jpeg", size: 9000 }]);
  assert.equal(msgs[1].text, "");
  assert.deepEqual(msgs[2], { from: "tg:99887766", text: "hi" });
});

test("Discord attachments reach the handler only from allowlisted users, and only download from Discord's CDN", async () => {
  const handled: Array<{ from: string; text: string; ctx: any }> = [];
  const listener = new DiscordListener(async (from, text, ctx) => void handled.push({ from, text, ctx }), isAllowed);
  const files = new Map([["1", { name: "deck.pdf", contentType: "application/pdf", size: 2048, url: "https://cdn.discordapp.com/attachments/1/2/deck.pdf" }]]);
  const channel = { send: async () => undefined };
  await listener.onMessage({ author: { id: "424242", bot: false }, content: "", channelId: "c1", id: "m1", channel, attachments: files } as any);
  assert.equal(handled.length, 1, "a file with no text is still handled");
  assert.equal(handled[0].ctx.attachments[0].name, "deck.pdf");
  assert.equal(handled[0].ctx.attachments[0].size, 2048);
  await listener.onMessage({ author: { id: "7", bot: false }, content: "", channelId: "c1", id: "m2", channel, attachments: files } as any);
  assert.equal(handled.length, 1, "unlisted users' files are never handled");

  await assert.rejects(() => discordAttachment({ name: "x", size: 1, url: "https://169.254.169.254/latest" }).download(10), /outside Discord/);
});

/* ---------- archives ---------- */

test("a zip is unpacked into its own new directory; traversal, absolute paths and links are skipped", () => {
  const up = new Uploads(freshDir(), undefined, fixedDate);
  const archive = zip([
    { name: "export/Connections.csv", data: "a,b\n1,2\n", deflate: true },
    { name: "export/", data: "" },
    { name: "notes.txt", data: "stored" },
    { name: "../escape.txt", data: "no" },
    { name: "/etc/cron.d/evil", data: "no" },
    { name: "C:\\evil.txt", data: "no" },
    { name: "link", data: "/etc/passwd", symlink: true },
  ]);
  const saved = up.save("linkedin.zip", archive, "application/zip");
  const x = saved.extracted!;
  assert.equal(x.dir, path.join(up.dir, "2026-10-28-linkedin.zip-files"));
  assert.equal(x.files, 2);
  assert.equal(x.skipped, 4);
  assert.equal(x.error, undefined);
  assert.equal(fs.readFileSync(path.join(x.dir, "export", "Connections.csv"), "utf8"), "a,b\n1,2\n");
  assert.equal(fs.readFileSync(path.join(x.dir, "notes.txt"), "utf8"), "stored");
  assert.equal(fs.existsSync(path.join(up.dir, "escape.txt")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(up.dir), "escape.txt")), false);
  assert.equal(fs.existsSync(path.join(x.dir, "link")), false);
  assert.equal(mode(x.dir), 0o700);
  assert.equal(mode(path.join(x.dir, "notes.txt")), 0o600);
});

test("a zip that unpacks past the limit is stopped, and a corrupt one is reported, not thrown", () => {
  const up = new Uploads(freshDir(), { maxBytes: 1024 * 1024, maxArchiveEntries: 3, maxArchiveBytes: 1000 }, fixedDate);
  const bomb = zip([{ name: "big.txt", data: "0".repeat(50_000), deflate: true }]);
  assert.ok(bomb.length < 1000, "small on the wire");
  const r = up.save("bomb.zip", bomb, "application/zip");
  assert.match(r.extracted!.error!, /more than/);
  assert.equal(r.extracted!.files, 0);
  const many = up.save("many.zip", zip([1, 2, 3, 4].map((i) => ({ name: `${i}.txt`, data: "x" }))), "application/zip");
  assert.match(many.extracted!.error!, /more than 3 entries/);
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
  const b = up.save("broken.zip", broken, "application/zip");
  assert.match(b.extracted!.error!, /zip|corrupt|could not be read/);
});

/* ---------- deletion ---------- */

test("an upload can be deleted by its saved or original name, with anything unpacked from it", () => {
  const up = new Uploads(freshDir(), undefined, fixedDate);
  up.save("Connections.csv", Buffer.from("x"));
  up.save("linkedin.zip", zip([{ name: "a.txt", data: "a" }]), "application/zip");
  up.save("deck.pdf", Buffer.from("%PDF"));
  up.save("deck.pdf", Buffer.from("%PDF2"));

  assert.match(up.delete("Connections.csv").message, /Deleted 2026-10-28-Connections.csv/);
  assert.equal(fs.existsSync(path.join(up.dir, "2026-10-28-Connections.csv")), false);

  const z = up.delete("2026-10-28-linkedin.zip");
  assert.deepEqual(z.deleted, ["2026-10-28-linkedin.zip", "2026-10-28-linkedin.zip-files"]);
  assert.equal(fs.existsSync(path.join(up.dir, "2026-10-28-linkedin.zip-files")), false);

  assert.match(up.delete("../../etc/passwd").message, /No upload called/);
  assert.match(up.delete("nope.csv").message, /No upload called/);
  assert.deepEqual(up.delete("deck.pdf").deleted, ["2026-10-28-deck.pdf"], "the exact original-name match wins");
  assert.equal(up.list().length, 1);
  assert.match(up.delete("all").message, /Deleted 2026-10-28-deck-2.pdf/);
  assert.equal(up.list().length, 0);
  assert.match(up.delete("all").message, /no uploads/);
  assert.ok(fs.existsSync(up.dir), "the directory itself stays");
});

/* ---------- the chief ---------- */

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-up-orch-"));
  const store = new Store(dir);
  const messenger = new ConsoleMessenger();
  const calls: RunOptions[] = [];
  const uploads = new Uploads(path.join(dir, "uploads"), undefined, fixedDate);
  const runner: AgentRunner = async (o) => {
    calls.push(o);
    const ops = o.mcpServers?.ops as any;
    if (ops && o.prompt.includes("please delete it")) {
      const t = ops.instance?._registeredTools?.delete_upload;
      const r = await (t?.callback ?? t?.handler)({ name: "Connections.csv" }, {});
      return { text: r.content[0].text, sessionId: "s" };
    }
    return { text: "chief replied", sessionId: "s" };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner, {}, uploads);
  return { orch, messenger, calls, uploads };
}

test("an upload is confirmed in chat and the chief is told its path, name, type, size and caption", async () => {
  const { orch, messenger, calls, uploads } = harness();
  const csv = att("Connections.csv", Buffer.from("First Name,Last Name\n"), "text/csv", 21);
  await orch.handle("tg:99887766", "cross-reference with the publisher list", { attachments: [csv] });
  assert.equal(csv.calls, 1);
  assert.equal(messenger.sent[0].text, "Saved Connections.csv (21 B). /delete upload <name> removes it.");
  assert.equal(messenger.sent.at(-1)!.text, "chief replied");
  const p = calls[0].prompt;
  assert.ok(p.includes(path.join(uploads.dir, "2026-10-28-Connections.csv")), "path");
  assert.match(p, /original name "Connections.csv", text\/csv, 21 B\), caption: "cross-reference with the publisher list"/);
  assert.match(p, /untrusted data/);
  assert.match(p, /Paul's message: cross-reference with the publisher list$/);
  assert.equal(calls[0].images, undefined, "a CSV is not an image");
  assert.match(calls[0].systemPrompt, /Paul can send files in chat/);
});

test("an image Paul sends is shown to the chief, not just described", async () => {
  const { orch, calls } = harness();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await orch.handle("tg:99887766", "", { attachments: [att("photo-8.jpg", png, "image/png")] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images, [{ mediaType: "image/png", data: png.toString("base64") }]);
  assert.match(calls[0].prompt, /The image is attached to this message so you can see it/);
  assert.match(calls[0].prompt, /Paul sent no message with the file/);
});

test("files from an unlisted sender are never downloaded or saved", async () => {
  const { orch, messenger, calls, uploads } = harness();
  const f = att("x.csv", Buffer.from("x"), "text/csv");
  await orch.handle("tg:1", "", { attachments: [f] });
  assert.equal(f.calls, 0);
  assert.equal(uploads.list().length, 0);
  assert.equal(messenger.sent.length, 0);
  assert.equal(calls.length, 0);
});

test("a refused file is reported, and the chief is not woken when nothing was saved", async () => {
  const { orch, messenger, calls } = harness();
  await orch.handle("dc:u:424242", "", { replyTo: "dc:c:c1", attachments: [att("huge.zip", Buffer.alloc(1), "application/zip", 500 * 1024 * 1024)] });
  assert.match(messenger.sent[0].text, /Could not save huge.zip: too large \(500.0 MB; limit 20.0 MB\)/);
  assert.equal(messenger.sent[0].to, "dc:c:c1");
  assert.equal(calls.length, 0);
});

test("/uploads lists files and /delete upload removes one; the chief can delete with a tool", async () => {
  const { orch, messenger, uploads } = harness();
  uploads.save("Connections.csv", Buffer.from("x"));
  uploads.save("deck.pdf", Buffer.from("y"));
  await orch.handle("tg:99887766", "/uploads");
  assert.match(messenger.sent.at(-1)!.text, /2026-10-28-Connections.csv \(1 B\)/);
  await orch.handle("tg:99887766", "/delete upload deck.pdf");
  assert.equal(messenger.sent.at(-1)!.text, "Deleted 2026-10-28-deck.pdf.");
  await orch.handle("tg:99887766", "I am done with my connections file, please delete it");
  assert.equal(messenger.sent.at(-1)!.text, "Deleted 2026-10-28-Connections.csv.");
  assert.equal(uploads.list().length, 0);
});

test("describe and receipt helpers stay short and complete", () => {
  const up = new Uploads(freshDir(), undefined, fixedDate);
  const img = up.save("shot.png", Buffer.alloc(10), "image/png");
  const text = describeUploads([img], [{ name: "big.mov", reason: "too large" }], inlineImages([img]).length);
  assert.match(text, /Paul sent 2 file\(s\)/);
  assert.match(text, /big.mov was not saved: too large/);
  assert.equal(receiptText([], [{ name: "a", reason: "b" }]), "Could not save a: b.");
});

/* ---------- workers ---------- */

test("every worker can read the uploads directory and is told how to treat uploads", () => {
  new Uploads(); // the default directory, created on first use
  assert.ok(readableDirs().includes(config.uploadsDir));
  for (const kind of JOB_KINDS) assert.ok(workerSpec(kind).prompt.includes(UPLOADS_RULE), `${kind} prompt carries the uploads rule`);
  assert.match(UPLOADS_RULE, /never copy them into any repository/);
  assert.match(workerSpec("engineer", "self").prompt, /Clean room rule/);
});
