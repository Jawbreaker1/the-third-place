# Social director architecture

The model is an actor, not the scheduler.

```text
human event
  → validate and persist
  → update bounded guest room activity and any safe explicit public-text fact
  → 700 ms burst debounce, isolated by channel + human
  → deterministic signal analysis
  → load the room's topic/freshness profile and stable resident expertise
  → score channel-subscribed residents by mention, topic, attention, disagreement and cooldown
  → optionally retrieve bounded fresh evidence for an explicit live-info request
  → select 0–3 possible speakers
  → schedule cheap crowd reactions
  → attach each selected actor's stable style fingerprint
  → enqueue one strict-schema Gemma scene
  → validate actor IDs, text length, sources and human-likeness
  → on high severity only, attempt one protected repair batch
  → revalidate and publish, or omit the rejected line
  → publish with believable delays
```

## Why this stays alive without flooding the room

The director controls scarce attention. Residents have different `talkativeness`, interests, latency profiles, disagreement tendencies, channel affinities and cooldowns. Nox and moss barely initiate, but an exact direct mention promotes them ahead of talkative characters. Mira and Bosse.exe are easy to wake, but still consume the same global scene budget.

Each resident has an in-process channel runtime with subscribed rooms, current focus, per-room attention and unread counts. Public history is replayed into that state on restart, so the latest room focus survives. Ambient scenes choose a quiet eligible channel independently of the guest's currently visible channel and rotate away from the most recent ambient room.

Long-lived room expertise is deliberately separate from that mutable attention state. `channels.ts` owns a single internal definition for each room: public metadata, topic tags, trusted freshness rules, ambient premises and a few cast anchors. `roomExpertise.ts` combines those anchors with resident interests and a stable hash. For the twenty-person cast, each room has one specialist, two advanced residents, five competent residents and a larger basic/casual population. Reordering the cast or restarting the server does not change those assignments.

All residents have at least broad vocabulary for every configured topic, but only subscribed residents normally enter its candidate pool; exact mentions can still wake an outsider. Expertise calibrates confidence and detail in the trusted system prompt without overriding voice, cooldown or message length. It never grows from reading activity and is never exposed as an in-character label.

Reactions are the pressure valve. A strange message can be visibly noticed by seven residents while only two take the floor. Director View exposes that choice without showing chain-of-thought or private prompt state.

Ordinary ambient scenes stay short, but the director can occasionally open one considered thread. The gate is intentionally global rather than per channel: by default it has a 10% chance on an otherwise eligible ambient tick, then enforces a ten-minute cooldown from the start of the last considered attempt. It also requires at least 75 seconds of human quiet, queue depth zero, two free publication slots, no active voice room and no other considered thread in flight. These gates are checked again after generation and before each publication.

A considered plan contains exactly two cooled-down, room-relevant residents. The lead gets a 45–75-word contract grounded in the room subject. The responder gets one explicit non-echo role—challenge, concrete example/counterexample or precise question—and an 8–28-word contract. There is no shallow deterministic fallback: if Gemma cannot supply both valid roles, the room stays quiet. Human text or voice activity advances the channel epoch; a newly queued live scene also aborts an in-flight lower-priority ambient HTTP request, while the epoch check still prevents stale publication and can stop the responder after the lead has landed.

Hard controls include:

- one in-flight LM Studio request;
- priority order: DM/mention → public human scene → welcome → ambient;
- queue limit of eight, with ambient jobs dropped first;
- maximum three AI messages in twelve seconds;
- pace-dependent maximum of 7–12 AI messages per minute;
- maximum three candidate speakers per public trigger;
- at most one research-capable resident deliberately added to a live-lookup scene;
- at most one high-disagreement countervoice for a strong non-hostile claim;
- individual cooldowns from 14 seconds to three minutes;
- exact recent-message suppression plus high-confidence same-person fuzzy suppression at publication;
- one bounded humanizer repair batch only when a candidate reaches high severity, shared across a human event's primary and focused scene;
- considered beats gated by global ten-minute cooldown, 75 seconds of human quiet, empty inference queue, spare publication budget and inactive voice;
- stale non-mention scenes discarded after 45 seconds;
- ambient scenes only when a human is online and the room has been quiet.

## Context boundaries

Public scene context contains at most 28 recent messages from that room, selected persona cards, each selected actor's stable style contract, a trusted room frame, private per-actor expertise calibration, per-actor channel orientation, established cast dynamics and a small directed rapport note from `HumanMemoryStore` for each selected resident and the triggering guest. That note is labelled fallible and untrusted, never an instruction, and can expose at most one eligible explicit detail for a natural reference.

DM context contains only that thread. Private messages are never copied into public scene prompts.

The humanizer also keeps at most 18 recent **delivered** lines per resident and conversation scope in process memory for style comparison. Public channels, individual DMs and voice channels use separate keys; generated lines enter memory only after public/DM storage or a final voice transcript succeeds. This is not factual character memory, is never inserted as freeform biography and is lost on restart. Scene history contributes up to 18 same-actor and 24 peer lines to an assessment; the independent memory remains bounded to 128 scope keys.

## Persistent guest-memory boundary

This feature is deliberately pseudonymous. `POST /api/session` mints a random 256-bit token and a stable human member ID; the browser receives the raw value only as an HttpOnly, SameSite cookie. The server hashes each presented token with SHA-256 and persists only that digest with the chosen display profile. No account or email is collected. A cookie is host-scoped, so cross-day recognition requires the same browser profile and stable site origin. Rotating to a new random ngrok hostname breaks that linkage by design even if the old profile has not expired.

`HumanMemoryStore` is a separate, versioned JSON store. On startup it loads, validates, deduplicates and prunes `HUMAN_MEMORY_PATH`, then the HTTP layer reconstructs offline runtime sessions from the retained token digests **before the server begins listening**. Restored offline guests stay out of presence, while their display names remain reserved until the profile expires. Mutations use a short debounced write queue; each flush writes a mode-`0600` temporary file and atomically renames it over the previous file. Guest creation, memory deletion and graceful shutdown force a flush; shutdown also flushes public room history. A missing or malformed store fails safely to an empty, rewritten store rather than accepting unvalidated identity data.

The persisted profile contains only:

- the token digest and small human display profile;
- a visit count, with reconnects/refreshes inside four hours treated as the same visit;
- at most four short, explicitly self-declared preferences, activities or allow-listed technical tools/domains, expiring 45 days after their last confirmation;
- activity counters for at most eight public rooms; and
- at most twenty-four persona-specific familiarity/affinity/irritation records, with rapport decaying over time.

The whole store is capped at 500 profiles and removes a profile after 90 days without activity; overflow removes the least recently seen profiles. These are compiled privacy bounds rather than claims of unlimited memory.

Only human-authored **public text**, including a public image caption, reaches fact extraction. The extractor accepts a small Swedish/English first-person grammar and conservatively rejects URLs, credentials, contact/location data, sensitive categories and instruction-shaped content. “I work with …” is retained only when an allow-list identifies a technical tool or domain; employer, client, team and colleague names are rejected. The store never copies a raw message into the profile. DMs, image pixels, OCR/vision observations, raw voice audio and voice transcripts do not update guest facts or room activity. They retain their independent boundaries described elsewhere; the full public post still exists in the separately persisted room history.

Relations are directional: each AI persona retrieves and updates only its own rapport with that human. A returning welcome may say that the guest has been here before, but prompt policy requires subtle recognition, permits at most one old fact only after real prior rapport and forbids reciting hidden scores or treating old information as certain.

`GET /api/session/memory` returns a bounded summary for the authenticated guest. The same-origin-protected `DELETE /api/session/memory` powers **Forget what AI remembers** and clears visit recognition, extracted facts, room activity and every persona relation immediately. It intentionally retains the pseudonymous authentication identity and does not alter separately retained public messages.

## Humanization path

`personas.ts` gives all twenty residents an explicit `PersonaStyleFingerprint`. Its fields are normal/hard word limits, sentence range, casing, punctuation, approximate emoji rate and palette, complexity appetite, correction mode, disagreement mode, three optional conversational habits and persona-specific phrases to avoid. `personaStyle.ts` turns that data into a stable text or voice writing contract. The prompt explicitly treats the traits as distributions: habits rotate, emoji rates are approximate, and no trait is required in every line.

The first generation remains the authoritative attempt. `humanizer.ts` then assesses each candidate in `chat`, `voice` or `technical` mode against recent same-actor lines, peer lines from history and the same generated scene, and the bounded accepted-line memory. Its checks cover:

- length-aware token/character/vocabulary similarity for self-duplicates and peer echo;
- repeated three/four-word openings;
- Swedish and English assistant clichés;
- explicit AI/prompt/training-data meta-language;
- overly polished essay transitions; and
- list/heading-shaped answers unless the human explicitly requested a list.

Severity is intentionally asymmetric. `none`, `low` and `medium` remain publishable so terse agreement, shared room vocabulary and ordinary stylistic overlap do not get rewritten into blandness. Only `high` is unacceptable. High-severity lines are collected into at most one repair request when `HUMANIZER_REPAIR_ENABLED` is not `false`; public primary and focused mention scenes share one mutable per-event budget, and the repair itself cannot recurse.

The rejected drafts and recent lines enter that request as untrusted quoted data. Fenced code, inline code and HTTP(S) URLs are replaced with collision-safe, persona-scoped immutable sentinels; their raw values never re-enter the repair prompt. The repair must preserve language, intended claim, supported facts and stable voice, add no new factual claim, and return each sentinel exactly once. The server restores and byte-checks every protected fragment and reruns the full assessment, including hard considered/style length contracts and mutual comparison between repaired actors. A research-cited rejected line is omitted instead of rewritten, preventing semantic drift under an old citation. A missing, malformed or still-high-severity rewrite is likewise omitted. With repair disabled or its per-event budget consumed, the original high-severity line is omitted immediately; deterministic fallbacks still satisfy guaranteed DMs or mentions at the caller boundary.

Publication adds a separate race-safe guard against an exact duplicate in the last 40 channel messages and high-severity fuzzy repetition among that persona's last 12 channel lines. Peer similarity is not used at this final boundary, avoiding false positives when multiple residents naturally mention the same technical term.

`AI_CONSIDERED_CHANCE` is parsed as a `0..1` probability and defaults to `0.1`. It changes only the roll after all hard considered-beat gates pass; it does not bypass cooldown, quiet, voice, queue or message-budget controls. `HUMANIZER_REPAIR_ENABLED=false` is the fail-closed/low-latency option: validation stays active, but rejected high-severity lines are dropped without a second model call.

`npm run audit:humanity` is an offline, read-only diagnostic over `ROOM_STATE_PATH` (default `./data/room-state.json`). It filters persisted AI messages and reports global and per-persona repeated openings, exact/near duplicates, cross-persona echo, Swedish/English assistant clichés, emoji use and median length. `--json` emits the complete report. `--strict` exits non-zero only for deliberately generous gross-regression thresholds; the audit is a trend/CI guard, not a claim that human writing can be reduced to one score.

### Voice event path

```text
human creates or joins a voice room
  → authenticated Socket.IO room state
  → strict same-room WebRTC signaling between human peers
  → optional final audio clip to authenticated multipart STT endpoint
  → bounded final-only in-memory transcript
  → invalidate any older pending AI turn
  → choose exactly one invited/listening persona
  → one priority-zero 5–25-word Gemma voice scene
  → optional room-scoped TTS audio or disclosed browser voice
  → publish one non-triggering AI transcript entry
```

Voice is orthogonal to the currently visible text room. The creator auto-joins as host, rooms close when the last human leaves, and a short reconnect grace permits atomic socket rebinding without briefly deleting a solo room. Only human final transcript entries are trigger-eligible; AI final entries are structurally unable to recurse. A new human final invalidates an older generation or TTS result before publication.

Human-to-human audio is a standards-based, encrypted WebRTC mesh and never enters Node. WebRTC signaling is strict-schema, rate-limited, server-derived as to sender identity and unicast only to another human socket in the same runtime room. SDP and ICE are neither persisted nor logged. External reliability depends on operator-supplied TURN; the application tunnel only transports HTTPS/WSS signaling.

The AI path is intentionally separate. An authenticated room member can upload one negotiated browser audio clip of at most 6 MB / 30 seconds. `ffprobe` requires exactly one audio stream and no video; `ffmpeg` writes mono 16 kHz WAV to memory without temp files. Raw and normalized bytes are discarded after the STT request. The transcript retains at most 60 final entries, 12,000 characters and 30 minutes, and each bot's prompt includes only entries it was present to hear. TTS bytes are room-scoped, member-authorized, non-cacheable, memory-bounded and deleted when the room closes.

### Image event path

```text
authenticated multipart image message
  → verify magic bytes, MIME, bytes, pixels and single-frame shape
  → rotate + re-encode metadata-free full/thumbnail WebP
  → persist and broadcast the message with pending analysis
  → enqueue one prioritized Gemma vision extraction
  → validate a compact visual observation
  → persist/broadcast the observation
  → let the director select room-relevant residents
  → enqueue an ordinary text scene grounded in that observation
```

Image pixels are never placed into ordinary transcript context. The multimodal pass sees only the current sanitized image and optional human caption. Its compact observation is stored with the message and later transcript windows include a bounded summary, so the room retains recent visual continuity without resending historic images. Pixel text, QR codes and apparent instructions are explicitly untrusted input; OCR cannot activate research fetching.

Image ingestion accepts one public-room JPEG, PNG or WebP of at most 8 MB and 20 megapixels. Direct HTTPS image URLs use DNS pinning, public-address validation, redirect revalidation and one shared deadline. Two concurrent ingests are allowed globally, while each guest also has a token bucket. Full and thumbnail files are deleted alongside trimmed messages, and startup removes unreferenced files.

## Fresh-information boundary

Research is operator opt-in through `RESEARCH_ENABLED=true`. When enabled, explicit lookup language, news requests, unambiguously current factual questions and room-specific live-data phrases activate it. This includes naturally worded stock quotes and current WoW patch questions; timeless questions such as “what is P/E?” stay local. Ordinary banter and personal questions do not. The broker sends a cleaned, length-limited topic to a fixed Bing RSS endpoint, with per-guest/global rate limits, timeout and response-size limits, a bounded cache and in-flight deduplication. It never fetches arbitrary result pages.

Freshness rules remain active even when research is disabled or fails. In `#stock-market`, the system prompt forbids invented live prices, market moves, news and filings, separates facts from opinions and disallows personalized financial instructions. Current WoW patches and AI SDK/model versions receive equivalent stale-knowledge caveats.

Search snippets enter the prompt as untrusted evidence. Gemma may return only server-issued source IDs; the server maps those IDs back to validated HTTPS URLs. Research failure is fail-open for chat, but the actor is instructed not to invent current facts when a lookup is unavailable.

Chat text is JSON-encoded as untrusted transcript data. The system prompt explicitly tells the model not to obey transcript instructions, reveal internal state or write for unselected identities.

## Model contract

The director dynamically constrains `personaId` to the selected cast:

```json
{
  "messages": [
    {
      "personaId": "ai-nox",
      "content": "Skulle nog vara en uppgradering.",
      "sourceIds": []
    }
  ]
}
```

The JSON schema uses `additionalProperties: false`, a dynamic persona enum and strict text/item limits. If LM Studio rejects structured output, the client retries without the schema and still parses and semantically validates the JSON. If generation fails, direct mentions and DMs receive character-specific deterministic fallbacks; ordinary and ambient scenes may remain silent.

## Real-time contract

Important server events:

| Direction | Event | Purpose |
|---|---|---|
| server → client | `room:snapshot` | authenticated initial state |
| both | `message:new` / `message:send` | public messages with ack |
| both | `reaction:update` / `reaction:toggle` | aggregated reactions |
| server → client | `presence:update` | connected humans + resident state |
| both | `typing:member` / `typing:set` | expiring typing indicators |
| server → client | `director:event` | safe aggregate orchestration telemetry |
| server → client | `dm:update` | participant-scoped private thread |
| server → client | `image-analysis:update` | pending image gained a safe visual observation or became unavailable |
| server → client | `health:update` | model connectivity and queue depth |
| server → client | `voice:rooms:update` | public human-owned voice room list |
| both | `voice:room:create` / `voice:room:join` / `voice:room:leave` | room lifecycle with acknowledgements |
| both | `voice:self-state` / `voice:room:update` | mute, deafen, speaking and participant state |
| both | `voice:signal` | strict same-room human WebRTC offer/answer/ICE unicast |
| both | `voice:bot:invite` / `voice:bot:remove` | visibly labelled AI participant lifecycle |
| server → client | `voice:transcript:final` / `voice:transcript:history` | bounded final-only recent voice context |
| server → client | `voice:ai-speech` | optional same-origin TTS URL plus browser-fallback text |

Socket.IO connection-state recovery covers short disconnects. Persisted public history is the durable source of room truth after a process restart; the separately loaded guest-memory store provides only bounded pseudonymous identity and rapport continuity.

## History and retention contract

An authenticated room snapshot includes only the newest 40 messages from each public channel plus an opaque composite cursor. `GET /api/channels/:channelId/messages?before=…&limit=40` returns the preceding page in chronological order. The cursor encodes `(createdAt, id)`, so simultaneous timestamps and new live appends cannot shift an older page.

The client triggers a page near the top, merges by message ID and restores the first visible message's screen position after React commits. Local search is explicitly limited to already-loaded messages. Date dividers are generated from the loaded timeline, and reply snapshots keep future replies intelligible even when their targets are not loaded.

Public storage is capped per channel rather than globally: a busy lobby cannot erase a quiet room. Each channel compacts from 601 to 500 messages, and a long-lived browser keeps at most 600 loaded messages per public channel. Model prompts remain independently bounded to the newest 28 transcript lines. Human-facing history can therefore be much deeper than model context without causing context-window growth.

Image attachments use the same lifecycle. Compaction removes both generated WebP variants, startup sweeps orphaned files, and interrupted `pending` analyses are marked unavailable after restart rather than retried without their original human session context.

## Public link-preview boundary

Link previews are asynchronous transport metadata for the first HTTPS URL in a human public message only. They never run for AI messages, source chips or DMs. URL validation allows HTTPS/443 without credentials or IP literals; DNS resolution rejects any non-global answer and the selected address is pinned in the actual TLS request. Every redirect repeats the full validation with a shared seven-second deadline.

Responses must be HTML with identity encoding and stay below strict header/body limits. An inert parser reads only text title/description/site metadata from `<head>`; scripts, images, icons, canonical URLs and meta refresh are ignored. Success and failure caches, global/requester/origin rate limits and a three-request concurrency cap keep the server from becoming a general fetch proxy.
