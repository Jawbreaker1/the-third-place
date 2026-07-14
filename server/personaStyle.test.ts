import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";
import {
  buildPersonaStylePromptNote,
  buildPersonaStylePromptNotes,
  derivePersonaStyleTurnPolicy,
  PERSONA_SURFACE_TEXTURES,
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
      expect(style.visibleAffectRate, persona.id).toBeGreaterThanOrEqual(0);
      expect(style.visibleAffectRate, persona.id).toBeLessThanOrEqual(1);
      expect(style.surfaceTextureRate, persona.id).toBeGreaterThanOrEqual(0);
      expect(style.surfaceTextureRate, persona.id).toBeLessThan(0.5);
      expect(style.surfaceTexturePalette.length, persona.id).toBeGreaterThan(0);
      expect(new Set(style.surfaceTexturePalette).size, persona.id).toBe(style.surfaceTexturePalette.length);
      for (const texture of style.surfaceTexturePalette) {
        expect(PERSONA_SURFACE_TEXTURES, persona.id).toContain(texture);
      }
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
    expect(unique(PERSONAS.map((persona) => persona.style.visibleAffectRate))).toBe(PERSONAS.length);
    expect(unique(PERSONAS.map((persona) => persona.style.surfaceTextureRate))).toBe(PERSONAS.length);
    expect(new Set(PERSONAS.flatMap((persona) => persona.style.surfaceTexturePalette))).toEqual(
      new Set(PERSONA_SURFACE_TEXTURES),
    );
    expect(Math.max(...PERSONAS.map((persona) => persona.style.visibleAffectRate))).toBeGreaterThanOrEqual(0.7);
    expect(Math.min(...PERSONAS.map((persona) => persona.style.visibleAffectRate))).toBeLessThanOrEqual(0.1);
    expect(Math.max(...PERSONAS.map((persona) => persona.style.surfaceTextureRate))).toBeLessThan(0.5);
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
    expect(note).toContain("Never alter or misspell names, handles, code, URLs");
    expect(note.length).toBeLessThan(3_000);
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
    expect(policies.filter((policy) => policy.visibleAffect).length).toBeGreaterThan(200);
    expect(policies.filter((policy) => policy.visibleAffect).length).toBeLessThan(300);
    expect(policies.filter((policy) => policy.surfaceTexture).length).toBeGreaterThan(80);
    expect(policies.filter((policy) => policy.surfaceTexture).length).toBeLessThan(160);
    expect(policies.filter((policy) => !policy.surfaceTexture).length).toBeGreaterThan(policies.length / 2);
    expect(policies.filter((policy) => policy.ending === "question-allowed").length).toBeGreaterThan(70);
    expect(policies.filter((policy) => policy.ending === "question-allowed").length).toBeLessThan(170);
    for (const policy of policies) {
      if (policy.habit) expect(mira.style.conversationHabits).toContain(policy.habit);
      if (policy.emoji) expect(mira.style.emojiPalette).toContain(policy.emoji);
      if (policy.surfaceTexture) expect(mira.style.surfaceTexturePalette).toContain(policy.surfaceTexture);
      if (policy.ending === "statement" && policy.habit) {
        const index = mira.style.conversationHabits.indexOf(policy.habit);
        expect(mira.style.questionEndingHabitIndexes ?? []).not.toContain(index);
      }
    }
  });

  it("realizes each persona's affect and texture rates while leaving most turns clean", () => {
    const samples = 2_000;
    for (const persona of PERSONAS) {
      const policies = Array.from({ length: samples }, (_, index) =>
        derivePersonaStyleTurnPolicy(persona, `distribution:${persona.id}:${index}`),
      );
      const affectRate = policies.filter((policy) => policy.visibleAffect).length / samples;
      const textureRate = policies.filter((policy) => policy.surfaceTexture).length / samples;

      expect(Math.abs(affectRate - persona.style.visibleAffectRate), persona.id).toBeLessThan(0.06);
      expect(Math.abs(textureRate - persona.style.surfaceTextureRate), persona.id).toBeLessThan(0.06);
      expect(policies.filter((policy) => !policy.surfaceTexture).length, persona.id).toBeGreaterThan(samples / 2);
      for (const policy of policies) {
        if (policy.surfaceTexture) expect(persona.style.surfaceTexturePalette).toContain(policy.surfaceTexture);
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

  it("filters written-only texture moves out of voice while retaining spoken-safe variation", () => {
    const writtenOnly = new Set(["stretched-emphasis", "rough-orthography", "harmless-typo"]);
    let sawWrittenOnlyTextMove = false;
    let sawSpokenTexture = false;

    for (const persona of PERSONAS) {
      for (let index = 0; index < 2_000; index += 1) {
        const key = `voice-texture:${persona.id}:${index}`;
        const textPolicy = derivePersonaStyleTurnPolicy(persona, key, "text");
        const voicePolicy = derivePersonaStyleTurnPolicy(persona, key, "voice");
        if (textPolicy.surfaceTexture && writtenOnly.has(textPolicy.surfaceTexture)) sawWrittenOnlyTextMove = true;
        if (voicePolicy.surfaceTexture) {
          sawSpokenTexture = true;
          expect(writtenOnly.has(voicePolicy.surfaceTexture), persona.id).toBe(false);
        }
      }
    }

    expect(sawWrittenOnlyTextMove).toBe(true);
    expect(sawSpokenTexture).toBe(true);
  });

  it("exposes at most one optional language-appropriate texture without lexical examples", () => {
    const juno = PERSONAS.find((persona) => persona.id === "ai-juno")!;
    const key = Array.from({ length: 10_000 }, (_, index) => `profanity-policy:${index}`)
      .find((candidate) => derivePersonaStyleTurnPolicy(juno, candidate).surfaceTexture === "mild-profanity")!;
    const policy = derivePersonaStyleTurnPolicy(juno, key);
    const note = buildPersonaStylePromptNote(juno, { turnKey: key });

    expect(policy.surfaceTexture).toBe("mild-profanity");
    expect(note).toContain("One mild, non-targeted adult profanity may appear");
    expect(note).toContain("it is never required");
    expect(note).toContain("natural in the required language and script");
    expect(note).toContain("Never alter or misspell names, handles, code, URLs");
    expect(note.match(/Turn policy \/ surface texture:/gu)).toHaveLength(1);
  });

  it("lets a trusted room override replace a clean persona turn with one bounded strong-language target", () => {
    const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const key = "the-pub:maximum-explicitness";
    const ordinary = buildPersonaStylePromptNote(mira, { turnKey: key });
    const targeted = buildPersonaStylePromptNote(mira, {
      turnKey: key,
      surfaceTextureOverride: "strong-profanity",
      stanceIntensity: "forceful",
      explicitnessTarget: "strong",
    });

    expect(targeted).toContain("one natural, non-targeted strong adult profanity");
    expect(targeted).toContain("scene's one strong-language target");
    expect(targeted).toContain("make it forceful, terse and unmistakable");
    expect(targeted).not.toContain("Keep this message's surface clean");
    expect(ordinary).not.toContain("scene's one strong-language target");
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
