import { z } from "zod";

/**
 * The episode schema is the single source of truth for the model's output.
 * Every provider — Claude (tool-use), OpenAI (json_schema), and open models
 * (coerced JSON) — is held to exactly this shape and validated against it.
 */

export const DialogueTurnSchema = z.object({
  speaker: z
    .enum(["host", "guest"])
    .describe("Who is speaking. 'host' guides; 'guest' is the domain expert."),
  text: z
    .string()
    .describe("What this speaker says, in natural spoken language. No markdown."),
});

export const EpisodeSchema = z.object({
  summary: z
    .string()
    .describe(
      "A tight prose summary of the paper — problem, approach, key results, limitations — in at most 150 words.",
    ),
  keyPoints: z
    .array(z.string())
    .describe(
      "Five to eight of the paper's most important takeaways. Each is ONE sentence of at most 25 words, not a paragraph.",
    ),
  turns: z
    .array(DialogueTurnSchema)
    .describe(
      "The podcast as an alternating two-host conversation between a host and an expert guest.",
    ),
});

export type DialogueTurn = z.infer<typeof DialogueTurnSchema>;
export type Episode = z.infer<typeof EpisodeSchema>;

export const EPISODE_SCHEMA_NAME = "episode";
export const EPISODE_SCHEMA_DESCRIPTION =
  "A podcast episode derived strictly from the provided paper: a summary, key points, and a two-host dialogue.";
