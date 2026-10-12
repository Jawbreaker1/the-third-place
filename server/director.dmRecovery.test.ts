import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import { HumanMemoryStore } from "./humanMemory.js";
import { PERSONAS } from "./personas.js";
import { createFailClosedTurnAnalysis } from "./semanticRouter.js";
import { RoomStore } from "./store.js";

const human = {
  id: "human-dm-recovery", name: "Returning visitor", kind: "human" as const, status: "offline" as const,
  avatar: { color: "#123456", accent: "#654321", glyph: "R" },
};
const persona = PERSONAS.find((candidate) => candidate.id === "ai-mira")!;
const directors: SocialDirector[] = [];
afterEach(() => { for (const director of directors.splice(0)) director.stop(); });

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-dm-recovery-"));
  const roomPath = join(directory, "rooms.json");
  const humanMemory = new HumanMemoryStore({ filePath: join(directory, "humans.json"), persistDelayMs: 60_000 });
  await humanMemory.load();
  humanMemory.upsertProfile({ member: human });
  await humanMemory.flush();
  const store = new RoomStore(roomPath);
  await store.load();
  const thread = store.openDm(human.id, persona.id);
  return { store, roomPath, humanMemory, thread };
};

const makeDirector = (store: RoomStore, humanMemory: HumanMemoryStore, generation?: ReturnType<typeof vi.fn>) => {
  const generateScene = generation ?? vi.fn(async () => [{
    personaId: persona.id, content: "I picked up both questions.", source: "lm" as const, sourceIds: [],
  }]);
  const analysis = createFailClosedTurnAnalysis("disabled");
  const enqueueDeliveredEpisode = vi.fn(async () => ({ status: "no_events", episodeId: "test", eventIds: [], createdEventIds: [] }));
  const emit = vi.fn();
  const director = new SocialDirector(
    { to: () => ({ emit }) } as never,
    store,
    {
      analyzeTurn: vi.fn(async () => ({
        ...analysis,
        source: "lm", failureReason: null,
        intent: { ...analysis.intent, kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.99 },
      })),
      generateScene,
      rememberDeliveredLine: vi.fn(),
    } as never,
    new ActorChannelRuntime(),
    { research: vi.fn(), researchSite: vi.fn() } as never,
    humanMemory,
    // The human is offline: restart recovery must use the trusted durable profile.
    () => PERSONAS,
    () => 0,
    {
      dmDebounceMs: 0,
      weatherForecastProvider: null,
      pageReader: { collectCandidates: () => ({ requestedAt: new Date().toISOString(), candidates: [] }) } as never,
      socialMemory: {
        promptNote: () => undefined,
        behaviorProjection: () => undefined,
        enqueueDeliveredEpisode,
      } as never,
    },
  );
  directors.push(director);
  return { director, generateScene, enqueueDeliveredEpisode, emit };
};

describe("director durable DM recovery", () => {
  it("batches only explicitly marked rows after restart and never replays a settled reply", async () => {
    const { store, roomPath, humanMemory, thread } = await fixture();
    store.addDmMessage(thread.id, human.id, "An old, unmarked message.");
    const first = await store.addDmMessageDurably(thread.id, human.id, "First pending question", { pendingResidentId: persona.id });
    const second = await store.addDmMessageDurably(thread.id, human.id, "Second pending question", { pendingResidentId: persona.id });
    const restarted = new RoomStore(roomPath);
    await restarted.load();
    const { director, generateScene, enqueueDeliveredEpisode } = makeDirector(restarted, humanMemory);
    expect(director.recoverPendingDirectTurns()).toBe(2);
    expect(director.recoverPendingDirectTurns()).toBe(0);
    await vi.waitFor(() => expect(restarted.getDmMessages(thread.id).filter((message) => message.authorId === persona.id)).toHaveLength(1));
    expect(generateScene).toHaveBeenCalledOnce();
    const request = generateScene.mock.calls[0]![0] as { trigger: { content: string } };
    expect(request.trigger.content).toContain(first!.content);
    expect(request.trigger.content).toContain(second!.content);
    expect(request.trigger.content).not.toContain("An old, unmarked message.");
    expect(enqueueDeliveredEpisode).toHaveBeenCalledOnce();
    expect(restarted.listPendingDirectTurns()).toEqual([]);
    await restarted.flush();
    director.stop();
    const nextRestart = new RoomStore(roomPath);
    await nextRestart.load();
    const next = makeDirector(nextRestart, humanMemory);
    expect(next.director.recoverPendingDirectTurns()).toBe(0);
    expect(next.generateScene).not.toHaveBeenCalled();
  });

  it("cancels a pre-reset private generation and its durable obligation without reviving old memory", async () => {
    const { store, roomPath, humanMemory, thread } = await fixture();
    const message = await store.addDmMessageDurably(thread.id, human.id, "Please remember this old detail", { pendingResidentId: persona.id });
    let finishOld!: (lines: unknown) => void;
    const generateScene = vi.fn(() => new Promise((resolve) => { finishOld = resolve; }));
    const { director, enqueueDeliveredEpisode } = makeDirector(store, humanMemory, generateScene);
    expect(director.recoverPendingDirectTurns()).toBe(1);
    await vi.waitFor(() => expect(generateScene).toHaveBeenCalledOnce());
    director.resetHumanMemoryWork(human.id);
    humanMemory.resetRememberedDetails(human.id);
    await store.flush();
    finishOld([{ personaId: persona.id, content: "A stale response after reset", source: "lm", sourceIds: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getDmMessages(thread.id).map((entry) => entry.id)).toEqual([message!.id]);
    expect(enqueueDeliveredEpisode).not.toHaveBeenCalled();
    expect(store.listPendingDirectTurns()).toEqual([]);
    const restarted = new RoomStore(roomPath);
    await restarted.load();
    expect(restarted.listPendingDirectTurns()).toEqual([]);

    generateScene.mockResolvedValueOnce([{ personaId: persona.id, content: "A fresh answer", source: "lm", sourceIds: [] }]);
    const later = await store.addDmMessageDurably(thread.id, human.id, "A genuinely new question", { pendingResidentId: persona.id });
    await director.onDirectMessage(later!, human, persona);
    expect(store.getDmMessages(thread.id).at(-1)?.content).toBe("A fresh answer");
    expect(enqueueDeliveredEpisode).toHaveBeenCalledOnce();
    await store.flush();
    await humanMemory.flush();
  });
});
