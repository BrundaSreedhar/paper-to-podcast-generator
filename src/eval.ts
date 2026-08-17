#!/usr/bin/env node
/**
 * Generate an episode for every paper on every requested provider, score each
 * one, and write a comparison report.
 *
 *   npm run eval                                  # all providers with credentials
 *   npm run eval -- --providers anthropic,open    # a specific subset
 *   npm run eval -- --minutes 4 --judge anthropic
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDeterministicChecks } from "../lib/eval/checks.js";
import { loadPaper, loadPapers } from "../lib/eval/dataset.js";
import { judgeEpisode } from "../lib/eval/judge.js";
import { estimateCost, renderMarkdown } from "../lib/eval/report.js";
import type { EvalResult } from "../lib/eval/types.js";
import { generateEpisode } from "../lib/llm/generateEpisode.js";
import { getProvider } from "../lib/llm/index.js";
import { activeProvider, type ProviderName } from "../lib/config/env.js";

const RESULTS_DIR = join(process.cwd(), "lib", "eval", "results");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Providers we have credentials for, so a missing key skips rather than throws. */
function availableProviders(): ProviderName[] {
  const requested = arg("--providers")
    ?.split(",")
    .map((s) => s.trim()) as ProviderName[] | undefined;
  const all: ProviderName[] = requested ?? ["anthropic", "openai", "open"];
  return all.filter((p) => {
    if (p === "anthropic") return !!process.env.ANTHROPIC_API_KEY?.trim();
    if (p === "openai") return !!process.env.OPENAI_API_KEY?.trim();
    return true; // a local endpoint needs no key
  });
}

async function main() {
  const minutes = Number(arg("--minutes") ?? 4);
  const judgeName = (arg("--judge") as ProviderName) ?? activeProvider();
  const judgeProvider = getProvider(judgeName);
  const providers = availableProviders();

  const papers = await loadPapers();
  if (papers.length === 0) {
    console.error("No PDFs found in sample_papers/. Add at least one paper.");
    process.exit(1);
  }

  console.log(`\n📊  Eval — ${papers.length} paper(s) × ${providers.length} provider(s)`);
  console.log(`    generators: ${providers.join(", ")}`);
  console.log(`    judge:      ${judgeName} / ${judgeProvider.model}`);
  console.log(`    length:     ${minutes} min\n`);

  const results: EvalResult[] = [];

  for (const pc of papers) {
    const paper = await loadPaper(pc);
    console.log(`📄  ${pc.id} — ${paper.wordCount} words, ${pc.expectedContributions.length} annotated contributions`);

    for (const name of providers) {
      process.stdout.write(`    ${name.padEnd(10)} generating… `);
      let result: EvalResult;
      try {
        const t0 = Date.now();
        const gen = await generateEpisode(paper, {
          minutes,
          provider: getProvider(name),
        });
        const genMs = Date.now() - t0;
        process.stdout.write(`${(genMs / 1000).toFixed(0)}s, judging… `);

        const deterministic = runDeterministicChecks({
          episode: gen.episode,
          paper,
          minutes,
          showName: "PaperCast",
        });
        const judged = await judgeEpisode(
          gen.episode,
          paper,
          pc.expectedContributions,
          { provider: judgeProvider },
        );

        result = {
          paperId: pc.id,
          paperTitle: paper.title,
          generator: { provider: gen.provider, model: gen.model },
          judge: { provider: judgeName, model: judgeProvider.model },
          selfJudged: gen.model === judgeProvider.model,
          deterministic,
          faithfulness: judged.faithfulness,
          coverage: judged.coverage,
          generationCost: {
            inputTokens: gen.usage.inputTokens ?? 0,
            outputTokens: gen.usage.outputTokens ?? 0,
            cachedInputTokens: gen.usage.cacheReadTokens ?? 0,
            latencyMs: genMs,
          },
          judgeCost: {
            inputTokens: judged.usage.inputTokens ?? 0,
            outputTokens: judged.usage.outputTokens ?? 0,
            cachedInputTokens: judged.usage.cacheReadTokens ?? 0,
            latencyMs: judged.latencyMs,
          },
        };
        results.push(result);

        const f = judged.faithfulness;
        console.log(
          `faithful ${(f.faithfulness * 100).toFixed(0)}% · halluc ${(f.hallucinationRate * 100).toFixed(0)}% · coverage ${(judged.coverage.coverage * 100).toFixed(0)}% · ${deterministic.errors} errors · ${
            estimateCost(gen.model, gen.usage) !== undefined
              ? "$" + estimateCost(gen.model, gen.usage)!.toFixed(4)
              : "free"
          }`,
        );
      } catch (err) {
        console.log(`❌ ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
    console.log();
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const md = renderMarkdown(results);
  await writeFile(join(RESULTS_DIR, `${stamp}.json`), JSON.stringify(results, null, 2));
  await writeFile(join(RESULTS_DIR, `${stamp}.md`), md);
  await writeFile(join(RESULTS_DIR, "latest.md"), md);

  console.log(md);
  console.log(`💾  Written to lib/eval/results/${stamp}.{json,md}\n`);
}

main().catch((err) => {
  console.error("\n❌  Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
