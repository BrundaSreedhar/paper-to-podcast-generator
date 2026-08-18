/**
 * Turning a dialogue into one audio file with a per-turn timeline.
 *
 * The original implementation passed the whole script to the synthesis endpoint
 * in a single call. Past the input limit the call failed, the error was caught
 * and discarded, and the response carried a transcript with `audioUrl: null` —
 * so the feature was missing precisely for the long episodes it existed for.
 *
 * Here, a turn is the unit of synthesis, chunked further when it exceeds the
 * backend's limit, and every chunk's duration is measured rather than estimated.
 * Exceeding the limit is now impossible by construction rather than caught.
 */
import type { Episode } from "../llm/schema";
import { chunkForSynthesis } from "./chunk";
import { joinWavs } from "./wav";
import type { EpisodeAudio, TTSProvider, TurnTiming } from "./types";

export interface SynthesizeOptions {
  provider: TTSProvider;
  /** Silence between turns, which stops speakers running into each other. */
  gapMs?: number;
  /** Called after each turn so a caller can show progress on a long episode. */
  onProgress?: (done: number, total: number) => void;
}

export async function synthesizeEpisode(
  episode: Episode,
  opts: SynthesizeOptions,
): Promise<EpisodeAudio> {
  const { provider, gapMs = 350, onProgress } = opts;
  if (episode.turns.length === 0) throw new Error("Episode has no dialogue turns.");

  // One entry per synthesis call, plus a record of which turn produced it.
  const buffers: Buffer[] = [];
  const owners: { turnIndex: number; speaker: TurnTiming["speaker"] }[] = [];

  for (const [turnIndex, turn] of episode.turns.entries()) {
    const chunks = chunkForSynthesis(turn.text, provider.maxChars);
    for (const chunk of chunks) {
      buffers.push(await provider.synthesizeChunk(chunk, turn.speaker));
      owners.push({ turnIndex, speaker: turn.speaker });
    }
    onProgress?.(turnIndex + 1, episode.turns.length);
  }

  // Gaps separate turns, not the chunks within one turn, so the join is done
  // without gaps and the spacing is applied per turn boundary below.
  const joined = joinWavs(buffers, 0);

  // Collapse chunk-level segments back up to turn-level timings.
  const timings: TurnTiming[] = [];
  joined.segments.forEach((seg, i) => {
    const owner = owners[i]!;
    const last = timings[timings.length - 1];
    if (last && last.turnIndex === owner.turnIndex) {
      last.endMs = seg.endMs;
      last.chunks += 1;
    } else {
      timings.push({
        turnIndex: owner.turnIndex,
        speaker: owner.speaker,
        startMs: seg.startMs,
        endMs: seg.endMs,
        chunks: 1,
      });
    }
  });

  if (gapMs <= 0) {
    return {
      audio: joined.wav,
      format: "wav",
      timings,
      totalMs: joined.totalMs,
      provider: provider.name,
      voices: provider.description,
      calls: buffers.length,
    };
  }

  // Re-join with silence at turn boundaries. Chunks belonging to one turn are
  // merged first so a gap never lands inside a sentence.
  const perTurn: Buffer[][] = [];
  owners.forEach((owner, i) => {
    const bucket = perTurn[owner.turnIndex] ?? (perTurn[owner.turnIndex] = []);
    bucket.push(buffers[i]!);
  });

  const turnBuffers = perTurn.map((bufs) => joinWavs(bufs, 0).wav);
  const spaced = joinWavs(turnBuffers, gapMs);

  const spacedTimings: TurnTiming[] = spaced.segments.map((seg, i) => ({
    turnIndex: i,
    speaker: episode.turns[i]!.speaker,
    startMs: seg.startMs,
    endMs: seg.endMs,
    chunks: perTurn[i]?.length ?? 1,
  }));

  return {
    audio: spaced.wav,
    format: "wav",
    timings: spacedTimings,
    totalMs: spaced.totalMs,
    provider: provider.name,
    voices: provider.description,
    calls: buffers.length,
  };
}
