import type { z } from "zod";
import type { ProviderName } from "../config/env.js";

/** A request for structured output validated against a Zod schema. */
export interface StructuredRequest<T> {
  system: string;
  user: string;
  /** Validation schema — the contract every provider must satisfy. */
  schema: z.ZodType<T>;
  /** Short name for the schema/tool (e.g. "episode"). */
  schemaName: string;
  schemaDescription?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: Usage;
  provider: ProviderName;
  model: string;
  /** Validation-retry attempts used before success (0 = first try). */
  retries: number;
}

/**
 * The one interface the rest of the app depends on. Providers hide the wildly
 * different ways Claude, OpenAI, and open models produce structured output.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
