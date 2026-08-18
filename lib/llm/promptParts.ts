/**
 * Assembly of the user-visible half of a request.
 *
 * Providers differ in what they can do with a large reusable prefix: Anthropic
 * can mark it for caching, while an OpenAI-compatible endpoint simply receives
 * it as more text. Keeping the assembly here means both paths are pure
 * functions that can be tested without a network client, and that the two
 * cannot silently drift apart in what they actually send.
 */

/** Combine a cacheable prefix with the request body for providers without caching. */
export function joinCacheableContext(
  cacheableContext: string | undefined,
  user: string,
): string {
  return cacheableContext ? `${cacheableContext}\n\n${user}` : user;
}
