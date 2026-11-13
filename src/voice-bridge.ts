import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
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
import type { Client, VoiceState } from "discord.js";
import prism from "prism-media";
import WebSocket from "ws";
import { config } from "./config.js";
import { dcChannel, dcUser } from "./discord.js";
import { InputPump, discordToVoice, voiceToDiscord, type VoiceBrain } from "./voice.js";

/**
 * Discord voice for ClearOps. When an allowlisted user joins a voice channel the bot joins too,
 * listens to that user only (never anyone else in the channel), streams the audio to the voice GPU
 * through the gateway, and plays back what comes from it. It leaves when he leaves, or after
 * VOICE_IDLE_MINUTES with nobody speaking, so the GPU can scale to zero.
 */

interface Call {
  guildId: string;
  channelId: string;
  userId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  out: Readable;
  upsample: { last: number };
  ws?: WebSocket;
  pump: InputPump;
  ticker?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  lastSpeech: number;
  reconnects: number;
  leaving: boolean;
  told: boolean;
}

export interface VoiceBridgeOptions {
  isAllowed: (from: string) => boolean;
  /** Posts a line in the voice channel's chat. */
  notify: (address: string, text: string) => Promise<void>;
  gatewayUrl?: string;
  key?: string;
}

/** A readable PCM stream we push into; a fresh one replaces it when Paul interrupts, dropping queued speech. */
function pcmOut(): Readable {
  return new Readable({ read() {} });
}

export class VoiceBridge {
  private call: Call | undefined;
  private readonly gatewayUrl: string;
  private readonly key: string;

  constructor(
    private readonly client: Client,
    private readonly brain: VoiceBrain,
    private readonly opts: VoiceBridgeOptions,
  ) {
    this.gatewayUrl = (opts.gatewayUrl ?? config.voice.gatewayUrl).replace(/^http/, "ws");
    this.key = opts.key ?? config.voice.key;
  }

  start(): void {
    this.client.on("voiceStateUpdate", (before, after) => void this.onVoiceState(before, after).catch((err) => console.warn(`voice: ${err instanceof Error ? err.message : err}`)));
  }

  async onVoiceState(before: VoiceState, after: VoiceState): Promise<void> {
    const userId = after.id;
    if (userId === this.client.user?.id || !this.opts.isAllowed(dcUser(userId))) return;
    if (after.channelId && after.channelId !== this.call?.channelId) {
      await this.join(after, userId);
    } else if (!after.channelId && before.channelId && this.call?.userId === userId) {
      await this.leave(undefined);
    }
  }

  private async join(state: VoiceState, userId: string): Promise<void> {
    if (this.call) await this.leave(undefined);
    const channelId = state.channelId!;
    const connection = joinVoiceChannel({ channelId, guildId: state.guild.id, adapterCreator: state.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      console.warn("voice: could not connect to the voice channel");
      return;
    }
    // Keep playing silence between replies rather than stopping, so streamed speech never has to restart the player.
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Number.POSITIVE_INFINITY } });
    connection.subscribe(player);
    const call: Call = { guildId: state.guild.id, channelId, userId, connection, player, out: pcmOut(), upsample: { last: 0 }, pump: new InputPump(), lastSpeech: Date.now(), reconnects: 0, leaving: false, told: false };
    this.call = call;
    this.play(call);
    this.brain.setSession({ address: dcChannel(channelId), sender: dcUser(userId) });

    // Only the allowlisted speaker is ever subscribed to.
    const opus = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder).on("data", (pcm: Buffer) => call.pump.push(discordToVoice(pcm)));
    decoder.on("error", (err: Error) => console.warn(`voice: decode: ${err.message}`));
    connection.receiver.speaking.on("start", (id) => {
      if (id === userId) call.lastSpeech = Date.now();
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void entersState(connection, VoiceConnectionStatus.Signalling, 5_000)
        .catch(() => entersState(connection, VoiceConnectionStatus.Connecting, 5_000))
        .catch(() => this.leave(undefined));
    });

    // A steady 20 ms stream to the gateway, with silence in the gaps.
    let next = Date.now();
    call.ticker = setInterval(() => {
      const now = Date.now();
      while (next <= now) {
        const frame = call.pump.frame();
        if (call.ws?.readyState === WebSocket.OPEN) call.ws.send(frame);
        next += 20;
      }
    }, 20);
    call.idleTimer = setInterval(() => {
      if (Date.now() - call.lastSpeech > config.voice.idleMinutes * 60_000) void this.leave(`I left voice after ${config.voice.idleMinutes} quiet minutes so the voice GPU can switch off. Rejoin the channel to talk again.`);
    }, 30_000);

    await this.opts.notify(dcChannel(channelId), "Cleo here, I'm in the voice channel. The voice model can take a minute or two to wake up the first time; I'll say hello when it's ready.").catch(() => undefined);
    this.connect(call);
  }

  private play(call: Call): void {
    call.out = pcmOut();
    call.player.play(createAudioResource(call.out, { inputType: StreamType.Raw }));
  }

  private connect(call: Call): void {
    const ws = new WebSocket(`${this.gatewayUrl}/ws`, { headers: { Authorization: `Bearer ${this.key}` }, handshakeTimeout: 180_000 });
    call.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", voice: config.voice.voiceName })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        call.out.push(voiceToDiscord(data as Buffer, call.upsample));
        return;
      }
      let msg: { type?: string; state?: string; detail?: unknown; event?: { type?: string } };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "status" && msg.state === "ready") call.reconnects = 0;
      if (msg.type === "status" && msg.state === "failed") console.warn(`voice: gateway failed to start: ${JSON.stringify(msg.detail)}`);
      // Paul spoke over the reply: drop what is still queued to play.
      if (msg.type === "event" && msg.event?.type === "unmute.interrupted_by_vad") this.play(call);
      if (msg.type === "event" && msg.event?.type === "conversation.item.input_audio_transcription.delta") call.lastSpeech = Date.now();
    });
    ws.on("error", (err) => console.warn(`voice: gateway: ${err.message}`));
    ws.on("close", (code) => {
      if (call.leaving || this.call !== call) return;
      call.reconnects += 1;
      if (call.reconnects > 5) {
        void this.leave("I couldn't keep the voice connection up, so I've left the channel. The details are in the service log.");
        return;
      }
      console.warn(`voice: gateway closed (${code}); reconnecting`);
      setTimeout(() => {
        if (this.call === call && !call.leaving) this.connect(call);
      }, 2_000 * call.reconnects);
    });
  }

  async leave(message: string | undefined): Promise<void> {
    const call = this.call;
    if (!call) return;
    call.leaving = true;
    this.call = undefined;
    clearInterval(call.ticker);
    clearInterval(call.idleTimer);
    call.ws?.close();
    call.player.stop(true);
    if (call.player.state.status !== AudioPlayerStatus.Idle) call.player.stop(true);
    call.connection.destroy();
    this.brain.setSession(undefined);
    if (message) await this.opts.notify(dcChannel(call.channelId), message).catch(() => undefined);
  }
}
