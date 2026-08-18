import type { Episode } from "../llm/schema";
import type { TurnTiming } from "../tts/types";

/**
 * Stages a job moves through, in order. Generation and synthesis each take tens
 * of seconds, which is why the work is a job with a timeline rather than a
 * request that blocks: a minute of silence is indistinguishable from a hang.
 */
export const STAGES = [
  "queued",
  "parsing",
  "scripting",
  "synthesizing",
  "verifying",
  "done",
] as const;

export type JobStage = (typeof STAGES)[number] | "error";

/**
 * Share of the overall timeline each stage occupies, from measured runs:
 * parsing is near-instant, scripting around 50 seconds, synthesis around 35,
 * and verification roughly as long as synthesis again. Weighting by real cost
 * keeps the reported percentage honest instead of jumping in equal steps.
 */
export const STAGE_WEIGHTS: Record<Exclude<JobStage, "error">, number> = {
  queued: 0,
  parsing: 4,
  scripting: 46,
  synthesizing: 35,
  verifying: 15,
  done: 0,
};

export interface JobEvent {
  at: number;
  stage: JobStage;
  /** Overall completion, 0–100. */
  percent: number;
  message: string;
}

export interface JobCost {
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCachedTokens: number;
  ttsCalls: number;
  usd?: number;
}

export interface JobResult {
  episode: Episode;
  audioPath?: string;
  timings?: TurnTiming[];
  totalMs?: number;
  /** Share of the script recognized in the audio, when verification ran. */
  transcriptRecall?: number;
}

export interface JobError {
  /** Stable identifier a client can branch on. */
  code: string;
  /** Safe to show a user: no stack traces, no credentials. */
  message: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
}

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: JobStage;
  percent: number;
  paperTitle?: string;
  options: { minutes: number; provider?: string; verify: boolean };
  cost: JobCost;
  events: JobEvent[];
  result?: JobResult;
  error?: JobError;
}

export function isTerminal(stage: JobStage): boolean {
  return stage === "done" || stage === "error";
}

/** Overall percentage given the stage and how far through it we are. */
export function overallPercent(stage: JobStage, withinStage = 0): number {
  if (stage === "error") return 100;
  if (stage === "done") return 100;
  let before = 0;
  for (const s of STAGES) {
    if (s === stage) break;
    before += STAGE_WEIGHTS[s];
  }
  const clamped = Math.min(1, Math.max(0, withinStage));
  return Math.round(before + STAGE_WEIGHTS[stage] * clamped);
}
