import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { EpisodeSchema } from "./schema";

const VALID = {
  summary: "A paper about turning papers into podcasts.",
  keyPoints: ["Section-aware extraction helps", "Two-host dialogue is more engaging"],
  turns: [
    { speaker: "host", text: "Welcome to the show." },
    { speaker: "guest", text: "Glad to be here." },
  ],
};

describe("EpisodeSchema", () => {
  it("accepts a well-formed episode", () => {
    const parsed = EpisodeSchema.parse(VALID);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]!.speaker).toBe("host");
  });

  it("rejects an invalid speaker", () => {
    const bad = { ...VALID, turns: [{ speaker: "narrator", text: "hi" }] };
    expect(() => EpisodeSchema.parse(bad)).toThrow();
  });

  it("rejects a missing field", () => {
    const { summary: _omit, ...rest } = VALID;
    expect(() => EpisodeSchema.parse(rest)).toThrow();
  });

  it("derives a sound JSON Schema for Claude tool-use", () => {
    const json = zodToJsonSchema(EpisodeSchema, { $refStrategy: "none" }) as Record<
      string,
      unknown
    >;
    expect(json.type).toBe("object");
    const props = json.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["summary", "keyPoints", "turns"]),
    );
    expect(json.required).toEqual(
      expect.arrayContaining(["summary", "keyPoints", "turns"]),
    );
  });
});
