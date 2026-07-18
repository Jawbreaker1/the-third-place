import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type {
  AdminBanRecord,
  AdminBehaviorTuning,
  AdminChannelConfig,
  AdminHumanMember,
  AdminPersonaConfig,
  AdminStateSnapshot,
  AdminVoiceOptions,
} from "../shared/adminTypes.js";
import { stripDangerousTextControls, unicodeCaselessKey } from "../shared/unicodeSafety.js";
import {
  CHANNEL_PROFILES,
  CHANNELS,
  type AmbientMode,
  type ChannelProfile,
  type ConversationRegister,
} from "./channels.js";
import { PERSONAS, type Persona } from "./personas.js";
import { PERSONA_VOICE_PROFILES, setAdminPersonaVoiceMappings } from "./personaVoices.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";
import { DEFAULT_RUNTIME_BEHAVIOR_TUNING } from "./behaviorTuning.js";
import { participantIdentityKey } from "./participantIdentity.js";

const percent = z.number().int().min(0).max(100);
const tuningSchema = z.object({
  activity: percent,
  autonomousLinkFrequency: percent,
  competence: percent,
  aggression: percent,
  explicitness: percent,
}).strict();

const cleanText = (minimum: number, maximum: number) => z.string().max(maximum).transform((value, context) => {
  const cleaned = stripDangerousTextControls(value.normalize("NFKC")).replace(/\s+/gu, " ").trim();
  if (cleaned.length < minimum) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Must contain at least ${minimum} visible characters` });
    return z.NEVER;
  }
  return cleaned;
});
const catalogId = z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9-]*$/u);
const personaId = catalogId.refine((value) => value.startsWith("ai-"), "Persona IDs must start with ai-");
const affinitySchema = z.record(catalogId, percent).superRefine((value, context) => {
  if (Object.keys(value).length > 80) context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many room affinities" });
});
const voicesSchema = z.record(z.string().min(1).max(35), z.string().min(1).max(80)).superRefine((value, context) => {
  if (Object.keys(value).length > 32) context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many language voice mappings" });
});

export const adminPersonaSchema: z.ZodType<AdminPersonaConfig> = z.object({
  id: personaId,
  name: cleanText(1, 48),
  role: cleanText(1, 100),
  bio: cleanText(1, 300),
  prompt: cleanText(12, 4_000),
  avatarImageUrl: z.string().max(300).refine(
    (value) => value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"),
    "Avatar images must be same-origin paths",
  ).optional(),
  core: z.object({
    talkativeness: percent,
    warmth: percent,
    curiosity: percent,
    mischief: percent,
    conscientiousness: percent,
    disagreement: percent,
  }).strict(),
  canResearch: z.boolean(),
  roomAffinities: affinitySchema,
  voices: voicesSchema,
}).strict();

const registerSchema = z.enum(["everyday", "banter", "technical", "analytical", "fandom", "studio"]);
const modeSchema = z.enum(["discussion", "casual", "banter"]);
export const adminChannelSchema: z.ZodType<AdminChannelConfig> = z.object({
  id: catalogId,
  name: cleanText(1, 48),
  description: cleanText(1, 180),
  icon: cleanText(1, 8),
  topic: cleanText(4, 500),
  guidance: cleanText(4, 2_000),
  register: registerSchema,
  mode: modeSchema,
  seeds: z.array(cleanText(8, 700)).min(1).max(40).superRefine((values, context) => {
    const unique = new Set(values.map(unicodeCaselessKey));
    if (unique.size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Channel seeds must be unique" });
  }),
}).strict();

// The new field is optional only at the HTTP compatibility boundary so an
// already-open older Admin page does not erase a live value on save. State on
// disk and snapshots remain complete and strict.
const tuningPatchSchema = tuningSchema.partial({ autonomousLinkFrequency: true });
export const adminBehaviorPatchSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global"), tuning: tuningPatchSchema }).strict(),
  z.object({ scope: z.literal("channel"), channelId: catalogId, tuning: tuningPatchSchema.nullable() }).strict(),
]);

const banSchema: z.ZodType<AdminBanRecord> = z.object({
  memberId: z.string().min(1).max(100),
  name: cleanText(1, 48),
  reason: cleanText(1, 240).optional(),
  bannedAt: z.string().datetime(),
}).strict();

const persistedSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().min(0),
  behavior: z.object({
    global: tuningSchema,
    channels: z.record(catalogId, tuningSchema),
  }).strict(),
  personaOverrides: z.record(personaId, adminPersonaSchema),
  customPersonas: z.array(adminPersonaSchema).max(80),
  disabledPersonaIds: z.array(personaId).max(160),
  channelOverrides: z.record(catalogId, adminChannelSchema),
  customChannels: z.array(adminChannelSchema).max(80),
  disabledChannelIds: z.array(catalogId).max(160),
  bans: z.array(banSchema).max(2_000),
}).strict().superRefine((value, context) => {
  for (const [id, persona] of Object.entries(value.personaOverrides)) {
    if (id !== persona.id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["personaOverrides", id], message: "Override key must match persona ID" });
  }
  for (const [id, channel] of Object.entries(value.channelOverrides)) {
    if (id !== channel.id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["channelOverrides", id], message: "Override key must match channel ID" });
  }
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (!unique(value.disabledPersonaIds)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["disabledPersonaIds"], message: "Disabled persona IDs must be unique" });
  if (!unique(value.disabledChannelIds)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["disabledChannelIds"], message: "Disabled channel IDs must be unique" });
  if (!unique(value.bans.map((ban) => ban.memberId))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["bans"], message: "Ban member IDs must be unique" });
});

type PersistedAdminState = z.infer<typeof persistedSchema>;

const migratePersistedState = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return raw;
  const behavior = record.behavior;
  if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) return raw;
  const behaviorRecord = behavior as Record<string, unknown>;
  const global = behaviorRecord.global;
  if (!global || typeof global !== "object" || Array.isArray(global)) return raw;
  const migratedGlobal = {
    ...(global as Record<string, unknown>),
    autonomousLinkFrequency: DEFAULT_RUNTIME_BEHAVIOR_TUNING.autonomousLinkFrequency,
  };
  const channels = behaviorRecord.channels;
  const migratedChannels = channels && typeof channels === "object" && !Array.isArray(channels)
    ? Object.fromEntries(Object.entries(channels as Record<string, unknown>).map(([channelId, tuning]) => [
        channelId,
        tuning && typeof tuning === "object" && !Array.isArray(tuning)
          ? { ...(tuning as Record<string, unknown>), autonomousLinkFrequency: migratedGlobal.autonomousLinkFrequency }
          : tuning,
      ]))
    : channels;
  const channelOverrides = record.channelOverrides;
  const currentPub = CHANNEL_PROFILES.find((profile) => profile.public.id === "the-pub");
  const migratedChannelOverrides = channelOverrides && typeof channelOverrides === "object" && !Array.isArray(channelOverrides)
    ? Object.fromEntries(Object.entries(channelOverrides as Record<string, unknown>).map(([channelId, config]) => {
        if (
          channelId !== "the-pub" ||
          !config ||
          typeof config !== "object" ||
          Array.isArray(config) ||
          !currentPub
        ) return [channelId, config];
        const pub = config as Record<string, unknown>;
        return [channelId, {
          ...pub,
          ...(pub.topic === LEGACY_V1_PUB_TOPIC ? { topic: currentPub.topic.brief } : {}),
          ...(pub.guidance === LEGACY_V1_PUB_GUIDANCE
            ? { guidance: currentPub.conversationGuidance }
            : {}),
        }];
      }))
    : channelOverrides;
  return {
    ...record,
    version: 2,
    channelOverrides: migratedChannelOverrides,
    behavior: {
      ...behaviorRecord,
      global: migratedGlobal,
      channels: migratedChannels,
    },
  };
};

const DEFAULT_TUNING: AdminBehaviorTuning = { ...DEFAULT_RUNTIME_BEHAVIOR_TUNING };
const LEGACY_V1_PUB_TOPIC =
  "a relaxed Friday hangout for films, music, work gripes, politics, food, links, memes and everyday nonsense";
const LEGACY_V1_PUB_GUIDANCE =
  "This room is loose Friday-table banter, not a panel discussion or themed pub role-play. Convey the looseness through fragments, specific references, overconfident taste, affectionate teasing, small self-corrections, recognizable tangents and uneven participation—not by announcing or explaining the mood. Avoid recurring catchphrases that merely label the room, the day or its vibe in any language. Alcohol is atmosphere, never a recurring subject or personality trait. Autonomous residents never introduce alcohol or invent having consumed it; if a human explicitly makes drinks the topic, at most one selected actor addresses that part once. Very short reactions, groans, punchlines and silence are legitimate. Prefer one specific real film, song, artist, dish or recognizable annoyance over generic enthusiasm or a recommendation list; never invent a work just to fill the scene. Unless the human asks for help, do not turn replies into advice. Job gripes stay general and never invent an employer, profession or lived work history. Current politics, news and releases need supplied research; timeless political opinions remain opinions. React specifically to supplied links, memes and images, but never fabricate a URL or pretend to have opened content that was not supplied. Lowbrow jokes are welcome; never explain a punchline, keep teasing affectionate and never pile on. Laughter usually belongs in reactions; at most one written line per scene may begin with laughter.";
const BUILTIN_PERSONAS = PERSONAS.map((persona) => structuredClone(persona));
const BUILTIN_CHANNEL_PROFILES = CHANNEL_PROFILES.map((profile) => structuredClone(profile));
const BUILTIN_PERSONA_IDS = new Set(BUILTIN_PERSONAS.map((persona) => persona.id));
const BUILTIN_CHANNEL_IDS = new Set(BUILTIN_CHANNEL_PROFILES.map((profile) => profile.public.id));

const emptyState = (): PersistedAdminState => ({
  version: 2,
  revision: 0,
  behavior: { global: { ...DEFAULT_TUNING }, channels: {} },
  personaOverrides: {},
  customPersonas: [],
  disabledPersonaIds: [],
  channelOverrides: {},
  customChannels: [],
  disabledChannelIds: [],
  bans: [],
});

const percentFromUnit = (value: number | undefined, fallback = 50): number =>
  Math.round(Math.max(0, Math.min(1, value ?? fallback / 100)) * 100);
const unitFromPercent = (value: number): number => value / 100;

const personaConfigFromRuntime = (persona: Persona): AdminPersonaConfig => ({
  id: persona.id,
  name: persona.name,
  role: persona.role ?? "AI resident",
  bio: persona.bio ?? "A resident of The Third Place.",
  prompt: persona.prompt,
  ...(persona.avatar.imageUrl ? { avatarImageUrl: persona.avatar.imageUrl } : {}),
  core: {
    talkativeness: percentFromUnit(persona.talkativeness),
    warmth: percentFromUnit(persona.warmth),
    curiosity: percentFromUnit(persona.curiosity),
    mischief: percentFromUnit(persona.mischief),
    conscientiousness: percentFromUnit(persona.conscientiousness),
    disagreement: percentFromUnit(persona.disagreement, 20),
  },
  canResearch: Boolean(persona.canResearch),
  roomAffinities: Object.fromEntries(
    Object.entries(persona.channelAffinity ?? {}).map(([channelId, value]) => [channelId, percentFromUnit(value)]),
  ),
  voices: {},
});

const channelConfigFromRuntime = (profile: ChannelProfile): AdminChannelConfig => ({
  id: profile.public.id,
  name: profile.public.name,
  description: profile.public.description,
  icon: profile.public.icon ?? "#",
  topic: profile.topic.brief,
  guidance: profile.conversationGuidance ?? "Keep the room conversational, specific and relevant to its topic.",
  register: profile.conversationRegister,
  mode: profile.ambientMode ?? "discussion",
  seeds: [...profile.ambientPremises],
});

const stablePalette = (id: string): [string, string] => {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return [`hsl(${hue} 48% 48%)`, `hsl(${(hue + 38) % 360} 65% 68%)`];
};

const runtimePersonaFromConfig = (config: AdminPersonaConfig, base?: Persona): Persona => {
  const [color, accent] = stablePalette(config.id);
  const talk = unitFromPercent(config.core.talkativeness);
  const warmth = unitFromPercent(config.core.warmth);
  const curiosity = unitFromPercent(config.core.curiosity);
  const mischief = unitFromPercent(config.core.mischief);
  const conscientiousness = unitFromPercent(config.core.conscientiousness);
  const disagreement = unitFromPercent(config.core.disagreement);
  const customVisibleAffectRate = Math.max(0.1, Math.min(0.68, 0.1 + warmth * 0.38 + mischief * 0.2));
  const customSurfaceTextureRate = Math.max(
    0.04,
    Math.min(0.4, 0.04 + mischief * 0.22 + (1 - conscientiousness) * 0.12),
  );
  const customSurfaceTexturePalette: Array<Persona["style"]["surfaceTexturePalette"][number]> = [
    "fragment",
    "self-correction",
  ];
  if (mischief >= 0.55) customSurfaceTexturePalette.push("stretched-emphasis", "rough-orthography");
  if (conscientiousness <= 0.45) customSurfaceTexturePalette.push("harmless-typo");
  if (mischief >= 0.7) customSurfaceTexturePalette.push("mild-profanity");
  const persona: Persona = base ? structuredClone(base) : {
    id: config.id,
    name: config.name,
    kind: "ai",
    status: "online",
    avatar: { color, accent, glyph: [...config.name][0]?.toLocaleUpperCase() ?? "A" },
    role: config.role,
    bio: config.bio,
    activity: "around",
    prompt: config.prompt,
    interests: ["community", "conversation"],
    expertiseDomains: ["community-social", "casual-culture"],
    talkativeness: talk,
    warmth,
    curiosity,
    mischief,
    conscientiousness,
    mentionResponse: 0.98,
    cooldownMs: Math.round(12_000 + (1 - talk) * 100_000),
    latency: [1_200, 5_500],
    disagreement,
    canResearch: config.canResearch,
    style: {
      typicalWords: [4, 26],
      hardMaxWords: 40,
      typicalSentences: [1, 2],
      casing: "sentence",
      punctuation: "plain",
      emojiRate: 0.02,
      complexityAppetite: curiosity,
      visibleAffectRate: customVisibleAffectRate,
      surfaceTextureRate: customSurfaceTextureRate,
      surfaceTexturePalette: customSurfaceTexturePalette,
      correctionMode: config.core.conscientiousness >= 70 ? "specific-fix" : "soft-question",
      disagreementMode: disagreement >= 0.7 ? "blunt-challenge" : "curious-pushback",
      conversationHabits: ["make one specific point", "respond to the live thread rather than recapping it"],
      avoidPhrases: ["fascinating", "great question", "as an AI"],
    },
  };
  persona.name = config.name;
  persona.role = config.role;
  persona.bio = config.bio;
  persona.prompt = config.prompt;
  persona.avatar = {
    ...persona.avatar,
    glyph: [...config.name][0]?.toLocaleUpperCase() ?? persona.avatar.glyph,
    ...(config.avatarImageUrl ? { imageUrl: config.avatarImageUrl } : { imageUrl: undefined }),
  };
  persona.talkativeness = talk;
  persona.warmth = warmth;
  persona.curiosity = curiosity;
  persona.mischief = mischief;
  persona.conscientiousness = conscientiousness;
  persona.disagreement = disagreement;
  persona.canResearch = config.canResearch;
  persona.channelAffinity = Object.fromEntries(
    Object.entries(config.roomAffinities).map(([channelId, value]) => [channelId, unitFromPercent(value)]),
  );
  return persona;
};

const runtimeChannelFromConfig = (
  config: AdminChannelConfig,
  base?: ChannelProfile,
): ChannelProfile => {
  const seedsReplaced = base !== undefined && (
    base.ambientPremises.length !== config.seeds.length ||
    base.ambientPremises.some((seed, index) => seed !== config.seeds[index])
  );
  const topicReplaced = base !== undefined && base.topic.brief !== config.topic;
  const profile: ChannelProfile = base ? structuredClone(base) : {
    public: { id: config.id, name: config.name, description: config.description, icon: config.icon },
    expertiseDomain: "community-social",
    topic: { brief: config.topic, tags: [] },
    conversationGuidance: config.guidance,
    conversationRegister: config.register as ConversationRegister,
    ambientMode: config.mode as AmbientMode,
    ambientPremises: [...config.seeds],
  };
  profile.public = { id: config.id, name: config.name, description: config.description, icon: config.icon };
  profile.topic = topicReplaced ? { brief: config.topic, tags: [] } : { ...profile.topic, brief: config.topic };
  profile.conversationGuidance = config.guidance;
  profile.conversationRegister = config.register;
  profile.ambientMode = config.mode;
  profile.ambientPremises = [...config.seeds];
  if (seedsReplaced) {
    // Families are index-aligned with the built-in seed list. Retaining them
    // after an admin replacement would attach stale semantic identities.
    delete profile.ambientPremiseFamilies;
  }
  // A built-in research lookup is trusted configuration for its original
  // topic. Reusing it after a complete topic replacement would silently post
  // evidence about the former room subject.
  if (topicReplaced) {
    delete profile.autonomousResearchSeeds;
    delete profile.autonomousResearchPriority;
    delete profile.ambientActivityPriority;
    delete profile.marketPulseSourceSet;
    delete profile.scheduledSocialModes;
    delete profile.transientSceneTexture;
  }
  return profile;
};

interface MaterializedCatalog {
  personas: Persona[];
  profiles: ChannelProfile[];
  personaConfigs: AdminPersonaConfig[];
  channelConfigs: AdminChannelConfig[];
}

const uniqueCatalog = (
  values: readonly { id: string; name: string }[],
  label: string,
  nameKey: (name: string) => string = unicodeCaselessKey,
): void => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const value of values) {
    const name = nameKey(value.name);
    if (ids.has(value.id)) throw new AdminStateError(409, "DUPLICATE_ID", `${label} ID ${value.id} already exists.`);
    if (names.has(name)) throw new AdminStateError(409, "DUPLICATE_NAME", `${label} name ${value.name} already exists.`);
    ids.add(value.id);
    names.add(name);
  }
};

export class AdminStateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AdminCatalogHooks {
  validateChannelIds?: (channelIds: readonly string[]) => void;
  validatePersonaIds?: (personaIds: readonly string[]) => void;
  validatePersonaNames?: (personas: readonly { id: string; name: string }[]) => void;
  reconcileCatalog?: () => void;
  onCommitted?: (snapshot: AdminStateSnapshot, catalogChanged: boolean) => void;
}

export interface AdminStateStoreOptions {
  path?: string;
  voiceOptions?: AdminVoiceOptions;
  /** Server-configured voice IDs remain valid even while the provider is temporarily unavailable. */
  configuredVoiceIds?: readonly string[];
  persist?: (state: unknown) => Promise<void>;
}

export class AdminStateStore {
  readonly path: string;
  private state: PersistedAdminState = emptyState();
  private readonly voiceOptions: AdminVoiceOptions;
  private readonly configuredVoiceIds: ReadonlySet<string>;
  private hooks: AdminCatalogHooks = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly customPersist?: (state: unknown) => Promise<void>;

  constructor(options: AdminStateStoreOptions = {}) {
    this.path = resolve(options.path ?? process.env.ADMIN_STATE_PATH ?? "data/admin-state.json");
    this.voiceOptions = structuredClone(options.voiceOptions ?? { languages: [], voices: [] });
    this.configuredVoiceIds = new Set(
      options.configuredVoiceIds ?? this.voiceOptions.voices.map((voice) => voice.id),
    );
    this.customPersist = options.persist;
  }

  setHooks(hooks: AdminCatalogHooks): void {
    this.hooks = hooks;
  }

  /** Re-runs live conflict hooks after dependent persistent identities load at startup. */
  validateActiveCatalog(): void {
    this.validateCatalog(this.materialize(this.state), true);
  }

  async load(): Promise<void> {
    let loaded = emptyState();
    try {
      loaded = persistedSchema.parse(migratePersistedState(JSON.parse(await readFile(this.path, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.validateVoiceMappings(loaded);
    const materialized = this.materialize(loaded);
    this.validateCatalog(materialized);
    this.applyRuntime(materialized);
    this.state = loaded;
  }

  snapshot(humans: AdminHumanMember[] = []): AdminStateSnapshot {
    const catalog = this.materialize(this.state);
    const global = { ...this.state.behavior.global };
    const activeChannelIds = new Set(catalog.channelConfigs.map((channel) => channel.id));
    return {
      behavior: {
        global,
        channels: Object.fromEntries(Object.entries(this.state.behavior.channels)
          .filter(([channelId]) => activeChannelIds.has(channelId))
          .map(([channelId, tuning]) => [channelId, { ...tuning }])),
      },
      automation: {
        autonomousLinkChannelIds: catalog.profiles
          .filter((profile) => (profile.autonomousResearchSeeds?.length ?? 0) > 0)
          .map((profile) => profile.public.id),
      },
      personas: catalog.personaConfigs.map((persona) => structuredClone(persona)),
      channels: catalog.channelConfigs.map((channel) => structuredClone(channel)),
      humans: humans.map((human) => ({ ...human })),
      bans: this.state.bans.map((ban) => ({ ...ban })),
      voiceOptions: structuredClone(this.voiceOptions),
      revision: String(this.state.revision),
    };
  }

  behaviorForChannel(channelId: string): { global: AdminBehaviorTuning; channel: AdminBehaviorTuning } {
    return {
      global: { ...this.state.behavior.global },
      channel: { ...(this.state.behavior.channels[channelId] ?? this.state.behavior.global) },
    };
  }

  behaviorTuning(channelId?: string): AdminBehaviorTuning {
    return { ...(channelId ? this.state.behavior.channels[channelId] ?? this.state.behavior.global : this.state.behavior.global) };
  }

  isBanned(memberId: string | undefined, name: string): boolean {
    const nameKey = participantIdentityKey(name);
    return this.state.bans.some((ban) =>
      (memberId && ban.memberId === memberId) || participantIdentityKey(ban.name) === nameKey,
    );
  }

  async updateBehavior(input: unknown): Promise<AdminStateSnapshot> {
    const patch = adminBehaviorPatchSchema.parse(input);
    return this.mutate((next) => {
      if (patch.scope === "global") {
        next.behavior.global = {
          ...patch.tuning,
          autonomousLinkFrequency:
            patch.tuning.autonomousLinkFrequency ?? next.behavior.global.autonomousLinkFrequency,
        };
      }
      else {
        if (!this.materialize(next).channelConfigs.some((channel) => channel.id === patch.channelId)) {
          throw new AdminStateError(404, "CHANNEL_NOT_FOUND", "That channel is not active.");
        }
        if (patch.tuning === null) delete next.behavior.channels[patch.channelId];
        else {
          const inherited = next.behavior.channels[patch.channelId] ?? next.behavior.global;
          next.behavior.channels[patch.channelId] = {
            ...patch.tuning,
            autonomousLinkFrequency:
              patch.tuning.autonomousLinkFrequency ?? inherited.autonomousLinkFrequency,
          };
        }
      }
    });
  }

  async createPersona(input: unknown): Promise<AdminStateSnapshot> {
    const config = this.parsePersona(input);
    return this.mutate((next) => {
      const active = this.materialize(next).personaConfigs.some((persona) => persona.id === config.id);
      if (active) throw new AdminStateError(409, "PERSONA_EXISTS", "That persona already exists.");
      if (BUILTIN_PERSONA_IDS.has(config.id)) {
        next.personaOverrides[config.id] = config;
        next.disabledPersonaIds = next.disabledPersonaIds.filter((id) => id !== config.id);
      } else {
        next.customPersonas.push(config);
      }
    }, true);
  }

  async updatePersona(id: string, input: unknown): Promise<AdminStateSnapshot> {
    const config = this.parsePersona(input);
    if (config.id !== id) throw new AdminStateError(400, "ID_MISMATCH", "Persona ID cannot change.");
    return this.mutate((next) => {
      const active = this.materialize(next).personaConfigs.some((persona) => persona.id === id);
      if (!active) throw new AdminStateError(404, "PERSONA_NOT_FOUND", "That persona is not active.");
      if (BUILTIN_PERSONA_IDS.has(id)) next.personaOverrides[id] = config;
      else next.customPersonas = next.customPersonas.map((persona) => persona.id === id ? config : persona);
    }, true);
  }

  async deletePersona(id: string): Promise<AdminStateSnapshot> {
    return this.mutate((next) => {
      if (!this.materialize(next).personaConfigs.some((persona) => persona.id === id)) {
        throw new AdminStateError(404, "PERSONA_NOT_FOUND", "That persona is not active.");
      }
      if (this.materialize(next).personaConfigs.length <= 1) {
        throw new AdminStateError(409, "LAST_PERSONA", "Keep at least one AI resident active.");
      }
      if (BUILTIN_PERSONA_IDS.has(id)) next.disabledPersonaIds = [...new Set([...next.disabledPersonaIds, id])];
      else next.customPersonas = next.customPersonas.filter((persona) => persona.id !== id);
    }, true);
  }

  async createChannel(input: unknown): Promise<AdminStateSnapshot> {
    const config = adminChannelSchema.parse(input);
    return this.mutate((next) => {
      if (this.materialize(next).channelConfigs.some((channel) => channel.id === config.id)) {
        throw new AdminStateError(409, "CHANNEL_EXISTS", "That channel already exists.");
      }
      if (BUILTIN_CHANNEL_IDS.has(config.id)) {
        next.channelOverrides[config.id] = config;
        next.disabledChannelIds = next.disabledChannelIds.filter((id) => id !== config.id);
      } else {
        next.customChannels.push(config);
      }
    }, true);
  }

  async updateChannel(id: string, input: unknown): Promise<AdminStateSnapshot> {
    const config = adminChannelSchema.parse(input);
    if (config.id !== id) throw new AdminStateError(400, "ID_MISMATCH", "Channel ID cannot change.");
    return this.mutate((next) => {
      if (!this.materialize(next).channelConfigs.some((channel) => channel.id === id)) {
        throw new AdminStateError(404, "CHANNEL_NOT_FOUND", "That channel is not active.");
      }
      if (BUILTIN_CHANNEL_IDS.has(id)) next.channelOverrides[id] = config;
      else next.customChannels = next.customChannels.map((channel) => channel.id === id ? config : channel);
    }, true);
  }

  async deleteChannel(id: string): Promise<AdminStateSnapshot> {
    return this.mutate((next) => {
      const active = this.materialize(next).channelConfigs;
      if (!active.some((channel) => channel.id === id)) {
        throw new AdminStateError(404, "CHANNEL_NOT_FOUND", "That channel is not active.");
      }
      if (active.length <= 1) throw new AdminStateError(409, "LAST_CHANNEL", "Keep at least one public channel active.");
      if (id === "lobby") throw new AdminStateError(409, "LOBBY_REQUIRED", "The lobby is required for arrivals and welcomes.");
      delete next.behavior.channels[id];
      if (BUILTIN_CHANNEL_IDS.has(id)) next.disabledChannelIds = [...new Set([...next.disabledChannelIds, id])];
      else next.customChannels = next.customChannels.filter((channel) => channel.id !== id);
    }, true);
  }

  async addBan(record: unknown): Promise<AdminStateSnapshot> {
    const ban = banSchema.parse(record);
    return this.mutate((next) => {
      next.bans = next.bans.filter((candidate) => candidate.memberId !== ban.memberId);
      next.bans.push(ban);
    });
  }

  async removeBan(memberId: string): Promise<AdminStateSnapshot> {
    return this.mutate((next) => {
      const remaining = next.bans.filter((ban) => ban.memberId !== memberId);
      if (remaining.length === next.bans.length) throw new AdminStateError(404, "BAN_NOT_FOUND", "That ban does not exist.");
      next.bans = remaining;
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private parsePersona(input: unknown): AdminPersonaConfig {
    const config = adminPersonaSchema.parse(input);
    const voices: Record<string, string> = {};
    for (const [rawLanguage, voiceId] of Object.entries(config.voices)) {
      const language = rawLanguage === "*" ? "*" : canonicalRegisteredLanguageTag(rawLanguage);
      if (!language) throw new AdminStateError(400, "INVALID_LANGUAGE", `Voice language ${rawLanguage} is not a registered BCP-47 tag.`);
      if (!this.configuredVoiceIds.has(voiceId)) throw new AdminStateError(400, "INVALID_VOICE", `Voice ${voiceId} is not configured on this server.`);
      voices[language] = voiceId;
    }
    return { ...config, voices };
  }

  private validateVoiceMappings(state: PersistedAdminState): void {
    for (const persona of [...Object.values(state.personaOverrides), ...state.customPersonas]) this.parsePersona(persona);
  }

  private materialize(state: PersistedAdminState): MaterializedCatalog {
    const disabledPersonas = new Set(state.disabledPersonaIds);
    const personaConfigs: AdminPersonaConfig[] = [];
    const personas: Persona[] = [];
    for (const base of BUILTIN_PERSONAS) {
      if (disabledPersonas.has(base.id)) continue;
      const overridden = state.personaOverrides[base.id];
      const baseConfig = personaConfigFromRuntime(base);
      const builtInVoice = PERSONA_VOICE_PROFILES[base.id]?.providerVoice;
      const allowedVoiceIds = new Set(this.voiceOptions.voices.map((voice) => voice.id));
      const config = overridden ?? {
        ...baseConfig,
        voices: builtInVoice && allowedVoiceIds.has(builtInVoice) ? { "*": builtInVoice } : {},
      };
      personaConfigs.push(config);
      personas.push(runtimePersonaFromConfig(config, base));
    }
    for (const config of state.customPersonas) {
      personaConfigs.push(config);
      personas.push(runtimePersonaFromConfig(config));
    }

    const disabledChannels = new Set(state.disabledChannelIds);
    const channelConfigs: AdminChannelConfig[] = [];
    const profiles: ChannelProfile[] = [];
    for (const base of BUILTIN_CHANNEL_PROFILES) {
      if (disabledChannels.has(base.public.id)) continue;
      const config = state.channelOverrides[base.public.id] ?? channelConfigFromRuntime(base);
      channelConfigs.push(config);
      profiles.push(runtimeChannelFromConfig(config, base));
    }
    for (const config of state.customChannels) {
      channelConfigs.push(config);
      profiles.push(runtimeChannelFromConfig(config));
    }
    return { personas, profiles, personaConfigs, channelConfigs };
  }

  private validateCatalog(catalog: MaterializedCatalog, runExternalHooks = true): void {
    if (catalog.personas.length < 1) throw new AdminStateError(409, "LAST_PERSONA", "Keep at least one AI resident active.");
    if (catalog.profiles.length < 1) throw new AdminStateError(409, "LAST_CHANNEL", "Keep at least one public channel active.");
    if (!catalog.profiles.some((profile) => profile.public.id === "lobby")) {
      throw new AdminStateError(409, "LOBBY_REQUIRED", "The lobby is required for arrivals and welcomes.");
    }
    uniqueCatalog(catalog.personaConfigs, "Persona", participantIdentityKey);
    uniqueCatalog(catalog.channelConfigs, "Channel");
    if (runExternalHooks) {
      this.hooks.validateChannelIds?.(catalog.profiles.map((profile) => profile.public.id));
      this.hooks.validatePersonaIds?.(catalog.personas.map((persona) => persona.id));
      this.hooks.validatePersonaNames?.(catalog.personas.map((persona) => ({ id: persona.id, name: persona.name })));
    }
  }

  private applyRuntime(catalog: MaterializedCatalog): void {
    PERSONAS.splice(0, PERSONAS.length, ...catalog.personas.map((persona) => structuredClone(persona)));
    CHANNEL_PROFILES.splice(0, CHANNEL_PROFILES.length, ...catalog.profiles.map((profile) => structuredClone(profile)));
    CHANNELS.splice(0, CHANNELS.length, ...catalog.profiles.map((profile) => ({ ...profile.public })));
    setAdminPersonaVoiceMappings(Object.fromEntries(catalog.personaConfigs.map((persona) => [persona.id, persona.voices])));
    this.hooks.reconcileCatalog?.();
  }

  private mutate(
    change: (next: PersistedAdminState) => void,
    catalogChanged = false,
  ): Promise<AdminStateSnapshot> {
    const run = this.writeQueue.then(async () => {
      const previous = structuredClone(this.state);
      const previousCatalog = this.materialize(previous);
      const next = structuredClone(this.state);
      change(next);
      next.revision += 1;
      const parsed = persistedSchema.parse(next);
      this.validateVoiceMappings(parsed);
      const catalog = this.materialize(parsed);
      this.validateCatalog(catalog, catalogChanged);
      let candidatePersisted = false;
      let runtimeApplyAttempted = false;
      try {
        await this.persist(parsed);
        candidatePersisted = true;
        if (catalogChanged) {
          // Humans/voice rooms may change while disk I/O is pending. Recheck
          // immediately before the synchronous runtime swap.
          this.validateCatalog(catalog, true);
          runtimeApplyAttempted = true;
          this.applyRuntime(catalog);
        }
      } catch (error) {
        if (catalogChanged && candidatePersisted) {
          const rollbackErrors: unknown[] = [];
          if (runtimeApplyAttempted) {
            try {
              this.applyRuntime(previousCatalog);
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          try {
            await this.persist(previous);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              "Admin catalog commit failed and its compensating rollback was incomplete.",
              { cause: error },
            );
          }
        }
        throw error;
      }
      this.state = parsed;
      const snapshot = this.snapshot();
      this.hooks.onCommitted?.(snapshot, catalogChanged);
      return snapshot;
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(state: PersistedAdminState): Promise<void> {
    if (this.customPersist) {
      await this.customPersist(structuredClone(state));
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
