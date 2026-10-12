import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { buildConversationContext, type SceneConversationTurn } from "./conversationFlow.js";
import { conversationOpportunity, conversationReplyCandidatePool } from "./conversationScheduling.js";
import { SocialDirector, type AmbientThreadState } from "./director.js";
import { buildSceneSystemPrompt, type SceneRequest } from "./lmStudio.js";
import { PERSONAS, type Persona } from "./personas.js";
import { createMessage, RoomStore } from "./store.js";

const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const bosse = PERSONAS.find((persona) => persona.id === "ai-bosse")!;
const juno = PERSONAS.find((persona) => persona.id === "ai-juno")!;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T16:00:00.000Z"));
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = async (residents: Persona[] = [mira, bosse, juno], random = 0.1) => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-resident-mentions-"));
  const store = new RoomStore(join(directory, "room.json"));
  const actors = new ActorChannelRuntime(residents);
  // Each case explicitly controls room subscription independently of text.
  vi.spyOn(actors, "autonomousCandidatesFor").mockReturnValue(residents);
  const generateScene = vi.fn();
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    store,
    { health: vi.fn(() => ({ connected: true, queueDepth: 0 })), generateScene, rememberDeliveredLine: vi.fn() } as never,
    actors, {} as never, {} as never, () => residents, () => 1,
    {
      now: () => Date.now(), rng: () => random, autonomousResearchEnabled: false,
      behaviorTuningProvider: () => ({ activity: 50, competence: 50, aggression: 25, explicitness: 50 }),
    },
  );
  const internals = director as unknown as {
    recordAmbientPost: (thread: AmbientThreadState, message: ReturnType<typeof createMessage>, action?: undefined, target?: SceneConversationTurn) => void;
    activeVoicePersonaIds: Set<string>;
  };
  const thread: AmbientThreadState = {
    seed: "The actual conversation", origin: "human_topic", messageCount: 1,
    participantIds: [mira.id, bosse.id], debateBeat: false,
    openedAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  };
  cleanup.push(async () => {
    director.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const publish = (content: string, target?: SceneConversationTurn) => {
    const message = createMessage("lobby", mira.id, content);
    store.addPublicMessage(message);
    internals.recordAmbientPost(thread, message, undefined, target);
    return message;
  };
  return { thread, store, generateScene, internals, publish };
};

describe("resident-owned direct addressing", () => {
  it("permits optional exact tags only in autonomous conversation guidance, without requiring invented recall", () => {
    const request: SceneRequest = {
      kind: "ambient", channelId: "lobby", channelName: "lobby", selected: [mira], history: [],
      conversationContext: buildConversationContext({ phase: "opening", messages: [] }),
    };
    const prompt = buildSceneSystemPrompt(request);
    expect(prompt).toContain("@ followed by their exact display name");
    expect(prompt).toContain("optional, not a tag quota");
    expect(prompt).toContain("Reply metadata quotes a specific published message");
    expect(prompt).toContain("an @mention draws the person's attention");
    expect(prompt).toContain("Use either or both when they serve the thought");
    expect(prompt).toContain("only names supplied in this scene");
    expect(prompt).toContain("never invent a past discussion");
    expect(buildSceneSystemPrompt({ ...request, kind: "voice" }))
      .not.toContain("@ followed by their exact display name");
  });

  it("gives an exact published tag one optional next-turn opportunity, without a cascade", async () => {
    const h = await setup();
    const text = "@bosse.exe, would you still choose that keyboard?";
    const message = h.publish(text);
    expect(h.thread.replyOpportunity).toEqual({ afterMessageId: message.id, actorId: bosse.id });
    expect(h.store.getMessage(message.id)?.content).toBe(text);
    expect(h.store.getAllMessages()).toHaveLength(1);
    expect(h.generateScene).not.toHaveBeenCalled();
    const opportunity = {
      latestMessageId: message.id, opportunity: h.thread.replyOpportunity, candidateIds: [bosse.id, juno.id],
    };
    expect(conversationReplyCandidatePool({ ...opportunity, random: 0.1 })).toEqual([bosse.id]);
    expect(conversationReplyCandidatePool({ ...opportunity, random: 0.99 })).toEqual([juno.id]);
  });

  it.each([
    "Bosse.exe, an ordinary untagged name",
    "@Mira talking to herself",
    "@unknown someone outside the supplied room",
    "https://example.com/@Bosse.exe",
    "someone@Bosse.exe",
    "@Bosse.executable is not the same handle",
    "@Jaw_B a human participant, not an autonomous resident",
  ])("does not infer a resident address from %s", async (content) => {
    const h = await setup();
    h.publish(content);
    expect(h.thread.replyOpportunity).toBeUndefined();
  });

  it("uses the shared Unicode exact matcher rather than a language-specific interpretation", async () => {
    const renamed = { ...bosse, name: "José" };
    const h = await setup([mira, renamed]);
    const message = h.publish("@Jose\u0301、そう思う？");
    expect(h.thread.replyOpportunity).toEqual({ afterMessageId: message.id, actorId: bosse.id });
  });

  it("does not pull non-subscribers, inactive residents, moderators or a voice-occupied resident into ambient work", async () => {
    const runa = PERSONAS.find((persona) => persona.id === "ai-runa")!;
    const stale = { ...juno, id: "ai-removed", name: "Removed" };
    const h = await setup([mira, bosse, runa, stale]);
    h.internals.activeVoicePersonaIds.add(bosse.id);
    h.publish("@Juno @Removed @Runa @Bosse.exe");
    expect(h.thread.replyOpportunity).toBeUndefined();
  });

  it.each([{ random: 0, expected: bosse.id }, { random: 0.99, expected: juno.id }])(
    "selects only one of several genuine recipients using the existing RNG ($random)",
    async ({ random, expected }) => {
      const h = await setup(undefined, random);
      const message = h.publish("@Bosse.exe @Juno, which version would you keep?");
      expect(h.thread.replyOpportunity).toEqual({ afterMessageId: message.id, actorId: expected });
      expect(h.generateScene).not.toHaveBeenCalled();
    },
  );

  it("lets explicit text address differ from a reply edge and preserves reply-only behavior", async () => {
    const h = await setup();
    const target: SceneConversationTurn = {
      messageId: "prior", authorId: juno.id, author: juno.name, kind: "ai",
      content: "That keyboard looks uncomfortable.", createdAt: new Date(Date.now() - 30_000).toISOString(),
    };
    const tagged = h.publish("That is the one @Bosse.exe preferred, isn't it?", target);
    expect(h.thread.replyOpportunity).toEqual({ afterMessageId: tagged.id, actorId: bosse.id });
    const replyOnly = h.publish("I see what you mean about the key spacing.", target);
    expect(h.thread.replyOpportunity).toEqual({ afterMessageId: replyOnly.id, actorId: juno.id });
    h.publish("A general observation without a tag or a reply.");
    expect(h.thread.replyOpportunity).toBeUndefined();
  });

  it("does not turn a mention into an obligation that bypasses silence, availability or the episode limit", async () => {
    const h = await setup();
    const message = h.publish("@Bosse.exe, what do you think?");
    const afterSilence = conversationOpportunity({
      publishedCount: 2, lastAuthorId: mira.id, quietCandidateIds: [bosse.id], eligibleIds: [bosse.id, juno.id],
    });
    expect(conversationReplyCandidatePool({
      latestMessageId: message.id, opportunity: h.thread.replyOpportunity,
      candidateIds: afterSilence.candidateIds, random: 0,
    })).toBeUndefined();
    expect(conversationReplyCandidatePool({
      latestMessageId: "newer", opportunity: h.thread.replyOpportunity, candidateIds: [bosse.id], random: 0,
    })).toBeUndefined();
    expect(conversationOpportunity({
      publishedCount: 8, lastAuthorId: mira.id, quietCandidateIds: [], eligibleIds: [bosse.id],
    }).status).toBe("budget");
  });
});
