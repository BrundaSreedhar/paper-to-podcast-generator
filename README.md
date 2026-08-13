# Paper → Podcast

Turn an academic paper into a **faithful** two-host podcast episode — a summary, key points, and a natural host/guest dialogue generated strictly from the paper's own content.

Model-agnostic by design: the same pipeline runs on **Claude**, **OpenAI**, or an **open model** (local Ollama or a hosted OSS endpoint) behind a single provider interface.

---

## North star: faithfulness

The hard part of this problem isn't generating audio — it's generating a script that says only what the paper actually says. Every design decision here serves that goal:

- **Section-aware extraction** removes references, appendices, and figure captions before the model ever sees the text, so it can't fabricate citations from a reference list it was shown.
- **Structured output** (a single schema enforced across all providers) replaces brittle text parsing, so the shape of the result is guaranteed rather than guessed at.
- **Explicit grounding constraints** in the system prompt: use only the provided paper, never invent numbers or names, say "the paper does not specify" rather than filling gaps.
- **A silent-truncation guard** that refuses to generate at all when the model didn't actually receive the whole paper (see below).

A faithfulness eval harness (LLM-as-judge) is the next phase — see [Roadmap](#roadmap).

---

## Status

| Phase | Scope | State |
|---|---|---|
| **P0** | Foundations, secrets hygiene, toolchain | ✅ Done |
| **P1** | Extraction → provider abstraction → dialogue → CLI | ✅ Done |
| **P2** | LLM-judge evals + frontier-vs-open comparison | ⬜ Next |
| **P3** | Audio (chunked, per-speaker TTS) | ⬜ Planned |
| **P4** | Async job model + streaming progress | ⬜ Planned |
| **P5** | Next.js frontend with synced transcript player | ⬜ Planned |
| **P6** | Tests in CI, deploy, README as pitch | ⬜ Planned |

**Today the project generates transcripts, not audio.** The full text pipeline (PDF → clean structure → summary + key points + dialogue) works end to end and is covered by 27 unit tests. Audio synthesis lands in P3.

Verified end to end against a live open model: a 4-minute episode from a real PDF via local `qwen2:7b` in ~72s (2,149 input / 855 output tokens, 13 dialogue turns, zero schema-validation retries).

---

## Quick start

### 1. Install

```bash
npm install
```

Requires Node 18+ (developed on Node 24).

### 2. Configure

```bash
cp .env.example .env
```

Then edit `.env` and set `LLM_PROVIDER` plus the credentials for whichever provider you want:

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `open` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Claude credentials and model id |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI credentials and model id |
| `OPEN_BASE_URL` / `OPEN_API_KEY` / `OPEN_MODEL` | Any OpenAI-compatible endpoint |

`.env` is gitignored; `.env.example` is the committed template.

### 3. Generate an episode

```bash
npm run generate -- path/to/paper.pdf
```

The CLI prints the summary, key points, and the first few dialogue turns, then writes the complete episode as JSON.

---

## Usage

```bash
# Default provider from .env, 10-minute target
npm run generate -- paper.pdf

# Shorter episode, explicit provider, custom output path
npm run generate -- paper.pdf --minutes 6 --provider anthropic --out episode.json
```

| Flag | Default | Description |
|---|---|---|
| `--minutes N` | `10` | Target spoken length; drives the word and token budget |
| `--provider` | `LLM_PROVIDER` from `.env` | `anthropic` \| `openai` \| `open` |
| `--out FILE` | `<paper>.episode.json` | Where to write the full result |

### Running fully free and offline

With [Ollama](https://ollama.com) installed locally, no API key is needed. `qwen2:7b` is the default open model, so this works with no further configuration:

```bash
ollama pull qwen2:7b
```

```bash
npm run generate -- paper.pdf --provider open --minutes 4
```

**Choosing an open model.** Set `OPEN_MODEL` to anything your host can run — the constraint is local RAM:

| Model | Approx. RAM | Notes |
|---|---|---|
| `qwen2:7b` | ~5 GB | Default; small but capable, fine for smoke tests |
| `qwen2.5:14b` | ~9 GB | Better quality; comfortable on a 16–18 GB machine |
| `llama3.3:70b` | ~40 GB+ | Needs a large workstation |

A hosted OpenAI-compatible tier (Together, Groq, OpenRouter) removes the RAM constraint entirely — point `OPEN_BASE_URL` at it and set `OPEN_API_KEY`. That is the better route for the P2 eval comparison, where a stronger open model makes the frontier-vs-open result more meaningful.

> **Raise Ollama's context window before using it on full papers.** Ollama defaults to a 4,096-token context regardless of the model's real capacity, which is far too small for a typical paper. Restart the server with a larger limit:
>
> ```bash
> OLLAMA_CONTEXT_LENGTH=32768 ollama serve
> ```
>
> Without this the run aborts with a `ContextTruncationError` rather than producing an episode about the wrong subject.

### Output shape

```jsonc
{
  "episode": {
    "summary": "…",
    "keyPoints": ["…"],
    "turns": [
      { "speaker": "host",  "text": "…" },
      { "speaker": "guest", "text": "…" }
    ]
  },
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "retries": 0,
  "truncatedInput": false
}
```

---

## Architecture

The core is plain TypeScript under `lib/`, deliberately independent of any web framework so it stays unit-testable in isolation and drops into Next.js route handlers in P5 without rework.

```
lib/
├── config/env.ts          Typed env loading and provider selection
├── pdf/
│   └── extract.ts         PDF → { title, abstract, sections[] }, noise stripped
├── llm/
│   ├── schema.ts          The Zod episode schema — single source of truth
│   ├── types.ts           LLMProvider interface
│   ├── anthropic.ts       Claude, via forced tool-use
│   ├── openai.ts          OpenAI, via strict json_schema
│   ├── openCompatible.ts  Open models, via JSON coercion + validation-retry
│   ├── contextGuard.ts    Aborts when the server silently drops input
│   ├── index.ts           Provider factory
│   └── generateEpisode.ts Prompt construction and orchestration
└── eval/                  (P2) LLM-judge harness

src/cli.ts                 End-to-end command-line runner
```

### The provider interface

One method is all the rest of the application depends on:

```ts
interface LLMProvider {
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
```

Each provider reaches the same guaranteed shape by a different route:

| Provider | Mechanism |
|---|---|
| **Claude** | The schema is registered as a tool and `tool_choice` forces the model to call it |
| **OpenAI** | Strict `response_format: json_schema`, enforced server-side |
| **Open models** | Schema embedded in the prompt + JSON mode, then Zod validation with the parse error fed back for self-correction (up to 3 retries) |

---

## Design decisions

**Why a provider abstraction rather than one SDK.** With only Claude and GPT the abstraction would be a formality — both support structured output natively. Adding an open model forces it to earn its keep: many OSS endpoints have no reliable tool-use or JSON-schema support, so the adapter has to coerce and validate. That coercion path is the part worth reading in `openCompatible.ts`.

**Why section-aware extraction and not full map-reduce chunking.** Modern context windows swallow most papers whole, so chunking a typical paper would be engineering theater. The real quality win is *what* you send, not how you split it — dropping the reference list and appendix measurably reduces fabricated citations. Papers that genuinely exceed the budget are truncated and flagged (`truncatedInput`) rather than silently cut.

**Why structured output instead of parsing text.** The original prototype asked for one blob of prose and split it with regex, which needed a second model call whenever the markers didn't appear. A schema removes the failure mode entirely.

**Why the pipeline fails loudly on context overflow.** Self-hosted endpoints cap the context window well below the model's real limit and do not error when a prompt exceeds it — they quietly drop the overflow. Ollama, for instance, defaults to 4,096 tokens no matter what the model supports, and ignores `num_ctx` over its OpenAI-compatible route.

This was found the hard way. Running the Amazon Aurora paper (~17k tokens) through a local 7B model produced a fluent, well-structured episode about *frequent itemset mining with MapReduce* — a topic found nowhere in the paper. The model had seen roughly a quarter of the input and confabulated the rest, with no error anywhere in the stack.

`lib/llm/contextGuard.ts` now compares the tokens sent against the tokens the server reports processing and aborts on a large shortfall. For a faithfulness-first system, a hard failure with remediation steps is strictly better than a confident, plausible, wrong answer.

---

## Development

```bash
npm test          # Vitest — 27 tests
npm run typecheck # tsc --noEmit
npm run lint      # ESLint
npm run format    # Prettier
```

Tests are deliberately network-free: PDF parsing runs against a flattened-paper fixture, providers are exercised through a stub, and the open-model JSON coercion is tested directly against malformed model output.

---

## Roadmap

- **P2 — Evals.** An LLM-as-judge harness that extracts claims from a generated script, checks each against the source paper, and reports faithfulness, coverage, and hallucination flags — then a three-way **Claude vs GPT vs open** comparison on quality, cost, and latency.
- **P3 — Audio.** Per-speaker voices, chunked to respect TTS input limits, concatenated into one episode with per-turn timestamps.
- **P4 — Backend.** Async job model with streamed stage-by-stage progress, typed errors, token/cost logging.
- **P5 — Frontend.** Next.js app with drag-and-drop upload, live progress, and an audio player that highlights the current dialogue turn.
- **P6 — Ship.** CI on every PR, deployed live URL, architecture diagram and eval results in this README.
