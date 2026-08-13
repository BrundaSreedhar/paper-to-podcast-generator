import { describe, it, expect } from "vitest";
import {
  generateEpisode,
  estimateOutputTokens,
  buildUserContent,
} from "./generateEpisode.js";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types.js";
import type { PaperStructure } from "../pdf/extract.js";

const PAPER: PaperStructure = {
  title: "A Test Paper",
  abstract: "We test things.",
  sections: [{ heading: "Introduction", content: "Testing is good." }],
  wordCount: 6,
};

const CANNED = {
  summary: "s",
  keyPoints: ["k"],
  turns: [{ speaker: "host" as const, text: "hi" }],
};

/** Records the last request and returns a fixed, schema-valid episode. */
class StubProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  last?: StructuredRequest<unknown>;
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req as StructuredRequest<unknown>;
    return {
      data: req.schema.parse(CANNED),
      usage: { inputTokens: 10, outputTokens: 20 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

describe("generateEpisode", () => {
  it("passes the episode schema and returns the parsed episode", async () => {
    const provider = new StubProvider();
    const result = await generateEpisode(PAPER, { provider, minutes: 5 });

    expect(result.episode.turns[0]!.speaker).toBe("host");
    expect(result.model).toBe("stub-model");
    expect(result.truncatedInput).toBe(false);
    expect(provider.last?.schemaName).toBe("episode");
    // The paper text should reach the model.
    expect(provider.last?.user).toContain("A Test Paper");
    // Faithfulness guardrail must be present in the system prompt.
    expect(provider.last?.system.toLowerCase()).toContain("use only");
  });

  it("flags truncation when the paper exceeds the input cap", async () => {
    const provider = new StubProvider();
    const big: PaperStructure = {
      ...PAPER,
      sections: [{ heading: "Body", content: "x".repeat(500) }],
    };
    const result = await generateEpisode(big, { provider, maxInputChars: 100 });
    expect(result.truncatedInput).toBe(true);
    expect(provider.last?.user).toContain("truncated");
  });
});

describe("estimateOutputTokens", () => {
  it("scales with minutes and stays within clamps", () => {
    expect(estimateOutputTokens(1)).toBeGreaterThanOrEqual(2500);
    expect(estimateOutputTokens(60)).toBeLessThanOrEqual(16000);
    expect(estimateOutputTokens(20)).toBeGreaterThan(estimateOutputTokens(5));
  });
});

describe("buildUserContent", () => {
  it("adds a truncation note only when truncated", () => {
    expect(buildUserContent("abc", false)).not.toContain("truncated");
    expect(buildUserContent("abc", true)).toContain("truncated");
  });
});
