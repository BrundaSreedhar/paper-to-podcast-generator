/**
 * Synthesis via the macOS `say` command.
 *
 * Chosen as the default because it costs nothing, needs no API key, and is
 * already present on the machine — the pipeline produces a complete episode
 * with audio on a fresh checkout, with no account anywhere. The voices are
 * dated next to a modern neural model, which is a fair trade for a development
 * and testing default; `TTS_PROVIDER=openai` swaps in better ones.
 *
 * It writes uncompressed PCM, which is what makes joining segments and deriving
 * exact per-turn timings possible without ffmpeg.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Speaker, TTSProvider } from "./types";

const run = promisify(execFile);

export interface MacSayOptions {
  hostVoice?: string;
  guestVoice?: string;
  /** Words per minute; the default `say` rate is unnaturally brisk for speech. */
  rate?: number;
  sampleRate?: number;
}

export class MacSayProvider implements TTSProvider {
  readonly name = "say";
  readonly format = "wav" as const;
  // `say` reads from a file and has no practical input limit, but turns are
  // still chunked so that a single failure costs one chunk rather than a turn.
  readonly maxChars = 8000;

  private readonly hostVoice: string;
  private readonly guestVoice: string;
  private readonly rate: number;
  private readonly sampleRate: number;

  constructor(opts: MacSayOptions = {}) {
    this.hostVoice = opts.hostVoice ?? "Samantha";
    this.guestVoice = opts.guestVoice ?? "Daniel";
    this.rate = opts.rate ?? 175;
    this.sampleRate = opts.sampleRate ?? 22050;
  }

  get description(): string {
    return `${this.hostVoice} (host) / ${this.guestVoice} (guest)`;
  }

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    const voice = speaker === "host" ? this.hostVoice : this.guestVoice;
    const dir = await mkdtemp(join(tmpdir(), "papercast-say-"));
    const out = join(dir, "chunk.wav");
    try {
      await run("say", [
        "-v",
        voice,
        "-r",
        String(this.rate),
        "-o",
        out,
        "--data-format",
        `LEI16@${this.sampleRate}`,
        // Passed after `--` so text starting with a dash is not read as a flag.
        "--",
        text,
      ]);
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Whether this backend can run here at all. */
export async function macSayAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await run("say", ["-v", "?"]);
    return true;
  } catch {
    return false;
  }
}
