import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { PERSONAS } from "./personas.js";
import { setAdminPersonaVoiceMappings } from "./personaVoices.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis, type TurnAnalysisInput } from "./semanticRouter.js";
import { mentionsPersona, routedLanguage, VoiceDirector, sanitizeSpokenLine, ttsModelSupportsLanguage } from "./voiceDirector.js";
import { VoiceRoomRuntime } from "./voiceRooms.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const routedAnalysis = (
  languageTag = "sv-SE",
  options: {
    addressedIds?: string[];
    addressConfidence?: number;
    asksAboutAcoustics?: boolean;
    asksAboutAiIdentity?: boolean;
  } = {},
): TurnAnalysis => {
  const fallback = createFailClosedTurnAnalysis("model_unavailable");
  return {
    ...fallback,
    source: "lm",
    failureReason: null,
    language: { tag: languageTag, confidence: 0.99 },
    intent: {
      kind: options.asksAboutAiIdentity
        ? "identity_question"
        : "question",
      isQuestion: true,
      replyExpected: "expected",
      confidence: 0.95,
    },
    personas: {
      ...fallback.personas,
      addressedIds: options.addressedIds ?? [],
      requestedReplyIds: options.addressedIds ?? [],
      addressConfidence: options.addressConfidence ?? (options.addressedIds?.length ? 0.95 : 0),
    },
    capabilities: {
      ...fallback.capabilities,
      asksAboutAcoustics: options.asksAboutAcoustics ?? false,
      asksAboutAiIdentity: options.asksAboutAiIdentity ?? false,
      confidence: 0.95,
    },
  } as TurnAnalysis;
};
const analyzeSwedish = async (_input: TurnAnalysisInput): Promise<TurnAnalysis> => routedAnalysis();

const languageAnalysis = (
  latestTag: string,
  latestConfidence: number,
  responseTag?: string,
  responseConfidence = latestConfidence,
): TurnAnalysis => ({
  ...routedAnalysis(latestTag),
  language: { tag: latestTag, confidence: latestConfidence },
  ...(responseTag ? { responseLanguage: { tag: responseTag, confidence: responseConfidence } } : {}),
}) as TurnAnalysis;

interface LanguageTurnOptions {
  analysis: TurnAnalysis;
  utterance: string;
  utteranceOrigin?: "microphone-stt" | "typed-voice-fallback";
  transcriptLanguage?: string;
  establishedChannelLanguage?: string;
  priorAiLanguage?: string;
  recentChannelMessages?: Array<{
    id: string;
    authorId: string;
    authorName: string;
    content: string;
    createdAt: string;
  }>;
  reply?: string;
  onAnalyze?: () => void;
}

const runLanguageTurn = async (options: LanguageTurnOptions) => {
  const runtime = new VoiceRoomRuntime(["lobby"]);
  const created = runtime.createRoom("lobby", {
    socketId: "socket-language-anchor",
    memberId: "human-language-anchor",
    name: "Alex",
  });
  if (!created.ok) throw new Error(created.error);
  const invited = runtime.inviteBot(created.room.id, "socket-language-anchor", { personaId: "ai-sana", name: "Sana" });
  if (!invited.ok) throw new Error(invited.error);
  runtime.setBotState(created.room.id, "ai-sana", "listening");
  if (options.priorAiLanguage) {
    const prior = runtime.appendFinalTranscript(created.room.id, "ai-sana", "Ett tidigare svar i röstsamtalet.", {
      utteranceOrigin: "ai-tts",
      language: options.priorAiLanguage,
    });
    if (!prior.ok) throw new Error(prior.error);
  }
  const human = runtime.appendFinalTranscript(created.room.id, "human-language-anchor", options.utterance, {
    utteranceOrigin: options.utteranceOrigin ?? "microphone-stt",
    ...(options.transcriptLanguage ? { language: options.transcriptLanguage } : {}),
  });
  if (!human.ok) throw new Error(human.error);

  let analysisInput: TurnAnalysisInput | undefined;
  let sceneLanguage: string | undefined;
  let scenePremise: string | undefined;
  const syntheses: Array<Record<string, unknown>> = [];
  const payloads: Array<Record<string, unknown>> = [];
  const director = new VoiceDirector({
    runtime,
    lm: {
      analyzeTurn: async (input) => {
        analysisInput = input;
        options.onAnalyze?.();
        return options.analysis;
      },
      generateScene: async (request) => {
        sceneLanguage = request.semanticContext?.languageTag;
        scenePremise = request.premise;
        return [{
          personaId: "ai-sana",
          content: options.reply ?? "Ett kort och naturligt svar.",
          source: "lm",
          sourceIds: [],
        }];
      },
    },
    speech: {
      capabilities: async () => ({
        stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
        tts: {
          available: true,
          provider: "openai-compatible",
          model: "generic-multilingual",
          formats: ["mp3"],
          defaultVoice: "provider-default",
          supportedLanguages: ["sv", "en", "ja"],
        },
        normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
        browserFallbackAllowed: false,
      }),
      synthesize: async (input) => {
        syntheses.push(input as unknown as Record<string, unknown>);
        return {
          id: "anchored-audio",
          roomId: created.room.id,
          mimeType: "audio/mpeg",
          bytes: 64,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    },
    actorChannels: new ActorChannelRuntime(),
    ...(options.establishedChannelLanguage
      ? { establishedChannelLanguage: () => options.establishedChannelLanguage }
      : {}),
    ...(options.recentChannelMessages
      ? { recentChannelMessages: () => options.recentChannelMessages! }
      : {}),
    events: {
      roomChanged: () => undefined,
      transcriptFinal: () => undefined,
      aiSpeech: (payload) => payloads.push(payload as unknown as Record<string, unknown>),
      aiStop: () => undefined,
    },
  });

  director.onHumanFinal(human.entry);
  await settle();
  return {
    analysisInput,
    director,
    payloads,
    roomId: created.room.id,
    runtime,
    sceneLanguage,
    scenePremise,
    syntheses,
  };
};

const installCustomPersona = (id: string, name: string): (() => void) => {
  const template = structuredClone(PERSONAS.find((persona) => persona.id === "ai-sana")!);
  PERSONAS.push({ ...template, id, name, prompt: `${name} answers directly and naturally.` });
  return () => {
    const index = PERSONAS.findIndex((persona) => persona.id === id);
    if (index >= 0) PERSONAS.splice(index, 1);
  };
};

describe("VoiceDirector", () => {
  it.each([
    {
      name: "keeps an anchor when only raw STT points elsewhere",
      analysis: createFailClosedTurnAnalysis("model_unavailable"),
      stt: "en-US",
      established: "sv-SE",
      expected: "sv-SE",
    },
    {
      name: "keeps an anchor for a high-confidence legacy classification",
      analysis: languageAnalysis("en-US", 0.99),
      stt: "en-US",
      established: "sv-SE",
      expected: "sv-SE",
    },
    {
      name: "keeps an anchor when the contextual response preserves it",
      analysis: languageAnalysis("en-US", 0.99, "sv-SE", 0.99),
      stt: "en-US",
      established: "sv-SE",
      expected: "sv-SE",
    },
    {
      name: "keeps an anchor when latest-message confidence is below the switch threshold",
      analysis: languageAnalysis("en-US", 0.89, "en-GB", 0.99),
      stt: "en-US",
      established: "sv-SE",
      expected: "sv-SE",
    },
    {
      name: "keeps the established locale when the primary language is unchanged",
      analysis: languageAnalysis("sv", 0.99, "sv", 0.99),
      stt: "sv",
      established: "sv-SE",
      expected: "sv-SE",
    },
    {
      name: "accepts a clear v2 switch when latest and response primary languages agree",
      analysis: languageAnalysis("en-US", 0.9, "en-GB", 0.9),
      stt: "fr-FR",
      established: "sv-SE",
      expected: "en-GB",
    },
    {
      name: "uses a trusted contextual response when no anchor exists",
      analysis: languageAnalysis("en-US", 0.8, "sv-SE", 0.8),
      stt: "en-US",
      established: undefined,
      expected: "sv-SE",
    },
    {
      name: "uses a high-confidence semantic latest language when no v2 response is trusted",
      analysis: languageAnalysis("ja-JP", 0.95, "en-US", 0.69),
      stt: "zh-Hant-TW",
      established: undefined,
      expected: "ja-JP",
    },
    {
      name: "does not route from unscored STT alone",
      analysis: createFailClosedTurnAnalysis("model_unavailable"),
      stt: "en-US",
      established: undefined,
      expected: undefined,
    },
  ])("$name", ({ analysis, stt, established, expected }) => {
    expect(routedLanguage(analysis, stt, established)).toBe(expected);
  });

  it("anchors a first short mistagged microphone turn to its channel and supplies bounded public context", async () => {
    const recentChannelMessages = Array.from({ length: 12 }, (_, index) => ({
      id: `public-${index}`,
      authorId: index % 2 === 0 ? "human-public" : "ai-sana",
      authorName: index === 11 ? "S".repeat(100) : index % 2 === 0 ? "Alex" : "Sana",
      content: index === 11 ? `svensk kanaltext ${"x".repeat(1_300)}` : `svensk kanaltext ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 12, index)).toISOString(),
    }));
    recentChannelMessages.push({
      id: "public-from-the-future",
      authorId: "human-future",
      authorName: "Future",
      content: "This arrived after the voice turn and must not affect it.",
      createdAt: "9999-01-01T00:00:00.000Z",
    });
    const turn: LanguageTurnOptions = {
      analysis: languageAnalysis("sr", 0.4, "sr", 0.4),
      utterance: "hej",
      transcriptLanguage: "sr",
      establishedChannelLanguage: "sv-SE",
      recentChannelMessages,
    };
    turn.onAnalyze = () => {
      // Simulate the public channel changing while semantic analysis is in flight.
      // This voice turn must keep the channel snapshot taken when it became final.
      turn.establishedChannelLanguage = "en-US";
    };
    const result = await runLanguageTurn(turn);

    expect(result.analysisInput?.transportLanguageHint).toBe("sr");
    expect(result.analysisInput?.recentMessages.map((message) => message.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `public-${index + 4}`),
    );
    expect(result.analysisInput?.recentMessages.at(-1)).toMatchObject({
      authorName: "S".repeat(80),
      content: expect.stringMatching(/^svensk kanaltext /u),
    });
    expect(result.analysisInput?.recentMessages.at(-1)?.content).toHaveLength(1_200);
    expect(result.sceneLanguage).toBe("sv-SE");
    expect(result.syntheses).toEqual([expect.objectContaining({ language: "sv-SE" })]);
    expect(result.payloads).toEqual([expect.objectContaining({ language: "sv-SE" })]);
    expect(result.runtime.getTranscript(result.roomId).at(-1)).toMatchObject({
      speakerKind: "ai",
      language: "sv-SE",
    });
  });

  it("carries the same referent-aware diegetic identity contract into voice turns", async () => {
    const result = await runLanguageTurn({
      analysis: routedAnalysis("sv-SE", { asksAboutAiIdentity: true }),
      utterance: "Säger du att jag är en bot?",
      reply: "Nä, det sa jag inte. Du är Alex.",
    });

    expect(result.scenePremise).toContain("answer the actual person or claim the human referred to");
    expect(result.scenePremise).toContain("If this resident is accused, deny or playfully dismiss it");
    expect(result.scenePremise).toContain("never volunteer the resident's own implementation identity as a contrast");
    expect(result.payloads).toEqual([expect.objectContaining({ text: "Nä, det sa jag inte. Du är Alex." })]);
  });

  it("inherits a prior AI response language for a typed voice fallback", async () => {
    const result = await runLanguageTurn({
      analysis: createFailClosedTurnAnalysis("model_unavailable"),
      utterance: "Okej?",
      utteranceOrigin: "typed-voice-fallback",
      priorAiLanguage: "sv-SE",
    });

    expect(result.analysisInput?.transportLanguageHint).toBeUndefined();
    expect(result.sceneLanguage).toBe("sv-SE");
    expect(result.syntheses).toEqual([expect.objectContaining({ language: "sv-SE" })]);
    expect(result.payloads).toEqual([expect.objectContaining({ language: "sv-SE" })]);
    expect(result.runtime.getTranscript(result.roomId).at(-1)?.language).toBe("sv-SE");
  });

  it("lets a clear high-confidence v2 language switch replace the voice-session anchor", async () => {
    const turn = {
      analysis: languageAnalysis("en-US", 0.98, "en-GB", 0.97),
      utterance: "Let's continue this discussion in English.",
      transcriptLanguage: "en-US",
      priorAiLanguage: "sv-SE",
      reply: "Yes, let's continue in English.",
    };
    const result = await runLanguageTurn(turn);

    expect(result.sceneLanguage).toBe("en-GB");
    expect(result.syntheses).toEqual([expect.objectContaining({ language: "en-GB" })]);
    expect(result.payloads).toEqual([expect.objectContaining({ language: "en-GB" })]);
    expect(result.runtime.getTranscript(result.roomId).at(-1)?.language).toBe("en-GB");

    turn.analysis = createFailClosedTurnAnalysis("model_unavailable");
    const followUp = result.runtime.appendFinalTranscript(
      result.roomId,
      "human-language-anchor",
      "Okay?",
      { utteranceOrigin: "typed-voice-fallback" },
    );
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    result.director.onHumanFinal(followUp.entry);
    await settle();

    expect(result.syntheses.at(-1)).toMatchObject({ language: "en-GB" });
    expect(result.payloads.at(-1)).toMatchObject({ language: "en-GB" });
    expect(result.runtime.getTranscript(result.roomId).at(-1)?.language).toBe("en-GB");
  });

  it("does not commit a language switch when its AI reply is not delivered", async () => {
    const turn: LanguageTurnOptions = {
      analysis: languageAnalysis("en-US", 0.99, "en-GB", 0.99),
      utterance: "Let's switch to English.",
      transcriptLanguage: "en-US",
      priorAiLanguage: "sv-SE",
      reply: "",
    };
    const result = await runLanguageTurn(turn);
    expect(result.payloads).toHaveLength(0);

    turn.analysis = createFailClosedTurnAnalysis("model_unavailable");
    turn.reply = "Vi fortsätter på svenska.";
    const followUp = result.runtime.appendFinalTranscript(
      result.roomId,
      "human-language-anchor",
      "Okej?",
      { utteranceOrigin: "typed-voice-fallback" },
    );
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    result.director.onHumanFinal(followUp.entry);
    await settle();

    expect(result.syntheses.at(-1)).toMatchObject({ language: "sv-SE" });
    expect(result.payloads.at(-1)).toMatchObject({ language: "sv-SE" });
    expect(result.runtime.getTranscript(result.roomId).at(-1)?.language).toBe("sv-SE");
  });

  it("turns one final human utterance into one bounded AI turn without recursion", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-a", memberId: "human-a", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const invited = runtime.inviteBot(created.room.id, "socket-a", { personaId: "ai-sana", name: "Sana" });
    expect(invited.ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-a", "Sana, vad tycker du om den idén?");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const transcripts: string[] = [];
    const speeches: string[] = [];
    let generated = 0;
    let requestOwnerIds: string[] | undefined;
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: analyzeSwedish,
        generateScene: async (request) => {
          generated += 1;
          requestOwnerIds = request.requestOwnerIds;
          return [{ personaId: "ai-sana", content: "**Bra grund.** Jag skulle testa den med fem användare först ✨ https://bad.invalid", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: (entry) => transcripts.push(entry.text),
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();
    expect(generated).toBe(1);
    expect(requestOwnerIds).toEqual(["ai-sana"]);
    expect(transcripts).toEqual(["Bra grund. Jag skulle testa den med fem användare först"]);
    expect(speeches).toEqual(transcripts);
    const aiEntry = runtime.getTranscript(created.room.id).at(-1)!;
    expect(aiEntry.trigger).toEqual({ eligible: false, source: "ai-final" });
    director.onHumanFinal(aiEntry);
    await settle();
    expect(generated).toBe(1);
  });

  it("synthesizes with the resident's stable provider voice and publishes safe fallback controls", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-tts", memberId: "human-tts", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-tts", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-tts", "Sana, säg något kort.");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const syntheses: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: analyzeSwedish,
        generateScene: async () => [{ personaId: "ai-sana", content: "Absolut, jag hör dig.", source: "lm", sourceIds: [] }],
      },
      speech: {
        capabilities: async () => ({
          stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
          tts: {
            available: true,
            provider: "openai-compatible",
            model: "piper-sv",
            formats: ["wav"],
            defaultVoice: "lisa-warm",
            supportedLanguages: ["sv"],
          },
          normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
          browserFallbackAllowed: false,
        }),
        synthesize: async (input) => {
          syntheses.push(input as unknown as Record<string, unknown>);
          return {
            id: "audio-id",
            roomId: created.room.id,
            mimeType: "audio/wav",
            bytes: 128,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => payloads.push(payload as unknown as Record<string, unknown>),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(syntheses).toHaveLength(1);
    expect(syntheses[0]).toMatchObject({
      roomId: created.room.id,
      text: "Absolut, jag hör dig.",
      voice: "lisa-warm",
      language: "sv-SE",
      speed: 0.98,
    });
    expect(payloads).toEqual([expect.objectContaining({
      memberId: "ai-sana",
      audioUrl: `/api/voice/audio/audio-id?roomId=${created.room.id}`,
      mimeType: "audio/wav",
      browserFallbackAllowed: false,
      language: "sv-SE",
      browserRate: 0.97,
      browserPitch: 1,
    })]);
  });

  it("uses prior rapport for a voice reply and only strengthens that persona relationship", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-memory", memberId: "human-memory", name: "Kim" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const invited = runtime.inviteBot(created.room.id, "socket-memory", { personaId: "ai-sana", name: "Sana" });
    expect(invited.ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-memory", "Sana, minns du mig?");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const callOrder: string[] = [];
    let sceneRelationshipNotes: Record<string, string> | undefined;
    const relationUpdates: Array<{ humanId: string; personaId: string; familiarity?: number }> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async () => {
          callOrder.push("analyze");
          return routedAnalysis();
        },
        generateScene: async (request) => {
          callOrder.push("generate");
          sceneRelationshipNotes = request.relationshipNotes;
          return [{ personaId: "ai-sana", content: "Ja, lite faktiskt. Kul att höra dig igen.", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      humanMemory: {
        promptNote: (humanId, personaId) => {
          callOrder.push("promptNote");
          expect([humanId, personaId]).toEqual(["human-memory", "ai-sana"]);
          return "Fallible prior memory: Kim has visited before; keep recognition subtle.";
        },
        getRelation: () => {
          callOrder.push("getRelation");
          return { familiarity: 0.4, affinity: 0.2, irritation: 0, updatedAt: 1_000 };
        },
        updateRelation: (humanId, personaId, update) => {
          callOrder.push("updateRelation");
          relationUpdates.push({ humanId, personaId, ...update });
          return { familiarity: update.familiarity ?? 0.4, affinity: 0.2, irritation: 0, updatedAt: 2_000 };
        },
      },
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: () => undefined,
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(sceneRelationshipNotes).toEqual({
      "ai-sana": "Fallible prior memory: Kim has visited before; keep recognition subtle.",
    });
    expect(relationUpdates).toEqual([{
      humanId: "human-memory",
      personaId: "ai-sana",
      familiarity: 0.45,
    }]);
    expect(callOrder).toEqual(["analyze", "promptNote", "getRelation", "generate", "updateRelation"]);
  });

  it("routes an acoustic question semantically and supplies trusted voice transport context", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-jaw", memberId: "human-jaw", name: "Jaw_B" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.joinRoom(created.room.id, { socketId: "socket-lina", memberId: "human-lina", name: "Lina" }).ok).toBe(true);
    expect(runtime.inviteBot(created.room.id, "socket-jaw", { personaId: "ai-mira", name: "Mira" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-mira", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-jaw", "Jeg skriker vel ikke?", {
      utteranceOrigin: "microphone-stt",
    });
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    let analysisInput: TurnAnalysisInput | undefined;
    let seenVoiceContext: Parameters<ConstructorParameters<typeof VoiceDirector>[0]["lm"]["generateScene"]>[0]["voiceContext"];
    let seenLanguageHint: string | undefined;
    let seenPremise: string | undefined;
    const speeches: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async (input) => {
          analysisInput = input;
          return routedAnalysis("nb-NO", { asksAboutAcoustics: true });
        },
        generateScene: async (request) => {
          seenVoiceContext = request.voiceContext;
          seenLanguageHint = request.languageHint;
          seenPremise = request.premise;
          return [{
            personaId: "ai-mira",
            content: "Det kan jeg ikke avgjøre uten pålitelig lydinformasjon.",
            source: "lm",
            sourceIds: [],
          }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(analysisInput).toMatchObject({
      medium: "voice",
      channel: { id: "lobby", name: "lobby" },
      latestMessage: { authorId: "human-jaw", content: "Jeg skriker vel ikke?" },
      availableCapabilities: ["local_datetime"],
      urlCandidates: [],
      personaCandidates: [{ id: "ai-mira", name: "Mira" }],
    });
    expect(seenVoiceContext).toEqual({
      latestSpeakerId: "human-jaw",
      latestUtteranceOrigin: "microphone-stt",
      acousticEvidenceAvailable: false,
      participants: [
        { memberId: "human-jaw", name: "Jaw_B", kind: "human" },
        { memberId: "human-lina", name: "Lina", kind: "human" },
        { memberId: "ai-mira", name: "Mira", kind: "ai" },
      ],
    });
    expect(seenLanguageHint).toBe("nb-NO");
    expect(seenPremise).toContain("asksAboutAcoustics=true");
    expect(speeches).toEqual(["Det kan jeg ikke avgjøre uten pålitelig lydinformasjon."]);
    expect(runtime.getTranscript(created.room.id).at(-1)).toMatchObject({
      speakerId: "ai-mira",
      utteranceOrigin: "ai-tts",
    });
  });

  it.each([
    ["sv-SE", "Vad tycker du om idén?"],
    ["nb-NO", "Hva synes du om ideen?"],
    ["de-DE", "Was hältst du von der Idee?"],
    ["fr-FR", "Que penses-tu de cette idée ?"],
    ["es-ES", "¿Qué opinas de esta idea?"],
  ])("uses one multilingual analysis plan for %s voice input", async (languageTag, utterance) => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: `socket-${languageTag}`, memberId: `human-${languageTag}`, name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, `socket-${languageTag}`, { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, `human-${languageTag}`, utterance);
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const analysisInputs: TurnAnalysisInput[] = [];
    const languageHints: Array<string | undefined> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async (input) => {
          analysisInputs.push(input);
          return routedAnalysis(languageTag);
        },
        generateScene: async (request) => {
          languageHints.push(request.languageHint);
          return [{ personaId: "ai-sana", content: "En kort naturlig replik.", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: () => undefined,
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(analysisInputs).toHaveLength(1);
    expect(analysisInputs[0]).toMatchObject({
      medium: "voice",
      latestMessage: { content: utterance },
      availableCapabilities: ["local_datetime"],
      urlCandidates: [],
    });
    expect(languageHints).toEqual([languageTag]);
  });

  it("uses high-confidence inferred targets while an explicit @mention wins deterministically", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-target", memberId: "human-target", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-target", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    expect(runtime.inviteBot(created.room.id, "socket-target", { personaId: "ai-mira", name: "Mira" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    runtime.setBotState(created.room.id, "ai-mira", "listening");
    const generatedBy: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async () => routedAnalysis("de-DE", {
          addressedIds: ["ai-mira"],
          addressConfidence: 0.97,
        }),
        generateScene: async (request) => {
          const selected = request.selected[0]!;
          generatedBy.push(selected.id);
          return [{ personaId: selected.id, content: "Klar, ich antworte kurz.", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: () => undefined,
        aiStop: () => undefined,
      },
    });

    const inferred = runtime.appendFinalTranscript(created.room.id, "human-target", "Mira kann das bestimmt beantworten.");
    expect(inferred.ok).toBe(true);
    if (!inferred.ok) return;
    director.onHumanFinal(inferred.entry);
    await settle();
    const explicit = runtime.appendFinalTranscript(created.room.id, "human-target", "@Sana, bitte du diesmal.");
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    director.onHumanFinal(explicit.entry);
    await settle();

    expect(generatedBy).toEqual(["ai-mira", "ai-sana"]);
  });

  it("uses a neutral language instruction and publishes no canned line when analysis or generation is unavailable", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-offline", memberId: "human-offline", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-offline", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-offline", "Pouvez-vous répondre ?", {
      language: "und",
    });
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    let languageHint: string | undefined;
    let semanticLanguage: string | undefined;
    let analysisInput: TurnAnalysisInput | undefined;
    const speeches: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async (input) => {
          analysisInput = input;
          return createFailClosedTurnAnalysis("model_unavailable");
        },
        generateScene: async (request) => {
          languageHint = request.languageHint;
          semanticLanguage = request.semanticContext?.languageTag;
          return [];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(languageHint).toBe("infer and mirror the language of the latest human utterance directly");
    expect(semanticLanguage).toBeUndefined();
    expect(analysisInput?.transportLanguageHint).toBeUndefined();
    expect(speeches).toEqual([]);
    expect(runtime.getTranscript(created.room.id)).toHaveLength(1);
    expect(runtime.getRoom(created.room.id)?.participants.find((participant) => participant.memberId === "ai-sana")?.botState)
      .toBe("listening");
  });

  it("keeps a canonical STT language as router metadata while routing from high-confidence semantics", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-stt-language", memberId: "human-stt-language", name: "陳明" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-stt-language", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-stt-language", "你覺得呢？", {
      utteranceOrigin: "microphone-stt",
      language: "zh-Hant-TW-u-ca-chinese",
    });
    expect(human.ok).toBe(true);
    if (!human.ok) return;
    expect(human.entry.language).toBe("zh-Hant-TW");

    let languageHint: string | undefined;
    let semanticLanguage: string | undefined;
    let analysisInput: TurnAnalysisInput | undefined;
    const speeches: Array<Record<string, unknown>> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async (input) => {
          analysisInput = input;
          return routedAnalysis("ja-JP");
        },
        generateScene: async (request) => {
          languageHint = request.languageHint;
          semanticLanguage = request.semanticContext?.languageTag;
          return [{ personaId: "ai-sana", content: "我覺得可以先小規模試試看。", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload as unknown as Record<string, unknown>),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(languageHint).toBe("ja-JP");
    expect(semanticLanguage).toBe("ja-JP");
    expect(analysisInput?.transportLanguageHint).toBe("zh-Hant-TW");
    expect(speeches).toEqual([expect.objectContaining({ language: "ja-JP" })]);
    expect(runtime.getTranscript(created.room.id).at(-1)?.language).toBe("ja-JP");
  });

  it("uses a generic provider's configured default voice, never a Piper persona alias", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-generic-tts", memberId: "human-generic-tts", name: "直子" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-generic-tts", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-generic-tts", "どう思う？", { language: "ja-JP" });
    expect(human.ok).toBe(true);
    if (!human.ok) return;
    const syntheses: Array<Record<string, unknown>> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: async () => routedAnalysis("ja-JP"),
        generateScene: async () => [{ personaId: "ai-sana", content: "まず小さく試すのがいいと思う。", source: "lm", sourceIds: [] }],
      },
      speech: {
        capabilities: async () => ({
          stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
          tts: {
            available: true,
            provider: "openai-compatible",
            model: "generic-multilingual",
            formats: ["mp3"],
            defaultVoice: "provider-default",
            supportedLanguages: ["ja"],
          },
          normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
          browserFallbackAllowed: true,
        }),
        synthesize: async (input) => {
          syntheses.push(input as unknown as Record<string, unknown>);
          return {
            id: "generic-audio",
            roomId: created.room.id,
            mimeType: "audio/mpeg",
            bytes: 10,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: () => undefined,
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(syntheses).toEqual([expect.objectContaining({
      voice: "provider-default",
      language: "ja-JP",
    })]);
    expect(syntheses[0]?.voice).not.toMatch(/^(?:lisa|nst)/u);
  });

  it("lets an admin-created resident inherit the provider default with neutral prosody", async () => {
    const personaId = "ai-admin-default-voice";
    const uninstall = installCustomPersona(personaId, "Aster");
    setAdminPersonaVoiceMappings({});
    try {
      const runtime = new VoiceRoomRuntime(["lobby"]);
      const created = runtime.createRoom("lobby", { socketId: "socket-custom-default", memberId: "human-custom-default", name: "Naoko" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(runtime.inviteBot(created.room.id, "socket-custom-default", { personaId, name: "Aster" }).ok).toBe(true);
      runtime.setBotState(created.room.id, personaId, "listening");
      const human = runtime.appendFinalTranscript(created.room.id, "human-custom-default", "どう思う？", { language: "ja-JP" });
      expect(human.ok).toBe(true);
      if (!human.ok) return;
      const syntheses: Array<Record<string, unknown>> = [];
      const director = new VoiceDirector({
        runtime,
        lm: {
          analyzeTurn: async () => routedAnalysis("ja-JP", { addressedIds: [personaId] }),
          generateScene: async () => [{ personaId, content: "まず小さく試そう。", source: "lm", sourceIds: [] }],
        },
        speech: {
          capabilities: async () => ({
            stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
            tts: {
              available: true,
              provider: "openai-compatible",
              model: "generic-multilingual",
              formats: ["mp3"],
              defaultVoice: "provider-default",
              supportedLanguages: ["ja"],
            },
            normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
            browserFallbackAllowed: true,
          }),
          synthesize: async (input) => {
            syntheses.push(input as unknown as Record<string, unknown>);
            return {
              id: "custom-default-audio",
              roomId: created.room.id,
              mimeType: "audio/mpeg",
              bytes: 10,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
          },
        },
        actorChannels: new ActorChannelRuntime(),
        events: {
          roomChanged: () => undefined,
          transcriptFinal: () => undefined,
          aiSpeech: () => undefined,
          aiStop: () => undefined,
        },
      });

      director.onHumanFinal(human.entry);
      await settle();

      expect(syntheses).toEqual([expect.objectContaining({
        voice: "provider-default",
        language: "ja-JP",
        speed: 1,
      })]);
    } finally {
      setAdminPersonaVoiceMappings({});
      uninstall();
    }
  });

  it("prefers an admin-created resident's explicit language voice over the provider default", async () => {
    const personaId = "ai-admin-mapped-voice";
    const uninstall = installCustomPersona(personaId, "Aster");
    setAdminPersonaVoiceMappings({ [personaId]: { ja: "ja-admin-voice" } });
    try {
      const runtime = new VoiceRoomRuntime(["lobby"]);
      const created = runtime.createRoom("lobby", { socketId: "socket-custom-mapped", memberId: "human-custom-mapped", name: "Naoko" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(runtime.inviteBot(created.room.id, "socket-custom-mapped", { personaId, name: "Aster" }).ok).toBe(true);
      runtime.setBotState(created.room.id, personaId, "listening");
      const human = runtime.appendFinalTranscript(created.room.id, "human-custom-mapped", "もう一度？", { language: "ja-JP" });
      expect(human.ok).toBe(true);
      if (!human.ok) return;
      const syntheses: Array<Record<string, unknown>> = [];
      const director = new VoiceDirector({
        runtime,
        lm: {
          analyzeTurn: async () => routedAnalysis("ja-JP", { addressedIds: [personaId] }),
          generateScene: async () => [{ personaId, content: "もちろん。", source: "lm", sourceIds: [] }],
        },
        speech: {
          capabilities: async () => ({
            stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
            tts: {
              available: true,
              provider: "openai-compatible",
              model: "generic-multilingual",
              formats: ["mp3"],
              defaultVoice: "provider-default",
              supportedLanguages: ["ja"],
            },
            normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
            browserFallbackAllowed: true,
          }),
          synthesize: async (input) => {
            syntheses.push(input as unknown as Record<string, unknown>);
            return {
              id: "custom-mapped-audio",
              roomId: created.room.id,
              mimeType: "audio/mpeg",
              bytes: 10,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
          },
        },
        actorChannels: new ActorChannelRuntime(),
        events: {
          roomChanged: () => undefined,
          transcriptFinal: () => undefined,
          aiSpeech: () => undefined,
          aiStop: () => undefined,
        },
      });

      director.onHumanFinal(human.entry);
      await settle();

      expect(syntheses).toEqual([expect.objectContaining({
        voice: "ja-admin-voice",
        language: "ja-JP",
        speed: 1,
      })]);
      expect(syntheses[0]?.voice).not.toBe("provider-default");
    } finally {
      setAdminPersonaVoiceMappings({});
      uninstall();
    }
  });

  it("answers a multilingual current-time voice request from the server clock without web access", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-time", memberId: "human-time", name: "Léa" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-time", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-time", "Quelle heure est-il en Suède maintenant ?");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    let analyzerInput: TurnAnalysisInput | undefined;
    let scenePremise = "";
    let requestedClock: { formatted: string; timeZone: string } | undefined;
    let temporalPolicy: string | undefined;
    const speeches: Array<Record<string, unknown>> = [];
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    const director = new VoiceDirector({
      runtime,
      now: () => now,
      lm: {
        analyzeTurn: async (input) => {
          analyzerInput = input;
          return {
            ...routedAnalysis("fr-FR"),
            evidence: {
              need: "required",
              action: "local_datetime",
              confidence: 0.99,
              query: null,
              urlRef: null,
              searchMode: null,
              timeZone: "Europe/Stockholm",
              timeKind: "current_time",
              locationLabel: "Suède",
            },
          };
        },
        generateScene: async (request) => {
          scenePremise = request.premise ?? "";
          requestedClock = request.requestedClock;
          temporalPolicy = request.temporalPolicy;
          now += 90_000;
          return [];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload as unknown as Record<string, unknown>),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(analyzerInput?.availableCapabilities).toEqual(["local_datetime"]);
    expect(scenePremise).toContain("trustedTemporalContext.requestedClock");
    expect(requestedClock?.timeZone).toBe("Europe/Stockholm");
    expect(requestedClock?.formatted).toContain("14:00:00");
    expect(temporalPolicy).toBe("direct_answer");
    expect(speeches[0]).toMatchObject({ language: "fr-FR" });
    expect(String(speeches[0]?.text)).toContain("14:01:30");
  });

  it("aborts in-flight generation and resets thinking bots after a committed catalog edit", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-catalog-generation", memberId: "human-catalog-generation", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-catalog-generation", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-catalog-generation", "Sana, vad tror du?");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    let generationSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aiStops: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: analyzeSwedish,
        generateScene: async (_request, _priority, signal) => {
          generationSignal = signal;
          markStarted?.();
          return await new Promise((resolve, reject) => {
            const fail = () => reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          });
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: () => undefined,
        aiStop: ({ roomId }) => aiStops.push(roomId),
      },
    });

    director.onHumanFinal(human.entry);
    await started;
    expect(runtime.getRoom(created.room.id)?.participants.find((participant) => participant.memberId === "ai-sana")?.botState).toBe("thinking");
    const stopCountBeforeCatalogEdit = aiStops.length;

    director.onCatalogChanged([created.room.id, created.room.id]);
    await settle();

    expect(generationSignal?.aborted).toBe(true);
    expect(runtime.getRoom(created.room.id)?.participants.find((participant) => participant.memberId === "ai-sana")?.botState).toBe("listening");
    expect(aiStops.slice(stopCountBeforeCatalogEdit)).toEqual([created.room.id]);
  });

  it("aborts in-flight synthesis and resets thinking bots after a committed catalog edit", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-catalog-tts", memberId: "human-catalog-tts", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-catalog-tts", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-catalog-tts", "Sana, säg det högt.");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    let synthesisSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const speeches: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: analyzeSwedish,
        generateScene: async () => [{ personaId: "ai-sana", content: "Det här är den gamla katalogversionen.", source: "lm", sourceIds: [] }],
      },
      speech: {
        capabilities: async () => ({
          stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
          tts: {
            available: true,
            provider: "openai-compatible",
            model: "piper-sv",
            formats: ["wav"],
            defaultVoice: "lisa-warm",
            supportedLanguages: ["sv"],
          },
          normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
          browserFallbackAllowed: true,
        }),
        synthesize: async (input) => {
          synthesisSignal = input.signal;
          markStarted?.();
          return await new Promise((resolve, reject) => {
            const fail = () => reject(input.signal?.reason ?? new Error("aborted"));
            if (input.signal?.aborted) fail();
            else input.signal?.addEventListener("abort", fail, { once: true });
          });
        },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await started;
    expect(runtime.getRoom(created.room.id)?.participants.find((participant) => participant.memberId === "ai-sana")?.botState).toBe("thinking");

    director.onCatalogChanged([created.room.id]);
    await settle();

    expect(synthesisSignal?.aborted).toBe(true);
    expect(runtime.getRoom(created.room.id)?.participants.find((participant) => participant.memberId === "ai-sana")?.botState).toBe("listening");
    expect(speeches).toEqual([]);
  });

  it("aborts the previous room generation when a newer human utterance arrives", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-a", memberId: "human-a", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-a", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const first = runtime.appendFinalTranscript(created.room.id, "human-a", "Första försöket.");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let firstSignal: AbortSignal | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let generationCount = 0;
    const speeches: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        analyzeTurn: analyzeSwedish,
        generateScene: async (_request, _priority, signal) => {
          generationCount += 1;
          if (generationCount === 1) {
            firstSignal = signal;
            markFirstStarted?.();
            return await new Promise((resolve, reject) => {
              const fail = () => reject(signal?.reason ?? new Error("aborted"));
              if (signal?.aborted) fail();
              else signal?.addEventListener("abort", fail, { once: true });
            });
          }
          return [{ personaId: "ai-sana", content: "Det andra försöket kom fram.", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(first.entry);
    await firstStarted;
    const second = runtime.appendFinalTranscript(created.room.id, "human-a", "Andra försöket.");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    director.onHumanFinal(second.entry);
    await settle();

    expect(firstSignal?.aborted).toBe(true);
    expect(generationCount).toBe(2);
    expect(speeches).toEqual(["Det andra försöket kom fram."]);
  });

  it("coalesces close multi-human finals into one floor response", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new VoiceRoomRuntime(["lobby"]);
      const created = runtime.createRoom("lobby", { socketId: "socket-a", memberId: "human-a", name: "Alex" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(runtime.joinRoom(created.room.id, { socketId: "socket-b", memberId: "human-b", name: "Bea" }).ok).toBe(true);
      expect(runtime.inviteBot(created.room.id, "socket-a", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
      runtime.setBotState(created.room.id, "ai-sana", "listening");
      let generations = 0;
      let ingestPending = false;
      let seenAuthors: string[] = [];
      const director = new VoiceDirector({
        runtime,
        floorSilenceMs: 650,
        hasPendingHumanIngest: () => ingestPending,
        lm: {
          analyzeTurn: analyzeSwedish,
          generateScene: async (request) => {
            generations += 1;
            seenAuthors = request.history.map((line) => line.author);
            return [{ personaId: "ai-sana", content: "Ni är inne på samma spår.", source: "lm", sourceIds: [] }];
          },
        },
        speech: {
          capabilities: async () => ({
            stt: { available: false, provider: "disabled", inputMimeTypes: [] },
            tts: { available: false, provider: "disabled", formats: [] },
            normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
            browserFallbackAllowed: true,
          }),
          synthesize: async () => { throw new Error("must not synthesize when disabled"); },
        },
        actorChannels: new ActorChannelRuntime(),
        events: {
          roomChanged: () => undefined,
          transcriptFinal: () => undefined,
          aiSpeech: () => undefined,
          aiStop: () => undefined,
        },
      });

      const first = runtime.appendFinalTranscript(created.room.id, "human-a", "Jag tänkte samma sak.");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      director.onHumanFinal(first.entry);
      await vi.advanceTimersByTimeAsync(400);

      const second = runtime.appendFinalTranscript(created.room.id, "human-b", "Fast vi borde testa först.");
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      director.onHumanFinal(second.entry);
      await vi.advanceTimersByTimeAsync(649);
      expect(generations).toBe(0);
      ingestPending = true;
      expect(runtime.setHumanState(created.room.id, "socket-a", { speaking: true }).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(generations).toBe(0);
      expect(runtime.setHumanState(created.room.id, "socket-a", { speaking: false }).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(generations).toBe(0);
      ingestPending = false;
      await vi.advanceTimersByTimeAsync(250);

      expect(generations).toBe(1);
      expect(seenAuthors).toEqual(expect.arrayContaining(["Alex", "Bea"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes written-only artifacts and bounds spoken output", () => {
    const words = Array.from({ length: 40 }, (_, index) => `ord${index}`).join(" ");
    const spoken = sanitizeSpokenLine(`# Rubrik\n[skrattar] ${words} 😀 https://example.com`);
    expect(spoken.split(/\s+/)).toHaveLength(25);
    expect(spoken).not.toMatch(/https?:|\[|#|😀/u);
    expect(sanitizeSpokenLine("【笑う】これは自然な返答です", "ja-JP")).toBe("これは自然な返答です");
    expect(sanitizeSpokenLine("（หัวเราะ）นี่คือคำตอบที่เป็นธรรมชาติ", "th-TH"))
      .toBe("นี่คือคำตอบที่เป็นธรรมชาติ".normalize("NFKC"));
  });

  it("matches complete persona names instead of substrings", () => {
    expect(mentionsPersona("Vale, vad tror du?", "Vale")).toBe(false);
    expect(mentionsPersona("@Vale, vad tror du?", "Vale")).toBe(true);
    expect(mentionsPersona("@Bosse.exe kom hit", "Bosse.exe")).toBe(true);
    expect(mentionsPersona("@Sana你怎麼看？", "Sana")).toBe(true);
    expect(mentionsPersona("ミラさん@Miraどう思う？", "Mira")).toBe(true);
    expect(mentionsPersona("مرحباً@Sana، ما رأيك؟", "Sana")).toBe(true);
    expect(mentionsPersona("https://example.test/@Sana", "Sana")).toBe(false);
    expect(mentionsPersona("Det svenska valet är snart", "Vale")).toBe(false);
    expect(mentionsPersona("That was beautiful", "Bea")).toBe(false);
  });

  it("uses only explicit provider language ranges and defaults closed", () => {
    expect(ttsModelSupportsLanguage(["sv"], "sv-SE")).toBe(true);
    expect(ttsModelSupportsLanguage(["sv-Latn"], "sv-Latn-SE")).toBe(true);
    expect(ttsModelSupportsLanguage(["sv"], "fr-FR")).toBe(false);
    expect(ttsModelSupportsLanguage(["ja"], "ja-JP")).toBe(true);
    expect(ttsModelSupportsLanguage([], "ja-JP")).toBe(false);
    expect(ttsModelSupportsLanguage(undefined, "ja-JP")).toBe(false);
    expect(ttsModelSupportsLanguage(["ja"], "und")).toBe(false);
  });
});
