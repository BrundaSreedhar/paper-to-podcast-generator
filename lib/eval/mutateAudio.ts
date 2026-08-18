/**
 * Deliberate corruption of synthesized audio, mirroring the text mutations.
 *
 * These reproduce the ways synthesis actually goes wrong: a call returning an
 * empty buffer, a chunk being dropped so a turn is cut short, or a timeline
 * drifting out of step with the file it describes. Each is silent on playback —
 * the episode still plays — which is exactly why they need a machine to notice.
 */
import { buildWav, parseWav } from "../tts/wav.js";
import type { EpisodeAudio } from "../tts/types.js";

export type AudioMutationKind =
  | "silence-turn"
  | "truncate-audio"
  | "desync-timeline"
  | "overlap-turns"
  | "drop-turn-timing";

export interface AudioMutation {
  kind: AudioMutationKind;
  expectedCheck: string;
  description: string;
}

export const AUDIO_MUTATIONS: AudioMutation[] = [
  {
    kind: "silence-turn",
    expectedCheck: "silent-turns",
    description: "A synthesis call returned an empty buffer, so one turn is silent",
  },
  {
    kind: "truncate-audio",
    expectedCheck: "timeline-matches-audio",
    description: "The file is shorter than the timeline claims, as if a chunk were lost",
  },
  {
    kind: "desync-timeline",
    expectedCheck: "timeline-matches-audio",
    description: "Timings drift past the end of the audio they describe",
  },
  {
    kind: "overlap-turns",
    expectedCheck: "timeline-order",
    description: "Two turns overlap on the timeline",
  },
  {
    kind: "drop-turn-timing",
    expectedCheck: "turns-voiced",
    description: "A turn has no entry on the timeline at all",
  },
];

function clone(audio: EpisodeAudio): EpisodeAudio {
  return {
    ...audio,
    audio: Buffer.from(audio.audio),
    timings: audio.timings.map((t) => ({ ...t })),
  };
}

/** Zero the PCM belonging to one turn, leaving its timing in place. */
function silenceRange(buf: Buffer, startMs: number, endMs: number): Buffer {
  const parsed = parseWav(buf);
  const { format, data } = parsed;
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  const start = Math.floor((startMs / 1000) * format.sampleRate) * bytesPerFrame;
  const end = Math.min(
    data.length,
    Math.ceil((endMs / 1000) * format.sampleRate) * bytesPerFrame,
  );
  const copy = Buffer.from(data);
  copy.fill(0, Math.max(0, start), Math.max(0, end));
  return buildWav(format, copy);
}

export function applyAudioMutation(
  audio: EpisodeAudio,
  kind: AudioMutationKind,
): EpisodeAudio {
  const out = clone(audio);
  if (out.timings.length === 0) return out;
  const target = Math.min(1, out.timings.length - 1);

  switch (kind) {
    case "silence-turn": {
      const t = out.timings[target]!;
      out.audio = silenceRange(out.audio, t.startMs, t.endMs);
      break;
    }
    case "truncate-audio": {
      // Drop the final third of the samples without adjusting the timeline.
      const parsed = parseWav(out.audio);
      const keep = Math.floor(parsed.data.length * 0.66);
      out.audio = buildWav(parsed.format, parsed.data.subarray(0, keep));
      break;
    }
    case "desync-timeline": {
      // Shift everything later, as an accumulated offset would.
      const shift = 5_000;
      out.timings = out.timings.map((t) => ({
        ...t,
        startMs: t.startMs + shift,
        endMs: t.endMs + shift,
      }));
      out.totalMs += shift;
      break;
    }
    case "overlap-turns": {
      if (out.timings.length >= 2) {
        out.timings[1] = {
          ...out.timings[1]!,
          startMs: Math.max(0, out.timings[0]!.endMs - 1_000),
        };
      }
      break;
    }
    case "drop-turn-timing":
      out.timings = out.timings.filter((_, i) => i !== target);
      break;
  }
  return out;
}
