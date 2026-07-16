import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import { PERSONAS } from "./personas.js";
import { createFailClosedTurnAnalysis } from "./semanticRouter.js";
import { createMessage, RoomStore } from "./store.js";
import type { DeliveredSocialEpisode } from "./socialMemoryCoordinator.js";

const human = {
  id: "guest-social-memory",
  name: "Guest",
  kind: "human" as const,
  status: "online" as const,
  avatar: { color: "#123", accent: "#456", glyph: "G" },
};

const analyzedTurn = () => ({
  ...createFailClosedTurnAnalysis("disabled"),
  source: "lm" as const,
  failureReason: null,
  language: { tag: "sv", confidence: 0.99 },
  intent: { kind: "question" as const, isQuestion: true, replyExpected: "expected" as const, confidence: 0.99 },
  social: {
    warmth: 0.2,
    hostility: 0,
    playfulness: 0,
    absurdity: 0,
    urgency: 0,
    energy: 0.3,
    pileOnRisk: 0,
    claimStrength: 0,
    confidence: 0.99,
  },
});

const setup = (options: {
  now?: () => number;
  coordinator?: {
    enqueueDeliveredEpisode: ReturnType<typeof vi.fn>;
    promptNote: ReturnType<typeof vi.fn>;
  };
  model?: Record<string, unknown>;
  humanMemory?: Record<string, unknown>;
} = {}) => {
  const store = new RoomStore(`/tmp/director-social-memory-${process.pid}-${Math.random()}.json`);
  const actorChannels = new ActorChannelRuntime();
  const enqueueDeliveredEpisode = options.coordinator?.enqueueDeliveredEpisode ?? vi.fn(async () => ({
    status: "no_events",
    episodeId: "test",
    eventIds: [],
    createdEventIds: [],
  }));
  const promptNote = options.coordinator?.promptNote ?? vi.fn(() => undefined);
  const model = {
    health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
    rememberDeliveredLine: vi.fn(),
    ...options.model,
  };
  const humanMemory = {
    getRelation: vi.fn(() => undefined),
    updateRelation: vi.fn(),
    promptNote: vi.fn(() => undefined),
    ...options.humanMemory,
  };
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    store,
    model as never,
    actorChannels,
    { research: vi.fn(), researchSite: vi.fn() } as never,
    humanMemory as never,
    () => [human, ...PERSONAS],
    () => 1,
    {
      now: options.now,
      rng: () => 0.5,
      socialMemory: { enqueueDeliveredEpisode, promptNote } as never,
      weatherForecastProvider: null,
    },
  );
  return { director, store, actorChannels, enqueueDeliveredEpisode, promptNote, model, humanMemory };
};

describe("SocialDirector persistent social-memory delivery gates", () => {
  it("captures the human source for residents who read it even when every generated reply stays silent", async () => {
    vi.useFakeTimers();
    try {
      const { director, store, enqueueDeliveredEpisode } = setup({
        model: {
          analyzeTurn: vi.fn(async () => analyzedTurn()),
          generateScene: vi.fn(async () => []),
        },
      });
      const incoming = createMessage("lobby", human.id, "någon som hör mig?");
      store.addPublicMessage(incoming);
      const pending = (director as unknown as {
        handleHumanBurst: (messages: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;

      expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);
      const episode = enqueueDeliveredEpisode.mock.calls[0]![0] as DeliveredSocialEpisode;
      expect(episode.messages).toEqual([expect.objectContaining({ id: incoming.id, authorKind: "human" })]);
      expect(episode.eligibleResidentOwners.length).toBeGreaterThan(0);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("captures selected silent readers and never includes a rejected response candidate", () => {
    const { director, store, enqueueDeliveredEpisode } = setup();
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const sana = PERSONAS.find((persona) => persona.id === "ai-sana")!;
    const first = createMessage("lobby", human.id, "första delen");
    const latest = createMessage("lobby", human.id, "och frågan?");
    store.addPublicMessage(first);
    store.addPublicMessage(latest);
    const internals = director as unknown as {
      capturePublicHumanSocialEpisode: (
        burst: typeof first[],
        posted: typeof first[],
        member: typeof human,
        selected: typeof PERSONAS,
      ) => void;
    };

    internals.capturePublicHumanSocialEpisode([first, latest], [], human, [mira, sana]);
    expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);
    const silentEpisode = enqueueDeliveredEpisode.mock.calls[0]![0] as DeliveredSocialEpisode;
    expect(silentEpisode.messages.map((message) => message.id)).toEqual([first.id, latest.id]);
    expect(silentEpisode.eligibleResidentOwners).toEqual(expect.arrayContaining([
      expect.objectContaining({ residentId: mira.id, witnessedMessageIds: [first.id, latest.id] }),
      expect.objectContaining({ residentId: sana.id, witnessedMessageIds: [first.id, latest.id] }),
    ]));

    const delivered = createMessage("lobby", mira.id, "ett faktiskt levererat svar", { replyToId: latest.id });
    const rejected = createMessage("lobby", sana.id, "det här filtret släppte aldrig igenom");
    store.addPublicMessage(delivered);
    internals.capturePublicHumanSocialEpisode([first, latest], [delivered], human, [mira, sana]);

    expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(2);
    const episode = enqueueDeliveredEpisode.mock.calls[1]![0] as DeliveredSocialEpisode;
    expect(episode.messages.map((message) => message.id)).toEqual([first.id, latest.id, delivered.id]);
    expect(episode.messages.map((message) => message.id)).not.toContain(rejected.id);
    expect(episode.eligibleResidentOwners).toEqual(expect.arrayContaining([
      expect.objectContaining({ residentId: mira.id, witnessedMessageIds: [first.id, latest.id, delivered.id] }),
      expect.objectContaining({ residentId: sana.id, witnessedMessageIds: [first.id, latest.id] }),
    ]));
    director.stop();
  });

  it("captures a DM only after the delivered reply and includes the exact burst plus that reply", async () => {
    vi.useFakeTimers();
    try {
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const generateScene = vi.fn(async () => [{ personaId: mira.id, content: "jag svarar på båda", source: "lm" as const }]);
      const { director, store, enqueueDeliveredEpisode } = setup({
        model: { analyzeTurn: vi.fn(async () => analyzedTurn()), generateScene },
      });
      const thread = store.openDm(human.id, mira.id);
      const first = store.addDmMessage(thread.id, human.id, "hallå?")!;
      const latest = store.addDmMessage(thread.id, human.id, "vad tänker du?")!;

      const turns = [
        director.onDirectMessage(first, human, mira),
        director.onDirectMessage(latest, human, mira),
      ];
      await vi.runAllTimersAsync();
      await Promise.all(turns);

      expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);
      const episode = enqueueDeliveredEpisode.mock.calls[0]![0] as DeliveredSocialEpisode;
      const storedReply = store.getDmMessages(thread.id).at(-1)!;
      expect(storedReply.authorId).toBe(mira.id);
      expect(episode.messages.map((message) => message.id)).toEqual([first.id, latest.id, storedReply.id]);
      expect(episode.eligibleResidentOwners[0]?.witnessedMessageIds).toEqual([
        first.id,
        latest.id,
        storedReply.id,
      ]);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("requires two delivered autonomous resident posts and enforces the channel cooldown", () => {
    let now = Date.parse("2026-07-16T15:00:00.000Z");
    const { director, enqueueDeliveredEpisode } = setup({ now: () => now });
    const [mira, sana, bosse, vale] = ["ai-mira", "ai-sana", "ai-bosse", "ai-vale"]
      .map((id) => PERSONAS.find((persona) => persona.id === id)!);
    const post = (persona: typeof mira, content: string) => (director as unknown as {
      postPublic: (
        channelId: string,
        actor: typeof mira,
        text: string,
        replyToId: undefined,
        generation: "lm",
        sources: [],
        linkPreview: undefined,
        autonomousKind: "ambient",
      ) => ReturnType<typeof createMessage> | undefined;
    }).postPublic("lobby", persona, content, undefined, "lm", [], undefined, "ambient");

    expect(post(mira, "första faktiska autonoma raden")).toBeDefined();
    expect(enqueueDeliveredEpisode).not.toHaveBeenCalled();
    expect(post(sana, "andra faktiska autonoma raden")).toBeDefined();
    expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);
    expect((enqueueDeliveredEpisode.mock.calls[0]![0] as DeliveredSocialEpisode).origin).toBe("autonomous");

    now += 60_000;
    expect(post(bosse, "en rad under minnes-cooldown")).toBeDefined();
    expect(post(vale, "ännu en rad under samma cooldown")).toBeDefined();
    expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);

    now += 10 * 60_000;
    expect(post(mira, "ny rad efter cooldown")).toBeDefined();
    expect(post(sana, "andra nya raden efter cooldown")).toBeDefined();
    expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(2);
    director.stop();
  });

  it("combines bounded legacy and persistent notes without running the legacy memory analyzer", () => {
    const analyzeMemoryTurn = vi.fn();
    const enqueueDeliveredEpisode = vi.fn(async () => ({
      status: "no_events",
      episodeId: "test",
      eventIds: [],
      createdEventIds: [],
    }));
    const promptNote = vi.fn(() => "PERSISTENT PRIVATE NOTE");
    const { director } = setup({
      coordinator: { enqueueDeliveredEpisode, promptNote },
      model: { analyzeMemoryTurn },
      humanMemory: { promptNote: vi.fn(() => "LEGACY PRIVATE NOTE") },
    });
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const message = createMessage("lobby", human.id, "minns detta");
    const internals = director as unknown as {
      schedulePersistentMemory: (messages: typeof message[], member: typeof human) => void;
      relationshipNotes: (
        personas: typeof PERSONAS,
        member: typeof human,
        scope: { kind: "public"; channelId: string },
      ) => Record<string, string>;
    };

    internals.schedulePersistentMemory([message], human);
    const note = internals.relationshipNotes([mira], human, { kind: "public", channelId: "lobby" })[mira.id]!;
    expect(analyzeMemoryTurn).not.toHaveBeenCalled();
    expect(note).toContain("PERSISTENT PRIVATE NOTE");
    expect(note).toContain("LEGACY PRIVATE NOTE");
    director.stop();
  });

  it("retrieves directed AI-to-AI memory only for structural ambient counterparts", () => {
    const promptNote = vi.fn((ownerId: string, subjectId: string) =>
      ownerId === "ai-mira" && subjectId === "ai-sana"
        ? "PRIVATE DIRECTED MEMORY FROM MIRA TOWARD SANA"
        : undefined,
    );
    const { director } = setup({
      coordinator: {
        enqueueDeliveredEpisode: vi.fn(async () => ({
          status: "no_events",
          episodeId: "test",
          eventIds: [],
          createdEventIds: [],
        })),
        promptNote,
      },
    });
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const sana = PERSONAS.find((persona) => persona.id === "ai-sana")!;
    const internals = director as unknown as {
      residentRelationshipNotes: (
        owners: typeof PERSONAS,
        counterparts: typeof PERSONAS,
        scope: { kind: "public"; channelId: string },
      ) => Record<string, string>;
    };

    const notes = internals.residentRelationshipNotes(
      [mira],
      [mira, sana],
      { kind: "public", channelId: "the-pub" },
    );

    expect(promptNote).toHaveBeenCalledTimes(1);
    expect(promptNote).toHaveBeenCalledWith(
      mira.id,
      sana.id,
      { kind: "public", channelId: "the-pub" },
    );
    expect(notes[mira.id]).toContain("PRIVATE DIRECTED MEMORY FROM MIRA TOWARD SANA");
    expect(notes[mira.id]).toContain(sana.name);
    director.stop();
  });
});
