import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import { anthropicConfig } from "../config/env.js";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types.js";

/**
 * Claude gets structured output the idiomatic way: define the schema as a tool
 * and force `tool_choice` so the model must call it. The tool input is then
 * validated against the same Zod schema.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;

  constructor() {
    const cfg = anthropicConfig();
    this.client = new Anthropic({ apiKey: cfg.apiKey });
    this.model = cfg.model;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.6,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [
        {
          name: req.schemaName,
          description: req.schemaDescription ?? "Return the structured result.",
          input_schema: toInputSchema(req.schema),
        },
      ],
      tool_choice: { type: "tool", name: req.schemaName },
    });

    const block = resp.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error("Anthropic returned no tool_use block for the forced tool.");
    }

    const data = req.schema.parse(block.input);
    return {
      data,
      usage: {
        inputTokens: resp.usage?.input_tokens,
        outputTokens: resp.usage?.output_tokens,
      },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

/** Convert a Zod schema into a Claude tool input_schema (plain JSON Schema). */
function toInputSchema(schema: z.ZodType<unknown>): Anthropic.Messages.Tool.InputSchema {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json as Anthropic.Messages.Tool.InputSchema;
}
