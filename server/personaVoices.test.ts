import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";
import {
  PIPER_PROVIDER_VOICES,
  PERSONA_VOICE_PROFILES,
  configuredProviderVoiceIds,
  configuredPersonaProviderVoices,
  mappedProviderVoiceForPersona,
  setAdminPersonaVoiceMappings,
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

  it("only advertises cast aliases to the bundled Piper provider", () => {
    expect(configuredPersonaProviderVoices("piper-sv").sort()).toEqual([
      "lisa-bright",
      "lisa-calm",
      "lisa-dry",
      "lisa-warm",
      "nst-brisk",
      "nst-calm",
      "nst-deep",
      "nst-dry",
    ]);
    expect(configuredPersonaProviderVoices("generic-multilingual")).toEqual([]);
    expect(configuredPersonaProviderVoices(undefined)).toEqual([]);
  });

  it("bounds generic provider allowlists and selects validated per-language mappings", () => {
    expect(configuredProviderVoiceIds("generic-multilingual", "default", "sv-one, en-one,sv-one")).toEqual([
      "sv-one",
      "en-one",
      "default",
    ]);
    expect(() => configuredProviderVoiceIds("generic", "default", "not a valid voice"))
      .toThrow("invalid provider voice ID");

    setAdminPersonaVoiceMappings({
      "ai-sana": { sv: "sv-one", "en-US": "en-one", "*": "default" },
    });
    try {
      expect(mappedProviderVoiceForPersona("ai-sana", "sv-SE")).toBe("sv-one");
      expect(mappedProviderVoiceForPersona("ai-sana", "en-US")).toBe("en-one");
      expect(mappedProviderVoiceForPersona("ai-sana", "ja-JP")).toBe("default");
      expect(voiceProfileForPersona("ai-sana", "sv-SE")?.providerVoice).toBe("sv-one");
    } finally {
      setAdminPersonaVoiceMappings({});
    }
  });
});
