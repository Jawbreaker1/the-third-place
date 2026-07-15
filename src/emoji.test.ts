import { describe, expect, it } from "vitest";
import { filterPublicReactionEmojis, insertEmojiAtSelection } from "./emoji";

describe("emoji picker helpers", () => {
  it("filters the shared catalog by accessible label or emoji", () => {
    expect(filterPublicReactionEmojis("football")).toEqual(["⚽"]);
    expect(filterPublicReactionEmojis("🤯")).toEqual(["🤯"]);
    expect(filterPublicReactionEmojis("not in the catalog")).toEqual([]);
  });

  it("inserts at the caret and replaces a selection", () => {
    expect(insertEmojiAtSelection("hello", "😂", 2, 2, 20)).toEqual({ value: "he😂llo", caret: 4 });
    expect(insertEmojiAtSelection("hello", "⚽", 1, 4, 20)).toEqual({ value: "h⚽o", caret: 2 });
  });

  it("rejects an over-limit emoji instead of slicing its surrogate pair", () => {
    const full = "a".repeat(500);
    expect(insertEmojiAtSelection(full, "😂", 500, 500, 500)).toBeUndefined();
    expect(full.at(-1)).toBe("a");
  });
});
