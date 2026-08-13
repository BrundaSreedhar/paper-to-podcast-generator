import { describe, it, expect } from "vitest";
import { parsePaperStructure, paperToText } from "./extract.js";

// A realistic flattened-PDF fixture: title, authors, abstract, numbered
// sections, figure/table noise, references, acknowledgments, appendix.
const FIXTURE = `Attention Is Some of What You Need
Jane Researcher, John Scholar
University of Somewhere

Abstract
We present a method for turning papers into podcasts. Our approach
improves faithfulness over prior work by 12 points.

1 Introduction
Academic papers are dense. Deep learning has changed summarization.
Figure 1: An overview of the pipeline.

2 Methods
We use a two-stage pipeline with section-aware extraction.
Table 2: Hyperparameters used in training.
The second stage generates a dialogue.

3 Results
Our system achieves a faithfulness score of 0.91.

4 Conclusion
Section-aware extraction matters.

Acknowledgments
We thank our reviewers and our funding agency.

References
[1] Vaswani et al. Attention Is All You Need. 2017.
[2] Someone. Another Paper. 2020.

Appendix A: Extra Derivations
Here are twenty more equations nobody asked for.
`;

describe("parsePaperStructure", () => {
  const paper = parsePaperStructure(FIXTURE);

  it("extracts the title", () => {
    expect(paper.title).toBe("Attention Is Some of What You Need");
  });

  it("captures the abstract separately", () => {
    expect(paper.abstract).toContain("turning papers into podcasts");
  });

  it("keeps core sections", () => {
    const headings = paper.sections.map((s) => s.heading.toLowerCase());
    expect(headings.some((h) => h.includes("introduction"))).toBe(true);
    expect(headings.some((h) => h.includes("methods"))).toBe(true);
    expect(headings.some((h) => h.includes("results"))).toBe(true);
  });

  it("strips references, acknowledgments, and appendix", () => {
    const joined = paperToText(paper).toLowerCase();
    expect(joined).not.toContain("vaswani");
    expect(joined).not.toContain("we thank our reviewers");
    expect(joined).not.toContain("twenty more equations");
  });

  it("removes figure and table caption lines", () => {
    const joined = paperToText(paper);
    expect(joined).not.toContain("Figure 1:");
    expect(joined).not.toContain("Table 2:");
    // but the surrounding prose survives
    expect(joined).toContain("two-stage pipeline");
  });

  it("reports a positive word count", () => {
    expect(paper.wordCount).toBeGreaterThan(30);
  });
});

describe("multi-line titles", () => {
  // Mirrors the real line layout of the Amazon Aurora paper, where the title
  // wraps across two lines and is terminated by a whitespace-only line.
  const WRAPPED = `



Amazon Aurora: Design Considerations for High
Throughput Cloud-Native Relational Databases

Alexandre Verbitski, Anurag Gupta, Debanjan Saha

Amazon Web Services
ABSTRACT
Amazon Aurora is a relational database service for OLTP workloads.

1 Introduction
Databases are hard.
`;

  it("joins wrapped title lines into one title", () => {
    const paper = parsePaperStructure(WRAPPED);
    expect(paper.title).toBe(
      "Amazon Aurora: Design Considerations for High Throughput Cloud-Native Relational Databases",
    );
  });

  it("still finds the abstract and sections after a wrapped title", () => {
    const paper = parsePaperStructure(WRAPPED);
    expect(paper.abstract).toContain("relational database service");
    expect(paper.sections.some((s) => s.heading.includes("Introduction"))).toBe(true);
  });

  it("stops at a heading rather than absorbing it", () => {
    const paper = parsePaperStructure("A Short Title\nABSTRACT\nBody text here.");
    expect(paper.title).toBe("A Short Title");
    expect(paper.abstract).toContain("Body text here");
  });

  it("does not run past the line bound on a title-less document", () => {
    const runOn = Array.from({ length: 10 }, (_, i) => `line number ${i} of prose`).join(
      "\n",
    );
    const paper = parsePaperStructure(runOn);
    expect(paper.title.length).toBeLessThanOrEqual(250);
    expect(paper.title.split(" of prose").length - 1).toBeLessThanOrEqual(3);
  });
});

describe("parsePaperStructure fallback", () => {
  it("handles text with no detectable headings and truncates references", () => {
    const raw =
      "Some Title Here\n\nThis is a blob of body text with no clear sections at all, " +
      "just running prose that describes an experiment and its findings in detail.\n\n" +
      "References\n[1] A citation that should be dropped.";
    const paper = parsePaperStructure(raw);
    const joined = paperToText(paper).toLowerCase();
    expect(joined).toContain("blob of body text");
    expect(joined).not.toContain("citation that should be dropped");
  });
});
