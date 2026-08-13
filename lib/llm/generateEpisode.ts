import type { ProviderName } from "../config/env.js";
import { paperToText, type PaperStructure } from "../pdf/extract.js";
import { getProvider } from "./index.js";
import {
  EPISODE_SCHEMA_DESCRIPTION,
  EPISODE_SCHEMA_NAME,
  EpisodeSchema,
  type Episode,
} from "./schema.js";
import type { LLMProvider, Usage } from "./types.js";

/** Average speaking rate used to translate target minutes into a word budget. */
const WORDS_PER_MINUTE = 150;

export interface GenerateEpisodeOptions {
  /** Target spoken length of the dialogue, in minutes. Default 10. */
  minutes?: number;
  /** Inject a provider (for tests/overrides); defaults to env selection. */
  provider?: LLMProvider;
  hostName?: string;
  guestName?: string;
  /**
   * Cap on characters of paper text sent to the model. We rely on section-aware
   * extraction (references/appendix already stripped) rather than full chunking;
   * genuinely huge papers are truncated here and flagged. Default ~120k chars.
   */
  maxInputChars?: number;
}

export interface EpisodeResult {
  episode: Episode;
  provider: ProviderName;
  model: string;
  usage: Usage;
  retries: number;
  truncatedInput: boolean;
}

/** Generate a faithful two-host podcast episode from a structured paper. */
export async function generateEpisode(
  paper: PaperStructure,
  opts: GenerateEpisodeOptions = {},
): Promise<EpisodeResult> {
  const minutes = opts.minutes ?? 10;
  const host = opts.hostName ?? "Alex";
  const guest = opts.guestName ?? "Dr. Rivera";
  const maxInputChars = opts.maxInputChars ?? 120_000;
  const provider = opts.provider ?? getProvider();

  const fullText = paperToText(paper);
  const truncatedInput = fullText.length > maxInputChars;
  const paperText = truncatedInput ? fullText.slice(0, maxInputChars) : fullText;

  const wordTarget = minutes * WORDS_PER_MINUTE;
  const system = buildSystemPrompt({ minutes, wordTarget, host, guest });
  const user = buildUserContent(paperText, truncatedInput);

  const result = await provider.generateStructured({
    system,
    user,
    schema: EpisodeSchema,
    schemaName: EPISODE_SCHEMA_NAME,
    schemaDescription: EPISODE_SCHEMA_DESCRIPTION,
    maxTokens: estimateOutputTokens(minutes),
    temperature: 0.6,
  });

  return {
    episode: result.data,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    retries: result.retries,
    truncatedInput,
  };
}

export function buildSystemPrompt(args: {
  minutes: number;
  wordTarget: number;
  host: string;
  guest: string;
}): string {
  const { minutes, wordTarget, host, guest } = args;
  return `You are an expert science communicator who turns a single academic paper into an engaging, accurate podcast episode.

FAITHFULNESS — this is the top priority:
- Use ONLY information contained in the provided paper. Do not add outside facts, prior knowledge, comparisons, or citations that are not in the text.
- Never invent numbers, results, author names, dataset names, or references. If a detail isn't in the paper, don't state it.
- If the paper is ambiguous or silent on something, either omit it or say the paper does not specify — do not fill the gap with a guess.
- Prefer the paper's own framing and terminology; spell out each acronym the first time you use it.

FORMAT:
- Produce a summary (problem, approach, key results, limitations), a list of concise key points, and the episode as a two-host dialogue.
- The dialogue is between ${host} (the host, who guides the conversation and asks clarifying questions) and ${guest} (an expert guest who explains the work).
- Alternate speakers naturally. ${host} opens with a brief welcome and closes with a short wrap-up. No music, sound effects, or stage directions.
- Write spoken language: contractions, short sentences, no markdown, no bullet points inside the dialogue.

LENGTH:
- Target roughly ${wordTarget} words of dialogue (about ${minutes} minutes at ${WORDS_PER_MINUTE} words/minute). Cover the paper's core contributions in proportion to their importance rather than padding.`;
}

export function buildUserContent(paperText: string, truncated: boolean): string {
  const note = truncated
    ? "\n\n[Note: the paper text below was truncated to fit; base the episode only on what is present.]"
    : "";
  return `Here is the paper to adapt into a podcast episode.${note}\n\n${paperText}`;
}

/** Output token budget from target minutes (dialogue + summary + key points). */
export function estimateOutputTokens(minutes: number): number {
  // ~1.4 tokens/word for dialogue, plus overhead for summary and key points.
  const dialogueTokens = minutes * WORDS_PER_MINUTE * 1.4;
  return Math.min(16_000, Math.max(2_500, Math.round(dialogueTokens + 1_500)));
}
