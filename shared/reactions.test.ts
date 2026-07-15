import { describe, expect, it } from "vitest";
import { CHANNELS, getChannelProfile } from "../server/channels.js";
import { RoomStore } from "../server/store.js";
import {
  PUBLIC_REACTION_EMOJIS,
  PUBLIC_REACTION_LABELS,
  isPublicReactionEmoji,
} from "./reactions.js";

describe("public reaction catalog", () => {
  it("is unique and has an accessible label for every picker entry", () => {
    expect(new Set(PUBLIC_REACTION_EMOJIS).size).toBe(PUBLIC_REACTION_EMOJIS.length);
    expect(Object.keys(PUBLIC_REACTION_LABELS).sort()).toEqual([...PUBLIC_REACTION_EMOJIS].sort());
    for (const emoji of PUBLIC_REACTION_EMOJIS) {
      expect(PUBLIC_REACTION_LABELS[emoji].trim(), emoji).not.toBe("");
      // Keep every catalog entry inside the socket schema's bounded UTF-16
      // payload even if a future picker entry uses a composed sequence.
      expect(emoji.length, emoji).toBeLessThanOrEqual(12);
    }
  });

  it("accepts every built-in reaction that a person can encounter in seeded history", async () => {
    const store = new RoomStore(`/tmp/third-place-reaction-catalog-${Date.now()}-${Math.random()}.json`);
    await store.load();
    const seededEmojis = new Set(
      store.getAllMessages().flatMap((message) => message.reactions.map((reaction) => reaction.emoji)),
    );

    expect(
      [...seededEmojis].filter((emoji) => !isPublicReactionEmoji(emoji)),
    ).toEqual([]);
  });

  it("accepts every room-specific reaction that autonomous residents can add", () => {
    const ambientEmojis = new Set(CHANNELS.flatMap(
      (channel) => getChannelProfile(channel.id)?.ambientReactionPalette ?? [],
    ));

    expect([...ambientEmojis].filter((emoji) => !isPublicReactionEmoji(emoji))).toEqual([]);
  });

  it("rejects arbitrary text and lookalike variants outside the curated catalog", () => {
    expect(isPublicReactionEmoji("not an emoji")).toBe(false);
    expect(isPublicReactionEmoji("<img src=x>")).toBe(false);
    expect(isPublicReactionEmoji("👍👍")).toBe(false);
    expect(isPublicReactionEmoji("👍🏻")).toBe(false);
    expect(isPublicReactionEmoji("❤")).toBe(false);
  });
});
