#!/usr/bin/env node
/**
 * End-to-end CLI: PDF -> clean structure -> faithful two-host episode (JSON).
 *
 *   npm run generate -- path/to/paper.pdf
 *   npm run generate -- paper.pdf --minutes 8 --provider openai --out ep.json
 *
 * This is the harness for tuning prompts on real papers before any UI exists.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractPaper } from "../lib/pdf/extract.js";
import { generateEpisode } from "../lib/llm/generateEpisode.js";
import { getProvider } from "../lib/llm/index.js";
import { activeProvider, type ProviderName } from "../lib/config/env.js";

interface Args {
  pdfPath: string;
  minutes: number;
  provider?: ProviderName;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const pdfPath = rest.find((a) => !a.startsWith("--"));
  if (!pdfPath) {
    console.error("Usage: npm run generate -- <paper.pdf> [--minutes N] [--provider anthropic|openai|open] [--out file.json]");
    process.exit(1);
  }
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const providerArg = get("--provider");
  return {
    pdfPath,
    minutes: Number(get("--minutes") ?? 10),
    provider: providerArg as ProviderName | undefined,
    out: get("--out") ?? `${basename(pdfPath).replace(/\.pdf$/i, "")}.episode.json`,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = args.provider ?? activeProvider();

  console.log(`\n📄  Reading ${args.pdfPath}`);
  const bytes = await readFile(args.pdfPath);

  console.log("✂️   Extracting and cleaning sections…");
  const paper = await extractPaper(bytes);
  console.log(
    `    title: ${paper.title || "(none detected)"}\n` +
      `    sections kept: ${paper.sections.length} · words: ${paper.wordCount}`,
  );

  console.log(`\n🎙️   Generating ${args.minutes}-min episode via "${provider}"…`);
  const t0 = Date.now();
  const result = await generateEpisode(paper, {
    minutes: args.minutes,
    provider: getProvider(provider),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const { episode, usage, retries, truncatedInput, model } = result;
  console.log(`\n✅  Done in ${secs}s  (model: ${model})`);
  console.log(
    `    tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out` +
      `${retries ? ` · retries: ${retries}` : ""}` +
      `${truncatedInput ? " · input truncated" : ""}`,
  );

  console.log(`\n── SUMMARY ─────────────────────────────────────────────`);
  console.log(episode.summary);
  console.log(`\n── KEY POINTS ──────────────────────────────────────────`);
  episode.keyPoints.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
  console.log(`\n── DIALOGUE (first 4 turns) ────────────────────────────`);
  episode.turns.slice(0, 4).forEach((t) => console.log(`  ${t.speaker.toUpperCase()}: ${t.text}`));
  console.log(`  … (${episode.turns.length} turns total)`);

  await writeFile(args.out, JSON.stringify(result, null, 2), "utf8");
  console.log(`\n💾  Full episode written to ${args.out}\n`);
}

main().catch((err) => {
  console.error("\n❌  Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
