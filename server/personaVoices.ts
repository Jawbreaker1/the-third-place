export const PIPER_PROVIDER_VOICES = [
  "lisa",
  "lisa-warm",
  "lisa-bright",
  "lisa-calm",
  "lisa-dry",
  "nst",
  "nst-deep",
  "nst-calm",
  "nst-dry",
  "nst-brisk",
] as const;

export type PiperProviderVoice = (typeof PIPER_PROVIDER_VOICES)[number];

export interface PersonaVoiceProfile {
  language: "sv-SE";
  providerVoice: PiperProviderVoice;
  speed: number;
  browserRate: number;
  browserPitch: number;
}

const voiceProfile = (
  providerVoice: PiperProviderVoice,
  speed: number,
  browserRate: number,
  browserPitch: number,
): PersonaVoiceProfile => Object.freeze({
  language: "sv-SE",
  providerVoice,
  speed,
  browserRate,
  browserPitch,
});

/**
 * Stable, hand-authored voices for the resident cast. These are intentionally
 * keyed by persona rather than inferred from names or avatars at runtime.
 */
export const PERSONA_VOICE_PROFILES: Readonly<Record<string, PersonaVoiceProfile>> = Object.freeze({
  "ai-mira": voiceProfile("lisa-bright", 1.08, 1.06, 1.08),
  "ai-bosse": voiceProfile("nst-dry", 1.02, 0.99, 0.86),
  "ai-sana": voiceProfile("lisa-warm", 0.98, 0.97, 1),
  "ai-nox": voiceProfile("lisa-calm", 0.9, 0.9, 0.84),
  "ai-linnea": voiceProfile("lisa-dry", 1, 0.98, 0.94),
  "ai-runa": voiceProfile("lisa-calm", 0.94, 0.92, 0.91),
  "ai-kim": voiceProfile("nst-brisk", 1.06, 1.04, 0.96),
  "ai-vale": voiceProfile("lisa-dry", 0.97, 0.95, 0.92),
  "ai-pixel": voiceProfile("lisa-bright", 1.04, 1.05, 1.1),
  "ai-otto": voiceProfile("nst-deep", 0.92, 0.9, 0.8),
  "ai-juno": voiceProfile("lisa-bright", 1.04, 1.03, 1.06),
  "ai-ibrahim": voiceProfile("nst-calm", 0.94, 0.92, 0.88),
  "ai-tess": voiceProfile("lisa-warm", 1, 0.98, 1.01),
  "ai-moss": voiceProfile("lisa-calm", 0.9, 0.9, 0.9),
  "ai-zed": voiceProfile("nst-dry", 1, 0.98, 0.9),
  "ai-bea": voiceProfile("lisa-bright", 1.06, 1.04, 1.08),
  "ai-elio": voiceProfile("nst-calm", 0.97, 0.95, 0.92),
  "ai-farah": voiceProfile("lisa-dry", 0.98, 0.96, 0.94),
  "ai-aya": voiceProfile("lisa-calm", 0.95, 0.94, 0.96),
  "ai-robin": voiceProfile("nst-calm", 1.01, 1, 1.02),
});

export const voiceProfileForPersona = (personaId: string): PersonaVoiceProfile | undefined =>
  PERSONA_VOICE_PROFILES[personaId];

export const configuredPersonaProviderVoices = (): PiperProviderVoice[] =>
  [...new Set(Object.values(PERSONA_VOICE_PROFILES).map((profile) => profile.providerVoice))];
