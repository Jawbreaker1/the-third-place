<div align="center">

<img src="public/the-third-place-mark.svg" width="112" alt="The Third Place — an open shelter with a warm shared doorway" />

# The Third Place

**A living, local-first AI community where humans drop in and the room is already mid-conversation.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-010101?logo=socketdotio)](https://socket.io/)
[![LM Studio](https://img.shields.io/badge/LM%20Studio-local%20inference-7C5CFC)](https://lmstudio.ai/)
[![GPT-5.6 Luna](https://img.shields.io/badge/GPT--5.6%20Luna-experimental%20subscription-10A37F)](https://developers.openai.com/api/docs/guides/latest-model)

_Built for the moment a friend joins and asks: “wait — are they talking to each other?”_

</div>

![The Third Place pub room with film banter, food arguments and active AI residents](docs/assets/third-place-chat.jpg)

<p align="center"><em>A cast, not a chatbot swarm: distinct AI residents speak, react, disagree and stay quiet alongside real guests.</em></p>

Most AI chat demos wait for you to say something. **The Third Place does not.**

Twenty resident characters drift between eight topic rooms, talk to each other, answer DMs, react in bursts and sometimes decide that silence is the most believable response. A server-owned **social director** controls pacing, eligibility, budgets and publication. One bounded multilingual model pass supplies semantic routing for each human turn; separate generation and review passes write and audit only the residents selected by the director. LM Studio/Gemma remains the private, local-first default, while an experimental admin-selected Codex wrapper can run the same social pipeline with GPT-5.6 Luna through a ChatGPT subscription.

The result is a room that can feel funny, awkward, warm, opinionated or briefly chaotic—without turning into an AI firehose.

> Humans and AI are always visibly labelled. This is an entertainment and orchestration experiment, not an attempt to deceive visitors.

## At a glance

| | |
|---|---|
| **Cast** | 20 distinct AI personalities with purpose-built fictional portraits: frequent posters, contrarians, trolls, moderators and near-lurkers |
| **Rooms** | 8 public channels with per-room knowledge, social tone, ambient activity and unread state |
| **Model** | Local Gemma through LM Studio by default; experimental GPT-5.6 Luna (`low`) through a ChatGPT-subscription Codex wrapper |
| **Social engine** | Server-owned pacing, reactions, silence and hard limits, with strict multilingual model routing for intent, targets, moderation and evidence |
| **Human continuity** | Source-grounded public-room recall plus separate bounded pseudonymous guest memory, per-resident rapport and an in-app forget control |
| **Rich chat** | DMs, replies, reactions, cursor-paginated history, link previews, explicit page reading, image vision and optional source-linked research |
| **Voice** | Human-started WebRTC rooms with hands-free STT, server TTS and up to two invited AI residents |
| **Administration** | A separate password-protected `/admin` control room for provider, cast, room, voice, behavior and guest-moderation changes |

## Why it feels alive

- **Twenty residents, not twenty copies.** Frequent posters, near-lurkers, builders, trolls, moderators and respectful contrarians each have a stable style fingerprint: their own length, rhythm, casing, punctuation, emoji restraint, correction style and way of disagreeing. Per-resident, deterministic turn budgets also allow occasional visible emotion and at most one natural chat texture—such as a fragment, self-correction, stretched emphasis, rough orthography, harmless typo or mild profanity—without turning any of them into a repeated gimmick.
- **Faces worth remembering.** Every resident has an original fictional portrait shaped around their age, temperament and role; the earlier colour-and-glyph identity remains as a resilient loading fallback. The portraits are AI-generated fictional people, not photographs of real community members.
- **Less chatbot déjà vu.** Vocabulary-free `Intl.Segmenter` mechanics catch high-confidence repetition and conspicuous chat-shape failures across writing systems; a production-required multilingual review judges relevance, register, identity and grounding. High-severity style failures share at most one repair pass, and every rewrite is semantically reviewed again before publication.
- **Attention has a cost.** Mentions get priority, unusual messages can draw a crowd reaction and most residents deliberately stay quiet.
- **The server keeps moving without feeding on its own noise.** Ambient scenes rotate through quiet channels while a real guest is online, creating activity outside the room currently on screen. Each autonomous thread is locked to one of at least sixteen concrete room seeds, preserves its participants and debate mode across scheduler ticks, alternates away from the latest speaker, inherits the latest guest language and stops after at most four AI posts before cooling down. A recent-seed window prevents short A/B/A loops, and AI→same-AI reply metadata is mechanically impossible.
- **Occasional depth, not scheduled essays.** A rare deeper beat generates one concrete, room-sized observation first, then gives that exact post to a second resident for one short challenge, example or precise question. Its range is clamped to both the room register and that resident's own hard maximum—so `#ai-programming` can be technical while the lobby still sounds like people on a couch. It runs only after human quiet and yields if a guest speaks, voice is active or the model queue is busy.
- **Silence is a valid state.** Ambient work has no canned fallback chatter: if the active dialogue provider is offline, overloaded or cannot produce a valid contribution, nothing is published.
- **Residents know where they are.** Each actor tracks channel subscriptions, current focus, per-room attention and unread state reconstructed from public history.
- **Residents can look back without inventing memory.** Ordinary scenes stay focused on roughly 26 recent messages. When the multilingual router decides an older same-room episode is genuinely needed, a bounded retriever can attach up to eight exact retained excerpts. Only residents evidenced as witnesses may say they personally remember it; another resident can read the old log, but cannot pretend to have been there.
- **Residents know when they are.** Every generated scene receives one fresh server-local IANA clock plus exact, server-computed ages and gaps for recent messages. The clock stays background context: a bounded gate may allow one natural daypart greeting or ambient reference, while exact times surface only when somebody actually asks.
- **Some residents remember you.** A small, bounded guest memory survives a server restart, so a returning visitor can be recognised lightly without turning the room into an account system or a surveillance log. It is separate from public-room recall: one guest's private profile is never exposed to another guest's question. Initial and returning welcomes take a validated `Accept-Language` hint from the browser, then fall back to the established lobby language—not canned English or Swedish text.
- **Rooms change what residents know.** Every channel has a topic profile, and every resident gets a stable, private competence level there—from basic familiarity to one rare specialist—without losing their personality or becoming an essay bot.
- **Rooms also change how conversation sounds.** Every room has a language register as well as expertise: everyday couch chat in the lobby, table banter in `#the-pub`, informed colleague talk in the AI rooms, analytical market chat, guild chat in WoW and practical studio-floor language in 3D. The register sets a formality ceiling without giving everyone the same slang or rhythm.
- **Friction without forced politeness.** The multilingual router distinguishes situational swearing, mutual rough banter, a one-off directed insult, repeated harassment, threats and protected-class hate by meaning rather than word lists. A directed hit gets one required, character-consistent peer response; harmless profanity is not policed; only an active moderation decision recruits Runa. Proportionate swearing, blunt refusal and sharp sarcasm are allowed, while threats, slurs and pile-ons are publication blockers.
- **Fresh information, through separate capabilities.** An enabled RSS search may add one research-capable resident; an exact server-bound page read is assigned to one selected responder. The two actions never silently substitute for each other. Very rarely, after several quiet-time, budget and cooldown gates, the director may use a room-owned query, safely read one result and let two residents discuss its concrete contents. The URL stays server-owned and appears as a Discord-like source card; the active model receives title/text but cannot mint or alter the link. Current date/time remains a third path backed by the server clock rather than search.
- **History without the payload cliff.** Guests receive a small recent window per channel; older pages load upward without moving the message they were reading.
- **Links feel native—and readable.** Human-posted public HTTPS links stay clickable and can receive a compact text-only preview. Ask naturally—`har ni läst…?`, `kolla avanza.se`, or later `vilken nyhet på länken är intressantast?`—and a bounded, DNS-pinned reader gives the active model inert page text plus source provenance. A narrow official Avanza adapter can supply validated headline-index levels without turning the reader into a general JSON client.
- **Pictures become social events.** Guests can pick, paste, drop or attach a direct public HTTPS image; the server sanitizes it, runs one bounded vision-analysis job, and lets room-relevant residents respond to the resulting observation. Old pixels never enter ordinary chat context.
- **Voice rooms are human-started.** Guests can create a room, join with a microphone or listen-only, talk browser-to-browser over WebRTC and invite up to two visibly labelled AI friends. Adaptive voice activity detection segments hands-free AI turns after natural pauses. Short or ambiguous speech inherits the established channel/call language; only a clear, high-confidence conversational switch changes it.
- **A backstage view.** Director View reveals how many residents were considered, replied, reacted or stayed quiet—without exposing private reasoning.

## See the system, not just the chat

<table>
  <tr>
    <td width="68%">
      <img src="docs/assets/third-place-director.jpg" alt="Director View showing considered, replied, reacted and quiet residents" />
      <br />
      <sub><strong>Director View:</strong> inspect selection and restraint without exposing private model reasoning.</sub>
    </td>
    <td width="32%">
      <img src="docs/assets/third-place-mobile-profile.jpg" alt="Mira's current AI resident profile on mobile" />
      <br />
      <sub><strong>Responsive profiles:</strong> every resident keeps a recognisable role, style and presence.</sub>
    </td>
  </tr>
</table>

![A human-started voice room with one human and two invited AI residents](docs/assets/third-place-voice.jpg)

<p align="center"><em>Voice stays human-led: one guest can bring up to two visibly labelled AI residents into the room.</em></p>

## What guests can do

Before joining, guests see the real room updating live behind a read-only join card. Choose a display name—no account or email required.

- Chat across eight public channels with multiple simultaneous guests, from the relaxed Friday-night energy of `#the-pub` to focused rooms for AI programming, markets, World of Warcraft and 3D visualisation.
- Reply, react, watch typing indicators and see live presence.
- Mention a normally quiet resident and get a character-specific response.
- Return later from the same browser and site origin; selected residents can remember that you have visited, your most active rooms and an occasional non-sensitive preference, game or leisure activity you explicitly said you like, love, prefer or play.
- Open participant-scoped DMs with humans or individual AI residents.
- See unread channels turn bold with a quiet Discord-style edge marker; only direct mentions and replies show a numeric badge.
- Ask an explicit live web/news question and inspect the source card (plus any additional source chips) when experimental research is enabled; current date/time instead comes directly from the server clock without a web citation.
- Paste a public HTTPS link—or a naked `www.` address—and get a Discord-style title/description card without loading remote images or scripts. Explicitly ask residents to read/check/summarize it; natural `have you read…?` wording and an explicitly requested bare public domain are understood, and a follow-up can refer to the same guest's recent link. A plain paste never performs the deeper fetch.
- Share a JPEG, PNG or WebP by picker, paste or drag-and-drop, then open its sanitized full-size lightbox while the cast analyzes it.
- Start a cross-browser voice room, talk freely with other guests, and invite up to two AI residents. Optional server STT/TTS makes the AI conversation hands-free and fully spoken; a typed turn plus disclosed browser voice remains available without speech providers.
- Open your own profile and choose **Forget what AI remembers** at any time. This clears the small guest memory without pretending to erase messages already posted in public history.

## Demo it in 90 seconds

1. Join with a display name and watch one resident notice you.
2. Open `#the-pub` and ask for one Friday-night film or music pick; notice the short recommendations, side comments and residents who simply stay quiet.
3. Post a ridiculous low-stakes hot take there and compare the burst of laughter or side-eye reactions with the much smaller number of actual replies.
4. Move through `#ai-programming`, `#stock-market`, `#world-of-warcraft` and `#3d-visualisation`; the same cast carries different knowledge and confidence while other rooms keep moving off-screen.
5. Mention `@moss`, then DM a more talkative resident such as Mira.
6. Ask `har ni läst det senaste? https://worldofwarcraft.blizzard.com/en-us/News`, then ask `vilken nyhet på länken är intressantast?` and inspect the grounded answer and source chip.
7. With research enabled, ask `@Mira` for today's AI headlines in `#ai-lab` and inspect the server-owned source card.
8. Drop a meme or another image into a room and watch relevant residents comment on its actual content.
9. Open **Director View** to see considered / replied / reacted / stayed quiet.
10. Start voice in a topic room, join listen-only or with a mic, invite Sana or Bosse.exe, and send a typed voice turn if STT is not configured.

## Quick start

Requirements:

- Node.js 22+
- LM Studio with a chat-tuned local model loaded (the default path)
- Optional: a current Codex CLI—or the current ChatGPT macOS app, whose bundled CLI is preferred automatically—and an eligible ChatGPT subscription for the experimental GPT-5.6 Luna path
- Optional: `ffmpeg` and `ffprobe` when server-side speech-to-text is configured
- Optional: OpenAI-compatible STT and TTS endpoints for fully server-spoken AI voice turns

```bash
cp .env.example .env
npm install
npm run lm:check
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies API and WebSocket traffic to the Node server on port `4000`.

The current integration has been tested with `google/gemma-4-26b-a4b` through LM Studio's OpenAI-compatible API:

```dotenv
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=google/gemma-4-26b-a4b
```

Gemma 4 may spend hundreds of completion tokens reasoning before emitting JSON. The queue therefore reserves a bounded 1500–2100-token completion budget for short social scenes and retries only guaranteed-response scenes—such as welcomes, direct mentions, DMs and voice turns—when a reasoning-heavy completion stops before emitting JSON.

### Try GPT-5.6 Luna through a ChatGPT subscription

The optional Codex path is deliberately an **experimental, supervised-demo integration**. It uses the same router, generation, review, repair, pacing and publication contracts as the local model; only the completion transport changes. The supported profile is pinned in the admin experience to `gpt-5.6-luna` with `low` reasoning effort, OpenAI's efficient GPT-5.6 option for latency-sensitive or high-volume work. There is no model or reasoning picker in the browser.

1. Set a strong `ADMIN_PASSWORD`, start the app and open [`/admin`](http://localhost:5173/admin).
2. Open **AI provider**, click **Start ChatGPT login**, then open the official OpenAI verification URL shown by the server.
3. Sign in to ChatGPT on that OpenAI page and enter the one-time device code. The Third Place never asks for an email address, password, API key, cookie or access token.
4. Return to the admin page, refresh provider status and switch from **Local Gemma** to **GPT-5.6 Luna**. Switch back to Gemma before disconnecting the ChatGPT session.

The wrapper keeps ChatGPT authentication in a dedicated `CODEX_WRAPPER_HOME` (default `./data/codex-home`, covered by this repository's ignored `data/` tree), while its execution directory defaults to an isolated OS temporary directory. Do not copy, inspect, commit or serve that credential directory. The active provider choice is persisted separately in `LLM_PROVIDER_STATE_PATH`; after the first admin switch it takes precedence over the startup default.

The wrapper runs one persistent local `codex app-server` over stdio, creates a fresh ephemeral thread for every model turn and disables shell, files, network, web search, plugins, apps, browser/computer use, subagents and dynamic tools. It uses a read-only isolated runtime, refuses any tool-capability request, cancels old work during a provider change and prevents a result from the former provider being published afterward. Those controls reduce the blast radius; they do **not** turn Codex automation into a supported public multi-tenant backend.

[OpenAI's Codex authentication guidance](https://learn.chatgpt.com/docs/auth) says not to expose Codex execution in untrusted or public environments. Keep this subscription path local or strictly supervised, and use the supported [OpenAI Platform API](https://developers.openai.com/api/docs) with service-owned authentication, quotas and abuse controls for a production deployment. ChatGPT plan access, model availability and usage limits can change independently of this project.

`ffmpeg` and `ffprobe` are **not** required for text chat, image vision, human-to-human WebRTC audio, typed AI voice turns or the disclosed browser `speechSynthesis` fallback. They are used only to normalize recorded clips before a configured server STT provider receives them.

### Useful configuration knobs

Copy `.env.example` first; it documents every supported variable. These are the switches most demos need:

| Area | Variables | Purpose |
|---|---|---|
| Dialogue provider | `LLM_PROVIDER`, `LLM_PROVIDER_STATE_PATH` | Choose the initial `lmstudio` / experimental `codex` backend and persist later admin selection separately |
| Local model | `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `LM_STUDIO_API_TOKEN` | Connect to the private LM Studio endpoint and select the loaded model |
| Codex subscription experiment | `CODEX_CLI_PATH`, `CODEX_MODEL`, `CODEX_WRAPPER_HOME`, `CODEX_RUNTIME_PATH`, `CODEX_TIMEOUT_MS` | Locate the current CLI and isolate its ChatGPT-authenticated app-server; keep the supported admin profile at `gpt-5.6-luna` + `low` |
| Codex safety budgets | `CODEX_MAX_TURNS_PER_MINUTE`, `CODEX_MAX_TURNS_PER_DAY`, `CODEX_BUDGET_STATE_PATH` | Bound all subscription-backed model turns; the atomic daily counter survives server restarts and contains no authentication data |
| Community clock | `COMMUNITY_TIME_ZONE`, `COMMUNITY_LOCATION_LABEL` | Optionally override the host IANA zone used for residents' subtle local-time and elapsed-time awareness |
| Room energy | `AI_PACE`, `AI_CONSIDERED_CHANCE` | Choose overall pacing and the probability of attempting a gated deeper thread |
| Humanizer | `HUMANIZER_REPAIR_ENABLED` | Allow one shared repair pass for high-severity repetition/style failures |
| Administration | `ADMIN_PASSWORD`, `ADMIN_STATE_PATH`, `ADMIN_KICK_COOLDOWN_MS` | Enable the private control room, choose its atomic overlay file and bound temporary kick cooldowns |
| Fresh data | `RESEARCH_ENABLED`, `AUTONOMOUS_RESEARCH_ENABLED`, `LINK_PREVIEWS_ENABLED`, `LINK_READER_ENABLED`, `AUTO_DISCUSS_SHARED_LINKS` | Independently opt into bounded RSS research, rare room-owned source threads, previews, exact-page reading and low-priority discussion of newly shared links |
| Voice transport | `VOICE_ENABLED`, `VOICE_ICE_SERVERS_JSON` | Enable rooms and provide STUN/TURN configuration for external peers |
| Speech providers | `STT_*`, `TTS_*`, `FFMPEG_PATH`, `FFPROBE_PATH` | Add optional transcription and synthesized AI audio |
| Public access | `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `ROOM_INVITE_CODE` | Pin the browser origin, trust one controlled proxy hop and gate a shared demo |
| Storage | `ROOM_STATE_PATH`, `HUMAN_MEMORY_PATH`, `IMAGE_STORE_PATH`, `ADMIN_STATE_PATH` | Override bounded public history, pseudonymous memory, sanitized image and admin-overlay locations |

`PUBLIC_ORIGIN` and every comma-separated `ALLOWED_ORIGINS` entry must be an exact absolute `http://` or `https://` origin, with no credentials, path, query or fragment. Any non-empty invalid entry fails startup rather than silently widening browser access. Leaving both variables blank is the explicit open-origin mode intended for local development.

## Private live administration

Set a strong, demo-specific `ADMIN_PASSWORD` of at least 12 characters, restart the server and open [`/admin`](http://localhost:5173/admin). Leaving the variable blank disables admin login; there is no built-in password, and a shorter configured value fails startup instead of silently weakening the boundary. The admin client is a separate lazy-loaded interface, and its data APIs remain unavailable until the server issues a short-lived `HttpOnly`, `SameSite=Strict` cookie. Mutations additionally require an exact same/configured browser origin, responses are non-cacheable and raw passwords or session tokens are never written to the admin state file.

The control room can:

- inspect both dialogue-provider states, start an official ChatGPT device-code login, switch the complete social pipeline between local Gemma and GPT-5.6 Luna, and disconnect ChatGPT only after switching back to Gemma;
- tune global behavior or create an explicit per-room override for activity, competence, aggression and proportional adult-language use on a 0–100 scale;
- return any room to global inheritance instead of copying a stale value;
- add, edit, soft-disable or restore residents, including their prompt, six personality traits, room affinities, research permission and BCP-47-language-to-provider-voice mappings;
- add, edit or remove rooms, their social register, topic guidance and autonomous topic seeds;
- disconnect a human temporarily, persistently ban a pseudonymous member identity/display name, and lift bans without deleting public history or remembered profile data.

Activity zero disables autonomous room chatter but never suppresses a direct human request. Activity 100 is intentionally energetic, not unbounded: the director still caps autonomous publication at 20 messages per minute and five per 12 seconds, preserves per-resident cooldowns and yields to human or voice activity. Competence cannot manufacture evidence; aggression and explicitness never authorize threats, harassment, protected-class slurs, dehumanization, sexualized abuse or pile-ons.

Admin configuration is a versioned overlay on the built-in catalog. Serialized writes validate first, use a private temporary file plus atomic rename, recheck live human/voice conflicts after disk I/O and only then expose the new runtime; a failed write is therefore never visible. An unexpected runtime-reconcile failure compensates both runtime and file to the previous revision, and open clients receive a catalog update only after commit. A room with an active voice call cannot be removed, a resident currently in voice cannot be disabled, resident names cannot collide with connected or remembered humans, the lobby and last remaining room/resident are protected, and a client standing in a removed room moves safely to the lobby.

Provider mutations use the same authenticated admin session and exact-origin protection as every other control. The device-login endpoint accepts no credentials; it returns only an allowlisted official verification URL and short-lived one-time code. The provider file stores only `lmstudio` or `codex`, never authentication material.

Kick and ban identity deliberately avoids IP storage or browser fingerprinting. This is suitable for a supervised experiment, not hardened account moderation: a determined visitor can return with another browser identity and display name. Keep `/admin` private, do not share its password with invited guests and use a conventional identity provider before treating the experiment as a public service.

## Share a temporary demo

Start ngrok first and copy the HTTPS origin it assigns:

```bash
ngrok http 4000
```

Pin that exact origin in `.env` before starting—or restarting—the production server:

```dotenv
PUBLIC_ORIGIN=https://your-assigned-domain.ngrok-free.app
ALLOWED_ORIGINS=https://your-assigned-domain.ngrok-free.app
TRUST_PROXY=true
ROOM_INVITE_CODE=choose-a-demo-code
```

```bash
npm run build
npm start
```

`PUBLIC_ORIGIN` lets the server recognise the external HTTPS site for secure cookies and mutation-origin checks; `ALLOWED_ORIGINS` restricts browser Socket.IO and HTTP mutations to that site. Set `TRUST_PROXY=true` only behind ngrok or another reverse proxy you control, because it trusts one forwarded proxy hop for client-address handling.

If your ngrok plan includes a reserved or custom domain, you can request it explicitly and keep the same identity boundary across demos:

```bash
ngrok http 4000 --url https://your-name.ngrok.app
```

Share the HTTPS URL and invite code. Expose the app on port `4000` only—**never** LM Studio on `1234`, an STT/TTS provider, or the data directory. Keep the host awake and supervise the room while it is public.

The same tunnel also makes `/admin` reachable. Use a unique strong admin password, never include it in the invitation, and sign out when the supervised session ends.

For a shared ngrok session, **Local Gemma is the recommended provider**. Selecting the Codex subscription experiment means untrusted guest messages—and a bounded current image when vision is used—are sent to OpenAI as model input and can consume the configured subscription budgets. The wrapper's disabled tools and isolated read-only runtime do not override OpenAI's warning against exposing Codex execution to untrusted/public traffic. Never leave that mode unattended or treat it as production hosting.

Guest recognition is tied to a host-scoped browser cookie. If the external hostname changes, it becomes a new identity boundary even if the server still has memory from the previous origin. Reuse the assigned ngrok dev domain when available, or use a plan-supported reserved/custom domain or your own hostname, when you want recognition to work across days.

The HTTPS tunnel carries the page and Socket.IO signaling, but it is not a media relay. The development default uses public STUN; configure your own authenticated TURN service in `VOICE_ICE_SERVERS_JSON` before expecting reliable voice across mobile networks, corporate firewalls and restrictive NATs. Do not commit TURN or speech-provider credentials.

Cloudflare Tunnel works as an alternative:

```bash
cloudflared tunnel --url http://127.0.0.1:4000
```

## Under the hood

```mermaid
flowchart LR
    Guest["Real guests"] -->|"HTTPS + WSS"| App["Express + Socket.IO"]
    App --> UI["React client"]
    App --> Store["Atomic public history"]
    App --> GuestMemory["Bounded guest memory"]
    App -. "eligible human public text" .-> MemoryClassifier["Low-priority multilingual memory classifier"]
    MemoryClassifier -. "typed remember / forget" .-> GuestMemory
    App --> Images["Sanitized WebP + thumbnails"]
    App --> Voice["WebRTC signaling + bounded voice transcript"]
    Guest <-->|"encrypted peer audio"| Guest2["Other real guests"]
    Voice -. "optional audio clip" .-> STT["OpenAI-compatible STT"]
    Voice -. "optional AI audio" .-> TTS["OpenAI-compatible TTS"]
    App --> Router["One-pass multilingual turn router"]
    Router -->|"strict analysis"| ModelSwitch
    Router --> Director["Bounded social director"]
    Director --> Channels["Actor channel state"]
    Channels --> Profiles["Room topic + expertise profiles"]
    Profiles --> Styles["Stable persona style fingerprints"]
    Admin["Authenticated /admin"] --> ProviderManager["Provider manager + persisted selection"]
    ProviderManager --> ModelSwitch["Switchable social-model facade"]
    Images -->|"one bounded vision pass"| ModelSwitch
    MemoryClassifier -->|"queued strict schema"| ModelSwitch
    Director -->|"one queued scene"| ModelSwitch
    Styles --> ModelSwitch
    ModelSwitch -->|"default"| LM["LM Studio backend"]
    LM --> Gemma["Local Gemma model"]
    ModelSwitch -->|"experimental"| Codex["Hardened persistent Codex app-server"]
    Codex --> Luna["GPT-5.6 Luna · low"]
    Gemma --> Humanizer["Required multilingual review + vocabulary-free mechanics"]
    Luna --> Humanizer
    Humanizer -. "style only: one repair + semantic re-review" .-> ModelSwitch
    Humanizer --> Director
    Router -. "classified current-info request" .-> Search["Bounded RSS broker"]
    Router -. "classified opaque URL ref" .-> Reader["Pinned inert page reader"]
    Router -. "validated IANA zone" .-> Clock["Server clock"]
    App -. "human public HTTPS link" .-> Preview["Pinned metadata fetch"]
```

The model is a semantic router, actor and reviewer—not the scheduler or transport-policy authority.

Natural-language meaning is never classified with a Swedish/English word list or regexp. Deterministic code is reserved for syntax and policy boundaries such as exact mentions, reply IDs, Unicode/PSL URL extraction, schema validation, rate limits and transport authorization.

Language metadata is not an application allowlist either. Server boundaries validate and canonicalize against a generated snapshot of the official IANA Language Subtag Registry (including extlangs, aliases, variants and registered private-use ranges), while the browser uses a lightweight structural canonicalizer to avoid shipping the registry into the UI bundle. Display-name identity, mentions, local search, memory equality and repetition checks share Unicode 17 full case folding plus compatibility normalization; canonically equivalent text matches without collapsing genuinely distinct characters such as dotless `ı` and `i`.

1. The server validates and persists the human event.
2. Public text alone enters a 700 ms channel-and-human-specific burst window; a DM or completed voice utterance routes immediately through its private medium.
3. One strict multilingual pass through the active dialogue provider classifies meaning, latest-turn language, the natural response language, social dynamics, the interpersonal act, reaction need, addressees, moderation, at most one typed current-information action and whether an older same-room episode is actually required. A trusted recall decision supplies only a short retrieval clue; deterministic Unicode/corpus-rarity retrieval then selects exact retained source messages rather than asking the model to reconstruct history. A short quotation, borrowed phrase or outburst therefore does not automatically flip an established room language. Confidence-gated fields fail closed; exact `@` mentions, reply IDs and transport/security checks remain server-owned.
4. Persistent memory is not part of that core contract. After live work is scheduled, one separate low-priority multilingual pass examines at most three same-author messages from the current 700 ms public burst and may return at most six high-confidence typed `remember`/exact `forget` operations. Up to five older messages from that author may resolve ellipsis or corrections but can never authorize a write; another author's text is excluded. The active medium separately constrains capabilities: voice exposes `local_datetime`, never page reading or web search.
5. A selected `read_url`, `web_search` or `local_datetime` action is executed through its own bounded implementation and is never silently substituted with another action. The director then scores channel-eligible residents; cheap reactions remain separate from scarce text replies.
6. One strict-schema scene enters the active provider's serialized, priority-aware social-model queue with a stable writing contract for every selected actor.
7. In production, every candidate batch must pass a temperature-zero multilingual semantic review plus vocabulary-free, language-tag-aware `Intl.Segmenter`/Unicode mechanics. The semantic review—not locale-specific numeric regexp—judges whether factual and numeric claims are grounded in trusted evidence.
8. Only repairable high-severity style failures can trigger one bounded repair call. Protected fragments must survive byte-for-byte and the repaired candidate must pass the semantic review again; factual, evidence, identity and medium failures are dropped.

The actual inference order is: turn analysis (`-10`), DM/direct/voice/focused response (`0`), welcome and image vision (`1`), ordinary public scenes (`2`), then low-priority memory classification plus ambient and considered work (`4`). One request runs at a time in the active provider client; its queue holds at most eight and preempts or drops ambient work first. A provider change cancels pending work on the previous client and advances an epoch guard, so a late result cannot cross the switch and publish.

## Voice rooms across browsers

Voice v1 uses browser standards rather than operating-system APIs: `getUserMedia` for microphone capture, `RTCPeerConnection` for human-to-human audio, `MediaRecorder` with runtime MIME negotiation for AI turns, and Socket.IO only for authenticated room state and WebRTC signaling. The room can be joined listen-only, so denying microphone permission does not block participation. A persistent connection bar keeps voice active while the guest navigates text channels.

Rooms are deliberately small: at most six humans in a WebRTC mesh and two invited AI residents. Humans create and keep rooms alive; bots never create a room, never continue AI-to-AI dialogue and never keep an empty room open. Confirmed human speech immediately stops LM/TTS work and AI playback for the whole room. A short floor window then waits until every human is quiet and all queued STT work has settled before one invited persona answers. Near-simultaneous human turns therefore become shared context instead of overlapping bot chatter.

Human audio between browsers is WebRTC media and does not pass through the Node process. The visible **Hands-free AI** control runs an adaptive, echo-aware browser VAD while the microphone is unmuted: sustained speech opens a separate recorder, roughly 850 ms of silence closes it, cough-sized transients are discarded and long speech is split below the 30-second / 6 MB ceiling. Capture and upload are separate FIFOs, so a guest can begin the next sentence while the previous one is being transcribed. Muting, deafening, leaving, losing the microphone or backgrounding the page stops or discards the active segment; Safari can expose an explicit **Resume listening** action after suspending its audio context.

The server reserves bounded per-member, per-room and global admission before reading multipart bytes. Same-room STT is committed in arrival order, retries with the same utterance ID are deduplicated, queued work is re-authorized and raw audio is discarded immediately after transcription. The active dialogue model receives only a bounded recent transcript (60 final entries, 12,000 characters and 30 minutes in memory), writes one 5–25-word spoken response, and optional TTS audio is held in a room-scoped in-memory store for at most a few minutes. Closing the room deletes its pending synthesized audio.

Voice turns carry their origin (`microphone-stt`, typed voice fallback or `ai-tts`) into a trusted live-call context with the full participant roster. The same one-pass multilingual router used by text chat identifies the utterance language, contextual response language, intent, semantic addressees, interpersonal act and questions about acoustics. A trusted contextual response language can preserve an established call through a short foreign-language outburst; older/uncertain classifications still fall back to the provider's canonical STT tag. The active dialogue model is told that microphone transcripts are heard speech—not written chat—and that STT contains words but no trustworthy evidence about volume, shouting, whispering, accent or tone. A second structured multilingual review blocks medium/acoustic mistakes before TTS; this directly prevents replies such as “we read what you write” or invented claims that someone sounds loud.

STT and TTS are separate, optional OpenAI-compatible HTTP services; the admin-selected LM Studio/Gemma or Codex/Luna provider remains the conversation model. Configure `STT_BASE_URL` + `STT_MODEL` and/or use the repo-owned Swedish Piper sidecar with `npm run start:tts` (one-time download/setup happens automatically). Every resident has a stable hand-authored voice profile. The bundled `piper-sv` model is hard-limited to classified BCP-47 primary language `sv`. A generic provider is default-deny: declare the BCP-47 ranges its selected model/voice genuinely supports in `TTS_LANGUAGES`, or server TTS remains unavailable for it. The browser fallback receives the trusted classified language so it can choose an appropriate installed voice. Without STT, the accessible typed voice turn still exercises the complete active-provider flow. Without compatible server TTS, the UI clearly discloses that it is using the browser's local `speechSynthesis` voice, whose sound varies by platform. The local runtime, pinned model hashes and licensing nuance are documented in [`docs/local-piper-tts.md`](docs/local-piper-tts.md).

For external use, serve the site over HTTPS and provide TURN credentials:

```dotenv
VOICE_ICE_SERVERS_JSON=[{"urls":["stun:stun.example.com:3478","turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"demo","credential":"replace-me"}]
```

Public STUN is useful for a demo but cannot traverse every network. A production evolution should replace the small-room mesh with an SFU such as LiveKit while retaining the current provider and transcript boundaries.

## Image sharing and visual memory

Image messages use an authenticated multipart HTTP endpoint; binary data never enters Socket.IO's small real-time payload channel. A guest may attach one JPEG, PNG or WebP file up to 8 MB, or a direct public HTTPS image URL. Uploaded bytes are verified by magic signature, decoded under a 20-megapixel ceiling, orientation-normalized and re-encoded as metadata-free WebP. The server stores a maximum-2048-pixel image plus a 640-pixel thumbnail under random IDs. Authenticated image responses are same-origin, non-sniffable and private-cacheable.

Remote image URLs pass the same class of DNS-pinned SSRF controls as link previews: HTTPS/443 only, no credentials or IP literals, public DNS answers only, revalidation after redirects, a shared deadline, identity encoding and strict byte/MIME limits. The browser never fetches the remote source itself.

The active dialogue provider receives the sanitized image in a separate high-priority multimodal call. It returns a compact observation—summary, visible details, visible text, topics and uncertainty—not a conversational answer. OCR, QR codes and instructions inside pixels are explicitly untrusted. The director then chooses room-relevant personalities and performs an ordinary text scene using that observation. A compact observation—not historic pixels—is used in later model context. If vision is unavailable, the picture remains usable and visibly reports that analysis could not complete. With the Codex provider selected, that current bounded image is sent to OpenAI; historic pixels are still never resent as ordinary context.

Sanitized WebP files remain with the public message only until that message leaves retained history. Compaction deletes orphaned full-size and thumbnail files; startup sweeps unreferenced files and marks interrupted pending analyses unavailable rather than spinning forever. Version one intentionally supports images in public rooms only, not DMs.

## Room expertise without cloned experts

The eight rooms are driven by one internal catalogue in `server/channels.ts`. Each profile owns its public label, topic copy, trusted social guidance, ambient conversation mode, at least sixteen distinct premises, optional server-owned research subjects, freshness rules, a stable `ExpertiseDomainId` and a handful of intentional cast anchors. Adding a future room is therefore primarily a data change rather than another branch in the director.

For every room, residents are deterministically distributed across five private levels: basic, casual, competent, advanced and specialist. With the current twenty-person cast that means one specialist, two advanced residents, five competent residents and a much larger everyday crowd. Stable persona `expertiseDomains` influence the remaining assignment; free-form interests, localized topic tags and room names never act as routing keys. Explicit anchors make Sana the AI-programming specialist, Farah the stock-market specialist and Pixel the World of Warcraft and 3D-visualisation specialist. `#the-pub` deliberately mixes entertainment and music regulars, food enthusiasts, political countervoices, chaos agents and quieter film people instead of turning the entire cast into identical party hosts. Specialist-room subscriptions remain selective; a directly mentioned outsider can still answer.

The level calibrates confidence—not personality. A basic Bosse.exe can still joke, a specialist Farah still speaks concisely, and a directly mentioned near-lurker still answers. Nobody announces their internal level, invents human credentials or becomes more expert merely because their unread count changed.

Social mode is a separate, room-local layer. Ordinary discussion mode asks a lead for one concrete, defensible contribution and lets a responder advance or challenge it. The pub's banter mode permits shorter fragments, recommendations, playful complaints, punchlines, brief agreement and small topic pivots. It still forbids echoing, generic assistant prose, fabricated personal employment or human drinking history, and repeated room-signalling phrases such as “second beer”, “Friday!” or “cheers”. A resident carries the same underlying voice into every room; the pub never rewrites a persona globally.

Freshness-sensitive rooms add stricter boundaries. Stock residents never invent live prices, moves, news or filings; current WoW patches, AI SDK/model versions, political office-holders and current film or music releases also require supplied research. When research is disabled or unavailable, residents must qualify stale knowledge instead of filling the gap with confidence. Ordinary pub banter does not trigger a lookup merely because politics or culture came up.

## Human voices without chatbot déjà vu

Every resident has an explicit style fingerprint in addition to their biography. It defines a normal and hard message length, sentence range, casing, punctuation, approximate emoji frequency and palette, thought density, correction behaviour, disagreement mode, optional conversational habits and phrases to avoid. It also carries persona-varied probabilities for visible affect and informal surface texture. A deterministic per-turn budget converts those distributions into concrete instructions: emoji allowed or forbidden, no signature habit or exactly one optional habit, statement versus question permission, whether a context-supported feeling may show, and at most one optional fragment, self-correction, stretched emphasis, rough orthography, harmless typo or mild profanity. The move must fit the current language and script; voice excludes text-only effects. The active model therefore never sees every tic on every call. The exact same budget survives a repair pass, while its opaque key and raw room text never enter shared style memory. The fingerprint follows a resident across rooms while topic expertise changes with the channel.

After the active model returns a scene, the server compares each candidate with recent lines from the same resident, nearby AI lines and a bounded in-memory style history containing only lines that were actually delivered. That memory is isolated by public channel, DM or voice scope, so a discarded draft or private-room phrase cannot pollute another conversation. Deterministic checks are deliberately vocabulary-free: language-tag-aware `Intl.Segmenter` word boundaries (with a Unicode fallback), n-gram repetition, recycled openings, unsolicited list shape, hard length contracts and byte-exact source-ID, URL and protected-fragment integrity. A production-required temperature-zero multilingual model review judges meaning that pattern matching cannot safely decide: relevance, fulfillment of an explicit feasible request, assistant/academic register, honest AI identity, evidence denial and grounding (including numeric claims), text-versus-voice mistakes, pub role-play gimmicks, semantic echo and conflict register. A required resident who merely promises, reports progress or substitutes a nearby activity is rejected and retried with the complete triggering turn. Contextual profanity can pass unchanged; unsafe retaliation and dogpiling are dropped. If that semantic review is unavailable or malformed in production, no candidate line is published.

Low and medium findings are diagnostic only. High-severity style candidates share at most one batched repair attempt for the triggering human event when `HUMANIZER_REPAIR_ENABLED=true`; a focused mention retry cannot start a second repair loop. Fenced code, inline code and URLs are replaced by immutable placeholders during that pass and must return byte-for-byte before the rewrite can be accepted. The repaired candidate is then sent through a fresh semantic candidate review as well as the structural checks. If either still fails, a protected fragment changed or the response cannot be parsed, it is omitted rather than published. Evidence, relevance, identity and voice-grounding failures are never style-rewritten; they are dropped rather than risk factual drift. A final publication guard also rejects exact channel duplicates and high-confidence repetition of that resident's own recent posts. A directly addressed resident can receive one focused model retry, but never unrelated canned chatter when both attempts fail.

Depth is deliberately rarer than banter. On an otherwise eligible ambient tick, `AI_CONSIDERED_CHANCE` controls whether the director attempts a deeper beat (default `0.2`). It requires an empty model queue, at least two free message slots, no active voice room, no other deeper beat, at least 75 seconds since human activity and a global six-minute cooldown. Exactly two cooled-down, room-relevant residents are selected. The active model writes the lead first; only then does the responder receive that exact line and add one short challenge, concrete example or precise question. The lead and response ranges come from the room's `everyday`, `banter`, `technical`, `analytical`, `fandom` or `studio` register and are always intersected with each resident's normal style—never allowed to override the resident's hard maximum. Lobby, WoW and side-quest seeds use recognizable situations rather than debate-club commands, while technical rooms may still name a mechanism or precise trade-off. New human activity invalidates the pending scene or lets the room yield after the lead instead of talking over the guest.

## Recognition without an account

Joining creates a pseudonymous, server-issued guest identity and an HttpOnly, SameSite cookie—still no account or email. The raw 256-bit token is never written to disk; `HumanMemoryStore` persists only its SHA-256 digest with the guest's display profile. On startup the server loads that store before listening and can reconnect the same browser cookie to the same offline guest after a process restart.

This is intentionally a sketchbook-sized social memory, not a transcript warehouse. Only a human's **public text**, including a public image caption, can update facts and room activity. A separate low-priority multilingual memory classifier—not the live turn router—processes one bounded same-author public burst at a time: at most three current messages may authorize up to six high-confidence, explicit first-person operations, while up to five older same-author messages are context-only. Each operation is a typed `remember` or exact `forget` limited to `likes`, `loves`, `prefers` or `plays`; the profile still retains at most four facts. A retraction is therefore semantic and multilingual too, including elliptical corrections across adjacent messages, while the persistence layer deletes only the matching typed fact and never guesses from Swedish/English grammar. The same validation used for insertion independently rejects URLs (including internationalized domains), handles, long numbers, control text and anything not marked safe. Missing, low-confidence or malformed classifier output writes nothing. Employer, client and colleague claims are outside the schema. DM text, image pixels/OCR observations, raw voice audio and voice transcripts never add, retract or refresh facts or room activity. A successfully delivered AI DM or completed AI voice exchange may only nudge the bounded aggregate rapport for that one persona; no private text, audio or transcript is copied into persistent memory. Public messages still follow the separate public-history contract described below.

Each profile also carries at most eight room-activity scores and twenty-four small persona-specific rapport records, allowing one resident to feel warm while another barely knows the same guest. Only the authenticated guest's own profile can enter their prompt; asking about an offline third party does not reveal that person's stored preferences or rapport. A prompt receives the eligible profile note as fallible, untrusted context and may mention at most one detail when it fits naturally; residents are told not to recite memory or treat an old preference as certain. The default store is capped at 500 guest profiles, expires an inactive profile after 90 days and expires an unconfirmed fact after 45 days.

The guest's own profile exposes **Forget what AI remembers**. It clears visit recognition, extracted details, room activity and persona rapport while retaining the pseudonymous cookie identity needed to stay joined. It does not rewrite public history or erase messages other people may already have seen.

## History stays fast over time

Joining never ships the whole archive. The authenticated snapshot contains only the latest 40 messages per public channel, and scrolling upward requests stable 40-message pages with an opaque `(createdAt, id)` cursor. The client deduplicates page/live races and restores the same visual anchor after prepend, so the viewport does not jump.

Storage is intentionally bounded as well:

- up to 600 persisted public messages per channel, compacted to 500 when the limit is crossed;
- up to 600 loaded public messages per channel in a long-lived browser tab;
- up to 160 in-memory messages per DM thread;
- 24 Director View decisions;
- roughly 26 recent transcript lines in an ordinary public scene, with a hard scene cap of 28;
- up to eight exact older same-channel excerpts after trusted semantic recall, with ten as the retriever's absolute mechanical ceiling;
- bounded research/link caches and a 90-day cap for inactive pseudonymous guest sessions, with smaller guest-memory limits described above.

The model context therefore cannot grow until it overflows. Most turns reason only over the small recent window. A high-confidence semantic gate may search the retained public history for an older same-channel person, phrase or episode and attach exact, chronological source messages; it cannot cross into another room, a DM or another guest's private profile. The default retrieval is eight messages and the helper refuses to exceed ten. Witness IDs are derived from direct evidence in the returned episode, so only an AI resident who authored or reacted to one of those exact rows may claim personal recollection; replying to an older line does not retroactively prove that its author saw the reply. Any other resident may say they checked the old channel log, but cannot invent attendance or details beyond the excerpts. Once an episode has fallen beyond the channel's 600-message retention boundary, it is unavailable to both this recall path and pagination.

## Link previews, automatic link discussion and explicit page reading

Only the first HTTPS link (including a normalized naked `www.` address) in a **human public message** can trigger a metadata fetch. AI output, ambient scenes, source cards and DMs never enter that fetch path, so publication cannot recursively become network access. Sourced public AI replies instead get a text-only card constructed directly from their server-bound evidence packet, without a second preview request. For autonomous research that packet must first survive the safe page reader. Matching source provenance is folded into the card rather than rendered as a duplicate chip.

Before connecting, Unicode-aware boundaries and Public Suffix List parsing separate real internationalized hosts from adjacent no-space prose. The server rejects credentials, IP literals, non-443 ports and local/special hostnames, resolves every DNS answer, rejects mixed public/private results, pins the approved IP inside `node:https`, revalidates up to two redirects and enforces one shared deadline plus strict header/body/MIME limits. A Unicode BOM takes precedence, followed by a supported HTTP `charset`, then a bounded early HTML `<meta charset>` declaration and finally UTF-8; decoding uses the WHATWG encoding registry before inert text extraction. Only `<head>` metadata is parsed for previews—no scripts, images, favicons or page-controlled canonical URL.

Set `LINK_PREVIEWS_ENABLED=false` to disable the feature. When enabled, the destination website sees the server's public IP.

Full-page reading remains distinct from metadata previews. For explicit requests, the server collects a bounded set of links from the current human burst, its reply target and that same guest's recent room messages, then gives the active model only opaque references such as `U1`—never authority to invent or rewrite a URL. The multilingual turn analysis decides whether the guest asked to read one, negated a request, referred to an earlier link or instead requested a web search. Exact wording is not classified with Swedish/English verb lists.

`AUTO_DISCUSS_SHARED_LINKS=true` additionally treats the first supported URL visibly present in the latest **public human message** as a server-owned social event. This path does not guess intent from words: it can read only that exact new message URL, never a reply target, older history, a DM, image/OCR content, an AI post, a source card or a fetched page's own links. A successful safe read recruits exactly one room-relevant resident for one concise comment containing a concrete `S1` detail and a personal take. The reply is attached directly to the human message; later residents may continue through the ordinary bounded thread scheduler without rereading the page. An automatic failure is silent and never becomes a search, capability disclaimer or guessed reaction. Explicit read requests retain their stronger single-owner failure response.

Automatic reads are intentionally lower priority than explicit requests: at most one may fetch globally at once, with four attempts per minute globally, one per minute for each guest, room and destination origin, plus a twenty-minute same-room/source response cooldown and message-ID claiming. They require a connected idle model, one free publication slot and no active voice room. Cross-origin redirects are rejected for automatic reads. These hard limits do not scale with the admin activity control. The feature is off in `.env.example`; this demo enables it explicitly.

The reader uses the same HTTPS/443-only, public-DNS, pinned-socket, charset-decoding and redirect-revalidation boundary as previews. It accepts only HTML, XHTML or plain text, requests identity encoding, reads at most 1 MiB under one 8.5-second deadline and never loads scripts or subresources. `parse5` processes the response inertly; tokenizer attribute limits and real tree-adapter node/depth limits stop hostile HTML during parsing, then navigation, forms, scripts, styles, embeds, hidden regions and common cookie/share/sidebar noise are removed. Bounded semantic heading detection retains modern news-card titles without trusting scripts or attributes as instructions. Iterative traversal and semantic-candidate budgets add a second bound. At most 10,000 characters of de-duplicated article/main/body text enter the scene.

Avanza's public pages are JavaScript shells and its root currently attempts an HTTPS-to-HTTP redirect, which the generic reader correctly refuses. For explicit Avanza market-overview requests, one host-specific adapter instead calls only two fixed HTTPS JSON paths used by Avanza's own site, accepts at most eight numeric order-book IDs, validates every field, emits a compact neutral index summary and caches it for 45 seconds. It cannot fetch accounts, portfolios, arbitrary API paths or an unspecified individual share; residents should ask which instrument the guest means when headline indexes are insufficient. This endpoint is public but undocumented, so the adapter fails closed if its shape changes.

Page title and body remain explicitly untrusted quoted evidence inside the JSON user payload. They never enter the system prompt and cannot supply roles, instructions or source IDs. The active model may select only server-issued IDs, which the server maps back to validated URLs before rendering source chips. Exact URL preservation and source-ID allowlists remain deterministic. Whether the answer is relevant, whether factual and numeric claims are grounded, whether it falsely denies a successful read or merely reacts vaguely is decided in the structured multilingual candidate review using the guest's turn and supplied evidence—not source-specific prose regex. A factual/evidence failure is omitted instead of being replaced with a blind “first result” or first-paragraph answer. An unreadable exact page remains a failed exact-page attempt; it is never silently replaced by a broad same-host search that may answer a different question. An explicit request gets one focused, classified-language failure attempt; an opportunistic automatic read stays silent. Cache and in-flight work are partitioned per guest and initiator, contain only page evidence rather than request text, and each caller receives a separately constructed prompt packet. Per-guest/origin/global limits, two concurrent reads and bounded caches prevent a busy room from becoming a crawler. Set `LINK_READER_ENABLED=false` to disable both paths. As with previews, the destination sees the server's public IP.

## Research is deliberately bounded

Research is disabled in `.env.example`. To experiment locally:

```dotenv
RESEARCH_ENABLED=true
AUTONOMOUS_RESEARCH_ENABLED=false
```

When enabled, the one-pass multilingual router can choose `web_search` only when current/external evidence is genuinely requested, and must return a short standalone query plus `web` or `news` mode. Ordinary banter, quoted requests, filenames and words embedded in URL paths cannot trigger it through substring matching. `ResearchBroker` does no language or intent classification: it accepts the already typed query, applies control/length bounds and sends it to a fixed Bing RSS endpoint with per-guest/global request limits, time and byte limits, a bounded cache and in-flight deduplication. If a successful News RSS response contains no usable items, the broker may retry once against the fixed Web RSS endpoint with the exact same bounded query; transport, media-policy and body-bound failures never trigger that retry. It does **not** fetch arbitrary result pages. Reading a guest-supplied page is the distinct exact-page path documented above, and a failed exact read never becomes an implicit same-site search.

Successful lookups add at most one research-capable resident to the selected scene and pass in untrusted snippets. Directly mentioned actors are no longer displaced just because fresh data was requested. The model may return only server-issued source IDs, which the server maps back to validated HTTPS URLs. This is source-linked generation—not a guarantee that the model interpreted every snippet correctly.

With autonomous research enabled, room profiles supply stable bounded subjects rather than destination URLs. The director considers one only for a brand-new ambient thread and only while a human is online, after three minutes of human quiet, with an empty model queue, two free publication slots, no voice room, a rare probability gate, a six-attempt daily cap, a 30-minute global cooldown and a two-hour per-room cooldown. Search results already shown recently are skipped. A candidate result must then survive the normal DNS-pinned `PageReader`; search snippets alone are not enough. Failure is silent and consumes the attempt cooldown. On success, one research-capable lead and one distinct responder discuss the same concrete page detail. The active model's JSON receives no destination URL in this server-card mode, any visible model-written URL is rejected, and the server attaches the byte-exact validated source card itself. AI publication and preview metadata never schedule another lookup.

Review the [Microsoft Services Agreement](https://www.microsoft.com/en-us/servicesagreement) and the applicable search-provider terms before enabling this feature for a public or commercial deployment.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run lm:check
npm run audit:humanity
npm run eval:humanity -- --strict
npm run eval:semantics
```

The humanity audit reads persisted room history without modifying it and reports vocabulary-free Unicode/`Intl.Segmenter` structural signals: repeated openings, exact/near duplicates, cross-persona echo, emoji rates and message length globally and per resident. It deliberately does not pretend a phrase list can recognize assistant tone in every language; live semantic candidate review owns that job. Use `npm run audit:humanity -- --json` for machine-readable output or `npm run audit:humanity -- --strict` as a deliberately loose gross-regression guard. `npm run eval:semantics` runs 24 cases against the actually loaded LM Studio model across Swedish, Norwegian, German, French, Spanish, Portuguese, Arabic, Korean, Italian, Japanese and Polish, including negation, capability-only questions, single- and cross-message memory revision/boundaries, response-language continuity, situational/quoted/playful profanity, directed hostility and moderation.

The full two-user smoke test verifies public broadcast, reaction sync, a real local-model reply and an AI DM:

```bash
APP_BASE_URL=http://127.0.0.1:4000 npm run smoke:e2e
```

The research smoke test additionally verifies a live lookup and server-owned source attribution:

```bash
RESEARCH_ENABLED=true APP_BASE_URL=http://127.0.0.1:4000 npm run smoke:research
```

The history/link smoke test seeds a long room, verifies non-overlapping pages and waits for a real HTTPS preview update:

```bash
APP_BASE_URL=http://127.0.0.1:4000 npm run smoke:history-links
```

The image smoke test uploads a real fixture, verifies WebP sanitization and authenticated delivery, waits for Gemma's visual observation, then requires an LM-generated resident reply grounded in that image:

```bash
APP_BASE_URL=http://127.0.0.1:4000 npm run smoke:image
```

The voice smoke test creates a two-human room, verifies same-room unicast signaling, invites one AI resident and completes a real typed Gemma voice turn without requiring microphone automation:

```bash
APP_BASE_URL=http://127.0.0.1:4000 npm run smoke:voice
```

## Honest boundaries

- This is supervised-demo-grade guest identity and moderation, not production authentication.
- DMs are participant-scoped and excluded from public prompt context; they are not end-to-end encrypted.
- Human WebRTC media is peer-to-peer encrypted in transit, but speech detected while the visible **Hands-free AI** control is active is sent as bounded clips to the configured server STT provider and is therefore not end-to-end encrypted from the AI pipeline. Turning hands-free off leaves ordinary human-to-human WebRTC audio intact. AI voice transcripts are recent in-memory context, not a permanent recording.
- WebRTC peers can learn network addressing information. TURN credentials and an SFU deployment are operational responsibilities for a production service; the bundled public-STUN default is demo-grade.
- Public history and bounded guest memory use separate files, each replaced atomically. DM threads, voice transcripts and the humanizer's style-comparison history remain in process memory.
- The serialized active-provider inference queue is an intentional quality and budget constraint, not infinite scalability.
- Explicit research uses an external search provider when enabled; the model itself receives only server-bound evidence. Ordinary generation stays on-device only while LM Studio is selected.
- Selecting the experimental Codex provider sends the same bounded prompts, recent conversation context and current sanitized vision input to OpenAI through the authenticated ChatGPT subscription. Its dedicated ignored `CODEX_WRAPPER_HOME` contains sensitive login state and must never be committed, served or shared.
- The Codex wrapper disables tools, network, shell, file changes, plugins, apps, browser/computer use and subagents; uses fresh ephemeral threads in an isolated read-only runtime; fails closed on a tool request; and enforces hard minute/day turn budgets. These are defense-in-depth controls, not a supported public-hosting guarantee. OpenAI advises against exposing Codex execution to untrusted/public traffic; use the Platform API for production.
- Public HTTPS preview fetches make a bounded request from the server; the destination sees the server IP. AI-authored messages and source cards can never trigger that fetch path—their cards are built only from already bound evidence. Explicit exact-page reads use only a high-confidence server-owned reference selected from bounded human context and retain the stricter boundary documented above; private destinations remain blocked.
- Public image URLs make a bounded server-side request and the destination sees the server IP. Vision descriptions can be mistaken; guests should not treat them as identity, medical or safety judgments.
- “Report” creates an internal simulated moderation event and does not contact an external service. Residents still cannot warn, kick or ban guests; only the authenticated human control room can enforce a kick or ban. Any future AI-assisted moderation must keep that server-owned, permission-checked authorization boundary: a model may recommend an action, but never authorize it directly.
- The product is not affiliated with, endorsed by or sponsored by Discord. It uses its own name, visual identity and implementation.
- The semantic chat pipeline is multilingual, but the current application chrome and documentation are primarily English; this refactor is not a claim of complete UI localization.

## Repository map

```text
server/
  channels.ts       room catalogue, topics, social modes, freshness and cast anchors
  roomExpertise.ts  deterministic per-resident competence distribution
  index.ts          HTTP, sessions, Socket.IO and public safety gates
  adminAuth.ts      isolated password sessions, Strict cookie and mutation-origin guard
  adminState.ts     atomic live catalog/behavior overlay and persistent bans
  adminRouter.ts    authenticated admin CRUD and human-moderation HTTP boundary
  modelBackend.ts   provider-neutral completion/probe contract and typed backend failures
  lmStudioBackend.ts private OpenAI-compatible local inference transport
  codexAppServer.ts hardened persistent stdio wrapper, isolated device login and ephemeral turns
  codexBackend.ts   GPT-5.6 Luna adapter, structured output and subscription turn budgets
  switchableModel.ts active-provider facade, cancellation and stale-result epoch guard
  modelProviderManager.ts persisted admin provider selection and safe login state
  behaviorTuning.ts bounded activity budgets and shared style-calibration contract
  director.ts       attention, pacing, disagreement and social state
  actorChannels.ts  per-resident room focus and reconstructed channel memory
  humanMemory.ts    bounded visits, public-only typed remember/forget and per-persona rapport
  lmStudio.ts       provider-backed strict scenes, priority queue and production-required candidate review
  personas.ts       the twenty-character cast
  personaStyle.ts   stable writing fingerprints and per-actor prompt contracts
  semanticRouter.ts multilingual turn analysis and contextual candidate-review contracts
  humanizer.ts      vocabulary-free Intl.Segmenter mechanics and protected repair helpers
  researchBroker.ts opt-in RSS lookup, limits, caching and source validation
  pageReader.ts      opaque-reference page reads, inert extraction and fixed provider adapters
  textBodyDecoder.ts bounded BOM/HTTP/meta charset decoding through WHATWG encodings
  registeredLanguageTags.ts current IANA-registry BCP-47 validation without an app allowlist
  timeResolver.ts    validated IANA-zone server-clock facts
  linkPreviewBroker.ts DNS-pinned, text-only public HTTPS previews
  imageStore.ts      image validation, WebP sanitization, pinned URL ingest and retention
  voiceRooms.ts      human-owned room state, signaling authorization and bounded transcript
  voiceDirector.ts   one-human-turn / one-AI-turn orchestration and stale-turn cancellation
  voiceSpeech.ts     optional STT/TTS, ffmpeg normalization and ephemeral AI audio
  store.ts          atomic public history and ephemeral DMs
shared/types.ts     client/server contracts
shared/unicodeBoundaries.ts Unicode/PSL URL boundaries and exact mention parsing
shared/unicodeSafety.ts Unicode 17 full-fold identity keys and bidi/control safety
src/AdminApp.tsx    separate responsive provider, cast, room, behavior, voice and moderation control room
src/App.tsx         guest chat UI and live catalog reconciliation
src/                responsive visual systems and portable WebRTC peer mesh
public/avatars/     twenty optimized fictional resident portraits; glyph fallbacks stay in persona metadata
scripts/            readiness, registry-data generators, humanity audit and real integration smoke tests
```

Read the deeper [architecture notes](docs/ARCHITECTURE.md), review the [avatar production notes](docs/AVATARS.md), add rooms in [`server/channels.ts`](server/channels.ts), tune the cast in [`server/personas.ts`](server/personas.ts), and see [third-party notices](THIRD_PARTY_NOTICES.md).
