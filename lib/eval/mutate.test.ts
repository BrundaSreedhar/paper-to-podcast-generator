/**
 * Sensitivity of the deterministic layer, measured rather than asserted.
 *
 * A clean episode is corrupted one fault at a time, and each corruption names
 * the check that should catch it. The suite therefore reports a detection rate
 * over a family of known-bad inputs, which is a far stronger claim than a
 * handful of hand-written cases — and it fails loudly if a future change to a
 * regex quietly stops catching something.
 *
 * The paper and episode here are synthetic so this runs anywhere, including CI
 * where the source PDFs are not committed.
 */
import { describe, it, expect } from "vitest";
import { runDeterministicChecks } from "./checks";
import { applyMutation, MUTATIONS, type MutationKind } from "./mutate";
import type { CheckContext } from "./types";
import type { PaperStructure } from "../pdf/extract";
import type { Episode } from "../llm/schema";

const PAPER: PaperStructure = {
  title: "Amazon Aurora: Design Considerations",
  abstract:
    "Aurora is a relational database service for OLTP workloads offered as part of Amazon Web Services.",
  sections: [
    {
      heading: "Introduction",
      content:
        "The central constraint has moved from compute and storage to the network. Aurora pushes redo log processing into a purpose-built storage service.",
    },
    {
      heading: "Durability",
      content:
        "Aurora replicates data six ways across three Availability Zones with a 4/6 write quorum and a 3/6 read quorum. Segments are 10GB, which shortens mean time to repair. Throughput improved 35 times over mirrored MySQL.",
    },
  ],
  wordCount: 80,
};

/** A clean, guardrail-compliant episode: the control for every mutation. */
const CLEAN: Episode = {
  summary:
    "Aurora treats the network as the bottleneck and pushes redo processing into its storage tier.",
  keyPoints: [
    "The network, not disk, is the constraint",
    "Only redo log records cross the network",
  ],
  turns: Array.from({ length: 16 }, (_, i) =>
    i % 2 === 0
      ? {
          speaker: "host" as const,
          text:
            i === 0
              ? "Welcome to PaperCast. Today the paper is Amazon Aurora, a relational database service for transactional workloads, and the authors argue that the network rather than the disk is now the real constraint on throughput in a cloud setting."
              : "That is a helpful distinction, and it raises an obvious follow-up question. How does the storage tier keep data durable when an individual node fails unexpectedly, and what does that cost in terms of extra work across the fleet?",
        }
      : {
          speaker: "guest" as const,
          text:
            // Includes a figure the paper states (35), so the swap-number
            // mutation exercises a genuine misstatement rather than an append.
            "The authors replicate data six ways across three Availability Zones, using a write quorum of four out of six, so a whole zone can fail alongside one more node without losing durability, and they report throughput improving 35 times over mirrored MySQL.",
        },
  ),
};

function ctx(episode: Episode): CheckContext {
  return { episode, paper: PAPER, minutes: 4, showName: "PaperCast" };
}

function failedCheckIds(episode: Episode): string[] {
  return runDeterministicChecks(ctx(episode))
    .checks.filter((c) => !c.passed)
    .map((c) => c.id);
}

describe("the control episode is clean", () => {
  it("passes every check, so any mutation failure is caused by the mutation", () => {
    const report = runDeterministicChecks(ctx(CLEAN));
    const failed = report.checks.filter((c) => !c.passed);
    expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(report.complianceScore).toBe(1);
  });
});

describe("each injected corruption is detected by the intended check", () => {
  for (const m of MUTATIONS) {
    it(`${m.kind} → ${m.expectedCheck} (${m.description})`, () => {
      const mutated = applyMutation(CLEAN, m.kind);
      expect(mutated).not.toEqual(CLEAN);
      expect(failedCheckIds(mutated)).toContain(m.expectedCheck);
    });
  }
});

describe("detection rate", () => {
  it("catches every known corruption", () => {
    const results = MUTATIONS.map((m) => ({
      kind: m.kind,
      caught: failedCheckIds(applyMutation(CLEAN, m.kind)).includes(m.expectedCheck),
    }));
    const missed = results.filter((r) => !r.caught).map((r) => r.kind);
    // Reported as a rate so a regression shows up as a number, not a stack trace.
    expect(missed, `missed ${missed.length}/${MUTATIONS.length}`).toEqual([]);
  });

  it("does not flag the intended check on the clean control", () => {
    // Guards against a check that fires unconditionally and would appear to
    // catch every mutation while actually detecting nothing.
    const cleanFailures = failedCheckIds(CLEAN);
    for (const m of MUTATIONS) {
      expect(cleanFailures).not.toContain(m.expectedCheck);
    }
  });
});

describe("mutations are deterministic and non-destructive", () => {
  it("produces identical output on repeated application", () => {
    for (const m of MUTATIONS) {
      const a = applyMutation(CLEAN, m.kind);
      const b = applyMutation(CLEAN, m.kind);
      expect(a).toEqual(b);
    }
  });

  it("never mutates the input episode in place", () => {
    const snapshot = JSON.stringify(CLEAN);
    for (const m of MUTATIONS) applyMutation(CLEAN, m.kind);
    expect(JSON.stringify(CLEAN)).toBe(snapshot);
  });

  it("handles an empty episode without throwing", () => {
    const empty: Episode = { summary: "", keyPoints: [], turns: [] };
    for (const m of MUTATIONS) {
      expect(() => applyMutation(empty, m.kind as MutationKind)).not.toThrow();
    }
  });
});
