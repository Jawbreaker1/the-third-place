import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { PERSONAS } from "./personas.js";
import { createMessage, RoomStore } from "./store.js";
import {
  addressedPersonaIds,
  ambientHistoryWithAnchor,
  ambientConversationPremise,
  ambientLanguageHint,
  ambientSceneWordLimits,
  analyzeSocialSignals,
  consideredConversationLeadPremise,
  consideredConversationPremise,
  consideredConversationResponsePremise,
  consideredConversationWordLimits,
  classifiedLanguage,
  ensureEvidenceResponder,
  evidenceFailureFallback,
  normalizeGeneratedMessageContent,
  pageEvidenceAnswerContract,
  selectAmbientLead,
  selectConsideredConversation,
  selectResponders,
  socialSignalsFromTurnAnalysis,
  SocialDirector,
  shouldRejectPublicCandidate,
  shouldSurfaceTemporalCue,
  shouldStartConsideredConversation,
  sourceIdsForPageResponder,
  trailingAiMessageCount,
  type ConsideredConversationGate,
} from "./director.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis } from "./semanticRouter.js";

const classifiedTurn = (overrides: Partial<TurnAnalysis> = {}): TurnAnalysis => ({
  ...createFailClosedTurnAnalysis("disabled"),
  source: "lm",
  failureReason: null,
  language: { tag: "sv", confidence: 0.99 },
  intent: { kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.99 },
  personas: { addressedIds: [], requestedReplyIds: [], relevantIds: [], addressConfidence: 0, relevanceConfidence: 0 },
  social: { warmth: 0.2, hostility: 0, playfulness: 0, absurdity: 0, urgency: 0, energy: 0.3, pileOnRisk: 0, claimStrength: 0, confidence: 0.99 },
  moderation: { risk: "none", action: "none", categories: [], confidence: 0.99 },
  evidence: { need: "none", action: "none", confidence: 0.99, query: null, urlRef: null, searchMode: null, timeZone: null, timeKind: null, locationLabel: null },
  capabilities: {
    discussed: [],
    requestKind: "none",
    asksAboutAcoustics: false,
    asksAboutAiIdentity: false,
    asksForList: false,
    confidence: 0.99,
  },
  ...overrides,
});

describe("social director", () => {
  it("uses one source-agnostic evidence contract for every successful page read", () => {
    const packet = (title: string, url: string) => ({
      kind: "page" as const,
      query: "read it",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S1", title, url, snippet: "A concrete supported detail from the page." }],
    });
    const contracts = [
      packet("Market", "https://www.avanza.se/"),
      packet("ゲームニュース", "https://example.jp/news"),
      packet("Actualités", "https://example.fr/article"),
    ].map((value) => pageEvidenceAnswerContract(value));
    expect(new Set(contracts).size).toBe(1);
    expect(contracts[0]).toContain("human's actual request");
    expect(contracts[0]).toContain("concrete detail");
  });

  it("does not guess a Swedish or English sentence when an evidence attempt fails", () => {
    expect(evidenceFailureFallback(true, "kan ni läsa länken?")).toBeUndefined();
    expect(evidenceFailureFallback(false, "bitte prüfe die aktuellen Kurse")).toBeUndefined();
  });

  it("wires DM evidence fallbacks to the actual message source metadata", async () => {
    vi.useFakeTimers();
    try {
      const human = {
        id: "guest-evidence",
        name: "Jaw_B",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "J" },
      };
      const persona = PERSONAS.find((candidate) => candidate.id === "ai-linnea")!;
      const pagePacket = {
        kind: "page" as const,
        query: "dagens kurser",
        retrievedAt: new Date().toISOString(),
        results: [{
          id: "S1",
          title: "Avanza – Börsen idag",
          url: "https://www.avanza.se/",
          snippet: "OMX Stockholm 30 (OMXS30): level 3 167,16; change -0,33%; updated 17:30.\nAdditional supplied context.",
        }],
      };
      const runCase = async (evidence: typeof pagePacket | undefined) => {
        const emit = vi.fn();
        const store = new RoomStore("/tmp/director-evidence-test-unused.json");
        const thread = store.openDm(human.id, persona.id);
        const incoming = store.addDmMessage(
          thread.id,
          human.id,
          "@Linnea kolla dagens kurser på https://www.avanza.se",
        )!;
        const lm = {
          analyzeTurn: vi.fn(async () => classifiedTurn({
            evidence: {
              need: "required",
              action: "read_url",
              confidence: 0.99,
              query: null,
              urlRef: "U1",
              searchMode: null,
              timeZone: null,
              timeKind: null,
              locationLabel: null,
            },
          })),
          generateScene: vi.fn(async () => evidence ? [{
            personaId: persona.id,
            content: "OMX Stockholm 30 (OMXS30) står på 3 167,16 i den hämtade översikten.",
            source: "lm" as const,
            sourceIds: ["S1"],
          }] : [{
            personaId: persona.id,
            content: "Jag fick inte fram just den sidan den här gången.",
            source: "lm" as const,
            sourceIds: [],
          }]),
          rememberDeliveredLine: vi.fn(),
        };
        const pageReader = {
          collectCandidates: vi.fn(() => ({
            requestedAt: new Date().toISOString(),
            candidates: [{
              id: "U1",
              url: new URL("https://www.avanza.se/"),
              raw: "https://www.avanza.se",
              supported: true,
              source: "message" as const,
              messageId: incoming.id,
              authorId: human.id,
              createdAt: incoming.createdAt,
            }],
          })),
          resolveTarget: vi.fn(({ candidateSet, intent }: { candidateSet: { requestedAt: string }; intent: string }) => ({
            url: new URL("https://www.avanza.se/"),
            requestedAt: candidateSet.requestedAt,
            intent,
            retry: false,
            source: "message" as const,
          })),
          read: vi.fn(async () => evidence),
        };
        const researchBroker = {
          researchSite: vi.fn(async () => undefined),
          research: vi.fn(async () => undefined),
        };
        const humanMemory = {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        };
        const director = new SocialDirector(
          { to: vi.fn(() => ({ emit })) } as never,
          store,
          lm as never,
          new ActorChannelRuntime(),
          researchBroker as never,
          humanMemory as never,
          () => [human, ...PERSONAS],
          () => 1,
          { pageReader: pageReader as never, now: () => Date.now() },
        );
        const pending = director.onDirectMessage(incoming, human, persona);
        await vi.runAllTimersAsync();
        await pending;
        director.stop();
        return {
          reply: store.getDmMessages(thread.id).at(-1)!,
          analyzerInput: lm.analyzeTurn.mock.calls[0]?.[0],
        };
      };

      const sourced = await runCase(pagePacket);
      expect(sourced.reply.generation).toBe("lm");
      expect(sourced.reply.content).toContain("OMX Stockholm 30 (OMXS30)");
      expect(sourced.reply.sources).toEqual([{ title: "Avanza – Börsen idag", url: "https://www.avanza.se/" }]);
      expect(sourced.analyzerInput.urlCandidates).toEqual([{
        ref: "U1",
        source: "latest_message",
        context: "host=www.avanza.se; path=/; source=message",
      }]);
      expect(JSON.stringify(sourced.analyzerInput.urlCandidates)).not.toContain("https://");

      const failed = await runCase(undefined);
      expect(failed.reply.generation).toBe("lm");
      expect(failed.reply.content).toBe("Jag fick inte fram just den sidan den här gången.");
      expect(failed.reply.sources).toEqual([]);
      expect(failed.reply.content).not.toContain("bold thing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a current-time request from the server clock and never sends it to search", async () => {
    vi.useFakeTimers();
    const fixedNow = Date.parse("2026-07-13T22:20:30.000Z");
    try {
      const human = {
        id: "guest-clock",
        name: "Jaw_B",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "J" },
      };
      const persona = PERSONAS.find((candidate) => candidate.id === "ai-mira")!;
      const store = new RoomStore("/tmp/director-clock-test-unused.json");
      const thread = store.openDm(human.id, persona.id);
      const incoming = store.addDmMessage(
        thread.id,
        human.id,
        "Så ingen :( Som kan kolla upp vad klockan är i Sverige just nu?",
      )!;
      const analyzeTurn = vi.fn(async () => classifiedTurn({
        language: { tag: "sv", confidence: 0.99 },
        evidence: {
          need: "required",
          action: "local_datetime",
          confidence: 0.99,
          query: null,
          urlRef: null,
          searchMode: null,
          timeZone: "Europe/Stockholm",
          timeKind: "current_time",
          locationLabel: "Sverige",
        },
      }));
      const generateScene = vi.fn(async (request: {
        premise?: string;
        requestedClock?: { formatted: string; timeZone: string };
        temporalPolicy?: string;
      }) => {
        expect(request.premise).not.toContain("Trusted server clock result");
        expect(request.requestedClock?.formatted).toContain("00:20:30");
        expect(request.requestedClock?.timeZone).toBe("Europe/Stockholm");
        expect(request.temporalPolicy).toBe("direct_answer");
        return [{ personaId: persona.id, content: "Klockan är 00:20 i Sverige.", source: "lm" as const, sourceIds: [] }];
      });
      const research = vi.fn(async () => undefined);
      const researchSite = vi.fn(async () => undefined);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        { analyzeTurn, generateScene, rememberDeliveredLine: vi.fn() } as never,
        new ActorChannelRuntime(),
        { research, researchSite } as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          pageReader: { collectCandidates: vi.fn(() => ({ requestedAt: new Date(fixedNow).toISOString(), candidates: [] })) } as never,
          now: () => fixedNow,
        },
      );
      const pending = director.onDirectMessage(incoming, human, persona);
      await vi.runAllTimersAsync();
      await pending;
      director.stop();

      expect(analyzeTurn).toHaveBeenCalledTimes(1);
      expect(research).not.toHaveBeenCalled();
      expect(researchSite).not.toHaveBeenCalled();
      expect(store.getDmMessages(thread.id).at(-1)?.content).toBe("Klockan är 00:20 i Sverige.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs exactly one analysis for a public burst and lets explicit @ plus the clock tool win", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const fixedNow = Date.parse("2026-07-13T22:20:30.000Z");
    try {
      const human = {
        id: "guest-public-clock",
        name: "Jaw_B",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "J" },
      };
      const persona = PERSONAS.find((candidate) => candidate.id === "ai-mira")!;
      const store = new RoomStore("/tmp/director-public-clock-test-unused.json");
      const first = createMessage("lobby", human.id, "Jag gillar Rust. Tss, jag frågade ju här i kanalen.");
      const latest = createMessage("lobby", human.id, "@Mira, vad är klockan i Sverige just nu?");
      store.addPublicMessage(first);
      store.addPublicMessage(latest);
      await store.flush();
      const analyzeTurn = vi.fn(async () => classifiedTurn({
        language: { tag: "sv", confidence: 0.99 },
        evidence: {
          need: "required",
          action: "local_datetime",
          confidence: 0.99,
          query: null,
          urlRef: null,
          searchMode: null,
          timeZone: "Europe/Stockholm",
          timeKind: "current_time",
          locationLabel: "Sverige",
        },
      }));
      const research = vi.fn(async () => undefined);
      const analyzeMemoryTurn = vi.fn(async (request: {
        content: string;
        currentBurstMessages: Array<{ id: string; content: string }>;
      }) => ({
        source: "lm" as const,
        failureReason: null,
        items: request.currentBurstMessages.some((message) => message.content.includes("Rust"))
          ? [{
              operation: "remember" as const,
              kind: "likes" as const,
              value: "Rust",
              explicitFirstPerson: true as const,
              safety: "safe" as const,
              confidence: 0.99,
            }]
          : [],
      }));
      const noteClassifiedMemoryFact = vi.fn();
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          analyzeTurn,
          analyzeMemoryTurn,
          generateScene: vi.fn(async () => [{
            personaId: persona.id,
            content: "00:20 här i Sverige.",
            source: "lm" as const,
            sourceIds: [],
          }]),
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        { research, researchSite: vi.fn(async () => undefined) } as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact,
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          pageReader: { collectCandidates: vi.fn(() => ({ requestedAt: new Date(fixedNow).toISOString(), candidates: [] })) } as never,
          now: () => fixedNow,
          rng: () => 0.5,
        },
      );
      const pending = (director as unknown as {
        handleHumanBurst: (messages: Array<typeof latest>, member: typeof human) => Promise<void>;
      }).handleHumanBurst([first, latest], human);
      await vi.runAllTimersAsync();
      await pending;
      await vi.runAllTimersAsync();
      director.stop();

      expect(analyzeTurn).toHaveBeenCalledTimes(1);
      expect(analyzeTurn.mock.calls[0]?.[0].latestMessage.content).toBe(latest.content);
      expect(analyzeTurn.mock.calls[0]?.[0].recentMessages.some((message: { id?: string }) => message.id === first.id)).toBe(true);
      expect(research).not.toHaveBeenCalled();
      expect(analyzeMemoryTurn).toHaveBeenCalledTimes(1);
      expect(analyzeMemoryTurn).toHaveBeenCalledWith(expect.objectContaining({
        turnId: `memory:${latest.id}`,
        content: latest.content,
        currentBurstMessages: [
          expect.objectContaining({ id: first.id, content: first.content }),
          expect.objectContaining({ id: latest.id, content: latest.content }),
        ],
      }));
      expect(noteClassifiedMemoryFact).toHaveBeenCalledWith(
        human.id,
        "lobby",
        expect.objectContaining({ operation: "remember", kind: "likes", value: "Rust" }),
        fixedNow,
      );
      const reply = store.getRecent("lobby", 1)[0];
      expect(reply?.authorId).toBe(persona.id);
      expect(reply?.content).toBe("00:20 här i Sverige.");
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a Japanese elliptical memory burst together and excludes every other author", async () => {
    vi.useFakeTimers();
    try {
      const human = {
        id: "guest-hana-memory",
        name: "Hana",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "H" },
      };
      const otherHuman = {
        id: "guest-other-memory",
        name: "Ken",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#321", accent: "#654", glyph: "K" },
      };
      const store = new RoomStore("/tmp/director-memory-burst-test-unused.json");
      const prior = createMessage("lobby", human.id, "チェスをしています。");
      const intervening = createMessage("lobby", otherHuman.id, "私は囲碁が好きです。");
      const first = createMessage("lobby", human.id, "もうしません。");
      const latest = createMessage("lobby", human.id, "今は将棋です。");
      for (const message of [prior, intervening, first, latest]) store.addPublicMessage(message);
      await store.flush();

      const analyzeMemoryTurn = vi.fn(async () => ({
        source: "lm" as const,
        failureReason: null,
        items: [
          {
            operation: "forget" as const,
            kind: "plays" as const,
            value: "チェス",
            explicitFirstPerson: true as const,
            safety: "safe" as const,
            confidence: 0.99,
          },
          {
            operation: "remember" as const,
            kind: "plays" as const,
            value: "将棋",
            explicitFirstPerson: true as const,
            safety: "safe" as const,
            confidence: 0.99,
          },
        ],
      }));
      const forgetClassifiedMemoryFact = vi.fn();
      const noteClassifiedMemoryFact = vi.fn();
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        { analyzeMemoryTurn, health: vi.fn(() => ({ connected: true, queueDepth: 0 })) } as never,
        new ActorChannelRuntime(),
        { research: vi.fn(), researchSite: vi.fn() } as never,
        {
          forgetClassifiedMemoryFact,
          noteClassifiedMemoryFact,
        } as never,
        () => [human, otherHuman, ...PERSONAS],
        () => 2,
      );

      (director as unknown as {
        schedulePersistentMemory: (messages: typeof first[], member: typeof human) => void;
      }).schedulePersistentMemory([first, latest], human);
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(analyzeMemoryTurn).toHaveBeenCalledTimes(1);
      expect(analyzeMemoryTurn).toHaveBeenCalledWith(expect.objectContaining({
        turnId: `memory:${latest.id}`,
        content: latest.content,
        currentBurstMessages: [
          expect.objectContaining({ id: first.id, content: "もうしません。" }),
          expect.objectContaining({ id: latest.id, content: "今は将棋です。" }),
        ],
        recentSameAuthorMessages: [
          expect.objectContaining({ id: prior.id, content: "チェスをしています。" }),
        ],
      }));
      const request = analyzeMemoryTurn.mock.calls[0]?.[0];
      expect(JSON.stringify(request)).not.toContain(intervening.content);
      expect(forgetClassifiedMemoryFact).toHaveBeenCalledWith(
        human.id,
        "lobby",
        expect.objectContaining({ value: "チェス" }),
        expect.any(Number),
      );
      expect(noteClassifiedMemoryFact).toHaveBeenCalledWith(
        human.id,
        "lobby",
        expect.objectContaining({ value: "将棋" }),
        expect.any(Number),
      );
      director.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent instead of publishing generic Bosse chatter when both required generations are empty", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    try {
      const human = {
        id: "guest-no-canned-line",
        name: "Jaw_B",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "J" },
      };
      const store = new RoomStore("/tmp/director-no-canned-line-test.json");
      const incoming = createMessage("lobby", human.id, "@Bosse.exe, vet du?");
      store.addPublicMessage(incoming);
      await store.flush();
      const generateScene = vi.fn(async () => []);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        { analyzeTurn: vi.fn(async () => classifiedTurn()), generateScene, rememberDeliveredLine: vi.fn() } as never,
        new ActorChannelRuntime(),
        { research: vi.fn(), researchSite: vi.fn() } as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          pageReader: { collectCandidates: vi.fn(() => ({ requestedAt: new Date().toISOString(), candidates: [] })) } as never,
          rng: () => 0.5,
        },
      );
      const pending = (director as unknown as {
        handleHumanBurst: (messages: Array<typeof incoming>, member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;
      director.stop();

      expect(generateScene).toHaveBeenCalledTimes(2);
      expect(store.getRecent("lobby", 5)).toEqual([incoming]);
      expect(store.getRecent("lobby", 5).some((message) => message.content.includes("bold thing"))).toBe(false);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ["nb", "Kan noen sjekke dagens strømpris?", "dagens strømpris Norge"],
    ["de", "Kann jemand die heutigen DAX-Kurse prüfen?", "DAX Kurse heute"],
    ["fr", "Quelqu’un peut vérifier les nouvelles règles aujourd’hui ?", "nouvelles règles aujourd'hui"],
    ["es", "¿Podéis mirar las noticias de mercado de hoy?", "noticias del mercado hoy"],
  ])("routes a %s lookup only from the classifier's standalone query", async (tag, content, query) => {
    vi.useFakeTimers();
    const previousResearch = process.env.RESEARCH_ENABLED;
    process.env.RESEARCH_ENABLED = "true";
    try {
      const human = {
        id: `guest-${tag}`,
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const persona = PERSONAS.find((candidate) => candidate.id === "ai-linnea")!;
      const store = new RoomStore(`/tmp/director-${tag}-routing-test-unused.json`);
      const thread = store.openDm(human.id, persona.id);
      const incoming = store.addDmMessage(thread.id, human.id, content)!;
      const analyzeTurn = vi.fn(async () => classifiedTurn({
        language: { tag, confidence: 0.99 },
        evidence: {
          need: "required",
          action: "web_search",
          confidence: 0.99,
          query,
          urlRef: null,
          searchMode: "web",
          timeZone: null,
          timeKind: null,
          locationLabel: null,
        },
      }));
      const packet = {
        kind: "search" as const,
        query,
        retrievedAt: new Date().toISOString(),
        results: [{ id: "S1", title: "Relevant source", url: "https://example.com/result", snippet: "Relevant detail" }],
      };
      const research = vi.fn(async () => packet);
      const generateScene = vi.fn(async (request: { languageHint?: string }) => {
        expect(request.languageHint).toBe(tag);
        return [{ personaId: persona.id, content: "Relevant answer", source: "lm" as const, sourceIds: ["S1"] }];
      });
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        { analyzeTurn, generateScene, rememberDeliveredLine: vi.fn() } as never,
        new ActorChannelRuntime(),
        { research, researchSite: vi.fn(async () => undefined) } as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        { pageReader: { collectCandidates: vi.fn(() => ({ requestedAt: new Date().toISOString(), candidates: [] })) } as never },
      );
      const pending = director.onDirectMessage(incoming, human, persona);
      await vi.runAllTimersAsync();
      await pending;
      director.stop();

      expect(analyzeTurn).toHaveBeenCalledTimes(1);
      expect(research).toHaveBeenCalledWith({ query, mode: "web", requesterId: human.id });
      const analyzerInput = analyzeTurn.mock.calls[0]?.[0];
      expect(analyzerInput.latestMessage.content).toBe(content);
      expect(analyzerInput.availableCapabilities).toContain("web_search");
    } finally {
      if (previousResearch === undefined) delete process.env.RESEARCH_ENABLED;
      else process.env.RESEARCH_ENABLED = previousResearch;
      vi.useRealTimers();
    }
  });

  it("keeps mentions while reserving one bounded slot for a capable evidence reader", () => {
    const researcher = PERSONAS.find((persona) => persona.canResearch)!;
    const nonResearchers = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 3);
    const result = ensureEvidenceResponder(
      nonResearchers,
      [researcher, ...nonResearchers],
      [nonResearchers[0]!.id],
      new Map([[researcher.id, 1]]),
    );
    expect(result.selected).toHaveLength(3);
    expect(result.selected.map((persona) => persona.id)).toContain(nonResearchers[0]!.id);
    expect(result.selected.map((persona) => persona.id)).toContain(researcher.id);
    expect(result.responder?.id).toBe(researcher.id);
  });

  it("can designate a mentioned resident for a supplied page when all three slots are mentioned", () => {
    const mentioned = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 3);
    const result = ensureEvidenceResponder(mentioned, mentioned, mentioned.map((persona) => persona.id), new Map(), false);
    expect(result.selected).toEqual(mentioned);
    expect(result.responder?.id).toBe(mentioned[0]?.id);
  });

  it("always gives explicit evidence a single owner when no specialist is attentive", () => {
    const ordinary = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 2);
    const result = ensureEvidenceResponder(ordinary, ordinary, [], new Map(), true);
    expect(result.responder?.id).toBe(ordinary[0]?.id);
    expect(result.selected.filter((persona) => persona.id === result.responder?.id)).toHaveLength(1);
  });

  it("guarantees the validated page source on the designated generated answer only", () => {
    const pageResearch = {
      kind: "page" as const,
      query: "read it",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S1", title: "Example", url: "https://example.com", snippet: "evidence" }],
    };
    expect(sourceIdsForPageResponder(pageResearch, [], true)).toEqual(["S1"]);
    expect(sourceIdsForPageResponder(pageResearch, ["S1"], true)).toEqual(["S1"]);
    expect(sourceIdsForPageResponder(pageResearch, [], false)).toEqual([]);
    expect(sourceIdsForPageResponder(pageResearch, ["S1"], false)).toEqual([]);
    expect(sourceIdsForPageResponder({ ...pageResearch, kind: "search" }, [], true)).toEqual([]);
  });

  it("always prioritises a directly mentioned quiet resident", () => {
    const signals = analyzeSocialSignals("@moss what do you think about this?");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(selected.map((persona) => persona.id)).toContain("ai-moss");
  });

  it("treats a Discord reply to an AI resident as direct address even outside their roster", () => {
    expect(addressedPersonaIds([], { authorId: "ai-kim" })).toEqual(["ai-kim"]);
    expect(addressedPersonaIds(["ai-sana"], { authorId: "ai-kim" })).toEqual(["ai-sana", "ai-kim"]);
    expect(addressedPersonaIds([], { authorId: "human-johan" })).toEqual([]);
    expect(addressedPersonaIds([], { authorId: "ai-kim", system: true })).toEqual([]);
  });

  it("uses the multilingual turn analysis for absurdity and energy without punctuation inference", () => {
    const baseline = analyzeSocialSignals("HEAR ME OUT!!! what if the banana runs the server? 🤯🤯");
    expect(baseline.energy).toBe(0);
    const signals = socialSignalsFromTurnAnalysis(classifiedTurn({
      social: { ...classifiedTurn().social, absurdity: 0.91, energy: 0.88 },
    }), [], baseline);
    expect(signals.absurdity).toBeGreaterThan(0.4);
    expect(signals.energy).toBeGreaterThan(0.5);
  });

  it("fails closed on uncertain semantic intent and language instead of forcing a locale or reply", () => {
    const analysis = classifiedTurn({
      language: { tag: "ja", confidence: 0.31 },
      intent: { kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.42 },
      personas: {
        addressedIds: ["ai-mira"],
        requestedReplyIds: ["ai-mira"],
        relevantIds: [],
        addressConfidence: 0.99,
        relevanceConfidence: 0,
      },
    });
    const signals = socialSignalsFromTurnAnalysis(analysis, [], analyzeSocialSignals("短い曖昧な発話"));
    expect(classifiedLanguage(analysis)).toBeUndefined();
    expect(signals.isQuestion).toBe(false);
    expect(signals.mentionedIds).toEqual([]);
    expect(classifiedLanguage(classifiedTurn({ language: { tag: "ja", confidence: 0.99 } }))).toBe("ja");
  });

  it("measures an uninterrupted autonomous tail without letting room notices reset it", () => {
    const history = [
      { authorId: "human-johan" },
      { authorId: "ai-sana" },
      { authorId: "room", system: true },
      { authorId: "ai-vale" },
    ];
    expect(trailingAiMessageCount(history)).toBe(2);
    expect(trailingAiMessageCount([...history, { authorId: "human-friend" }])).toBe(0);
  });

  it("anchors autonomous language to the latest human-authored message", () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    const oldHuman = {
      id: "old",
      authorId: "human-old",
      content: "old thought",
      createdAt: new Date(now - 31 * 60_000).toISOString(),
    };
    const freshHuman = {
      id: "fresh",
      authorId: "human-johan",
      content: "hur skulle ni lösa det här?",
      createdAt: new Date(now - 60_000).toISOString(),
    };
    const aiTail = {
      id: "ai-tail",
      authorId: "ai-sana",
      content: "en tidigare replik",
      createdAt: new Date(now - 30_000).toISOString(),
    };
    expect(ambientLanguageHint([oldHuman, freshHuman, aiTail])).toBe("the language used in the latest human-authored message");
    const longAiTail = Array.from({ length: 24 }, (_, index) => ({
      ...aiTail,
      id: `ai-tail-${index}`,
      createdAt: new Date(now - (24 - index) * 1_000).toISOString(),
    }));
    const bounded = ambientHistoryWithAnchor([oldHuman, freshHuman, ...longAiTail], 18);
    expect(bounded).toHaveLength(18);
    expect(bounded[0]?.id).toBe("fresh");
    expect(bounded.slice(1).every((message) => message.authorId.startsWith("ai-"))).toBe(true);
  });

  it("chooses a room-relevant lead over the loudest generic resident", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-bosse", "ai-sana"].includes(persona.id));
    const lead = selectAmbientLead(candidates, (id) => (id === "ai-sana" ? 1 : 0), () => 0);
    expect(lead?.id).toBe("ai-sana");
  });

  it("rotates among the strongest room-relevant leads instead of crowning one permanent host", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-pixel", "ai-bosse", "ai-juno"].includes(persona.id));
    const affinities = new Map([
      ["ai-pixel", 0.95],
      ["ai-bosse", 0.86],
      ["ai-juno", 0.84],
    ]);
    const leads = [0.05, 0.55, 0.95].map((roll) =>
      selectAmbientLead(candidates, (id) => affinities.get(id) ?? 0, () => roll)?.id,
    );
    expect(new Set(leads).size).toBeGreaterThan(1);
    expect(leads).not.toContain(undefined);
  });

  it("lets sociable voices open pub banter while quieter experts remain available to reply", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-juno", "ai-mira", "ai-farah"].includes(persona.id));
    const lead = selectAmbientLead(candidates, () => 0.8, () => 0, "banter");
    expect(["ai-juno", "ai-mira"]).toContain(lead?.id);
    expect(lead?.id).not.toBe("ai-farah");
  });

  it("turns a concrete seed into a bounded claim-and-response contract", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-sana")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-vale")!;
    const seed = "Fail-silent background agents create more trust than canned fallback chatter.";
    const premise = ambientConversationPremise(seed, lead, responder, false, true);
    const limits = ambientSceneWordLimits(lead, responder, false);
    expect(premise).toContain(seed);
    expect(premise).toContain("specific, defensible claim");
    expect(premise).toContain("counterexample or hidden cost");
    expect(premise).toContain("Exactly the selected residents speak in order");
    expect(limits[lead.id]).toEqual({ minimum: lead.style.typicalWords[0], maximum: lead.style.hardMaxWords });
    expect(limits[responder.id]).toEqual({ minimum: responder.style.typicalWords[0] - 1, maximum: 28 });
  });

  it("turns the same machinery into short social banter for the pub", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-juno")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-bosse")!;
    const seed = "Put one beloved film on trial for its ending.";
    const premise = ambientConversationPremise(seed, lead, responder, false, true, "banter");
    const limits = ambientSceneWordLimits(lead, responder, false, "banter");
    expect(premise).toContain(seed);
    expect(premise).toContain("one concrete social hook");
    expect(premise).toContain("countertake, adjacent recommendation, punchline");
    expect(premise).not.toContain("specific, defensible claim");
    expect(premise).not.toContain("counterexample or hidden cost");
    expect(limits[lead.id]).toEqual({ minimum: lead.style.typicalWords[0], maximum: 26 });
    expect(limits[responder.id]).toEqual({ minimum: 2, maximum: 20 });
  });

  it("uses an everyday, shorter contract in casual rooms without rewarding complexity as the house voice", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-ibrahim")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const premise = ambientConversationPremise(
      "A quiet regular remembers why the room made an odd decision.",
      lead,
      responder,
      false,
      false,
      "casual",
    );
    const limits = ambientSceneWordLimits(lead, responder, false, "casual");

    expect(premise).toContain("ordinary phrase, recognizable example or specific detail");
    expect(premise).toContain("No miniature essay");
    expect(premise).not.toContain("specific, defensible claim");
    expect(limits[lead.id]!.maximum).toBeLessThan(lead.style.hardMaxWords);
    expect(limits[lead.id]!.minimum).toBe(lead.style.typicalWords[0]);
  });

  it("keeps autonomous rooms silent when the model is offline or returns no valid lines", async () => {
    const runCase = async (
      connected: boolean,
      recentMessages: Array<Record<string, unknown>> = [],
      knownHumanChannel = false,
    ) => {
      const emit = vi.fn();
      const io = { to: vi.fn(() => ({ emit })) };
      const store = {
        getRecent: vi.fn(() => recentMessages),
        addPublicMessage: vi.fn(),
      };
      const lm = {
        health: vi.fn(() => ({ connected, queueDepth: 0, label: connected ? "Gemma" : "offline" })),
        generateScene: vi.fn(async () => []),
      };
      const director = new SocialDirector(
        io as never,
        store as never,
        lm as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        { rng: () => 0, now: () => 2_000_000, consideredConversationChance: 0 },
      );
      if (knownHumanChannel) {
        (director as unknown as { lastHumanMessageAtByChannel: Map<string, number> })
          .lastHumanMessageAtByChannel.set("lobby", 1_900_000);
      }
      await (director as unknown as { runAmbient: () => Promise<void> }).runAmbient();
      director.stop();
      return { store, lm };
    };

    const offline = await runCase(false);
    const empty = await runCase(true);
    const freshRestartTail = await runCase(true, [{
      id: "recent-ai",
      channelId: "lobby",
      authorId: "ai-sana",
      content: "one prior autonomous line",
      createdAt: new Date(1_970_000).toISOString(),
      reactions: [],
    }]);
    const humanTriggeredTail = await runCase(true, [{
      id: "human-triggered-ai",
      channelId: "lobby",
      authorId: "ai-sana",
      content: "a reply caused by a known human message",
      createdAt: new Date(1_970_000).toISOString(),
      reactions: [],
    }], true);
    expect(offline.lm.generateScene).not.toHaveBeenCalled();
    expect(offline.store.addPublicMessage).not.toHaveBeenCalled();
    expect(empty.lm.generateScene).toHaveBeenCalledTimes(1);
    expect(empty.store.addPublicMessage).not.toHaveBeenCalled();
    expect(freshRestartTail.lm.generateScene).not.toHaveBeenCalled();
    expect(freshRestartTail.store.addPublicMessage).not.toHaveBeenCalled();
    expect(humanTriggeredTail.lm.generateScene).toHaveBeenCalledTimes(1);
    expect(humanTriggeredTail.store.addPublicMessage).not.toHaveBeenCalled();
  });

  it("does not recruit the moderator for ordinary banter", () => {
    const signals = analyzeSocialSignals("pineapple pizza is obviously the best");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.5);
    expect(selected.map((persona) => persona.id)).not.toContain("ai-runa");
  });

  it("does not confuse names with substrings", () => {
    expect(analyzeSocialSignals("det här är en beautiful idé").mentionedIds).not.toContain("ai-bea");
    expect(analyzeSocialSignals("vad tycker ni om valet?").mentionedIds).not.toContain("ai-vale");
    expect(analyzeSocialSignals("Vale, vad tycker du?").mentionedIds).not.toContain("ai-vale");
    expect(analyzeSocialSignals("@Vale, vad tycker du?").mentionedIds).toContain("ai-vale");
  });

  it("routes model-classified hostility to the moderator without a language word list", () => {
    const analysis = classifiedTurn({
      language: { tag: "de", confidence: 0.99 },
      social: { ...classifiedTurn().social, hostility: 0.86 },
      moderation: { risk: "medium", action: "deescalate", categories: ["harassment"], confidence: 0.96 },
    });
    const signals = socialSignalsFromTurnAnalysis(analysis, [], analyzeSocialSignals("Du bist wirklich unmöglich"));
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(signals.aggression).toBeGreaterThanOrEqual(0.4);
    expect(selected.map((persona) => persona.id)).toEqual(["ai-runa"]);
  });

  it("keeps an explicit @ target when moderation also needs to join", () => {
    const analysis = classifiedTurn({
      social: { ...classifiedTurn().social, hostility: 0.86 },
      moderation: { risk: "medium", action: "deescalate", categories: ["harassment"], confidence: 0.96 },
    });
    const baseline = analyzeSocialSignals("@Mira, det där var faktiskt över gränsen");
    const signals = socialSignalsFromTurnAnalysis(analysis, baseline.mentionedIds, baseline);
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(selected.map((persona) => persona.id)).toEqual(["ai-mira", "ai-runa"]);
  });

  it("takes claim strength from meaning rather than Swedish or English substrings", () => {
    const strong = socialSignalsFromTurnAnalysis(classifiedTurn({
      language: { tag: "fr", confidence: 0.99 },
      social: { ...classifiedTurn().social, claimStrength: 0.88 },
    }), [], analyzeSocialSignals("Ce modèle est clairement le meilleur"));
    const weak = socialSignalsFromTurnAnalysis(classifiedTurn({
      language: { tag: "fr", confidence: 0.99 },
      social: { ...classifiedTurn().social, claimStrength: 0.08 },
    }), [], analyzeSocialSignals("Mon colis est arrivé aujourd’hui"));
    expect(strong.claimStrength).toBeGreaterThan(0.28);
    expect(weak.claimStrength).toBeLessThan(0.28);
  });

  it("gates optional temporal cues by chance and cooldown without reading message vocabulary", () => {
    const now = 2_000_000;
    expect(shouldSurfaceTemporalCue({
      now,
      cooldownMs: 600_000,
      chance: 0.32,
      rng: () => 0.31,
    })).toBe(true);
    expect(shouldSurfaceTemporalCue({
      now,
      cooldownMs: 600_000,
      chance: 0.32,
      rng: () => 0.32,
    })).toBe(false);
    let rolls = 0;
    expect(shouldSurfaceTemporalCue({
      now,
      lastSurfacedAt: now - 599_999,
      cooldownMs: 600_000,
      chance: 1,
      rng: () => { rolls += 1; return 0; },
    })).toBe(false);
    expect(rolls).toBe(0);
  });

  it("opens a considered beat only on the rare roll after quiet and cooldown", () => {
    const now = 2_000_000;
    const base: ConsideredConversationGate = {
      now,
      lastStartedAt: now - 600_000,
      lastHumanActivityAt: now - 75_000,
      cooldownMs: 600_000,
      humanQuietMs: 75_000,
      chance: 0.1,
      queueDepth: 0,
      availableMessageSlots: 2,
      voiceRoomActive: false,
      alreadyInFlight: false,
      rng: () => 0.099,
    };

    expect(shouldStartConsideredConversation(base)).toBe(true);
    expect(shouldStartConsideredConversation({ ...base, rng: () => 0.1 })).toBe(false);
  });

  it("blocks considered beats before rolling when people, voice, queue, spam limits or another beat intervene", () => {
    const now = 2_000_000;
    let rolls = 0;
    const base: ConsideredConversationGate = {
      now,
      lastStartedAt: now - 600_000,
      lastHumanActivityAt: now - 75_000,
      cooldownMs: 600_000,
      humanQuietMs: 75_000,
      chance: 1,
      queueDepth: 0,
      availableMessageSlots: 2,
      voiceRoomActive: false,
      alreadyInFlight: false,
      rng: () => {
        rolls += 1;
        return 0;
      },
    };
    const blocked: Partial<ConsideredConversationGate>[] = [
      { voiceRoomActive: true },
      { alreadyInFlight: true },
      { queueDepth: 1 },
      { availableMessageSlots: 1 },
      { lastStartedAt: now - 599_999 },
      { lastHumanActivityAt: now - 74_999 },
    ];

    for (const override of blocked) {
      expect(shouldStartConsideredConversation({ ...base, ...override })).toBe(false);
    }
    expect(rolls).toBe(0);
  });

  it("pairs distinct relevant residents and gives the responder a non-echo role", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-sana", "ai-vale", "ai-mira"].includes(persona.id));
    const affinities = new Map([
      ["ai-sana", 0.95],
      ["ai-vale", 0.8],
      ["ai-mira", 0.7],
    ]);
    const plan = selectConsideredConversation(candidates, new Map(), 2_000_000, (id) => affinities.get(id) ?? 0, () => 0);

    expect(plan?.lead.id).toBe("ai-sana");
    expect(plan?.responder.id).toBe("ai-vale");
    expect(plan?.responseRole).toBe("challenge");
    expect(plan?.lead.id).not.toBe(plan?.responder.id);
    const challengePremise = consideredConversationPremise(plan!);
    const anchoredPremise = consideredConversationPremise(plan!, "A deterministic director should own pacing.");
    const leadPremise = consideredConversationLeadPremise(plan!, "A deterministic director should own pacing.");
    const responsePremise = consideredConversationResponsePremise(plan!);
    const examplePremise = consideredConversationPremise({ ...plan!, responseRole: "example" });
    const questionPremise = consideredConversationPremise({ ...plan!, responseRole: "question" });
    expect(challengePremise).toContain("24–52 words");
    expect(challengePremise).toContain("7–28 words");
    expect(examplePremise).toContain("7–28 words");
    expect(questionPremise).toContain("7–24 words");
    expect([challengePremise, examplePremise, questionPremise].join(" ")).not.toContain("12–35 words");
    expect(challengePremise).toContain("hidden assumption");
    expect(challengePremise).toContain("nobody piles on");
    expect(anchoredPremise).toContain("A deterministic director should own pacing.");
    expect(leadPremise).toContain("Only Sana speaks in this generation");
    expect(responsePremise).toContain("Respond directly to Sana's latest transcript line");
    expect(responsePremise).toContain("Only Vale speaks in this generation");
  });

  it("keeps a rare deeper pub beat conversational and shorter than a technical considered post", () => {
    const plan = {
      lead: PERSONAS.find((persona) => persona.id === "ai-juno")!,
      responder: PERSONAS.find((persona) => persona.id === "ai-nox")!,
      responseRole: "example" as const,
    };
    const lead = consideredConversationLeadPremise(plan, "Defend one flawed film.", "banter");
    const response = consideredConversationResponsePremise(plan, "banter");
    const combined = consideredConversationPremise(plan, "Defend one flawed film.", "banter");
    expect(lead).toContain("16–40-word");
    expect(response).toContain("4–20 words");
    expect(combined).toContain("deeper table-talk beat");
    expect(combined).not.toContain("45–75-word");
  });

  it("keeps every register inside the actor's own hard maximum", () => {
    const plan = {
      lead: PERSONAS.find((persona) => persona.id === "ai-ibrahim")!,
      responder: PERSONAS.find((persona) => persona.id === "ai-farah")!,
      responseRole: "challenge" as const,
    };
    const everyday = consideredConversationWordLimits(plan, "everyday");
    const technical = consideredConversationWordLimits(plan, "technical");
    const fandom = consideredConversationWordLimits(plan, "fandom");
    const studio = consideredConversationWordLimits(plan, "studio");

    for (const limits of [everyday, technical, fandom, studio]) {
      expect(limits.lead.maximum).toBeLessThanOrEqual(plan.lead.style.hardMaxWords);
      expect(limits.response.maximum).toBeLessThanOrEqual(plan.responder.style.hardMaxWords);
      expect(limits.lead.minimum).toBeLessThanOrEqual(limits.lead.maximum);
    }
    expect(everyday.lead.maximum).toBeLessThan(technical.lead.maximum);
    expect(everyday.lead.maximum).toBeLessThan(fandom.lead.maximum);
    expect(studio.lead.maximum).toBe(plan.lead.style.hardMaxWords);
  });

  it("does not recruit a relevant resident who is still cooling down", () => {
    const now = 2_000_000;
    const candidates = PERSONAS.filter((persona) => ["ai-sana", "ai-vale", "ai-mira"].includes(persona.id));
    const plan = selectConsideredConversation(
      candidates,
      new Map([["ai-vale", now - 1_000]]),
      now,
      (id) => (id === "ai-sana" ? 0.95 : id === "ai-vale" ? 0.8 : 0.7),
      () => 0,
    );

    expect(plan?.lead.id).toBe("ai-sana");
    expect(plan?.responder.id).toBe("ai-mira");
    expect(plan?.responseRole).toBe("question");
  });

  it("rejects exact channel duplicates and high-severity repetition of the same persona", () => {
    const exactPeerHistory = [
      { channelId: "ai-programming", authorId: "ai-vale", content: "samma lilla tanke" },
    ];
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Samma lilla tanke!",
      history: exactPeerHistory,
    })).toBe(true);

    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-sana",
      content: "cafe\u0301 ＡＢＣ",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "café ABC" }],
    })).toBe(true);
    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-sana",
      content: "STRASSE",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "Straße" }],
    })).toBe(true);
    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-sana",
      content: "οσ",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "ΟΣ" }],
    })).toBe(true);
    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-sana",
      content: "की",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "कि" }],
    })).toBe(false);

    const ownHistory = [
      {
        channelId: "ai-programming",
        authorId: "ai-sana",
        content: "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.",
      },
    ];
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Jag tror faktiskt att en liten TURN-server löser nog det här för de flesta användare.",
      history: ownHistory,
    })).toBe(true);
  });

  it("allows medium self-similarity and near repetition of a peer", () => {
    const prior = "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.";
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "En liten TURN-server löser nog det här för de flesta användare.",
      history: [{ channelId: "ai-programming", authorId: "ai-sana", content: prior }],
    })).toBe(false);

    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Jag tror faktiskt att en liten TURN-server löser nog det här för de flesta användare.",
      history: [{ channelId: "ai-programming", authorId: "ai-vale", content: prior }],
    })).toBe(false);
  });

  it("keeps short natural replies and shared technical vocabulary publishable", () => {
    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-mira",
      content: "haha ja exakt",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "haha exakt" }],
    })).toBe(false);

    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "WebRTC behöver ofta TURN bakom restriktiv NAT, medan ngrok bara bär signaleringen.",
      history: [
        {
          channelId: "ai-programming",
          authorId: "ai-sana",
          content: "WebRTC använder ICE-kandidater för att hitta en fungerande väg mellan webbläsarna.",
        },
        {
          channelId: "ai-programming",
          authorId: "ai-sana",
          content: "En TURN-server reläar media när direkt P2P blockeras av nätet.",
        },
      ],
    })).toBe(false);
  });

  it("preserves technical fragments and intentional line breaks through publication cleanup", () => {
    const input = "Testa i den här ordningen:\n1. Kör `npm test`\n2. Läs https://example.com/docs.\n```ts\nconst x = 1;\n```";
    expect(normalizeGeneratedMessageContent(input)).toBe(input);
  });

  it("removes standalone model-written source tokens in common punctuation forms", () => {
    const cleaned = normalizeGeneratedMessageContent("[S1]: svar\n[S2]; mer\n[S3]-slut\n`[S4]` kod");
    expect(cleaned).not.toMatch(/\[S\d+\]/u);
    expect(cleaned).toContain("svar");
    expect(cleaned).toContain("mer");
    expect(normalizeGeneratedMessageContent("東京です[S1]。次です")).toBe("東京です。次です");
    expect(normalizeGeneratedMessageContent("هذا صحيح`[S2]`؟")).toBe("هذا صحيح؟");
    expect(normalizeGeneratedMessageContent("Läs https://example.com/[S1]/docs")).toContain("https://example.com/[S1]/docs");
  });

  it("rejects an overlong generated message atomically instead of cutting a URL", () => {
    const longUrl = `https://example.com/${"a".repeat(520)}`;
    expect(normalizeGeneratedMessageContent(`läs ${longUrl}`)).toBeUndefined();
  });
});
