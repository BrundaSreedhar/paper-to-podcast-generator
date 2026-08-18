/**
 * Running a paper through the whole pipeline as a job.
 *
 * The stages already existed as separate commands; what this adds is a single
 * flow that reports where it is. Generation and synthesis each take tens of
 * seconds, and a minute of silence is indistinguishable from a hang, so every
 * step publishes progress as it goes.
 *
 * Framework-agnostic on purpose: it takes a store and emits into it, so an
 * Express route, a Next.js handler, or a test can all drive the same code.
 */
import { writeFile } from "node:fs/promises";
import { extractPaper } from "../pdf/extract.js";
import { generateEpisode } from "../llm/generateEpisode.js";
import { getProvider } from "../llm/index.js";
import type { ProviderName } from "../config/env.js";
import { resolveTTSProvider, synthesizeEpisode, type TTSProviderName } from "../tts/index.js";
import { sliceWav } from "../tts/wav.js";
import { runAudioChecks } from "../eval/audioChecks.js";
import { WhisperCppProvider, whisperAvailable } from "../eval/asr.js";
import { verifyPerTurn } from "../eval/transcriptFidelity.js";
import { estimateCost } from "../eval/report.js";
import { toJobError } from "./errors.js";
import { overallPercent } from "./types.js";
import type { JobStore } from "./store.js";

export interface RunJobInput {
  pdf: Buffer;
  minutes: number;
  provider?: ProviderName;
  ttsProvider?: TTSProviderName;
  verify: boolean;
  /** Where to write the finished audio, when audio is wanted. */
  audioPath?: string;
}

export async function runJob(
  store: JobStore,
  jobId: string,
  input: RunJobInput,
): Promise<void> {
  const step = (stage: Parameters<typeof overallPercent>[0], within: number, message: string) =>
    store.update(jobId, { stage, percent: overallPercent(stage, within), message });

  try {
    step("parsing", 0, "Reading the paper");
    const paper = await extractPaper(input.pdf);
    store.update(jobId, {
      paperTitle: paper.title,
      percent: overallPercent("parsing", 1),
      message: `Parsed ${paper.sections.length} sections, ${paper.wordCount} words`,
    });

    step("scripting", 0, "Writing the episode");
    const generated = await generateEpisode(paper, {
      minutes: input.minutes,
      provider: input.provider ? getProvider(input.provider) : undefined,
    });
    store.update(jobId, {
      percent: overallPercent("scripting", 1),
      message: `Wrote ${generated.episode.turns.length} turns`,
      cost: {
        llmInputTokens: generated.usage.inputTokens ?? 0,
        llmOutputTokens: generated.usage.outputTokens ?? 0,
        llmCachedTokens: generated.usage.cacheReadTokens ?? 0,
        usd: estimateCost(generated.model, generated.usage),
      },
    });

    if (!input.audioPath) {
      store.update(jobId, {
        stage: "done",
        percent: 100,
        message: "Transcript ready",
        result: { episode: generated.episode },
      });
      return;
    }

    step("synthesizing", 0, "Recording the episode");
    const tts = await resolveTTSProvider(input.ttsProvider);
    const audio = await synthesizeEpisode(generated.episode, {
      provider: tts,
      onProgress: (done, total) =>
        store.update(jobId, {
          percent: overallPercent("synthesizing", done / total),
          message: `Recording turn ${done} of ${total}`,
        }),
    });
    await writeFile(input.audioPath, audio.audio);

    const checks = runAudioChecks({
      episode: generated.episode,
      audio,
      targetMinutes: input.minutes,
    });
    store.update(jobId, {
      percent: overallPercent("synthesizing", 1),
      message: `Recorded ${(audio.totalMs / 1000 / 60).toFixed(1)} minutes · ${checks.errors} audio errors`,
      cost: { ttsCalls: audio.calls },
    });

    let transcriptRecall: number | undefined;
    if (input.verify && (await whisperAvailable())) {
      step("verifying", 0, "Checking the audio against the script");
      const fidelity = await verifyPerTurn(
        generated.episode,
        audio,
        new WhisperCppProvider(),
        sliceWav,
        (done, total) =>
          store.update(jobId, {
            percent: overallPercent("verifying", done / total),
            message: `Verifying turn ${done} of ${total}`,
          }),
      );
      transcriptRecall = fidelity.episodeRecall;
    }

    store.update(jobId, {
      stage: "done",
      percent: 100,
      message: "Episode ready",
      result: {
        episode: generated.episode,
        audioPath: input.audioPath,
        timings: audio.timings,
        totalMs: audio.totalMs,
        transcriptRecall,
      },
    });
  } catch (err) {
    // The full error stays in the server log; the client gets a safe summary.
    console.error(`[job ${jobId}]`, err);
    store.update(jobId, {
      stage: "error",
      percent: 100,
      message: "Failed",
      error: toJobError(err),
    });
  }
}
