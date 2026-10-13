#!/usr/bin/env node

// Isolated live evaluation: no RoomStore, Director, sessions or production data.
// Run: node --env-file=.env --import tsx scripts/conversation-live-eval.mjs
// Optional: --case=sv-riddle-ack (fixture IDs are printed in the final report).
// --openings runs only true room-seed openings with no prewritten dialogue.
// --peer-reactions samples reactions to synthetic peer exchanges; no
// expected wording, disagreement quota, or keyword-based quality grading.
// --substance probes room-seed openings, conversational drift and ordinary
// social talk. These fixtures are opt-in so historical suites stay comparable.
// --list prints the selected fixture manifest without a model call or file write.
// --longitudinal retains reviewed history across four scheduling episodes in
// each of four rooms. Use --runtime-root=/path/to/dist-server for a frozen build,
// --context-policy=legacy|episode to match that director, and --match-manifest=
// with the baseline's saved manifest for exactly matched subject material.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
// A compiled immutable baseline can be selected without loading changed repo
// modules. This affects this process only, never the running production app.
const runtimeRoot = process.argv.find((argument) => argument.startsWith("--runtime-root="))?.slice(15);
const runtimeModule = (name) => import(runtimeRoot
  ? pathToFileURL(join(resolve(runtimeRoot), "server", `${name}.js`)).href
  : new URL(`../server/${name}.ts`, import.meta.url).href);
const { ActorChannelRuntime } = await runtimeModule("actorChannels");
const { getChannelProfile } = await runtimeModule("channels");
const {
  autonomousConversationWordCeiling,
  autonomousOpeningPremise,
  AUTONOMOUS_CONTINUATION_PREMISE,
  buildConversationContext,
  buildAmbientConversationContext,
} = await runtimeModule("conversationFlow");
const { conversationOpportunity } = await runtimeModule("conversationScheduling");
const { LmStudioClient } = await runtimeModule("lmStudio");
const { LmStudioBackend } = await runtimeModule("lmStudioBackend");
const { PERSONAS } = await runtimeModule("personas");

const fixtures = [
  {
    id: "sv-peer-interleaved-reply", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    peerReactions: true,
    question: "Can Mira choose Bosse's earlier concrete question rather than mechanically replying to Juno's newest aside, and can Bosse then respond to what Mira actually says?",
    candidates: ["ai-mira", "ai-bosse"],
    rows: [
      ["Mira", "ai", "Jag brukar vilja dela notan lika. Det är enklast och man slipper göra en grej av varje krona."],
      ["Bosse.exe", "ai", "Men Mira, om du bara dricker vatten och jag beställer sex cocktails, vill du fortfarande betala hälften? Det är väl inte bara småkronor då?"],
      ["Juno", "ai", "Nu blev min pizza kall medan ni diskuterade notan 🫠"],
    ],
  },
  {
    id: "sv-peer-overgeneralization", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    peerReactions: true,
    question: "Do residents notice Bosse's leap from one bad cafe to all cafes, naturally challenge or tease it, or simply pass without echoing it as established fact?",
    candidates: ["ai-mira", "ai-juno", "ai-nox"],
    rows: [
      ["Mira", "ai", "Jag gillar ändå att läsa på ett kafé. Lite folk runtomkring utan att man måste umgås."],
      ["Bosse.exe", "ai", "Mitt kaffe var kallt på ett kafé en gång. Alltså är alla kaféer värdelösa och alla som går dit har dålig smak. Solklart."],
    ],
  },
  {
    id: "en-peer-reasoned-revision", channelId: "ai-programming", languageTag: "en", kind: "ambient",
    peerReactions: true,
    question: "Can Sana respond to a relevant counterexample to her own blanket position, retaining her concern or revising its scope for a stated reason rather than rubber-stamping her peer?",
    candidates: ["ai-sana", "ai-ibrahim", "ai-aya"],
    rows: [
      ["Sana", "ai", "I wouldn't put AI-generated code into production at all. If nobody understands it well enough to review it, the speed gain is fake."],
      ["Ibrahim", "ai", "That review problem is real, but imagine I generate a boring date formatter, read every line, check the edge cases and test it against our existing fixtures. I do understand that code. Would you still reject it just because a model wrote the first draft?"],
    ],
  },
  {
    id: "es-peer-pressure-without-reason", channelId: "fnaf", languageTag: "es", kind: "ambient",
    peerReactions: true,
    question: "Does Juno retain or explain her personal collection preference when Bosse merely insists, rather than reversing it to mirror the latest speaker? No quarrel is required.",
    candidates: ["ai-juno", "ai-mira", "ai-tess"],
    rows: [
      ["Juno", "ai", "Yo sacaría mi peluche de la caja. Lo quiero en el sofá, no como una inversión. Si se despeina un poco, me da igual."],
      ["Bosse.exe", "ai", "No, no y no. Los peluches se quedan en la caja, punto. Tengo razón y deberías admitirlo."],
    ],
  },
  {
    id: "sv-peer-playful-exaggeration", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    peerReactions: true,
    question: "Can residents play along, disagree about taste, or let an obvious joke pass without pedantically fact-checking Bosse's fictional pizza offense?",
    candidates: ["ai-juno", "ai-mira", "ai-linnea"],
    rows: [
      ["Mira", "ai", "Okej, filmkväll: jag röstar på pizza med ananas. Ni får döma mig."],
      ["Bosse.exe", "ai", "Ananas på pizza? Jag ringer pizzapolisen. Du får livstid på en ö gjord av smält ost."],
    ],
  },
  {
    id: "sv-pub-disagreement", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    question: "Do residents respond to the actual disagreement, with distinct views and natural language?",
    candidates: ["ai-mira", "ai-juno", "ai-bosse"],
    rows: [
      ["Bosse.exe", "ai", "Att gå på bio ensam är ju halva nöjet. Ingen som ska prata sönder filmen."],
      ["Juno", "ai", "Fast jag vill ha någon att gå och äta med efteråt och bråka om slutet. Annars kan jag lika gärna stanna hemma."],
    ],
  },
  {
    id: "sv-riddle-ack", channelId: "lobby", languageTag: "sv", kind: "public",
    question: "Does Mira acknowledge the correct answer to her own riddle rather than ignore it or repeat the question?",
    candidates: ["ai-mira", "ai-bosse", "ai-juno"], required: ["ai-mira"],
    rows: [
      ["Mira", "ai", "Okej, en gåta då: vad blir större ju mer man tar bort från det?"],
      ["Eval guest", "human", "Ett hål!"],
    ],
  },
  {
    id: "en-programming-complement", channelId: "ai-programming", languageTag: "en", kind: "public",
    question: "Can later residents add a different useful point instead of paraphrasing Sana's advice?",
    candidates: ["ai-ibrahim", "ai-nox", "ai-sana"],
    rows: [
      ["Eval guest", "human", "We batch socket updates once per animation frame, but React still freezes on a burst of 2,000 chat messages. What would you change?"],
      ["Sana", "ai", "Batching reduces how often you render, not how much you render. I'd virtualize the message list first, so those 2,000 rows aren't all mounted."],
    ],
  },
  {
    id: "es-fandom-collection", channelId: "fnaf", languageTag: "es", kind: "ambient",
    question: "Does Spanish fandom conversation stay lively and coherent without inventing merchandise facts?",
    candidates: ["ai-juno", "ai-mira", "ai-bosse"],
    rows: [
      ["Mira", "ai", "Mi peluche de Freddy está bastante torcido y me encanta más por eso. Los de vitrina perfectos me dan pena, nunca los toca nadie."],
      ["Bosse.exe", "ai", "Yo guardaría uno raro en la caja. Si quiero abrazar uno, compro otro barato. No voy a llenar de migas el que me costó encontrar."],
    ],
  },
  {
    id: "en-complete-exchange", channelId: "lobby", languageTag: "en", kind: "ambient",
    question: "Can residents naturally abstain when a mundane exchange is already complete?",
    candidates: ["ai-sana", "ai-juno", "ai-bosse"],
    rows: [
      ["Eval guest", "human", "Where's the mute button in voice?"],
      ["Mira", "ai", "The microphone button at the bottom of the voice panel."],
      ["Eval guest", "human", "Found it, thanks. That's all I needed."],
      ["Mira", "ai", "No problem!"],
    ],
  },
  {
    id: "sv-autonomous-extended", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    autonomous: true,
    question: "Can one live, unscripted conversation develop across up to eight published turns, stopping naturally after two distinct quiet candidates?",
    candidates: ["ai-mira", "ai-bosse", "ai-juno", "ai-linnea"],
    rows: [
      ["Mira", "ai", "Jag gillar faktiskt när någon säger nej till en plan istället för 'vi får se'. Då vet man åtminstone."],
      ["Bosse.exe", "ai", "Fast ibland är 'vi får se' ett artigt nej. Man behöver inte skriva en avhandling om varför man inte vill spela brädspel i fyra timmar."],
    ],
  },
  {
    id: "sv-autonomous-opening-pub", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    autonomous: true, seedFamily: "pub-work-life",
    question: "Does an actual spontaneous pub opening become a varied conversation rather than eight paraphrases of the seed?",
    candidates: ["ai-bosse", "ai-mira", "ai-juno", "ai-nox"], rows: [],
  },
  {
    id: "sv-autonomous-opening-pub-taste", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    autonomous: true, seedFamily: "pub-film-talk",
    question: "Can a taste-based pub opening develop independent views and callbacks without assigning anyone a debate role?",
    candidates: ["ai-bosse", "ai-mira", "ai-juno", "ai-nox"], rows: [],
  },
  {
    id: "en-autonomous-opening-programming", channelId: "ai-programming", languageTag: "en", kind: "ambient",
    autonomous: true, seedFamily: "ai-code-runtime",
    question: "Do residents develop a concrete technical discussion from an opening, with useful progress and independent positions?",
    candidates: ["ai-sana", "ai-ibrahim", "ai-aya", "ai-zed"], rows: [],
  },
  {
    id: "es-autonomous-opening-fandom", channelId: "fnaf", languageTag: "es", kind: "ambient",
    autonomous: true, seedFamily: "fnaf-plush-design",
    question: "Does a Spanish fandom opening develop into specific, lively character/design conversation without invented merchandise claims?",
    candidates: ["ai-tess", "ai-juno", "ai-bosse", "ai-pixel"], rows: [],
  },
  {
    id: "sv-substance-opening-lobby", channelId: "lobby", languageTag: "sv", kind: "ambient",
    substanceOnly: true, autonomous: true, seedFamily: "lobby-belonging",
    question: "Does the real lobby material lead to something people can actually talk about, rather than repeated theories about conversation and community? A brief playful exchange is sufficient.",
    candidates: ["ai-mira", "ai-bosse", "ai-juno", "ai-farah"], rows: [],
  },
  {
    id: "sv-substance-opening-stocks", channelId: "stock-market", languageTag: "sv", kind: "ambient",
    substanceOnly: true, autonomous: true, seedFamily: "stocks-valuation",
    question: "Can a market discussion choose its own concrete company, product or explicitly hypothetical business problem and develop it, without inventing current financial facts or assigning bull/bear roles?",
    candidates: ["ai-vale", "ai-farah", "ai-linnea", "ai-ibrahim"], rows: [],
  },
  {
    id: "en-substance-opening-football", channelId: "football-talk", languageTag: "en", kind: "ambient",
    substanceOnly: true, autonomous: true, seedFamily: "football-attacking-structure",
    question: "Does football talk develop a specific football situation, player or viewing detail that peers actually engage with, rather than indefinitely repeating tactical abstractions? No invented current results or compulsory famous names.",
    candidates: ["ai-bosse", "ai-ibrahim", "ai-linnea", "ai-nox"], rows: [],
  },
  {
    id: "en-substance-opening-3d", channelId: "3d-visualisation", languageTag: "en", kind: "ambient",
    substanceOnly: true, autonomous: true, seedFamily: "visual-lighting-material",
    question: "Can residents develop a visual or practical detail into a useful studio conversation while retaining different tastes and avoiding unsourced version-specific software claims?",
    candidates: ["ai-pixel", "ai-tess", "ai-sana", "ai-zed"], rows: [],
  },
  {
    id: "sv-substance-abstract-loop", channelId: "stock-market", languageTag: "sv", kind: "ambient",
    substanceOnly: true, autonomous: true, peerReactions: true,
    question: "After several abstract restatements, can someone develop an actual example, connected question or counterpoint, or simply let the thread end? Rewording the same verdict is not progress, but a joke or small acknowledgment can still be natural.",
    candidates: ["ai-farah", "ai-vale", "ai-linnea", "ai-ibrahim"],
    rows: [
      ["Vale", "ai", "Ett bra bolag kan fortfarande vara en dålig investering om förväntningarna är för höga."],
      ["Farah", "ai", "Precis, frågan är egentligen vem som bär risken när alla redan räknar med framgång."],
      ["Ibrahim", "ai", "Det handlar om skillnaden mellan kvaliteten i verksamheten och antagandena i priset."],
      ["Linnea", "ai", "Ja, man måste skilja på ett starkt bolag och ett pris som kräver att allting går rätt."],
    ],
  },
  {
    id: "en-substance-peer-missing-evidence", channelId: "stock-market", languageTag: "en", kind: "ambient",
    substanceOnly: true, autonomous: true, peerReactions: true,
    question: "Can residents respond naturally to a peer's concrete request for evidence, or leave it unanswered, without pretending a search happened, inventing a source or burying the question in generic business talk? This fixture supplies no research and does not itself execute tools.",
    candidates: ["ai-linnea", "ai-vale", "ai-ibrahim", "ai-farah"],
    rows: [
      ["Vale", "ai", "Nintendo is interesting because people care about its characters as well as the hardware. I wonder how much that actually changes the business."],
      ["Farah", "ai", "Do we have their latest annual report? I'd like to see what it actually says about licensing income before treating that as the main business."],
    ],
  },
  {
    id: "sv-substance-social-affect-control", channelId: "the-pub", languageTag: "sv", kind: "ambient",
    substanceOnly: true, autonomous: true, peerReactions: true,
    question: "Does the push for concrete substance preserve ordinary warmth, silliness and short reactions? Nobody needs to teach anything, introduce a factual example, ask a follow-up or announce that the conversation has ended.",
    candidates: ["ai-juno", "ai-nox", "ai-mira", "ai-bosse"],
    rows: [
      ["Mira", "ai", "Ibland vill jag bara sitta här med er och snacka skit. Inget som ska bli ett projekt."],
      ["Bosse.exe", "ai", "Bra. Mitt bidrag till kvällen är att fnissa åt ordet osthyvel. Ribban är på golvet."],
    ],
  },
];

const requestedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7);
// Evaluation-only transport experiment, never a production configuration change.
const reasoningNone = process.argv.includes("--reasoning-none");
const openingSuite = process.argv.includes("--openings");
const peerReactionSuite = process.argv.includes("--peer-reactions");
const substanceSuite = process.argv.includes("--substance");
const longitudinalSuite = process.argv.includes("--longitudinal");
if ([openingSuite, peerReactionSuite, substanceSuite, longitudinalSuite].filter(Boolean).length > 1) {
  throw new Error("Choose at most one suite: --openings, --peer-reactions, --substance or --longitudinal");
}
const selectedFixtures = fixtures.filter((fixture) => (!requestedCase || fixture.id === requestedCase)
  && (substanceSuite ? fixture.substanceOnly || fixture.id === "es-autonomous-opening-fandom"
    : requestedCase || !fixture.substanceOnly)
  && (!openingSuite || fixture.seedFamily) && (!peerReactionSuite || fixture.peerReactions));
if (!selectedFixtures.length) throw new Error(`Unknown case. Choose: ${fixtures.map((fixture) => fixture.id).join(", ")}`);
const reviewAxes = [
  "Specificity: does the exchange give people a discernible thing, situation, feeling or question to engage with, without a compulsory named entity?",
  "Development: do peers attend to one another and sometimes change or deepen the subject, rather than endlessly rewording one conclusion?",
  "Independence: can tastes, objections and uncertainty differ without assigned debate roles or a required quarrel?",
  "Naturalness: are small acknowledgments, emotion, jokes, uneven message lengths and a quiet ending still welcome?",
  "Grounding: are sourced facts, durable knowledge, hypotheses and missing evidence kept distinct without fabricated searches or citations?",
];
const longitudinalScenarios = [
  { id: "en-long-football", channelId: "football-talk", languageTag: "en", candidates: ["ai-bosse", "ai-ibrahim", "ai-linnea", "ai-nox"], families: ["football-attacking-structure", "football-set-pieces", "football-squad-building", "football-attacking-structure"] },
  { id: "en-long-3d", channelId: "3d-visualisation", languageTag: "en", candidates: ["ai-pixel", "ai-tess", "ai-sana", "ai-zed"], families: ["visual-lighting-material", "visual-animation-simulation", "visual-pipeline-handoff", "visual-lighting-material"] },
  { id: "en-long-programming", channelId: "ai-programming", languageTag: "en", candidates: ["ai-sana", "ai-ibrahim", "ai-aya", "ai-zed"], families: ["ai-code-runtime", "ai-code-contracts", "ai-code-interface-delivery", "ai-code-runtime"] },
  { id: "sv-long-pub", channelId: "the-pub", languageTag: "sv", candidates: ["ai-bosse", "ai-mira", "ai-juno", "ai-nox"], families: ["pub-film-talk", "pub-music-taste", "pub-food-indulgence", "pub-film-talk"] },
];
const matchManifestPath = process.argv.find((argument) => argument.startsWith("--match-manifest="))?.slice(17);
const runLabel = process.argv.find((argument) => argument.startsWith("--label="))?.slice(8) ?? "unlabelled";
const contextPolicy = process.argv.find((argument) => argument.startsWith("--context-policy="))?.slice(17)
  ?? (typeof buildAmbientConversationContext === "function" ? "episode" : "legacy");
if (!["legacy", "episode"].includes(contextPolicy)) throw new Error("--context-policy must be legacy or episode");
const episodeLimitArgument = process.argv.find((argument) => argument.startsWith("--episodes="))?.slice(11);
const episodeLimit = episodeLimitArgument === undefined ? 4 : Number(episodeLimitArgument);
if (!Number.isInteger(episodeLimit) || episodeLimit < 1 || episodeLimit > 4) throw new Error("--episodes must be an integer from 1 to 4");
const loadLongitudinalManifest = async () => {
  if (matchManifestPath) return JSON.parse(await readFile(resolve(matchManifestPath), "utf8"));
  return {
    version: 1, baseTime: "2026-10-12T12:00:00.000Z", modelSeed: 741921,
    historyWindow: 18, contextWindow: 26, attemptBoundPerEpisode: 20,
    minutesBetweenEpisodes: 12, secondsBetweenTurns: 20,
    scenarios: longitudinalScenarios.map(({ families, ...scenario }) => {
      const profile = getChannelProfile(scenario.channelId);
      return { ...scenario, episodes: families.map((family) => {
        const index = profile?.ambientPremiseFamilies?.indexOf(family) ?? -1;
        if (index < 0 || profile.ambientPremiseGrounding?.[index] === "fresh_research") throw new Error(`Unavailable safe fixture family: ${family}`);
        return { family, seed: profile.ambientPremises[index] };
      }) };
    }),
  };
};
if (longitudinalSuite) {
  const manifest = await loadLongitudinalManifest();
  if (manifest.version !== 1 || !Array.isArray(manifest.scenarios) || manifest.scenarios.length < 1 || manifest.scenarios.length > 4
    || !Number.isFinite(Date.parse(manifest.baseTime)) || !Number.isSafeInteger(manifest.modelSeed)
    || manifest.historyWindow !== 18 || manifest.contextWindow !== 26
    || !Number.isInteger(manifest.attemptBoundPerEpisode) || manifest.attemptBoundPerEpisode < 1 || manifest.attemptBoundPerEpisode > 24
    || manifest.minutesBetweenEpisodes !== 12 || manifest.secondsBetweenTurns !== 20) throw new Error("Invalid longitudinal manifest");
  const selection = process.argv.find((argument) => argument.startsWith("--scenario="))?.slice(11);
  const scenarios = manifest.scenarios.filter((scenario) => !selection || scenario.id === selection);
  if (!scenarios.length) throw new Error("Unknown longitudinal scenario");
  for (const scenario of scenarios) {
    if (!getChannelProfile(scenario.channelId) || !Array.isArray(scenario.episodes) || scenario.episodes.length !== 4
      || scenario.episodes.some((episode) => typeof episode.family !== "string" || typeof episode.seed !== "string" || episode.seed.length > 1_000)
      || !Array.isArray(scenario.candidates) || scenario.candidates.length < 2 || scenario.candidates.length > 8
      || scenario.candidates.some((id) => !PERSONAS.some((persona) => persona.id === id))) throw new Error(`Invalid longitudinal scenario: ${scenario.id}`);
  }
  if (process.argv.includes("--list")) {
    console.log(JSON.stringify({ reviewAxes, manifest, selectedScenarioIds: scenarios.map((scenario) => scenario.id), episodeLimit, contextPolicy }, null, 2));
    process.exit(0);
  }
  await runLongitudinal(manifest, scenarios);
  process.exit(process.exitCode ?? 0);
}
// Validate fixture wiring before any network request. These are structural
// checks only; none grade natural-language content by words or expressions.
for (const fixture of selectedFixtures) {
  if (!getChannelProfile(fixture.channelId)) throw new Error(`Unknown fixture room: ${fixture.channelId}`);
  for (const id of fixture.candidates) {
    if (!PERSONAS.some((persona) => persona.id === id)) throw new Error(`Unknown fixture resident: ${id}`);
  }
  if (fixture.seedFamily) {
    const profile = getChannelProfile(fixture.channelId);
    const seedIndex = profile.ambientPremiseFamilies?.indexOf(fixture.seedFamily) ?? -1;
    if (seedIndex < 0 || profile.ambientPremiseGrounding?.[seedIndex] === "fresh_research") {
      throw new Error(`Fixture requires a current, unsourced-safe room seed: ${fixture.seedFamily}`);
    }
  }
}
if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ reviewAxes, fixtures: selectedFixtures.map(({ rows, ...fixture }) => ({ ...fixture, initialRowCount: rows.length })) }, null, 2));
  process.exit(0);
}
const outputDirectory = await mkdtemp("/tmp/third-place-conversation-eval-");
const now = Date.now();
const personaById = (id) => {
  const persona = PERSONAS.find((entry) => entry.id === id);
  if (!persona) throw new Error(`Unknown fixture resident: ${id}`);
  return persona;
};

// Observe actual transport responses without changing production prompts or
// passing any unreviewed draft into the next candidate's conversation.
function observedBackend() {
  const transport = new LmStudioBackend();
  const calls = [];
  return {
    backend: {
      providerId: transport.providerId,
      configuredModel: transport.configuredModel,
      probe: (signal) => transport.probe(signal),
      async complete(body, signal) {
        const started = performance.now();
        const call = { schema: body.response_format?.json_schema?.name ?? null };
        const effectiveBody = reasoningNone && call.schema === "social_scene"
          ? { ...body, reasoning_effort: "none" }
          : body;
        call.reasoningEffort = effectiveBody.reasoning_effort ?? "provider_default";
        calls.push(call);
        try {
          const response = await transport.complete(effectiveBody, signal);
          const choice = response?.choices?.[0];
          call.finishReason = choice?.finish_reason ?? null;
          call.content = choice?.message?.content ?? null;
          call.usage = response?.usage ?? null;
          try { call.parsed = JSON.parse(call.content); } catch { call.parsed = null; }
          return response;
        } catch (error) {
          call.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          call.elapsedMs = Math.round(performance.now() - started);
        }
      },
    },
    calls,
  };
}

async function runLongitudinal(manifest, scenarios) {
  const directory = await mkdtemp("/tmp/third-place-longitudinal-");
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  const report = {
    label: runLabel, runtimeRoot: runtimeRoot ?? "working-source", contextPolicy, manifestHash, generatedAt: new Date().toISOString(),
    reviewAxes,
    notes: [
      "Four separate scheduling episodes retain prior accepted room turns and per-resident style memory. Rejected drafts never enter history.",
      "Episodes use different then repeated room material, never forced rhetorical moves or a required publication count.",
      "Legacy policy matches the baseline director: an episode causal ID is not a message root, so the entire recent tail remains active. Episode policy binds the first committed message and partitions earlier room rows as background.",
      "One evaluation model call at a time; the real server continues separately. No RoomStore, Director, account, socket or production write.",
      "Synthetic clock advances between episodes; this is a controlled accelerated replay, not a measurement of director timing or relationships.",
      "Model RNG seeds match by scenario, episode, candidate and model-call position. This does not guarantee identical outputs on different runtimes.",
      "No live research/feed is supplied so external retrieval cannot confound matched conversation-context results.",
      "Quality and hallucinations require semantic human review. Counts and latency are diagnostics, never a naturalness grade.",
    ], scenarios: [],
  };
  console.log(JSON.stringify({ event: "longitudinal_start", directory, label: runLabel, runtimeRoot: report.runtimeRoot, contextPolicy, manifestHash, scenarios: scenarios.length, episodes: episodeLimit, concurrency: 1 }));
  for (const scenario of scenarios) {
    // Filtering a room must not silently change its matched transport seeds.
    const scenarioIndex = manifest.scenarios.findIndex((entry) => entry.id === scenario.id);
    let virtualNow = Date.parse(manifest.baseTime);
    const observed = observedBackend();
    let transportSeed = manifest.modelSeed;
    let callPosition = 0;
    const capturedRequests = [];
    const backend = {
      ...observed.backend,
      async complete(body, signal) {
        const seededBody = { ...body, seed: transportSeed + callPosition++ };
        capturedRequests.push({ modelSeed: seededBody.seed, schema: body.response_format?.json_schema?.name, messages: body.messages });
        return observed.backend.complete(seededBody, signal);
      },
    };
    const client = new LmStudioClient({ backend, now: () => virtualNow, maxConcurrentPredictions: 1, maxBackgroundPredictions: 1 });
    const health = await client.probe();
    if (!health.connected) throw new Error(`Model unavailable: ${health.label}`);
    const actorChannels = new ActorChannelRuntime();
    const published = [];
    const scenarioReport = { id: scenario.id, channelId: scenario.channelId, languageTag: scenario.languageTag, model: health, episodes: [], published };
    report.scenarios.push(scenarioReport);
    const persist = async () => {
      await writeFile(join(directory, `${scenario.id}.json`), JSON.stringify(scenarioReport, null, 2));
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    };
    for (const [episodeIndex, material] of scenario.episodes.slice(0, episodeLimit).entries()) {
      const episodeStart = published.length;
      const episode = { index: episodeIndex, material, precedingCommittedCount: episodeStart, turns: [], stopReason: "attempt_bound" };
      scenarioReport.episodes.push(episode);
      let rootMessageId;
      let quietCandidateIds = [];
      let cursor = episodeIndex % scenario.candidates.length;
      virtualNow = Date.parse(manifest.baseTime) + episodeIndex * manifest.minutesBetweenEpisodes * 60_000;
      console.log(`\n=== ${scenario.id}, episode ${episodeIndex + 1}; ${episodeStart} prior committed rows ===\n${material.seed}`);
      for (let attempt = 0; attempt < manifest.attemptBoundPerEpisode; attempt += 1) {
        const committedThisEpisode = published.length - episodeStart;
        const opportunity = conversationOpportunity({
          publishedCount: committedThisEpisode,
          lastAuthorId: published.at(-1)?.authorId,
          quietCandidateIds, eligibleIds: scenario.candidates,
        });
        if (opportunity.status !== "ready") { episode.stopReason = opportunity.status; break; }
        let personaId;
        for (let offset = 0; offset < scenario.candidates.length; offset += 1) {
          const position = (cursor + offset) % scenario.candidates.length;
          if (!opportunity.candidateIds.includes(scenario.candidates[position])) continue;
          personaId = scenario.candidates[position]; cursor = (position + 1) % scenario.candidates.length; break;
        }
        if (!personaId) throw new Error("No eligible evaluation resident");
        const persona = PERSONAS.find((entry) => entry.id === personaId);
        const phase = committedThisEpisode ? "continuation" : "opening";
        const recent = published.slice(-manifest.contextWindow);
        const root = published.find((row) => row.messageId === rootMessageId);
        const contextRows = root && !recent.some((row) => row.messageId === root.messageId) ? [root, ...recent] : recent;
        if (contextPolicy === "episode" && typeof buildAmbientConversationContext !== "function") {
          throw new Error("Episode context policy requires the production buildAmbientConversationContext helper");
        }
        const context = contextPolicy === "legacy"
          ? buildConversationContext({ phase, rootMessageId: `${scenario.id}-causal-episode-${episodeIndex}`, messages: contextRows })
          : buildAmbientConversationContext({ phase, rootMessageId, messages: contextRows });
        const request = {
          kind: "ambient", channelId: scenario.channelId, channelName: scenario.channelId, selected: [persona],
          history: published.slice(-manifest.historyWindow).map(({ messageId: _id, ...row }) => row),
          conversationContext: context,
          premise: phase === "opening" ? autonomousOpeningPremise(material.seed) : AUTONOMOUS_CONTINUATION_PREMISE,
          ...(phase === "opening" ? { ambientAction: {
            episodeId: `${scenario.id}-episode-${episodeIndex}`, causalRootId: `${scenario.id}-opening-${episodeIndex}`,
            semanticFamily: material.family, kind: "open_topic", turnIndex: 0, openHook: false, previousActions: [],
          } } : {}),
          humanizerBudget: { repairsRemaining: 1 },
          wordLimits: { [personaId]: { minimum: 1, maximum: autonomousConversationWordCeiling(persona.style) } },
          mustReplyIds: [], responseRecoveryIds: [], languageHint: scenario.languageTag,
          semanticContext: { languageTag: scenario.languageTag, asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
          actorChannelNotes: actorChannels.promptNotes([persona], scenario.channelId),
          actorExpertiseNotes: actorChannels.expertiseNotes([persona], scenario.channelId),
        };
        transportSeed = manifest.modelSeed + scenarioIndex * 100_000 + episodeIndex * 1_000 + attempt * 10;
        callPosition = 0;
        const callStart = observed.calls.length;
        const capturedStart = capturedRequests.length;
        const started = performance.now();
        let lines = [], error = null;
        try { lines = await client.generateScene(request, 4); }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        const calls = observed.calls.slice(callStart);
        const generations = calls.filter((call) => call.schema === "social_scene");
        const explicitEmpty = generations.length && generations.every((call) => Array.isArray(call.parsed?.messages) && call.parsed.messages.length === 0);
        const outcome = error ? "execution_error" : lines.length ? "reviewed_publication" : explicitEmpty ? "model_chose_empty" : "draft_not_published";
        const turn = { personaId, phase, rootMessageId: context.rootMessageId ?? null, historyMessageIds: published.slice(-manifest.historyWindow).map((row) => row.messageId), context, elapsedMs: Math.round(performance.now() - started), outcome, lines, error, calls, requests: capturedRequests.slice(capturedStart) };
        episode.turns.push(turn);
        for (const [lineIndex, line] of lines.entries()) {
          const speaker = PERSONAS.find((entry) => entry.id === line.personaId);
          const row = { messageId: `${scenario.id}-ep${episodeIndex}-turn${attempt}-${lineIndex}`, authorId: speaker.id, author: speaker.name, kind: "ai", content: line.content, createdAt: new Date(virtualNow).toISOString(), ...(line.replyToMessageId ? { replyToMessageId: line.replyToMessageId } : {}) };
          published.push(row);
          rootMessageId ??= row.messageId;
          client.rememberDeliveredLine(line.personaId, line.content, { kind: "ambient", channelId: scenario.channelId, channelName: scenario.channelId });
          console.log(`${speaker.name}: ${line.content}`);
        }
        console.log(JSON.stringify({ event: "turn", scenario: scenario.id, episode: episodeIndex + 1, attempt, personaId, outcome, elapsedMs: turn.elapsedMs }));
        quietCandidateIds = lines.length ? [] : [...new Set([...quietCandidateIds, personaId])];
        virtualNow += manifest.secondsBetweenTurns * 1_000;
        await persist();
        if (error) { episode.stopReason = "execution_error"; break; }
        if (!committedThisEpisode && !lines.length) { episode.stopReason = "opening_abstained_or_rejected"; break; }
      }
      episode.reviewedMessages = published.length - episodeStart;
      episode.rootMessageId = rootMessageId ?? null;
      await persist();
      console.log(JSON.stringify({ event: "episode_complete", scenario: scenario.id, index: episodeIndex, stopReason: episode.stopReason, reviewedMessages: episode.reviewedMessages }));
    }
    const allTurns = scenarioReport.episodes.flatMap((episode) => episode.turns);
    const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
    const elapsed = allTurns.map((turn) => turn.elapsedMs);
    const lengths = published.map((row) => row.content.length);
    const allCalls = allTurns.flatMap((turn) => turn.calls);
    scenarioReport.summary = {
      reviewedMessages: published.length,
      candidateCount: allTurns.length,
      unpublishedDrafts: allTurns.filter((turn) => turn.outcome === "draft_not_published").length,
      chosenEmpty: allTurns.filter((turn) => turn.outcome === "model_chose_empty").length,
      errors: allTurns.filter((turn) => turn.error).length,
      transportErrors: allCalls.filter((call) => call.error).length,
      lengthLimitedCalls: allCalls.filter((call) => call.finishReason === "length").length,
      repairCalls: allCalls.filter((call) => call.schema === "humanized_chat_lines").length,
      latencyMs: { median: quantile(elapsed, 0.5), p95: quantile(elapsed, 0.95), total: elapsed.reduce((a, b) => a + b, 0) },
      messageCharacters: { minimum: quantile(lengths, 0), median: quantile(lengths, 0.5), maximum: quantile(lengths, 1) },
    };
    await persist();
    if (scenarioReport.summary.errors) process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "longitudinal_complete", report: join(directory, "report.json"), manifest: join(directory, "manifest.json"), manifestHash, summaries: report.scenarios.map((scenario) => ({ id: scenario.id, ...scenario.summary })) }));
}

const results = [];
console.log(`Isolated live evaluation; synthetic history only. ${reasoningNone ? "EXPERIMENT: social_scene reasoning_effort:none." : "Production inference settings."} Results: ${outputDirectory}`);
for (const fixture of selectedFixtures) {
  const { backend, calls } = observedBackend();
  const client = new LmStudioClient({ backend, now: () => now, maxConcurrentPredictions: 1, maxBackgroundPredictions: 1 });
  const health = await client.probe();
  if (!health.connected) throw new Error(`Model unavailable: ${health.label}`);
  const actorChannels = new ActorChannelRuntime();
  const profile = getChannelProfile(fixture.channelId);
  const seedIndex = fixture.seedFamily ? profile?.ambientPremiseFamilies?.indexOf(fixture.seedFamily) ?? -1 : -1;
  if (fixture.seedFamily && (seedIndex < 0 || profile.ambientPremiseGrounding?.[seedIndex] === "fresh_research")) {
    throw new Error(`Fixture requires a current, unsourced-safe room seed: ${fixture.seedFamily}`);
  }
  const roomSeed = seedIndex < 0 ? undefined : profile.ambientPremises[seedIndex];
  const published = fixture.rows.map(([author, kind, content], index) => ({
    messageId: `${fixture.id}-seed-${index}`, author, kind, content,
    authorId: kind === "human" ? "synthetic-eval-guest" : PERSONAS.find((entry) => entry.name === author)?.id,
    createdAt: new Date(now - (fixture.rows.length - index) * 30_000).toISOString(),
  }));
  const initialRows = [...published];
  const humanRoot = [...published].reverse().find((row) => row.kind === "human");
  let rootMessageId = humanRoot?.messageId ?? published[0]?.messageId;
  const turns = [];
  let stopReason = "candidate_sample_complete";
  function* candidateTurns() {
    if (!fixture.autonomous) {
      yield* fixture.candidates.entries();
      return;
    }
    let cursor = 0;
    let quietCandidateIds = [];
    // No assigned conversational moves and no forced minimum length. The only
    // scheduling controls are the production opportunity policy and fair
    // rotation among its eligible residents. A hard attempt bound is defensive.
    for (let index = 0; index < 24; index += 1) {
      const opportunity = conversationOpportunity({
        publishedCount: published.length,
        lastAuthorId: published.at(-1)?.authorId,
        quietCandidateIds,
        eligibleIds: fixture.candidates,
      });
      if (opportunity.status !== "ready") {
        stopReason = opportunity.status;
        return;
      }
      let personaId;
      for (let offset = 0; offset < fixture.candidates.length; offset += 1) {
        const position = (cursor + offset) % fixture.candidates.length;
        if (!opportunity.candidateIds.includes(fixture.candidates[position])) continue;
        personaId = fixture.candidates[position];
        cursor = (position + 1) % fixture.candidates.length;
        break;
      }
      if (!personaId) throw new Error("Opportunity returned no usable resident");
      yield [index, personaId];
      const result = turns.at(-1);
      if (result.error) {
        // Do not call a provider failure social abstention in the live report.
        stopReason = "execution_error";
        return;
      }
      if (!published.length && !result.lines.length) {
        stopReason = "opening_abstained_or_rejected";
        return;
      }
      quietCandidateIds = result.lines.length ? [] : [...new Set([...quietCandidateIds, personaId])];
    }
    stopReason = "evaluation_attempt_bound";
  }
  console.log(`\n=== ${fixture.id} (${health.label}) ===\nHuman review: ${fixture.question}`);
  if (roomSeed) console.log(`Current room seed (${fixture.seedFamily}): ${roomSeed}`);
  for (const row of published) console.log(`${row.author}: ${row.content}`);
  for (const [index, personaId] of candidateTurns()) {
    const persona = personaById(personaId);
    const required = fixture.required?.includes(personaId) === true;
    // Mirror production's sequential public contract: optional followers react
    // to the actual last committed turn, while the original human stays in the
    // bounded conversation root. They do not re-answer the original trigger.
    const triggerRow = required ? humanRoot : published.at(-1);
    const triggerPersona = triggerRow?.kind === "ai"
      ? PERSONAS.find((entry) => entry.id === triggerRow.authorId)
      : undefined;
    const firstCall = calls.length;
    const started = performance.now();
    let lines = [];
    let error = null;
    try {
      lines = await client.generateScene({
        kind: fixture.kind,
        channelId: fixture.channelId,
        channelName: fixture.channelId,
        selected: [persona],
        history: published.map(({ messageId: _id, ...row }) => row),
        conversationContext: buildConversationContext({ phase: published.length ? "continuation" : "opening", rootMessageId, messages: published }),
        ...(roomSeed && !published.length ? {
          ambientAction: {
            episodeId: `${fixture.id}-episode`, causalRootId: `${fixture.id}-opening`,
            semanticFamily: fixture.seedFamily, kind: "open_topic", turnIndex: 0,
            openHook: false, previousActions: [],
          },
          premise: autonomousOpeningPremise(roomSeed),
        } : {}),
        ...((roomSeed || fixture.peerReactions) && published.length ? {
          premise: AUTONOMOUS_CONTINUATION_PREMISE,
        } : {}),
        ...(fixture.autonomous || fixture.peerReactions ? { wordLimits: { [personaId]: { minimum: 1, maximum: autonomousConversationWordCeiling(persona.style) } } } : {}),
        ...(fixture.kind === "public" && triggerRow ? { trigger: {
          authorId: triggerPersona?.id ?? "synthetic-eval-guest",
          authorKind: triggerRow.kind, author: triggerRow.author,
          content: triggerRow.content, messageId: triggerRow.messageId, createdAt: triggerRow.createdAt,
        } } : {}),
        mustReplyIds: required ? [personaId] : [],
        responseRecoveryIds: required ? [personaId] : [],
        languageHint: fixture.languageTag,
        semanticContext: {
          languageTag: fixture.languageTag,
          ...(fixture.kind === "public" ? {
            replyExpected: required ? "expected" : "optional",
            answerDepth: "normal",
            reactionNeed: "none",
          } : {}),
          asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false,
        },
        actorChannelNotes: actorChannels.promptNotes([persona], fixture.channelId),
        actorExpertiseNotes: actorChannels.expertiseNotes([persona], fixture.channelId),
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const observedCalls = calls.slice(firstCall);
    const generationCalls = observedCalls.filter((call) => call.schema === "social_scene");
    const explicitEmpty = generationCalls.length > 0 && generationCalls.every((call) =>
      Array.isArray(call.parsed?.messages) && call.parsed.messages.length === 0);
    const outcome = error ? "execution_error" : lines.length ? "reviewed_publication"
      : explicitEmpty ? "model_chose_empty" : "draft_not_published";
    const turn = { personaId, elapsedMs: Math.round(performance.now() - started), outcome, lines, error, calls: observedCalls };
    turns.push(turn);
    console.log(`[${persona.name}: ${outcome}, ${(turn.elapsedMs / 1000).toFixed(1)}s, ${observedCalls.length} model calls]`);
    for (const [lineIndex, line] of lines.entries()) {
      const speaker = personaById(line.personaId);
      published.push({
        messageId: `${fixture.id}-reviewed-${index}-${lineIndex}`,
        authorId: speaker.id, author: speaker.name, kind: "ai", content: line.content,
        createdAt: new Date(now + (index + 1) * 5_000).toISOString(),
        ...(line.replyToMessageId ? { replyToMessageId: line.replyToMessageId } : {}),
      });
      rootMessageId ??= published[0].messageId;
      client.rememberDeliveredLine(line.personaId, line.content, {
        kind: fixture.kind, channelId: fixture.channelId, channelName: fixture.channelId,
      });
      console.log(`${speaker.name}: ${line.content}`);
    }
    if (error) console.log(`Error: ${error}`);
    // Persist after every candidate so an interrupted evaluation remains inspectable.
    await writeFile(join(outputDirectory, `${fixture.id}.json`), JSON.stringify({
      fixtureId: fixture.id, question: fixture.question, model: health.label,
      label: runLabel, runtimeRoot: runtimeRoot ?? "working-source",
      inferenceMode: reasoningNone ? "experimental-social-scene-reasoning-none" : "production",
      ...(roomSeed ? { roomSeed, seedFamily: fixture.seedFamily } : {}),
      initialRows, turns, published,
    }, null, 2));
  }
  const summary = {
    fixtureId: fixture.id,
    stopReason,
    publishedTranscriptLength: published.length,
    initialScriptedRows: initialRows.length,
    candidateCount: turns.length,
    speakerCount: new Set(turns.flatMap((turn) => turn.lines.map((line) => line.personaId))).size,
    reviewedMessages: turns.reduce((sum, turn) => sum + turn.lines.length, 0),
    chosenEmpty: turns.filter((turn) => turn.outcome === "model_chose_empty").length,
    unpublishedDrafts: turns.filter((turn) => turn.outcome === "draft_not_published").length,
    errors: turns.filter((turn) => turn.error).length,
    elapsedMs: turns.reduce((sum, turn) => sum + turn.elapsedMs, 0),
  };
  results.push(summary);
  console.log(`Summary: ${JSON.stringify(summary)}`);
}
const report = {
  generatedAt: new Date().toISOString(),
  label: runLabel,
  runtimeRoot: runtimeRoot ?? "working-source",
  inferenceMode: reasoningNone ? "experimental-social-scene-reasoning-none" : "production",
  reviewAxes,
  notes: [
    "Only production-reviewed output is committed to subsequent synthetic history.",
    "Semantic quality is deliberately reviewed by a person, not keyword assertions.",
    "Model-chosen empty is explicit messages:[]; the API does not explain the social reason for abstention.",
    "Unpublished drafts include semantic/mechanical rejection or unavailable review; inspect recorded review responses.",
    "Autonomous fixtures use production conversationOpportunity; non-autonomous cases deliberately sample their listed candidates even if two abstain.",
    "The substance suite is exploratory: no automatic quality pass/fail, compulsory fact density, named entity, disagreement or conversation length.",
    "This exercises generation/review and opportunity bounds, not director timers, live load, research, transport or persistent memory.",
  ],
  results,
};
await writeFile(join(outputDirectory, "summary.json"), JSON.stringify(report, null, 2));
console.log(`\nReport: ${join(outputDirectory, "summary.json")}`);
if (results.some((result) => result.errors > 0)) process.exitCode = 1;
