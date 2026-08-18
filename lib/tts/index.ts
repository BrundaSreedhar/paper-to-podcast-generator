import { MacSayProvider, macSayAvailable } from "./macSay.js";
import { OpenAITTSProvider } from "./openaiTts.js";
import type { TTSProvider } from "./types.js";

export type TTSProviderName = "say" | "openai";

/**
 * Choose a synthesis backend. Defaults to the local macOS voice, so a fresh
 * checkout produces audio without any account; `TTS_PROVIDER=openai` swaps in
 * the hosted voices when a key is present.
 */
export function getTTSProvider(name?: TTSProviderName): TTSProvider {
  const chosen = name ?? (process.env.TTS_PROVIDER as TTSProviderName) ?? "say";
  switch (chosen) {
    case "openai":
      return new OpenAITTSProvider();
    case "say":
      return new MacSayProvider();
    default:
      throw new Error(`Unknown TTS provider "${chosen}". Use "say" or "openai".`);
  }
}

export { MacSayProvider, macSayAvailable, OpenAITTSProvider };
export { synthesizeEpisode } from "./synthesize.js";
export type { EpisodeAudio, TTSProvider, TurnTiming } from "./types.js";
