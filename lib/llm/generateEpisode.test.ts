import { describe, it, expect } from "vitest";
import {
  generateEpisode,
  estimateOutputTokens,
  buildUserContent,
  targetTurnCount,
} from "./generateEpisode";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types";
import type { PaperStructure } from "../pdf/extract";

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

describe("speaker and show-name guardrails", () => {
  it("pins the show name so the model cannot invent one", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    expect(provider.last?.system).toContain("PaperCast");
    expect(provider.last?.system).toMatch(/never invent a different show name/i);
  });

  it("accepts a custom show name", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, showName: "Lab Notes" });
    expect(provider.last?.system).toContain("Lab Notes");
    expect(provider.last?.system).not.toContain("PaperCast");
  });

  it("gives the speakers no names at all", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    const sys = provider.last!.system;
    // Earlier versions injected invented personas ("Alex", "Dr. Rivera").
    expect(sys).not.toMatch(/\bAlex\b/);
    expect(sys).not.toMatch(/\bDr\.\s/);
    expect(sys).toMatch(/speakers have no names/i);
    expect(sys).toMatch(/never let them address each other by name/i);
  });

  it("forbids fabricated credentials and author impersonation", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    const sys = provider.last!.system;
    expect(sys).toMatch(/neither speaker wrote the paper/i);
    expect(sys).toMatch(/no credentials|no credentials, degrees/i);
    expect(sys).toMatch(/never "we found"|never "we found", "our method"/i);
  });
});

describe("targetTurnCount", () => {
  it("scales with length and enforces a conversational floor", () => {
    expect(targetTurnCount(4)).toBe(14);
    expect(targetTurnCount(1)).toBeGreaterThanOrEqual(6);
    expect(targetTurnCount(10)).toBeGreaterThan(targetTurnCount(4));
  });

  it("states the turn floor and word target in the prompt", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, minutes: 4 });
    const sys = provider.last!.system;
    expect(sys).toContain("at least 14 turns");
    expect(sys).toContain("600 words");
  });
});

describe("estimateOutputTokens", () => {
  it("scales with minutes and stays within clamps", () => {
    expect(estimateOutputTokens(1)).toBeGreaterThanOrEqual(4000);
    expect(estimateOutputTokens(120)).toBeLessThanOrEqual(32000);
    expect(estimateOutputTokens(20)).toBeGreaterThan(estimateOutputTokens(5));
  });

  it("budgets enough for a 4-minute episode to complete", () => {
    // Regression: the previous formula returned 2500 here, and Claude ran out
    // of budget mid-keyPoints, truncating the tool call into invalid JSON.
    expect(estimateOutputTokens(4)).toBeGreaterThan(3500);
  });

  it("accounts for JSON scaffolding, not just spoken words", () => {
    // Budget must exceed a naive words-only estimate by a clear margin.
    const naiveWordsOnly = 10 * 150 * 1.4;
    expect(estimateOutputTokens(10)).toBeGreaterThan(naiveWordsOnly * 1.5);
  });
});

describe("buildUserContent", () => {
  it("adds a truncation note only when truncated", () => {
    expect(buildUserContent("abc", false)).not.toContain("truncated");
    expect(buildUserContent("abc", true)).toContain("truncated");
  });
});
