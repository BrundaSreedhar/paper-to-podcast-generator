# Evaluation design

How this project decides whether a generated episode is any good, and why the
harness is shaped the way it is.

---

## The problem

The pipeline turns a paper into a spoken dialogue. The failure that matters is
not a crash — it is a fluent, confident episode that says things the paper never
said. That failure is invisible by construction: the output reads perfectly, and
the only signal that anything is wrong is that it does not match a document
nobody re-reads.

Every fabrication found while building this was caught by a human noticing it in
a transcript:

| Failure | What it looked like |
|---|---|
| Whole-episode hallucination | An episode about MapReduce itemset mining, generated from the Amazon Aurora paper |
| Invented show name | "Welcome to Science Uncovered" |
| Fabricated credentials | "Dr. Rivera, our expert in digital ethics" |
| Author impersonation | "By pushing redo processing down, **we** reduce network traffic" |
| Invented personas | Two hosts with names nobody asked for |
| Length collapse | 14 dialogue turns silently becoming 5 |

The eval exists so that finding these does not depend on whether somebody read
carefully that day.

---

## Two layers, cheapest first

The guiding rule: **do not send a language model to do a regex's job.** Most of
the failures above are decidable without a model, so they run first — free,
instant, and on every commit. The judge is reserved for what genuinely needs
judgement.

```
episode ──▶ Layer 1: deterministic checks   (free, ms, every commit)
        └─▶ Layer 2: LLM judge              (paid, ~60s, on demand)
```

### Layer 1 — deterministic checks

Eleven pure functions over `(episode, paper)`. No network, no model.

| Check | Catches | Severity |
|---|---|---|
| `schema` | Off-schema payload that slipped through validation | error |
| `alternation` | Same speaker twice in a row | error |
| `show-name` | A show name other than the configured one | error |
| `honorifics` | Doctorates and titles absent from the paper | error |
| `claimed-expertise` | "an expert in distributed systems" | error |
| `author-impersonation` | "we designed", "our approach" | error |
| `no-names` | Speakers addressed by invented names | error |
| `turn-count` | Dialogue collapsed below its target | warning |
| `word-count` | Episode far shorter than requested | warning |
| `proper-nouns` | Entities the paper never mentions | warning |
| `numbers` | Figures the paper never states | warning |

**Errors** are unambiguous contract violations and gate CI. **Warnings** are
heuristics — a proper noun absent from the paper is suspicious, not proof.

Two checks are grounding proxies rather than rules. `proper-nouns` and `numbers`
compare the dialogue against a word-level index of the paper, which catches a
surprising share of hallucination for zero cost: an episode discussing a system
the paper never names is almost always wrong.

`numbers` accepts rounding. The paper's "5.38 milliseconds" spoken as "about
5.4" is honest paraphrase, so a paper figure that rounds to the spoken one at
its stated precision counts as present. This was added after the check produced
a false positive on a correct episode — an eval that cries wolf is worse than no
eval.

### Layer 2 — the LLM judge

Three passes, each with a strict output schema.

```
1. extract   transcript              ──▶ atomic claims
2. verify    claims + paper          ──▶ supported | unsupported | contradicted
3. coverage  episode + contributions ──▶ hit | missed
```

**Faithfulness is scored by decomposition, not by rating.** Asking a model to
score an episode out of ten produces a number that is noisy and impossible to
argue with. A list of atomic claims, each with a verdict and a quoted passage,
can be read line by line and disagreed with — which is what makes the score
inspectable rather than merely numeric.

Claim extraction has two rules worth noting, both added after reading real
output:

- **Contrastive statements are not split.** Decomposing "the old bottleneck goes
  away, but the cost moves to the network" into its first half alone produces a
  claim the paper genuinely contradicts — an artifact of splitting, not a
  hallucination. Fixing this moved a clean episode from 88% to 93%.
- **Meta-claims are excluded.** "This episode discusses a paper" is not a claim
  about the paper's subject and does not belong in the denominator.

### Metrics

```
faithfulness  = supported / total_factual_claims
hallucination = (contradicted + specific_unsupported) / total_factual_claims
coverage      = contributions_conveyed / contributions_expected
compliance    = layer-1 checks passed / total
```

Hallucination separates **specific** unsupported claims (a number, a system, a
result the paper never gave) from vague ones ("this is an important area").
Asserting a fabricated figure is a different failure from conversational
framing, and collapsing them makes the metric useless.

---

## Why coverage exists

Faithfulness alone rewards silence. An episode that says almost nothing scores
near 100%, because it has almost nothing to be wrong about. This is not
hypothetical — it is what the first real comparison showed:

| Generator | Faithful | Coverage | Output |
|---|--:|--:|--:|
| `claude-sonnet-5` | 91% | **100%** | 5,250 tokens |
| `qwen2:7b-32k` | 94% | 80% | 1,297 tokens |

The open model's higher faithfulness is not a win. It said a quarter as much and
dropped one of the paper's five key contributions. **Coverage is what stops
faithfulness from rewarding brevity**, and the two only mean something together.

---

## Trusting the grader

An eval is worth nothing if the grader is unsound, so three things check the
checker.

### 1. Known-bad fixtures

`npm run eval:validate` runs before any comparison is trusted. The fixtures are
real captured outputs, not synthetic ones, each with bounds it must land inside.

| Fixture | Expectation | Measured |
|---|---|--:|
| `clean-claude` | ≥80% faithful, 0 errors | 93% |
| `fabricated-personas` | ≥2 deterministic errors | 91%, 2 errors |
| `hallucinated-mapreduce` | **≤30% faithful** | 13% |

The last is the most valuable test in the suite: an episode about MapReduce
itemset mining produced from the Aurora paper after a local model's context
silently truncated. A judge that rates it faithful is broken. This one puts it
seven times below the faithful episodes.

That fixture is pinned to `paperId: "aurora"`, so it is always judged against
the Aurora paper regardless of what else is in the corpus. Adding a real
MapReduce paper to `sample_papers/` does not weaken it — the claim it encodes is
"this episode is unfaithful *to the Aurora paper*", which stays true.

### 2. Sensitivity, via mutation

Fixtures prove the checks catch failures already observed. Writing more by hand
only tests failures already imagined. So a clean episode is corrupted one fault
at a time, each naming the check that must catch it:

```
swap-number       → numbers                 fabricate-entity → proper-nouns
add-honorific     → honorifics              claim-authorship → author-impersonation
claim-expertise   → claimed-expertise       invent-show-name → show-name
address-by-name   → no-names                break-alternation → alternation
truncate-dialogue → turn-count
```

**9 of 9 detected, no false positives on the uncorrupted control.** Sensitivity
becomes a rate over a family of known-bad inputs rather than an anecdote, and a
regression in a regex shows up as a number. Needs no API key; runs in CI.

Two guards keep this honest: the control must pass *every* check, so a failure
is attributable to the mutation; and no expected check may fire on the clean
control, so a check that fires unconditionally cannot fake a perfect score.

### 3. Variance

Grading the same episode repeatedly, `claude-sonnet-5`, three runs each:

| Fixture | Mean | Spread |
|---|--:|--:|
| `clean-claude` | 94% | 2.0 pts |
| `fabricated-personas` | 91% | 0.0 pts |
| `hallucinated-mapreduce` | 12% | 8.2 pts |

**A two- or three-point gap between models is noise.** Differences are only
reported as real when they exceed the spread of the instrument measuring them.
This is why the comparison above is described as a tie on faithfulness.

---

## Cost

Only verification needs the whole paper. Claim extraction sees the transcript
alone; coverage sees the episode against a short annotated list. So one
expensive call per episode, not three.

The paper is passed as `cacheableContext`, which the Anthropic adapter marks for
prompt caching and other providers simply prepend. Judging several providers on
one paper therefore pays for the paper once: measured at 25,762 tokens written
to cache, then served from it twice across three judgements. Cached input bills
at roughly a tenth of the fresh rate.

---

## Bias

Every report flags rows where the judge and generator are the same model.
Language models systematically prefer their own output, so a self-judged score
is an upper bound rather than a neutral measurement. `JUDGE_PROVIDER` exists to
break that tie once a second provider is available; until then the caveat is
printed rather than quietly omitted.

---

## Adding to the dataset

1. Drop a PDF into `sample_papers/`. It is discovered automatically — the id is
   the filename without extension.
2. Add its key contributions to `ANNOTATIONS` in `lib/eval/dataset.ts`.

Without step 2, coverage is reported as **not measured** rather than 0%. That
distinction matters: scoring an unannotated paper 0% would read as "the episode
covered nothing" and quietly condemn every newly added paper. The runner warns
when annotations are missing.

To add a new corruption, extend `MUTATIONS` in `lib/eval/mutate.ts` with the
check expected to catch it; the detection-rate test picks it up automatically.

---

## Audio

Audio is checked for integrity, not aesthetics. Whether the delivery sounds
natural needs a human or a speech model; whether a turn of fifty words produced
two seconds of audio does not.

The failure worth catching is **text silently going missing**. A synthesis call
that drops a chunk, truncates a sentence, or returns an empty buffer still
yields a file that plays perfectly. Nobody re-reads a transcript against a
waveform, so the loss is invisible — structurally the same problem as a context
window quietly discarding a paper.

| Check | Catches | Severity |
|---|---|---|
| `audio-parses` | Unreadable or empty output | error |
| `turns-voiced` | A turn with no audio at all | error |
| `timeline-order` | Overlapping or out-of-order turns | error |
| `timeline-matches-audio` | Timings drifting from the file's real length | error |
| `silent-turns` | Text present, no audible speech (measured by RMS) | error |
| `speech-rate` | Dropped text: words per minute far outside 80–260 | warning |
| `episode-duration` | An episode far shorter than requested | warning |

`speech-rate` is a cheap stand-in for transcribing the audio back and comparing
it to the script. A proper round-trip through a speech recognizer would catch
missing text definitively, but needs a model and a dependency; comparing spoken
duration against word count catches the same class of failure for nothing.

`timeline-matches-audio` exists because drift is progressive. A timeline that
disagrees with its file does not fail loudly — it highlights the wrong line, a
little further out as the episode goes on.

Sensitivity is measured by the same mutation method as the text layer: silence a
turn, truncate the file, desync the timeline, overlap two turns, drop a timing.
**5 of 5 detected, no false positives on the control.** The real Aurora episode
scores 100%, which also calibrates the speech-rate thresholds against genuine
speech rather than the synthetic tone used in tests.

---

## Known limits

- **One paper.** The current comparison demonstrates the harness works, not
  which model is better. More papers are the obvious next step.
- **Claude judges its own output** on the frontier row, flagged in every report.
- **Coverage depends on hand annotation**, so it exists only for annotated
  papers.
- **Layer 2 sensitivity is unmeasured.** The mutation harness currently exercises
  the deterministic layers only. Running the same corruptions through the judge
  would give a detection rate for the expensive layer too.
- **Audio is checked structurally, not perceptually.** Nothing here measures
  whether the speech sounds good, or whether a word was mispronounced. An ASR
  round-trip would turn the speech-rate proxy into a real measurement of what
  the audio actually says.
