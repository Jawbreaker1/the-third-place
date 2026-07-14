import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";
import {
  buildPersonaStylePromptNote,
  buildPersonaStylePromptNotes,
  derivePersonaStyleTurnPolicy,
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
      for (const index of style.questionEndingHabitIndexes ?? []) {
        expect(Number.isInteger(index), persona.id).toBe(true);
        expect(index, persona.id).toBeGreaterThanOrEqual(0);
        expect(index, persona.id).toBeLessThan(style.conversationHabits.length);
      }
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
    expect(note).toContain("generic service-assistant validation");
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

  it("derives stable per-turn budgets without turning probabilities into prompt tics", () => {
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const keys = Array.from({ length: 400 }, (_, index) => `lobby:scene-${index}`);
    const policies = keys.map((key) => derivePersonaStyleTurnPolicy(mira, key));

    expect(derivePersonaStyleTurnPolicy(mira, keys[37]!)).toEqual(
      derivePersonaStyleTurnPolicy(mira, keys[37]!),
    );
    expect(policies.filter((policy) => policy.emoji).length).toBeGreaterThan(0);
    expect(policies.filter((policy) => policy.emoji).length).toBeLessThan(50);
    expect(policies.filter((policy) => policy.habit).length).toBeGreaterThan(70);
    expect(policies.filter((policy) => policy.habit).length).toBeLessThan(170);
    expect(policies.filter((policy) => policy.ending === "question-allowed").length).toBeGreaterThan(70);
    expect(policies.filter((policy) => policy.ending === "question-allowed").length).toBeLessThan(170);
    for (const policy of policies) {
      if (policy.habit) expect(mira.style.conversationHabits).toContain(policy.habit);
      if (policy.emoji) expect(mira.style.emojiPalette).toContain(policy.emoji);
      if (policy.ending === "statement" && policy.habit) {
        const index = mira.style.conversationHabits.indexOf(policy.habit);
        expect(mira.style.questionEndingHabitIndexes ?? []).not.toContain(index);
      }
    }
  });

  it("shows the model at most one optional habit and an explicit ending budget", () => {
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const keys = Array.from({ length: 200 }, (_, index) => `ai-lab:turn-${index}`);
    const noHabitKey = keys.find((key) => !derivePersonaStyleTurnPolicy(mira, key).habit)!;
    const oneHabitKey = keys.find((key) => derivePersonaStyleTurnPolicy(mira, key).habit)!;
    const noHabitNote = buildPersonaStylePromptNote(mira, { turnKey: noHabitKey });
    const oneHabitPolicy = derivePersonaStyleTurnPolicy(mira, oneHabitKey);
    const oneHabitNote = buildPersonaStylePromptNote(mira, { turnKey: oneHabitKey });

    expect(noHabitNote).toContain("Turn policy / habit: Use no signature habit");
    for (const habit of mira.style.conversationHabits) expect(noHabitNote).not.toContain(`“${habit}”`);
    expect(oneHabitNote).toContain(`The only signature habit permitted is “${oneHabitPolicy.habit}”`);
    for (const habit of mira.style.conversationHabits) {
      if (habit !== oneHabitPolicy.habit) expect(oneHabitNote).not.toContain(`“${habit}”`);
    }
    expect(oneHabitNote).toMatch(/Turn policy \/ ending: (?:A genuine question|End with a statement)/u);
  });

  it("forbids emoji in voice even on a text turn whose deterministic budget permits one", () => {
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const key = Array.from({ length: 1_000 }, (_, index) => `voice-candidate-${index}`)
      .find((candidate) => derivePersonaStyleTurnPolicy(mira, candidate, "text").emoji)!;

    expect(derivePersonaStyleTurnPolicy(mira, key, "text").emoji).toBeTruthy();
    expect(derivePersonaStyleTurnPolicy(mira, key, "voice").emoji).toBeUndefined();
    expect(buildPersonaStylePromptNote(mira, { medium: "voice", turnKey: key }))
      .toContain("Turn policy / emoji: Use no emoji");
  });

  it("lets an explicit scene role require one question while keeping the emoji budget deterministic", () => {
    const vale = PERSONAS.find((persona) => persona.id === "ai-vale")!;
    const key = "considered-response-question";
    const ordinary = buildPersonaStylePromptNote(vale, { turnKey: key });
    const required = buildPersonaStylePromptNote(vale, {
      turnKey: key,
      endingOverride: "question-required",
    });

    expect(required).toContain("End with exactly one precise, genuine question required by this scene role");
    expect(required).not.toContain("do not ask a question in this message");
    expect(required.split("\n").find((line) => line.startsWith("- Turn policy / emoji:"))).toBe(
      ordinary.split("\n").find((line) => line.startsWith("- Turn policy / emoji:")),
    );
    expect(derivePersonaStyleTurnPolicy(vale, key, "text", "question-required")).toEqual(
      derivePersonaStyleTurnPolicy(vale, key, "text", "question-required"),
    );
    expect(required.match(/The only signature habit permitted/gu)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("uses explicit habit metadata instead of parsing English wording", () => {
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const key = Array.from({ length: 5_000 }, (_, index) => `question-habit-${index}`)
      .find((candidate) => derivePersonaStyleTurnPolicy(mira, candidate).habit?.includes("ask"))!;
    const ordinary = derivePersonaStyleTurnPolicy(mira, key);
    const statement = derivePersonaStyleTurnPolicy(mira, key, "text", "statement");
    const note = buildPersonaStylePromptNote(mira, { turnKey: key, endingOverride: "statement" });

    expect(ordinary.habit).toContain("ask");
    expect(statement.habit).not.toBe(ordinary.habit);
    expect(note).toContain("do not ask a question in this message");
    expect(note).not.toContain("ask a sharp follow-up");
  });
});
