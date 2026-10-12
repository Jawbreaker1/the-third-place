import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Member } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector, type AmbientThreadState } from "./director.js";
import type { GeneratedLine, SceneRequest } from "./lmStudio.js";
import { PERSONAS } from "./personas.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis } from "./semanticRouter.js";
import { createMessage, RoomStore } from "./store.js";

const residents = ["ai-mira", "ai-sana", "ai-vale"].map((id) => PERSONAS.find((resident) => resident.id === id)!);
const human: Member = {
  id: "human-conversation-flow", name: "Alex", kind: "human", status: "online",
  avatar: { color: "#123", accent: "#456", glyph: "A" },
};
const anotherHuman: Member = { ...human, id: "human-conversation-flow-second", name: "Bea" };
const primaryContent = "I'd pick the late screening. The quiet walk home is half the fun.";
const optionalContents = [
  "Wait, which cinema stays open that late? The one near me closes annoyingly early.",
  "The riverside cinema does midnight shows on Fridays. Their tiny screen upstairs is my favorite.",
];

const analysisFor = (addressedIds: string[] = []): TurnAnalysis => ({
  ...createFailClosedTurnAnalysis("disabled"),
  source: "lm", failureReason: null,
  language: { tag: "en", confidence: 0.99 },
  intent: { kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.99 },
  personas: {
    addressedIds, requestedReplyIds: addressedIds, relevantIds: residents.map((resident) => resident.id),
    addressConfidence: addressedIds.length ? 0.99 : 0, relevanceConfidence: 0.99,
  },
  social: {
    warmth: 0.2, hostility: 0, playfulness: 0, absurdity: 0, urgency: 0,
    energy: 0.3, pileOnRisk: 0, claimStrength: 0, confidence: 0.99,
  },
  moderation: { risk: "none", action: "none", categories: [], confidence: 0.99 },
  capabilities: {
    discussed: [], requestKind: "none", asksAboutAcoustics: false, asksAboutAiIdentity: false,
    asksForList: false, confidence: 0.99,
  },
  evidence: {
    need: "none", action: "none", confidence: 0.99, goal: null, query: null, urlRef: null,
    searchMode: null, timeZone: null, timeKind: null, locationLabel: null,
  },
});

const lineFor = (request: SceneRequest, content: string): GeneratedLine => ({
  personaId: request.selected[0]!.id, content, source: "lm", sourceIds: [],
});

type GenerationFrame = { request: SceneRequest; committed: ChatMessage[] };
const cleanups: Array<() => Promise<void>> = [];

const createHarness = async (options: {
  addressedIds?: string[];
  generate?: (request: SceneRequest, frame: number) => Promise<GeneratedLine[]> | GeneratedLine[];
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-conversation-flow-"));
  const store = new RoomStore(join(directory, "room.json"), { now: () => Date.now() });
  const actors = new ActorChannelRuntime(residents);
  vi.spyOn(actors, "candidatesFor").mockReturnValue(residents);
  vi.spyOn(actors, "promptNotes").mockImplementation((selected) => Object.fromEntries(
    selected.map((resident) => [resident.id, `PRIVATE_CHANNEL_${resident.id}`]),
  ));
  vi.spyOn(actors, "expertiseNotes").mockImplementation((selected) => Object.fromEntries(
    selected.map((resident) => [resident.id, `PRIVATE_EXPERTISE_${resident.id}`]),
  ));
  const frames: GenerationFrame[] = [];
  const generateScene = vi.fn(async (request: SceneRequest): Promise<GeneratedLine[]> => {
    frames.push({ request, committed: store.getAllMessages().map((message) => ({ ...message })) });
    return await (options.generate?.(request, frames.length - 1) ??
      (request.conversationContext ? [] : [lineFor(request, primaryContent)]));
  });
  const analyzeTurn = vi.fn(async () => analysisFor(options.addressedIds));
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    store,
    {
      analyzeTurn, generateScene, rememberDeliveredLine: vi.fn(),
      health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
    } as never,
    actors,
    { research: vi.fn(), researchSite: vi.fn() } as never,
    {
      getRelation: vi.fn(() => undefined), updateRelation: vi.fn(),
      promptNote: vi.fn((_humanId: string, residentId: string) => `PRIVATE_RELATION_${residentId}`),
      listProfiles: vi.fn(() => []), listRestorableProfiles: vi.fn(() => []),
      noteClassifiedMemoryFact: vi.fn(),
    } as never,
    () => [human, anotherHuman, ...residents],
    () => 2,
    {
      now: () => Date.now(), rng: () => 0.99,
      pageReader: {
        collectCandidates: vi.fn(() => ({ requestedAt: new Date().toISOString(), candidates: [] })),
      } as never,
      weatherForecastProvider: null,
    },
  );
  const internals = director as unknown as {
    ambientThreads: Map<string, AmbientThreadState>;
    noteHumanChannelEvent: (message: ChatMessage) => void;
    handleHumanBurst: (
      messages: ChatMessage[], member: Member, visual?: undefined,
      claims?: Array<{
        messageId: string; channelId: string; authorId: string; deliveryKind: "direct";
        personaId: string; attempt: number;
      }>, actorEpoch?: number, recovering?: boolean,
    ) => Promise<void>;
  };
  cleanups.push(async () => {
    director.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const addHuman = (content: string, channelId = "lobby", author = human) => {
    const message = createMessage(channelId, author.id, content, { authorSnapshot: { ...author, status: "offline" } });
    store.addPublicMessage(message);
    internals.noteHumanChannelEvent(message);
    return message;
  };
  return { director, store, actors, frames, generateScene, analyzeTurn, internals, addHuman };
};

const settle = async (pending: Promise<void>): Promise<void> => {
  let complete = false;
  void pending.then(() => { complete = true; }, () => { complete = true; });
  await vi.waitFor(() => expect(complete).toBe(true), { timeout: 4_000, interval: 20 });
  await pending;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T14:00:00.000Z"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("published public conversation flow", () => {
  it("publishes the primary before considering peers and scopes every peer to its own private context", async () => {
    const h = await createHarness({
      generate: (request, frame) => frame < 2
        ? [lineFor(request, frame === 0 ? primaryContent : optionalContents[0]!)]
        : [],
    });
    const incoming = h.addHuman("Which screening should we choose?\nI'd rather avoid another rushed evening.");
    await settle(h.internals.handleHumanBurst([incoming], human));

    expect(h.frames).toHaveLength(3);
    const primary = h.store.getAllMessages().find((message) => message.content === primaryContent)!;
    expect(primary).toBeDefined();
    expect(h.frames[0]!.request.conversationContext).toBeUndefined();
    expect(h.frames[0]!.committed.map((message) => message.id)).toEqual([incoming.id]);
    const peer = h.frames[1]!;
    expect(peer.committed).toContainEqual(expect.objectContaining({ id: primary.id, content: primaryContent }));
    expect(peer.request.trigger).toMatchObject({
      authorId: primary.authorId, authorKind: "ai", messageId: primary.id, content: primaryContent,
    });
    expect(peer.request.conversationContext).toMatchObject({
      phase: "continuation", rootMessageId: incoming.id, latestMessageId: primary.id,
      publishedTurns: expect.arrayContaining([
        expect.objectContaining({ messageId: primary.id, content: primaryContent }),
      ]),
    });
    expect(peer.request.history).toContainEqual(expect.objectContaining({ content: primaryContent }));
    expect(peer.request.mustReplyIds).toEqual([]);
    expect(peer.request.requestOwnerIds).toEqual([]);
    expect(peer.request.publicSiblingDrafts).toBeUndefined();
    expect(peer.request.semanticContext?.replyExpected).toBe("optional");
    for (const { request } of h.frames) {
      const actorId = request.selected[0]!.id;
      expect(request.selected).toHaveLength(1);
      for (const record of [request.relationshipNotes, request.relationshipStylePlans,
        request.actorChannelNotes, request.actorExpertiseNotes, request.romanticInteractionPolicies]) {
        expect(Object.keys(record ?? {}).every((id) => id === actorId)).toBe(true);
      }
      for (const other of residents.filter((resident) => resident.id !== actorId)) {
        for (const prefix of ["PRIVATE_RELATION_", "PRIVATE_CHANNEL_", "PRIVATE_EXPERTISE_"]) {
          expect(JSON.stringify(request)).not.toContain(`${prefix}${other.id}`);
        }
      }
    }
    const publishedPeer = h.store.getAllMessages().find((message) => message.content === optionalContents[0]);
    expect(publishedPeer?.replyToId).toBe(primary.id);
  });

  it.each([0, 1, 2])("allows %i optional contributions without enforcing a two-reply quota", async (contributions) => {
    const h = await createHarness({
      generate: (request, frame) => frame === 0
        ? [lineFor(request, primaryContent)]
        : frame <= contributions ? [lineFor(request, optionalContents[frame - 1]!)] : [],
    });
    const incoming = h.addHuman("Which film night would you choose?");
    await settle(h.internals.handleHumanBurst([incoming], human));
    const replies = h.store.getAllMessages().filter((message) => message.authorId.startsWith("ai-"));
    expect(replies).toHaveLength(1 + contributions);
    expect(new Set(replies.map((message) => message.authorId)).size).toBe(replies.length);
    expect(replies[0]?.replyToId).toBe(incoming.id);
    for (let index = 1; index < replies.length; index += 1) {
      expect(replies[index]?.replyToId).toBe(replies[index - 1]?.id);
    }
    expect(h.frames).toHaveLength(3);
    expect(h.frames.slice(1).every(({ request }) => request.mustReplyIds?.length === 0)).toBe(true);
  });

  it.each(["same human", "another human", "another resident"])(
    "drops an optional draft after newer same-room traffic from %s without retracting the primary",
    async (traffic) => {
      let resolveOptional: ((lines: GeneratedLine[]) => void) | undefined;
      const optional = new Promise<GeneratedLine[]>((resolve) => { resolveOptional = resolve; });
      const h = await createHarness({
        generate: (request, frame) => frame === 0 ? [lineFor(request, primaryContent)] : frame === 1 ? optional : [],
      });
      const incoming = h.addHuman("Which film should we see tonight?");
      const pending = h.internals.handleHumanBurst([incoming], human);
      await vi.waitFor(() => expect(h.frames).toHaveLength(2));
      const primary = h.store.getAllMessages().find((message) => message.content === primaryContent)!;
      expect(primary).toBeDefined();
      if (traffic === "another resident") h.store.addPublicMessage(createMessage("lobby", "ai-outsider", "The cinema just cancelled that screening."));
      else h.addHuman("Actually, the cinema just cancelled that screening.", "lobby", traffic === "same human" ? human : anotherHuman);
      resolveOptional!([lineFor(h.frames[1]!.request, "This late draft no longer belongs in the changed conversation.")]);
      await settle(pending);
      expect(h.store.getMessage(primary.id)).toMatchObject({ content: primaryContent, replyToId: incoming.id });
      expect(h.store.getAllMessages().some((message) => message.content.startsWith("This late draft"))).toBe(false);
      expect(h.frames).toHaveLength(2);
    },
  );

  it("does not let another room's human activity cancel the current room's continuation", async () => {
    let resolveOptional: ((lines: GeneratedLine[]) => void) | undefined;
    const optional = new Promise<GeneratedLine[]>((resolve) => { resolveOptional = resolve; });
    const h = await createHarness({
      generate: (request, frame) => frame === 0 ? [lineFor(request, primaryContent)] : frame === 1 ? optional : [],
    });
    const incoming = h.addHuman("What about a midnight showing?");
    const pending = h.internals.handleHumanBurst([incoming], human);
    await vi.waitFor(() => expect(h.frames).toHaveLength(2));
    const elsewhere = h.addHuman("Any new collector figures this week?", "fnaf", anotherHuman);
    resolveOptional!([lineFor(h.frames[1]!.request, optionalContents[0]!)]);
    await settle(pending);
    const replies = h.store.getRecent("lobby", 20).filter((message) => message.authorId.startsWith("ai-"));
    expect(replies).toHaveLength(2);
    expect(replies[1]?.replyToId).toBe(replies[0]?.id);
    expect(h.frames.slice(1).every(({ request }) =>
      !request.conversationContext?.publishedTurns.some((turn) => turn.messageId === elsewhere.id),
    )).toBe(true);
  });

  it("does not replace a newer participant's ambient topic when an older optional draft finishes", async () => {
    let resolveOptional: ((lines: GeneratedLine[]) => void) | undefined;
    const optional = new Promise<GeneratedLine[]>((resolve) => { resolveOptional = resolve; });
    const newerReply = "The cancellation changes things. Let's pick a different cinema.";
    const h = await createHarness({
      generate: (request, frame) => frame === 0
        ? [lineFor(request, primaryContent)]
        : frame === 1 ? optional
        : !request.conversationContext ? [lineFor(request, newerReply)] : [],
    });
    const older = h.addHuman("Which screening should we choose?");
    const olderPending = h.internals.handleHumanBurst([older], human);
    await vi.waitFor(() => expect(h.frames).toHaveLength(2));
    const newer = h.addHuman("That cinema cancelled everything. Where should we go instead?", "lobby", anotherHuman);
    await settle(h.internals.handleHumanBurst([newer], anotherHuman));
    const newerThread = h.internals.ambientThreads.get("lobby");
    expect(newerThread).toMatchObject({ causalRootId: newer.id, initiatorActorId: anotherHuman.id });

    resolveOptional!([lineFor(h.frames[1]!.request, "The old screening still sounds good.")]);
    await settle(olderPending);

    expect(h.internals.ambientThreads.get("lobby")).toBe(newerThread);
    expect(h.store.getAllMessages().some((message) => message.content === "The old screening still sounds good.")).toBe(false);
    expect(h.store.getAllMessages().filter((message) => message.content === newerReply))
      .toEqual([expect.objectContaining({ replyToId: newer.id })]);
  });

  it("delivers an older required answer without replacing the newer participant's ambient topic", async () => {
    let resolvePrimary: ((lines: GeneratedLine[]) => void) | undefined;
    const primary = new Promise<GeneratedLine[]>((resolve) => { resolvePrimary = resolve; });
    const h = await createHarness({
      generate: (request, frame) => frame === 0 ? primary
        : request.conversationContext ? [] : [lineFor(request, optionalContents[0]!)],
    });
    const older = h.addHuman("Which screening should we choose?");
    const olderPending = h.internals.handleHumanBurst([older], human);
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));
    expect(h.frames[0]!.request.mustReplyIds).toHaveLength(1);
    const newer = h.addHuman("Where else could we go if that screening is cancelled?", "lobby", anotherHuman);
    await settle(h.internals.handleHumanBurst([newer], anotherHuman));
    const newerThread = h.internals.ambientThreads.get("lobby");
    expect(newerThread?.causalRootId).toBe(newer.id);

    resolvePrimary!([lineFor(h.frames[0]!.request, primaryContent)]);
    await settle(olderPending);

    expect(h.store.getAllMessages().filter((message) => message.content === primaryContent))
      .toEqual([expect.objectContaining({ replyToId: older.id })]);
    expect(h.internals.ambientThreads.get("lobby")).toBe(newerThread);
  });

  it("still answers each personally mentioned resident's obligation in separate published-aware turns", async () => {
    const addressed = residents.slice(0, 2);
    const h = await createHarness({
      addressedIds: addressed.map((resident) => resident.id),
      generate: (request) => request.mustReplyIds?.length
        ? [lineFor(request, request.selected[0]!.id === addressed[0]!.id ? primaryContent : optionalContents[0]!)]
        : [],
    });
    const incoming = h.addHuman(`@${addressed[0]!.name} @${addressed[1]!.name}, which screening would each of you choose?`);
    await settle(h.internals.handleHumanBurst([incoming], human));
    const replies = h.store.getRecent("lobby", 20).filter((message) => message.authorId.startsWith("ai-"));
    expect(replies.map((message) => message.authorId).sort()).toEqual(addressed.map((resident) => resident.id).sort());
    expect(replies.every((message) => message.replyToId === incoming.id)).toBe(true);
    const second = h.frames[1]!.request;
    expect(second.mustReplyIds).toEqual([second.selected[0]!.id]);
    expect(second.conversationContext?.publishedTurns).toContainEqual(expect.objectContaining({ messageId: replies[0]!.id }));
    expect(second.trigger?.messageId).toBe(incoming.id);
  });

  it("does not add an optional crowd burst when recovering a durable direct reply", async () => {
    const owner = residents[0]!;
    const h = await createHarness({ addressedIds: [owner.id] });
    const incoming = h.addHuman(`@${owner.name}, what would you choose?`);
    h.store.registerPendingPublicTurn(incoming.id, { targetPersonaIds: [owner.id], deliveryKind: "direct" });
    const claim = h.store.claimPendingPublicTurnTarget(incoming.id, owner.id)!;
    const pending = h.internals.handleHumanBurst([incoming], human, undefined, [{
      messageId: incoming.id, channelId: incoming.channelId, authorId: human.id,
      deliveryKind: "direct", personaId: owner.id, attempt: claim.target.attempts,
    }], undefined, true);
    await settle(pending);
    expect(h.frames).toHaveLength(1);
    expect(h.store.getRecent("lobby", 10).filter((message) => message.replyToId === incoming.id))
      .toEqual([expect.objectContaining({ authorId: owner.id })]);
    expect(h.store.getPendingPublicTurns()).toEqual([]);
    expect(h.internals.ambientThreads.has("lobby")).toBe(false);
  });

  it("recovers an older durable answer without replacing an already-current ambient topic", async () => {
    const owner = residents[0]!;
    const h = await createHarness({ addressedIds: [owner.id] });
    const older = h.addHuman(`@${owner.name}, which screening would you choose?`);
    h.store.registerPendingPublicTurn(older.id, { targetPersonaIds: [owner.id], deliveryKind: "direct" });
    const claim = h.store.claimPendingPublicTurnTarget(older.id, owner.id)!;
    const newer = h.addHuman("Which cinema has the better sound system?", "lobby", anotherHuman);
    await settle(h.internals.handleHumanBurst([newer], anotherHuman));
    const newerThread = h.internals.ambientThreads.get("lobby");
    expect(newerThread?.causalRootId).toBe(newer.id);

    await settle(h.internals.handleHumanBurst([older], human, undefined, [{
      messageId: older.id, channelId: older.channelId, authorId: human.id,
      deliveryKind: "direct", personaId: owner.id, attempt: claim.target.attempts,
    }], undefined, true));

    expect(h.store.getRecent("lobby", 10).filter((message) => message.replyToId === older.id))
      .toEqual([expect.objectContaining({ authorId: owner.id })]);
    expect(h.store.getPendingPublicTurns()).toEqual([]);
    expect(h.internals.ambientThreads.get("lobby")).toBe(newerThread);
  });

  it.each(["model recovery", "director retry"])("spends no optional work after %s used the primary recovery budget", async (recovery) => {
    const h = await createHarness({
      generate: (request, frame) => {
        if (recovery === "director retry" && frame === 0) return [];
        if (recovery === "model recovery") request.responseRecoveryBudget!.retriesRemaining = 0;
        return [lineFor(request, primaryContent)];
      },
    });
    const incoming = h.addHuman("What's your choice for tonight?");
    await settle(h.internals.handleHumanBurst([incoming], human));
    expect(h.frames).toHaveLength(recovery === "director retry" ? 2 : 1);
    expect(h.frames.every(({ request }) => !request.conversationContext)).toBe(true);
    expect(h.store.getRecent("lobby", 10).filter((message) => message.authorId.startsWith("ai-")))
      .toEqual([expect.objectContaining({ content: primaryContent, replyToId: incoming.id })]);
  });
});
