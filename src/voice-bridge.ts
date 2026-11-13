import { Readable } from "node:stream";
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Client, Guild, VoiceState } from "discord.js";
import prism from "prism-media";
import { config } from "./config.js";
import { dcChannel, dcUser } from "./discord.js";
import { transcribe } from "./transcribe.js";
import { SentenceSplitter, decodeToDiscord, discordToVoice, level, speak, wav, type VoiceBrain } from "./voice.js";

/**
 * Discord voice for Cleo. When an allowlisted user joins a voice channel the bot joins too (and, after
 * a restart, finds him if he is already in one). It listens to that user only, never anyone else in
 * the channel. Each time he pauses for VOICE_SILENCE_MS, his turn is transcribed through OpenRouter,
 * Cleo's brain answers, and her answer is spoken through OpenRouter's text to speech a sentence at a
 * time. If he talks over her she stops. It leaves when he leaves or after VOICE_IDLE_MINUTES quiet.
 */

type Turn = { role: "user" | "assistant"; content: string };

interface Call {
  guildId: string;
  channelId: string;
  userId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  history: Turn[];
  /** The turn being answered; aborted when Paul speaks again. */
  turn?: AbortController;
  /** Playback chain for the current answer, sentence by sentence. */
  out?: Readable;
  recording: boolean;
  lastSpeech: number;
  idleTimer?: NodeJS.Timeout;
  leaving: boolean;
}

export interface VoiceBridgeOptions {
  isAllowed: (from: string) => boolean;
  /** Posts a line in the voice channel's chat. */
  notify: (address: string, text: string) => Promise<void>;
  /** Injected in tests. */
  transcribeImpl?: typeof transcribe;
  speakImpl?: typeof speak;
  decodeImpl?: typeof decodeToDiscord;
}

/** Shortest turn worth sending (a cough or a click is not a turn): half a second at 24 kHz, 16-bit. */
const MIN_TURN_BYTES = 24000;
/** A turn quieter than this (RMS, 0 to 1) is background noise. */
const MIN_LEVEL = 0.01;

export class VoiceBridge {
  private call: Call | undefined;

  constructor(
    private readonly client: Client,
    private readonly brain: VoiceBrain,
    private readonly opts: VoiceBridgeOptions,
  ) {}

  start(): void {
    this.client.on("voiceStateUpdate", (before, after) => void this.onVoiceState(before, after).catch((err) => console.warn(`voice: ${err instanceof Error ? err.message : err}`)));
    // After a restart Paul may already be sitting in a voice channel: join him.
    this.client.once("clientReady", () => void this.findPaul().catch((err) => console.warn(`voice: ${err instanceof Error ? err.message : err}`)));
    this.brain.onNews((address) => {
      const call = this.call;
      if (call && dcChannel(call.channelId) === address && !call.turn && !call.recording) void this.answer(call, "...");
    });
  }

  private async findPaul(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId && state.id !== this.client.user?.id && this.opts.isAllowed(dcUser(state.id))) return this.join(guild, state.channelId, state.id);
      }
    }
  }

  async onVoiceState(before: VoiceState, after: VoiceState): Promise<void> {
    const userId = after.id;
    if (userId === this.client.user?.id || !this.opts.isAllowed(dcUser(userId))) return;
    if (after.channelId && after.channelId !== this.call?.channelId) {
      await this.join(after.guild, after.channelId, userId);
    } else if (!after.channelId && before.channelId && this.call?.userId === userId) {
      await this.leave(undefined);
    }
  }

  private async join(guild: Guild, channelId: string, userId: string): Promise<void> {
    if (this.call) await this.leave(undefined);
    const connection = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      console.warn("voice: could not connect to the voice channel");
      return;
    }
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Number.POSITIVE_INFINITY } });
    connection.subscribe(player);
    const call: Call = { guildId: guild.id, channelId, userId, connection, player, history: [], recording: false, lastSpeech: Date.now(), leaving: false };
    this.call = call;
    this.brain.setSession({ address: dcChannel(channelId), sender: dcUser(userId) });

    // Only the allowlisted speaker is ever listened to: a recording starts when he starts talking.
    connection.receiver.speaking.on("start", (id) => {
      if (id !== userId || call.leaving) return;
      call.lastSpeech = Date.now();
      // He is talking over Cleo, or over a turn still being worked out: stop it.
      this.interrupt(call);
      if (!call.recording) this.record(call);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void entersState(connection, VoiceConnectionStatus.Signalling, 5_000)
        .catch(() => entersState(connection, VoiceConnectionStatus.Connecting, 5_000))
        .catch(() => this.leave(undefined));
    });
    call.idleTimer = setInterval(() => {
      if (Date.now() - call.lastSpeech > config.voice.idleMinutes * 60_000) void this.leave(`I left voice after ${config.voice.idleMinutes} quiet minutes. Rejoin the channel to talk again.`);
    }, 30_000);
    console.log("voice: joined");
    await this.say(call, "Hi Paul, it's Cleo.");
  }

  /** Collects one turn until he has been quiet for VOICE_SILENCE_MS, then answers it. */
  private record(call: Call): void {
    call.recording = true;
    const opus = call.connection.receiver.subscribe(call.userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: config.voice.silenceMs } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    decoder.on("data", (pcm: Buffer) => chunks.push(discordToVoice(pcm)));
    decoder.on("error", (err: Error) => console.warn(`voice: decode: ${err.message}`));
    opus.pipe(decoder);
    opus.once("end", () => {
      call.recording = false;
      const pcm = Buffer.concat(chunks);
      if (call.leaving || pcm.length < MIN_TURN_BYTES || level(pcm) < MIN_LEVEL) return;
      void this.heard(call, pcm);
    });
  }

  private async heard(call: Call, pcm: Buffer): Promise<void> {
    const ac = new AbortController();
    call.turn = ac;
    let text = "";
    try {
      text = await (this.opts.transcribeImpl ?? transcribe)(wav(pcm), { name: "turn.wav", mimeType: "audio/wav" });
    } catch (err) {
      console.warn(`voice: transcription failed: ${err instanceof Error ? err.message : err}`);
    }
    if (ac.signal.aborted || !text.trim()) {
      if (call.turn === ac) call.turn = undefined;
      return;
    }
    await this.answer(call, text.trim(), ac);
  }

  /** Cleo's answer to `said`, spoken a sentence at a time as it is written. */
  private async answer(call: Call, said: string, ac = new AbortController()): Promise<void> {
    call.turn = ac;
    call.history.push({ role: "user", content: said });
    let spoken = "";
    let chain: Promise<void> = Promise.resolve();
    const out = this.playback(call);
    const splitter = new SentenceSplitter((sentence) => {
      // Synthesise each sentence as soon as it is complete; play them in order.
      const audio = this.synthesise(sentence, ac.signal);
      chain = chain.then(async () => {
        const pcm = await audio;
        if (pcm && !ac.signal.aborted) out.push(pcm);
      });
    });
    try {
      await this.brain.reply(call.history, (t) => {
        spoken += t;
        splitter.push(t);
      }, ac.signal);
      splitter.flush();
      await chain;
    } catch (err) {
      if (!ac.signal.aborted) console.warn(`voice: answer failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!ac.signal.aborted) out.push(null);
      if (call.turn === ac) call.turn = undefined;
      if (spoken.trim()) call.history.push({ role: "assistant", content: spoken.trim() });
      // A news turn is not something Paul said: keep Cleo's words, drop the marker.
      if (said === "...") call.history = call.history.filter((t) => !(t.role === "user" && t.content === "..."));
      call.history = call.history.slice(-20);
    }
  }

  /** A fixed line, spoken straight away (the greeting). */
  private async say(call: Call, text: string): Promise<void> {
    const out = this.playback(call);
    const pcm = await this.synthesise(text);
    if (pcm) out.push(pcm);
    out.push(null);
    call.history.push({ role: "assistant", content: text });
  }

  private async synthesise(text: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    try {
      const mp3 = await (this.opts.speakImpl ?? speak)(text, fetch, signal);
      return await (this.opts.decodeImpl ?? decodeToDiscord)(mp3);
    } catch (err) {
      if (!signal?.aborted) console.warn(`voice: speech failed: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  /** A fresh stream for one answer; the player plays it as audio arrives. */
  private playback(call: Call): Readable {
    const out = new Readable({ read() {} });
    call.out = out;
    call.player.play(createAudioResource(out, { inputType: StreamType.Raw }));
    return out;
  }

  private interrupt(call: Call): void {
    call.turn?.abort();
    call.turn = undefined;
    if (call.out) {
      call.out.destroy();
      call.out = undefined;
      call.player.stop(true);
    }
  }

  async leave(message: string | undefined): Promise<void> {
    const call = this.call;
    if (!call) return;
    call.leaving = true;
    this.call = undefined;
    clearInterval(call.idleTimer);
    this.interrupt(call);
    call.connection.destroy();
    this.brain.setSession(undefined);
    console.log("voice: left");
    if (message) await this.opts.notify(dcChannel(call.channelId), message).catch(() => undefined);
  }
}
