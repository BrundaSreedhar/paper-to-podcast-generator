/**
 * The eval dataset: papers to generate from, and fixture episodes with known
 * verdicts used to validate the judge itself.
 *
 * The fixtures are not synthetic. They are real outputs captured while building
 * this pipeline — including an episode about MapReduce itemset mining that a
 * local model produced from the Amazon Aurora paper after its context window
 * silently truncated the input. A judge that scores that episode as faithful is
 * broken, which makes it the single most useful test in the suite.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EpisodeSchema } from "../llm/schema";
import { extractPaper, type PaperStructure } from "../pdf/extract";

// This package compiles to CommonJS, so `__dirname` is the portable choice —
// `import.meta` is ESM-only and fails the build even though Vitest accepts it.
const FIXTURE_DIR = join(__dirname, "fixtures");
const PAPER_DIR = join(__dirname, "..", "..", "sample_papers");

/** Bounds a fixture is expected to satisfy, used to validate the judge. */
export const ExpectationSchema = z.object({
  minFaithfulness: z.number().optional(),
  maxFaithfulness: z.number().optional(),
  minDeterministicErrors: z.number().optional(),
  maxDeterministicErrors: z.number().optional(),
});

export const FixtureSchema = z.object({
  id: z.string(),
  description: z.string(),
  paperId: z.string(),
  generator: z.object({ provider: z.string(), model: z.string() }),
  expectation: ExpectationSchema,
  episode: EpisodeSchema,
});

export type Expectation = z.infer<typeof ExpectationSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;

/** A paper in the dataset, plus the contributions coverage is scored against. */
export interface PaperCase {
  id: string;
  path: string;
  /**
   * Key contributions a faithful episode should mention. Left empty until
   * annotated; coverage scoring is skipped for papers without them.
   */
  expectedContributions: string[];
}

/**
 * Papers are discovered from sample_papers/ rather than hardcoded, so dropping
 * a PDF into that directory adds it to the eval set. Annotations live here.
 */
const ANNOTATIONS: Record<string, string[]> = {
  aurora: [
    "The network, not compute or storage, is the bottleneck for cloud OLTP databases",
    "Only redo log records cross the network; the storage tier materializes pages",
    "Six-way replication across three Availability Zones with a 4/6 write quorum",
    "Crash recovery is continuous and asynchronous, avoiding checkpoint replay",
    "An asynchronous scheme based on log sequence numbers replaces two-phase commit",
  ],
};

export async function loadPapers(): Promise<PaperCase[]> {
  let entries: string[];
  try {
    entries = await readdir(PAPER_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => {
      const id = f.replace(/\.pdf$/i, "").toLowerCase();
      return {
        id,
        path: join(PAPER_DIR, f),
        expectedContributions: ANNOTATIONS[id] ?? [],
      };
    });
}

export async function loadPaper(pc: PaperCase): Promise<PaperStructure> {
  return extractPaper(await readFile(pc.path));
}

export async function loadFixtures(): Promise<Fixture[]> {
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".json"));
  const out: Fixture[] = [];
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(join(FIXTURE_DIR, f), "utf8"));
    out.push(FixtureSchema.parse(raw));
  }
  return out;
}

/** Report which expectations a measured result violated. */
export function checkExpectation(
  exp: Expectation,
  measured: { faithfulness?: number; deterministicErrors: number },
): string[] {
  const failures: string[] = [];
  const f = measured.faithfulness;
  if (exp.minFaithfulness !== undefined && f !== undefined && f < exp.minFaithfulness) {
    failures.push(
      `faithfulness ${f.toFixed(2)} below expected minimum ${exp.minFaithfulness}`,
    );
  }
  if (exp.maxFaithfulness !== undefined && f !== undefined && f > exp.maxFaithfulness) {
    failures.push(
      `faithfulness ${f.toFixed(2)} above expected maximum ${exp.maxFaithfulness} — the judge failed to detect known-bad content`,
    );
  }
  if (
    exp.minDeterministicErrors !== undefined &&
    measured.deterministicErrors < exp.minDeterministicErrors
  ) {
    failures.push(
      `${measured.deterministicErrors} deterministic errors, expected at least ${exp.minDeterministicErrors}`,
    );
  }
  if (
    exp.maxDeterministicErrors !== undefined &&
    measured.deterministicErrors > exp.maxDeterministicErrors
  ) {
    failures.push(
      `${measured.deterministicErrors} deterministic errors, expected at most ${exp.maxDeterministicErrors}`,
    );
  }
  return failures;
}
