import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { CHANNELS, type AutonomousResearchSeed } from "./channels.js";
import { buildConversationContext, type SceneConversationContext } from "./conversationFlow.js";
import type { ConversationResearchChoice, ConversationResearchInput } from "./conversationResearch.js";
import { SocialDirector, type AmbientThreadState } from "./director.js";
import type { GeneratedLine, SceneRequest } from "./lmStudio.js";
import { PERSONAS, type Persona } from "./personas.js";
import type { ResearchPacket } from "./researchBroker.js";
import { createMessage, RoomStore } from "./store.js";

const channel = CHANNELS.find((room) => room.id === "ai-programming")!;
const lead = { ...PERSONAS.find((resident) => resident.id === "ai-mira")!, canResearch: true, cooldownMs: 0 };
const peer = { ...PERSONAS.find((resident) => resident.id === "ai-sana")!, canResearch: false, cooldownMs: 0 };
const sourceUrl = "https://example.org/tool-retry-test";
const content = "That retry test checks the saved state too. I would trust that more than a final-answer score.";
const cleanups: Array<() => Promise<void>> = [];
type PreparedResearch = { research: ResearchPacket; seed: AutonomousResearchSeed; release: () => void };

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-conversation-research-"));
  const store = new RoomStore(join(directory, "room.json"), { now: () => Date.now() });
  const actors = new ActorChannelRuntime([lead, peer]);
  vi.spyOn(actors, "autonomousCandidatesFor").mockReturnValue([lead, peer]);
  const first = createMessage(channel.id, lead.id, "How would you test an agent recovering after a failed tool step?");
  const latest = createMessage(channel.id, peer.id, "I wonder if a real benchmark checks the saved state after the retry.");
  store.addPublicMessage(first);
  store.addPublicMessage(latest);
  const conversation = buildConversationContext({
    phase: "continuation", rootMessageId: first.id,
    messages: [first, latest].map((message) => ({
      messageId: message.id, authorId: message.authorId, author: message.authorId,
      kind: "ai", content: message.content, createdAt: message.createdAt,
    })),
  });
  const choice: ConversationResearchChoice = {
    sourceMessageId: latest.id, query: "agent failed tool retry saved state benchmark",
    question: "Does a recovery benchmark check saved state after retry?", mode: "web",
  };
  const packet: ResearchPacket = {
    kind: "page", query: choice.query, retrievedAt: new Date().toISOString(),
    results: [{ id: "S1", title: "Tool retry benchmark", url: sourceUrl,
      snippet: "A controlled test verifies saved tool state after retry, not only the final answer." }],
  };
  const plan = vi.fn(async (_input: ConversationResearchInput): Promise<ConversationResearchChoice | null> => choice);
  const research = vi.fn(async () => packet);
  const read = vi.fn(async () => packet);
  const generate = vi.fn(async (request: SceneRequest): Promise<GeneratedLine[]> => [{
    personaId: request.selected[0]!.id, content, source: "lm",
    sourceIds: request.research ? ["S1"] : [],
  }]);
  let frequency = 100;
  let waiting = 0;
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never, store,
    { health: () => ({ connected: true, queueDepth: waiting }), planConversationResearch: plan,
      generateScene: generate, rememberDeliveredLine: vi.fn() } as never,
    actors, { research } as never, {} as never, () => [lead, peer], () => 0,
    {
      now: () => Date.now(), rng: () => 0.2, autonomousResearchEnabled: true,
      autonomousResearchChance: 1, consideredConversationChance: 0, ambientTemporalCueChance: 0,
      pageReader: { read } as never,
      behaviorTuningProvider: (roomId) => ({
        activity: roomId && roomId !== channel.id ? 0 : 60,
        autonomousLinkFrequency: frequency, competence: 50, aggression: 25, explicitness: 50,
      }),
    },
  );
  const thread: AmbientThreadState = {
    seed: "Testing recovery after a failed tool step", episodeId: "episode-research-test",
    causalRootId: first.id, messageCount: 2, lastMessageId: latest.id, lastAuthorId: peer.id,
    participantIds: [lead.id, peer.id], debateBeat: false, languageHint: "en", languageTag: "en",
    openedAt: Date.now(), updatedAt: Date.now(),
  };
  const internals = director as unknown as {
    ambientThreads: Map<string, AmbientThreadState>;
    channelEpoch: Map<string, number>;
    ambientLifecycleGeneration: number;
    ambientGenerationsInFlight: number;
    autonomousResearchLease?: symbol;
    autonomousResearchSuccessTimestamps: number[];
    lastAutonomousResearchSuccessAt?: number;
    lastAutonomousResearchSuccessAtByChannel: Map<string, number>;
    ambientPersonasInFlight: Map<string, symbol>;
    ambientChannelsInFlight: Map<string, symbol>;
    ambientPublicationReservations: number;
    maybeResearchConversation: (
      room: typeof channel, state: AmbientThreadState, resident: Persona,
      context: SceneConversationContext, epoch: number, lifecycle: number,
    ) => Promise<PreparedResearch | undefined>;
    maybeRunAutonomousResearch: () => Promise<boolean>;
    scheduleAmbient: () => void;
    runAmbient: (workerId?: number) => Promise<void>;
  };
  internals.ambientThreads.set(channel.id, thread);
  vi.spyOn(internals, "maybeRunAutonomousResearch").mockResolvedValue(false);
  vi.spyOn(internals, "scheduleAmbient").mockImplementation(() => {});
  cleanups.push(async () => {
    director.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    director, store, thread, internals, conversation, choice, packet, plan, research, read, generate,
    frequency: (value: number) => { frequency = value; },
    waiting: (value: number) => { waiting = value; },
    run: (context = conversation, resident = lead, room = channel) => internals.maybeResearchConversation(
      room, thread, resident, context, 0, 0,
    ),
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-12T08:00:00.000Z");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("optional research within a committed conversation", () => {
  it.each(["disabled", "already tried", "existing evidence", "too early", "no researcher", "waiting queue", "daily cap", "global cooldown", "room cooldown", "lease"])(
    "does not call the model or web when the %s gate is closed", async (gate) => {
      const h = await createHarness();
      if (gate === "disabled") h.frequency(0);
      if (gate === "already tried") h.thread.researchAttempted = true;
      if (gate === "existing evidence") h.thread.research = h.packet;
      if (gate === "too early") h.thread.messageCount = 1;
      if (gate === "waiting queue") h.waiting(1);
      if (gate === "daily cap") h.internals.autonomousResearchSuccessTimestamps = Array(1_000).fill(Date.now());
      if (gate === "global cooldown") h.internals.lastAutonomousResearchSuccessAt = Date.now();
      if (gate === "room cooldown") h.internals.lastAutonomousResearchSuccessAtByChannel.set(channel.id, Date.now());
      const unrelatedLease = Symbol("another room");
      if (gate === "lease") h.internals.autonomousResearchLease = unrelatedLease;
      expect(await h.run(h.conversation, gate === "no researcher" ? { ...lead, canResearch: false } : lead)).toBeUndefined();
      expect(h.plan).not.toHaveBeenCalled();
      expect(h.research).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.thread.researchDecisionAtMessageCount).toBeUndefined();
      if (gate === "lease") expect(h.internals.autonomousResearchLease).toBe(unrelatedLease);
    },
  );

  it("does not start planning from empty context or a non-public channel", async () => {
    const h = await createHarness();
    expect(await h.run(buildConversationContext({ phase: "continuation", messages: [] }))).toBeUndefined();
    expect(await h.run(h.conversation, lead, { ...channel, id: "dm:private-thread" })).toBeUndefined();
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.research).not.toHaveBeenCalled();
  });

  it("paces null decisions by new publications, without consuming a lookup or success budget", async () => {
    const h = await createHarness();
    h.plan.mockResolvedValue(null);
    expect(await h.run()).toBeUndefined();
    expect(h.thread.researchDecisionAtMessageCount).toBe(2);
    expect(h.thread.researchAttempted).toBeUndefined();
    h.thread.messageCount = 4;
    expect(await h.run()).toBeUndefined();
    expect(h.plan).toHaveBeenCalledTimes(1);
    h.thread.messageCount = 5;
    expect(await h.run()).toBeUndefined();
    expect(h.plan).toHaveBeenCalledTimes(2);
    expect(h.research).not.toHaveBeenCalled();
    expect(h.internals.ambientGenerationsInFlight).toBe(0);
    expect(h.internals.autonomousResearchLease).toBeUndefined();
    expect(h.director.getAutonomousResearchDiagnostics()).toMatchObject({ attempts: 0, published: 0, failed: 0 });
  });

  it("stages safe evidence with a held global lease and no success accounting until publication", async () => {
    const h = await createHarness();
    const prepared = await h.run();
    expect(prepared?.research.results).toEqual(h.packet.results);
    expect(h.plan).toHaveBeenCalledWith({
      channelId: channel.id, channelName: channel.name, roomTopic: expect.any(String),
      resident: { id: lead.id, name: lead.name, interests: lead.interests }, conversation: h.conversation,
    });
    expect(h.research).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.thread.researchAttempted).toBe(true);
    expect(h.thread.research).toBeUndefined();
    expect(h.internals.autonomousResearchLease).toBeTypeOf("symbol");
    expect(h.internals.autonomousResearchSuccessTimestamps).toEqual([]);
    expect(h.director.getAutonomousResearchDiagnostics()).toMatchObject({ attempts: 1, published: 0, failed: 0 });
    prepared!.release();
    expect(h.internals.autonomousResearchLease).toBeUndefined();
    const otherLease = Symbol("later work");
    h.internals.autonomousResearchLease = otherLease;
    prepared!.release();
    expect(h.internals.autonomousResearchLease).toBe(otherLease);
    h.internals.autonomousResearchLease = undefined;
  });

  it.each(["planner", "search", "source"])("falls back to ordinary continuation after a %s failure", async (failure) => {
    const h = await createHarness();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (failure === "planner") h.plan.mockRejectedValue(new Error("provider unavailable"));
    if (failure === "search") h.research.mockRejectedValue(new Error("search unavailable"));
    if (failure === "source") h.read.mockRejectedValue(new Error("source unavailable"));
    await h.internals.runAmbient();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]).toMatchObject({ conversationContext: { phase: "continuation" } });
    expect(h.generate.mock.calls[0]?.[0].research).toBeUndefined();
    expect(h.store.getRecent(channel.id, 1)[0]?.content).toBe(content);
    expect(h.thread.closedAt).toBeUndefined();
    expect(h.thread.messageCount).toBe(3);
    expect(h.internals.autonomousResearchLease).toBeUndefined();
    expect(h.internals.ambientGenerationsInFlight).toBe(0);
    expect(h.internals.ambientPublicationReservations).toBe(0);
    expect(h.director.getAutonomousResearchDiagnostics().published).toBe(0);
  });

  it("keeps a null planner decision conversational rather than closing the room", async () => {
    const h = await createHarness();
    h.plan.mockResolvedValue(null);
    await h.internals.runAmbient();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.research).not.toHaveBeenCalled();
    expect(h.thread.messageCount).toBe(3);
    expect(h.thread.closedAt).toBeUndefined();
  });

  it.each(["epoch", "lifecycle", "admin", "thread replaced"])(
    "prevents web access when %s changes during planning", async (change) => {
      const h = await createHarness();
      h.plan.mockImplementation(async () => {
        if (change === "epoch") h.internals.channelEpoch.set(channel.id, 1);
        if (change === "lifecycle") h.internals.ambientLifecycleGeneration += 1;
        if (change === "admin") h.frequency(0);
        if (change === "thread replaced") h.internals.ambientThreads.set(channel.id, { ...h.thread });
        return h.choice;
      });
      await expect(h.run()).rejects.toThrow("superseded");
      expect(h.research).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.thread.researchAttempted).toBeUndefined();
      expect(h.internals.autonomousResearchLease).toBeUndefined();
      expect(h.internals.ambientGenerationsInFlight).toBe(0);
    },
  );

  it("does not read a result when the conversation was superseded during discovery", async () => {
    const h = await createHarness();
    h.research.mockImplementation(async () => {
      h.internals.channelEpoch.set(channel.id, 1);
      return h.packet;
    });
    await expect(h.run()).rejects.toThrow("during discovery");
    expect(h.read).not.toHaveBeenCalled();
    expect(h.internals.autonomousResearchLease).toBeUndefined();
  });

  it.each(["epoch", "admin"])("does not generate or publish when %s changes during source reading", async (change) => {
    const h = await createHarness();
    h.read.mockImplementation(async () => {
      if (change === "epoch") h.internals.channelEpoch.set(channel.id, 1);
      else h.frequency(0);
      return h.packet;
    });
    await h.internals.runAmbient();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.store.getRecent(channel.id, 10)).toHaveLength(2);
    expect(h.thread.research).toBeUndefined();
    expect(h.thread.closedAt).toBeUndefined();
    expect(h.internals.autonomousResearchLease).toBeUndefined();
    expect(h.internals.ambientPublicationReservations).toBe(0);
  });

  it("retains the lease through generation and only accounts for a sourced publication", async () => {
    const h = await createHarness();
    h.generate.mockImplementation(async (request) => {
      expect(h.internals.autonomousResearchLease).toBeTypeOf("symbol");
      expect(h.thread.research).toBeUndefined();
      expect(h.director.getAutonomousResearchDiagnostics().published).toBe(0);
      return [{ personaId: request.selected[0]!.id, content, source: "lm", sourceIds: ["S1"] }];
    });
    await h.internals.runAmbient();
    expect(h.store.getRecent(channel.id, 1)[0]).toMatchObject({ content, sources: [{ url: sourceUrl }] });
    expect(h.thread.research?.results[0]?.url).toBe(sourceUrl);
    expect(h.thread.autonomousResearchContext?.discussionAngle).toBe(h.choice.question);
    expect(h.thread.messageCount).toBe(3);
    expect(h.director.getAutonomousResearchDiagnostics()).toMatchObject({ attempts: 1, published: 1, failed: 0 });
    expect(h.internals.autonomousResearchLease).toBeUndefined();
    expect(h.internals.ambientPersonasInFlight.size).toBe(0);
    expect(h.internals.ambientChannelsInFlight.size).toBe(0);
    expect(h.internals.ambientPublicationReservations).toBe(0);
  });

  it("never counts a lookup as publication when the resident elects not to cite it", async () => {
    const h = await createHarness();
    h.generate.mockImplementation(async (request) => [{
      personaId: request.selected[0]!.id, content, source: "lm", sourceIds: [],
    }]);
    await h.internals.runAmbient();
    expect(h.store.getRecent(channel.id, 1)[0]).toMatchObject({ content });
    expect(h.store.getRecent(channel.id, 1)[0]?.sources ?? []).toEqual([]);
    expect(h.thread.research).toBeUndefined();
    expect(h.thread.autonomousResearchContext).toBeUndefined();
    expect(h.director.getAutonomousResearchDiagnostics().published).toBe(0);
    expect(h.internals.autonomousResearchLease).toBeUndefined();
  });

  it("does not publish newly fetched evidence after Admin disables links during generation", async () => {
    const h = await createHarness();
    h.generate.mockImplementation(async (request) => {
      h.frequency(0);
      return [{ personaId: request.selected[0]!.id, content, source: "lm", sourceIds: ["S1"] }];
    });
    await h.internals.runAmbient();
    expect(h.store.getRecent(channel.id, 10)).toHaveLength(2);
    expect(h.thread.research).toBeUndefined();
    expect(h.director.getAutonomousResearchDiagnostics().published).toBe(0);
    expect(h.internals.autonomousResearchLease).toBeUndefined();
    expect(h.internals.ambientPublicationReservations).toBe(0);
  });
});
