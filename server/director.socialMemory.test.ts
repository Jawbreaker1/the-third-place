import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { recruitReferencedMemoryOwner, SocialDirector } from "./director.js";
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

const restorableProfile = (id: string, name: string, lastSeenAt: number) => ({
  tokenHash: id.padEnd(64, "0").slice(0, 64),
  member: {
    ...human,
    id,
    name,
    status: "offline" as const,
  },
  lastSeenAt,
});

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
    publicThirdPartyPromptNote?: ReturnType<typeof vi.fn>;
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
  const publicThirdPartyPromptNote = options.coordinator?.publicThirdPartyPromptNote ?? vi.fn(() => undefined);
  const model = {
    health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
    rememberDeliveredLine: vi.fn(),
    ...options.model,
  };
  const humanMemory = {
    getRelation: vi.fn(() => undefined),
    updateRelation: vi.fn(),
    promptNote: vi.fn(() => undefined),
    listRestorableProfiles: vi.fn(() => []),
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
      socialMemory: { enqueueDeliveredEpisode, promptNote, publicThirdPartyPromptNote } as never,
      weatherForecastProvider: null,
    },
  );
  return {
    director,
    store,
    actorChannels,
    enqueueDeliveredEpisode,
    promptNote,
    publicThirdPartyPromptNote,
    model,
    humanMemory,
  };
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

  it("invalidates one actor's late public reply and memory without disturbing another actor's burst", async () => {
    vi.useFakeTimers();
    try {
      const otherHuman = {
        ...human,
        id: "guest-social-memory-survivor",
        name: "Survivor",
      };
      type Line = { personaId: string; content: string; source: "lm"; sourceIds: string[] };
      const pendingScenes = new Map<string, { selectedId: string; resolve: (lines: Line[]) => void }>();
      const { director, store, enqueueDeliveredEpisode } = setup({
        model: {
          analyzeTurn: vi.fn(async () => analyzedTurn()),
          generateScene: vi.fn((request: {
            trigger: { author: string };
            selected: Array<(typeof PERSONAS)[number]>;
          }) => new Promise<Line[]>((resolve) => {
            pendingScenes.set(request.trigger.author, {
              selectedId: request.selected[0]!.id,
              resolve,
            });
          })),
        },
      });
      const forgottenMessage = createMessage("lobby", human.id, "det här kontot ska tas bort nu");
      const survivingMessage = createMessage("lobby", otherHuman.id, "min samtidiga fråga ska fortfarande få svar");
      store.addPublicMessage(forgottenMessage);
      store.addPublicMessage(survivingMessage);
      const handle = (message: typeof forgottenMessage, member: typeof human) => (director as unknown as {
        handleHumanBurst: (messages: typeof forgottenMessage[], actor: typeof human) => Promise<void>;
      }).handleHumanBurst([message], member);
      const forgottenPending = handle(forgottenMessage, human);
      const survivingPending = handle(survivingMessage, otherHuman);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect([...pendingScenes.keys()]).toEqual(expect.arrayContaining([human.name, otherHuman.name]));
      director.invalidatePublicWorkForHumanActor(human.id);
      const forgottenScene = pendingScenes.get(human.name)!;
      const survivingScene = pendingScenes.get(otherHuman.name)!;
      forgottenScene.resolve([{
        personaId: forgottenScene.selectedId,
        content: "ett för sent svar som aldrig får levereras",
        source: "lm",
        sourceIds: [],
      }]);
      survivingScene.resolve([{
        personaId: survivingScene.selectedId,
        content: "det här samtidiga svaret ska levereras",
        source: "lm",
        sourceIds: [],
      }]);
      await vi.runAllTimersAsync();
      await Promise.all([forgottenPending, survivingPending]);

      const aiMessages = store.getRecent("lobby", 20).filter((message) => message.authorId.startsWith("ai-"));
      expect(aiMessages).toEqual([
        expect.objectContaining({ content: "det här samtidiga svaret ska levereras", replyToId: survivingMessage.id }),
      ]);
      expect(enqueueDeliveredEpisode).toHaveBeenCalledTimes(1);
      const episode = enqueueDeliveredEpisode.mock.calls[0]![0] as DeliveredSocialEpisode;
      expect(episode.participants.map((participant) => participant.id)).toContain(otherHuman.id);
      expect(episode.participants.map((participant) => participant.id)).not.toContain(human.id);
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

  it("deterministically surfaces at most the first note-bearing resident in a multi-resident scene", () => {
    const promptNote = vi.fn((ownerId: string, subjectId: string) =>
      `PRIVATE NOTE ${ownerId} -> ${subjectId}`
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
    const [mira, sana, bosse] = PERSONAS.slice(0, 3);
    const internals = director as unknown as {
      relationshipNotes: (
        personas: typeof PERSONAS,
        member: typeof human,
        scope: { kind: "public"; channelId: string },
      ) => Record<string, string>;
      residentRelationshipNotes: (
        owners: typeof PERSONAS,
        counterparts: typeof PERSONAS,
        scope: { kind: "public"; channelId: string },
      ) => Record<string, string>;
    };

    const humanNotes = internals.relationshipNotes(
      [mira!, sana!],
      human,
      { kind: "public", channelId: "lobby" },
    );
    expect(Object.keys(humanNotes)).toEqual([mira!.id]);
    expect(promptNote).toHaveBeenCalledTimes(1);
    expect(promptNote).toHaveBeenCalledWith(mira!.id, human.id, {
      kind: "public",
      channelId: "lobby",
    });

    promptNote.mockClear();
    const residentNotes = internals.residentRelationshipNotes(
      [mira!, sana!],
      [mira!, sana!, bosse!],
      { kind: "public", channelId: "the-pub" },
    );
    expect(Object.keys(residentNotes)).toEqual([mira!.id]);
    expect(promptNote).toHaveBeenCalledTimes(2);
    expect(promptNote).not.toHaveBeenCalledWith(sana!.id, expect.anything(), expect.anything());
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

  it("retrieves at most the two AI-to-AI notes that can actually reach the scene prompt", () => {
    const promptNote = vi.fn((ownerId: string, subjectId: string) =>
      `DIRECTED MEMORY ${ownerId} -> ${subjectId}`
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
    const [owner, first, second, omitted] = PERSONAS.slice(0, 4);
    const internals = director as unknown as {
      residentRelationshipNotes: (
        owners: typeof PERSONAS,
        counterparts: typeof PERSONAS,
        scope: { kind: "public"; channelId: string },
      ) => Record<string, string>;
    };

    const notes = internals.residentRelationshipNotes(
      [owner!],
      [owner!, first!, second!, omitted!],
      { kind: "public", channelId: "lobby" },
    );

    expect(promptNote).toHaveBeenCalledTimes(2);
    expect(promptNote).toHaveBeenNthCalledWith(1, owner!.id, first!.id, {
      kind: "public",
      channelId: "lobby",
    });
    expect(promptNote).toHaveBeenNthCalledWith(2, owner!.id, second!.id, {
      kind: "public",
      channelId: "lobby",
    });
    expect(promptNote).not.toHaveBeenCalledWith(owner!.id, omitted!.id, expect.anything());
    expect(notes[owner!.id]).toContain(first!.name);
    expect(notes[owner!.id]).toContain(second!.name);
    expect(notes[owner!.id]).not.toContain(omitted!.name);
    director.stop();
  });

  it("builds an offline-human catalog with global caseless ambiguity removal and a hard bound", () => {
    const duplicateUpper = restorableProfile("human-duplicate-upper", "Per", 9_000);
    const duplicateLower = restorableProfile("human-duplicate-lower", "ｐｅｒ", 8_000);
    const residentCollision = restorableProfile("human-resident-collision", "MIRA", 7_000);
    const unique = restorableProfile("human-unique", "Κατερίνα", 6_000);
    const overflow = Array.from({ length: 40 }, (_, index) =>
      restorableProfile(`human-bounded-${index}`, `Distinct ${index}`, 5_000 - index));
    const { director } = setup({
      humanMemory: {
        listRestorableProfiles: vi.fn(() => [
          restorableProfile(human.id, human.name, 10_000),
          duplicateUpper,
          duplicateLower,
          residentCollision,
          unique,
          ...overflow,
        ]),
      },
    });
    const internals = director as unknown as {
      offlineHumanCandidates: (speakerId: string) => Array<{ id: string; displayLabel: string }>;
    };

    const candidates = internals.offlineHumanCandidates(human.id);
    expect(candidates).toHaveLength(32);
    expect(candidates[0]).toEqual({ id: unique.member.id, displayLabel: unique.member.name });
    expect(candidates.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([
      human.id,
      duplicateUpper.member.id,
      duplicateLower.member.id,
      residentCollision.member.id,
    ]));
    director.stop();
  });

  it("scans bounded selected owners but exposes exactly one note-bearing public viewpoint", () => {
    const [mira, sana] = ["ai-mira", "ai-sana"].map((id) =>
      PERSONAS.find((persona) => persona.id === id)!);
    const publicThirdPartyPromptNote = vi.fn((ownerId: string, subjectId: string) =>
      ownerId === sana.id && subjectId === "human-second"
        ? "SECOND OWNER PUBLIC RECOLLECTION"
        : undefined);
    const { director } = setup({
      coordinator: {
        enqueueDeliveredEpisode: vi.fn(async () => ({
          status: "no_events",
          episodeId: "test",
          eventIds: [],
          createdEventIds: [],
        })),
        promptNote: vi.fn(() => undefined),
        publicThirdPartyPromptNote,
      },
    });
    const internals = director as unknown as {
      publicReferencedHumanNotes: (
        personas: typeof PERSONAS,
        referencedHumanIds: string[],
        humanCandidates: Array<{ id: string; displayLabel: string }>,
        scope: { kind: "public"; channelId: string },
      ) => Record<string, string>;
    };

    const notes = internals.publicReferencedHumanNotes(
      [mira, sana],
      ["human-first", "human-second", "human-ignored"],
      [
        { id: "human-first", displayLabel: "Alex" },
        { id: "human-second", displayLabel: "Samira" },
        { id: "human-ignored", displayLabel: "Ignored" },
      ],
      { kind: "public", channelId: "lobby" },
    );

    expect(Object.keys(notes)).toEqual([sana.id]);
    expect(notes[sana.id]).toContain("Samira");
    expect(notes[sana.id]).toContain("SECOND OWNER PUBLIC RECOLLECTION");
    expect(publicThirdPartyPromptNote).toHaveBeenCalledTimes(4);
    expect(publicThirdPartyPromptNote).not.toHaveBeenCalledWith(
      expect.anything(),
      "human-ignored",
      expect.anything(),
    );
    director.stop();
  });

  it("surfaces a trusted offline human's public recollection when exact room history is absent", async () => {
    vi.useFakeTimers();
    try {
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const analyzeTurn = vi.fn(async () => ({
        ...analyzedTurn(),
        personas: {
          addressedIds: [mira.id],
          requestedReplyIds: [mira.id],
          relevantIds: [mira.id],
          addressConfidence: 0.99,
          relevanceConfidence: 0.99,
        },
        referencedHumanIds: ["human-alex"],
        referencedHumanConfidence: 0.98,
        historyRecall: { need: "required" as const, query: "Álex", confidence: 0.97 },
      }));
      const generateScene = vi.fn(async (scene: any) => [{
        personaId: mira.id,
        content: "jaa, jag minns Álex lite från förut",
        source: "lm" as const,
      }]);
      const promptNote = vi.fn(() => "CURRENT SPEAKER NOTE MUST NOT WIN");
      const publicThirdPartyPromptNote = vi.fn((ownerId: string, subjectId: string) =>
        ownerId === mira.id && subjectId === "human-alex"
          ? "MIRA PUBLIC RECOLLECTION ABOUT ALEX"
          : undefined);
      const { director, store } = setup({
        model: { analyzeTurn, generateScene },
        humanMemory: {
          listRestorableProfiles: vi.fn(() => [
            restorableProfile(human.id, human.name, 2_000),
            restorableProfile("human-alex", "Álex", 1_000),
          ]),
        },
        coordinator: {
          enqueueDeliveredEpisode: vi.fn(async () => ({
            status: "no_events",
            episodeId: "test",
            eventIds: [],
            createdEventIds: [],
          })),
          promptNote,
          publicThirdPartyPromptNote,
        },
      });
      const incoming = createMessage("lobby", human.id, "@Mira kommer du ihåg Álex från förut?");
      store.addPublicMessage(incoming);
      const pending = (director as unknown as {
        handleHumanBurst: (messages: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;

      expect(analyzeTurn).toHaveBeenCalledWith(expect.objectContaining({
        humanCandidates: [{ id: "human-alex", displayLabel: "Álex" }],
      }), { durableDelivery: false });
      expect(publicThirdPartyPromptNote).toHaveBeenCalledWith(
        mira.id,
        "human-alex",
        { kind: "public", channelId: "lobby" },
      );
      expect(promptNote).not.toHaveBeenCalled();
      const scene = generateScene.mock.calls[0]![0] as any;
      expect(scene.roomRecall).toBeUndefined();
      expect(scene.relationshipNotes[mira.id]).toContain("MIRA PUBLIC RECOLLECTION ABOUT ALEX");
      expect(scene.relationshipNotes[mira.id]).toContain("Álex");
      expect(scene.requestOwnerIds).toEqual([mira.id]);
      expect(scene.premise).toContain("fallible, owner-subjective public recollection");
      expect(generateScene).toHaveBeenCalledTimes(1);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("recruits an unselected eligible resident who actually owns the recollection and makes them accountable", async () => {
    vi.useFakeTimers();
    try {
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const sana = PERSONAS.find((persona) => persona.id === "ai-sana")!;
      const publicThirdPartyPromptNote = vi.fn((ownerId: string, subjectId: string) =>
        ownerId === sana.id && subjectId === "human-dario"
          ? "SANA PUBLIC RECOLLECTION ABOUT DARIO"
          : undefined);
      const generateScene = vi.fn(async () => [
        { personaId: mira.id, content: "Sana minns honom bättre än jag", source: "lm" as const },
        { personaId: sana.id, content: "jo, lite faktiskt", source: "lm" as const },
      ]);
      const { director, store } = setup({
        model: {
          analyzeTurn: vi.fn(async () => ({
            ...analyzedTurn(),
            social: { ...analyzedTurn().social, pileOnRisk: 0.9 },
            personas: {
              addressedIds: [mira.id],
              requestedReplyIds: [mira.id],
              relevantIds: [sana.id],
              addressConfidence: 0.99,
              relevanceConfidence: 0.99,
            },
            referencedHumanIds: ["human-dario"],
            referencedHumanConfidence: 0.98,
            historyRecall: { need: "required" as const, query: "Dario", confidence: 0.97 },
          })),
          generateScene,
        },
        humanMemory: {
          listRestorableProfiles: vi.fn(() => [restorableProfile("human-dario", "Dario", 1_000)]),
        },
        coordinator: {
          enqueueDeliveredEpisode: vi.fn(async () => ({
            status: "no_events",
            episodeId: "test",
            eventIds: [],
            createdEventIds: [],
          })),
          promptNote: vi.fn(() => undefined),
          publicThirdPartyPromptNote,
        },
      });
      const incoming = createMessage("lobby", human.id, "@Mira kommer du ihåg Dario?");
      store.addPublicMessage(incoming);
      const pending = (director as unknown as {
        handleHumanBurst: (messages: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;

      const scene = generateScene.mock.calls[0]![0] as any;
      expect(publicThirdPartyPromptNote).toHaveBeenNthCalledWith(1, mira.id, "human-dario", expect.anything());
      expect(publicThirdPartyPromptNote).toHaveBeenCalledWith(sana.id, "human-dario", expect.anything());
      expect(publicThirdPartyPromptNote.mock.calls.length).toBeLessThanOrEqual(12);
      expect(Object.keys(scene.relationshipNotes)).toEqual([sana.id]);
      expect(scene.requestOwnerIds).toEqual([sana.id]);
      expect(scene.mustReplyIds).toEqual(expect.arrayContaining([mira.id, sana.id]));
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("prefers an exact retained room excerpt and does not also surface fallible third-party memory", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const publicThirdPartyPromptNote = vi.fn(() => "SHOULD NOT BE READ WHEN EXACT HISTORY EXISTS");
      const generateScene = vi.fn(async () => [{
        personaId: mira.id,
        content: "ja, teleskopet minns jag",
        source: "lm" as const,
      }]);
      const { director, store } = setup({
        model: {
          analyzeTurn: vi.fn(async () => ({
            ...analyzedTurn(),
            personas: {
              addressedIds: [mira.id],
              requestedReplyIds: [mira.id],
              relevantIds: [mira.id],
              addressConfidence: 0.99,
              relevanceConfidence: 0.99,
            },
            referencedHumanIds: ["human-alex"],
            referencedHumanConfidence: 0.98,
            historyRecall: { need: "required" as const, query: "Álex teleskop", confidence: 0.97 },
          })),
          generateScene,
        },
        humanMemory: {
          listRestorableProfiles: vi.fn(() => [restorableProfile("human-alex", "Álex", 1_000)]),
        },
        coordinator: {
          enqueueDeliveredEpisode: vi.fn(async () => ({
            status: "no_events",
            episodeId: "test",
            eventIds: [],
            createdEventIds: [],
          })),
          promptNote: vi.fn(() => undefined),
          publicThirdPartyPromptNote,
        },
      });
      store.addPublicMessage(createMessage("lobby", "human-alex", "Álex byggde ett teleskop", {
        authorSnapshot: restorableProfile("human-alex", "Álex", 1_000).member,
        createdAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      }));
      store.addPublicMessage(createMessage("lobby", mira.id, "det där teleskopet lät faktiskt rätt coolt", {
        authorSnapshot: mira,
        generation: "lm",
        createdAt: new Date(now - 2 * 60 * 60_000 + 10_000).toISOString(),
      }));
      for (let index = 0; index < 35; index += 1) {
        store.addPublicMessage(createMessage("lobby", human.id, `neutral archive row ${index}`, {
          authorSnapshot: human,
          createdAt: new Date(now - 60 * 60_000 + index * 10_000).toISOString(),
        }));
      }
      const incoming = createMessage("lobby", human.id, "@Mira kommer du ihåg Álex och teleskopet?", {
        authorSnapshot: human,
        createdAt: new Date(now).toISOString(),
      });
      store.addPublicMessage(incoming);
      const pending = (director as unknown as {
        handleHumanBurst: (messages: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;

      expect(publicThirdPartyPromptNote).not.toHaveBeenCalled();
      const scene = generateScene.mock.calls[0]![0] as any;
      expect(JSON.stringify(scene.roomRecall?.transcript)).toContain("teleskop");
      expect(scene.relationshipNotes).not.toEqual(expect.objectContaining({
        [mira.id]: expect.stringContaining("SHOULD NOT BE READ"),
      }));
      expect(scene.premise).toContain("exact retained public-room excerpt");
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not displace three directly addressed residents with a fourth recollection owner", () => {
    const [mira, sana, bosse, vale] = ["ai-mira", "ai-sana", "ai-bosse", "ai-vale"]
      .map((id) => PERSONAS.find((persona) => persona.id === id)!);
    const addressed = [mira, bosse, vale];

    const capped = recruitReferencedMemoryOwner(
      addressed,
      sana,
      addressed.map((persona) => persona.id),
      3,
    );

    expect(capped.map((persona) => persona.id)).toEqual(addressed.map((persona) => persona.id));
    expect(capped.some((persona) => persona.id === sana.id)).toBe(false);
  });

  it("keeps grounded evidence ownership authoritative over a simultaneous offline-human reference", async () => {
    vi.useFakeTimers();
    try {
      const relevant = PERSONAS.slice(0, 4);
      const publicThirdPartyPromptNote = vi.fn(() => "FALLIBLE NOTE MUST NOT RECRUIT DURING EVIDENCE");
      const generateScene = vi.fn(async (scene: any) => scene.selected.map((persona: typeof PERSONAS[number]) => ({
        personaId: persona.id,
        content: `${persona.name} ger det grundade svaret`,
        source: "lm" as const,
      })));
      const base = analyzedTurn();
      const { director, store } = setup({
        model: {
          analyzeTurn: vi.fn(async () => ({
            ...base,
            social: { ...base.social, energy: 1, absurdity: 0.8 },
            personas: {
              addressedIds: [],
              requestedReplyIds: [],
              relevantIds: relevant.map((persona) => persona.id),
              addressConfidence: 0,
              relevanceConfidence: 0.99,
            },
            referencedHumanIds: ["human-noor"],
            referencedHumanConfidence: 0.98,
            evidence: {
              need: "required" as const,
              action: "local_datetime" as const,
              confidence: 0.99,
              goal: "aktuell tid i Stockholm",
              query: null,
              urlRef: null,
              searchMode: null,
              timeZone: "Europe/Stockholm",
              timeKind: "current_time" as const,
              locationLabel: "Stockholm",
              competitionTarget: null,
              footballView: null,
              footballFilter: null,
            },
            capabilities: {
              discussed: ["local_datetime" as const],
              requestKind: "execute" as const,
              asksAboutAcoustics: false,
              asksAboutAiIdentity: false,
              asksForList: false,
              confidence: 0.99,
            },
            historyRecall: { need: "required" as const, query: "Noor", confidence: 0.97 },
          })),
          generateScene,
        },
        humanMemory: {
          listRestorableProfiles: vi.fn(() => [restorableProfile("human-noor", "Noor", 1_000)]),
        },
        coordinator: {
          enqueueDeliveredEpisode: vi.fn(async () => ({
            status: "no_events",
            episodeId: "test",
            eventIds: [],
            createdEventIds: [],
          })),
          promptNote: vi.fn(() => undefined),
          publicThirdPartyPromptNote,
        },
      });
      const incoming = createMessage(
        "lobby",
        human.id,
        "Vad är klockan i Stockholm, och minns någon Noor?",
      );
      store.addPublicMessage(incoming);
      const pending = (director as unknown as {
        handleHumanBurst: (messages: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;

      expect(publicThirdPartyPromptNote).not.toHaveBeenCalled();
      const scene = generateScene.mock.calls[0]![0] as any;
      const selectedIds = new Set(scene.selected.map((persona: typeof PERSONAS[number]) => persona.id));
      expect(scene.selected).toHaveLength(3);
      expect(scene.requestOwnerIds).toHaveLength(1);
      expect(scene.requestOwnerIds.every((id: string) => selectedIds.has(id))).toBe(true);
      expect(scene.mustReplyIds.every((id: string) => selectedIds.has(id))).toBe(true);
      expect(JSON.stringify(scene.relationshipNotes)).not.toContain("FALLIBLE NOTE MUST NOT RECRUIT");
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses an empty relationship-note map in a focused retry when no note exists", async () => {
    vi.useFakeTimers();
    try {
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const generateScene = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ personaId: mira.id, content: "nu svarar jag", source: "lm" as const }]);
      const { director, store } = setup({
        model: {
          analyzeTurn: vi.fn(async () => ({
            ...analyzedTurn(),
            personas: {
              addressedIds: [mira.id],
              requestedReplyIds: [mira.id],
              relevantIds: [mira.id],
              addressConfidence: 0.99,
              relevanceConfidence: 0.99,
            },
          })),
          generateScene,
        },
      });
      const incoming = createMessage("lobby", human.id, "@Mira svara på det här");
      store.addPublicMessage(incoming);
      const pending = (director as unknown as {
        handleHumanBurst: (messages: typeof incoming[], member: typeof human) => Promise<void>;
      }).handleHumanBurst([incoming], human);
      await vi.runAllTimersAsync();
      await pending;

      expect(generateScene).toHaveBeenCalledTimes(2);
      expect(generateScene.mock.calls[1]![0]).toMatchObject({ relationshipNotes: {} });
      expect(generateScene.mock.calls[1]![0].relationshipNotes).not.toHaveProperty(mira.id);
      director.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
