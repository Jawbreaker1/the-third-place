import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";
import {
  PIPER_PROVIDER_VOICES,
  PERSONA_VOICE_PROFILES,
  configuredPersonaProviderVoices,
  voiceProfileForPersona,
} from "./personaVoices.js";

describe("resident voice profiles", () => {
  it("gives every resident one explicit stable profile without a global fallback", () => {
    const personaIds = PERSONAS.map((persona) => persona.id).sort();
    expect(Object.keys(PERSONA_VOICE_PROFILES).sort()).toEqual(personaIds);
    expect(PERSONAS).toHaveLength(20);
    for (const persona of PERSONAS) {
      const profile = voiceProfileForPersona(persona.id);
      expect(profile, persona.id).toBeDefined();
      expect(profile?.language).toBe("sv-SE");
      expect(PIPER_PROVIDER_VOICES).toContain(profile?.providerVoice);
      expect(profile?.speed).toBeGreaterThanOrEqual(0.85);
      expect(profile?.speed).toBeLessThanOrEqual(1.15);
      expect(profile?.browserRate).toBeGreaterThanOrEqual(0.85);
      expect(profile?.browserRate).toBeLessThanOrEqual(1.15);
      expect(profile?.browserPitch).toBeGreaterThanOrEqual(0.75);
      expect(profile?.browserPitch).toBeLessThanOrEqual(1.15);
    }
    expect(voiceProfileForPersona("ai-future-resident")).toBeUndefined();
  });

  it("only advertises provider aliases that the cast actually uses", () => {
    expect(configuredPersonaProviderVoices().sort()).toEqual([
      "lisa-bright",
      "lisa-calm",
      "lisa-dry",
      "lisa-warm",
      "nst-brisk",
      "nst-calm",
      "nst-deep",
      "nst-dry",
    ]);
  });
});
