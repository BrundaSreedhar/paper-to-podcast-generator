import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeZodError } from "./anthropic";
import { OutputTruncationError } from "./errors";

describe("describeZodError", () => {
  it("summarizes field paths and messages", () => {
    const schema = z.object({ keyPoints: z.array(z.string()) });
    const result = schema.safeParse({ keyPoints: "not an array" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = describeZodError(result.error);
      expect(msg).toContain("keyPoints");
      expect(msg).toMatch(/expected array|Expected array/i);
    }
  });

  it("falls back gracefully on non-Zod errors", () => {
    expect(describeZodError(new Error("boom"))).toBe("boom");
    expect(describeZodError("plain string")).toBe("plain string");
  });
});

describe("OutputTruncationError", () => {
  it("names the model and token count, and points at the budget", () => {
    const err = new OutputTruncationError("claude-sonnet-5", 2500);
    expect(err.message).toContain("claude-sonnet-5");
    expect(err.message).toContain("2,500");
    expect(err.message).toContain("estimateOutputTokens");
    expect(err.name).toBe("OutputTruncationError");
  });
});
