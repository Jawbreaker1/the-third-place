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
  /** Provider voice ID already allowed by the server-side speech service. */
  providerVoice: string;
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

let adminLanguageVoices: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});

/** Replaces only server-validated voice IDs; provider credentials never enter this map. */
export const setAdminPersonaVoiceMappings = (
  mappings: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void => {
  adminLanguageVoices = Object.freeze(Object.fromEntries(
    Object.entries(mappings).map(([personaId, voices]) => [personaId, Object.freeze({ ...voices })]),
  ));
};

const mappedVoice = (personaId: string, language?: string): string | undefined => {
  const voices = adminLanguageVoices[personaId];
  if (!voices) return undefined;
  const canonical = language?.trim();
  const base = canonical?.split("-")[0];
  return (canonical ? voices[canonical] ?? voices[canonical.toLocaleLowerCase()] : undefined)
    ?? (base ? voices[base] : undefined)
    ?? voices["*"];
};

/** Returns only an administrator-selected, server-validated provider voice. */
export const mappedProviderVoiceForPersona = (personaId: string, language?: string): string | undefined =>
  mappedVoice(personaId, language);

export const voiceProfileForPersona = (personaId: string, language?: string): PersonaVoiceProfile | undefined => {
  const configured = mappedVoice(personaId, language);
  const base = PERSONA_VOICE_PROFILES[personaId];
  if (!configured) return base;
  return {
    providerVoice: configured,
    speed: base?.speed ?? 1,
    browserRate: base?.browserRate ?? 1,
    browserPitch: base?.browserPitch ?? 1,
  };
};

export const configuredPersonaProviderVoices = (model: string | undefined): string[] =>
  model?.trim().toLocaleLowerCase() === "piper-sv"
    ? [...new Set([
        ...Object.values(PERSONA_VOICE_PROFILES).map((profile) => profile.providerVoice),
        ...Object.values(adminLanguageVoices).flatMap((voices) => Object.values(voices)),
      ])]
    : [];

const validProviderVoiceId = (value: string): boolean =>
  value.length <= 80 && /^[\p{L}\p{N}._:-]+$/u.test(value);

/** Public configuration IDs only; credentials and provider URLs are never included. */
export const configuredProviderVoiceIds = (
  model: string | undefined,
  defaultVoice: string | undefined,
  configuredVoices: string | undefined,
): string[] => {
  if (model?.trim().toLocaleLowerCase() === "piper-sv") return [...PIPER_PROVIDER_VOICES];
  const values = [
    ...(configuredVoices?.split(",") ?? []),
    ...(defaultVoice ? [defaultVoice] : []),
  ].map((value) => value.normalize("NFKC").trim()).filter(Boolean);
  if (values.length > 64 || values.some((value) => !validProviderVoiceId(value))) {
    throw new TypeError("TTS_VOICES contains an invalid provider voice ID");
  }
  return [...new Set(values)];
};
