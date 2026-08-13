import { activeProvider, type ProviderName } from "../config/env.js";
import type { LLMProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenCompatibleProvider } from "./openCompatible.js";

/** Instantiate a provider by name (defaults to LLM_PROVIDER from env). */
export function getProvider(name: ProviderName = activeProvider()): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "open":
      return new OpenCompatibleProvider();
  }
}

export type { LLMProvider, StructuredRequest, StructuredResult } from "./types.js";
export * from "./schema.js";
