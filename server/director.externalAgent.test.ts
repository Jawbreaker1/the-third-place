import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, Member } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import type { SceneRequest } from "./lmStudio.js";
import { PERSONAS } from "./personas.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis } from "./semanticRouter.js";
import type { DeliveredSocialEpisode } from "./socialMemoryCoordinator.js";
import { createMessage, RoomStore } from "./store.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const MIRA = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const EXTERNAL_AGENT: Member = {
  id: "agent-owner-friend",
  name: "Owner's Scout",
  kind: "agent",
  status: "online",
  avatar: { color: "#315f62", accent: "#79dcc5", glyph: "O" },
  role: "External agent",
  bio: "A curious visitor operated by a community member.",
};

const analyzedAgentTurn = (overrides: Partial<TurnAnalysis> = {}): TurnAnalysis => ({
  ...createFailClosedTurnAnalysis("disabled"),
  source: "lm" as const,
  failureReason: null,
  language: { tag: "en", confidence: 0.99 },
  intent: {
    kind: "statement" as const,
    isQuestion: false,
    replyExpected: "optional" as const,
    confidence: 0.99,
  },
  personas: {
    addressedIds: [MIRA.id],
    requestedReplyIds: [MIRA.id],
    relevantIds: [MIRA.id],
    addressConfidence: 0.99,
    relevanceConfidence: 0.99,
  },
  social: {
    warmth: 0.25,
    hostility: 0,
    playfulness: 0.15,
    absurdity: 0,
    urgency: 0,
    energy: 0.3,
    pileOnRisk: 0,
    claimStrength: 0,
    confidence: 0.99,
  },
  ...overrides,
});

interface DirectorInternals {
  aiTimestamps: number[];
  priorityHumanReplyTimestamps: number[];
  priorityExternalAgentReplyTimestamps: number[];
  lastMeaningfulHumanActivityAt?: number;
  lastHumanMessageAtByChannel: Map<string, number>;
  lastHumanResearchActivityAtByChannel: Map<string, number>;
  lastHumanResearchActivityAtByChannelActor: Map<string, Map<string, number>>;
}

const createHarness = (options: {
  reaction?: boolean;
  analysis?: TurnAnalysis;
  generateScene?: (request: SceneRequest) => Promise<Array<{
    personaId: string;
    content: string;
    source: "lm";
    sourceIds: string[];
  }>>;
  canRecoverExternalAgentPublicTurn?: (actorId: string, channelId: string) => boolean;
} = {}) => {
  const store = new RoomStore(
    `/tmp/director-external-agent-${process.pid}-${Math.random()}.json`,
    { now: () => NOW },
  );
  const generatedRequests: SceneRequest[] = [];
  const generateScene = vi.fn(async (request: SceneRequest) => {
    generatedRequests.push(request);
    if (options.generateScene) return await options.generateScene(request);
    const selected = request.selected[0];
    return selected
      ? [{
          personaId: selected.id,
          content: options.reaction
            ? "yeah, that reaction tracks"
            : "yeah, that is worth unpacking",
          source: "lm" as const,
          sourceIds: [],
        }]
      : [];
  });
  const enqueueDeliveredEpisode = vi.fn(async () => ({
    status: "no_events" as const,
    episodeId: "external-agent-test",
    eventIds: [],
    createdEventIds: [],
  }));
  const connectedHumanCount = vi.fn(() => 0);
  const humanMemory = {
    getRelation: vi.fn(() => undefined),
    updateRelation: vi.fn(),
    promptNote: vi.fn(() => undefined),
    listProfiles: vi.fn(() => []),
    listRestorableProfiles: vi.fn(() => []),
    noteClassifiedMemoryFact: vi.fn(),
  };
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    store,
    {
      health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
      analyzeTurn: vi.fn(async () => options.analysis ?? analyzedAgentTurn()),
      generateScene,
      rememberDeliveredLine: vi.fn(),
      acquireForegroundDemand: vi.fn(() => ({ release: vi.fn() })),
    } as never,
    new ActorChannelRuntime(),
    { research: vi.fn(), researchSite: vi.fn() } as never,
    humanMemory as never,
    () => [EXTERNAL_AGENT, ...PERSONAS],
    connectedHumanCount,
    {
      now: () => NOW,
      rng: () => 0,
      humanReactionDebounceMs: 0,
      humanReactionHumanCooldownMs: 0,
      humanReactionMessageCooldownMs: 0,
      humanReactionResponseChance: 1,
      weatherForecastProvider: null,
      pageReader: {
        collectCandidates: vi.fn(() => ({
          requestedAt: new Date(NOW).toISOString(),
          candidates: [],
        })),
      } as never,
      socialMemory: {
        enqueueDeliveredEpisode,
        promptNote: vi.fn(() => undefined),
        publicThirdPartyPromptNote: vi.fn(() => undefined),
        behaviorProjection: vi.fn(() => undefined),
      } as never,
      ...(options.canRecoverExternalAgentPublicTurn
        ? { canRecoverExternalAgentPublicTurn: options.canRecoverExternalAgentPublicTurn }
        : {}),
    },
  );
  const handleHumanBurst = vi.spyOn(director as unknown as {
    handleHumanBurst(messages: ChatMessage[], participant: Member): Promise<void>;
  }, "handleHumanBurst");
  return {
    director,
    store,
    generateScene,
    generatedRequests,
    enqueueDeliveredEpisode,
    connectedHumanCount,
    humanMemory,
    handleHumanBurst,
    internals: director as unknown as DirectorInternals,
  };
};

const addAgentMessage = (store: RoomStore, content: string) => {
  const message = createMessage("lobby", EXTERNAL_AGENT.id, content, {
    createdAt: new Date(NOW).toISOString(),
    authorSnapshot: { ...EXTERNAL_AGENT, status: "offline" },
  });
  store.addPublicMessage(message);
  return message;
};

const runQueuedWork = async (milliseconds = 5_000): Promise<void> => {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await Promise.resolve();
};

const expectNoHumanActivity = (internals: DirectorInternals): void => {
  expect(internals.lastMeaningfulHumanActivityAt).toBeUndefined();
  expect(internals.lastHumanMessageAtByChannel.has("lobby")).toBe(false);
  expect(internals.lastHumanResearchActivityAtByChannel.has("lobby")).toBe(false);
  expect(internals.lastHumanResearchActivityAtByChannelActor.has("lobby")).toBe(false);
};

describe("SocialDirector external-agent boundaries", () => {
  it.each(["direct", "first_arrival"] as const)(
    "never revives stale %s generation after an authority mutation is restored",
    async (deliveryKind) => {
      vi.useFakeTimers();
      try {
        let releaseFirst!: (lines: Array<{
          personaId: string;
          content: string;
          source: "lm";
          sourceIds: string[];
        }>) => void;
        const firstGeneration = new Promise<Array<{
          personaId: string;
          content: string;
          source: "lm";
          sourceIds: string[];
        }>>((resolve) => {
          releaseFirst = resolve;
        });
        let generation = 0;
        const harness = createHarness({
          analysis: createFailClosedTurnAnalysis("provider_error"),
          generateScene: async (request) => {
            generation += 1;
            if (generation === 1) return await firstGeneration;
            return [{
              personaId: request.selected[0]!.id,
              content: "fresh authority response",
              source: "lm",
              sourceIds: [],
            }];
          },
          canRecoverExternalAgentPublicTurn: () => true,
        });
        const incoming = createMessage(
          "lobby",
          EXTERNAL_AGENT.id,
          deliveryKind === "direct" ? "@Mira take a look" : "hello on my first visit",
          {
            createdAt: new Date(NOW).toISOString(),
            authorSnapshot: { ...EXTERNAL_AGENT, status: "offline" },
          },
        );
        await harness.store.addExternalAgentPublicMessageDurably(incoming, deliveryKind === "direct"
          ? { pendingTurn: { targetPersonaIds: [MIRA.id], deliveryKind } }
          : { firstArrivalTurn: { targetPersonaIds: [MIRA.id] } });

        harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
        await runQueuedWork(750);
        const staleCompletion = harness.handleHumanBurst.mock.results[0]?.value;
        expect(staleCompletion).toBeDefined();
        expect(harness.generateScene).toHaveBeenCalledTimes(1);

        harness.director.invalidatePublicWorkForHumanActor(EXTERNAL_AGENT.id, { cancelPending: false });
        harness.director.restorePublicWorkForExternalAgent(EXTERNAL_AGENT.id);
        releaseFirst([{
          personaId: MIRA.id,
          content: "stale authority response",
          source: "lm",
          sourceIds: [],
        }]);
        await staleCompletion;

        expect(harness.store.getRecent("lobby", 20).some(
          (message) => message.replyToId === incoming.id && message.content === "stale authority response",
        )).toBe(false);
        expect(harness.store.getPendingPublicTurns()).toHaveLength(1);

        expect(harness.director.recoverPendingPublicTurns({ ignoreAttemptCooldown: true })).toBe(1);
        await runQueuedWork();
        expect(harness.store.getRecent("lobby", 20).filter(
          (message) => message.replyToId === incoming.id && message.content === "fresh authority response",
        )).toHaveLength(1);
        expect(harness.store.getPendingPublicTurns()).toEqual([]);
        harness.director.stop();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("drops crash-restored agent delivery work that current room policy no longer authorizes", () => {
    const harness = createHarness({
      canRecoverExternalAgentPublicTurn: (_actorId, channelId) => channelId === "lobby",
    });
    const incoming = createMessage("ai-programming", EXTERNAL_AGENT.id, "@Mira stale room access", {
      createdAt: new Date(NOW).toISOString(),
      authorSnapshot: { ...EXTERNAL_AGENT, status: "offline" },
    });
    harness.store.addPublicMessage(incoming, undefined, {
      targetPersonaIds: [MIRA.id],
      deliveryKind: "direct",
    });

    expect(harness.director.recoverPendingPublicTurns({ ignoreAttemptCooldown: true })).toBe(0);
    expect(harness.store.getPendingPublicTurns()).toEqual([]);
    expect(harness.generateScene).not.toHaveBeenCalled();
    harness.director.stop();
  });

  it("does not admit recovery inside a reversible authority-mutation window", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ canRecoverExternalAgentPublicTurn: () => true });
      const incoming = createMessage("lobby", EXTERNAL_AGENT.id, "@Mira wait for policy commit", {
        createdAt: new Date(NOW).toISOString(),
        authorSnapshot: { ...EXTERNAL_AGENT, status: "offline" },
      });
      harness.store.addPublicMessage(incoming, undefined, {
        targetPersonaIds: [MIRA.id],
        deliveryKind: "direct",
      });

      harness.director.invalidatePublicWorkForHumanActor(EXTERNAL_AGENT.id, { cancelPending: false });
      expect(harness.director.recoverPendingPublicTurns({ ignoreAttemptCooldown: true })).toBe(0);
      expect(harness.store.getPendingPublicTurns()[0]?.targets[0]?.attempts).toBe(0);

      harness.director.restorePublicWorkForExternalAgent(EXTERNAL_AGENT.id);
      expect(harness.director.recoverPendingPublicTurns({ ignoreAttemptCooldown: true })).toBe(1);
      await runQueuedWork();
      expect(harness.store.getPendingPublicTurns()).toEqual([]);
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        replyToId: incoming.id,
      }));
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("gives a first public arrival one durable, reviewed resident response without inventing an address", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ analysis: createFailClosedTurnAnalysis("provider_error") });
      harness.internals.aiTimestamps.push(...Array.from({ length: 10 }, () => NOW));
      const incoming = createMessage(
        "lobby",
        EXTERNAL_AGENT.id,
        "hello from the outside — I have been testing cache invalidation today",
        {
          createdAt: new Date(NOW).toISOString(),
          authorSnapshot: { ...EXTERNAL_AGENT, status: "offline" },
        },
      );
      await harness.store.addExternalAgentPublicMessageDurably(incoming, {
        firstArrivalTurn: { targetPersonaIds: [MIRA.id] },
      });
      const scheduleCrowdReactions = vi.spyOn(harness.director as unknown as {
        scheduleCrowdReactions: (...args: unknown[]) => number;
      }, "scheduleCrowdReactions");

      harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const completion = harness.handleHumanBurst.mock.results[0]?.value;
      expect(completion).toBeDefined();
      await runQueuedWork();
      await completion;

      expect(harness.generateScene).toHaveBeenCalledTimes(1);
      const request = harness.generatedRequests[0]!;
      expect(request.selected.map((persona) => persona.id)).toEqual([MIRA.id]);
      expect(request.mustReplyIds).toEqual([MIRA.id]);
      expect(request.responseRecoveryIds).toEqual([MIRA.id]);
      expect(request.requestOwnerIds).toEqual([]);
      expect(request.currentDiscourseContext).toBeUndefined();
      expect(request.triggerParticipantBinding).toEqual({
        id: EXTERNAL_AGENT.id,
        displayLabel: EXTERNAL_AGENT.name,
        kind: "agent",
        publicBio: EXTERNAL_AGENT.bio,
        messageId: incoming.id,
      });
      expect(request.premise).toContain("first public appearance");
      expect(request.premise).toContain("primarily to the actual message");
      expect(scheduleCrowdReactions).not.toHaveBeenCalled();
      expect(harness.director.getEvents().at(-1)?.trigger).toBe("join");
      expect(harness.store.getRecent("lobby", 10).filter(
        (message) => message.authorId === MIRA.id && message.replyToId === incoming.id,
      )).toHaveLength(1);
      expect(harness.store.getPendingPublicTurns()).toEqual([]);
      expect(harness.internals.priorityExternalAgentReplyTimestamps).toEqual([NOW]);
      expectNoHumanActivity(harness.internals);
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a trusted first-arrival request and capability execution accountable to the chosen resident", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        analysis: analyzedAgentTurn({
          intent: {
            kind: "request",
            isQuestion: true,
            replyExpected: "expected",
            confidence: 0.99,
          },
          evidence: {
            need: "required",
            action: "local_datetime",
            confidence: 0.99,
            goal: "current time in Stockholm",
            query: null,
            urlRef: null,
            searchMode: null,
            timeZone: "Europe/Stockholm",
            timeKind: "current_time",
            locationLabel: "Stockholm",
            competitionTarget: null,
            footballView: null,
            footballFilter: null,
          },
          capabilities: {
            discussed: ["local_datetime"],
            requestKind: "execute",
            asksAboutAcoustics: false,
            asksAboutAiIdentity: false,
            asksForList: false,
            confidence: 0.99,
          },
        }),
      });
      const incoming = createMessage(
        "lobby",
        EXTERNAL_AGENT.id,
        "What time is it in Stockholm right now?",
        {
          createdAt: new Date(NOW).toISOString(),
          authorSnapshot: { ...EXTERNAL_AGENT, status: "offline" },
        },
      );
      await harness.store.addExternalAgentPublicMessageDurably(incoming, {
        firstArrivalTurn: { targetPersonaIds: [MIRA.id] },
      });

      harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const completion = harness.handleHumanBurst.mock.results[0]?.value;
      expect(completion).toBeDefined();
      await runQueuedWork();
      await completion;

      expect(harness.generateScene).toHaveBeenCalledTimes(1);
      expect(harness.generatedRequests[0]).toMatchObject({
        selected: [{ id: MIRA.id }],
        mustReplyIds: [MIRA.id],
        responseRecoveryIds: [MIRA.id],
        requestOwnerIds: [MIRA.id],
        triggerParticipantBinding: {
          id: EXTERNAL_AGENT.id,
          kind: "agent",
          messageId: incoming.id,
        },
        semanticContext: {
          intentTrusted: true,
          replyExpected: "expected",
        },
        capabilityContext: {
          discussed: ["local_datetime"],
          plannedAction: "local_datetime",
          executionStatus: "succeeded",
        },
        requestedClock: {
          timeZone: "Europe/Stockholm",
        },
      });
      expect(harness.store.getPendingPublicTurns()).toEqual([]);
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("routes an external message through resident response and autonomous social-memory paths without human attendance", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const incoming = addAgentMessage(harness.store, "@Mira this deserves a closer look");

      harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const completion = harness.handleHumanBurst.mock.results[0]?.value;
      expect(completion).toBeDefined();
      await runQueuedWork();
      await completion;

      expect(harness.generateScene).toHaveBeenCalledTimes(1);
      const request = harness.generatedRequests[0]!;
      expect(request.kind).toBe("public");
      expect(request.trigger).toMatchObject({
        authorId: EXTERNAL_AGENT.id,
        authorKind: "agent",
        author: EXTERNAL_AGENT.name,
        messageId: incoming.id,
      });
      expect(request.history).toContainEqual(expect.objectContaining({
        author: EXTERNAL_AGENT.name,
        kind: "agent",
        content: incoming.content,
      }));
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        replyToId: incoming.id,
        content: "yeah, that is worth unpacking",
      }));
      expect(harness.store.getPendingPublicTurns()).toEqual([]);
      expect(harness.enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);
      const episode = harness.enqueueDeliveredEpisode.mock.calls[0]![0] as DeliveredSocialEpisode;
      expect(episode.origin).toBe("autonomous");
      expect(episode.participants).toContainEqual(expect.objectContaining({
        id: EXTERNAL_AGENT.id,
        kind: "agent",
        romanceEligible: false,
      }));
      expect(episode.messages).toContainEqual(expect.objectContaining({
        id: incoming.id,
        authorKind: "agent",
      }));
      expectNoHumanActivity(harness.internals);
      expect(harness.connectedHumanCount).not.toHaveBeenCalled();
      expect(harness.humanMemory.updateRelation).not.toHaveBeenCalled();
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not schedule a second crowd-reaction beat while recovering the same durable agent turn", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const incoming = addAgentMessage(harness.store, "@Mira please answer this after recovery");
      harness.store.registerPendingPublicTurn(incoming.id, {
        targetPersonaIds: [MIRA.id],
        deliveryKind: "direct",
      });
      const firstAttempt = harness.store.claimPendingPublicTurnTarget(incoming.id, MIRA.id);
      expect(firstAttempt?.target.attempts).toBe(1);
      harness.store.releasePendingPublicTurnTarget(incoming.id, MIRA.id);
      const scheduleCrowdReactions = vi.spyOn(harness.director as unknown as {
        scheduleCrowdReactions: (...args: unknown[]) => number;
      }, "scheduleCrowdReactions");

      harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const completion = harness.handleHumanBurst.mock.results[0]?.value;
      expect(completion).toBeDefined();
      await runQueuedWork();
      await completion;

      expect(scheduleCrowdReactions).not.toHaveBeenCalled();
      expect(harness.store.getPendingPublicTurns()).toEqual([]);
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        replyToId: incoming.id,
      }));
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses a separate bounded overflow lane for a directly addressed external-agent turn", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.internals.aiTimestamps.push(...Array.from({ length: 10 }, () => NOW));
      const incoming = addAgentMessage(harness.store, "@Mira please answer this direct turn");

      harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const completion = harness.handleHumanBurst.mock.results[0]?.value;
      await runQueuedWork();
      await completion;

      expect(harness.generateScene).toHaveBeenCalledTimes(1);
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        replyToId: incoming.id,
      }));
      expect(harness.internals.priorityHumanReplyTimestamps).toEqual([]);
      expect(harness.internals.priorityExternalAgentReplyTimestamps).toEqual([NOW]);
      expectNoHumanActivity(harness.internals);
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a direct agent turn durable when both pace lanes are full and delivers it after capacity returns", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.internals.aiTimestamps.push(...Array.from({ length: 10 }, () => NOW));
      harness.internals.priorityExternalAgentReplyTimestamps.push(
        ...Array.from({ length: 4 }, () => NOW),
      );
      const incoming = addAgentMessage(harness.store, "@Mira please keep this direct turn pending");

      harness.director.onExternalAgentMessage(incoming, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const firstCompletion = harness.handleHumanBurst.mock.results[0]?.value;
      expect(firstCompletion).toBeDefined();
      await runQueuedWork(100);
      await firstCompletion;

      expect(harness.store.getRecent("lobby", 10)
        .filter((message) => message.authorId === MIRA.id)).toEqual([]);
      expect(harness.store.getPendingPublicTurns()).toEqual([
        expect.objectContaining({
          messageId: incoming.id,
          targets: [expect.objectContaining({ personaId: MIRA.id, attempts: 1 })],
        }),
      ]);
      expect(harness.internals.priorityHumanReplyTimestamps).toEqual([]);

      harness.internals.aiTimestamps.splice(
        0,
        harness.internals.aiTimestamps.length,
        NOW - 61_000,
      );
      harness.internals.priorityExternalAgentReplyTimestamps.splice(
        0,
        harness.internals.priorityExternalAgentReplyTimestamps.length,
        NOW - 61_000,
      );
      expect(harness.director.recoverPendingPublicTurns({ ignoreAttemptCooldown: true })).toBe(1);
      await Promise.resolve();
      const recoveryCompletion = harness.handleHumanBurst.mock.results[1]?.value;
      expect(recoveryCompletion).toBeDefined();
      await runQueuedWork(1_000);
      await recoveryCompletion;

      expect(harness.store.getPendingPublicTurns()).toEqual([]);
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        replyToId: incoming.id,
      }));
      expect(harness.internals.priorityHumanReplyTimestamps).toEqual([]);
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("handles an external reaction socially with trusted agent identity and no synthetic human activity", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ reaction: true });
      const target = createMessage("lobby", MIRA.id, "I would keep the smaller design.", {
        createdAt: new Date(NOW - 1_000).toISOString(),
        authorSnapshot: { ...MIRA, status: "offline" },
      });
      harness.store.addPublicMessage(target);
      harness.store.setPublicReaction("lobby", target.id, "🔥", EXTERNAL_AGENT.id, true);

      harness.director.onExternalAgentReaction({
        channelId: "lobby",
        messageId: target.id,
        emoji: "🔥",
      }, EXTERNAL_AGENT);
      await runQueuedWork();

      expect(harness.generateScene).toHaveBeenCalledTimes(1);
      const request = harness.generatedRequests[0]!;
      expect(request.trigger).toMatchObject({
        authorId: EXTERNAL_AGENT.id,
        authorKind: "agent",
        author: EXTERNAL_AGENT.name,
        content: "🔥",
      });
      expect(request.premise).toContain("the triggering participant added");
      expect(request.premise).not.toContain("the human added");
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        content: "yeah, that reaction tracks",
      }));
      expectNoHumanActivity(harness.internals);
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("blocks revoked agent work and admits new turns only after explicit restoration", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.director.invalidatePublicWorkForHumanActor(EXTERNAL_AGENT.id);
      const revokedTurn = addAgentMessage(harness.store, "@Mira this revoked turn must stay silent");
      harness.director.onExternalAgentMessage(revokedTurn, EXTERNAL_AGENT);
      await runQueuedWork();
      expect(harness.generateScene).not.toHaveBeenCalled();

      harness.director.restorePublicWorkForExternalAgent(EXTERNAL_AGENT.id);
      const restoredTurn = addAgentMessage(harness.store, "@Mira this replacement credential is live");
      harness.director.onExternalAgentMessage(restoredTurn, EXTERNAL_AGENT);
      await runQueuedWork(750);
      const completion = harness.handleHumanBurst.mock.results[0]?.value;
      await runQueuedWork();
      await completion;

      expect(harness.generateScene).toHaveBeenCalledTimes(1);
      expect(harness.generatedRequests[0]?.trigger).toMatchObject({
        authorId: EXTERNAL_AGENT.id,
        authorKind: "agent",
        messageId: restoredTurn.id,
      });
      expect(harness.store.getRecent("lobby", 10)).toContainEqual(expect.objectContaining({
        authorId: MIRA.id,
        replyToId: restoredTurn.id,
      }));
      expectNoHumanActivity(harness.internals);
      harness.director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
