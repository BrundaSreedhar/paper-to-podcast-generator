# Paper → Podcast

Turn an academic paper into a **faithful** two-host podcast episode — a summary, key points, and a natural host/guest dialogue generated strictly from the paper's own content.

Model-agnostic by design: the same pipeline runs on **Claude**, **OpenAI**, or an **open model** (local Ollama or a hosted OSS endpoint) behind a single provider interface.

---

## North star: faithfulness

The hard part of this problem isn't generating audio — it's generating a script that says only what the paper actually says. Every design decision here serves that goal:

- **Section-aware extraction** removes references, appendices, and figure captions before the model ever sees the text, so it can't fabricate citations from a reference list it was shown.
- **Structured output** (a single schema enforced across all providers) replaces brittle text parsing, so the shape of the result is guaranteed rather than guessed at.
- **Explicit grounding constraints** in the system prompt: use only the provided paper, never invent numbers or names, say "the paper does not specify" rather than filling gaps.
- **Speaker constraints**, because fabrication is not only about the science. Left unconstrained, models name the show, hand the speakers doctorates, and slip into "our approach" as though the presenters wrote the paper. The show name is fixed (`PaperCast` by default), the two speakers are unnamed and have no credentials or affiliations, and the work is always attributed to *the authors*. Apart from the show name, every proper noun in the dialogue should come from the paper.
- **A silent-truncation guard** that refuses to generate at all when the model didn't actually receive the whole paper (see below).

All of this is measured rather than asserted — see [Evaluation](#evaluation).

---

## Status

| Phase | Scope | State |
|---|---|---|
| **P0** | Foundations, secrets hygiene, toolchain | ✅ Done |
| **P1** | Extraction → provider abstraction → dialogue → CLI | ✅ Done |
| **P2** | LLM-judge evals + frontier-vs-open comparison | ✅ Done |
| **P3** | Audio (chunked, per-speaker TTS) | ⬜ Planned |
| **P4** | Async job model + streaming progress | ⬜ Planned |
| **P5** | Next.js frontend with synced transcript player | ⬜ Planned |
| **P6** | Tests in CI, deploy, README as pitch | ⬜ Planned |

**Today the project generates transcripts, not audio.** The full text pipeline (PDF → clean structure → summary + key points + dialogue) works end to end and is covered by 148 unit tests. Audio synthesis lands in P3.

Verified end to end on real papers against both Claude and a local open model, and scored by the eval harness rather than by eye — see [Evaluation](#evaluation) for the numbers and their error bars.

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

> **Raise Ollama's context window before using it on full papers.** Ollama gives every model a 4,096-token context regardless of its real capacity — far too small for a typical paper, and it ignores `num_ctx` sent over the OpenAI-compatible API. Bake the larger context into a derived model instead:
>
> ```bash
> ollama create qwen2:7b-32k -f ollama/qwen2-32k.Modelfile
> ```
>
> Then set `OPEN_MODEL=qwen2:7b-32k`. Measured effect on this repo's own runs: **4,096 → 25,025** input tokens actually processed.
>
> Setting `OLLAMA_CONTEXT_LENGTH` and restarting the server is the commonly suggested fix, but it does **not** work on macOS — the menu-bar app supervises `ollama serve` and respawns it without that variable. The derived model needs no service restart, survives reboots, reuses the base weights (no extra disk), and leaves your other models untouched.
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
└── eval/
    ├── checks.ts           Deterministic checks (Layer 1)
    ├── judge.ts            Claim extraction, verification, coverage (Layer 2)
    ├── judgeSchema.ts      Strict-mode-safe schemas for the judge passes
    ├── dataset.ts          Paper discovery, annotations, fixture loading
    ├── mutate.ts           Deliberate corruptions for sensitivity testing
    ├── report.ts           Markdown comparison report and cost estimates
    └── fixtures/           Captured episodes with known verdicts

src/cli.ts                 Generate a single episode
src/eval.ts                Generate + score across providers
src/validate-judge.ts      Validate the judge before trusting it
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
| **Claude** | Schema registered as a tool, `tool_choice` forcing the call, then Zod validation with failures returned as a `tool_result` for in-place correction |
| **OpenAI** | Strict `response_format: json_schema`, enforced server-side |
| **Open models** | Schema embedded in the prompt + JSON mode, then Zod validation with the parse error fed back for self-correction |

Forcing `tool_choice` guarantees Claude *calls* the tool, not that the input matches the schema — unlike OpenAI's `strict` mode, tool input is validated loosely, and a field occasionally comes back mistyped. Validation and retry therefore belong on the Claude path too, not only the open-model one.

---

## Evaluation

```bash
npm run eval                  # generate + score on every provider with credentials
npm run eval:validate         # check the judge itself against known-bad episodes
npm run eval:validate -- --repeat 3   # measure judge variance
```

### Two layers

**Deterministic checks** run first, free and instantly, on every commit: schema, speaker alternation, length targets, show name, honorifics, claimed expertise, author impersonation, naming, and whether proper nouns and figures trace back to the paper. Most fabrication is decidable without a model, and sending an LLM to do a regex's job is slow and expensive.

**An LLM judge** handles what genuinely needs judgement. Faithfulness is scored by decomposition, not by asking a model for a rating out of ten: the transcript is split into atomic claims, and each is marked `supported`, `unsupported`, or `contradicted` against a quoted passage. A list of verdicts with evidence can be read and argued with; a single number cannot.

Only claim verification needs the full paper, so it is passed as cacheable context. Judging several providers on one paper pays for the paper once — measured at 25,762 tokens written to cache, then served from it twice.

### Validating the judge

An eval is only worth its output if the grader is sound, so `eval:validate` runs against captured episodes with known verdicts before any comparison is trusted. The most useful case is not synthetic: it is a real episode about *MapReduce frequent-itemset mining* that a local model produced from the Amazon Aurora paper after its context window silently truncated the input.

| Fixture | Faithfulness | Hallucination | Coverage |
|---|--:|--:|--:|
| `clean-claude` | 93% | 4% | 100% |
| `fabricated-personas` | 91% | 0% | 80% |
| `hallucinated-mapreduce` | **13%** | 47% | 0% |

A judge that rates that last row as faithful is broken. This one places it seven times below the faithful episodes.

Inspecting individual verdicts also caught a bug in the harness rather than the model. Decomposing *"the old bottleneck goes away, but the cost moves to the network"* into its first half alone produced a claim the paper genuinely contradicts — an artifact of splitting, not a hallucination. Extraction now keeps contrastive and qualified statements intact, which moved the clean episode from 88% to 93%.

### Sensitivity: mutation testing

Fixtures prove the checks catch the failures already seen. They say nothing about sensitivity in general, and hand-writing more cases only tests the failures one already thought of. So a clean episode is corrupted one fault at a time — a figure swapped for one the paper never states, a fabricated system introduced, a doctorate handed out, authorship claimed, the show renamed, alternation broken, the dialogue truncated — and each corruption names the check that must catch it.

**All 9 injected corruptions are detected, with no false positives on the uncorrupted control.** The suite reports that as a rate, so a regression in a regex shows up as a number rather than a mysteriously passing build. It needs no API key and runs in CI.

### Judge variance

Repeated grading of the same episode, `claude-sonnet-5`, three runs each:

| Fixture | Mean | Spread |
|---|--:|--:|
| `clean-claude` | 94% | 2.0 pts |
| `fabricated-personas` | 91% | 0.0 pts |
| `hallucinated-mapreduce` | 12% | 8.2 pts |

**A gap of two or three points between models is noise.** Differences are only reported as real when they exceed this.

### Results

Amazon Aurora paper, 4-minute episode, judged by `claude-sonnet-5`:

| Generator | Faithful | Halluc. | Coverage | Compliance | Cost | Time |
|---|--:|--:|--:|--:|--:|--:|
| `claude-sonnet-5` | 91% | 4% | **100%** | 100% | $0.245 | 48s |
| `qwen2:7b-32k` (local) | 94% | 4% | 80% | 100% | free | 174s |

Read carefully, because the headline number is the misleading one. The open model's 3-point faithfulness lead sits inside the judge's 2-point noise band and should be treated as a tie. The real difference is **coverage**: the local model omitted one of the paper's five key contributions — that an asynchronous scheme based on log sequence numbers replaces two-phase commit — while Claude conveyed all five in roughly four times the output.

That is the trap in scoring faithfulness alone. **An episode that says less has less to be wrong about**, and a model that says nothing at all scores perfectly. Coverage is what stops faithfulness from rewarding silence, and the two belong in the same table.

Both `results/*.md` reports flag when the judge and generator are the same model. Models favour their own output, so a self-judged score is an upper bound, not a neutral measurement; `JUDGE_PROVIDER` exists to break that tie once a second provider is available.

### Adding a paper

Drop a PDF into `sample_papers/` — it is discovered automatically — then add its key contributions to `ANNOTATIONS` in [`lib/eval/dataset.ts`](lib/eval/dataset.ts).

Without annotations, coverage is reported as **not measured** rather than 0%. That distinction matters: scoring an unannotated paper 0% would read as "the episode covered nothing" and quietly condemn every newly added paper. The runner warns when annotations are missing.

### Known limits

- One paper. A comparison across a single document shows the harness works, not which model is better; more papers are the obvious next step.
- Claude currently judges its own output on the frontier row, flagged in every report.
- Coverage depends on hand-annotated contributions, so it exists only for annotated papers.
- Mutation testing currently exercises the deterministic layer only; the judge's own detection rate is not yet measured.

**Full design rationale:** [docs/evaluation-design.md](docs/evaluation-design.md).

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
npm test          # Vitest — 148 tests
npm run typecheck # tsc --noEmit
npm run lint      # ESLint
npm run format    # Prettier
```

Tests are deliberately network-free: PDF parsing runs against a flattened-paper fixture, providers are exercised through a stub, and the open-model JSON coercion is tested directly against malformed model output.

---

## Roadmap

- **P3 — Audio.** Per-speaker voices, chunked to respect TTS input limits, concatenated into one episode with per-turn timestamps.
- **P4 — Backend.** Async job model with streamed stage-by-stage progress, typed errors, token/cost logging.
- **P5 — Frontend.** Next.js app with drag-and-drop upload, live progress, and an audio player that highlights the current dialogue turn.
- **P6 — Ship.** CI on every PR, deployed live URL, architecture diagram and eval results in this README.
