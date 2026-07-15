# Adding a turn capability

Turn capabilities are the narrow server-owned actions that may supply current or external evidence to a resident reply. Adding one is a security and grounding change, not merely a new model prompt or an extra branch in the social director.

This guide defines the mandatory extension contract. New capabilities belong in the capability catalog and runtime registry; they must not add capability-ID-specific control flow to `server/director.ts`.

## Start with the generic default

Use `web_search` for general external discovery. A new dedicated adapter is justified only when it gives the server a materially narrower or more reliable contract, for example:

- a structured response whose fields can be strictly validated;
- a fixed provider and fixed endpoint family rather than arbitrary destinations;
- a security, authorization or licensing boundary that generic page reading cannot provide;
- deterministic calculations that should not be left to the dialogue model; or
- a non-web local fact such as the validated server clock.

An exact URL supplied by the guest remains `read_url`. A current date or time request remains `local_datetime`. A current-day or future forecast at a resolvable named location remains `weather_forecast`. Fixtures, latest provider-reported results and provisional group tables for the registered 2026 World Cup target remain `football_data`; minute-by-minute scores, news, injuries, lineups, tactics and causes remain `web_search`. Everything else that asks for current or external discovery should normally remain `web_search`.

This default applies when the semantic router selects an action. It is not an execution fallback. Once a trusted `CapabilityInvocation` selects a dedicated capability, a failed attempt must remain a failure of that exact action. The registry must never silently run `web_search`, `read_url` or another adapter instead. A new turn may make a new semantic decision, but one invocation has one identity and one bounded authority.

## The extension seam

The capability system has one declarative catalog and one runtime binding layer:

- `server/capabilities/catalog.ts` is the static source of truth for the semantic contract: stable ID, routing class, local/external classification, bounded argument shape and primary/verifier routing guidance. Router and verifier schemas are derived from this catalog.
- `server/capabilities/registry.ts` binds every catalog entry to exactly one runtime adapter. The adapter owns trusted runtime availability, invocation compilation, provider execution, answerability, grounding, failure presentation and source/publication policy.

The Director should receive only the registry interface and neutral results. It may schedule a responder, pass trusted evidence to generation and publish validated sources, but it must not compare an action to strings such as `weather_forecast` or inspect adapter-specific arguments.

Two neutral contracts cross that boundary:

- `CapabilityInvocation` is the validated, confidence-gated request produced after semantic routing. It contains one registered capability ID, request kind, resolved goal and only that capability's bounded arguments.
- `EvidenceResolution` is the adapter's normalized outcome. It records whether execution failed temporarily, produced retrieval metadata only or produced bounded grounding that may enter semantic generation/review, plus source/publication policy and any trusted presentation data needed by the scene. `grounding_available` deliberately does not promise that arbitrary page text answers the guest; relevance remains a semantic publication requirement. The result does not invite the Director to reinterpret the capability ID.

An invocation that is unknown, unavailable, malformed or below either the evidence-plan or capability-intent confidence threshold fails closed before execution.

## Mandatory adapter process

### 1. Write the justification

Document the user need and explain why `web_search` plus safe page expansion is insufficient. State the narrower authority the adapter introduces, the expected freshness, the provider and the failure behavior. If the argument is only “this site is easier to scrape directly,” keep using the generic path.

Also state which media may advertise the capability. Voice currently exposes only its deliberately small trusted capability inventory; a text capability does not become a voice capability automatically.

### 2. Add one catalog entry

Add the capability once in `server/capabilities/catalog.ts`. The entry must define:

- a stable, bounded ID;
- a concise multilingual semantic scope, including when not to select it;
- the media allowed to advertise it (`public`, `dm` and/or `voice`);
- strict required and forbidden argument fields;
- whether its semantic scope is generic discovery, an exact source or a narrow structured lookup; and
- whether it obtains external evidence or resolves a local trusted fact.

Do not add a language keyword list, room-name switch, domain allowlist or capability-ID branch in the Director. Meaning belongs to the multilingual router; syntax, inventory and transport policy remain deterministic.

### 3. Extend the strict semantic schema

Derive the primary router and evidence-verifier action enums from the catalog. The selected adapter must validate its own argument projection in both descriptive and compact wire forms.

Add multilingual contrasts covering:

- a positive execution request;
- a pure availability question that does not execute;
- an unavailable adapter;
- missing, ambiguous and extra arguments;
- a negated or passive mention;
- a correction or retry;
- a broad external request that must stay on `web_search`;
- an exact supplied URL that must stay on `read_url`; and
- neighboring local or dedicated capabilities that must not be confused with it.

The verifier may recover a complete invocation from a failed primary classification, but it may not manufacture unavailable authority or silently change an already selected action after execution.

### 4. Implement the provider boundary

Keep provider code outside the Director. Bound and validate every input before transport. For an external provider, define at minimum:

- fixed HTTPS origins and endpoint shapes;
- credential and redirect policy;
- request timeout, response-byte and concurrency limits;
- per-guest and global rate limits;
- cache and in-flight deduplication bounds;
- accepted status and media types;
- an exact response schema;
- control-character and length handling; and
- safe logging that excludes secrets and unnecessary personal data.

An adapter must not become an open proxy. Page-controlled text and provider error bodies are untrusted data, never instructions or prompt policy.

### 5. Register the adapter

Bind the provider to its catalog entry in `server/capabilities/registry.ts`. Registration must reject duplicate IDs, a catalog entry without an implementation and an implementation without a catalog entry. Its adapter must define:

- an availability predicate based only on trusted server state and turn context;
- strict compilation from the catalog-validated argument projection;
- whether it requires a research-capable resident;
- provider execution and exact answerability rules;
- successful and failed grounding instructions;
- automatic-failure visibility, if applicable, driven only by a trusted server-owned response obligation rather than domain or language wording; and
- source-ID, source-count and URL-card publication policy.

The adapter receives a `CapabilityInvocation` and trusted execution context. It returns one `EvidenceResolution`; it does not publish chat messages, choose residents, call another capability or mutate the invocation.

### 6. Prove safe grounding

Keep retrieval separate from answerability:

- generic search titles and snippets are retrieval metadata only;
- `web_search` reaches `grounding_available` only after the bounded evidence resolver safely reads and validates one or more result pages;
- an exact page reaches `grounding_available` only after the page reader returns bounded content for the selected server-owned target; and
- structured provider data may reach `grounding_available` directly only after exact schema validation and bounded server-side transformation.

`grounding_available` means safe bounded material exists; it does not certify semantic relevance to the exact question. Generation must cite the supporting source and the multilingual publication reviewer must reject irrelevant or unsupported answers. An `EvidenceResolution` with retrieval-only readiness must never be presented to the dialogue model as proof of the requested fact. Empty or malformed structured data is a temporary failed attempt, not a weak success.

### 7. Define grounding and sources

Successful evidence must use server-issued source IDs. The adapter declares whether a factual answer requires a source, whether a server-owned source card is attached and which exact validated URL backs it. The model cannot invent, rewrite or select a different destination.

The generation contract must say what concrete facts are available and what may not be inferred. Candidate review receives the same bounded evidence and must reject unsupported numbers, claims outside the requested horizon, false capability denials and source IDs not present in the resolution.

Failure text must remain scoped to this attempt. It may not become “I cannot access the internet,” “weather data is unavailable here,” or any other permanent capability claim.

### 8. Review privacy and configuration

Document:

- whether guest text or a named location leaves the server;
- which third party receives it and sees the server IP;
- whether credentials, accounts or personal data are involved;
- retention and cache duration;
- the exact enable/disable setting and safe default;
- provider terms, attribution and commercial-use constraints; and
- the least precise input that still satisfies the request.

Never send a full chat transcript when a bounded query or city name is sufficient. Secrets and private-room content must not enter autonomous or unrelated external calls.

### 9. Add the complete test matrix

Every new catalog entry requires:

- catalog/registry contract tests for uniqueness, completeness, availability and generic-default invariants;
- strict router and verifier tests in `server/semanticRouter.test.ts`, including at least three languages or writing systems;
- a provider unit test covering success, malformed data, timeout, size/media limits, rate limits, caching and deduplication;
- an end-to-end Director test using the neutral invocation/resolution boundary;
- successful and failed grounding/reviewer tests in `server/lmStudio.test.ts`;
- source-publication and unknown-source rejection tests;
- a regression proving that a failed dedicated adapter does not call `web_search`;
- live semantic-evaluation cases in `scripts/semantic-router-live-eval.mjs`; and
- one private or isolated smoke path that does not pollute a public room.

The Director architecture suite parses its TypeScript AST and must continue to prove that no registered capability ID or provider helper appears in Director control flow. Public and DM integration tests must exercise the new adapter through the neutral registry boundary. If a new capability requires an `if (action === "new_id")` in the Director, the extension contract has failed.

### 10. Run validation and smoke checks

At minimum:

```bash
npm run typecheck
npm test
npm run build
npm run eval:semantics
```

Add and document a capability-specific smoke command when it exercises a real provider. The smoke path must verify the advertised inventory, one successful grounded resolution, source attachment, a temporary failure and absence of unintended fallback calls. Run it only with the required local model/provider services explicitly enabled.

## Example: major market benchmarks versus market news

“What is moving the market today?”, “why did tech fall?” or “find today's news about the car sector” is broad discovery or analysis. It should use `web_search` in `news` mode followed by bounded page expansion, or remain ordinary conversation when no fresh fact is requested. A market adapter must not take over merely because the room is `#stock-market` or the message resembles a ticker.

`market_snapshot` has the narrower authority to return latest provider-reported levels and previous-close changes for one canonical major benchmark or one fixed basket. The exact index catalog contains sixteen provider-neutral IDs across the Americas, Europe and Asia-Pacific; `GLOBAL_MAJOR`, `US_MAJOR`, `EUROPE_MAJOR` and `ASIA_MAJOR` expand to explicit immutable subsets of at most eight rows. This is major benchmark coverage, not an open symbol service and not support for every exchange, company, fund or security. Unknown, missing or semantically ambiguous targets fail closed.

The provider service—not the router or Director—validates provider identity, exact requested membership, catalog metadata, positive finite levels, recomputed previous-close change, exchange-local trading date, absolute observation/retrieval times, freshness and HTTPS source provenance. Stale rows cannot answer a current question. Baskets require enough usable coverage and expose missing members; the scene must say “latest reported”, preserve independent exchange timestamps and never infer market-open state, a shared session, news, causes, forecasts, advice or unsupported instruments. If an available `market_snapshot` invocation is selected and execution fails, it returns `failed_temporary`; the registry never retries it as `web_search`.

The bundled Yahoo chart adapter demonstrates the provider seam with fixed symbols, two fixed hosts, no redirects or arbitrary discovery, strict JSON validation and fail-closed behavior. It is experimental because the endpoint is undocumented and provides no stability, service-level or public-display guarantee. A public/production implementation must add a licensed provider whose terms explicitly allow the intended display or redistribution; changing provider precedence must not require catalog, router, registry-scene or Director branches.

Market news remains separate. `MarketPulseCoordinator` is a server-owned autonomous event source, not another semantic action: only fixed official Fed, ECB, SEC and Riksbank feed URLs may enter its bounded XML fetcher. New autonomous sources must follow the same pattern—trusted fixed configuration, narrow transport allowlist, strict parsing, freshness, persistent dedupe/high-water state, safe full-page expansion before prose evidence, independent enable/disable controls, Admin cadence gates and semantic publication review. They must never be added as a room-name conditional, keyword heuristic, model-supplied URL or execution fallback inside a turn capability.

## Definition of done

A capability is complete only when it can be enabled and disabled through trusted configuration, advertised by context, selected and verified multilingually, executed through the registry, resolved into bounded grounding or a bounded temporary failure, semantically reviewed for relevance and support, source-linked where required, privacy-documented and smoke-tested—without adding its ID to Director or semantic-router control-flow branches.
