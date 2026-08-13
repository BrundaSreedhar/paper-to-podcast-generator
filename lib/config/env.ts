import dotenv from "dotenv";

// Load .env once, on first import. Safe to call repeatedly.
dotenv.config();

export type ProviderName = "anthropic" | "openai" | "open";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}

/**
 * Which provider drives script generation. Defaults to Anthropic so the
 * project leads with Claude while staying swappable.
 */
export function activeProvider(): ProviderName {
  const p = opt("LLM_PROVIDER", "anthropic").toLowerCase();
  if (p === "anthropic" || p === "openai" || p === "open") return p;
  throw new Error(
    `LLM_PROVIDER must be one of "anthropic" | "openai" | "open" (got "${p}").`,
  );
}

export const anthropicConfig = () => ({
  apiKey: req("ANTHROPIC_API_KEY"),
  model: opt("ANTHROPIC_MODEL", "claude-sonnet-5"),
});

export const openaiConfig = () => ({
  apiKey: req("OPENAI_API_KEY"),
  model: opt("OPENAI_MODEL", "gpt-4o"),
  ttsModel: opt("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
});

export const openConfig = () => ({
  baseURL: opt("OPEN_BASE_URL", "http://localhost:11434/v1"),
  // Local runtimes (Ollama) accept any non-empty key.
  apiKey: opt("OPEN_API_KEY", "ollama"),
  model: opt("OPEN_MODEL", "qwen2:7b"),
});
