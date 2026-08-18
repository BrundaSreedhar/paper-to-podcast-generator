import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { openaiConfig } from "../config/env.js";
import { OutputTruncationError } from "./errors.js";
import { joinCacheableContext } from "./promptParts.js";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types.js";

/**
 * OpenAI gets structured output via strict `response_format: json_schema`,
 * using the SDK's zod helper + `.parse()` so the schema is enforced server-side
 * and re-validated client-side.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly model: string;
  private client: OpenAI;

  constructor() {
    const cfg = openaiConfig();
    this.client = new OpenAI({ apiKey: cfg.apiKey });
    this.model = cfg.model;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const completion = await this.client.beta.chat.completions.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.6,
      messages: [
        { role: "system", content: req.system },
        // No explicit cache control here; the prefix is simply prepended.
        { role: "user", content: joinCacheableContext(req.cacheableContext, req.user) },
      ],
      response_format: zodResponseFormat(
        req.schema as z.ZodType<Record<string, unknown>>,
        req.schemaName,
      ),
    });

    if (completion.choices[0]?.finish_reason === "length") {
      throw new OutputTruncationError(
        this.model,
        completion.usage?.completion_tokens ?? req.maxTokens ?? 0,
      );
    }

    const msg = completion.choices[0]?.message;
    if (msg?.refusal) throw new Error(`OpenAI refused the request: ${msg.refusal}`);
    if (!msg?.parsed) throw new Error("OpenAI returned no parsed structured output.");

    // The SDK already parsed against the schema; re-validate to return a real T.
    const data = req.schema.parse(msg.parsed);
    return {
      data,
      usage: {
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
      },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}
