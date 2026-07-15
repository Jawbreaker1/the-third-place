import { describe, expect, it, vi } from "vitest";
import type { Member } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import { PERSONAS } from "./personas.js";
import { createMessage, RoomStore } from "./store.js";

const human: Member = {
  id: "guest-reaction",
  name: "Johan",
  kind: "human",
  status: "online",
  avatar: { color: "#123456", accent: "#abcdef", glyph: "J" },
};

const makeHarness = (options: {
  debounceMs?: number;
  responseChance?: number;
  generate?: ReturnType<typeof vi.fn>;
} = {}) => {
  const store = new RoomStore(`/tmp/third-place-human-reaction-${Date.now()}-${Math.random()}.json`);
  const persona = PERSONAS.find((candidate) => candidate.id === "ai-mira")!;
  const target = createMessage("lobby", persona.id, "Jag står fortfarande för den take:n.");
  store.addPublicMessage(target);
  const emit = vi.fn();
  const generateScene = options.generate ?? vi.fn(async () => [{
    personaId: persona.id,
    content: "haha okej, den där tog jag 😅",
    source: "lm" as const,
    sourceIds: [],
  }]);
  const lm = {
    health: vi.fn(() => ({ connected: true, queueDepth: 0 })),
    generateScene,
    rememberDeliveredLine: vi.fn(),
  };
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit })) } as never,
    store,
    lm as never,
    new ActorChannelRuntime(),
    {} as never,
    {
      promptNote: vi.fn(() => undefined),
      getRelation: vi.fn(() => undefined),
    } as never,
    () => [...PERSONAS, human],
    () => 1,
    {
      rng: () => 0,
      now: () => Date.parse("2026-07-15T20:00:00.000Z"),
      humanReactionDebounceMs: options.debounceMs ?? 0,
      humanReactionResponseChance: options.responseChance ?? 1,
    },
  );
  return { director, store, persona, target, lm, emit, generateScene };
};

describe("human reactions as social events", () => {
  it("gives only the reacted-to resident an optional, bounded scene", async () => {
    const harness = makeHarness();
    harness.store.togglePublicReaction("lobby", harness.target.id, "😂", human.id);

    harness.director.onHumanReaction({
      channelId: "lobby",
      messageId: harness.target.id,
      emoji: "😂",
    }, human);

    await vi.waitFor(() => expect(harness.generateScene).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.store.getRecent("lobby", 10)).toHaveLength(2));
    const request = harness.generateScene.mock.calls[0]![0];
    expect(request.selected.map((candidate: { id: string }) => candidate.id)).toEqual([harness.persona.id]);
    expect(request.mustReplyIds).toBeUndefined();
    expect(request.trigger).toMatchObject({ author: human.name, content: "😂" });
    expect(request.wordLimits[harness.persona.id].maximum).toBeLessThanOrEqual(18);
    expect(request.premise).toContain("silence is valid");
    const posted = harness.store.getRecent("lobby", 10).at(-1)!;
    expect(posted.authorId).toBe(harness.persona.id);
    expect(posted.replyToId).toBeUndefined();
    expect(harness.generateScene.mock.calls[0]![0].selected).toHaveLength(1);
    harness.director.stop();
  });

  it("coalesces repeated add notifications and does not create a resident dogpile", async () => {
    const harness = makeHarness({ debounceMs: 15 });
    harness.store.togglePublicReaction("lobby", harness.target.id, "👀", human.id);
    const event = { channelId: "lobby", messageId: harness.target.id, emoji: "👀" };

    harness.director.onHumanReaction(event, human);
    harness.director.onHumanReaction(event, human);

    await vi.waitFor(() => expect(harness.generateScene).toHaveBeenCalledTimes(1));
    expect(harness.generateScene.mock.calls[0]![0].selected).toHaveLength(1);
    harness.director.stop();
  });

  it("re-checks membership after debounce so a quick removal produces no ghost response", async () => {
    const harness = makeHarness({ debounceMs: 30 });
    harness.store.togglePublicReaction("lobby", harness.target.id, "💛", human.id);
    harness.director.onHumanReaction({
      channelId: "lobby",
      messageId: harness.target.id,
      emoji: "💛",
    }, human);
    harness.store.togglePublicReaction("lobby", harness.target.id, "💛", human.id);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(harness.generateScene).not.toHaveBeenCalled();
    expect(harness.store.getRecent("lobby", 10)).toHaveLength(1);
    harness.director.stop();
  });

  it("lets the model choose silence without retries or a synthetic fallback", async () => {
    const generate = vi.fn(async () => []);
    const harness = makeHarness({ generate });
    harness.store.togglePublicReaction("lobby", harness.target.id, "👍", human.id);

    harness.director.onHumanReaction({
      channelId: "lobby",
      messageId: harness.target.id,
      emoji: "👍",
    }, human);

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(
      harness.director.getEvents().some((event) => event.trigger === "reaction"),
    ).toBe(true));
    expect(harness.store.getRecent("lobby", 10)).toHaveLength(1);
    expect(harness.emit.mock.calls.some(([event, payload]) =>
      event === "typing:member" && payload?.active === true,
    )).toBe(false);
    harness.director.stop();
  });

  it("caps one target message across humans so reactions cannot make its author repeat", async () => {
    const harness = makeHarness();
    harness.store.togglePublicReaction("lobby", harness.target.id, "😂", human.id);
    harness.director.onHumanReaction({
      channelId: "lobby",
      messageId: harness.target.id,
      emoji: "😂",
    }, human);
    await vi.waitFor(() => expect(harness.store.getRecent("lobby", 10)).toHaveLength(2));

    const secondHuman: Member = {
      ...human,
      id: "guest-reaction-two",
      name: "Sam",
      avatar: { ...human.avatar, glyph: "S" },
    };
    harness.store.togglePublicReaction("lobby", harness.target.id, "🤔", secondHuman.id);
    harness.director.onHumanReaction({
      channelId: "lobby",
      messageId: harness.target.id,
      emoji: "🤔",
    }, secondHuman);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.generateScene).toHaveBeenCalledTimes(1);
    harness.director.stop();
  });
});
