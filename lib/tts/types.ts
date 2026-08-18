import type { DialogueTurn } from "../llm/schema.js";

export type Speaker = DialogueTurn["speaker"];

/**
 * A synthesis backend. Mirrors LLMProvider: the rest of the pipeline depends on
 * this interface alone, so a local voice, a hosted API, or a future neural
 * model are interchangeable.
 */
export interface TTSProvider {
  readonly name: string;
  /** Identifier for reports — which voices actually produced the audio. */
  readonly description: string;
  /** Container the backend emits. Only `wav` can be joined without re-encoding. */
  readonly format: "wav";
  /** Maximum characters per call. Longer turns are chunked to fit. */
  readonly maxChars: number;
  /** Synthesize one chunk of one speaker's text. */
  synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer>;
}

/** Where a turn sits on the finished timeline. */
export interface TurnTiming {
  turnIndex: number;
  speaker: Speaker;
  startMs: number;
  endMs: number;
  /** Number of synthesis calls this turn required. */
  chunks: number;
}

export interface EpisodeAudio {
  audio: Buffer;
  format: "wav";
  timings: TurnTiming[];
  totalMs: number;
  provider: string;
  voices: string;
  /** Total synthesis calls made — the count the original code got wrong. */
  calls: number;
}
