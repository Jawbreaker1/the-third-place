import { describe, expect, it } from "vitest";
import { displayNameGlyph, normalizeDisplayName, validDisplayName } from "./displayName.js";

describe("Unicode display names", () => {
  it.each(["अनु", "مُحَمَّد", "山田", "𐐨lex", "Élodie"])("accepts Unicode grapheme names: %s", (name) => {
    expect(validDisplayName(normalizeDisplayName(name))).toBe(true);
  });

  it.each(["李", "𐐨"])("accepts a single Unicode grapheme name: %s", (name) => {
    expect(validDisplayName(normalizeDisplayName(name))).toBe(true);
  });

  it("counts grapheme clusters rather than UTF-16 code units", () => {
    const supplementary = "𐐨𐐨";
    expect(supplementary.length).toBe(4);
    expect(validDisplayName(supplementary)).toBe(true);
    expect(displayNameGlyph(supplementary)).toBe("𐐀");
    expect(displayNameGlyph("ßeta")).toBe("S");
  });

  it("requires a letter or number in the first grapheme and bounds separators", () => {
    expect(validDisplayName("◌́Alex")).toBe(false);
    expect(validDisplayName("_Alex")).toBe(false);
    expect(validDisplayName("Alex/Root")).toBe(false);
  });
});
