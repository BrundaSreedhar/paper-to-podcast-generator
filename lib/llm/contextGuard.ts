/**
 * Guard against *silent* input truncation.
 *
 * Self-hosted and OpenAI-compatible endpoints frequently cap the context window
 * far below what the underlying model supports — Ollama, for example, defaults
 * to 4096 tokens regardless of the model's real limit, and ignores `num_ctx`
 * when called through its OpenAI-compatible route. When the prompt overflows,
 * the server does not error: it quietly drops part of the input and the model
 * confabulates a fluent, confident answer about a document it never fully saw.
 *
 * That is the single most dangerous failure mode for this project, because the
 * output looks perfect while being unrelated to the paper. We therefore compare
 * how many input tokens we believe we sent against how many the server reports
 * processing, and fail loudly on a large shortfall.
 */

export class ContextTruncationError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly processedTokens: number,
    readonly model: string,
  ) {
    super(
      `The model silently dropped most of the input: sent roughly ${estimatedTokens.toLocaleString()} tokens, ` +
        `but "${model}" reported processing only ${processedTokens.toLocaleString()}. ` +
        `Any output would describe a document the model never fully saw.\n\n` +
        `Fix one of the following:\n` +
        `  • Raise the server's context window. For Ollama, restart it with a larger limit:\n` +
        `      OLLAMA_CONTEXT_LENGTH=32768 ollama serve\n` +
        `    (Ollama defaults to 4096 and ignores num_ctx over the OpenAI-compatible API.)\n` +
        `  • Use a hosted endpoint with a large context window (set OPEN_BASE_URL / OPEN_MODEL).\n` +
        `  • Use a frontier provider: --provider anthropic | openai\n` +
        `  • Or shorten the input paper.`,
    );
    this.name = "ContextTruncationError";
  }
}

/** Rough token estimate for English prose. Deliberately conservative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fraction of our estimate the server must report before we treat the request
 * as truncated. Loose enough to absorb tokenizer variance between models.
 */
const MIN_RATIO = 0.7;

/** Ignore shortfalls smaller than this; they are estimator noise, not data loss. */
const MIN_ABSOLUTE_SHORTFALL = 500;

/**
 * Throw if the server processed materially fewer input tokens than we sent.
 * A missing/zero `processedTokens` means the endpoint reported no usage, in
 * which case we cannot verify and let it pass.
 */
export function assertNoSilentTruncation(args: {
  sentText: string;
  processedTokens: number | undefined;
  model: string;
}): void {
  const { sentText, processedTokens, model } = args;
  if (!processedTokens || processedTokens <= 0) return;

  const estimated = estimateTokens(sentText);
  const shortfall = estimated - processedTokens;

  if (shortfall >= MIN_ABSOLUTE_SHORTFALL && processedTokens < estimated * MIN_RATIO) {
    throw new ContextTruncationError(estimated, processedTokens, model);
  }
}
