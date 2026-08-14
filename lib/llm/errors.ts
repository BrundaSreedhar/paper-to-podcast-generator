/**
 * Raised when the model stopped because it hit the output token cap partway
 * through building its structured result.
 *
 * The failure is worth naming because of how it presents: a truncated tool call
 * still parses as *some* JSON, so validation reports a scatter of missing and
 * mistyped fields that look like a schema bug rather than a budget problem.
 */
export class OutputTruncationError extends Error {
  constructor(
    readonly model: string,
    readonly outputTokens: number,
  ) {
    super(
      `"${model}" hit its output token limit (${outputTokens.toLocaleString()} tokens) ` +
        `while still writing the episode, so the result was cut off mid-structure.\n\n` +
        `Raise the budget by generating a shorter episode (--minutes), or increase ` +
        `the cap in estimateOutputTokens() in lib/llm/generateEpisode.ts.`,
    );
    this.name = "OutputTruncationError";
  }
}
