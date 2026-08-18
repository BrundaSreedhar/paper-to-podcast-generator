/**
 * Cacheable context is the mechanism that keeps repeated judging affordable, so
 * the two ways of delivering it have to agree on content while differing only
 * in caching. A prefix that quietly failed to reach the model would still
 * produce output — grounded in nothing.
 */
import { describe, it, expect } from "vitest";
import { joinCacheableContext } from "./promptParts";
import { buildMessageContent } from "./anthropic";
import { estimateTokens } from "./contextGuard";

describe("joinCacheableContext", () => {
  it("prepends the prefix when present", () => {
    expect(joinCacheableContext("PAPER", "QUESTION")).toBe("PAPER\n\nQUESTION");
  });

  it("returns the body unchanged when there is no prefix", () => {
    expect(joinCacheableContext(undefined, "QUESTION")).toBe("QUESTION");
    expect(joinCacheableContext("", "QUESTION")).toBe("QUESTION");
  });

  it("never drops the prefix content", () => {
    const joined = joinCacheableContext("A".repeat(500), "B");
    expect(joined).toContain("A".repeat(500));
    expect(joined).toContain("B");
  });
});

describe("buildMessageContent (Anthropic)", () => {
  it("puts the prefix in its own block marked for caching", () => {
    const blocks = buildMessageContent("PAPER", "QUESTION");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "text",
      text: "PAPER",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toMatchObject({ type: "text", text: "QUESTION" });
  });

  it("marks only the reusable prefix, never the varying body", () => {
    const blocks = buildMessageContent("PAPER", "QUESTION");
    expect(blocks[1]).not.toHaveProperty("cache_control");
  });

  it("emits a single unmarked block when there is no prefix", () => {
    const blocks = buildMessageContent(undefined, "QUESTION");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toHaveProperty("cache_control");
  });
});

describe("both providers deliver identical content", () => {
  it("sends the same text either way, differing only in cache marking", () => {
    const paper = "SOURCE PAPER\n\nAurora uses a quorum.";
    const question = "Judge these claims.";

    const anthropicText = buildMessageContent(paper, question)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n\n");
    const openaiText = joinCacheableContext(paper, question);

    expect(anthropicText).toBe(openaiText);
  });
});

describe("truncation guard accounts for the cacheable prefix", () => {
  it("counts the prefix, so a dropped paper is still detected", () => {
    // The guard compares what was sent against what the server processed. If it
    // measured only the question, an endpoint discarding the entire paper would
    // look like a full-size prompt and pass unnoticed.
    const paper = "x".repeat(40_000);
    const withPrefix = estimateTokens(joinCacheableContext(paper, "Q"));
    const withoutPrefix = estimateTokens("Q");
    expect(withPrefix).toBeGreaterThan(withoutPrefix + 9_000);
  });
});
