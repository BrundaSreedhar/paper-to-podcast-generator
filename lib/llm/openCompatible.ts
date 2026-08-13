import OpenAI from "openai";
import { ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { openConfig } from "../config/env.js";
import { assertNoSilentTruncation } from "./contextGuard.js";
import type { LLMProvider, StructuredRequest, StructuredResult, Usage } from "./types.js";

const MAX_RETRIES = 3;

/**
 * Adapter for any OpenAI-compatible endpoint — a hosted OSS tier (Together,
 * Groq, OpenRouter) or a local runtime (Ollama). This is where the provider
 * abstraction earns its keep: open models frequently lack reliable tool-use or
 * strict json_schema, so we (1) ask for JSON mode when available, (2) embed the
 * schema in the prompt, and (3) validate against Zod, re-asking with the error
 * on failure. That coercion + validation-retry loop is what makes an open model
 * a first-class citizen next to Claude and GPT.
 */
export class OpenCompatibleProvider implements LLMProvider {
  readonly name = "open" as const;
  readonly model: string;
  private client: OpenAI;

  constructor() {
    const cfg = openConfig();
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.model = cfg.model;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const jsonSchema = zodToJsonSchema(req.schema, { $refStrategy: "none" }) as Record<
      string,
      unknown
    >;
    delete jsonSchema.$schema;

    const system = `${req.system}

Respond with a SINGLE JSON object and nothing else — no commentary, no markdown code fences. It must conform exactly to this JSON Schema:
${JSON.stringify(jsonSchema)}`;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: req.user },
    ];

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const completion = await this.chat(messages, req);
      const content = completion.choices[0]?.message?.content ?? "";

      // Verify the server actually ingested the prompt before trusting anything
      // it says. Checked on the first attempt, when `messages` is exactly what
      // we composed; retries append correction turns and only grow from here.
      if (attempt === 0) {
        assertNoSilentTruncation({
          sentText: system + req.user,
          processedTokens: completion.usage?.prompt_tokens,
          model: this.model,
        });
      }

      usage.inputTokens = (usage.inputTokens ?? 0) + (completion.usage?.prompt_tokens ?? 0);
      usage.outputTokens =
        (usage.outputTokens ?? 0) + (completion.usage?.completion_tokens ?? 0);

      try {
        const data = req.schema.parse(extractJson(content));
        return { data, usage, provider: this.name, model: this.model, retries: attempt };
      } catch (err) {
        lastError = err;
        // Feed the failure back so the model can self-correct.
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `That response was not valid: ${describeError(err)}. Reply again with ONLY a JSON object conforming to the schema — no other text.`,
        });
      }
    }

    throw new Error(
      `Open model produced no valid structured output after ${MAX_RETRIES + 1} attempts. Last error: ${describeError(lastError)}`,
    );
  }

  /** Request JSON mode; fall back to a plain call if the endpoint rejects it. */
  private async chat<T>(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    req: StructuredRequest<T>,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      max_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.4,
    };
    try {
      return await this.client.chat.completions.create({
        ...body,
        response_format: { type: "json_object" },
      });
    } catch {
      // Some endpoints/models don't support response_format — degrade gracefully.
      return await this.client.chat.completions.create(body);
    }
  }
}

/** Pull a JSON object out of a model response that may wrap it in prose/fences. */
export function extractJson(text: string): unknown {
  let t = text.trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    t = fence[1].trim();
  } else if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
  }

  return JSON.parse(t);
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  if (err instanceof SyntaxError) return `invalid JSON (${err.message})`;
  return err instanceof Error ? err.message : String(err);
}
