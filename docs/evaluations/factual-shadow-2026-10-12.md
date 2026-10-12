# Factual review: frozen Gemma shadow evaluation

## Decision

**Parked. Do not replace, relax or augment the publication gate. Memory phase two remains on hold.** This experiment exposes false approvals, a false rejection and invalid review metadata. It does not demonstrate a reliable improvement over the existing reviewer. Phase-one memory context and the commitment-delivery fix are retained unchanged for manual testing.

No production generation/review/publication code was changed. No server was started, and no real channel, user or persistent memory was used. The new module has no production imports. This is an isolated live-model comparison, not a background observer installed on chat traffic.

The parked module and its tests now live under `scripts/experiments/`, outside the production TypeScript build. Only explicit manual evaluation invokes it. Regression tests and a [durable result archive](factual-shadow-2026-10-12.results.json) are retained in the repository; the archive preserves all 64 candidate comparisons, parsed assessments, original model responses (including invalid ones), timings and original report hashes without duplicating 128 large prompt bodies or saving credentials.

## Method

- Model: `google/gemma-4-26b-a4b` through the existing LM Studio endpoint.
- 12 discovery cases and 20 independently prepared holdout cases, each repeated twice: **64 comparisons / 128 model calls**, excluding four preliminary probes.
- Five languages overall: English, Swedish, Spanish, French and German. Code, arithmetic, procedures, time offsets, source scope, stale information, injection-bearing source text, opinions, fiction and non-delivery controls.
- Each model receives the same unchanged draft and relevant request/context/source text. The existing reviewer also retains its own persona/room/delivery context; the narrow checker deliberately does not receive that broad contract or its verdict. The legacy sequential-state case retains its earlier memory/scene fixture.
- Fixture labels, rationales, case names and the other reviewer's outputs are not model inputs. Call order alternates, with at most two active calls total.
- Both arms use temperature 0 and `reasoning_effort: none`. Shadow output is bounded to 1,200 tokens and a 20-second cooperative deadline, without retries. A preliminary low-reasoning probe still approved the known wrong code; that setting was not adopted.
- Prompt and inference configuration were frozen before opening/evaluating holdout. Neither was tuned after seeing holdout results. Repetitions at temperature 0 are not independent samples or evidence of statistical significance.
- Full prompts, raw replies, normalized outcomes, source hashes, timings and usage are retained in fresh temporary reports. No arbitrary candidate code is executed; the test oracles are manually specified, checkable examples.

## Narrow-check results

“Correct” below means the coarse factual distinction (clean vs defective), not complete correctness of every explanatory rationale. Unavailable assessments are not counted as successful rejections.

| Result | Discovery (24) | Holdout (40) | Total (64) |
| --- | ---: | ---: | ---: |
| Correct coarse factual decision | 18 | 34 | 52 |
| False approval against frozen labels | 4 | 1 | 5 |
| False rejection | 0 | 1 | 1 |
| Invalid/unavailable assessment | 2 | 4 | 6 |
| Explicit uncertainty/abstention | 0 | 0 | 0 |

The valid variant and defective variant were both correctly distinguished in 4/10 discovery pair-repetitions and 11/16 holdout pair-repetitions. Single controls are not counted as matched pairs.

The existing review cleared five drafts labelled factually defective and returned no valid assessment twice. Its only two blocks on factually clean controls were **correct delivery blocks**: “I'll come up with names later” did not supply the two names requested. These must not be advertised as factual false rejections. The broad review's factual issue codes alone missed nine labelled defects, but some were caught under other issue codes; issue-code absence is not publication approval. The harness records these layers separately.

### Concrete findings

1. **Known sequential mutation/copy example:** both reviewers approved the correct version twice and the incorrect version twice. The narrow check still misses that copying an already-mutated array cannot undo the earlier mutation. This is a reasoning failure, not a missing citation.
2. **Held-out `let` loop bindings:** the narrow checker rejected the correct `[0, 1, 2]` answer once and approved the incorrect `[3, 3, 3]` answer once. The second repetition distinguished them correctly. The existing reviewer approved both incorrect repetitions. The shadow false rejection is new; discovery produced no broad false rejection whose repair could be demonstrated.
3. **Arithmetic metadata:** two discovery responses noticed the arithmetic error in prose but labelled every individual claim supported while declaring the overall answer contradicted. Structural validation correctly returned `unavailable`; it did not reinterpret prose to rescue the result.
4. **Procedure/counting metadata:** four holdout responses noticed the error but returned either a non-exact excerpt or invalid conversation references. They are unusable assessments, not counted as correct rejections. We did not weaken validation after seeing them.
5. **Grounded contrasts:** source exclusions, private-demo versus public-release, fixed UTC offsets and several other supplied-evidence contrasts were distinguished successfully. The injected instruction inside a source did not overturn the tested factual result. These limited successes are not general injection-resistance or factual-reliability guarantees.
6. **Delivery remains independent:** the deferred café-name promise was `not_factual` in shadow but blocked by the unchanged delivery reviewer in both repetitions. Shadow results cannot override that block.

### Oracle caveats

- Two discovery false-approval labels concern an explicitly fictional stock. Fictional framing could license inventing a price; the candidate also asserts an unsupported “I just checked” action that the narrow review omitted. Retain the frozen labels, but do not present these as unambiguous real-world price hallucinations. The other three false approvals are unambiguous code errors.
- The stale-price holdout expects `insufficient_evidence`, while shadow returned `contradicted` twice. Its candidate asserts both today's price and that yesterday's observation establishes today's price. The second assertion is arguably contradicted by the supplied limitations, so the stronger overall verdict is defensible. Count both as detected defects, with an exact-label ambiguity, not as proof of confusing unknown prices with false prices.

## Cost and limits

Across all 64 comparisons, median existing-review latency was **2.839 s**, versus **3.159 s** for the narrow check (p95 3.790 s / 5.312 s). Narrow input averaged about **850 tokens**, versus about **10,940** for broad review, but its explanatory output erased that input-size advantage in wall-clock time. Adding it serially would therefore add meaningful latency, not be free. These figures are for this local run at concurrency two, not a throughput benchmark or guaranteed production latency.

Scope excludes actual page fetching, canonical-room source entitlements, voice/acoustics, images, channel feeds, private memory authority, live routing and end-to-end publication. Passing synthetic supplied-source checks does not validate those systems. Same-model agreement is not independent verification.

## Reproduce and inspect

```sh
npm run test:parked:factual-shadow
npm run eval:parked:factual-shadow -- --split=discovery --samples=2
npm run eval:parked:factual-shadow -- --split=holdout --samples=2 --frozen-prompt=2321dd78b7ab9c710efa96546cc22b687a3abda91a98ab02965f9019174aefce
```

Use `--list` or `--dry-run` for an offline manifest. Optional `--output` must be a fresh directory below the system temporary directory. Reports never overwrite earlier traces. The CLI checks the frozen prompt; reports also fingerprint the configuration-containing module, so a matching prompt alone is not a claim that all configuration is unchanged.

Frozen artifacts:

- System prompt SHA256: `2321dd78b7ab9c710efa96546cc22b687a3abda91a98ab02965f9019174aefce`.
- Shadow module SHA256: `9034e3e73ce17a09268a757dd50fc9b9340fe6e46e66a5caf830ef7c3ebbc61a`.
- Holdout fixture SHA256: `c226dedea3eec9821d96d8c547f138cc36e64f117615ce5dc9568f1e8034ebc7`.
- Discovery report: `/tmp/third-place-factual-shadow-discovery-v1-20261012/report.json`, SHA256 `686047c81763221389031390b1265425d857c151c6f330c7d993263988654465`.
- Holdout report: `/tmp/third-place-factual-shadow-holdout-v1-20261012/report.json`, SHA256 `8083b90fd97bae30c8e032dff6564a8bc8be16a9e337aedc8d67a807bf7abf66`.

The discovery run captured an earlier harness whose broad overall counters were misleadingly named “falseRejections/falseApprovals.” The frozen raw report was not rewritten. This report and the durable archive interpret its cells using the corrected `summarize()` naming, which distinguishes overall blocks from factual flags. Model inputs/results are unchanged. The holdout run used the corrected harness (`2997410eef5f4194373a07f677c1fe4063fa1a00457abac81e706b0b153a0f65`). The later parking move changes file paths/module hashes but not the frozen prompt, inference settings or recorded results. The hashes above describe the original evaluation, not the relocated files. Temporary full-prompt reports may eventually be removed by the host; fixtures, checks, per-case outputs and this qualified summary remain in the repository.

Validation after parking: **2,391/2,391 Vitest tests**, including the 71 relocated contract/isolation tests; **11/11 offline harness/archive tests**; application and experiment typechecks and production build passed. The archive test replays all 64 recorded shadow replies without calling Gemma and preserves all six invalid assessments as invalid. No runtime source changed relative to `1b9fe6a`; stale compiled experiment output was removed, and the production build does not recreate it. No merge, deployment, production feature flag or phase-two work is part of this experiment.
