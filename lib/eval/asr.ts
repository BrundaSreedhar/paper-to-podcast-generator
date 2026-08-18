/**
 * Transcribing generated audio back to text.
 *
 * The audio checks measure duration against word count, which is a proxy: a
 * turn whose audio is far too short probably lost text. This closes that gap by
 * asking what the audio actually says. It is the difference between inferring
 * that something went missing and demonstrating it.
 *
 * Deliberately behind an interface, like every other model in this project, so
 * the recognizer can be swapped without touching the metric.
 */
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ASRProvider {
  readonly name: string;
  readonly model: string;
  /** Transcribe a WAV buffer to plain text. */
  transcribe(wav: Buffer): Promise<string>;
}

export interface WhisperCppOptions {
  binary?: string;
  modelPath?: string;
  /** Recognition threads; whisper.cpp defaults conservatively. */
  threads?: number;
}

/**
 * whisper.cpp via its command-line interface. Runs locally on CPU, so
 * verification costs nothing and needs no account — the same property the rest
 * of the local pipeline has.
 */
export class WhisperCppProvider implements ASRProvider {
  readonly name = "whisper.cpp";
  readonly model: string;
  private readonly binary: string;
  private readonly threads: number;

  constructor(opts: WhisperCppOptions = {}) {
    this.binary = opts.binary ?? process.env.WHISPER_BIN ?? "whisper-cli";
    this.model =
      opts.modelPath ?? process.env.WHISPER_MODEL ?? ".models/ggml-base.en.bin";
    this.threads = opts.threads ?? 4;
  }

  async transcribe(wav: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "papercast-asr-"));
    const input = join(dir, "in.wav");
    const stem = join(dir, "out");
    try {
      await writeFile(input, wav);
      await run(this.binary, [
        "-m", this.model,
        "-f", input,
        "-t", String(this.threads),
        "--no-timestamps",
        "--output-txt",
        "-of", stem,
      ]);
      return (await readFile(`${stem}.txt`, "utf8")).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Whether the recognizer and its model are both present. */
export async function whisperAvailable(opts: WhisperCppOptions = {}): Promise<boolean> {
  const model = opts.modelPath ?? process.env.WHISPER_MODEL ?? ".models/ggml-base.en.bin";
  try {
    await access(model);
  } catch {
    return false;
  }
  try {
    await run(opts.binary ?? process.env.WHISPER_BIN ?? "whisper-cli", ["--help"]);
    return true;
  } catch {
    return false;
  }
}
