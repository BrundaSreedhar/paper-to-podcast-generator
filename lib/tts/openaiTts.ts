/**
 * Synthesis via the OpenAI speech API.
 *
 * Requests uncompressed PCM rather than MP3 so segments can be joined and timed
 * with the same code path as every other backend. Joining MP3 by concatenation
 * appears to work and then produces subtly corrupt files; decoding to do it
 * properly would mean depending on ffmpeg.
 *
 * The 4096-character input limit is the one the original pipeline violated by
 * sending an entire script in a single call. It is declared here so the
 * chunker can respect it rather than discovering it as a runtime failure.
 */
import OpenAI from "openai";
import { openaiConfig } from "../config/env.js";
import { buildWav } from "./wav.js";
import type { Speaker, TTSProvider } from "./types.js";

/** The API returns headerless PCM at this fixed rate for the `pcm` format. */
const PCM_SAMPLE_RATE = 24000;

export interface OpenAITTSOptions {
  hostVoice?: string;
  guestVoice?: string;
}

export class OpenAITTSProvider implements TTSProvider {
  readonly name = "openai";
  readonly format = "wav" as const;
  readonly maxChars = 4096;

  private client: OpenAI;
  private model: string;
  private hostVoice: string;
  private guestVoice: string;

  constructor(opts: OpenAITTSOptions = {}) {
    const cfg = openaiConfig();
    this.client = new OpenAI({ apiKey: cfg.apiKey });
    this.model = cfg.ttsModel;
    this.hostVoice = opts.hostVoice ?? "nova";
    this.guestVoice = opts.guestVoice ?? "onyx";
  }

  get description(): string {
    return `${this.model}: ${this.hostVoice} (host) / ${this.guestVoice} (guest)`;
  }

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    if (text.length > this.maxChars) {
      throw new Error(
        `Chunk of ${text.length} characters exceeds the ${this.maxChars}-character limit; it should have been split before reaching the provider.`,
      );
    }

    const resp = await this.client.audio.speech.create({
      model: this.model,
      voice: speaker === "host" ? this.hostVoice : this.guestVoice,
      input: text,
      response_format: "pcm",
    });

    const pcm = Buffer.from(await resp.arrayBuffer());
    // Wrap the raw PCM so every backend hands back the same container.
    return buildWav(
      { audioFormat: 1, channels: 1, sampleRate: PCM_SAMPLE_RATE, bitsPerSample: 16 },
      pcm,
    );
  }
}
