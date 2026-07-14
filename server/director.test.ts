import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { PERSONAS } from "./personas.js";
import { createMessage, RoomStore } from "./store.js";
import {
  addressedPersonaIds,
  ambientChannelScore,
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
  conductResponderIds,
  ensureEvidenceResponder,
  evidenceFailureFallback,
  autonomousResearchResultIsFresh,
  canonicalAutonomousResearchUrl,
  linkPreviewFromResearch,
  normalizeGeneratedMessageContent,
  pageEvidenceAnswerContract,
  selectAutoSharedLinkCandidate,
  selectAmbientLead,
  selectAmbientSeed,
  selectAutonomousResearchSeed,
  selectConsideredConversation,
  selectResponders,
  socialSignalsFromTurnAnalysis,
  SocialDirector,
  shouldRejectPublicCandidate,
  shouldStartAutoSharedLinkDiscussion,
  shouldStartAutonomousResearch,
  shouldSurfaceTemporalCue,
  shouldStartConsideredConversation,
  sourceIdsForPageResponder,
  trailingAiMessageCount,
  type ConsideredConversationGate,
  type AmbientThreadState,
} from "./director.js";
import type { AutonomousResearchSeed } from "./channels.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis } from "./semanticRouter.js";
import {
  ambientRoomSelectionWeight,
  autonomousActivityLimits,
  autonomousLinkPolicy,
  resolveBehaviorTuning,
  scaleAmbientDelay,
} from "./behaviorTuning.js";

const classifiedTurn = (overrides: Partial<TurnAnalysis> = {}): TurnAnalysis => ({
  ...createFailClosedTurnAnalysis("disabled"),
  source: "lm",
  failureReason: null,
  language: { tag: "sv", confidence: 0.99 },
  intent: { kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.99 },
  personas: { addressedIds: [], requestedReplyIds: [], relevantIds: [], addressConfidence: 0, relevanceConfidence: 0 },
  social: { warmth: 0.2, hostility: 0, playfulness: 0, absurdity: 0, urgency: 0, energy: 0.3, pileOnRisk: 0, claimStrength: 0, confidence: 0.99 },
  moderation: { risk: "none", action: "none", categories: [], confidence: 0.99 },
  evidence: { need: "none", action: "none", confidence: 0.99, goal: null, query: null, urlRef: null, searchMode: null, timeZone: null, timeKind: null, locationLabel: null },
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
  it("selects only the first supported URL visibly present in the exact latest human text", () => {
    const humanId = "guest-link-scope";
    const trigger = createMessage(
      "lobby",
      humanId,
      "first https://first.example/story then https://second.example/story",
    );
    const candidate = (
      id: `U${number}`,
      raw: string,
      overrides: Partial<{
        source: "message" | "reply" | "recent";
        messageId: string;
        authorId: string;
        supported: boolean;
      }> = {},
    ) => ({
      id,
      raw,
      url: new URL(raw),
      supported: true,
      source: "message" as const,
      messageId: trigger.id,
      authorId: humanId,
      createdAt: trigger.createdAt,
      ...overrides,
    });
    const candidateSet = {
      requestedAt: trigger.createdAt,
      candidates: [
        candidate("U1", "https://second.example/story"),
        candidate("U2", "https://old.example/story", { source: "recent" }),
        candidate("U3", "https://first.example/story"),
        candidate("U4", "https://preview-only.example/story"),
        candidate("U5", "https://first.example/story", { messageId: "another-message" }),
      ],
    };

    expect(selectAutoSharedLinkCandidate(candidateSet, trigger, humanId)?.id).toBe("U3");
    expect(selectAutoSharedLinkCandidate(candidateSet, trigger, "another-human")).toBeUndefined();
    expect(selectAutoSharedLinkCandidate(candidateSet, {
      ...trigger,
      attachments: [{} as never],
    }, humanId)).toBeUndefined();
  });

  it("enforces every automatic shared-link pacing and capacity boundary", () => {
    const now = 2_000_000;
    const base = {
      enabled: true,
      now,
      alreadyInFlight: false,
      globalAttemptsInWindow: 0,
      modelConnected: true,
      queueDepth: 0,
      availableMessageSlots: 1,
      voiceRoomActive: false,
    };
    expect(shouldStartAutoSharedLinkDiscussion(base)).toBe(true);
    for (const override of [
      { enabled: false },
      { alreadyInFlight: true },
      { globalAttemptsInWindow: 4 },
      { modelConnected: false },
      { queueDepth: 1 },
      { availableMessageSlots: 0 },
      { voiceRoomActive: true },
      { lastRequesterAttemptAt: now - 59_999 },
      { lastChannelAttemptAt: now - 59_999 },
      { lastOriginAttemptAt: now - 59_999 },
      { lastSuccessfulChannelUrlAt: now - 20 * 60_000 + 1 },
    ]) {
      expect(shouldStartAutoSharedLinkDiscussion({ ...base, ...override })).toBe(false);
    }
    expect(shouldStartAutoSharedLinkDiscussion({
      ...base,
      lastRequesterAttemptAt: now - 60_000,
      lastChannelAttemptAt: now - 60_000,
      lastOriginAttemptAt: now - 60_000,
      lastSuccessfulChannelUrlAt: now - 20 * 60_000,
    })).toBe(true);
  });

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

  it("augments only explicit root-site reads with the resolved multilingual goal", async () => {
    const human = {
      id: "guest-root-site",
      name: "Guest",
      kind: "human" as const,
      status: "online" as const,
      avatar: { color: "#123", accent: "#456", glyph: "G" },
    };
    const rootUrl = new URL("https://markets.example/");
    const articleUrl = new URL("https://markets.example/company/report");
    const requestedAt = "2026-07-14T16:00:00.000Z";
    const goal = "今日の会社株価を確認する";
    const rootPacket = {
      kind: "page" as const,
      query: goal,
      retrievedAt: requestedAt,
      results: [{ id: "S1", title: "Root page", url: rootUrl.toString(), snippet: "General market overview." }],
    };
    const sameSitePacket = {
      kind: "search" as const,
      query: `site:markets.example ${goal}`,
      retrievedAt: requestedAt,
      results: [{ id: "S1", title: "Company quote", url: articleUrl.toString(), snippet: "A current company quote." }],
    };
    const read = vi.fn(async () => rootPacket);
    const resolveTarget = vi.fn(({ intent }: { intent: string }) => ({
      url: rootUrl,
      requestedAt,
      intent,
      retry: false,
      source: "message" as const,
    }));
    const researchSite = vi.fn()
      .mockResolvedValueOnce(sameSitePacket)
      .mockResolvedValueOnce(undefined);
    const director = new SocialDirector(
      { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
      new RoomStore("/tmp/director-root-site-augmentation-unused.json"),
      {} as never,
      new ActorChannelRuntime(),
      { research: vi.fn(), researchSite } as never,
      {
        getRelation: vi.fn(() => undefined),
        updateRelation: vi.fn(),
        promptNote: vi.fn(() => undefined),
        noteClassifiedMemoryFact: vi.fn(),
      } as never,
      () => [human, ...PERSONAS],
      () => 1,
      {
        pageReader: {
          resolveTarget,
          read,
        } as never,
      },
    );
    const candidateSet = {
      requestedAt,
      candidates: [{
        id: "U1" as const,
        raw: rootUrl.toString(),
        url: rootUrl,
        supported: true,
        source: "message" as const,
        messageId: "root-message",
        authorId: human.id,
        createdAt: requestedAt,
      }],
    };
    const analysis = classifiedTurn({
      evidence: {
        need: "required",
        action: "read_url",
        confidence: 0.99,
        goal,
        query: null,
        urlRef: "U1",
        searchMode: null,
        timeZone: null,
        timeKind: null,
        locationLabel: null,
      },
      capabilities: {
        discussed: ["read_url"],
        requestKind: "execute",
        asksAboutAcoustics: false,
        asksAboutAiIdentity: false,
        asksForList: false,
        confidence: 0.99,
      },
    });
    const internal = director as unknown as {
      classifiedToolPlan: (
        turn: TurnAnalysis,
        candidates: typeof candidateSet,
        rawIntent: string,
        requesterId: string,
      ) => {
        pageReadRequest?: {
          url?: URL;
          requestedAt: string;
          intent: string;
          retry: boolean;
          source: "message" | "reply" | "recent";
          initiator?: "explicit" | "automatic";
        };
        siteResearch?: { goal: string; mode: "web" | "news" };
      };
      resolveRequestedEvidence: (
        page: {
          url?: URL;
          requestedAt: string;
          intent: string;
          retry: boolean;
          source: "message" | "reply" | "recent";
          initiator?: "explicit" | "automatic";
        } | undefined,
        search: undefined,
        requesterId: string,
        site?: { goal: string; mode: "web" | "news" },
      ) => Promise<typeof sameSitePacket | typeof rootPacket | undefined>;
    };

    const plan = internal.classifiedToolPlan(analysis, candidateSet, "gå bara till sajten", human.id);
    expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({ intent: goal, retry: false }));
    resolveTarget.mockClear();
    internal.classifiedToolPlan({
      ...analysis,
      capabilities: { ...analysis.capabilities, requestKind: "correct_limitation" },
    }, candidateSet, "gå bara till sajten", human.id);
    expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({ intent: goal, retry: true }));
    await expect(internal.resolveRequestedEvidence(
      plan.pageReadRequest,
      undefined,
      human.id,
      plan.siteResearch,
    )).resolves.toEqual(sameSitePacket);
    expect(researchSite).toHaveBeenCalledWith({
      url: rootUrl,
      query: goal,
      mode: "web",
      requesterId: human.id,
    });
    expect(read).not.toHaveBeenCalled();

    await expect(internal.resolveRequestedEvidence(
      plan.pageReadRequest,
      undefined,
      human.id,
      plan.siteResearch,
    )).resolves.toEqual(rootPacket);
    expect(researchSite).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);

    researchSite.mockClear();
    read.mockClear();
    await expect(internal.resolveRequestedEvidence(
      { ...plan.pageReadRequest!, url: articleUrl },
      undefined,
      human.id,
      plan.siteResearch,
    )).resolves.toEqual(rootPacket);
    expect(researchSite).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);

    read.mockClear();
    await expect(internal.resolveRequestedEvidence(
      { ...plan.pageReadRequest!, initiator: "automatic" },
      undefined,
      human.id,
      plan.siteResearch,
    )).resolves.toEqual(rootPacket);
    expect(researchSite).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    director.stop();
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
              goal: "dagens marknadsutveckling",
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

  it("turns one passive public link into one grounded reply and claims duplicate deliveries", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-07-14T12:00:00.000Z");
      const human = {
        id: "guest-auto-link",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const sourceUrl = "https://example.com/shared#first";
      const store = new RoomStore("/tmp/director-auto-link-success-unused.json");
      const incoming = createMessage("lobby", human.id, `Den här dök upp ${sourceUrl}`);
      store.addPublicMessage(incoming);
      const packet = {
        kind: "page" as const,
        query: incoming.content,
        retrievedAt: new Date(now).toISOString(),
        results: [{
          id: "S1",
          title: "Concrete shared report",
          url: sourceUrl,
          snippet: "The report measures whether a recovered step preserves later state.",
        }],
      };
      const analyzeTurn = vi.fn(async () => classifiedTurn({
        intent: { kind: "statement", isQuestion: false, replyExpected: "optional", confidence: 0.99 },
      }));
      const generateScene = vi.fn(async (request: {
        selected: Array<(typeof PERSONAS)[number]>;
        mustReplyIds: string[];
        research?: typeof packet;
        premise?: string;
        urlPublicationPolicy?: string;
      }) => request.selected.map((persona, index) => ({
        personaId: persona.id,
        content: request.premise?.includes("actual request")
          ? `Den explicita rollen ${index + 1} kommenterar hur testet återställer ett misslyckat steg.`
          : "Det konkreta testet är att senare tillstånd måste överleva återhämtningen, inte bara nästa svar.",
        source: "lm" as const,
        sourceIds: [],
      })));
      const read = vi.fn(async () => packet);
      let queueDepth = 0;
      const pageReader = {
        collectCandidates: vi.fn(({ messages }: { messages: typeof incoming[] }) => {
          const latest = messages.at(-1)!;
          const raw = latest.content.match(/https:\/\/\S+/u)?.[0] ?? sourceUrl;
          return {
            requestedAt: new Date(now).toISOString(),
            candidates: [{
              id: "U1" as const,
              raw,
              url: new URL(raw),
              supported: true,
              source: "message" as const,
              messageId: latest.id,
              authorId: latest.authorId,
              createdAt: latest.createdAt,
            }],
          };
        }),
        resolveTarget: vi.fn(({ candidateSet, intent }: { candidateSet: { requestedAt: string }; intent: string }) => ({
          url: new URL(sourceUrl),
          requestedAt: candidateSet.requestedAt,
          intent,
          retry: false,
          source: "message" as const,
        })),
        read,
      };
      const emit = vi.fn();
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth })),
          analyzeTurn,
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          pageReader: pageReader as never,
          autoSharedLinkDiscussionEnabled: true,
        },
      );
      const handle = (messages: typeof incoming[]) => (director as unknown as {
        handleHumanBurst: (items: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst(messages, human);

      const first = handle([incoming]);
      await vi.runAllTimersAsync();
      await first;
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ initiator: "automatic" }), human.id);
      expect(generateScene).toHaveBeenCalledTimes(1);
      const scene = generateScene.mock.calls[0]![0];
      expect(scene.selected).toHaveLength(1);
      expect(scene.mustReplyIds).toEqual([scene.selected[0]?.id]);
      expect(scene.research).toEqual(packet);
      expect(scene.premise).toContain("one grounded response");
      expect(scene.urlPublicationPolicy).toBe("server_card");
      const reply = store.getRecent("lobby", 10).filter((message) => message.authorId !== human.id);
      expect(reply).toHaveLength(1);
      expect(reply[0]).toMatchObject({
        replyToId: incoming.id,
        sources: [{ title: "Concrete shared report", url: sourceUrl }],
        linkPreview: { url: sourceUrl, title: "Concrete shared report" },
      });
      expect((director as unknown as {
        ambientThreads: Map<string, AmbientThreadState>;
      }).ambientThreads.get("lobby")?.research).toMatchObject({ kind: "page", results: [{ id: "S1", url: sourceUrl }] });

      await handle([incoming]);
      now += 61_000;
      const sameCanonical = createMessage("lobby", human.id, "Igen https://example.com/shared#other");
      store.addPublicMessage(sameCanonical);
      await handle([sameCanonical]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(store.getRecent("lobby", 20).filter((message) => message.authorId !== human.id)).toHaveLength(1);

      queueDepth = 2;
      analyzeTurn.mockResolvedValueOnce(classifiedTurn({
        intent: { kind: "request", isQuestion: false, replyExpected: "expected", confidence: 0.99 },
        evidence: {
          need: "required",
          action: "read_url",
          confidence: 0.99,
          goal: "vad som står på den delade sidan",
          query: null,
          urlRef: "U1",
          searchMode: null,
          timeZone: null,
          timeKind: null,
          locationLabel: null,
        },
        capabilities: {
          discussed: ["read_url"],
          requestKind: "execute",
          asksAboutAcoustics: false,
          asksAboutAiIdentity: false,
          asksForList: false,
          confidence: 0.99,
        },
      }));
      const explicit = createMessage(
        "lobby",
        human.id,
        "@Mira @Sana läs https://example.com/explicit och säg vad som står",
      );
      store.addPublicMessage(explicit);
      const explicitPending = handle([explicit]);
      await vi.runAllTimersAsync();
      await explicitPending;
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[1]?.[0]).not.toMatchObject({ initiator: "automatic" });
      expect(generateScene).toHaveBeenCalledTimes(2);
      expect(generateScene.mock.calls[1]?.[0]).toMatchObject({
        urlPublicationPolicy: "server_card",
      });
      const explicitScene = generateScene.mock.calls[1]![0];
      expect(explicitScene.selected.map((persona) => persona.id)).toEqual(expect.arrayContaining(["ai-mira", "ai-sana"]));
      expect(explicitScene.mustReplyIds).toEqual(expect.arrayContaining(["ai-mira", "ai-sana"]));
      expect(store.getRecent("lobby", 20).filter((message) => message.authorId !== human.id))
        .toHaveLength(1 + explicitScene.selected.length);
      expect(emit.mock.calls.some(([event, payload]) =>
        event === "typing:member" && payload?.active === true,
      )).toBe(true);
      director.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unreadable automatic shared link completely silent", async () => {
    vi.useFakeTimers();
    try {
      const human = {
        id: "guest-auto-link-failure",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const incoming = createMessage("lobby", human.id, "https://example.com/unreadable");
      const store = new RoomStore("/tmp/director-auto-link-failure-unused.json");
      store.addPublicMessage(incoming);
      const emit = vi.fn();
      const generateScene = vi.fn(async () => []);
      const read = vi.fn(async () => undefined);
      const search = vi.fn(async () => undefined);
      const analyzeTurn = vi.fn(async () => createFailClosedTurnAnalysis("timeout"));
      const pageReader = {
        collectCandidates: vi.fn(() => ({
          requestedAt: incoming.createdAt,
          candidates: [{
            id: "U1" as const,
            raw: incoming.content,
            url: new URL(incoming.content),
            supported: true,
            source: "message" as const,
            messageId: incoming.id,
            authorId: human.id,
            createdAt: incoming.createdAt,
          }],
        })),
        resolveTarget: vi.fn(() => ({
          url: new URL(incoming.content),
          requestedAt: incoming.createdAt,
          intent: incoming.content,
          retry: false,
          source: "message" as const,
        })),
        read,
      };
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          analyzeTurn,
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        { research: search, researchSite: vi.fn(async () => undefined) } as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        { pageReader: pageReader as never, autoSharedLinkDiscussionEnabled: true, rng: () => 0.99 },
      );
      await (director as unknown as {
        handleHumanBurst: (items: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ initiator: "automatic" }), human.id);
      expect(search).not.toHaveBeenCalled();
      expect(generateScene).not.toHaveBeenCalled();
      expect(store.getRecent("lobby", 10)).toEqual([incoming]);
      expect(emit.mock.calls.some(([event, payload]) =>
        event === "typing:member" && payload?.active === true,
      )).toBe(false);

      analyzeTurn.mockResolvedValueOnce(classifiedTurn({
        intent: { kind: "statement", isQuestion: false, replyExpected: "optional", confidence: 0.99 },
        evidence: {
          need: "optional",
          action: "read_url",
          confidence: 0.99,
          goal: "vad som står på den delade sidan",
          query: null,
          urlRef: "U1",
          searchMode: null,
          timeZone: null,
          timeKind: null,
          locationLabel: null,
        },
      }));
      generateScene.mockImplementationOnce(async (request: { selected: Array<(typeof PERSONAS)[number]> }) => [{
        personaId: request.selected[0]!.id,
        content: "Jag fick inte fram just den sidan den här gången.",
        source: "lm" as const,
        sourceIds: [],
      }]);
      const explicit = createMessage("lobby", human.id, "Läs https://example.com/unreadable om du kan");
      store.addPublicMessage(explicit);
      const explicitPending = (director as unknown as {
        handleHumanBurst: (items: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([explicit], human);
      await vi.runAllTimersAsync();
      await explicitPending;
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[1]?.[0]).not.toMatchObject({ initiator: "automatic" });
      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(search).not.toHaveBeenCalled();
      expect(store.getRecent("lobby", 10).at(-1)).toMatchObject({
        content: "Jag fick inte fram just den sidan den här gången.",
        replyToId: explicit.id,
      });
      director.stop();
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
          goal: "aktuell tid i Sverige",
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
          goal: "aktuell tid i Sverige",
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

  it("keeps a departed human's frozen display name in semantic-router context", async () => {
    const departed = {
      id: "guest-departed-dimitra",
      name: "Δήμητρα",
      kind: "human" as const,
      status: "offline" as const,
      avatar: { color: "#345", accent: "#789", glyph: "Δ" },
    };
    const current = {
      id: "guest-current-router",
      name: "Current guest",
      kind: "human" as const,
      status: "online" as const,
      avatar: { color: "#123", accent: "#456", glyph: "C" },
    };
    const older = createMessage(
      "lobby",
      departed.id,
      "Θα επιστρέψω αργότερα.",
      { authorSnapshot: departed },
    );
    const latest = createMessage("lobby", current.id, "Μια καινούργια ερώτηση.");
    const analyzeTurn = vi.fn(async () => classifiedTurn({
      language: { tag: "el", confidence: 0.99 },
    }));
    const director = new SocialDirector(
      { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
      new RoomStore("/tmp/director-departed-router-name-unused.json"),
      { analyzeTurn, rememberDeliveredLine: vi.fn() } as never,
      new ActorChannelRuntime(),
      {} as never,
      {
        getRelation: vi.fn(() => undefined),
        updateRelation: vi.fn(),
        promptNote: vi.fn(() => undefined),
        noteClassifiedMemoryFact: vi.fn(),
      } as never,
      () => [current, ...PERSONAS],
      () => 1,
    );

    await (director as unknown as {
      analyzeHumanTurn: (input: {
        medium: "public";
        turnId: string;
        channelId: string;
        latest: typeof latest;
        burst: Array<typeof latest>;
        recent: Array<typeof latest>;
        personas: typeof PERSONAS;
        candidateSet: { requestedAt: string; candidates: never[] };
        allowSearch: boolean;
      }) => Promise<TurnAnalysis>;
    }).analyzeHumanTurn({
      medium: "public",
      turnId: `public:${latest.id}`,
      channelId: "lobby",
      latest,
      burst: [latest],
      recent: [older],
      personas: PERSONAS,
      candidateSet: { requestedAt: latest.createdAt, candidates: [] },
      allowSearch: true,
    });
    director.stop();

    expect(analyzeTurn).toHaveBeenCalledTimes(1);
    expect(analyzeTurn.mock.calls[0]?.[0].recentMessages).toContainEqual(expect.objectContaining({
      id: older.id,
      authorId: departed.id,
      authorName: "Δήμητρα",
      content: older.content,
    }));
    expect(analyzeTurn.mock.calls[0]?.[0].recentMessages).not.toContainEqual(expect.objectContaining({
      id: older.id,
      authorName: "guest",
    }));
  });

  it("recalls an exact older public episode and appoints a real witness to answer", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-14T14:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const human = {
        id: "guest-room-recall",
        name: "Nikos",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "N" },
      };
      const departed = {
        id: "guest-periklis",
        name: "Περικλής",
        kind: "human" as const,
        status: "offline" as const,
        avatar: { color: "#345", accent: "#678", glyph: "Π" },
      };
      const fillerAuthor = {
        id: "guest-archive-filler",
        name: "Archive guest",
        kind: "human" as const,
        status: "offline" as const,
        avatar: { color: "#222", accent: "#444", glyph: "A" },
      };
      const store = new RoomStore("/tmp/director-grounded-room-recall-unused.json");
      const at = (message: ReturnType<typeof createMessage>, time: number) => {
        message.createdAt = new Date(time).toISOString();
        store.addPublicMessage(message);
        return message;
      };
      const oldHuman = at(createMessage(
        "lobby",
        departed.id,
        "Γεια, είμαι ο Περικλής και δοκιμάζω το παλιό αρχείο.",
        { authorSnapshot: departed },
      ), now - 2 * 60 * 60_000);
      const oldWitness = at(createMessage(
        "lobby",
        "ai-mira",
        "Χάρηκα, Περικλή — θα το θυμάμαι ως δοκιμή αρχείου.",
        { replyToId: oldHuman.id },
      ), now - 2 * 60 * 60_000 + 60_000);
      for (let index = 0; index < 34; index += 1) {
        at(createMessage(
          "lobby",
          fillerAuthor.id,
          `unrelated archive row ${index}`,
          { authorSnapshot: fillerAuthor },
        ), now - 60 * 60_000 + index * 1_000);
      }
      const trigger = at(createMessage(
        "lobby",
        human.id,
        "Θυμάστε τον Περικλή από πριν;",
      ), now);
      const analyzeTurn = vi.fn(async () => classifiedTurn({
        language: { tag: "el", confidence: 0.99 },
        historyRecall: {
          need: "required",
          query: "Περικλής",
          confidence: 0.99,
        },
      }));
      const generateScene = vi.fn(async (request: {
        selected: Array<(typeof PERSONAS)[number]>;
        mustReplyIds: string[];
        requestOwnerIds: string[];
        history: Array<{ author: string; content: string }>;
        roomRecall?: {
          witnessPersonaIds: string[];
          transcript: Array<{ author: string; kind: string; content: string; createdAt: string }>;
        };
        premise?: string;
      }) => [{
        personaId: request.requestOwnerIds[0] ?? request.selected[0]!.id,
        content: "Ναι, ήμουν εδώ όταν μπήκε ο Περικλής.",
        source: "lm" as const,
        sourceIds: [],
      }]);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        { analyzeTurn, generateScene, rememberDeliveredLine: vi.fn() } as never,
        new ActorChannelRuntime(),
        {} as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          pageReader: {
            collectCandidates: vi.fn(() => ({ requestedAt: trigger.createdAt, candidates: [] })),
          } as never,
        },
      );

      const pending = (director as unknown as {
        handleHumanBurst: (messages: Array<typeof trigger>, member: typeof human) => Promise<void>;
      }).handleHumanBurst([trigger], human);
      await vi.advanceTimersByTimeAsync(12_000);
      await pending;
      director.stop();

      expect(analyzeTurn).toHaveBeenCalledTimes(1);
      expect(analyzeTurn.mock.calls[0]?.[0].recentMessages).not.toContainEqual(expect.objectContaining({
        id: oldHuman.id,
      }));
      expect(generateScene).toHaveBeenCalledTimes(1);
      const scene = generateScene.mock.calls[0]![0];
      expect(scene.history).toHaveLength(26);
      expect(scene.history.some((line) => line.content === oldHuman.content)).toBe(false);
      expect(scene.roomRecall?.transcript).toEqual([
        {
          author: "Περικλής",
          kind: "human",
          content: oldHuman.content,
          createdAt: oldHuman.createdAt,
        },
        {
          author: "Mira",
          kind: "ai",
          content: oldWitness.content,
          createdAt: oldWitness.createdAt,
        },
      ]);
      expect(scene.roomRecall?.transcript.length).toBeLessThanOrEqual(8);
      expect(scene.roomRecall?.witnessPersonaIds).toEqual(["ai-mira"]);
      expect(scene.selected.map((persona) => persona.id)).toContain("ai-mira");
      expect(scene.requestOwnerIds).toEqual(["ai-mira"]);
      expect(scene.mustReplyIds).toContain("ai-mira");
      expect(scene.premise).toContain("Mira is the server-observed witness");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose room recall when the semantic gate is weak or says none", async () => {
    vi.useFakeTimers();
    const baseNow = Date.parse("2026-07-14T15:00:00.000Z");
    vi.setSystemTime(baseNow);
    try {
      const cases: Array<{
        label: string;
        historyRecall: NonNullable<TurnAnalysis["historyRecall"]>;
        intent?: TurnAnalysis["intent"];
      }> = [
        {
          label: "low-confidence",
          historyRecall: { need: "required", query: "記憶対象", confidence: 0.79 },
        },
        {
          label: "none",
          historyRecall: { need: "none", query: null, confidence: 0.99 },
        },
        {
          label: "trusted-no-source",
          historyRecall: { need: "required", query: "存在しない名前", confidence: 0.99 },
          intent: { kind: "statement", isQuestion: false, replyExpected: "none", confidence: 0.99 },
        },
      ];

      for (const [caseIndex, testCase] of cases.entries()) {
        const now = baseNow + caseIndex * 10 * 60_000;
        const human = {
          id: `guest-recall-gate-${caseIndex}`,
          name: "Guest",
          kind: "human" as const,
          status: "online" as const,
          avatar: { color: "#123", accent: "#456", glyph: "G" },
        };
        const oldHuman = {
          id: `guest-old-recall-gate-${caseIndex}`,
          name: "記憶対象",
          kind: "human" as const,
          status: "offline" as const,
          avatar: { color: "#234", accent: "#567", glyph: "記" },
        };
        const filler = {
          id: `guest-filler-recall-gate-${caseIndex}`,
          name: "Filler",
          kind: "human" as const,
          status: "offline" as const,
          avatar: { color: "#222", accent: "#333", glyph: "F" },
        };
        const store = new RoomStore(`/tmp/director-room-recall-${testCase.label}-unused.json`);
        const addAt = (message: ReturnType<typeof createMessage>, time: number) => {
          message.createdAt = new Date(time).toISOString();
          store.addPublicMessage(message);
          return message;
        };
        const old = addAt(createMessage(
          "lobby",
          oldHuman.id,
          "記憶対象 が以前ここにいました。",
          { authorSnapshot: oldHuman },
        ), now - 2 * 60 * 60_000);
        addAt(createMessage("lobby", "ai-mira", "前の会話への短い返事。", { replyToId: old.id }), now - 2 * 60 * 60_000 + 1_000);
        for (let index = 0; index < 30; index += 1) {
          addAt(createMessage(
            "lobby",
            filler.id,
            `unrelated row ${index}`,
            { authorSnapshot: filler },
          ), now - 60 * 60_000 + index * 1_000);
        }
        const trigger = addAt(createMessage("lobby", human.id, "記憶対象について覚えていますか？"), now);
        const analyzeTurn = vi.fn(async () => classifiedTurn({
          language: { tag: "ja", confidence: 0.99 },
          ...(testCase.intent ? { intent: testCase.intent } : {}),
          historyRecall: testCase.historyRecall,
        }));
        const generateScene = vi.fn(async (request: {
          selected: Array<(typeof PERSONAS)[number]>;
          mustReplyIds: string[];
          roomRecall?: unknown;
          premise?: string;
        }) => [{
          personaId: request.selected[0]!.id,
          content: "短い返事です。",
          source: "lm" as const,
          sourceIds: [],
        }]);
        const director = new SocialDirector(
          { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
          store,
          { analyzeTurn, generateScene, rememberDeliveredLine: vi.fn() } as never,
          new ActorChannelRuntime(),
          {} as never,
          {
            getRelation: vi.fn(() => undefined),
            updateRelation: vi.fn(),
            promptNote: vi.fn(() => undefined),
            noteClassifiedMemoryFact: vi.fn(),
          } as never,
          () => [human, ...PERSONAS],
          () => 1,
          {
            now: () => now,
            rng: () => 0.99,
            pageReader: {
              collectCandidates: vi.fn(() => ({ requestedAt: trigger.createdAt, candidates: [] })),
            } as never,
          },
        );

        const pending = (director as unknown as {
          handleHumanBurst: (messages: Array<typeof trigger>, member: typeof human) => Promise<void>;
        }).handleHumanBurst([trigger], human);
        await vi.advanceTimersByTimeAsync(12_000);
        await pending;
        director.stop();

        expect(generateScene, testCase.label).toHaveBeenCalledTimes(1);
        const scene = generateScene.mock.calls[0]![0];
        expect(scene.roomRecall, testCase.label).toBeUndefined();
        expect(scene.premise ?? "", testCase.label).not.toContain("retained public-room excerpt");
        if (testCase.label === "trusted-no-source") {
          expect(scene.mustReplyIds.length).toBeGreaterThan(0);
          expect(scene.premise).toContain("no matching retained public excerpt was found");
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a required conflict reaction through the public scene contract", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    try {
      const human = {
        id: "guest-conflict-contract",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const store = new RoomStore("/tmp/director-conflict-contract-test-unused.json");
      const incoming = createMessage("lobby", human.id, "opaque hostile utterance");
      store.addPublicMessage(incoming);
      await store.flush();
      const analyzeTurn = vi.fn(async () => classifiedTurn({
        language: { tag: "en", confidence: 0.99 },
        responseLanguage: { tag: "sv", confidence: 0.98 },
        intent: { kind: "statement", isQuestion: false, replyExpected: "none", confidence: 0.99 },
        social: {
          ...classifiedTurn().social,
          warmth: 0,
          hostility: 0.88,
          playfulness: 0.04,
          pileOnRisk: 0.91,
          energy: 0.62,
        },
        interaction: {
          kind: "directed_insult",
          targetScope: "room",
          reactionNeed: "required",
          coarseness: 0.94,
          mutualBanterConfidence: 0.02,
          confidence: 0.99,
        },
        moderation: { risk: "low", action: "watch", categories: ["harassment"], confidence: 0.98 },
      }));
      const generateScene = vi.fn(async (request: {
        selected: Array<(typeof PERSONAS)[number]>;
        mustReplyIds: string[];
        semanticContext?: Record<string, unknown>;
        languageHint?: string;
        premise?: string;
      }) => [{
        personaId: request.selected[0]!.id,
        content: "Nej. Så snackar du inte med folk här.",
        source: "lm" as const,
        sourceIds: [],
      }]);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        { analyzeTurn, generateScene, rememberDeliveredLine: vi.fn() } as never,
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
          pageReader: {
            collectCandidates: vi.fn(() => ({ requestedAt: new Date().toISOString(), candidates: [] })),
          } as never,
          rng: () => 0.99,
        },
      );

      const pending = (director as unknown as {
        handleHumanBurst: (messages: Array<typeof incoming>, member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;
      await vi.runAllTimersAsync();
      director.stop();

      expect(generateScene).toHaveBeenCalledTimes(1);
      const request = generateScene.mock.calls[0]![0];
      expect(request.selected).toHaveLength(1);
      expect(request.selected[0]?.id).not.toBe("ai-runa");
      expect(request.mustReplyIds).toEqual([request.selected[0]?.id]);
      expect(request.languageHint).toBe("sv");
      expect(request.semanticContext).toEqual({
        languageTag: "sv",
        intentTrusted: true,
        replyExpected: "none",
        socialTrusted: true,
        warmth: 0,
        hostility: 0.88,
        playfulness: 0.04,
        absurdity: 0,
        urgency: 0,
        energy: 0.62,
        pileOnRisk: 0.91,
        claimStrength: 0,
        interactionTrusted: true,
        interactionKind: "directed_insult",
        targetScope: "room",
        reactionNeed: "required",
        coarseness: 0.94,
        mutualBanterConfidence: 0.02,
        moderationTrusted: true,
        moderationRisk: "low",
        moderationAction: "watch",
        moderationCategories: ["harassment"],
        asksForList: false,
        asksAboutAiIdentity: false,
        asksAboutAcoustics: false,
      });
      expect(request.premise).toContain("One designated resident must react directly");
      expect(store.getRecent("lobby", 1)[0]?.authorId).toBe(request.selected[0]?.id);
      expect(director.trustedLanguageForChannel("lobby")).toBe("sv");
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

  it("gives an empty central request-owner attempt one focused semantic retry", async () => {
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
      let sceneAttempt = 0;
      const generateScene = vi.fn(async (request: { selected: Array<(typeof PERSONAS)[number]> }) => {
        sceneAttempt += 1;
        return sceneAttempt === 1
          ? []
          : [{
              personaId: request.selected[0]!.id,
              content: "Jag vet faktiskt inte säkert.",
              source: "lm" as const,
              sourceIds: [],
            }];
      });
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
      expect(generateScene.mock.calls[1]?.[0].selected).toHaveLength(1);
      expect(store.getRecent("lobby", 5)).toHaveLength(2);
      expect(store.getRecent("lobby", 1)[0]).toMatchObject({
        content: "Jag vet faktiskt inte säkert.",
        replyToId: incoming.id,
        generation: "lm",
      });
      expect(store.getRecent("lobby", 5).some((message) => message.content.includes("bold thing"))).toBe(false);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reserves one bounded reply for an explicit human request when ambient traffic filled the normal pace", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-14T18:30:00.000Z");
    try {
      const human = {
        id: "guest-priority-reply",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const store = new RoomStore("/tmp/director-priority-human-reply-unused.json");
      const incoming = createMessage("lobby", human.id, "Kan någon svara på min fråga?");
      store.addPublicMessage(incoming);
      const generateScene = vi.fn(async (request: { selected: Array<(typeof PERSONAS)[number]> }) => [{
        personaId: request.selected[0]!.id,
        content: "Ja, jag tar den.",
        source: "lm" as const,
        sourceIds: [],
      }]);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          analyzeTurn: vi.fn(async () => classifiedTurn({
            intent: { kind: "request", isQuestion: true, replyExpected: "expected", confidence: 0.99 },
          })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
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
          now: () => now,
          rng: () => 0.99,
          pageReader: {
            collectCandidates: vi.fn(() => ({ requestedAt: new Date(now).toISOString(), candidates: [] })),
          } as never,
        },
      );
      const internal = director as unknown as {
        handleHumanBurst: (messages: Array<typeof incoming>, member: typeof human) => Promise<void>;
        aiTimestamps: number[];
        priorityHumanReplyTimestamps: number[];
      };
      internal.aiTimestamps.push(now, now, now);

      const pending = internal.handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;
      director.stop();

      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(store.getRecent("lobby", 1)[0]).toMatchObject({
        content: "Ja, jag tar den.",
        replyToId: incoming.id,
        generation: "lm",
      });
      expect(internal.priorityHumanReplyTimestamps).toEqual([now]);
      expect(internal.aiTimestamps).toHaveLength(4);
    } finally {
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
          goal: query,
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

  it("assigns exactly one non-moderator to a required directed-insult reaction", () => {
    const analysis = classifiedTurn({
      intent: { kind: "statement", isQuestion: false, replyExpected: "none", confidence: 0.99 },
      social: {
        ...classifiedTurn().social,
        hostility: 0.88,
        playfulness: 0.04,
        pileOnRisk: 0.91,
      },
      interaction: {
        kind: "directed_insult",
        targetScope: "room",
        reactionNeed: "required",
        coarseness: 0.94,
        mutualBanterConfidence: 0.02,
        confidence: 0.99,
      },
      moderation: { risk: "low", action: "watch", categories: ["harassment"], confidence: 0.98 },
    });
    const signals = socialSignalsFromTurnAnalysis(
      analysis,
      [],
      analyzeSocialSignals("opaque hostile utterance"),
    );
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).not.toBe("ai-runa");
    expect(conductResponderIds(selected, signals)).toEqual([selected[0]?.id]);
  });

  it.each([
    ["ambient_profanity", "none"],
    ["playful_banter", "optional"],
  ] as const)("does not recruit Runa or a dogpile for %s", (kind, reactionNeed) => {
    const analysis = classifiedTurn({
      social: {
        ...classifiedTurn().social,
        hostility: 0.05,
        playfulness: kind === "playful_banter" ? 0.92 : 0.18,
        pileOnRisk: 0.78,
      },
      interaction: {
        kind,
        targetScope: kind === "ambient_profanity" ? "self_or_situation" : "previous_speaker",
        reactionNeed,
        coarseness: 0.87,
        mutualBanterConfidence: kind === "playful_banter" ? 0.96 : 0.08,
        confidence: 0.99,
      },
      moderation: { risk: "none", action: "none", categories: [], confidence: 0.99 },
    });
    const signals = socialSignalsFromTurnAnalysis(
      analysis,
      [],
      analyzeSocialSignals("opaque coarse utterance"),
    );
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.5);

    expect(selected.map((persona) => persona.id)).not.toContain("ai-runa");
    expect(selected.length).toBeLessThanOrEqual(1);
    expect(conductResponderIds(selected, signals)).toEqual([]);
  });

  it("does not confuse names with substrings", () => {
    expect(analyzeSocialSignals("det här är en beautiful idé").mentionedIds).not.toContain("ai-bea");
    expect(analyzeSocialSignals("vad tycker ni om valet?").mentionedIds).not.toContain("ai-vale");
    expect(analyzeSocialSignals("Vale, vad tycker du?").mentionedIds).not.toContain("ai-vale");
    expect(analyzeSocialSignals("@Vale, vad tycker du?").mentionedIds).toContain("ai-vale");
  });

  it.each(["deescalate", "report", "block"] as const)(
    "routes a trusted %s action to Runa and makes her response mandatory",
    (action) => {
      const analysis = classifiedTurn({
        language: { tag: "de", confidence: 0.99 },
        social: { ...classifiedTurn().social, hostility: 0.86, pileOnRisk: 0.92 },
        interaction: {
          kind: action === "deescalate" ? "harassment" : "threat",
          targetScope: "named_participant",
          reactionNeed: "required",
          coarseness: 0.91,
          mutualBanterConfidence: 0,
          confidence: 0.99,
        },
        moderation: {
          risk: action === "block" ? "high" : "medium",
          action,
          categories: action === "deescalate" ? ["harassment"] : ["threat"],
          confidence: 0.96,
        },
      });
      const signals = socialSignalsFromTurnAnalysis(
        analysis,
        [],
        analyzeSocialSignals("opaque policy-triggering utterance"),
      );
      const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);

      expect(signals.aggression).toBeGreaterThanOrEqual(0.4);
      expect(selected.map((persona) => persona.id)).toEqual(["ai-runa"]);
      expect(conductResponderIds(selected, signals)).toEqual(["ai-runa"]);
    },
  );

  it("does not infer moderator authority from raw hostility alone", () => {
    const analysis = classifiedTurn({
      social: { ...classifiedTurn().social, hostility: 0.97 },
      interaction: {
        kind: "directed_insult",
        targetScope: "room",
        reactionNeed: "optional",
        coarseness: 0.9,
        mutualBanterConfidence: 0.03,
        confidence: 0.99,
      },
      moderation: { risk: "low", action: "watch", categories: ["harassment"], confidence: 0.99 },
    });
    const signals = socialSignalsFromTurnAnalysis(
      analysis,
      [],
      analyzeSocialSignals("opaque hostile utterance"),
    );
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.5);

    expect(signals.aggression).toBe(0.97);
    expect(selected.map((persona) => persona.id)).not.toContain("ai-runa");
    expect(conductResponderIds(selected, signals)).toEqual([]);
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

  it("rotates across a recent ambient window instead of allowing A/B/A loops", () => {
    const seeds = Array.from({ length: 8 }, (_, index) => `seed-${index}`);
    expect(selectAmbientSeed(seeds, seeds.slice(0, 6), () => 0)).toBe("seed-6");
    expect(selectAmbientSeed(["a", "b"], ["a", "b"], () => 0)).toBe("a");
    expect(selectAmbientSeed(["only"], ["only"], () => 0)).toBe("only");

    const researchSeeds: AutonomousResearchSeed[] = ["a", "b", "c"].map((id) => ({
      id,
      query: `query ${id}`,
      mode: "web",
      discussionAngle: `angle ${id}`,
    }));
    expect(selectAutonomousResearchSeed(researchSeeds, ["a", "b"], () => 0)?.id).toBe("c");
  });

  it("rotates semantic seed families instead of selecting a reworded recent subject", () => {
    const seeds = ["trace one", "memory one", "trace two", "voice one", "memory two"];
    const families = ["observability", "memory", "observability", "voice", "memory"];
    expect(selectAmbientSeed(seeds, ["trace one", "memory one"], () => 0, families)).toBe("voice one");
  });

  it("keeps real disagreement in casual and banter registers without making it academic", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-juno")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-bosse")!;
    const casual = ambientConversationPremise("one ordinary preference", lead, responder, false, true, "casual");
    const banter = ambientConversationPremise("one film ranking", lead, responder, false, true, "banter");
    expect(casual).toContain("specific counterexample or competing preference");
    expect(casual).toContain("Do not soften it into agreement");
    expect(banter).toContain("incompatible concrete preference");
    expect(banter).toContain("do not politely agree");
    expect(casual).toContain("ordinary");
    expect(banter).toContain("table-talk");
  });

  it("finishes a live bounded thread before opening the stalest new room topic", () => {
    const quietLiveThread = ambientChannelScore({
      idleMinutes: 0,
      rotated: false,
      hasLiveThread: true,
      random: 0,
    });
    const stalestFreshRoom = ambientChannelScore({
      idleMinutes: 20,
      rotated: true,
      hasLiveThread: false,
      random: 1,
    });
    expect(quietLiveThread).toBeGreaterThan(stalestFreshRoom);
  });

  it("starts autonomous research only behind every quiet-time, budget and cooldown gate", () => {
    const base = {
      enabled: true,
      now: 10_000_000,
      globalCooldownMs: 60_000,
      channelCooldownMs: 120_000,
      humanQuietMs: 90_000,
      queueDepth: 0,
      availableMessageSlots: 2,
      dailyAttempts: 0,
      dailyCap: 6,
      voiceRoomActive: false,
      freshThread: true,
      availableActors: 2,
      chance: 0.1,
      rng: () => 0.05,
    };
    expect(shouldStartAutonomousResearch(base)).toBe(true);
    expect(shouldStartAutonomousResearch({ ...base, enabled: false })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, freshThread: false })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, voiceRoomActive: true })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, queueDepth: 1 })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, availableMessageSlots: 1 })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, dailyAttempts: 6 })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, lastGlobalAttemptAt: base.now - 59_999 })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, lastChannelAttemptAt: base.now - 119_999 })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, lastHumanActivityAt: base.now - 89_999 })).toBe(false);
    expect(shouldStartAutonomousResearch({ ...base, rng: () => 0.1 })).toBe(false);
  });

  it("maps autonomous-link frequency onto a bounded cadence with the former cadence at 50", () => {
    expect(autonomousLinkPolicy(0)).toMatchObject({ enabled: false, chance: 0, dailyCap: 0 });
    expect(autonomousLinkPolicy(50)).toEqual({
      enabled: true,
      chance: 0.07,
      globalCooldownMs: 30 * 60_000,
      channelCooldownMs: 2 * 60 * 60_000,
      humanQuietMs: 3 * 60_000,
      dailyCap: 6,
    });
    const raisedDefault = autonomousLinkPolicy(60);
    expect(raisedDefault.chance).toBeGreaterThan(0.07);
    expect(raisedDefault.dailyCap).toBe(8);
    expect(raisedDefault.globalCooldownMs).toBeGreaterThanOrEqual(12 * 60_000);
    expect(raisedDefault.channelCooldownMs).toBeGreaterThanOrEqual(40 * 60_000);
    const maximum = autonomousLinkPolicy(100);
    expect(maximum).toMatchObject({ enabled: true, chance: 0.22, dailyCap: 16 });
    expect(maximum.humanQuietMs).toBe(75_000);
  });

  it("enforces configured autonomous-source freshness without language heuristics", () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const currentSeed: AutonomousResearchSeed = {
      id: "fresh-release",
      query: "one configured current release subject",
      mode: "news",
      maxAgeDays: 14,
      discussionAngle: "Discuss one concrete choice in the supplied release.",
    };
    expect(autonomousResearchResultIsFresh(currentSeed, "2026-07-08T12:00:00.000Z", now)).toBe(true);
    expect(autonomousResearchResultIsFresh(currentSeed, "2026-05-14T12:00:00.000Z", now)).toBe(false);
    expect(autonomousResearchResultIsFresh(currentSeed, undefined, now)).toBe(false);
    expect(autonomousResearchResultIsFresh(currentSeed, "2026-07-14T12:06:00.000Z", now)).toBe(false);
    const evergreen = { ...currentSeed, maxAgeDays: undefined };
    expect(autonomousResearchResultIsFresh(evergreen, undefined, now)).toBe(true);
    expect(autonomousResearchResultIsFresh(evergreen, "2026-07-14T12:06:00.000Z", now)).toBe(false);
  });

  it("canonicalizes autonomous source URLs for cross-room repeat protection", () => {
    expect(canonicalAutonomousResearchUrl("https://EXAMPLE.com/story?b=2&a=1#comments"))
      .toBe("https://example.com/story?a=1&b=2");
    expect(canonicalAutonomousResearchUrl("http://example.com/story")).toBeUndefined();
    expect(canonicalAutonomousResearchUrl("not a url")).toBeUndefined();
  });

  it("keeps autonomous research disabled unless both environment switches explicitly opt in", () => {
    const previousResearch = process.env.RESEARCH_ENABLED;
    const previousAutonomous = process.env.AUTONOMOUS_RESEARCH_ENABLED;
    const makeDirector = () => new SocialDirector(
      { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
      new RoomStore("/tmp/director-autonomous-opt-in-unused.json"),
      {} as never,
      new ActorChannelRuntime(),
      {} as never,
      {} as never,
      () => PERSONAS,
      () => 1,
    );
    try {
      process.env.RESEARCH_ENABLED = "true";
      delete process.env.AUTONOMOUS_RESEARCH_ENABLED;
      expect((makeDirector() as unknown as { autonomousResearchEnabled: boolean }).autonomousResearchEnabled).toBe(false);

      process.env.AUTONOMOUS_RESEARCH_ENABLED = "false";
      expect((makeDirector() as unknown as { autonomousResearchEnabled: boolean }).autonomousResearchEnabled).toBe(false);

      process.env.AUTONOMOUS_RESEARCH_ENABLED = "true";
      expect((makeDirector() as unknown as { autonomousResearchEnabled: boolean }).autonomousResearchEnabled).toBe(true);

      process.env.RESEARCH_ENABLED = "false";
      expect((makeDirector() as unknown as { autonomousResearchEnabled: boolean }).autonomousResearchEnabled).toBe(false);
    } finally {
      if (previousResearch === undefined) delete process.env.RESEARCH_ENABLED;
      else process.env.RESEARCH_ENABLED = previousResearch;
      if (previousAutonomous === undefined) delete process.env.AUTONOMOUS_RESEARCH_ENABLED;
      else process.env.AUTONOMOUS_RESEARCH_ENABLED = previousAutonomous;
    }
  });

  it("builds an inert same-source card from safely read research metadata", () => {
    const packet = {
      kind: "page" as const,
      query: "room-owned lookup",
      retrievedAt: "2026-07-14T12:00:00.000Z",
      results: [{
        id: "S1",
        title: "A concrete release note",
        url: "https://example.com/news/item",
        snippet: "One bounded detail that the room can actually discuss.",
      }],
    };
    expect(linkPreviewFromResearch(packet)).toEqual({
      url: "https://example.com/news/item",
      displayHost: "example.com",
      siteName: "example.com",
      title: "A concrete release note",
      description: "One bounded detail that the room can actually discuss.",
      fetchedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(linkPreviewFromResearch({ ...packet, results: [{ ...packet.results[0]!, url: "http://example.com/" }] })).toBeUndefined();
  });

  it("rejects an AI self-reply atomically instead of disguising it as a new post", () => {
    const store = new RoomStore("/tmp/director-self-reply-unused.json");
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const prior = createMessage("side-quests", mira.id, "Första tanken om den gamla synten.");
    store.addPublicMessage(prior);
    const director = new SocialDirector(
      { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
      store,
      { rememberDeliveredLine: vi.fn() } as never,
      new ActorChannelRuntime(),
      {} as never,
      {} as never,
      () => PERSONAS,
      () => 1,
      { now: () => 1_000_000 },
    );
    const posted = (director as unknown as {
      postPublic: (channelId: string, persona: typeof mira, content: string, replyToId?: string) => ReturnType<typeof createMessage> | undefined;
    }).postPublic("side-quests", mira, "En ny konkret detalj om filtret.", prior.id);
    expect(posted).toBeUndefined();
    expect(store.getRecent("side-quests", 10)).toEqual([prior]);
  });

  it("assigns one accountable resident to an unaddressed expected request and requires completion now", async () => {
    vi.useFakeTimers();
    try {
      const human = {
        id: "guest-artifact-contract",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const store = new RoomStore("/tmp/director-artifact-contract-unused.json");
      const incoming = createMessage("lobby", human.id, "Nu får någon annan hitta på en gåta. Kom igen.");
      store.addPublicMessage(incoming);
      const generateScene = vi.fn(async (request: {
        selected: Array<(typeof PERSONAS)[number]>;
        mustReplyIds: string[];
        requestOwnerIds: string[];
        premise?: string;
      }) => [{
        personaId: request.selected[0]!.id,
        content: "Jag har städer men inga hus, skogar men inga träd och vatten men inga fiskar. Vad är jag?",
        source: "lm" as const,
        sourceIds: [],
      }]);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          analyzeTurn: vi.fn(async () => classifiedTurn({
            intent: { kind: "request", isQuestion: false, replyExpected: "expected", confidence: 0.99 },
          })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
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
          pageReader: {
            collectCandidates: vi.fn(() => ({ requestedAt: new Date().toISOString(), candidates: [] })),
          } as never,
          rng: () => 0.99,
        },
      );
      const pending = (director as unknown as {
        handleHumanBurst: (messages: Array<typeof incoming>, member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;
      director.stop();

      expect(generateScene).toHaveBeenCalledTimes(1);
      const request = generateScene.mock.calls[0]![0];
      expect(request.mustReplyIds).toContain(request.selected[0]?.id);
      expect(request.requestOwnerIds).toEqual([request.selected[0]?.id]);
      expect(request.premise).toContain("perform any feasible self-contained request now");
      expect(store.getRecent("lobby", 1)[0]?.content).toContain("städer men inga hus");
      expect((director as unknown as {
        ambientThreads: Map<string, AmbientThreadState>;
      }).ambientThreads.get("lobby")).toMatchObject({
        origin: "human_topic",
        messageCount: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes only the semantically selected safe source when two candidates were read", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-07-14T12:00:00.000Z");
      const offTopicUrl = "https://example.com/windows/recent-files";
      const sourceUrl = "https://example.com/research/concrete-item";
      const searchPacket = {
        kind: "search" as const,
        query: "recent practical agent testing",
        retrievedAt: new Date(now).toISOString(),
        results: [
          { id: "S1", title: "Windows Recent Files", url: offTopicUrl, snippet: "Search summary" },
          { id: "S2", title: "Search result", url: sourceUrl, snippet: "Search summary" },
        ],
      };
      const pagePacket = {
        kind: "page" as const,
        query: "Discuss the recovery test",
        retrievedAt: new Date(now + 1_000).toISOString(),
        results: [{
          id: "S1",
          title: "A practical recovery benchmark",
          url: sourceUrl,
          snippet: "The benchmark resets a failed tool step and measures whether the agent can recover without corrupting later state.",
        }],
      };
      const offTopicPagePacket = {
        ...pagePacket,
        results: [{
          id: "S1",
          title: "Windows Recent Files",
          url: offTopicUrl,
          snippet: "How an operating system displays recently opened files.",
        }],
      };
      const store = new RoomStore("/tmp/director-autonomous-source-unused.json");
      const research = { research: vi.fn(async () => searchPacket) };
      const pageReader = {
        read: vi.fn(async (request: { url: URL }) =>
          request.url.toString() === offTopicUrl ? offTopicPagePacket : pagePacket),
      };
      const actorChannels = new ActorChannelRuntime();
      const lm = {
        health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
        generateScene: vi.fn(async (request: { selected: typeof PERSONAS; urlPublicationPolicy?: string }) => [
          {
            personaId: request.selected[0]!.id,
            content: "Det intressanta är återställningen efter verktygsfelet, inte den snygga sluttexten.",
            source: "lm" as const,
            sourceIds: ["S2"],
          },
          {
            personaId: request.selected[1]!.id,
            content: "Ja, men mäter den också om nästa steg är rätt av rätt anledning?",
            source: "lm" as const,
            sourceIds: ["S2"],
          },
        ]),
        rememberDeliveredLine: vi.fn(),
      };
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        lm as never,
        actorChannels,
        research as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => now,
          rng: () => 0,
          pageReader: pageReader as never,
          autonomousResearchEnabled: true,
        },
      );
      const channel = { id: "ai-programming", name: "ai-programming", description: "", icon: "⌘" };
      const available = actorChannels
        .candidatesFor("ai-programming")
        .filter((persona) => persona.id !== "ai-runa" && persona.id !== "ai-robin");
      const thread: AmbientThreadState = {
        seed: "unused room seed",
        messageCount: 0,
        participantIds: [],
        debateBeat: false,
        languageHint: "the room's established language",
        openedAt: now,
        updatedAt: now,
      };
      const pending = (director as unknown as {
        runAutonomousResearchConversation: (
          room: typeof channel,
          epoch: number,
          candidates: typeof PERSONAS,
          state: AmbientThreadState,
          seed: AutonomousResearchSeed,
        ) => Promise<boolean>;
      }).runAutonomousResearchConversation(channel, 0, available, thread, {
        id: "agent-recovery",
        query: "recent practical agent testing",
        mode: "web",
        discussionAngle: "Discuss whether recovery should count more than a polished final answer.",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBe(true);

      expect(research.research).toHaveBeenCalledWith(expect.objectContaining({
        requesterId: "ambient-research:ai-programming",
      }));
      expect(pageReader.read).toHaveBeenCalledTimes(2);
      expect(pageReader.read).toHaveBeenCalledWith(
        expect.objectContaining({ url: new URL(sourceUrl), retry: false, initiator: "automatic" }),
        "ambient-research:ai-programming",
      );
      expect(lm.generateScene).toHaveBeenCalledWith(
        expect.objectContaining({
          urlPublicationPolicy: "server_card",
          research: expect.objectContaining({
            query: "recent practical agent testing",
            results: [
              expect.objectContaining({ id: "S1", url: offTopicUrl }),
              expect.objectContaining({ id: "S2", url: sourceUrl }),
            ],
          }),
          autonomousResearchContext: expect.objectContaining({
            seedId: "agent-recovery",
            roomTopic: expect.stringContaining("software development"),
          }),
        }),
        4,
      );
      const messages = store.getRecent("ai-programming", 10);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.linkPreview?.url).toBe(sourceUrl);
      expect(messages[0]?.sources).toEqual([{ title: "A practical recovery benchmark", url: sourceUrl }]);
      expect(messages[0]?.content).not.toContain("https://");
      expect(messages[1]?.replyToId).toBe(messages[0]?.id);
      expect(messages[1]?.authorId).not.toBe(messages[0]?.authorId);
      expect(thread).toMatchObject({
        origin: "autonomous_research",
        messageCount: 2,
        research: {
          kind: "page",
          results: [{ id: "S2", url: sourceUrl }],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an older human burst when a newer channel epoch arrives during generation", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-07-14T12:30:00.000Z");
      const human = {
        id: "guest-overlap",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const first = createMessage("lobby", human.id, "Kan någon göra en gåta?");
      const second = createMessage("lobby", human.id, "Vänta, jag vill fråga något annat.");
      const store = new RoomStore("/tmp/director-overlap-unused.json");
      store.addPublicMessage(first);
      let resolveScene: ((lines: Array<{
        personaId: string;
        content: string;
        source: "lm";
        sourceIds: string[];
      }>) => void) | undefined;
      let selectedId = "";
      const generateScene = vi.fn((request: { selected: Array<(typeof PERSONAS)[number]> }) => {
        selectedId = request.selected[0]!.id;
        return new Promise<Array<{
          personaId: string;
          content: string;
          source: "lm";
          sourceIds: string[];
        }>>((resolve) => {
          resolveScene = resolve;
        });
      });
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          analyzeTurn: vi.fn(async () => classifiedTurn({
            intent: { kind: "request", isQuestion: false, replyExpected: "expected", confidence: 0.99 },
          })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          pageReader: {
            collectCandidates: vi.fn(() => ({ requestedAt: new Date(now).toISOString(), candidates: [] })),
          } as never,
        },
      );
      const internals = director as unknown as {
        noteHumanChannelEvent: (message: typeof first) => void;
        handleHumanBurst: (messages: Array<typeof first>, member: typeof human) => Promise<void>;
      };
      internals.noteHumanChannelEvent(first);
      const pending = internals.handleHumanBurst([first], human);
      await Promise.resolve();
      await Promise.resolve();
      expect(generateScene).toHaveBeenCalledTimes(1);

      store.addPublicMessage(second);
      internals.noteHumanChannelEvent(second);
      resolveScene?.([{
        personaId: selectedId,
        content: "Jag svarar på den gamla frågan alldeles för sent.",
        source: "lm",
        sourceIds: [],
      }]);
      await pending;
      director.stop();

      expect(store.getRecent("lobby", 10).filter((message) => message.authorId.startsWith("ai-"))).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("discards and backs off a zero-message ambient thread so another room gets a turn", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-07-14T13:00:00.000Z");
      const generateScene = vi.fn(async () => []);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        new RoomStore("/tmp/director-ambient-empty-unused.json"),
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => now,
          rng: () => 0,
          consideredConversationChance: 0,
          autonomousResearchEnabled: false,
          ambientTemporalCueChance: 0,
        },
      );
      const internals = director as unknown as {
        runAmbient: () => Promise<void>;
        ambientThreads: Map<string, AmbientThreadState>;
        ambientBackoffUntilByChannel: Map<string, number>;
      };
      await internals.runAmbient();
      const firstChannelId = (generateScene.mock.calls[0]?.[0] as { channelId?: string } | undefined)?.channelId;
      expect(firstChannelId).toBeTruthy();
      expect(internals.ambientThreads.has(firstChannelId!)).toBe(false);
      expect(internals.ambientBackoffUntilByChannel.get(firstChannelId!)).toBeGreaterThan(now);

      await internals.runAmbient();
      const secondChannelId = (generateScene.mock.calls[1]?.[0] as { channelId?: string } | undefined)?.channelId;
      expect(secondChannelId).toBeTruthy();
      expect(secondChannelId).not.toBe(firstChannelId);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("waits instead of letting the same resident continue an autonomous thread alone", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now() + 10 * 60_000;
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const store = new RoomStore("/tmp/director-single-actor-unused.json");
      const prior = createMessage("lobby", mira.id, "En första tanke som någon annan måste svara på.");
      store.addPublicMessage(prior);
      const generateScene = vi.fn(async () => []);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime([mira]),
        {} as never,
        {} as never,
        () => [mira],
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          consideredConversationChance: 0,
          autonomousResearchEnabled: false,
          ambientTemporalCueChance: 0,
        },
      );
      const thread: AmbientThreadState = {
        seed: "Continue the supplied topic.",
        messageCount: 2,
        lastMessageId: prior.id,
        lastAuthorId: mira.id,
        participantIds: [mira.id],
        debateBeat: false,
        languageHint: "sv",
        origin: "human_topic",
        openedAt: now,
        updatedAt: now,
      };
      const internals = director as unknown as {
        runAmbient: () => Promise<void>;
        ambientThreads: Map<string, AmbientThreadState>;
        ambientBackoffUntilByChannel: Map<string, number>;
      };
      internals.ambientThreads.set("lobby", thread);
      await internals.runAmbient();
      expect(generateScene).not.toHaveBeenCalled();
      expect(internals.ambientBackoffUntilByChannel.get("lobby")).toBeGreaterThan(now);
      expect(store.getRecent("lobby", 10)).toEqual([prior]);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("retains bounded source evidence and hands it to a different continuation speaker", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now() + 10 * 60_000;
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const bosse = PERSONAS.find((persona) => persona.id === "ai-bosse")!;
      const store = new RoomStore("/tmp/director-source-continuation-unused.json");
      const first = createMessage("lobby", mira.id, "Källan testar återhämtning efter ett misslyckat verktygssteg.", {
        sources: [{ title: "Recovery benchmark", url: "https://example.com/recovery" }],
      });
      const second = createMessage("lobby", bosse.id, "Frågan är om nästa steg också blir rätt av rätt anledning.", {
        replyToId: first.id,
        sources: [{ title: "Recovery benchmark", url: "https://example.com/recovery" }],
      });
      store.addPublicMessage(first);
      store.addPublicMessage(second);
      const research = {
        kind: "page" as const,
        query: "agent recovery",
        retrievedAt: new Date(now).toISOString(),
        results: [{
          id: "S1",
          title: "Recovery benchmark",
          url: "https://example.com/recovery",
          snippet: "The benchmark resets a failed tool step and checks later state.",
        }],
      };
      const generateScene = vi.fn(async (request: {
        selected: Array<(typeof PERSONAS)[number]>;
        research?: typeof research;
      }) => [{
        personaId: request.selected[0]!.id,
        content: "Det viktiga testet är nog om senare tillstånd förblir helt, inte bara om nästa svar ser snyggt ut.",
        source: "lm" as const,
        sourceIds: ["S1"],
      }]);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          consideredConversationChance: 0,
          autonomousResearchEnabled: false,
          ambientTemporalCueChance: 0,
        },
      );
      const thread: AmbientThreadState = {
        seed: "Continue the exact sourced argument.",
        messageCount: 2,
        lastMessageId: second.id,
        lastAuthorId: bosse.id,
        participantIds: [mira.id, bosse.id],
        debateBeat: true,
        languageHint: "sv",
        research,
        origin: "autonomous_research",
        openedAt: now,
        updatedAt: now,
      };
      const internals = director as unknown as {
        runAmbient: () => Promise<void>;
        ambientThreads: Map<string, AmbientThreadState>;
      };
      internals.ambientThreads.set("lobby", thread);
      await internals.runAmbient();
      const request = generateScene.mock.calls[0]![0];
      expect(request.research).toEqual(research);
      expect(request.selected[0]?.id).not.toBe(bosse.id);
      const posted = store.getRecent("lobby", 10).at(-1)!;
      expect(posted.authorId).not.toBe(bosse.id);
      expect(posted.sources).toEqual([{ title: "Recovery benchmark", url: "https://example.com/recovery" }]);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rechecks every mutable autonomous-research publication gate", () => {
    const now = Date.parse("2026-07-14T14:00:00.000Z");
    let queueDepth = 0;
    const runtime = new ActorChannelRuntime();
    const actor = runtime.candidatesFor("lobby").find((persona) => persona.id !== "ai-runa")!;
    let autonomousLinkFrequency = 60;
    const director = new SocialDirector(
      { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
      new RoomStore("/tmp/director-autonomous-gates-unused.json"),
      { health: vi.fn(() => ({ connected: true, queueDepth })) } as never,
      runtime,
      {} as never,
      {} as never,
      () => PERSONAS,
      () => 1,
      {
        now: () => now,
        autonomousResearchEnabled: true,
        behaviorTuningProvider: () => ({
          activity: 50,
          autonomousLinkFrequency,
          competence: 50,
          aggression: 25,
          explicitness: 50,
        }),
      },
    );
    const internals = director as unknown as {
      autonomousResearchIsStillSafe: (
        channelId: string,
        epoch: number,
        actors: Array<typeof actor>,
        requiredSlots: number,
      ) => boolean;
      lastHumanActivityAt?: number;
      lastSpoke: Map<string, number>;
      aiTimestamps: number[];
    };
    const safe = () => internals.autonomousResearchIsStillSafe("lobby", 0, [actor], 1);
    expect(safe()).toBe(true);
    queueDepth = 1;
    expect(safe()).toBe(false);
    queueDepth = 0;
    director.setVoiceRoomActive(true);
    expect(safe()).toBe(false);
    director.setVoiceRoomActive(false);
    internals.lastHumanActivityAt = now;
    expect(safe()).toBe(false);
    internals.lastHumanActivityAt = undefined;
    internals.aiTimestamps.push(now, now, now);
    expect(safe()).toBe(false);
    internals.aiTimestamps.length = 0;
    internals.lastSpoke.set(actor.id, now);
    expect(safe()).toBe(false);
    internals.lastSpoke.delete(actor.id);
    expect(internals.autonomousResearchIsStillSafe("lobby", 0, [{ ...actor, id: "ai-not-in-room" }], 1)).toBe(false);
    autonomousLinkFrequency = 0;
    expect(safe()).toBe(false);
    director.stop();
    expect(safe()).toBe(false);
  });

  it("cancels an autonomous source publication if voice activity begins during the safe read", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-07-14T14:30:00.000Z");
      const sourceUrl = "https://example.com/research/delayed";
      const searchPacket = {
        kind: "search" as const,
        query: "delayed research",
        retrievedAt: new Date(now).toISOString(),
        results: [{ id: "S1", title: "Delayed result", url: sourceUrl, snippet: "Search result" }],
      };
      const pagePacket = {
        kind: "page" as const,
        query: "Discuss the result",
        retrievedAt: new Date(now).toISOString(),
        results: [{ id: "S1", title: "Delayed result", url: sourceUrl, snippet: "A safely read fact." }],
      };
      let resolveRead: ((packet: typeof pagePacket) => void) | undefined;
      const read = vi.fn(() => new Promise<typeof pagePacket>((resolve) => {
        resolveRead = resolve;
      }));
      const generateScene = vi.fn(async () => []);
      const store = new RoomStore("/tmp/director-autonomous-voice-race-unused.json");
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        { research: vi.fn(async () => searchPacket) } as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => now,
          rng: () => 0,
          pageReader: { read } as never,
          autonomousResearchEnabled: true,
        },
      );
      const channel = { id: "ai-programming", name: "ai-programming", description: "", icon: "⌘" };
      const available = PERSONAS.filter((persona) => persona.id !== "ai-runa" && persona.id !== "ai-robin");
      const thread: AmbientThreadState = {
        seed: "unused",
        messageCount: 0,
        participantIds: [],
        debateBeat: false,
        languageHint: "sv",
        openedAt: now,
        updatedAt: now,
      };
      const pending = (director as unknown as {
        runAutonomousResearchConversation: (
          room: typeof channel,
          epoch: number,
          candidates: typeof PERSONAS,
          state: AmbientThreadState,
          seed: AutonomousResearchSeed,
        ) => Promise<boolean>;
      }).runAutonomousResearchConversation(channel, 0, available, thread, {
        id: "delayed",
        query: "delayed research",
        mode: "web",
        discussionAngle: "Discuss the result.",
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(1);
      director.setVoiceRoomActive(true);
      resolveRead?.(pagePacket);
      expect(await pending).toBe(false);
      expect(generateScene).not.toHaveBeenCalled();
      expect(store.getRecent("ai-programming", 10)).toEqual([]);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stop prevents an in-flight ambient generation from publishing or rescheduling", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-07-14T15:00:00.000Z");
      let resolveScene: ((lines: Array<{
        personaId: string;
        content: string;
        source: "lm";
        sourceIds: string[];
      }>) => void) | undefined;
      let selectedId = "";
      const generateScene = vi.fn((request: { selected: Array<(typeof PERSONAS)[number]> }) => {
        selectedId = request.selected[0]!.id;
        return new Promise<Array<{
          personaId: string;
          content: string;
          source: "lm";
          sourceIds: string[];
        }>>((resolve) => {
          resolveScene = resolve;
        });
      });
      const store = new RoomStore("/tmp/director-stop-race-unused.json");
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          consideredConversationChance: 0,
          autonomousResearchEnabled: false,
          ambientTemporalCueChance: 0,
        },
      );
      const internals = director as unknown as {
        runAmbient: () => Promise<void>;
        ambientTimer?: NodeJS.Timeout;
      };
      const pending = internals.runAmbient();
      await Promise.resolve();
      expect(generateScene).toHaveBeenCalledTimes(1);
      director.stop();
      resolveScene?.([{
        personaId: selectedId,
        content: "Det här inlägget får aldrig publiceras efter stop.",
        source: "lm",
        sourceIds: [],
      }]);
      await pending;
      expect(store.getAllMessages()).toEqual([]);
      expect(internals.ambientTimer).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("scales autonomous cadence and budgets while enforcing hard activity caps", () => {
    expect(autonomousActivityLimits(12, 0)).toEqual({ perMinute: 0, perTwelveSeconds: 0 });
    expect(autonomousActivityLimits(12, 50)).toEqual({ perMinute: 12, perTwelveSeconds: 3 });
    expect(autonomousActivityLimits(12, 100)).toEqual({ perMinute: 20, perTwelveSeconds: 5 });
    expect(autonomousActivityLimits(100, 10_000)).toEqual({ perMinute: 20, perTwelveSeconds: 5 });

    expect(scaleAmbientDelay(10_000, 100)).toBeLessThan(scaleAmbientDelay(10_000, 50));
    expect(scaleAmbientDelay(10_000, 50)).toBeLessThan(scaleAmbientDelay(10_000, 1));
    expect(scaleAmbientDelay(10_000, 0)).toBe(30_000);
    expect(ambientRoomSelectionWeight(4, 100)).toBeGreaterThan(ambientRoomSelectionWeight(4, 50));
    expect(ambientRoomSelectionWeight(4, 50)).toBeGreaterThan(ambientRoomSelectionWeight(4, 1));
    expect(ambientRoomSelectionWeight(4, 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("merges global and room tuning as one complete live override with global inheritance", () => {
    const global = { activity: 40, autonomousLinkFrequency: 45, competence: 60, aggression: 20, explicitness: 30 };
    const lobby = { activity: 90, autonomousLinkFrequency: 80, competence: 80, aggression: 70, explicitness: 65 };
    const provider = (channelId?: string) => channelId === undefined ? global : channelId === "lobby" ? lobby : undefined;
    expect(resolveBehaviorTuning(provider, "lobby")).toEqual({ global, effective: lobby });
    expect(resolveBehaviorTuning(provider, "the-pub")).toEqual({ global, effective: global });
    expect(resolveBehaviorTuning(provider)).toEqual({ global, effective: global });
  });

  it("lets either global or channel activity zero stop autonomous rooms", async () => {
    vi.useFakeTimers();
    try {
      let globalActivity = 0;
      let channelActivity = 100;
      const generateScene = vi.fn(async () => []);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        new RoomStore("/tmp/director-zero-activity-unused.json"),
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => Date.parse("2026-07-14T16:00:00.000Z"),
          behaviorTuningProvider: (channelId) => ({
            activity: channelId ? channelActivity : globalActivity,
            competence: 50,
            aggression: 25,
            explicitness: 50,
          }),
        },
      );
      const runAmbient = (director as unknown as { runAmbient: () => Promise<void> }).runAmbient.bind(director);
      await runAmbient();
      expect(generateScene).not.toHaveBeenCalled();

      globalActivity = 50;
      channelActivity = 0;
      await runAmbient();
      expect(generateScene).not.toHaveBeenCalled();
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not let activity zero suppress a direct human request", async () => {
    vi.useFakeTimers();
    try {
      const human = {
        id: "guest-zero-activity",
        name: "Guest",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "G" },
      };
      const store = new RoomStore("/tmp/director-zero-activity-direct-unused.json");
      const incoming = createMessage("lobby", human.id, "Kan någon ge mig en kort gåta?");
      store.addPublicMessage(incoming);
      const generateScene = vi.fn(async (request: { selected: Array<(typeof PERSONAS)[number]> }) => [{
        personaId: request.selected[0]!.id,
        content: "Jag har nycklar men inga lås. Vad är jag?",
        source: "lm" as const,
        sourceIds: [],
      }]);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          analyzeTurn: vi.fn(async () => classifiedTurn({
            intent: { kind: "request", isQuestion: true, replyExpected: "expected", confidence: 0.99 },
          })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
          noteClassifiedMemoryFact: vi.fn(),
        } as never,
        () => [human, ...PERSONAS],
        () => 1,
        {
          rng: () => 0.99,
          pageReader: {
            collectCandidates: vi.fn(() => ({ requestedAt: new Date().toISOString(), candidates: [] })),
          } as never,
          behaviorTuningProvider: () => ({ activity: 0, competence: 50, aggression: 25, explicitness: 50 }),
        },
      );
      const pending = (director as unknown as {
        handleHumanBurst: (messages: Array<typeof incoming>, member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;
      director.stop();
      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(store.getRecent("lobby", 2).at(-1)?.content).toContain("nycklar men inga lås");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("prefers a higher-activity room without making low nonzero rooms ineligible", async () => {
    vi.useFakeTimers();
    try {
      const generateScene = vi.fn(async () => []);
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        new RoomStore("/tmp/director-room-activity-weight-unused.json"),
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => Date.parse("2026-07-14T16:30:00.000Z"),
          rng: () => 0.5,
          consideredConversationChance: 0,
          autonomousResearchEnabled: false,
          ambientTemporalCueChance: 0,
          behaviorTuningProvider: (channelId) => ({
            activity: channelId === undefined ? 50 : channelId === "the-pub" ? 100 : channelId === "lobby" ? 10 : 0,
            competence: 50,
            aggression: 25,
            explicitness: 50,
          }),
        },
      );
      await (director as unknown as { runAmbient: () => Promise<void> }).runAmbient();
      expect(generateScene).toHaveBeenCalledWith(expect.objectContaining({ channelId: "the-pub" }), 4);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reconcileCatalog invalidates in-flight ambient output and clears continuation state", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-07-14T17:00:00.000Z");
      let resolveScene: ((lines: Array<{
        personaId: string;
        content: string;
        source: "lm";
        sourceIds: string[];
      }>) => void) | undefined;
      let selectedId = "";
      const generateScene = vi.fn((request: { selected: Array<(typeof PERSONAS)[number]> }) => {
        selectedId = request.selected[0]!.id;
        return new Promise<Array<{
          personaId: string;
          content: string;
          source: "lm";
          sourceIds: string[];
        }>>((resolve) => {
          resolveScene = resolve;
        });
      });
      const store = new RoomStore("/tmp/director-catalog-reconcile-unused.json");
      const director = new SocialDirector(
        { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        store,
        {
          health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
          generateScene,
          rememberDeliveredLine: vi.fn(),
        } as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        {
          now: () => now,
          rng: () => 0.99,
          consideredConversationChance: 0,
          autonomousResearchEnabled: false,
          ambientTemporalCueChance: 0,
        },
      );
      const internals = director as unknown as {
        runAmbient: () => Promise<void>;
        ambientThreads: Map<string, AmbientThreadState>;
        channelEpoch: Map<string, number>;
      };
      const pending = internals.runAmbient();
      await Promise.resolve();
      expect(generateScene).toHaveBeenCalledTimes(1);
      expect(internals.ambientThreads.size).toBeGreaterThan(0);
      director.reconcileCatalog();
      expect(internals.ambientThreads.size).toBe(0);
      expect(internals.channelEpoch.get("lobby")).toBe(1);
      resolveScene?.([{
        personaId: selectedId,
        content: "Det här gamla katalogsvaret får inte publiceras.",
        source: "lm",
        sourceIds: [],
      }]);
      await pending;
      expect(store.getAllMessages()).toEqual([]);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
