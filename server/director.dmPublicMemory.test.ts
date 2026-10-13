import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Member } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import type { SceneRequest } from "./lmStudio.js";
import { PERSONAS } from "./personas.js";
import { createFailClosedTurnAnalysis, type TurnAnalysisInput } from "./semanticRouter.js";
import { SocialMemoryStore } from "./socialMemory.js";
import { SocialMemoryCoordinator } from "./socialMemoryCoordinator.js";
import { RoomStore } from "./store.js";

const member = (id: string, name: string): Member => ({
  id, name, kind: "human", status: "online", avatar: { color: "#123", accent: "#456", glyph: name[0]! },
});
const asker = member("human-alex", "Alex");
const subject = member("human-lumi", "Lumi");
const secret = member("human-private-only", "Private Only");
const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const setup = async (options: { legacyNote?: string | null } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-dm-public-memory-"));
  const store = new RoomStore(join(directory, "rooms.json"));
  const memory = new SocialMemoryStore({ filePath: ":memory:" });
  const coordinator = new SocialMemoryCoordinator({
    analyzeSocialEpisode: async () => ({ source: "lm", failureReason: null, events: [] }),
  }, memory);
  let profiles = [asker, subject, secret];
  let referenceIds = [subject.id];
  let confidence = 0.99;
  let duringRouting = () => {};
  let duringGeneration: () => void | Promise<void> = () => {};
  const analyzeTurn = vi.fn(async (_input: TurnAnalysisInput) => {
    duringRouting();
    const base = createFailClosedTurnAnalysis("disabled");
    return {
      ...base, source: "lm" as const, failureReason: null,
      intent: { ...base.intent, isQuestion: true, kind: "question" as const, replyExpected: "expected" as const, confidence: 0.99 },
      referencedHumanIds: referenceIds, referencedHumanConfidence: confidence,
    };
  });
  const generateScene = vi.fn(async (_scene: SceneRequest) => {
    await duringGeneration();
    return [{ personaId: mira.id, content: "A reviewed test reply.", source: "lm" as const, sourceIds: [] }];
  });
  const director = new SocialDirector(
    { to: () => ({ emit: vi.fn() }) } as never, store,
    { analyzeTurn, generateScene, rememberDeliveredLine: vi.fn() } as never,
    new ActorChannelRuntime(), { research: vi.fn(), researchSite: vi.fn() } as never,
    {
      listProfiles: () => profiles.map((entry) => ({ member: entry })),
      promptNote: () => options.legacyNote === null ? undefined : options.legacyNote ?? "CURRENT ASKER PRIVATE ORIENTATION", getRelation: () => undefined,
      updateRelation: vi.fn(),
    } as never,
    () => [asker, subject, ...PERSONAS], () => 1,
    {
      dmDebounceMs: 0, weatherForecastProvider: null, socialMemory: coordinator,
      pageReader: { collectCandidates: () => ({ requestedAt: new Date().toISOString(), candidates: [] }) } as never,
    },
  );
  const addPublic = (withWitness = true) => {
    const time = Date.now() - 60_000;
    const first: ChatMessage = {
      id: "public-subject", channelId: "pingu", authorId: subject.id,
      content: "I finally found the scarf plushie I wanted.", createdAt: new Date(time).toISOString(), reactions: [],
      authorSnapshot: subject,
    };
    store.addPublicMessage(first);
    if (withWitness) store.addPublicMessage({
      ...first, id: "public-mira", authorId: mira.id, authorSnapshot: undefined,
      content: "The wonky scarf is the best part!", replyToId: first.id,
      createdAt: new Date(time + 1_000).toISOString(),
    });
  };
  const remember = (visibility: "public" | "dm" | "voice", person = subject, ownerId = mira.id, sourceActorId = person.id) => {
    const id = `${visibility}-${person.id}-${ownerId}`;
    memory.recordEvent({
      id, kind: "humor", origin: "human",
      scope: visibility === "public" ? { kind: "public", channelId: "pingu" }
        : visibility === "dm" ? { kind: "dm", threadId: "other-private-thread", participantIds: [person.id, ownerId] }
          : { kind: "voice", roomId: "private-voice", participantIds: [person.id, ownerId] },
      sourceMessageIds: [`source-${id}`], actorIds: [sourceActorId], subjectIds: [person.id], witnessIds: [ownerId],
      occurredAt: Date.now() - 50_000, summary: "Synthetic memory.", salience: 0.9, confidence: 0.99,
      memoryViews: [{ id: `memory-${id}`, ownerId, subjectIds: [person.id], perspective: visibility === "public"
        ? "Lumi showed me a wonky scarf plushie in the public Pingu room and I found it endearing."
        : `PRIVATE-${visibility}-SECRET`, salience: visibility === "public" ? 0.7 : 1, confidence: 0.99 }],
    });
  };
  const run = async (text = "Vad tycker du om Lumi?") => {
    const thread = store.openDm(asker.id, mira.id);
    const message = store.addDmMessage(thread.id, asker.id, text)!;
    await director.onDirectMessage(message, asker, mira);
    return { scene: generateScene.mock.calls.at(-1)?.[0], messages: store.getDmMessages(thread.id) };
  };
  cleanups.push(async () => { director.stop(); await store.flush(); memory.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    director, store, memory, coordinator, analyzeTurn, generateScene, addPublic, remember, run,
    setReference: (ids: string[], certainty = 0.99) => { referenceIds = ids; confidence = certainty; },
    setProfiles: (next: Member[]) => { profiles = next; },
    duringRouting: (callback: () => void) => { duringRouting = callback; },
    duringGeneration: (callback: () => void | Promise<void>) => { duringGeneration = callback; },
  };
};

describe("DM third-person public continuity through the director", () => {
  it("includes an online third person, their witnessed public exchange and own public memory without replacing the asker context", async () => {
    const f = await setup(); f.addPublic(); f.remember("public"); f.remember("dm"); f.remember("voice"); f.remember("dm", secret);
    const { scene } = await f.run();
    expect(f.analyzeTurn.mock.calls[0]![0].humanCandidates).toEqual([{ id: subject.id, displayLabel: subject.name }]);
    expect(f.analyzeTurn.mock.calls[0]![0]).toMatchObject({
      publicParticipantRecallAvailable: true, historyRecallAvailable: false,
    });
    expect(scene?.history.at(-1)?.content).toBe("Vad tycker du om Lumi?");
    expect(scene?.relationshipNotes?.[mira.id]).toContain("CURRENT ASKER PRIVATE ORIENTATION");
    expect(scene?.publicParticipantNotes?.[mira.id]).toContain("wonky scarf plushie");
    expect(scene?.roomRecall?.sourceChannel).toEqual({ id: "pingu", name: "pingu" });
    expect(scene?.roomRecall?.witnessPersonaIds).toEqual([mira.id]);
    expect(scene?.roomRecall?.transcript.map((row) => row.content)).toEqual([
      "I finally found the scarf plushie I wanted.", "The wonky scarf is the best part!",
    ]);
    expect(JSON.stringify(scene)).not.toContain("PRIVATE-dm-SECRET");
    expect(JSON.stringify(scene)).not.toContain("PRIVATE-voice-SECRET");
    expect(scene?.requestOwnerIds).toEqual([mira.id]);
  });

  it("recalls an owned public memory after original public rows are no longer retained", async () => {
    const f = await setup(); f.remember("public"); f.remember("dm", secret);
    const { scene } = await f.run();
    expect(scene?.publicParticipantNotes?.[mira.id]).toContain("wonky scarf plushie");
    expect(scene?.roomRecall).toBeUndefined();
    expect(f.analyzeTurn.mock.calls[0]![0].humanCandidates).toEqual([{ id: subject.id, displayLabel: subject.name }]);
  });

  it.each(["unknown", "low confidence", "ambiguous", "unrelated"])("does not retrieve a third party for %s routing", async (variant) => {
    const f = await setup(); f.addPublic(); f.remember("public");
    if (variant === "unknown") f.setReference(["unknown-person"]);
    if (variant === "low confidence") f.setReference([subject.id], 0.4);
    if (variant === "ambiguous") f.setProfiles([asker, subject, member("human-other-lumi", "LUMI")]);
    if (variant === "unrelated") f.setReference([]);
    const { scene } = await f.run();
    expect(scene?.publicParticipantNotes).toEqual({});
    expect(scene?.roomRecall).toBeUndefined();
  });

  it("does not borrow another resident's memory or claim an unwitnessed public encounter", async () => {
    const f = await setup(); f.addPublic(false); f.remember("public", subject, "ai-juno");
    const { scene } = await f.run();
    expect(scene?.publicParticipantNotes).toEqual({});
    expect(scene?.roomRecall).toBeUndefined();
  });

  it("drops a deleted identity after routing and a reset identity during generation", async () => {
    const deleted = await setup(); deleted.addPublic(); deleted.remember("public");
    deleted.duringRouting(() => deleted.setProfiles([asker]));
    const { scene } = await deleted.run();
    expect(scene?.publicParticipantNotes).toEqual({});
    expect(scene?.roomRecall).toBeUndefined();

    const reset = await setup(); reset.addPublic(); reset.remember("public");
    reset.duringGeneration(() => reset.director.resetHumanMemoryWork(subject.id));
    const result = await reset.run();
    expect(result.messages.map((message) => message.authorId)).toEqual([asker.id]);
  });

  it("excludes a retiring identity while profile deletion is still in progress", async () => {
    const f = await setup(); f.addPublic(); f.remember("public");
    // Identity retirement invalidates work before the asynchronous durable
    // erase removes its profile and public rows. A new turn must not capture
    // that already-advanced epoch as permission to reuse the old evidence.
    f.director.invalidatePublicWorkForHumanActor(subject.id);
    const { scene } = await f.run();
    expect(f.analyzeTurn.mock.calls[0]![0].humanCandidates).toEqual([]);
    expect(scene?.publicParticipantNotes).toEqual({});
    expect(scene?.roomRecall).toBeUndefined();
  });

  it("does not publish a generated reply after the referenced identity retires", async () => {
    const f = await setup(); f.addPublic(); f.remember("public");
    f.duringGeneration(() => f.director.invalidatePublicWorkForHumanActor(subject.id));
    const result = await f.run();
    expect(result.messages.map((message) => message.authorId)).toEqual([asker.id]);
  });

  it("does not publish a copied public memory after another source actor is erased", async () => {
    const f = await setup();
    f.remember("public", subject, mira.id, "human-event-source");
    f.duringGeneration(async () => { await f.coordinator.forgetActor("human-event-source"); });
    const result = await f.run();
    expect(result.scene?.publicParticipantNotes?.[mira.id]).toContain("wonky scarf plushie");
    expect(f.memory.listMemories({ ownerId: mira.id })).toEqual([]);
    expect(result.messages.map((message) => message.authorId)).toEqual([asker.id]);
  });

  it("keeps a memory-free DM reply when an unrelated actor is erased", async () => {
    const f = await setup({ legacyNote: null });
    f.setReference([]);
    f.duringGeneration(async () => { await f.coordinator.forgetActor("human-unrelated"); });
    const result = await f.run("Hello again!");
    expect(result.scene?.publicParticipantNotes).toEqual({});
    expect(result.messages.map((message) => message.authorId)).toEqual([asker.id, mira.id]);
  });
});
