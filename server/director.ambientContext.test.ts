import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import type { SceneConversationContext } from "./conversationFlow.js";
import { SocialDirector, type AmbientThreadState } from "./director.js";
import { PERSONAS } from "./personas.js";
import { createMessage, RoomStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-ambient-context-"));
  const store = new RoomStore(join(directory, "room.json"));
  const residents = PERSONAS.filter((persona) => ["ai-mira", "ai-bosse", "ai-juno"].includes(persona.id));
  const now = Date.parse("2026-10-12T17:00:00.000Z");
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    store,
    { health: vi.fn(() => ({ connected: true, queueDepth: 0 })), rememberDeliveredLine: vi.fn() } as never,
    new ActorChannelRuntime(residents), {} as never, {} as never,
    () => residents, () => 0, { now: () => now, rng: () => 0.5, autonomousResearchEnabled: false },
  );
  const internals = director as unknown as {
    publishedConversationContext: (
      channelId: string, rootId: string | undefined, phase: "opening" | "continuation",
      options?: { separateRoomBackground?: boolean },
    ) => SceneConversationContext;
    recordAmbientPost: (thread: AmbientThreadState, message: ChatMessage) => void;
  };
  let sequence = 0;
  const add = (content: string, authorId = "ai-mira", channelId = "lobby") => {
    const message = createMessage(channelId, authorId, content, {
      createdAt: new Date(now + sequence++ * 1_000).toISOString(),
    });
    store.addPublicMessage(message);
    return message;
  };
  cleanups.push(async () => { director.stop(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return { store, internals, add, now };
};

describe("autonomous room background and committed conversation focus", () => {
  it("does not promote the old room tail or a scheduler ID into a fresh opening's active exchange", async () => {
    const h = await setup();
    h.add("Earlier room topic", "ai-bosse");
    const old = h.add("That is the same point again.", "ai-juno");
    const foreign = h.add("Not this room", "ai-mira", "the-pub");
    for (const rootId of [undefined, "scheduler-episode-id", foreign.id]) {
      const context = h.internals.publishedConversationContext("lobby", rootId, "opening", { separateRoomBackground: true });
      expect(context.publishedTurns).toEqual([]);
      expect(context.rootMessageId).toBeUndefined();
      expect(context.latestMessageId).toBeUndefined();
      expect(context.roomBackground?.at(-1)?.messageId).toBe(old.id);
      expect(JSON.stringify(context)).not.toContain(foreign.content);
    }
  });

  it("anchors a seed or feed exchange to its first publication without overwriting causal provenance", async () => {
    const h = await setup();
    const old = h.add("An earlier topic", "ai-bosse");
    const thread: AmbientThreadState = {
      seed: "Optional room material", origin: "room_seed", episodeId: "episode-1", causalRootId: "seed-or-feed-revision",
      messageCount: 0, participantIds: [], debateBeat: false, languageHint: "en", openedAt: h.now, updatedAt: h.now,
    };
    const first = h.add("An independent thought with a concrete detail.");
    h.internals.recordAmbientPost(thread, first);
    const second = h.add("What if we tried the cheaper one?", "ai-juno");
    h.internals.recordAmbientPost(thread, second);
    expect(thread.conversationRootMessageId).toBe(first.id);
    expect(thread.causalRootId).toBe("seed-or-feed-revision");
    const context = h.internals.publishedConversationContext("lobby", thread.conversationRootMessageId, "continuation", { separateRoomBackground: true });
    expect(context.rootMessageId).toBe(first.id);
    expect(context.latestMessageId).toBe(second.id);
    expect(context.publishedTurns.map((row) => row.messageId)).toEqual([first.id, second.id]);
    expect(context.roomBackground?.map((row) => row.messageId)).toEqual([old.id]);
  });

  it("retains a real participant's question as the root and keeps unrelated earlier chatter in background", async () => {
    const h = await setup();
    const old = h.add("Unrelated old joke", "ai-bosse");
    const question = h.add("Which option would you choose?", "human-example");
    const thread: AmbientThreadState = {
      seed: "Participant question", origin: "human_topic", causalRootId: question.id,
      messageCount: 0, participantIds: [], debateBeat: false, languageHint: "en", openedAt: h.now, updatedAt: h.now,
    };
    const reply = h.add("The small one, because it fits beside the window.");
    h.internals.recordAmbientPost(thread, reply);
    expect(thread.conversationRootMessageId).toBe(question.id);
    const context = h.internals.publishedConversationContext("lobby", thread.conversationRootMessageId, "continuation", { separateRoomBackground: true });
    expect(context.publishedTurns.map((row) => row.messageId)).toEqual([question.id, reply.id]);
    expect(context.roomBackground?.map((row) => row.messageId)).toEqual([old.id]);
  });

  it("leaves interactive public conversation context unchanged and retains legacy continuations with an unbound origin", async () => {
    const h = await setup();
    const old = h.add("Earlier point", "ai-bosse");
    const latest = h.add("Current answer");
    const interactive = h.internals.publishedConversationContext("lobby", latest.id, "continuation");
    expect(interactive.roomBackground).toBeUndefined();
    expect(interactive.publishedTurns.map((row) => row.messageId)).toEqual([old.id, latest.id]);
    const legacy = h.internals.publishedConversationContext("lobby", "legacy-episode", "continuation", { separateRoomBackground: true });
    expect(legacy.publishedTurns.map((row) => row.messageId)).toEqual([old.id, latest.id]);
    expect(legacy.rootMessageId).toBeUndefined();
  });
});
