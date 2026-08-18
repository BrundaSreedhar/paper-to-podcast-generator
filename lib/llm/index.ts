import { activeProvider, type ProviderName } from "../config/env";
import type { LLMProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { OpenCompatibleProvider } from "./openCompatible";

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

export type { LLMProvider, StructuredRequest, StructuredResult } from "./types";
export * from "./schema";
