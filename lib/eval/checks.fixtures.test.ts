/**
 * The deterministic checks run against real captured episodes rather than
 * hand-written strings. These are the actual outputs whose failures were found
 * by hand during development, so this file answers the question that matters:
 * would the checks have caught them without a human reading the transcript?
 */
import { describe, it, expect, beforeAll } from "vitest";
import { runDeterministicChecks } from "./checks.js";
import { loadFixtures, loadPapers, loadPaper, type Fixture } from "./dataset.js";
import type { PaperStructure } from "../pdf/extract.js";

let fixtures: Fixture[];
let aurora: PaperStructure | undefined;

beforeAll(async () => {
  fixtures = await loadFixtures();
  const papers = await loadPapers();
  const pc = papers.find((p) => p.id === "aurora");
  if (pc) aurora = await loadPaper(pc);
});

function byId(id: string): Fixture {
  const f = fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`fixture ${id} missing`);
  return f;
}

function report(id: string) {
  if (!aurora) return undefined;
  return runDeterministicChecks({
    episode: byId(id).episode,
    paper: aurora,
    minutes: 4,
    showName: "PaperCast",
  });
}

describe("fixtures load", () => {
  it("has the three captured episodes", () => {
    expect(fixtures.map((f) => f.id).sort()).toEqual([
      "clean-claude",
      "fabricated-personas",
      "hallucinated-mapreduce",
    ]);
  });
});

describe("deterministic checks against real episodes", () => {
  it("flags the fabricated-personas episode", () => {
    const r = report("fabricated-personas");
    if (!r) return; // sample_papers/aurora.pdf not present
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toContain("show-name");
    expect(failed).toContain("honorifics");
    expect(r.errors).toBeGreaterThanOrEqual(2);
  });

  it("passes the clean Claude episode with no errors", () => {
    const r = report("clean-claude");
    if (!r) return;
    const errors = r.checks.filter((c) => !c.passed && c.severity === "error");
    expect(errors.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
  });

  it("scores the clean episode above the fabricated one", () => {
    const clean = report("clean-claude");
    const bad = report("fabricated-personas");
    if (!clean || !bad) return;
    expect(clean.complianceScore).toBeGreaterThan(bad.complianceScore);
  });

  it("flags the hallucinated episode on entity grounding", () => {
    const r = report("hallucinated-mapreduce");
    if (!r) return;
    // Whole-episode hallucination is the judge's job, but the cheap layer
    // should still notice it discussing entities the paper never mentions.
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toContain("proper-nouns");
  });
});
