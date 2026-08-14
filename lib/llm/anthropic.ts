import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodError, type z } from "zod";
import { anthropicConfig } from "../config/env.js";
import { OutputTruncationError } from "./errors.js";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types.js";

const MAX_VALIDATION_RETRIES = 2;

/** Summarize a Zod failure compactly enough to hand back to the model. */
export function describeZodError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

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
    // A cacheable prefix goes in its own content block marked for caching, so
    // repeated judgements of the same paper pay for it once.
    const content: Anthropic.Messages.ContentBlockParam[] = req.cacheableContext
      ? [
          {
            type: "text",
            text: req.cacheableContext,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: req.user },
        ]
      : [{ type: "text", text: req.user }];

    const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content }];
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 8000,
        // Sonnet 5+ (and Opus 4.7+) reject non-default sampling params; omit temperature.
        ...(supportsSamplingParams(this.model)
          ? { temperature: req.temperature ?? 0.6 }
          : {}),
        system: req.system,
        messages,
        tools: [
          {
            name: req.schemaName,
            description: req.schemaDescription ?? "Return the structured result.",
            input_schema: toInputSchema(req.schema),
          },
        ],
        tool_choice: { type: "tool", name: req.schemaName },
      });

      usage.inputTokens += resp.usage?.input_tokens ?? 0;
      usage.outputTokens += resp.usage?.output_tokens ?? 0;
      usage.cacheWriteTokens += resp.usage?.cache_creation_input_tokens ?? 0;
      usage.cacheReadTokens += resp.usage?.cache_read_input_tokens ?? 0;

      // A tool call cut off by the token cap yields half-built JSON, which would
      // otherwise surface as a confusing pile of Zod "Required" errors. Retrying
      // cannot help here — the budget is the problem — so fail immediately.
      if (resp.stop_reason === "max_tokens") {
        throw new OutputTruncationError(this.model, usage.outputTokens);
      }

      const block = resp.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error("Anthropic returned no tool_use block for the forced tool.");
      }

      const parsed = req.schema.safeParse(block.input);
      if (parsed.success) {
        return {
          data: parsed.data,
          usage,
          provider: this.name,
          model: this.model,
          retries: attempt,
        };
      }

      // Forcing tool_choice guarantees the tool is *called*, not that its input
      // matches the schema — Claude validates tool input far more loosely than
      // OpenAI's strict json_schema, and occasionally mistypes a field. Return
      // the failure as a tool_result so the model can correct it in place.
      lastError = parsed.error;
      messages.push(
        { role: "assistant", content: resp.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `The input did not match the schema: ${describeZodError(parsed.error)}. Call the tool again with corrected input, keeping every field the schema requires.`,
            },
          ],
        },
      );
    }

    throw new Error(
      `Claude did not produce schema-valid tool input after ${MAX_VALIDATION_RETRIES + 1} attempts. Last error: ${describeZodError(lastError)}`,
    );
  }
}

/** Older Claude models accept temperature; Sonnet 5+ and Opus 4.7+ return 400 if set. */
function supportsSamplingParams(model: string): boolean {
  if (/claude-sonnet-5\b/.test(model)) return false;
  if (/claude-opus-4-[789]/.test(model)) return false;
  if (/claude-opus-5\b/.test(model)) return false;
  return true;
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
