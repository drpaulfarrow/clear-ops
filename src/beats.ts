/**
 * The beat maker's hands.
 *
 * Paul writes hip-hop lyrics and wants instrumentals to write over. The write worker's one tool of
 * its own, generate_beat, asks the Stable Audio API (his saved account, its free credits only) to
 * generate an instrumental from a production prompt, then saves the finished track, with the prompt
 * that produced it, into Paul's private beats folder under DATA_DIR: owner-only, outside every git
 * checkout, never inside a repository. The result carries his private link, served by the reports
 * view's own route (src/index.ts), so the track reaches him and nobody else.
 *
 * Nothing here sends, posts, publishes, pays, buys credits, tops up, subscribes or enters a card:
 * there is no such endpoint on this path at all. The only side effect is a file in that folder, and
 * the account's key is read from its file inside the request that uses it, carried as a request
 * header alone, never logged, never echoed, never put in a prompt, a path or a body. When the
 * account has no free credits left the generation fails closed with a plain message.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { isPrivateAddress } from "./design.js";
import { REPORTS_PATH, reportsToken } from "./reports.js";

export const BEAT_SERVER = "beats";
export const BEAT_TOOLS = [`mcp__${BEAT_SERVER}__generate_beat`];

/** Where every beat, and the small JSON note beside it, is kept: DATA_DIR/beats, owner-only. */
export const beatsDir = () => path.join(config.dataDir, "beats");

/** The audio formats a beat may be saved as. A name must end in one of these. */
export const BEAT_EXTS = ["mp3", "wav", "m4a", "flac", "ogg"] as const;
export type BeatExt = (typeof BEAT_EXTS)[number];

export interface AudioKind {
  ext: BeatExt;
  mime: string;
}

const KINDS: Record<BeatExt, AudioKind> = {
  mp3: { ext: "mp3", mime: "audio/mpeg" },
  wav: { ext: "wav", mime: "audio/wav" },
  m4a: { ext: "m4a", mime: "audio/mp4" },
  flac: { ext: "flac", mime: "audio/flac" },
  ogg: { ext: "ogg", mime: "audio/ogg" },
};

/** Largest track the service will save, or accept from the API. */
export const BEAT_MAX_BYTES = 40 * 1024 * 1024;
/** How long one request to the Stable Audio API may take. */
export const BEAT_TIMEOUT_MS = 60_000;
/** Every Stable Audio generation costs this many credits, flat, from the account's free balance. */
export const BEAT_CREDITS = 8;
/** At most this many generations one job may ask for, so one worker cannot burn the whole balance. */
export const MAX_BEATS_PER_JOB = 3;

/** Stable Audio's documented text-to-audio endpoint: asynchronous, answered with a generation id. */
export const STABILITY_HOST = "api.stability.ai";
export const STABILITY_TEXT_TO_AUDIO = "/v2beta/audio/stable-audio/text-to-audio";
/** The documented results endpoint the generation is polled on until the audio comes back. */
export const stabilityResultsPath = (id: string) => `/v2beta/audio/results/${id}`;

/** A file name for generate_beat: one plain level, an audio extension, nothing else. */
export function checkBeatName(name: string): string {
  const ext = BEAT_EXTS.join("|");
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.(${ext})$`, "i").test(name) || name.includes("..")) {
    throw new Error(`Beat file names are one plain file name ending .${BEAT_EXTS.join(", .")}, for example boom-bap-88bpm-2026-11-19-01.mp3`);
  }
  return name;
}

/** Is these bytes really audio, and which format? Undefined when it is not (an error page, a JSON body). */
export function sniffAudio(bytes: Buffer): AudioKind | undefined {
  if (bytes.length < 12) return undefined;
  const ascii = (at: number, s: string) => bytes.subarray(at, at + s.length).toString("latin1") === s;
  if (ascii(0, "ID3")) return KINDS.mp3;
  // An MPEG frame sync: 11 set bits, as every MP3 starts when it carries no ID3 tag.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return KINDS.mp3;
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return KINDS.wav;
  if (ascii(4, "ftyp")) return KINDS.m4a;
  if (ascii(0, "fLaC")) return KINDS.flac;
  if (ascii(0, "OggS")) return KINDS.ogg;
  return undefined;
}

/** A path inside the beats folder, or an error: nothing is ever written outside it. */
function insideBeats(rel: string): string {
  const root = path.resolve(beatsDir());
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`${rel} is outside the beats folder`);
  return p;
}

function ownerOnly(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export interface BeatMeta {
  prompt: string;
  service?: string;
  bpm?: number;
  key?: string;
  seconds?: number;
  note?: string;
  credits?: number;
}

/**
 * Writes the track and the small note that goes with it (the prompt, the service, the settings, the
 * credits it cost and the date), and appends one line to index.md so the folder reads as a catalogue.
 */
export function saveBeat(name: string, bytes: Buffer, kind: AudioKind, meta: BeatMeta, now = new Date()): { file: string; note: string } {
  checkBeatName(name);
  if (bytes.length > BEAT_MAX_BYTES) throw new Error(`the track is larger than ${Math.round(BEAT_MAX_BYTES / 1024 / 1024)} MB`);
  ownerOnly(beatsDir());
  const file = insideBeats(name);
  const note = insideBeats(`${name.slice(0, name.length - `.${kind.ext}`.length)}.json`);
  const record = {
    name,
    savedAt: now.toISOString(),
    bytes: bytes.length,
    format: kind.ext,
    prompt: meta.prompt.trim(),
    ...(meta.service ? { service: meta.service } : {}),
    ...(meta.bpm !== undefined ? { bpm: meta.bpm } : {}),
    ...(meta.key ? { key: meta.key } : {}),
    ...(meta.seconds !== undefined ? { seconds: meta.seconds } : {}),
    ...(meta.note ? { note: meta.note } : {}),
    ...(meta.credits !== undefined ? { credits: meta.credits } : {}),
  };
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(note, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(note, 0o600);
  const line = `- ${record.savedAt.slice(0, 10)} ${name} — ${record.prompt.slice(0, 160)}${record.service ? ` (${record.service})` : ""}${record.bpm !== undefined ? `, ${record.bpm} bpm` : ""}${record.seconds !== undefined ? `, ${record.seconds}s` : ""}\n`;
  fs.appendFileSync(insideBeats("index.md"), line, { mode: 0o600 });
  return { file, note };
}

/**
 * The one saved track a serving request may read (src/index.ts): a plain audio file name resolved
 * inside the beats folder alone. Nothing else in the data dir, and nothing beside the track but the
 * track, is ever reachable through it.
 */
export function beatFor(name: string): { file: string; mime: string } | undefined {
  try {
    checkBeatName(name);
  } catch {
    return undefined;
  }
  const root = path.resolve(beatsDir());
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) return undefined;
  const found = KINDS[path.extname(file).slice(1).toLowerCase() as BeatExt];
  if (!found) return undefined;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size > BEAT_MAX_BYTES) return undefined;
  return { file, mime: found.mime };
}

/** Paul's private link for one saved track: the reports view's own route and its own token. */
export function beatLink(store: Parameters<typeof reportsToken>[0], name: string): string {
  return `${config.publicUrl}${REPORTS_PATH}/beat/${encodeURIComponent(name)}?t=${reportsToken(store)}`;
}

/* ---------- The Stable Audio client ---------- */

export interface StabilityRequest {
  method: "GET" | "POST";
  /** One of the two documented paths above, nothing else: there is no other endpoint on this path. */
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}
export interface StabilityResponse {
  status: number;
  contentType?: string;
  body: Buffer;
}
/** One request to the Stable Audio API. The real one is https with the pinned lookup; tests inject a fake. */
export type StabilityCall = (req: StabilityRequest) => Promise<StabilityResponse>;

/**
 * The account's API key, read from its file (config.stabilityKeyFile, by default
 * DATA_DIR/stability-api.key) inside the request that uses it, and held nowhere else: never logged,
 * never in an error, never in a prompt or a result.
 */
function stabilityKey(): string {
  let key = "";
  try {
    key = fs.readFileSync(config.stabilityKeyFile, "utf8").trim();
  } catch {
    throw new Error("The Stable Audio key file is missing, so no instrumental could be generated. Nothing was sent anywhere; tell Paul the service's key file needs checking.");
  }
  if (!key) throw new Error("The Stable Audio key file is empty, so no instrumental could be generated. Nothing was sent anywhere; tell Paul the service's key file needs checking.");
  return key;
}

/**
 * Node's own resolver, refusing any host with a private address and returning the very address that
 * was checked, so DNS changing between the check and the connection cannot send a request somewhere
 * else. The host is the API's own, never taken from any input.
 */
function pinnedLookup(hostname: string, options: import("node:dns").LookupOptions, cb: (err: Error | null, address: string, family: number) => void): void {
  const want = typeof options.family === "number" ? options.family : options.family === "IPv6" ? 6 : 4;
  lookup(hostname, { all: true })
    .then((addrs) => {
      if (!addrs.length) return cb(new Error(`cannot resolve ${hostname}`), "", 4);
      const bad = addrs.find((a) => isPrivateAddress(a.address));
      if (bad) return cb(new Error(`${hostname} resolves to a private address`), "", 4);
      const pick = addrs.find((a) => a.family === want) ?? addrs[0];
      cb(null, pick.address, pick.family);
    })
    .catch((err) => cb(err instanceof Error ? err : new Error(String(err)), "", 4));
}

/** The real request: https to the API's own host, the key as a header, capped, redirects never followed. */
export const stabilityCall: StabilityCall = (req) =>
  new Promise<StabilityResponse>((resolve, reject) => {
    const r = https.request(
      { host: STABILITY_HOST, path: req.path, method: req.method, agent: new https.Agent({ lookup: pinnedLookup, keepAlive: false }), timeout: BEAT_TIMEOUT_MS, headers: req.headers },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BEAT_MAX_BYTES) {
            res.destroy();
            r.destroy(new Error("the answer is larger than this service saves"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, contentType: res.headers["content-type"] as string | undefined, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error("the music service did not answer in time")));
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });

/* ---------- One generation ---------- */

export interface GenerateBeatInput {
  name: string;
  prompt: string;
  duration?: number;
  seed?: number;
  bpm?: number;
  key?: string;
  note?: string;
}

export interface BeatRunContext {
  /** The store the private link's token is minted in (the reports view's own token). */
  store: Parameters<typeof reportsToken>[0];
  call?: StabilityCall;
  pollMs?: number;
  maxPolls?: number;
  now?: Date;
  /** The per-job counter (max defaults to MAX_BEATS_PER_JOB), so one worker cannot burn the balance. */
  meter?: { made: number; max: number };
}

const NO_CREDITS = `The Stable Audio account has no free credits left (${BEAT_CREDITS} are needed for each generation), so nothing was generated. Nothing was bought and nothing can be bought from here: tell Paul, who handles the account himself, and stop.`;

/**
 * One generation, start to finish: the prompt goes to the documented text-to-audio endpoint, the
 * generation is polled on the documented results endpoint, the bytes must really be audio, and the
 * track is saved into the private beats folder with the prompt that produced it. The key is read
 * inside this request and carried as a header alone. The answer that comes back is never echoed into
 * an error, only its status, so nothing the API says can carry the key back out. Nothing was added,
 * bought, topped up or subscribed on the way, and no such endpoint exists on this path at all.
 */
export async function generateBeat(input: GenerateBeatInput, o: BeatRunContext): Promise<{ file: string; note: string; name: string; kind: AudioKind; bytes: number }> {
  const wanted = checkBeatName(input.name);
  const key = stabilityKey();
  const call = o.call ?? stabilityCall;
  const auth = (accept: string): Record<string, string> => ({ authorization: `Bearer ${key}`, accept });
  const post = await call({
    method: "POST",
    path: STABILITY_TEXT_TO_AUDIO,
    headers: { ...auth("application/json"), "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({
        model: "stable-audio-3",
        prompt: input.prompt,
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        output_format: "mp3",
      }),
    ),
  });
  if (post.status === 402) throw new Error(NO_CREDITS);
  if (post.status === 401) throw new Error("The Stable Audio API key was refused, so no instrumental could be generated. Tell Paul the service's key may need checking; nothing else was tried.");
  if (post.status >= 400) throw new Error(`Stable Audio answered ${post.status}, so no instrumental could be generated. Tell Paul plainly and do not retry.`);
  let id = "";
  try {
    id = String(JSON.parse(post.body.toString("utf8")).id ?? "");
  } catch {
    // A body that is not the expected JSON: no id, no poll.
  }
  if (!id) throw new Error("Stable Audio did not return a generation id, so nothing could be generated. Tell Paul plainly and do not retry.");

  const polls = o.maxPolls ?? 60;
  const wait = o.pollMs ?? 5_000;
  for (let i = 0; i < polls; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await call({ method: "GET", path: stabilityResultsPath(id), headers: auth("audio/*") });
    if (res.status === 402) throw new Error(NO_CREDITS);
    if (res.status >= 400) throw new Error(`Stable Audio answered ${res.status} for the generation, so nothing was generated. Tell Paul plainly and do not retry.`);
    const found = sniffAudio(res.body);
    if (res.status === 200 && found) {
      // The name's extension follows the bytes the API really returned.
      const stem = wanted.slice(0, wanted.length - path.extname(wanted).length);
      const name = `${stem}.${found.ext}`;
      const { file, note } = saveBeat(name, res.body, found, { prompt: input.prompt, service: "Stable Audio", credits: BEAT_CREDITS, ...(input.bpm !== undefined ? { bpm: input.bpm } : {}), ...(input.key ? { key: input.key } : {}), ...(input.duration !== undefined ? { seconds: input.duration } : {}), ...(input.note ? { note: input.note } : {}) }, o.now ?? new Date());
      return { file, note, name, kind: found, bytes: res.body.length };
    }
    // Anything else on a 2xx is the generation still in progress: keep polling.
  }
  throw new Error("Stable Audio did not finish the generation in time, so nothing was saved. Tell Paul plainly; he can ask again.");
}

const toolText = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/**
 * The tool's whole answer, on its own so the tests drive exactly what the worker sees. On success it
 * carries Paul's private link, which the worker is told to put in its report; on failure a plain
 * reason. Either way it never carries the key.
 */
export async function runGenerateBeat(input: GenerateBeatInput, o: BeatRunContext) {
  const meter = o.meter;
  if (meter && meter.made >= meter.max) {
    return toolText(`No more beats this job: at most ${meter.max} generations were allowed, and they are used. Tell Paul plainly and stop; he can start another job for more.`, true);
  }
  meter && (meter.made += 1);
  try {
    const saved = await generateBeat(input, o);
    const link = beatLink(o.store, saved.name);
    return toolText(
      `Generated and saved ${saved.file} (${saved.bytes} bytes, ${saved.kind.mime}; ${BEAT_CREDITS} of the account's free credits). Paul's private link for the track: ${link} — put that link in your report so he can play and download it, and say in your message what you made.`,
    );
  } catch (err) {
    return toolText(err instanceof Error ? err.message : "The generation failed, so nothing was saved. Tell Paul plainly and do not retry.", true);
  }
}

/** The write worker's one tool of its own. No other kind gets it, and it buys nothing. */
export function beatServer(store: Parameters<typeof reportsToken>[0], o: { call?: StabilityCall; pollMs?: number; maxPolls?: number; now?: Date; max?: number } = {}) {
  const meter = { made: 0, max: o.max ?? MAX_BEATS_PER_JOB };
  return createSdkMcpServer({
    name: BEAT_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "generate_beat",
        `Generate an instrumental Paul can write lyrics over, with the service's own Stable Audio integration, using his saved account's free credits only (${BEAT_CREDITS} per generation, at most ${meter.max} in this job). Give a production prompt (genre, tempo, instruments, mood; no lyrics, no real names, no private recordings) and one plain file name ending .mp3. The service generates the track, checks it really is audio and saves it into Paul's private beats folder, and gives you his private link: put that link in your report. It never buys credits and cannot: if the account has none left, it says so and you tell Paul and stop.`,
        {
          name: z.string().describe("A clear file name, one plain level: genre, bpm and date, e.g. boom-bap-90bpm-2026-11-19-01.mp3"),
          prompt: z.string().describe("The production prompt, verbatim: genre, tempo, instruments, mood"),
          duration: z.number().optional().describe("Length in seconds, 1 to 380; leave out for the service's default"),
          seed: z.number().optional().describe("The seed, to generate the same track again"),
          bpm: z.number().optional().describe("Tempo in bpm, for the note saved beside the track"),
          key: z.string().optional().describe("Key or mood, e.g. A minor or dusty, for the note"),
          note: z.string().optional().describe("One short line for Paul: what to listen for, or what to change next time"),
        },
        (input) => runGenerateBeat(input, { store, ...(o.call ? { call: o.call } : {}), ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}), ...(o.maxPolls !== undefined ? { maxPolls: o.maxPolls } : {}), ...(o.now ? { now: o.now } : {}), meter }),
      ),
    ],
  });
}

/** The paragraph a write job's prompt is given when the beat tool is wired in (src/jobs.ts). */
export const BEAT_NOTE = `You can also generate an instrumental with generate_beat (Stable Audio, Paul's saved account, its free credits only: ${BEAT_CREDITS} per generation, at most ${MAX_BEATS_PER_JOB} in this job). Use it when the brief asks for a beat or instrumental: one plain file name ending .mp3 (for example boom-bap-90bpm-2026-11-19-01.mp3) and a production prompt (genre, tempo, instruments, mood; no lyrics, no real names, no private recordings). The service generates the track, saves it into Paul's private beats folder and gives you his private link: put that link in your report, and say plainly in your message what you made. It never buys credits: if the account has none left it says so, and you tell Paul and stop. Nothing was ever sent, posted or published anywhere.`;
