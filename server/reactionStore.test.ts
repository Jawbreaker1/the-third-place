import { describe, expect, it } from "vitest";
import { createMessage, RoomStore } from "./store.js";

const storeWithMessage = () => {
  const store = new RoomStore(`/tmp/third-place-reaction-${Date.now()}-${Math.random()}.json`);
  const message = createMessage("lobby", "ai-mira", "A message worth reacting to");
  store.addPublicMessage(message);
  return { message, store };
};

describe("public reaction storage", () => {
  it("toggles one member without disturbing the other reactors", () => {
    const { message, store } = storeWithMessage();

    store.togglePublicReaction("lobby", message.id, "👀", "ai-juno", true);
    expect(store.togglePublicReaction("lobby", message.id, "👀", "human-johan"))
      .toEqual({ emoji: "👀", memberIds: ["ai-juno", "human-johan"] });
    expect(store.togglePublicReaction("lobby", message.id, "👀", "human-johan"))
      .toEqual({ emoji: "👀", memberIds: ["ai-juno"] });
    expect(store.getMessage(message.id)?.reactions).toEqual([
      { emoji: "👀", memberIds: ["ai-juno"] },
    ]);
  });

  it("removes the reaction group when its final member toggles off", () => {
    const { message, store } = storeWithMessage();

    expect(store.togglePublicReaction("lobby", message.id, "✨", "human-johan"))
      .toEqual({ emoji: "✨", memberIds: ["human-johan"] });
    expect(store.togglePublicReaction("lobby", message.id, "✨", "human-johan"))
      .toEqual({ emoji: "✨", memberIds: [] });
    expect(store.getMessage(message.id)?.reactions).toEqual([]);
  });

  it("keeps force-added AI reactions idempotent", () => {
    const { message, store } = storeWithMessage();

    store.togglePublicReaction("lobby", message.id, "😂", "ai-bosse", true);
    store.togglePublicReaction("lobby", message.id, "😂", "ai-bosse", true);

    expect(store.getMessage(message.id)?.reactions).toEqual([
      { emoji: "😂", memberIds: ["ai-bosse"] },
    ]);
  });

  it("binds a mutation to both the message and its channel", () => {
    const { message, store } = storeWithMessage();

    expect(store.togglePublicReaction("the-pub", message.id, "👍", "human-johan"))
      .toBeUndefined();
    expect(store.getMessage(message.id)?.reactions).toEqual([]);
  });
});
