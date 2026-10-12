import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector, type AmbientThreadState } from "./director.js";
import type { GeneratedLine, SceneRequest } from "./lmStudio.js";
import { PERSONAS } from "./personas.js";
import { createMessage, RoomStore } from "./store.js";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T16:00:00.000Z")); });
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

const setup = async (target: "older" | "own" | "foreign" | "unknown" | "none") => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-peer-reply-"));
  let now = Date.now();
  let random = 0.1;
  const [mira, bosse, juno] = ["ai-mira", "ai-bosse", "ai-juno"].map((id) => ({
    ...PERSONAS.find((persona) => persona.id === id)!, cooldownMs: 0,
  }));
  const residents = [mira!, bosse!, juno!];
  const store = new RoomStore(join(directory, "room.json"));
  const own = createMessage("lobby", mira!.id, "I'd split the bill evenly.", { createdAt: new Date(now - 60_000).toISOString() });
  const challenged = createMessage("lobby", bosse!.id, "Even if I only had water and you ordered six cocktails?", { createdAt: new Date(now - 50_000).toISOString() });
  const latest = createMessage("lobby", juno!.id, "That sounds like an expensive glass of water.", { createdAt: new Date(now - 40_000).toISOString(), replyToId: challenged.id });
  const foreign = createMessage("the-pub", bosse!.id, "This belongs to another conversation.");
  for (const row of [own, challenged, latest, foreign]) store.addPublicMessage(row);
  const targetId = { older: challenged.id, own: own.id, foreign: foreign.id, unknown: "made-up", none: undefined }[target];
  const actors = new ActorChannelRuntime(residents);
  const candidates = vi.spyOn(actors, "autonomousCandidatesFor").mockReturnValue([mira!]);
  const generateScene = vi.fn(async (request: SceneRequest): Promise<GeneratedLine[]> => [{
    personaId: request.selected[0]!.id, source: "lm", sourceIds: [],
    content: generateScene.mock.calls.length === 1
      ? "Fair point, Bosse. I meant when we ordered roughly the same, not that you should sponsor my cocktails."
      : "Then we agree about the expensive bit. I can live with rounding off a little.",
    ...(generateScene.mock.calls.length === 1 && targetId ? { replyToMessageId: targetId } : {}),
  }]);
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never, store,
    { health: vi.fn(() => ({ connected: true, queueDepth: 0 })), generateScene, rememberDeliveredLine: vi.fn() } as never,
    actors, {} as never, {} as never, () => residents, () => 1,
    {
      now: () => now, rng: () => random, autonomousResearchEnabled: false, ambientTemporalCueChance: 0,
      behaviorTuningProvider: (id) => ({ activity: !id || id === "lobby" ? 50 : 0, competence: 50, aggression: 25, explicitness: 50 }),
    },
  );
  const internals = director as unknown as { runAmbient: () => Promise<void>; ambientThreads: Map<string, AmbientThreadState> };
  const thread: AmbientThreadState = {
    seed: "Discuss the actual bill-splitting disagreement.", origin: "human_topic", causalRootId: own.id,
    messageCount: 3, lastMessageId: latest.id, lastAuthorId: latest.authorId,
    participantIds: residents.map((persona) => persona.id), debateBeat: false, languageHint: "en",
    openedAt: now - 60_000, updatedAt: now - 40_000,
  };
  internals.ambientThreads.set("lobby", thread);
  cleanup.push(async () => { director.stop(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return { store, internals, thread, generateScene, challenged, latest, own, candidates, residents,
    advance: () => { now += 40_000; },
    setRandom: (value: number) => { random = value; },
  };
};

describe("resident-owned reply targets", () => {
  it("publishes the chosen earlier target and offers its author a chance to respond", async () => {
    const h = await setup("older");
    await h.internals.runAmbient();
    const posted = h.store.getRecent("lobby", 1)[0]!;
    expect(posted.replyToId).toBe(h.challenged.id);
    expect(posted.replyToId).not.toBe(h.latest.id);
    expect(h.thread.replyOpportunity).toEqual({ afterMessageId: posted.id, actorId: h.challenged.authorId });
    const context = h.generateScene.mock.calls[0]![0].conversationContext!;
    expect(context.publishedTurns.find((row) => row.messageId === h.latest.id))
      .toMatchObject({ authorId: h.latest.authorId, replyToMessageId: h.challenged.id });
    h.candidates.mockReturnValue(h.residents);
    h.advance();
    await h.internals.runAmbient();
    expect(h.generateScene.mock.calls[1]![0].selected[0]?.id).toBe(h.challenged.authorId);
    expect(h.generateScene.mock.calls[1]![0].mustReplyIds).toEqual([]);
    expect(h.thread.replyOpportunity).toBeUndefined();
  });

  it("gives other residents a real opening instead of stacking returning-speaker bonuses", async () => {
    const h = await setup("older");
    await h.internals.runAmbient();
    expect(h.thread.replyOpportunity?.actorId).toBe(h.challenged.authorId);
    h.candidates.mockReturnValue(h.residents);
    h.setRandom(0.99);
    h.advance();
    await h.internals.runAmbient();
    expect(h.generateScene.mock.calls[1]![0].selected[0]?.id).toBe(h.latest.authorId);
    expect(h.generateScene.mock.calls[1]![0].mustReplyIds).toEqual([]);
  });

  it.each(["own", "foreign", "unknown", "none"] as const)("does not turn %s targets into a fabricated reply or scheduling preference", async (target) => {
    const h = await setup(target);
    await h.internals.runAmbient();
    const posted = h.store.getRecent("lobby", 1)[0]!;
    expect(posted.id).not.toBe(h.latest.id);
    expect(posted.replyToId).toBeUndefined();
    expect(h.thread.replyOpportunity).toBeUndefined();
  });

  it("does not infer a preferred speaker from a legacy automatically linked reply", async () => {
    const h = await setup("none");
    expect(h.latest.replyToId).toBe(h.challenged.id);
    await h.internals.runAmbient();
    expect(h.generateScene.mock.calls[0]![0].selected[0]?.id).toBe(h.own.authorId);
    expect(h.thread.replyOpportunity).toBeUndefined();
  });
});
