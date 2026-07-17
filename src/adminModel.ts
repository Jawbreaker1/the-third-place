import type {
  AdminAutonomousResearchDiagnostics,
  AdminBanRecord,
  AdminBehaviorTuning,
  AdminChannelConfig,
  AdminHumanMember,
  AdminPersonaConfig,
  AdminPersonaCore,
  AdminPresence,
  AdminStateSnapshot,
  AdminVoiceOption,
  AdminVoiceOptions,
} from "../shared/adminTypes";

export const DEFAULT_ADMIN_TUNING: AdminBehaviorTuning = {
  activity: 50,
  autonomousLinkFrequency: 60,
  competence: 50,
  aggression: 25,
  explicitness: 50,
};

export const DEFAULT_PERSONA_CORE: AdminPersonaCore = {
  talkativeness: 50,
  warmth: 50,
  curiosity: 50,
  mischief: 30,
  conscientiousness: 50,
  disagreement: 35,
};

export interface PersonaVoiceChoice {
  id: string;
  label: string;
  unavailable: boolean;
}

const voiceSupportsLanguage = (voice: AdminVoiceOption, language: string): boolean =>
  language === "*" ||
  voice.languages.length === 0 ||
  voice.languages.includes(language) ||
  voice.languages.some((tag) => language.startsWith(`${tag}-`) || tag.startsWith(`${language}-`));

/**
 * Keeps a persisted mapping visible even when its provider is offline or its
 * current language inventory no longer includes the mapped language. The
 * disabled fallback prevents an unrelated persona edit from appearing to drop
 * the saved value while still preventing it from being newly selected.
 */
export function personaVoiceChoices(
  voices: readonly AdminVoiceOption[],
  language: string,
  selectedVoiceId?: string,
): PersonaVoiceChoice[] {
  const compatible = voices
    .filter((voice) => voiceSupportsLanguage(voice, language))
    .map((voice) => ({ id: voice.id, label: voice.label, unavailable: false }));
  const selected = selectedVoiceId?.trim();
  if (!selected || compatible.some((voice) => voice.id === selected)) return compatible;

  const configured = voices.find((voice) => voice.id === selected);
  return [
    ...compatible,
    {
      id: selected,
      label: `${configured?.label ?? selected} (unavailable)`,
      unavailable: true,
    },
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asString = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const asOptionalString = (value: unknown): string | undefined => {
  const text = asString(value).trim();
  return text || undefined;
};
const asBoolean = (value: unknown, fallback = false): boolean => typeof value === "boolean" ? value : fallback;
const nonNegativeInteger = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

export const clampAdminPercent = (value: unknown, fallback = 50): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.max(0, Math.min(100, parsed))) : fallback;
};

const stringArray = (value: unknown): string[] => Array.from(new Set(
  asArray(value).map((entry) => asString(entry).trim()).filter(Boolean),
));

const stringRecord = (value: unknown): Record<string, string> => Object.fromEntries(
  Object.entries(asRecord(value))
    .map(([key, entry]) => [key.trim(), asString(entry).trim()] as const)
    .filter(([key, entry]) => Boolean(key && entry)),
);

const percentRecord = (value: unknown): Record<string, number> => Object.fromEntries(
  Object.entries(asRecord(value))
    .map(([key, entry]) => [key.trim(), clampAdminPercent(entry)] as const)
    .filter(([key]) => Boolean(key)),
);

export function normalizeAdminTuning(
  value: unknown,
  fallback: AdminBehaviorTuning = DEFAULT_ADMIN_TUNING,
): AdminBehaviorTuning {
  const input = asRecord(value);
  return {
    activity: clampAdminPercent(input.activity, fallback.activity),
    autonomousLinkFrequency: clampAdminPercent(
      input.autonomousLinkFrequency,
      fallback.autonomousLinkFrequency,
    ),
    competence: clampAdminPercent(input.competence, fallback.competence),
    aggression: clampAdminPercent(input.aggression, fallback.aggression),
    explicitness: clampAdminPercent(input.explicitness, fallback.explicitness),
  };
}

export function normalizePersonaCore(value: unknown): AdminPersonaCore {
  const input = asRecord(value);
  return {
    talkativeness: clampAdminPercent(input.talkativeness, DEFAULT_PERSONA_CORE.talkativeness),
    warmth: clampAdminPercent(input.warmth, DEFAULT_PERSONA_CORE.warmth),
    curiosity: clampAdminPercent(input.curiosity, DEFAULT_PERSONA_CORE.curiosity),
    mischief: clampAdminPercent(input.mischief, DEFAULT_PERSONA_CORE.mischief),
    conscientiousness: clampAdminPercent(input.conscientiousness, DEFAULT_PERSONA_CORE.conscientiousness),
    disagreement: clampAdminPercent(input.disagreement, DEFAULT_PERSONA_CORE.disagreement),
  };
}

const normalizePersona = (value: unknown, index: number): AdminPersonaConfig => {
  const input = asRecord(value);
  const identity = asRecord(input.identity);
  return {
    id: asString(input.id, `persona-${index + 1}`),
    name: asString(input.name ?? identity.name, `Persona ${index + 1}`),
    role: asString(input.role ?? identity.role),
    bio: asString(input.bio ?? identity.bio),
    prompt: asString(input.prompt ?? input.behaviorPrompt),
    ...(asOptionalString(input.avatarImageUrl ?? asRecord(input.avatar).imageUrl)
      ? { avatarImageUrl: asOptionalString(input.avatarImageUrl ?? asRecord(input.avatar).imageUrl) }
      : {}),
    core: normalizePersonaCore(input.core ?? input.sliders),
    canResearch: asBoolean(input.canResearch ?? input.researchEnabled),
    roomAffinities: percentRecord(input.roomAffinities ?? input.affinities),
    voices: stringRecord(input.voices ?? input.voiceMappings),
  };
};

const normalizeChannel = (value: unknown, index: number): AdminChannelConfig => {
  const input = asRecord(value);
  const identity = asRecord(input.identity);
  const topic = input.topic;
  return {
    id: asString(input.id, `channel-${index + 1}`),
    name: asString(input.name ?? identity.name, `channel-${index + 1}`),
    description: asString(input.description ?? identity.description),
    icon: asString(input.icon ?? identity.icon, "#"),
    topic: typeof topic === "string" ? topic : asString(asRecord(topic).brief),
    guidance: asString(input.guidance ?? input.conversationGuidance),
    register: input.register === "banter" || input.register === "technical" || input.register === "analytical" || input.register === "fandom" || input.register === "studio"
      ? input.register
      : input.conversationRegister === "banter" || input.conversationRegister === "technical" || input.conversationRegister === "analytical" || input.conversationRegister === "fandom" || input.conversationRegister === "studio"
        ? input.conversationRegister
        : "everyday",
    mode: input.mode === "casual" || input.mode === "banter"
      ? input.mode
      : input.ambientMode === "casual" || input.ambientMode === "banter"
        ? input.ambientMode
        : "discussion",
    seeds: stringArray(input.seeds ?? input.ambientPremises),
  };
};

const normalizePresence = (value: unknown): AdminPresence =>
  value === "online" || value === "idle" || value === "dnd" || value === "offline" ? value : "offline";

const normalizeHuman = (value: unknown, index: number): AdminHumanMember => {
  const input = asRecord(value);
  return {
    id: asString(input.id ?? input.memberId, `human-${index + 1}`),
    name: asString(input.name, `Guest ${index + 1}`),
    status: normalizePresence(input.status),
    ...(typeof input.recoveryConfigured === "boolean" ? { recoveryConfigured: input.recoveryConfigured } : {}),
    ...(asOptionalString(input.activeChannelId) ? { activeChannelId: asOptionalString(input.activeChannelId) } : {}),
    ...(asOptionalString(input.joinedAt) ? { joinedAt: asOptionalString(input.joinedAt) } : {}),
  };
};

const normalizeBan = (value: unknown, index: number): AdminBanRecord => {
  const input = asRecord(value);
  return {
    memberId: asString(input.memberId ?? input.id, `banned-${index + 1}`),
    name: asString(input.name, `Banned member ${index + 1}`),
    ...(asOptionalString(input.reason) ? { reason: asOptionalString(input.reason) } : {}),
    bannedAt: asString(input.bannedAt, new Date(0).toISOString()),
  };
};

const normalizeVoiceOption = (value: unknown, index: number): AdminVoiceOption => {
  if (typeof value === "string") return { id: value, label: value, languages: [] };
  const input = asRecord(value);
  const id = asString(input.id ?? input.voiceId, `voice-${index + 1}`);
  return {
    id,
    label: asString(input.label ?? input.name, id),
    languages: stringArray(input.languages ?? input.languageTags),
  };
};

const normalizeVoiceOptions = (value: unknown, personas: AdminPersonaConfig[]): AdminVoiceOptions => {
  const input = asRecord(value);
  const voices = asArray(input.voices ?? value).map(normalizeVoiceOption);
  const mappedLanguages = personas.flatMap((persona) => Object.keys(persona.voices));
  const voiceLanguages = voices.flatMap((voice) => voice.languages);
  return {
    languages: Array.from(new Set([...stringArray(input.languages), ...mappedLanguages, ...voiceLanguages])).sort(),
    voices,
  };
};

const normalizeAutonomousResearchDiagnostics = (
  value: unknown,
): AdminAutonomousResearchDiagnostics | undefined => {
  if (!isRecord(value)) return undefined;
  const failure = asRecord(value.lastFailure);
  const channelId = asOptionalString(failure.channelId);
  const seedId = asOptionalString(failure.seedId);
  const reason = asOptionalString(failure.reason);
  const failedAt = nonNegativeInteger(failure.failedAt);
  const retryAfterAt = nonNegativeInteger(failure.retryAfterAt);
  return {
    attempts: nonNegativeInteger(value.attempts),
    published: nonNegativeInteger(value.published),
    failed: nonNegativeInteger(value.failed),
    ...(channelId && seedId && reason && failedAt > 0 && retryAfterAt > 0
      ? {
          lastFailure: {
            channelId,
            seedId,
            reason,
            failedAt,
            retryAfterAt,
            consecutiveFailures: Math.max(1, nonNegativeInteger(failure.consecutiveFailures)),
          },
        }
      : {}),
  };
};

export function normalizeAdminState(value: unknown): AdminStateSnapshot {
  const envelope = asRecord(value);
  const root = isRecord(envelope.state) ? envelope.state : envelope;
  const behavior = asRecord(root.behavior);
  const global = normalizeAdminTuning(behavior.global ?? root.globalTuning ?? root.global);
  const channelInput = asRecord(behavior.channels ?? root.channelTunings ?? root.roomTunings);
  const channelTunings = Object.fromEntries(
    Object.entries(channelInput).map(([channelId, tuning]) => [channelId, normalizeAdminTuning(tuning, global)]),
  );
  const personas = asArray(root.personas).map(normalizePersona);
  const automation = asRecord(root.automation);
  const autonomousResearch = normalizeAutonomousResearchDiagnostics(automation.autonomousResearch);
  return {
    behavior: { global, channels: channelTunings },
    automation: {
      autonomousLinkChannelIds: stringArray(automation.autonomousLinkChannelIds),
      ...(autonomousResearch ? { autonomousResearch } : {}),
    },
    personas,
    channels: asArray(root.channels).map(normalizeChannel),
    humans: asArray(root.humans).map(normalizeHuman),
    bans: asArray(root.bans).map(normalizeBan),
    voiceOptions: normalizeVoiceOptions(root.voiceOptions, personas),
    ...(asOptionalString(root.revision) ? { revision: asOptionalString(root.revision) } : {}),
  };
}

export function createPersonaDraft(index: number): AdminPersonaConfig {
  return {
    id: `ai-new-persona-${index}`,
    name: "New resident",
    role: "Resident",
    bio: "",
    prompt: "",
    core: { ...DEFAULT_PERSONA_CORE },
    canResearch: false,
    roomAffinities: {},
    voices: {},
  };
}

export function createChannelDraft(index: number): AdminChannelConfig {
  return {
    id: `new-channel-${index}`,
    name: `new-channel-${index}`,
    description: "",
    icon: "#",
    topic: "",
    guidance: "",
    register: "everyday",
    mode: "discussion",
    seeds: [],
  };
}

/**
 * Keep only administrator-authored affinity overrides for rooms that still
 * exist. Missing entries intentionally remain missing: the server derives a
 * resident-specific affinity from personality and expertise in that case.
 */
export function activePersonaRoomAffinities(
  affinities: AdminPersonaConfig["roomAffinities"],
  channels: readonly Pick<AdminChannelConfig, "id">[],
): AdminPersonaConfig["roomAffinities"] {
  const activeIds = new Set(channels.map((channel) => channel.id));
  return Object.fromEntries(
    Object.entries(affinities).filter(([channelId]) => activeIds.has(channelId)),
  );
}

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}
