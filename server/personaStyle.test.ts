import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";
import {
  buildPersonaStylePromptNote,
  buildPersonaStylePromptNotes,
  GENERIC_ASSISTANT_PHRASES,
  personaStyleSignature,
} from "./personaStyle.js";

describe("persona style fingerprints", () => {
  it("gives every resident a bounded, explicit style contract", () => {
    for (const persona of PERSONAS) {
      const style = persona.style;
      expect(style.typicalWords[0], persona.id).toBeGreaterThanOrEqual(2);
      expect(style.typicalWords[0], persona.id).toBeLessThanOrEqual(style.typicalWords[1]);
      expect(style.typicalWords[1], persona.id).toBeLessThanOrEqual(style.hardMaxWords);
      expect(style.hardMaxWords, persona.id).toBeLessThanOrEqual(50);
      expect(style.typicalSentences[0], persona.id).toBeGreaterThanOrEqual(1);
      expect(style.typicalSentences[0], persona.id).toBeLessThanOrEqual(style.typicalSentences[1]);
      expect(style.typicalSentences[1], persona.id).toBeLessThanOrEqual(3);
      expect(style.emojiRate, persona.id).toBeGreaterThanOrEqual(0);
      expect(style.emojiRate, persona.id).toBeLessThanOrEqual(0.1);
      expect(style.complexityAppetite, persona.id).toBeGreaterThanOrEqual(0);
      expect(style.complexityAppetite, persona.id).toBeLessThanOrEqual(1);
      expect(style.conversationHabits, persona.id).toHaveLength(3);
      expect(new Set(style.conversationHabits).size, persona.id).toBe(style.conversationHabits.length);
      expect(style.avoidPhrases.length, persona.id).toBeGreaterThanOrEqual(3);
      expect(style.avoidPhrases.length, persona.id).toBeLessThanOrEqual(4);
    }
  });

  it("keeps every complete fingerprint unique", () => {
    const signatures = PERSONAS.map((persona) => personaStyleSignature(persona.style));
    expect(new Set(signatures).size).toBe(PERSONAS.length);
  });

  it("has real population-level variation instead of one house voice", () => {
    const unique = <T>(values: T[]) => new Set(values).size;
    expect(unique(PERSONAS.map((persona) => persona.style.casing))).toBe(3);
    expect(unique(PERSONAS.map((persona) => persona.style.punctuation))).toBeGreaterThanOrEqual(5);
    expect(unique(PERSONAS.map((persona) => persona.style.correctionMode))).toBeGreaterThanOrEqual(5);
    expect(unique(PERSONAS.map((persona) => persona.style.disagreementMode))).toBeGreaterThanOrEqual(6);
    expect(PERSONAS.filter((persona) => persona.style.emojiRate === 0).length).toBeGreaterThanOrEqual(6);
    expect(PERSONAS.filter((persona) => persona.style.emojiRate > 0).length).toBeGreaterThanOrEqual(6);
    expect(Math.min(...PERSONAS.map((persona) => persona.style.complexityAppetite))).toBeLessThanOrEqual(0.3);
    expect(Math.max(...PERSONAS.map((persona) => persona.style.complexityAppetite))).toBeGreaterThanOrEqual(0.9);
    expect(Math.max(...PERSONAS.map((persona) => persona.style.hardMaxWords))).toBeGreaterThanOrEqual(44);
    expect(Math.min(...PERSONAS.map((persona) => persona.style.hardMaxWords))).toBeLessThanOrEqual(18);
  });

  it("renders compact anti-assistant prompt notes without making traits mandatory", () => {
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const note = buildPersonaStylePromptNote(mira);
    expect(note).toContain("Stable voice for Mira");
    expect(note).toContain("usually 5–26 words");
    expect(note).toContain("Do not perform every trait every time");
    expect(note).toContain("at most one per message");
    expect(note).toContain("“here's the thing”");
    for (const phrase of GENERIC_ASSISTANT_PHRASES) expect(note).toContain(`“${phrase}”`);
    expect(note.length).toBeLessThan(2_400);
  });

  it("uses the same identity in voice while honoring the tighter spoken ceiling", () => {
    const ibrahim = PERSONAS.find((persona) => persona.id === "ai-ibrahim")!;
    const moss = PERSONAS.find((persona) => persona.id === "ai-moss")!;
    expect(buildPersonaStylePromptNote(ibrahim, { medium: "voice" })).toContain("hard maximum 25 words");
    expect(buildPersonaStylePromptNote(moss, { medium: "voice" })).toContain("hard maximum 16 words");
  });

  it("builds a note map with no missing or duplicate persona keys", () => {
    const notes = buildPersonaStylePromptNotes(PERSONAS);
    expect(Object.keys(notes)).toHaveLength(PERSONAS.length);
    for (const persona of PERSONAS) expect(notes[persona.id]).toContain(`Stable voice for ${persona.name}`);
  });
});
