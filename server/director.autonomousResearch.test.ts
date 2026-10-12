import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import type { AmbientCapacitySnapshot } from "./ambientScheduling.js";
import { CHANNELS, type AutonomousResearchSeed } from "./channels.js";
import { SocialDirector, type AmbientThreadState } from "./director.js";
import type { GeneratedLine, SceneRequest } from "./lmStudio.js";
import { PERSONAS, type Persona } from "./personas.js";
import type { ResearchPacket } from "./researchBroker.js";
import { createMessage, RoomStore } from "./store.js";

const lead = { ...PERSONAS.find((persona) => persona.id === "ai-mira")!, canResearch: true };
const peer = { ...PERSONAS.find((persona) => persona.id === "ai-sana")!, canResearch: false };
const unrelated = { ...PERSONAS.find((persona) => persona.id === "ai-vale")!, canResearch: false };
const channel = CHANNELS.find((candidate) => candidate.id === "ai-programming")!;
const seed: AutonomousResearchSeed = {
  id: "source-opening-test", query: "agent recovery testing", mode: "web",
  discussionAngle: "What makes an agent recovery test convincing?",
};
const sourceUrl = "https://example.com/recovery";
const responseContent = "This test checks later state after a failed tool step. That feels much more useful than just scoring the final answer.";
const cleanups: Array<() => Promise<void>> = [];

const createHarness = async (available: Persona[], options: {
  generate?: (request: SceneRequest) => Promise<GeneratedLine[]>;
  health?: () => AmbientCapacitySnapshot;
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-research-opening-"));
  const store = new RoomStore(join(directory, "room.json"), { now: () => Date.now() });
  const actors = new ActorChannelRuntime(available);
  vi.spyOn(actors, "autonomousCandidatesFor").mockReturnValue(available);
  const generateScene = vi.fn(async (request: SceneRequest): Promise<GeneratedLine[]> => options.generate
    ? options.generate(request)
    : [{ personaId: request.selected[0]!.id, content: responseContent, source: "lm", sourceIds: ["S999"] }]);
  const research: ResearchPacket = {
    kind: "page", query: seed.query, retrievedAt: new Date().toISOString(),
    results: [{ id: "S1", title: "Recovery benchmark", url: sourceUrl,
      snippet: "The benchmark checks later state after a failed tool step." }],
  };
  const health = vi.fn(() => options.health?.() ?? { connected: true, queueDepth: 0 });
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    store,
    { health, generateScene, rememberDeliveredLine: vi.fn() } as never,
    actors, {} as never, {} as never, () => available, () => 1,
    { now: () => Date.now(), rng: () => 0.5, autonomousResearchEnabled: true,
      consideredConversationChance: 0, ambientTemporalCueChance: 0,
      behaviorTuningProvider: () => ({ activity: 60, autonomousLinkFrequency: 100, competence: 50, aggression: 25, explicitness: 50 }),
    },
  );
  const thread: AmbientThreadState = {
    seed: "unused", messageCount: 0, participantIds: [], debateBeat: false,
    languageHint: "en", openedAt: Date.now(), updatedAt: Date.now(),
  };
  const internals = director as unknown as {
    ambientThreads: Map<string, AmbientThreadState>;
    ambientPersonasInFlight: Map<string, symbol>;
    acquireAmbientPersonaLease: (id: string) => symbol | undefined;
    releaseAmbientPersonaLease: (id: string, token: symbol) => void;
    residentRelationshipSceneContext: (owners: Persona[], counterparts: Persona[], scope: unknown) => unknown;
    runAmbient: (workerId?: number) => Promise<void>;
    maybeRunAutonomousResearch: (
      now: number, globalTuning: unknown, waitingQueueDepth: number, lifecycleGeneration: number,
    ) => Promise<boolean>;
    runAutonomousResearchConversation: (
      room: typeof channel, epoch: number, candidates: Persona[], state: AmbientThreadState,
      researchSeed: AutonomousResearchSeed, prepared: { research: ResearchPacket },
    ) => Promise<boolean>;
  };
  internals.ambientThreads.set(channel.id, thread);
  const relationshipContext = vi.spyOn(internals, "residentRelationshipSceneContext");
  cleanups.push(async () => {
    director.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store, director, internals, thread, generateScene, relationshipContext, health,
    run: () => internals.runAutonomousResearchConversation(channel, 0, available, thread, seed, { research }),
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-11T14:00:00.000Z");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("single-resident autonomous source openings", () => {
  const spareCapacity: AmbientCapacitySnapshot = {
    connected: true, queueDepth: 2, activePredictions: 2, activeBackgroundPredictions: 2,
    maxConcurrentPredictions: 4, maxBackgroundPredictions: 3,
    effectiveMaxBackgroundPredictions: 3, foregroundDemandCount: 0,
  };
  const fullCapacity: AmbientCapacitySnapshot = {
    ...spareCapacity, queueDepth: 4, activePredictions: 4, activeBackgroundPredictions: 3,
  };

  it("publishes with a sole eligible researcher and retains server-owned source grounding", async () => {
    const harness = await createHarness([lead]);
    expect(await harness.run()).toBe(true);
    expect(harness.generateScene).toHaveBeenCalledTimes(1);
    expect(harness.generateScene.mock.calls[0]![0]).toMatchObject({
      selected: [{ id: lead.id }], mustReplyIds: [lead.id], responseRecoveryIds: [lead.id],
      conversationContext: { phase: "opening" }, urlPublicationPolicy: "server_card",
      evidenceOutcome: "succeeded", research: { results: [{ id: "S1", url: sourceUrl }] },
    });
    const messages = harness.store.getRecent(channel.id, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorId: lead.id, content: responseContent,
      sources: [{ title: "Recovery benchmark", url: sourceUrl }],
      linkPreview: { url: sourceUrl },
    });
    expect(harness.relationshipContext).toHaveBeenCalledWith([lead], [], { kind: "public", channelId: channel.id });
    expect(harness.thread.pendingBeat).toEqual({ kind: "research_response", attempts: 0 });
    expect(harness.internals.ambientPersonasInFlight.size).toBe(0);
    expect(harness.director.getAutonomousResearchDiagnostics()).toEqual({ attempts: 1, published: 1, failed: 0 });
  });

  it("does not reserve an unspeaking resident during source generation or release another room's lease", async () => {
    let finish: ((lines: GeneratedLine[]) => void) | undefined;
    const harness = await createHarness([lead, peer], {
      generate: () => new Promise((resolve) => { finish = resolve; }),
    });
    const pending = harness.run();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect([...harness.internals.ambientPersonasInFlight.keys()]).toEqual([lead.id]);
    const otherRoomLease = harness.internals.acquireAmbientPersonaLease(peer.id);
    expect(otherRoomLease).toBeDefined();
    finish!([{ personaId: lead.id, content: responseContent, source: "lm", sourceIds: ["S1"] }]);
    expect(await pending).toBe(true);
    expect(harness.internals.ambientPersonasInFlight.get(peer.id)).toBe(otherRoomLease);
    expect(harness.internals.ambientPersonasInFlight.has(lead.id)).toBe(false);
    harness.internals.releaseAmbientPersonaLease(peer.id, otherRoomLease!);
  });

  it("publishes the selected older peer target and offers that peer a return turn without changing the source card", async () => {
    const older = createMessage(channel.id, peer.id, "A final answer score seems enough to evaluate recovery.");
    const newer = createMessage(channel.id, unrelated.id, "The benchmark setup matters too.");
    const harness = await createHarness([lead, peer, unrelated], {
      generate: async () => [{
        personaId: lead.id, content: responseContent, source: "lm", sourceIds: ["S999"],
        replyToMessageId: older.id,
      }],
    });
    harness.store.addPublicMessage(older);
    harness.store.addPublicMessage(newer);
    expect(await harness.run()).toBe(true);
    const request = harness.generateScene.mock.calls[0]![0];
    expect(request.conversationContext?.publishedTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: older.id, authorId: peer.id }),
      expect.objectContaining({ messageId: newer.id, authorId: unrelated.id }),
    ]));
    const published = harness.store.getRecent(channel.id, 1)[0]!;
    expect(published).toMatchObject({
      authorId: lead.id, replyToId: older.id, replyPreview: { authorId: peer.id },
      sources: [{ title: "Recovery benchmark", url: sourceUrl }],
      linkPreview: { url: sourceUrl },
    });
    expect(harness.thread.replyOpportunity).toEqual({ afterMessageId: published.id, actorId: peer.id });
    expect(harness.thread.lastMessageId).toBe(published.id);
  });

  it("does not substitute a thread's last message when the source opening omits or invents a reply target", async () => {
    for (const replyToMessageId of [undefined, "unpublished-message"]) {
      const harness = await createHarness([lead, peer], {
        generate: async () => [{
          personaId: lead.id, content: responseContent, source: "lm", sourceIds: ["S1"],
          ...(replyToMessageId ? { replyToMessageId } : {}),
        }],
      });
      const previous = createMessage(channel.id, peer.id, "What should this benchmark measure?");
      harness.store.addPublicMessage(previous);
      harness.thread.lastMessageId = previous.id;
      harness.thread.lastAuthorId = peer.id;
      harness.thread.replyOpportunity = { afterMessageId: previous.id, actorId: peer.id };
      expect(await harness.run()).toBe(true);
      const published = harness.store.getRecent(channel.id, 1)[0]!;
      expect(published.replyToId).toBeUndefined();
      expect(published.replyPreview).toBeUndefined();
      expect(published).toMatchObject({
        authorId: lead.id, sources: [{ title: "Recovery benchmark", url: sourceUrl }],
        linkPreview: { url: sourceUrl },
      });
      expect(harness.thread.replyOpportunity).toBeUndefined();
    }
  });

  it("uses actual recent room authors as relationship context even when they are currently busy", async () => {
    const harness = await createHarness([lead, peer, unrelated]);
    harness.store.addPublicMessage(createMessage("lobby", unrelated.id, "A different room's conversation."));
    harness.store.addPublicMessage(createMessage(channel.id, peer.id, "Recovery should preserve the tool state too."));
    harness.store.addPublicMessage(createMessage(channel.id, "human-source-reader", "That is a useful test."));
    const busyPeerLease = harness.internals.acquireAmbientPersonaLease(peer.id)!;
    const unrelatedLease = harness.internals.acquireAmbientPersonaLease(unrelated.id)!;
    expect(await harness.run()).toBe(true);
    expect(harness.relationshipContext).toHaveBeenCalledWith(
      [lead], [expect.objectContaining({ id: peer.id })], { kind: "public", channelId: channel.id },
    );
    expect(harness.internals.ambientPersonasInFlight.get(peer.id)).toBe(busyPeerLease);
    expect(harness.internals.ambientPersonasInFlight.get(unrelated.id)).toBe(unrelatedLease);
    expect(harness.thread.pendingBeat?.preferredActorId).toBeUndefined();
  });

  it("releases only its speaker lease when a reviewed source opening produces no publishable line", async () => {
    const harness = await createHarness([lead, peer], { generate: async () => [] });
    const peerLease = harness.internals.acquireAmbientPersonaLease(peer.id)!;
    expect(await harness.run()).toBe(false);
    expect(harness.store.getRecent(channel.id, 10)).toEqual([]);
    expect(harness.internals.ambientPersonasInFlight.has(lead.id)).toBe(false);
    expect(harness.internals.ambientPersonasInFlight.get(peer.id)).toBe(peerLease);
    expect(harness.director.getAutonomousResearchDiagnostics()).toMatchObject({
      attempts: 1, published: 0, failed: 1,
      lastFailure: { reason: "invalid_generated_lines", channelId: channel.id, seedId: seed.id },
    });
  });

  it("allows a source opening while other background predictions run if a model slot is free", async () => {
    const harness = await createHarness([lead], { health: () => spareCapacity });
    expect(await harness.run()).toBe(true);
    expect(harness.generateScene).toHaveBeenCalledTimes(1);
    expect(harness.store.getRecent(channel.id, 10)).toHaveLength(1);
    expect(harness.director.getAutonomousResearchDiagnostics()).toMatchObject({
      attempts: 1, published: 1, failed: 0,
    });
  });

  it("defers before generation when the model has no free prediction capacity", async () => {
    const harness = await createHarness([lead], { health: () => fullCapacity });
    await expect(harness.run()).rejects.toThrow("publication gates changed");
    expect(harness.generateScene).not.toHaveBeenCalled();
    expect(harness.store.getRecent(channel.id, 10)).toEqual([]);
    expect(harness.internals.ambientPersonasInFlight.size).toBe(0);
    expect(harness.store.getAutonomousPublicationBudget()).toBeUndefined();
    expect(harness.director.getAutonomousResearchDiagnostics()).toMatchObject({
      attempts: 1, published: 0, failed: 0,
    });
  });

  it("publishes an already reviewed source even if another job takes the final model slot", async () => {
    let capacity = spareCapacity;
    const harness = await createHarness([lead], {
      health: () => capacity,
      generate: async () => {
        capacity = fullCapacity;
        return [{ personaId: lead.id, content: responseContent, source: "lm", sourceIds: ["S1"] }];
      },
    });
    expect(await harness.run()).toBe(true);
    expect(harness.generateScene).toHaveBeenCalledTimes(1);
    expect(harness.store.getRecent(channel.id, 1)[0]).toMatchObject({
      authorId: lead.id, content: responseContent, linkPreview: { url: sourceUrl },
    });
    expect(harness.store.getAutonomousPublicationBudget()?.tokens).toBe(3);
    expect(harness.internals.ambientPersonasInFlight.size).toBe(0);
  });

  it("still rejects a reviewed source when same-room human activity invalidated its turn", async () => {
    let capacity = spareCapacity;
    const harness = await createHarness([lead], {
      health: () => capacity,
      generate: async () => {
        capacity = fullCapacity;
        harness.director.noteHumanVoiceActivity(channel.id);
        return [{ personaId: lead.id, content: responseContent, source: "lm", sourceIds: ["S1"] }];
      },
    });
    await expect(harness.run()).rejects.toThrow("publication gates changed");
    expect(harness.generateScene).toHaveBeenCalledTimes(1);
    expect(harness.store.getRecent(channel.id, 10)).toEqual([]);
    expect(harness.store.getAutonomousPublicationBudget()).toBeUndefined();
    expect(harness.internals.ambientPersonasInFlight.size).toBe(0);
  });

  it("passes waiting queue depth to research admission instead of counting active parallel work as queued", async () => {
    const harness = await createHarness([lead], { health: () => spareCapacity });
    const maybeResearch = vi.spyOn(harness.internals, "maybeRunAutonomousResearch").mockResolvedValue(true);
    await harness.internals.runAmbient(0);
    expect(maybeResearch).toHaveBeenCalledTimes(1);
    expect(maybeResearch.mock.calls[0]![2]).toBe(0);
    expect(harness.generateScene).not.toHaveBeenCalled();
  });
});
