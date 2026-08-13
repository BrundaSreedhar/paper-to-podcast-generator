import { describe, it, expect } from "vitest";
import { extractJson } from "./openCompatible.js";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences", () => {
    const s = 'Here you go:\n```json\n{"a":1,"b":"two"}\n```';
    expect(extractJson(s)).toEqual({ a: 1, b: "two" });
  });

  it("strips plain ``` fences", () => {
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("slices JSON out of surrounding prose", () => {
    const s = 'Sure! The result is {"x":[1,2,3]} — hope that helps.';
    expect(extractJson(s)).toEqual({ x: [1, 2, 3] });
  });

  it("throws on genuinely non-JSON content", () => {
    expect(() => extractJson("I cannot do that.")).toThrow();
  });
});
