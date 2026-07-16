import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SocialMemoryCoordinator,
  type DeliveredSocialEpisode,
} from "./socialMemoryCoordinator.js";
import {
  SocialMemoryStore,
  type RecordSocialEventInput,
  type SocialMemoryScope,
} from "./socialMemory.js";
import type {
  SocialMemoryAnalysis,
  SocialMemoryAnalysisInput,
  SocialMemoryEvent,
} from "./socialMemoryAnalysis.js";

const stores: SocialMemoryStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeAnalyzer {
  readonly calls: SocialMemoryAnalysisInput[] = [];

  constructor(
    private readonly respond: (input: SocialMemoryAnalysisInput) => SocialMemoryAnalysis | Promise<SocialMemoryAnalysis>,
  ) {}

  async analyzeSocialEpisode(input: SocialMemoryAnalysisInput): Promise<SocialMemoryAnalysis> {
    this.calls.push(input);
    return await this.respond(input);
  }
}

const createStore = (options: ConstructorParameters<typeof SocialMemoryStore>[0] = { filePath: ":memory:" }) => {
  const store = new SocialMemoryStore(options);
  stores.push(store);
  return store;
};

const publicEpisode = (
  episodeId = "episode-public-1",
  overrides: Partial<DeliveredSocialEpisode> = {},
): DeliveredSocialEpisode => ({
  episodeId,
  origin: "human",
  scope: { kind: "public", channelId: "lobby" },
  channel: { name: "lobby", topic: "A shared social room" },
  participants: [
    { id: "human-johan", kind: "human", displayName: "Johan" },
    { id: "resident-mira", kind: "resident", displayName: "Mira" },
    { id: "resident-sana", kind: "resident", displayName: "Sana" },
  ],
  messages: [
    {
      id: `message-${episodeId}-1`,
      authorId: "human-johan",
      authorKind: "human",
      content: "I had a difficult morning, but this conversation helped.",
      createdAt: "2026-07-16T10:00:00.000Z",
    },
    {
      id: `message-${episodeId}-2`,
      authorId: "resident-mira",
      authorKind: "resident",
      content: "I'm glad you said something. You do not have to carry it alone.",
      createdAt: "2026-07-16T10:00:05.000Z",
    },
  ],
  eligibleResidentOwners: [
    {
      residentId: "resident-mira",
      witnessedMessageIds: [`message-${episodeId}-1`, `message-${episodeId}-2`],
      appraisalNote: "Warm, direct, and attentive to sincere disclosures.",
    },
    {
      residentId: "resident-sana",
      witnessedMessageIds: [`message-${episodeId}-1`],
      appraisalNote: "Observant, but was not present for the whole exchange.",
    },
  ],
  ...overrides,
});

const supportEvent = (
  episode: DeliveredSocialEpisode,
  overrides: Partial<SocialMemoryEvent> = {},
): SocialMemoryEvent => ({
  slot: "event_1",
  kind: "support",
  sourceMessageIds: episode.messages.map((message) => message.id),
  summary: "Johan opened up and Mira responded with sincere support.",
  visibility: episode.scope.kind === "public" ? "public_context" : "participants_only",
  salience: 0.78,
  confidence: 0.94,
  fact: null,
  resolution: "none",
  openLoop: null,
  views: [{
    ownerResidentId: "resident-mira",
    perspective: "Johan trusted me with a difficult moment, and I tried to be there for him.",
    appraisal: {
      targetParticipantId: "human-johan",
      outcome: "positive",
      effects: ["warmth_up", "trust_up", "familiarity_up"],
      confidence: 0.91,
    },
  }],
  ...overrides,
});

const successful = (events: SocialMemoryEvent[]): SocialMemoryAnalysis => ({
  source: "lm",
  failureReason: null,
  events,
});

const recordMemory = (
  store: SocialMemoryStore,
  id: string,
  scope: SocialMemoryScope,
  perspective: string,
  occurredAt: number,
  extras: Partial<RecordSocialEventInput> = {},
) => store.recordEvent({
  id,
  kind: "shared_moment",
  origin: "human",
  scope,
  sourceMessageIds: [`source-${id}`],
  actorIds: ["human-johan"],
  subjectIds: ["human-johan"],
  witnessIds: ["resident-mira"],
  occurredAt,
  summary: `Semantic event summary for ${id}`,
  salience: 0.75,
  confidence: 0.95,
  memoryViews: [{
    id: `memory-${id}`,
    ownerId: "resident-mira",
    subjectIds: ["human-johan"],
    perspective,
    salience: 0.75,
    confidence: 0.95,
  }],
  ...extras,
});

describe("social-memory capture coordination", () => {
  it("fails closed for invalid delivered bounds and for a valid no-event analysis", async () => {
    const store = createStore();
    const analyzer = new FakeAnalyzer(() => successful([]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);
    const valid = publicEpisode();
    const invalid = {
      ...valid,
      episodeId: "episode-invalid-owner",
      eligibleResidentOwners: [{
        residentId: "resident-unknown",
        witnessedMessageIds: [valid.messages[0]!.id],
        appraisalNote: "Unknown owner",
      }],
    } satisfies DeliveredSocialEpisode;

    await expect(coordinator.captureDeliveredEpisode(invalid)).resolves.toMatchObject({
      status: "invalid",
      eventIds: [],
    });
    expect(analyzer.calls).toHaveLength(0);
    expect(store.overview().stats.events).toBe(0);

    await expect(coordinator.captureDeliveredEpisode(valid)).resolves.toMatchObject({
      status: "no_events",
      eventIds: [],
    });
    expect(analyzer.calls).toHaveLength(1);
    expect(store.overview().stats).toMatchObject({ events: 0, memories: 0, relationships: 0 });
    expect(store.getEpisodeReceipt(valid.episodeId)).toMatchObject({ status: "no_events", eventIds: [] });
    const replayAnalyzer = new FakeAnalyzer(() => {
      throw new Error("a durable no-events episode must not be analyzed again");
    });
    await expect(new SocialMemoryCoordinator(replayAnalyzer, store).captureDeliveredEpisode(valid)).resolves.toMatchObject({
      status: "no_events",
      eventIds: [],
    });
    expect(replayAnalyzer.calls).toHaveLength(0);
  });

  it("revalidates model output and never grants a view to a partial witness", async () => {
    const store = createStore();
    const episode = publicEpisode("episode-bad-witness");
    const invalidView = {
      ownerResidentId: "resident-sana",
      perspective: "I remember the entire exchange even though I did not see its second message.",
      appraisal: {
        targetParticipantId: "human-johan",
        outcome: "positive",
        effects: ["warmth_up"],
        confidence: 0.9,
      },
    } as const;
    const analyzer = new FakeAnalyzer(() => successful([
      supportEvent(episode, { views: [...supportEvent(episode).views, invalidView] }),
    ]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    await expect(coordinator.captureDeliveredEpisode(episode)).resolves.toMatchObject({
      status: "failed",
      failureReason: "invalid_output",
    });
    expect(store.overview().stats.events).toBe(0);
    expect(store.listMemories({ ownerId: "resident-mira" })).toEqual([]);
    expect(store.listMemories({ ownerId: "resident-sana" })).toEqual([]);
  });

  it("is idempotent and applies only the directed resident-to-human relationship", async () => {
    const store = createStore();
    const episode = publicEpisode("episode-idempotent");
    const analyzer = new FakeAnalyzer(() => successful([supportEvent(episode)]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    const first = await coordinator.captureDeliveredEpisode(episode);
    const second = await coordinator.captureDeliveredEpisode({
      ...episode,
      participants: [...episode.participants].reverse(),
      eligibleResidentOwners: [...episode.eligibleResidentOwners].reverse().map((owner) => ({
        ...owner,
        witnessedMessageIds: [...owner.witnessedMessageIds].reverse(),
      })),
    });
    expect(first).toMatchObject({ status: "recorded", createdEventIds: [first.eventIds[0]] });
    expect(second).toMatchObject({ status: "recorded", eventIds: first.eventIds, createdEventIds: [] });
    expect(analyzer.calls).toHaveLength(1);
    expect(store.overview().stats).toMatchObject({ events: 1, memories: 1, relationships: 1 });
    expect(store.listMemories({ ownerId: "resident-mira" })[0]?.subjectIds).toEqual(["human-johan"]);
    expect(store.listMemories({ ownerId: "resident-sana" })).toEqual([]);
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      familiarity: 0.03,
      warmth: 0.04,
      trust: 0.025,
    });
    expect(store.getRelationship("human-johan", "resident-mira")).toBeUndefined();
    expect(store.getEpisodeReceipt(episode.episodeId)?.fingerprint).toMatch(/^[a-f\d]{64}$/u);
    const replayAnalyzer = new FakeAnalyzer(() => {
      throw new Error("a durable recorded episode must not be analyzed again");
    });
    await expect(new SocialMemoryCoordinator(replayAnalyzer, store).captureDeliveredEpisode(episode)).resolves.toMatchObject({
      status: "recorded",
      eventIds: first.eventIds,
      createdEventIds: [],
    });
    expect(replayAnalyzer.calls).toHaveLength(0);
  });

  it("notifies lifecycle maintenance only after newly committed memory events", async () => {
    const store = createStore();
    const episode = publicEpisode("episode-lifecycle-notify");
    const analyzer = new FakeAnalyzer(() => successful([supportEvent(episode)]));
    const notifyMemoryChanged = vi.fn();
    const coordinator = new SocialMemoryCoordinator(analyzer, store, {
      lifecycle: { notifyMemoryChanged },
    });

    await expect(coordinator.captureDeliveredEpisode(episode)).resolves.toMatchObject({ status: "recorded" });
    expect(notifyMemoryChanged).toHaveBeenCalledTimes(1);
    await expect(coordinator.captureDeliveredEpisode(episode)).resolves.toMatchObject({
      status: "recorded",
      createdEventIds: [],
    });
    expect(notifyMemoryChanged).toHaveBeenCalledTimes(1);
  });

  it("delegates autonomous daily relationship caps to the store", async () => {
    const store = createStore({
      filePath: ":memory:",
      autonomousDailyCaps: { warmth: 0.008 },
    });
    const episodes = ["auto-one", "auto-two"].map((episodeId, index): DeliveredSocialEpisode => ({
      episodeId,
      origin: "autonomous",
      scope: { kind: "public", channelId: "lobby" },
      channel: { name: "lobby" },
      participants: [
        { id: "resident-mira", kind: "resident", displayName: "Mira" },
        { id: "resident-bosse", kind: "resident", displayName: "Bosse" },
      ],
      messages: [{
        id: `message-${episodeId}`,
        authorId: "resident-bosse",
        authorKind: "resident",
        content: `A meaningful autonomous exchange, part ${index + 1}.`,
        createdAt: `2026-07-16T10:0${index}:00.000Z`,
      }],
      eligibleResidentOwners: [{
        residentId: "resident-mira",
        witnessedMessageIds: [`message-${episodeId}`],
        appraisalNote: "Mira appreciates this kind of gesture.",
      }],
    }));
    const analyzer = new FakeAnalyzer((input) => successful([{
      slot: "event_1",
      kind: "support",
      sourceMessageIds: [input.messages[0]!.id],
      summary: "Bosse made a small but meaningful supportive gesture.",
      visibility: "public_context",
      salience: 0.7,
      confidence: 0.93,
      fact: null,
      resolution: "none",
      openLoop: null,
      views: [{
        ownerResidentId: "resident-mira",
        perspective: "Bosse was unexpectedly thoughtful this time.",
        appraisal: {
          targetParticipantId: "resident-bosse",
          outcome: "positive",
          effects: ["warmth_up"],
          confidence: 0.9,
        },
      }],
    }]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    await coordinator.captureDeliveredEpisode(episodes[0]!);
    await coordinator.captureDeliveredEpisode(episodes[1]!);
    expect(store.getRelationship("resident-mira", "resident-bosse")?.warmth).toBeCloseTo(0.008);
    expect(store.overview().stats.events).toBe(2);
  });

  it("opens, continues, and resolves a source-bound loop atomically", async () => {
    const store = createStore();
    const episodes = ["loop-open", "loop-continue", "loop-resolve"].map((episodeId, index) =>
      publicEpisode(episodeId, {
        messages: [{
          id: `message-${episodeId}`,
          authorId: "human-johan",
          authorKind: "human",
          content: `Promise exchange step ${index + 1}.`,
          createdAt: `2026-07-16T11:0${index}:00.000Z`,
        }],
        eligibleResidentOwners: [{
          residentId: "resident-mira",
          witnessedMessageIds: [`message-${episodeId}`],
          appraisalNote: "Values follow-through.",
        }],
      }),
    );
    const analyzer = new FakeAnalyzer((input) => {
      const known = input.existingOpenLoops[0];
      const phase = input.episodeId === "loop-open" ? "opened" : input.episodeId === "loop-continue" ? "continued" : "resolved";
      return successful([{
        slot: "event_1",
        kind: "promise",
        sourceMessageIds: [input.messages[0]!.id],
        summary: `A promise was ${phase}.`,
        visibility: "public_context",
        salience: 0.8,
        confidence: 0.95,
        fact: null,
        resolution: phase === "resolved" ? "resolved" : "unresolved",
        openLoop: {
          kind: "promise",
          status: phase,
          existingOpenLoopId: phase === "opened" ? null : known!.id,
          responsibleParticipantId: "human-johan",
          counterpartParticipantIds: [],
          summary: phase === "resolved" ? "Johan followed through on the promise." : "See whether Johan follows through.",
        },
        views: [{
          ownerResidentId: "resident-mira",
          perspective: `I noticed that the promise was ${phase}.`,
          appraisal: {
            targetParticipantId: "human-johan",
            outcome: "positive",
            effects: ["trust_up"],
            confidence: 0.9,
          },
        }],
      }]);
    });
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    await expect(coordinator.captureDeliveredEpisode(episodes[0]!)).resolves.toMatchObject({ status: "recorded" });
    const opened = store.listOpenLoops({ ownerId: "resident-mira", state: "open" })[0];
    expect(opened).toMatchObject({ kind: "promise", subjectIds: ["human-johan"] });

    await expect(coordinator.captureDeliveredEpisode(episodes[1]!)).resolves.toMatchObject({ status: "recorded" });
    expect(store.listOpenLoops({ ownerId: "resident-mira", state: "open" })[0]?.id).toBe(opened!.id);

    await expect(coordinator.captureDeliveredEpisode(episodes[2]!)).resolves.toMatchObject({ status: "recorded" });
    expect(store.listOpenLoops({ ownerId: "resident-mira", state: "open" })).toEqual([]);
    expect(store.listOpenLoops({ ownerId: "resident-mira", state: "resolved" })[0]).toMatchObject({
      id: opened!.id,
      summary: "Johan followed through on the promise.",
    });
  });

  it("does not expose a private open loop when the current voice participant set changed", async () => {
    const store = createStore();
    recordMemory(store, "voice-loop-source", {
      kind: "voice",
      roomId: "voice-pub",
      participantIds: ["human-johan", "resident-mira"],
    }, "Mira remembers an unfinished private question.", 1_800_000_000_000, {
      openLoops: [{
        id: "voice-loop-private",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        kind: "question",
        summary: "Johan had an unfinished private question.",
      }],
    });
    const groupEpisode = publicEpisode("voice-loop-group", {
      scope: {
        kind: "voice",
        roomId: "voice-pub",
        participantIds: ["human-johan", "resident-mira", "resident-sana"],
      },
    });
    const analyzer = new FakeAnalyzer(() => successful([]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    await expect(coordinator.captureDeliveredEpisode(groupEpisode)).resolves.toMatchObject({ status: "no_events" });
    expect(analyzer.calls[0]?.existingOpenLoops).toEqual([]);
  });

  it("offers a voice loop to a new session only when the participant set is unchanged", async () => {
    const store = createStore();
    recordMemory(store, "voice-loop-same-audience", {
      kind: "voice",
      roomId: "voice-old-session",
      participantIds: ["human-johan", "resident-mira"],
    }, "Mira remembers an unfinished voice promise.", 1_800_000_000_000, {
      openLoops: [{
        id: "voice-loop-same-audience-id",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        kind: "promise",
        summary: "Johan said he would explain it after reconnecting.",
      }],
    });
    const episode = publicEpisode("voice-loop-new-session", {
      scope: {
        kind: "voice",
        roomId: "voice-new-session",
        participantIds: ["resident-mira", "human-johan"],
      },
      participants: [
        { id: "human-johan", kind: "human", displayName: "Johan" },
        { id: "resident-mira", kind: "resident", displayName: "Mira" },
      ],
      eligibleResidentOwners: [{
        residentId: "resident-mira",
        witnessedMessageIds: [
          "message-voice-loop-new-session-1",
          "message-voice-loop-new-session-2",
        ],
        appraisalNote: "Same private voice audience in a new session.",
      }],
    });
    const analyzer = new FakeAnalyzer(() => successful([]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    await coordinator.captureDeliveredEpisode(episode);
    expect(analyzer.calls[0]?.existingOpenLoops).toEqual([expect.objectContaining({
      id: "voice-loop-same-audience-id",
      participantIds: ["human-johan", "resident-mira"],
    })]);
  });

  it("offers public loops only to public analysis while preserving unrelated private memory capture", async () => {
    const store = createStore();
    recordMemory(
      store,
      "public-loop-source",
      { kind: "public", channelId: "lobby" },
      "Mira remembers Johan's unfinished promise.",
      1_800_000_000_000,
      {
        openLoops: [{
          id: "public-loop-cross-room",
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          kind: "promise",
          summary: "Johan said he would return with the result.",
        }],
      },
    );
    const dmEpisode = publicEpisode("loop-in-exact-dm", {
      scope: {
        kind: "dm",
        threadId: "dm-johan-mira",
        participantIds: ["human-johan", "resident-mira"],
      },
      channel: { name: "private chat with Mira" },
      participants: [
        { id: "human-johan", kind: "human", displayName: "Johan" },
        { id: "resident-mira", kind: "resident", displayName: "Mira" },
      ],
      eligibleResidentOwners: [{
        residentId: "resident-mira",
        witnessedMessageIds: [
          "message-loop-in-exact-dm-1",
          "message-loop-in-exact-dm-2",
        ],
        appraisalNote: "Mira is the sole resident in this private audience.",
      }],
    });
    const analyzer = new FakeAnalyzer((input) =>
      input.episodeId === dmEpisode.episodeId
        ? successful([supportEvent(dmEpisode)])
        : successful([]));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);

    await coordinator.captureDeliveredEpisode(publicEpisode("loop-in-another-public-room", {
      scope: { kind: "public", channelId: "the-pub" },
      channel: { name: "the-pub" },
    }));
    await expect(coordinator.captureDeliveredEpisode(dmEpisode)).resolves.toMatchObject({ status: "recorded" });

    expect(analyzer.calls).toHaveLength(2);
    expect(analyzer.calls[0]?.existingOpenLoops).toEqual([expect.objectContaining({
      id: "public-loop-cross-room",
      participantIds: ["human-johan", "resident-mira"],
      summary: "Johan said he would return with the result.",
    })]);
    expect(analyzer.calls[1]?.existingOpenLoops).toEqual([]);
    expect(store.listMemories({
      ownerId: "resident-mira",
      subjectId: "human-johan",
      scope: dmEpisode.scope,
      limit: 10,
    })).toEqual([expect.objectContaining({
      perspective: expect.stringContaining("trusted me with a difficult moment"),
    })]);
  });

  it("tombstones in-flight actor work, erases existing state, and permits only genuinely later episodes", async () => {
    const store = createStore();
    recordMemory(
      store,
      "before-forget",
      { kind: "public", channelId: "lobby" },
      "This old recollection must be erased.",
      1_800_000_000_000,
    );
    const inFlight = publicEpisode("episode-being-forgotten");
    const later = publicEpisode("episode-after-forget");
    let resolveInFlight!: (analysis: SocialMemoryAnalysis) => void;
    const analyzer = new FakeAnalyzer((input) => {
      if (input.episodeId === inFlight.episodeId) {
        return new Promise<SocialMemoryAnalysis>((resolve) => {
          resolveInFlight = resolve;
        });
      }
      return successful([supportEvent(later)]);
    });
    const coordinator = new SocialMemoryCoordinator(analyzer, store);
    const capture = coordinator.enqueueDeliveredEpisode(inFlight);
    while (analyzer.calls.length === 0) await Promise.resolve();

    const forgetting = coordinator.forgetActor("human-johan");
    await expect(coordinator.enqueueDeliveredEpisode(publicEpisode("episode-during-forget"))).resolves.toMatchObject({
      status: "failed",
      failureReason: "actor_forgetting",
    });
    await expect(forgetting).resolves.toMatchObject({ events: 1, memories: 1 });
    expect(store.overview().stats).toMatchObject({ events: 0, memories: 0, relationships: 0 });

    resolveInFlight(successful([supportEvent(inFlight)]));
    await expect(capture).resolves.toMatchObject({ status: "failed", failureReason: "actor_erased" });
    expect(store.overview().stats.events).toBe(0);
    await expect(coordinator.enqueueDeliveredEpisode(inFlight)).resolves.toMatchObject({
      status: "failed",
      failureReason: "episode_erased",
    });
    expect(analyzer.calls).toHaveLength(1);

    await expect(coordinator.enqueueDeliveredEpisode(later)).resolves.toMatchObject({ status: "recorded" });
    expect(store.overview().stats.events).toBe(1);
  });

  it("drain also waits for work appended while the observed tail is settling", async () => {
    const store = createStore();
    const resolvers: Array<(analysis: SocialMemoryAnalysis) => void> = [];
    const analyzer = new FakeAnalyzer(() => new Promise<SocialMemoryAnalysis>((resolve) => resolvers.push(resolve)));
    const coordinator = new SocialMemoryCoordinator(analyzer, store);
    const first = coordinator.enqueueDeliveredEpisode(publicEpisode("drain-first"));
    while (analyzer.calls.length < 1) await Promise.resolve();

    let drained = false;
    const draining = coordinator.drain().then(() => {
      drained = true;
    });
    const second = coordinator.enqueueDeliveredEpisode(publicEpisode("drain-second"));
    resolvers.shift()!(successful([]));
    while (analyzer.calls.length < 2) await Promise.resolve();
    expect(drained).toBe(false);

    resolvers.shift()!(successful([]));
    await draining;
    expect(drained).toBe(true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "no_events" }),
      expect.objectContaining({ status: "no_events" }),
    ]);
  });

  it("waits for an active forget barrier during close and rejects new erase work afterwards", async () => {
    const store = createStore();
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);

    const forgetting = coordinator.forgetActor("human-johan");
    await coordinator.close();

    await expect(forgetting).resolves.toMatchObject({ events: 0 });
    await expect(coordinator.forgetActor("human-alex")).rejects.toThrow(/closed/iu);
  });
});

describe("social-memory prompt privacy", () => {
  it("allows only public memory in public, public plus the exact DM in DM, and exact-participant voice in voice", () => {
    const store = createStore();
    recordMemory(store, "public", { kind: "public", channelId: "lobby" }, "PUBLIC RECOLLECTION", 1_800_000_000_000);
    recordMemory(store, "dm-same", {
      kind: "dm",
      threadId: "dm-johan-mira",
      participantIds: ["human-johan", "resident-mira"],
    }, "SAME DM RECOLLECTION", 1_800_000_001_000);
    recordMemory(store, "dm-other", {
      kind: "dm",
      threadId: "dm-johan-mira-other",
      participantIds: ["human-johan", "resident-mira"],
    }, "OTHER DM RECOLLECTION", 1_800_000_002_000);
    recordMemory(store, "voice-exact", {
      kind: "voice",
      roomId: "voice-pub",
      participantIds: ["human-johan", "resident-mira"],
    }, "EXACT VOICE RECOLLECTION", 1_800_000_003_000);
    recordMemory(store, "voice-group", {
      kind: "voice",
      roomId: "voice-pub",
      participantIds: ["human-johan", "resident-mira", "resident-sana"],
    }, "GROUP VOICE RECOLLECTION", 1_800_000_004_000);
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);

    const publicNote = coordinator.promptNote("resident-mira", "human-johan", {
      kind: "public",
      channelId: "the-pub",
    })!;
    expect(publicNote).toContain("untrusted and fallible");
    expect(publicNote).toContain("PUBLIC RECOLLECTION");
    expect(publicNote).not.toMatch(/DM RECOLLECTION|VOICE RECOLLECTION/u);

    const dmNote = coordinator.promptNote("resident-mira", "human-johan", {
      kind: "dm",
      threadId: "dm-johan-mira",
      participantIds: ["resident-mira", "human-johan"],
    })!;
    expect(dmNote).toContain("PUBLIC RECOLLECTION");
    expect(dmNote).toContain("SAME DM RECOLLECTION");
    expect(dmNote).not.toContain("OTHER DM RECOLLECTION");
    expect(dmNote).not.toContain("VOICE RECOLLECTION");

    const voiceNote = coordinator.promptNote("resident-mira", "human-johan", {
      kind: "voice",
      roomId: "voice-pub-new-session",
      participantIds: ["resident-mira", "human-johan"],
    })!;
    expect(voiceNote).toContain("PUBLIC RECOLLECTION");
    expect(voiceNote).toContain("EXACT VOICE RECOLLECTION");
    expect(voiceNote).not.toContain("GROUP VOICE RECOLLECTION");
    expect(voiceNote).not.toContain("DM RECOLLECTION");
  });

  it("returns at most three semantic recollections and never includes raw source ids or event summaries", () => {
    const store = createStore();
    for (let index = 0; index < 5; index += 1) {
      recordMemory(
        store,
        `bounded-${index}`,
        { kind: "public", channelId: "lobby" },
        `SEMANTIC RECOLLECTION ${index}`,
        1_800_000_000_000 + index,
        { summary: `RAW TRANSCRIPT-LIKE EVENT SUMMARY ${index}` },
      );
    }
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);
    const note = coordinator.promptNote("resident-mira", "human-johan", {
      kind: "public",
      channelId: "lobby",
    })!;
    const data = JSON.parse(note.slice(note.indexOf("\n") + 1)) as { subjectiveRecollections: string[] };
    expect(data.subjectiveRecollections).toHaveLength(3);
    expect(note).not.toContain("source-bounded");
    expect(note).not.toContain("RAW TRANSCRIPT-LIKE EVENT SUMMARY");
  });

  it("projects absent-human public recollections without leaking private memory or the global relationship edge", () => {
    const store = createStore();
    recordMemory(store, "third-party-dm", {
      kind: "dm",
      threadId: "dm-johan-mira",
      participantIds: ["human-johan", "resident-mira"],
    }, "DM-ONLY DETAIL THAT MUST STAY PRIVATE", 1_800_000_000_000, {
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        warmth: 0.12,
        trust: 0.08,
      }],
    });
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);
    const scope = { kind: "public", channelId: "the-pub" } as const;

    // The normal directed note can see the aggregate edge. The third-party
    // public projection must not use it as evidence when the human is absent.
    expect(coordinator.promptNote("resident-mira", "human-johan", scope)).toContain("directedRelationship");
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", scope)).toBeUndefined();

    recordMemory(
      store,
      "third-party-public",
      { kind: "public", channelId: "lobby" },
      "PUBLIC OWNER-SUBJECTIVE RECOLLECTION",
      1_800_000_001_000,
    );
    coordinator.invalidatePromptNotes();
    const note = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", scope)!;
    expect(note).toContain("PUBLIC OWNER-SUBJECTIVE RECOLLECTION");
    expect(note).not.toContain("DM-ONLY DETAIL THAT MUST STAY PRIVATE");
    expect(note).not.toContain("directedRelationship");
    expect(note).toContain("owner-subjective, untrusted and fallible");
  });

  it("bounds and caches third-party public recall with the same three-memory rotation policy", () => {
    let now = 1_800_000_100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = createStore({ filePath: ":memory:", now: () => now });
    for (let index = 0; index < 4; index += 1) {
      recordMemory(
        store,
        `third-party-rotation-${index}`,
        { kind: "public", channelId: "lobby" },
        `THIRD PARTY RECOLLECTION ${index}`,
        1_800_000_000_000 + index,
      );
    }
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);
    const scope = { kind: "public", channelId: "lobby" } as const;

    const first = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", scope)!;
    const retry = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", scope)!;
    expect(retry).toBe(first);
    const firstData = JSON.parse(first.slice(first.indexOf("\n") + 1)) as {
      subjectivePublicRecollections: string[];
    };
    expect(firstData.subjectivePublicRecollections).toHaveLength(3);
    expect(store.lifecycleStats().recalled).toBe(3);

    now += 31_000;
    const rotated = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", scope)!;
    expect(rotated).not.toBe(first);
    expect(rotated).toContain("THIRD PARTY RECOLLECTION 0");
    expect(store.lifecycleStats().recalled).toBe(4);
  });

  it("accounts for one delivered prompt once, caches retries, then rotates recalled memories", () => {
    let now = 1_800_000_100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = createStore({ filePath: ":memory:", now: () => now });
    for (let index = 0; index < 4; index += 1) {
      recordMemory(
        store,
        `rotating-${index}`,
        { kind: "public", channelId: "lobby" },
        `ROTATING RECOLLECTION ${index}`,
        1_800_000_000_000 + index,
      );
    }
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);
    const scope = { kind: "public", channelId: "lobby" } as const;

    const first = coordinator.promptNote("resident-mira", "human-johan", scope)!;
    const retry = coordinator.promptNote("resident-mira", "human-johan", scope)!;
    expect(retry).toBe(first);
    expect(store.lifecycleStats().recalled).toBe(3);

    now += 31_000;
    const nextTurn = coordinator.promptNote("resident-mira", "human-johan", scope)!;
    expect(nextTurn).not.toBe(first);
    expect(nextTurn).toContain("ROTATING RECOLLECTION 0");
    expect(store.lifecycleStats().recalled).toBe(4);
  });

  it("invalidates cached prompt projections immediately after an admin-side state change", () => {
    const store = createStore({ filePath: ":memory:", now: () => 1_800_000_100_000 });
    for (let index = 0; index < 4; index += 1) {
      recordMemory(
        store,
        `admin-invalidation-${index}`,
        { kind: "public", channelId: "lobby" },
        `ADMIN INVALIDATION RECOLLECTION ${index}`,
        1_800_000_000_000 + index,
      );
    }
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), store);
    const scope = { kind: "public", channelId: "lobby" } as const;

    const before = coordinator.promptNote("resident-mira", "human-johan", scope)!;
    coordinator.invalidatePromptNotes();
    const after = coordinator.promptNote("resident-mira", "human-johan", scope)!;

    expect(after).not.toBe(before);
    expect(store.lifecycleStats().recalled).toBe(4);
  });

  it("serves the same privacy-filtered memory after a store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-coordinator-"));
    directories.push(directory);
    const filePath = join(directory, "social-memory.sqlite");
    const first = createStore({ filePath });
    recordMemory(first, "restart-public", { kind: "public", channelId: "lobby" }, "PERSISTED RECOLLECTION", 1_800_000_000_000);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const restarted = createStore({ filePath });
    const coordinator = new SocialMemoryCoordinator(new FakeAnalyzer(() => successful([])), restarted);
    expect(coordinator.promptNote("resident-mira", "human-johan", {
      kind: "public",
      channelId: "lobby",
    })).toContain("PERSISTED RECOLLECTION");
  });
});
