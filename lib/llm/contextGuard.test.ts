import { describe, it, expect } from "vitest";
import {
  assertNoSilentTruncation,
  ContextTruncationError,
  estimateTokens,
} from "./contextGuard";

const long = (tokens: number) => "x".repeat(tokens * 4);

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

describe("assertNoSilentTruncation", () => {
  it("throws when the server processed far fewer tokens than sent", () => {
    // The real Aurora case: ~15k tokens sent, Ollama processed 4096.
    expect(() =>
      assertNoSilentTruncation({
        sentText: long(15_000),
        processedTokens: 4096,
        model: "qwen2:7b",
      }),
    ).toThrow(ContextTruncationError);
  });

  it("names the model and both token counts in the message", () => {
    try {
      assertNoSilentTruncation({
        sentText: long(15_000),
        processedTokens: 4096,
        model: "qwen2:7b",
      });
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("qwen2:7b");
      expect(msg).toContain("4,096");
      // Must point at the remediation that actually works, not the one that
      // silently fails under the macOS menu-bar supervisor.
      expect(msg).toContain("ollama create");
      expect(msg).toContain("Modelfile");
    }
  });

  it("passes when the whole prompt was processed", () => {
    expect(() =>
      assertNoSilentTruncation({
        sentText: long(2_000),
        processedTokens: 2_100,
        model: "qwen2:7b",
      }),
    ).not.toThrow();
  });

  it("tolerates tokenizer variance on a fully-ingested prompt", () => {
    // Real case: Verge article, estimate ~1.85k, server reported 2149.
    expect(() =>
      assertNoSilentTruncation({
        sentText: long(1_850),
        processedTokens: 2_149,
        model: "qwen2:7b",
      }),
    ).not.toThrow();
  });

  it("ignores small shortfalls below the absolute floor", () => {
    expect(() =>
      assertNoSilentTruncation({
        sentText: long(400),
        processedTokens: 100,
        model: "tiny",
      }),
    ).not.toThrow();
  });

  it("skips the check when the endpoint reports no usage", () => {
    expect(() =>
      assertNoSilentTruncation({
        sentText: long(15_000),
        processedTokens: undefined,
        model: "unknown",
      }),
    ).not.toThrow();
  });
});
