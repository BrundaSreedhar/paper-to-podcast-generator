import { describe, it, expect } from "vitest";
import {
  checkAlternation,
  checkSchema,
  checkNoAuthorImpersonation,
  checkNoClaimedExpertise,
  checkNoDirectAddress,
  checkNoHonorifics,
  checkNumbers,
  checkProperNouns,
  checkShowName,
  checkTurnCount,
  checkWordCount,
  runDeterministicChecks,
} from "./checks.js";
import type { CheckContext } from "./types.js";
import type { PaperStructure } from "../pdf/extract.js";
import type { Episode } from "../llm/schema.js";

const PAPER: PaperStructure = {
  title: "Amazon Aurora: Design Considerations",
  abstract: "Aurora is a relational database service for OLTP workloads.",
  sections: [
    {
      heading: "Introduction",
      content:
        "Aurora replicates data six ways across three Availability Zones using a 4/6 write quorum. Segments are 10GB. Throughput improved 35 times over MySQL.",
    },
  ],
  wordCount: 40,
};

function ctx(turns: Episode["turns"], overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    episode: { summary: "s", keyPoints: ["k"], turns },
    paper: PAPER,
    minutes: 4,
    showName: "PaperCast",
    ...overrides,
  };
}

const t = (speaker: "host" | "guest", text: string) => ({ speaker, text });

describe("checkSchema", () => {
  it("passes a well-formed episode", () => {
    expect(checkSchema(ctx([t("host", "hello")])).passed).toBe(true);
  });

  it("fails an episode with a malformed speaker", () => {
    const bad = ctx([]);
    // Providers can return off-schema payloads; the check exists to catch a
    // shape that slipped through rather than to restate the type system.
    bad.episode = {
      ...bad.episode,
      turns: [{ speaker: "narrator", text: "hi" }],
    } as unknown as typeof bad.episode;
    expect(checkSchema(bad).passed).toBe(false);
  });

  it("fails an episode missing a required field", () => {
    const bad = ctx([t("host", "hi")]);
    bad.episode = { turns: bad.episode.turns } as unknown as typeof bad.episode;
    const r = checkSchema(bad);
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
});

describe("checkAlternation", () => {
  it("passes on alternating speakers", () => {
    expect(checkAlternation(ctx([t("host", "a"), t("guest", "b")])).passed).toBe(true);
  });

  it("fails when a speaker repeats", () => {
    const r = checkAlternation(ctx([t("host", "a"), t("host", "b")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("share a speaker");
  });
});

describe("checkShowName", () => {
  it("accepts the configured show name", () => {
    expect(checkShowName(ctx([t("host", "Welcome to PaperCast.")])).passed).toBe(true);
  });

  it("catches the invented show name from the real failure", () => {
    const r = checkShowName(ctx([t("host", "Welcome to this episode of Science Uncovered.")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("Science Uncovered");
  });

  it("accepts 'welcome back to' phrasing", () => {
    expect(checkShowName(ctx([t("host", "Welcome back to PaperCast.")])).passed).toBe(true);
  });
});

describe("checkNoHonorifics", () => {
  it("catches a fabricated doctorate", () => {
    const r = checkNoHonorifics(ctx([t("host", "Thanks for that, Dr. Rivera.")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("Dr.");
  });

  it("passes clean dialogue", () => {
    expect(checkNoHonorifics(ctx([t("host", "Thanks for walking us through it.")])).passed).toBe(
      true,
    );
  });
});

describe("checkNoClaimedExpertise", () => {
  it("catches claimed expertise", () => {
    const r = checkNoClaimedExpertise(ctx([t("host", "our expert in digital ethics")]));
    expect(r.passed).toBe(false);
  });
});

describe("checkNoAuthorImpersonation", () => {
  it("catches the real 'we're able to' style slip", () => {
    const r = checkNoAuthorImpersonation(
      ctx([t("guest", "By pushing redo processing down, we designed a faster path.")]),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("we designed");
  });

  it("catches 'our approach'", () => {
    expect(
      checkNoAuthorImpersonation(ctx([t("guest", "our approach reduces traffic")])).passed,
    ).toBe(false);
  });

  it("allows proper attribution to the authors", () => {
    expect(
      checkNoAuthorImpersonation(
        ctx([t("guest", "The authors found that the network is the bottleneck.")]),
      ).passed,
    ).toBe(true);
  });

  it("does not fire on ordinary conversational 'we'", () => {
    expect(
      checkNoAuthorImpersonation(ctx([t("host", "Today we're digging into this paper.")])).passed,
    ).toBe(true);
  });
});

describe("checkNoDirectAddress", () => {
  it("catches a speaker addressed by an invented name", () => {
    const r = checkNoDirectAddress(ctx([t("host", "Thanks, Sam, for that explanation.")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("Sam");
  });

  it("passes nameless address", () => {
    expect(
      checkNoDirectAddress(ctx([t("host", "Thanks for walking us through that.")])).passed,
    ).toBe(true);
  });
});

describe("checkProperNouns", () => {
  it("passes entities that appear in the paper", () => {
    expect(
      checkProperNouns(ctx([t("guest", "The Aurora design uses Availability Zones.")])).passed,
    ).toBe(true);
  });

  it("flags an entity the paper never mentions", () => {
    const r = checkProperNouns(ctx([t("guest", "This builds on the Spanner design.")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("Spanner");
  });

  it("ignores sentence-initial capitals", () => {
    expect(checkProperNouns(ctx([t("guest", "Databases are hard. Networks too.")])).passed).toBe(
      true,
    );
  });
});

describe("checkNumbers", () => {
  it("passes figures present in the paper", () => {
    expect(checkNumbers(ctx([t("guest", "It improved 35 times over MySQL.")])).passed).toBe(true);
  });

  it("flags a fabricated figure", () => {
    const r = checkNumbers(ctx([t("guest", "Throughput rose by 912 percent.")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("912");
  });

  it("ignores small ordinal numbers", () => {
    expect(checkNumbers(ctx([t("guest", "There are 2 main ideas here.")])).passed).toBe(true);
  });

  it("accepts rounded figures", () => {
    // Real case: the paper reports 5.38 ms, Claude said "about 5.4" — honest
    // paraphrase, not fabrication.
    const paper = {
      ...PAPER,
      sections: [{ heading: "Results", content: "Lag grows from 2.62 ms to 5.38 ms." }],
    };
    const r = checkNumbers(
      ctx([t("guest", "Lag grows from about 2.6 to 5.4 milliseconds.")], { paper }),
    );
    expect(r.passed).toBe(true);
  });

  it("still catches a figure that is not a rounding of anything", () => {
    const paper = {
      ...PAPER,
      sections: [{ heading: "Results", content: "Lag grows from 2.62 ms to 5.38 ms." }],
    };
    expect(
      checkNumbers(ctx([t("guest", "Lag reached 87.9 milliseconds.")], { paper })).passed,
    ).toBe(false);
  });
});

describe("length checks", () => {
  it("flags a collapsed dialogue", () => {
    // The real regression: 5 turns where 14 were required.
    const five = Array.from({ length: 5 }, (_, i) =>
      t(i % 2 === 0 ? "host" : "guest", "short"),
    );
    expect(checkTurnCount(ctx(five)).passed).toBe(false);
  });

  it("flags an under-length episode", () => {
    const r = checkWordCount(ctx([t("host", "too short")]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("600-word target");
  });
});

describe("runDeterministicChecks", () => {
  it("scores a clean episode highly and reports no errors", () => {
    const clean = Array.from({ length: 16 }, (_, i) =>
      t(
        i % 2 === 0 ? "host" : "guest",
        "The authors describe how Aurora replicates data across Availability Zones and why that matters for durability and throughput in practice today.",
      ),
    );
    const report = runDeterministicChecks(ctx(clean));
    expect(report.errors).toBe(0);
    expect(report.complianceScore).toBeGreaterThan(0.9);
  });

  it("accumulates multiple failures", () => {
    const bad = [
      t("host", "Welcome to Science Uncovered. Thanks, Sam."),
      t("host", "our approach was to use Spanner with Dr. Rivera."),
    ];
    const report = runDeterministicChecks(ctx(bad));
    expect(report.errors).toBeGreaterThanOrEqual(4);
    expect(report.complianceScore).toBeLessThan(0.6);
  });
});
