/**
 * The report is what a reader actually sees, so its arithmetic and its caveats
 * both matter. A cost estimate that ignores cache discounts overstates the bill
 * by an order of magnitude, and a self-judged row that loses its warning turns
 * a biased measurement into an apparently neutral one.
 */
import { describe, it, expect } from "vitest";
import { estimateCost, renderMarkdown } from "./report";
import type { EvalResult } from "./types";

function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    paperId: "aurora",
    paperTitle: "Amazon Aurora",
    generator: { provider: "anthropic", model: "claude-sonnet-5" },
    judge: { provider: "anthropic", model: "claude-sonnet-5" },
    selfJudged: false,
    deterministic: { checks: [], errors: 0, warnings: 0, complianceScore: 1 },
    faithfulness: {
      verdicts: [],
      totalClaims: 10,
      supported: 9,
      unsupported: 1,
      contradicted: 0,
      faithfulness: 0.9,
      hallucinationRate: 0.05,
    },
    coverage: { expected: ["a"], hit: ["a"], missed: [], coverage: 1 },
    generationCost: {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
      latencyMs: 48000,
    },
    ...over,
  };
}

describe("estimateCost", () => {
  it("prices input and output at the model's rates", () => {
    // 1M in at $3 + 1M out at $15 = $18
    const c = estimateCost("claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(c).toBeCloseTo(18, 5);
  });

  it("bills cached input at the discounted rate", () => {
    // All input served from cache: 1M at $0.30 rather than $3.
    const c = estimateCost("claude-sonnet-5", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(c).toBeCloseTo(0.3, 5);
  });

  it("splits partially cached input between both rates", () => {
    // 250k fresh at $3 + 750k cached at $0.30 = 0.75 + 0.225
    const c = estimateCost("claude-sonnet-5", {
      inputTokens: 1_000_000,
      cacheReadTokens: 750_000,
      outputTokens: 0,
    });
    expect(c).toBeCloseTo(0.975, 5);
  });

  it("never reports negative fresh input when cache exceeds the total", () => {
    const c = estimateCost("claude-sonnet-5", {
      inputTokens: 100,
      cacheReadTokens: 500,
      outputTokens: 0,
    });
    expect(c).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined for a local model, which has no per-token price", () => {
    expect(estimateCost("qwen2:7b-32k", { inputTokens: 999_999 })).toBeUndefined();
  });
});

describe("renderMarkdown", () => {
  it("renders a row per result with the headline metrics", () => {
    const md = renderMarkdown([result()]);
    expect(md).toContain("| aurora |");
    expect(md).toContain("`claude-sonnet-5`");
    expect(md).toContain("90%"); // faithfulness
    expect(md).toContain("100%"); // coverage
  });

  it("warns when the judge also wrote the episode", () => {
    const md = renderMarkdown([result({ selfJudged: true })]);
    expect(md).toContain("## Caveat");
    expect(md).toMatch(/prefer their own output/i);
    expect(md).toContain("JUDGE_PROVIDER");
  });

  it("omits the bias caveat when nothing was self-judged", () => {
    const md = renderMarkdown([result({ selfJudged: false })]);
    expect(md).not.toContain("## Caveat");
  });

  it("lists deterministic failures with their detail", () => {
    const md = renderMarkdown([
      result({
        deterministic: {
          checks: [
            {
              id: "show-name",
              label: "Show name",
              passed: false,
              severity: "error",
              detail: "Invented show name(s): Science Uncovered.",
            },
          ],
          errors: 1,
          warnings: 0,
          complianceScore: 0.9,
        },
      }),
    ]);
    expect(md).toContain("## Deterministic failures");
    expect(md).toContain("Science Uncovered");
  });

  it("marks a local model as free rather than as a missing value", () => {
    const md = renderMarkdown([
      result({ generator: { provider: "open", model: "qwen2:7b-32k" } }),
    ]);
    expect(md).toContain("free");
  });

  it("renders an em dash rather than NaN when the judge did not run", () => {
    const md = renderMarkdown([result({ faithfulness: undefined, coverage: undefined })]);
    expect(md).not.toMatch(/NaN/);
    expect(md).toContain("—");
  });

  it("handles an empty result set without throwing", () => {
    expect(renderMarkdown([])).toContain("No results");
  });
});
