/**
 * Splitting spoken text to fit a synthesis call's input limit.
 *
 * The original pipeline sent an entire script to the TTS endpoint in one call.
 * Anything past roughly four thousand characters was rejected, the error was
 * swallowed, and the request returned a transcript with no audio — the headline
 * feature silently absent for exactly the long inputs it existed to handle.
 *
 * Splitting happens at sentence boundaries wherever possible, because a cut
 * mid-sentence is audible: the two halves are synthesised with independent
 * prosody and the join lands as an unnatural break.
 */

const TERMINATORS = new Set([".", "!", "?"]);
const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";

/**
 * Split into sentences, keeping terminal punctuation attached.
 *
 * Scanned explicitly rather than matched with one regex because of decimals: a
 * naive split treats the period in "5.38 milliseconds" as a sentence end, and
 * these transcripts are full of figures. A period counts as terminal unless it
 * sits between two digits, and must be followed by whitespace or end of text.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!TERMINATORS.has(ch)) continue;
    if (ch === "." && isDigit(text[i - 1]) && isDigit(text[i + 1])) continue;

    // Absorb runs of punctuation and any closing quote or bracket.
    let end = i + 1;
    while (end < text.length && /[.!?"'’)\]]/.test(text[end]!)) end++;
    // A terminator mid-token (a URL, say) does not end a sentence.
    if (end < text.length && !/\s/.test(text[end]!)) continue;

    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
    i = end - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Hard-split a run of text that has no usable boundary, preferring whitespace. */
function splitOversized(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const breakAt = window.lastIndexOf(" ");
    // Only break on whitespace if it is not pathologically early, otherwise a
    // long unbroken token would produce a stream of tiny fragments.
    const cut = breakAt > maxChars * 0.5 ? breakAt : maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Pack text into chunks no longer than `maxChars`, breaking at sentence
 * boundaries. Sentences longer than the limit are split on whitespace as a
 * last resort.
 */
export function chunkForSynthesis(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (maxChars <= 0) throw new Error("maxChars must be positive.");
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of splitSentences(trimmed)) {
    if (sentence.length > maxChars) {
      flush();
      chunks.push(...splitOversized(sentence, maxChars));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      flush();
      current = sentence;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks;
}
