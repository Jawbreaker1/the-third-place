import type { VoiceRoomView, VoiceTranscriptEntry } from "../shared/types.js";
import { speechTimingUnits, truncateSpokenText } from "../shared/spokenText.js";
import { containsExactMention } from "../shared/unicodeBoundaries.js";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { resolveBehaviorTuning, type BehaviorTuningProvider } from "./behaviorTuning.js";
import { CHANNELS, getChannelProfile } from "./channels.js";
import type { HumanMemory } from "./humanMemory.js";
import {
  diegeticIdentityTurnPremise,
  isBackgroundWorkPreemptedError,
  type ModelWorkScope,
  type SceneCapabilityContext,
  type TranscriptLine,
} from "./lmStudio.js";
import type { SocialModelClient } from "./switchableModel.js";
import { PERSONAS, type Persona } from "./personas.js";
import { mappedProviderVoiceForPersona, voiceProfileForPersona } from "./personaVoices.js";
import {
  CANDIDATE_OUTPUT_LANGUAGE_TRUST_CONFIDENCE,
  projectTrustedTurnAnalysis,
  type TurnAnalysis,
  type TurnAnalysisInput,
} from "./semanticRouter.js";
import type { VoiceRoomRuntime } from "./voiceRooms.js";
import { ttsLanguageIsSupported, type VoiceSpeechService } from "./voiceSpeech.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { capabilitiesForMedium, type TurnCapability } from "./capabilities/catalog.js";
import type { SocialMemoryCoordinator } from "./socialMemoryCoordinator.js";
import type { SocialMemoryScope } from "./socialMemory.js";
import {
  deriveRelationshipStylePlan,
  RELATIONSHIP_DECISION_BIAS_LIMITS,
  type RelationshipBehaviorProjection,
  type RelationshipPromptCue,
  type RelationshipStylePlan,
} from "./relationshipBehavior.js";

export interface VoiceAiSpeechPayload {
  roomId: string;
  memberId: string;
  text: string;
  utteranceId: string;
  audioUrl?: string;
  mimeType?: string;
  browserFallbackAllowed: boolean;
  language?: string;
  browserRate?: number;
  browserPitch?: number;
}

export interface VoiceDirectorEvents {
  roomChanged(room: VoiceRoomView): void;
  transcriptFinal(entry: VoiceTranscriptEntry): void;
  aiSpeech(payload: VoiceAiSpeechPayload): void;
  aiStop(payload: { roomId: string }): void;
}

export interface VoiceChannelRecentMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface VoiceDirectorOptions {
  runtime: VoiceRoomRuntime;
  capabilityRegistry: CapabilityRegistry;
  lm: Pick<SocialModelClient, "analyzeTurn" | "generateScene"> &
    Partial<Pick<SocialModelClient, "rememberDeliveredLine" | "acquireForegroundDemand">>;
  speech: Pick<VoiceSpeechService, "capabilities" | "synthesize">;
  actorChannels: ActorChannelRuntime;
  events: VoiceDirectorEvents;
  humanMemory?: Pick<HumanMemory, "promptNote" | "getRelation" | "updateRelation">;
  socialMemory?: Pick<SocialMemoryCoordinator, "promptNote" | "enqueueDeliveredEpisode">;
  now?: () => number;
  /** Quiet floor after the latest completed human turn; production uses this to coalesce overlapping speakers. */
  floorSilenceMs?: number;
  /** Poll interval while another human still owns the floor or has audio awaiting STT. */
  floorRecheckMs?: number;
  /** True while a human clip in this room is queued, uploading or being transcribed. */
  hasPendingHumanIngest?: (roomId: string) => boolean;
  /** Last trusted response language in the public channel, used only to seed a new voice session. */
  establishedChannelLanguage?: (channelId: string) => string | undefined;
  /** Bounded public-channel context lets the semantic router understand the conversation a voice room continues. */
  recentChannelMessages?: (channelId: string) => readonly VoiceChannelRecentMessage[];
  /** Live admin calibration shared with scene generation and the sole-resident router draft. */
  behaviorTuningProvider?: BehaviorTuningProvider;
  /**
   * Optional server-owned directed relationship projection. Voice consumes
   * only its bounded tie-break and coarse prompt cue; absence/failure is
   * neutral and never changes direct response obligations.
   */
  relationshipBehaviorProjection?: (
    ownerPersonaId: string,
    subjectActorId: string,
  ) => RelationshipBehaviorProjection | undefined;
  /**
   * Trusted account/admin policy for endpoint romance eligibility in memory
   * analysis. Every actor kind fails closed unless this callback returns true.
   */
  romanceEligibleActor?: (
    actorId: string,
    kind: "human" | "resident",
  ) => boolean;
  /** One bounded resident-to-resident follow-up after a human turn when two residents are present. */
  residentFollowUpEnabled?: boolean;
  /** Natural floor gap after the first resident finishes speaking. */
  residentFollowUpGapMs?: number;
  /** Defers optional publication briefly after a browser human-floor transition. */
  residentFollowUpFloorGraceMs?: number;
  /** Absolute freshness budget after the intended peer handoff. Slow optional work is aborted. */
  residentFollowUpMaxLatenessMs?: number;
}

export const mentionsPersona = containsExactMention;

const explicitlyMentionsPersona = mentionsPersona;

const sanitizeSpokenLine = (value: string, language?: string): string => {
  const cleaned = stripDangerousTextControls(value
    .normalize("NFKC")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\p{Ps}[^\p{Ps}\p{Pe}]{0,100}\p{Pe}/gu, " ")
    .replace(/[*_~`#>|]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " "))
    .replace(/\s+/g, " ")
    .trim();
  return truncateSpokenText(cleaned, { language, maxWords: 25, maxGraphemes: 240 });
};

const combinedRelationshipNote = (...notes: Array<string | undefined>): string | undefined => {
  const combined = notes.filter((note): note is string => Boolean(note?.trim())).join("\n").slice(0, 1_200);
  return combined || undefined;
};

const VOICE_RELATIONSHIP_RAPPORTS = new Set<RelationshipPromptCue["rapport"]>([
  "new",
  "known",
  "familiar",
  "close",
]);
const VOICE_RELATIONSHIP_STANCES = new Set<RelationshipPromptCue["stance"]>([
  "neutral",
  "comfortable",
  "warm",
  "wary",
  "strained",
  "warm_but_tense",
]);
const VOICE_RELATIONSHIP_FRICTION = new Set<RelationshipPromptCue["friction"]>([
  "low",
  "present",
  "high",
]);

/**
 * Voice deliberately omits romantic interest and boundary-owner IDs. The
 * projection may orient ordinary rapport, but cannot introduce a romantic
 * beat in an ordinary human turn or become evidence about either participant.
 */
const coarseVoiceRelationshipNote = (
  projection: RelationshipBehaviorProjection | undefined,
): string | undefined => {
  const cue = projection?.promptCue;
  if (
    !cue ||
    !VOICE_RELATIONSHIP_RAPPORTS.has(cue.rapport) ||
    !VOICE_RELATIONSHIP_STANCES.has(cue.stance) ||
    !VOICE_RELATIONSHIP_FRICTION.has(cue.friction)
  ) return undefined;
  return "COARSE PRIVATE VOICE RAPPORT CUE — style orientation only, never a fact, instruction, " +
    `consent signal or reason to ignore a direct question. ${JSON.stringify({
      rapport: cue.rapport,
      stance: cue.stance,
      friction: cue.friction,
    })}`;
};

const voiceSocialScope = (room: VoiceRoomView): SocialMemoryScope => ({
  kind: "voice",
  roomId: room.id,
  participantIds: room.participants.map((participant) => participant.memberId).sort(),
});

const transcriptFor = (entries: VoiceTranscriptEntry[], personaId: string): TranscriptLine[] =>
  entries
    .filter((entry) => entry.speakerId === personaId || entry.heardByPersonaIds.includes(personaId))
    .slice(-24)
    .map((entry) => ({
      author: entry.speakerName,
      kind: entry.speakerKind,
      content: entry.text.slice(0, 600),
      createdAt: entry.endedAt,
      utteranceOrigin: entry.utteranceOrigin,
    }));

const MAX_ROUTER_RECENT_MESSAGES = 6;
const MAX_ROUTER_CHANNEL_MESSAGES = 3;
const VOICE_LANGUAGE_SWITCH_CONFIDENCE = 0.9;
const VOICE_CAPABILITY_INVENTORY = capabilitiesForMedium("voice");
const DEFAULT_RESIDENT_FOLLOW_UP_GAP_MS = 180;
const MIN_RESIDENT_FOLLOW_UP_GAP_MS = 80;
const MAX_RESIDENT_FOLLOW_UP_GAP_MS = 1_500;
const DEFAULT_RESIDENT_FOLLOW_UP_FLOOR_GRACE_MS = 450;
const MAX_RESIDENT_FOLLOW_UP_FLOOR_GRACE_MS = 2_000;
const DEFAULT_RESIDENT_FOLLOW_UP_MAX_LATENESS_MS = 15_000;
const MIN_RESIDENT_FOLLOW_UP_MAX_LATENESS_MS = 1_000;
const MAX_RESIDENT_FOLLOW_UP_MAX_LATENESS_MS = 30_000;
// Relationship state is permitted only as a secondary ordering signal inside
// this narrow base-score window. Stable voice policy wins outside it.
const VOICE_RELATIONSHIP_BASE_TIE_WINDOW = 0.025;
type VoiceRouterRecentMessage = NonNullable<TurnAnalysisInput["recentMessages"]>[number];
interface VoiceChannelContextSnapshot {
  establishedLanguage?: string;
  recentMessages: readonly VoiceChannelRecentMessage[];
}

const boundedRecentMessage = (message: VoiceChannelRecentMessage): VoiceRouterRecentMessage => ({
  id: message.id.slice(0, 128),
  authorId: message.authorId.slice(0, 128),
  authorName: message.authorName.slice(0, 80),
  content: message.content.slice(0, 480),
  createdAt: message.createdAt,
});

const messageTimestamp = (message: VoiceRouterRecentMessage): number | undefined => {
  const timestamp = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const compareRecentMessages = (left: VoiceRouterRecentMessage, right: VoiceRouterRecentMessage): number => {
  const timestampDelta = (messageTimestamp(left) ?? 0) - (messageTimestamp(right) ?? 0);
  if (timestampDelta !== 0) return timestampDelta;
  const leftId = left.id ?? "";
  const rightId = right.id ?? "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
};

const compactVoiceReplyProfile = (
  persona: Persona,
  expertiseNote: string | undefined,
  tuning: ReturnType<typeof resolveBehaviorTuning>["effective"],
): string => [
  `Live room calibration: competence ${tuning.competence}/100, aggression ${tuning.aggression}/100, explicitness ${tuning.explicitness}/100.`,
  expertiseNote ? `Room expertise: ${expertiseNote.slice(0, 120)}` : "",
  `Voice: ${persona.prompt.slice(0, 230)}`,
  `Natural length ${persona.style.typicalWords[0]}–${Math.min(25, persona.style.typicalWords[1])} words; casing ${persona.style.casing}; punctuation ${persona.style.punctuation}; correction ${persona.style.correctionMode}; disagreement ${persona.style.disagreementMode}.`.slice(0, 170),
  persona.style.avoidPhrases.length > 0
    ? `Avoid stock phrases: ${persona.style.avoidPhrases.join(", ").slice(0, 90)}.`
    : "",
  persona.connections ? `Known dynamics: ${persona.connections.slice(0, 70)}` : "",
].filter(Boolean).join(" ").slice(0, 650);

interface SoleVoiceDraftContext {
  replyProfile: string;
  relationshipContext?: string;
  participants: TurnAnalysisInput["voiceParticipantRoster"];
}

const analysisInputFor = (
  entry: VoiceTranscriptEntry,
  room: VoiceRoomView,
  transcript: VoiceTranscriptEntry[],
  invited: Persona[],
  availableCapabilities: readonly TurnCapability[],
  recentChannelMessages: readonly VoiceChannelRecentMessage[] = [],
  soleDraftContext?: SoleVoiceDraftContext,
): TurnAnalysisInput => {
  const channel = getChannelProfile(room.channelId);
  const transportLanguageHint = canonicalRegisteredLanguageTag(entry.language);
  const latestTimestamp = Date.parse(entry.endedAt);
  const recentVoiceMessages: VoiceRouterRecentMessage[] = transcript
    .filter((candidate) => candidate.id !== entry.id)
    .slice(-MAX_ROUTER_RECENT_MESSAGES)
    .map((candidate) => ({
      id: candidate.id,
      authorId: candidate.speakerId,
      authorName: candidate.speakerName.slice(0, 80),
      content: candidate.text.slice(0, 800),
      createdAt: candidate.endedAt,
    }));
  const recentChannelContext = recentChannelMessages
    .map(boundedRecentMessage)
    .filter((candidate) => candidate.id !== entry.id)
    .filter((candidate) => {
      const timestamp = messageTimestamp(candidate);
      return timestamp !== undefined && (!Number.isFinite(latestTimestamp) || timestamp <= latestTimestamp);
    })
    .sort(compareRecentMessages)
    .slice(-MAX_ROUTER_CHANNEL_MESSAGES);
  const recentMessages = [
    ...recentChannelContext,
    ...recentVoiceMessages,
  ]
    .filter((candidate) => candidate.id !== entry.id)
    .filter((candidate) => {
      const timestamp = messageTimestamp(candidate);
      return timestamp !== undefined && (!Number.isFinite(latestTimestamp) || timestamp <= latestTimestamp);
    })
    .sort(compareRecentMessages)
    .slice(-MAX_ROUTER_RECENT_MESSAGES);
  return {
    turnId: `voice:${entry.id}`.slice(0, 128),
    medium: "voice",
    channel: {
      id: room.channelId,
      name: channel?.public.name ?? room.channelId,
      ...(channel?.topic.brief ? { topic: channel.topic.brief.slice(0, 500) } : {}),
    },
    latestMessage: {
      id: entry.id,
      authorId: entry.speakerId,
      authorName: entry.speakerName.slice(0, 80),
      content: entry.text.slice(0, 4_000),
      createdAt: entry.endedAt,
    },
    recentMessages,
    personaCandidates: invited.map((persona) => ({
      id: persona.id,
      name: persona.name,
      interests: persona.interests.slice(0, 16),
      ...(invited.length === 1 && soleDraftContext
        ? {
            voiceReplyProfile: soleDraftContext.replyProfile,
            ...(soleDraftContext.relationshipContext
              ? { voiceRelationshipContext: soleDraftContext.relationshipContext.slice(0, 600) }
              : {}),
          }
        : {}),
    })),
    voiceParticipantRoster: soleDraftContext?.participants ?? [],
    mechanicalAddressedPersonaIds: invited
      .filter((persona) => explicitlyMentionsPersona(entry.text, persona.name))
      .map((persona) => persona.id),
    // The medium-owned registry inventory is trusted runtime state. Voice
    // never advertises capabilities outside that explicitly scoped list.
    availableCapabilities: [...availableCapabilities],
    urlCandidates: [],
    ...(transportLanguageHint ? { transportLanguageHint } : {}),
  };
};

const primaryLanguage = (language: string): string => language.split("-", 1)[0]!.toLocaleLowerCase();

export const routedLanguage = (
  analysis: TurnAnalysis | undefined,
  _transcriptLanguage?: string,
  establishedLanguage?: string,
): string | undefined => {
  const established = canonicalRegisteredLanguageTag(establishedLanguage);
  const trustedResponseLanguage = analysis?.source === "lm" && analysis.responseLanguage
    ? canonicalRegisteredLanguageTag(projectTrustedTurnAnalysis(analysis).languageTag)
    : undefined;
  const highConfidenceLatestLanguage = analysis?.source === "lm" &&
    analysis.language.confidence >= VOICE_LANGUAGE_SWITCH_CONFIDENCE
    ? canonicalRegisteredLanguageTag(analysis.language.tag)
    : undefined;
  const highConfidenceResponseLanguage = analysis?.source === "lm" &&
    analysis.responseLanguage &&
    analysis.responseLanguage.confidence >= VOICE_LANGUAGE_SWITCH_CONFIDENCE
    ? canonicalRegisteredLanguageTag(analysis.responseLanguage.tag)
    : undefined;

  if (established) {
    const switchesPrimaryLanguage = highConfidenceLatestLanguage &&
      highConfidenceResponseLanguage &&
      primaryLanguage(highConfidenceLatestLanguage) === primaryLanguage(highConfidenceResponseLanguage) &&
      primaryLanguage(highConfidenceResponseLanguage) !== primaryLanguage(established);
    return switchesPrimaryLanguage ? highConfidenceResponseLanguage : established;
  }

  // STT exposes no confidence, so its per-clip language tag remains analysis
  // metadata and never becomes a hard response-language route by itself.
  return trustedResponseLanguage ?? highConfidenceLatestLanguage;
};

const routedLanguageHint = (language: string | undefined): string =>
  language ?? "infer and mirror the language of the latest human utterance directly";

const estimatedSpeechDurationMs = (spoken: string, language?: string): number => Math.max(
  1_200,
  Math.min(12_000, 550 + speechTimingUnits(spoken, language) * 310),
);

const voiceRosterFingerprint = (room: VoiceRoomView): string => room.participants
  .map((participant) => `${participant.kind}:${participant.memberId}`)
  .sort()
  .join("\n");

const voiceRoomWorkScope = (roomId: string): ModelWorkScope => ({
  kind: "voice-room",
  id: roomId,
});

/** Server TTS is allowed only for provider-declared BCP-47 ranges. */
export const ttsModelSupportsLanguage = (
  supportedLanguages: readonly string[] | undefined,
  language: string | undefined,
): boolean => ttsLanguageIsSupported(supportedLanguages, language);

export class VoiceDirector {
  private readonly epochByRoom = new Map<string, number>();
  private readonly establishedLanguageByRoom = new Map<string, string>();
  private readonly lastSpokeAtByPersona = new Map<string, number>();
  private readonly analysisAbortByRoom = new Map<string, AbortController>();
  private readonly speechAbortByRoom = new Map<string, AbortController>();
  private readonly generationAbortByRoom = new Map<string, AbortController>();
  private readonly pendingResponseTimerByRoom = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingResidentFollowUpTimerByRoom = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly options: VoiceDirectorOptions) {
    this.now = options.now ?? Date.now;
  }

  onHumanFinal(entry: VoiceTranscriptEntry): void {
    if (entry.speakerKind !== "human" || !entry.final || !entry.trigger.eligible || entry.trigger.source !== "human-final") return;
    const channelContext = this.snapshotChannelContext(entry);
    const epoch = this.invalidateRoom(entry.roomId);
    const floorSilenceMs = Math.max(0, this.options.floorSilenceMs ?? 0);
    if (floorSilenceMs === 0) {
      void this.respond(entry, epoch, channelContext);
      return;
    }
    this.scheduleFloorResponse(entry, epoch, floorSilenceMs, channelContext);
  }

  invalidateRoom(roomId: string): number {
    const pending = this.pendingResponseTimerByRoom.get(roomId);
    if (pending) clearTimeout(pending);
    this.pendingResponseTimerByRoom.delete(roomId);
    const residentFollowUp = this.pendingResidentFollowUpTimerByRoom.get(roomId);
    if (residentFollowUp) clearTimeout(residentFollowUp);
    this.pendingResidentFollowUpTimerByRoom.delete(roomId);
    this.analysisAbortByRoom.get(roomId)?.abort(new Error("Voice turn superseded"));
    this.analysisAbortByRoom.delete(roomId);
    this.generationAbortByRoom.get(roomId)?.abort(new Error("Voice turn superseded"));
    this.generationAbortByRoom.delete(roomId);
    this.speechAbortByRoom.get(roomId)?.abort(new Error("Voice turn superseded"));
    this.speechAbortByRoom.delete(roomId);
    const epoch = (this.epochByRoom.get(roomId) ?? 0) + 1;
    this.epochByRoom.set(roomId, epoch);
    this.options.events.aiStop({ roomId });
    // Invalidating a turn is also the lifecycle boundary for its visible
    // state. Any async continuation now belongs to an obsolete epoch and can
    // no longer clean up the resident it marked as thinking/speaking.
    this.resetBotsToListening(roomId);
    return epoch;
  }

  /**
   * A committed live catalog edit invalidates voice work built from the old
   * persona/room snapshot. Reset visible bot state as well so a cancelled
   * generation or synthesis cannot leave a resident stuck on "thinking".
   */
  onCatalogChanged(roomIds: readonly string[]): void {
    for (const roomId of new Set(roomIds)) {
      if (!this.options.runtime.getRoom(roomId)) continue;
      this.invalidateRoom(roomId);
    }
  }

  forgetRoom(roomId: string): void {
    const pending = this.pendingResponseTimerByRoom.get(roomId);
    if (pending) clearTimeout(pending);
    this.pendingResponseTimerByRoom.delete(roomId);
    const residentFollowUp = this.pendingResidentFollowUpTimerByRoom.get(roomId);
    if (residentFollowUp) clearTimeout(residentFollowUp);
    this.pendingResidentFollowUpTimerByRoom.delete(roomId);
    this.analysisAbortByRoom.get(roomId)?.abort(new Error("Voice room closed"));
    this.analysisAbortByRoom.delete(roomId);
    this.generationAbortByRoom.get(roomId)?.abort(new Error("Voice room closed"));
    this.generationAbortByRoom.delete(roomId);
    this.speechAbortByRoom.get(roomId)?.abort(new Error("Voice room closed"));
    this.speechAbortByRoom.delete(roomId);
    this.epochByRoom.delete(roomId);
    this.establishedLanguageByRoom.delete(roomId);
  }

  private establishedLanguage(
    room: VoiceRoomView,
    transcript: readonly VoiceTranscriptEntry[],
    channelLanguage: string | undefined,
  ): string | undefined {
    const existing = this.establishedLanguageByRoom.get(room.id);
    if (existing) return existing;
    const priorAiLanguage = [...transcript]
      .reverse()
      .find((candidate) => candidate.speakerKind === "ai" && candidate.utteranceOrigin === "ai-tts" && candidate.language)
      ?.language;
    return canonicalRegisteredLanguageTag(priorAiLanguage) ??
      canonicalRegisteredLanguageTag(channelLanguage);
  }

  private snapshotChannelContext(entry: VoiceTranscriptEntry): VoiceChannelContextSnapshot {
    const room = this.options.runtime.getRoom(entry.roomId);
    if (!room) return { recentMessages: [] };
    const establishedLanguage = canonicalRegisteredLanguageTag(
      this.options.establishedChannelLanguage?.(room.channelId),
    );
    const recentMessages = (this.options.recentChannelMessages?.(room.channelId) ?? []).map((message) => ({
      ...message,
    }));
    return {
      ...(establishedLanguage ? { establishedLanguage } : {}),
      recentMessages,
    };
  }

  private isCurrent(roomId: string, epoch: number, personaId: string): boolean {
    return this.epochByRoom.get(roomId) === epoch && this.options.runtime.isMemberInRoom(roomId, personaId);
  }

  private invitedPersonas(entry: VoiceTranscriptEntry): Persona[] {
    const room = this.options.runtime.getRoom(entry.roomId);
    if (!room) return [];
    const eligibleIds = new Set(entry.heardByPersonaIds);
    return room.participants
      .filter((participant) => participant.kind === "ai" && eligibleIds.has(participant.memberId))
      .map((participant) => PERSONAS.find((persona) => persona.id === participant.memberId))
      .filter((persona): persona is Persona => Boolean(persona));
  }

  private relationshipBehavior(
    ownerPersonaId: string,
    subjectActorId: string,
  ): RelationshipBehaviorProjection | undefined {
    try {
      return this.options.relationshipBehaviorProjection?.(ownerPersonaId, subjectActorId);
    } catch {
      // A relationship projection is optional texture. A missing or failed
      // provider must preserve the existing voice owner and response policy.
      return undefined;
    }
  }

  private voiceRelationshipTieBreak(ownerPersonaId: string, subjectActorId: string): number {
    const projected = this.relationshipBehavior(ownerPersonaId, subjectActorId)?.decisionBiases.voiceTieBreak;
    if (typeof projected !== "number" || !Number.isFinite(projected)) return 0;
    return Math.max(
      -RELATIONSHIP_DECISION_BIAS_LIMITS.voiceTieBreak,
      Math.min(RELATIONSHIP_DECISION_BIAS_LIMITS.voiceTieBreak, projected),
    );
  }

  private voiceRelationshipNote(ownerPersonaId: string, subjectActorId: string): string | undefined {
    return coarseVoiceRelationshipNote(this.relationshipBehavior(ownerPersonaId, subjectActorId));
  }

  private voiceRelationshipStylePlan(
    ownerPersonaId: string,
    subjectActorId: string,
  ): RelationshipStylePlan | undefined {
    const projection = this.relationshipBehavior(ownerPersonaId, subjectActorId);
    return projection ? deriveRelationshipStylePlan(projection, "voice") : undefined;
  }

  private romanceEligibleActor(actorId: string, kind: "human" | "resident"): boolean {
    try {
      return this.options.romanceEligibleActor?.(actorId, kind) === true;
    } catch {
      return false;
    }
  }

  private romanticSceneEligibility(
    residentId: string,
    subjectId: string,
    subjectKind: "human" | "resident",
  ): "eligible" | "ineligible" {
    return this.romanceEligibleActor(residentId, "resident") &&
      this.romanceEligibleActor(subjectId, subjectKind)
      ? "eligible"
      : "ineligible";
  }

  private romanticInteractionPolicy(
    _residentId: string,
    _subjectId: string,
    _subjectKind: "human" | "resident",
  ): "ordinary_only" {
    // Voice has no rare romantic-scene gate yet. Eligibility and an unspecified
    // boundary are not permission, so ordinary peer warmth remains allowed but
    // romantic escalation stays fail-closed.
    return "ordinary_only";
  }

  private selectPersona(
    entry: VoiceTranscriptEntry,
    room: VoiceRoomView,
    invited: Persona[],
    analysis: TurnAnalysis | undefined,
  ): Persona | undefined {
    if (invited.length === 0) return undefined;
    const trusted = projectTrustedTurnAnalysis(analysis);
    if (
      trusted.moderationTrusted &&
      ["deescalate", "report", "block"].includes(trusted.moderation.action)
    ) {
      const moderator = invited.find((persona) => persona.id === "ai-runa");
      if (moderator) return moderator;
    }
    const explicitMention = invited.find((persona) => explicitlyMentionsPersona(entry.text, persona.name));
    if (explicitMention) return explicitMention;
    const inferredIds = trusted.inferredAddressedIds;
    if (inferredIds.length > 0) {
      const inferredTarget = inferredIds
        .map((id) => invited.find((persona) => persona.id === id))
        .find((persona): persona is Persona => Boolean(persona));
      if (inferredTarget) return inferredTarget;
    }
    const channelId = room.channelId;
    return invited
      .map((persona) => {
        const age = this.now() - (this.lastSpokeAtByPersona.get(persona.id) ?? 0);
        const cooldownPenalty = age < persona.cooldownMs ? 0.9 : 0;
        return {
          persona,
          baseScore:
            this.options.actorChannels.affinity(persona.id, channelId) +
            persona.talkativeness * 0.45 +
            persona.curiosity * 0.2 -
            cooldownPenalty,
          relationshipTieBreak: this.voiceRelationshipTieBreak(persona.id, entry.speakerId),
        };
      })
      .sort((left, right) => {
        const baseDifference = right.baseScore - left.baseScore;
        if (Math.abs(baseDifference) > VOICE_RELATIONSHIP_BASE_TIE_WINDOW) return baseDifference;
        const relationshipDifference = right.relationshipTieBreak - left.relationshipTieBreak;
        return relationshipDifference || baseDifference || left.persona.id.localeCompare(right.persona.id);
      })[0]?.persona;
  }

  private setBotState(roomId: string, personaId: string, state: "listening" | "thinking" | "speaking"): void {
    const result = this.options.runtime.setBotState(roomId, personaId, state);
    if (result.ok) this.options.events.roomChanged(result.room);
  }

  private resetBotsToListening(roomId: string): void {
    for (const participant of this.options.runtime.getRoom(roomId)?.participants ?? []) {
      if (participant.kind === "ai" && (participant.botState === "thinking" || participant.botState === "speaking")) {
        this.setBotState(roomId, participant.memberId, "listening");
      }
    }
  }

  private scheduleFloorResponse(
    entry: VoiceTranscriptEntry,
    epoch: number,
    delayMs: number,
    channelContext: VoiceChannelContextSnapshot,
  ): void {
    const timer = setTimeout(() => {
      if (this.pendingResponseTimerByRoom.get(entry.roomId) !== timer) return;
      const humanStillSpeaking = this.options.runtime.getRoom(entry.roomId)?.participants.some(
        (participant) => participant.kind === "human" && participant.speaking,
      ) ?? false;
      if (humanStillSpeaking || this.options.hasPendingHumanIngest?.(entry.roomId)) {
        this.scheduleFloorResponse(
          entry,
          epoch,
          Math.max(25, this.options.floorRecheckMs ?? 250),
          channelContext,
        );
        return;
      }
      this.pendingResponseTimerByRoom.delete(entry.roomId);
      if (this.epochByRoom.get(entry.roomId) === epoch) void this.respond(entry, epoch, channelContext);
    }, delayMs);
    timer.unref();
    this.pendingResponseTimerByRoom.set(entry.roomId, timer);
  }

  private async respond(
    entry: VoiceTranscriptEntry,
    epoch: number,
    channelContext: VoiceChannelContextSnapshot,
  ): Promise<void> {
    const foreground = this.options.lm.acquireForegroundDemand?.();
    try {
      await this.respondWithForeground(entry, epoch, channelContext);
    } finally {
      foreground?.release();
    }
  }

  private async respondWithForeground(
    entry: VoiceTranscriptEntry,
    epoch: number,
    channelContext: VoiceChannelContextSnapshot,
  ): Promise<void> {
    const latencyStartedAt = performance.now();
    let analysisFinishedAt = latencyStartedAt;
    let capabilityFinishedAt = latencyStartedAt;
    let sceneFinishedAt = latencyStartedAt;
    const room = this.options.runtime.getRoom(entry.roomId);
    if (!room) return;
    const invited = this.invitedPersonas(entry);
    if (invited.length === 0) return;
    // When ownership is already unambiguous, expose the real pending state
    // while semantic routing runs instead of leaving several seconds of dead
    // air. With multiple unaddressed residents we wait for the semantic router
    // so the UI never advertises the wrong speaker.
    const earlyPersona = invited.length === 1
      ? invited[0]
      : invited.find((persona) => explicitlyMentionsPersona(entry.text, persona.name));
    if (earlyPersona) this.setBotState(room.id, earlyPersona.id, "thinking");
    const solePersona = invited.length === 1 ? invited[0] : undefined;
    const soleRelationshipNote = solePersona
      ? combinedRelationshipNote(
          this.voiceRelationshipNote(solePersona.id, entry.speakerId),
          this.options.humanMemory?.promptNote(entry.speakerId, solePersona.id),
          this.options.socialMemory?.promptNote(
            solePersona.id,
            entry.speakerId,
            voiceSocialScope(room),
            {
              romanticSceneEligibility: this.romanticSceneEligibility(
                solePersona.id,
                entry.speakerId,
                entry.speakerKind === "ai" ? "resident" : "human",
              ),
            },
          ),
        )
      : undefined;
    const behaviorTuning = resolveBehaviorTuning(
      this.options.behaviorTuningProvider,
      room.channelId,
    ).effective;
    const soleExpertiseNote = solePersona
      ? this.options.actorChannels.expertiseNotes([solePersona], room.channelId)[solePersona.id]
      : undefined;
    const soleDraftContext: SoleVoiceDraftContext | undefined = solePersona
      ? {
          replyProfile: compactVoiceReplyProfile(solePersona, soleExpertiseNote, behaviorTuning),
          ...(soleRelationshipNote ? { relationshipContext: soleRelationshipNote } : {}),
          participants: room.participants.map((participant) => ({
            id: participant.memberId,
            name: participant.name,
            kind: participant.kind,
          })),
        }
      : undefined;
    const transcript = this.options.runtime.getTranscript(room.id);
    const capabilityContext = {
      medium: "voice" as const,
      candidateSet: {
        requestedAt: entry.endedAt,
        candidates: [],
      },
      allowSearch: false,
      inventory: VOICE_CAPABILITY_INVENTORY,
      intent: entry.text,
      requesterId: entry.speakerId,
    };
    const availableCapabilities = this.options.capabilityRegistry.available(capabilityContext);
    let analysis: TurnAnalysis | undefined;
    const analysisAbort = new AbortController();
    this.analysisAbortByRoom.set(room.id, analysisAbort);
    try {
      analysis = await this.options.lm.analyzeTurn(analysisInputFor(
        entry,
        room,
        transcript,
        invited,
        availableCapabilities,
        channelContext.recentMessages,
        soleDraftContext,
      ), {
        supersessionScope: voiceRoomWorkScope(room.id),
        signal: analysisAbort.signal,
      });
    } catch (error) {
      if (!analysisAbort.signal.aborted) {
        console.warn("Voice semantic analysis unavailable; using neutral routing:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (this.analysisAbortByRoom.get(room.id) === analysisAbort) {
        this.analysisAbortByRoom.delete(room.id);
      }
    }
    analysisFinishedAt = performance.now();
    if (this.epochByRoom.get(room.id) !== epoch) return;
    const trusted = projectTrustedTurnAnalysis(analysis);
    let utteranceLanguage = routedLanguage(
      analysis,
      entry.language,
      this.establishedLanguage(room, transcript, channelContext.establishedLanguage),
    );
    const invocation = analysis
      ? this.options.capabilityRegistry.compile(analysis, capabilityContext)
      : undefined;
    const persona = this.selectPersona(entry, room, invited, analysis);
    if (!persona) {
      if (earlyPersona && this.isCurrent(room.id, epoch, earlyPersona.id)) {
        this.setBotState(room.id, earlyPersona.id, "listening");
      }
      return;
    }
    if (earlyPersona && earlyPersona.id !== persona.id && this.isCurrent(room.id, epoch, earlyPersona.id)) {
      this.setBotState(room.id, earlyPersona.id, "listening");
    }
    if (earlyPersona?.id !== persona.id) this.setBotState(room.id, persona.id, "thinking");

    const resolution = invocation
      ? await this.options.capabilityRegistry.execute(invocation, entry.speakerId)
      : undefined;
    capabilityFinishedAt = performance.now();
    if (this.epochByRoom.get(room.id) !== epoch) return;
    const capabilityScene = invocation && resolution
      ? this.options.capabilityRegistry.sceneContract(invocation, resolution, { actorName: persona.name })
      : undefined;
    const plannedAction = invocation?.capability ?? null;
    const sceneCapabilityContext: SceneCapabilityContext = {
      available: [...availableCapabilities],
      externalEvidenceAvailable: this.options.capabilityRegistry.hasExternalEvidence(availableCapabilities),
      requestKind: trusted.capabilityTrusted && analysis?.source === "lm"
        ? analysis.capabilities.requestKind
        : "none",
      discussed: trusted.capabilityTrusted && analysis?.source === "lm"
        ? [...analysis.capabilities.discussed]
        : [],
      plannedAction,
      executionStatus: plannedAction === null
        ? "not_requested"
        : resolution?.state === "grounding_available"
          ? "succeeded"
          : "failed_temporary",
    };

    // Capture only memory that predates this turn for generation. A delivered
    // voice exchange is classified asynchronously after it reaches transcript.
    const relationshipNote = solePersona?.id === persona.id
      ? soleRelationshipNote
      : combinedRelationshipNote(
          this.voiceRelationshipNote(persona.id, entry.speakerId),
          this.options.humanMemory?.promptNote(entry.speakerId, persona.id),
          this.options.socialMemory?.promptNote(
            persona.id,
            entry.speakerId,
            voiceSocialScope(room),
            {
              romanticSceneEligibility: this.romanticSceneEligibility(
                persona.id,
                entry.speakerId,
                entry.speakerKind === "ai" ? "resident" : "human",
              ),
            },
          ),
        );
    const relationshipStylePlan = this.voiceRelationshipStylePlan(persona.id, entry.speakerId);
    const previousRelation = this.options.humanMemory?.getRelation(entry.speakerId, persona.id);
    const actorChannelNotes = this.options.actorChannels.promptNotes([persona], room.channelId);
    const actorExpertiseNotes = this.options.actorChannels.expertiseNotes([persona], room.channelId);

    let spoken = "";
    const generationAbort = new AbortController();
    this.generationAbortByRoom.set(room.id, generationAbort);
    try {
      const trustedSemanticFacts = [
        trusted.intentTrusted && analysis?.source === "lm"
          ? `intent=${analysis.intent.kind}; replyExpected=${analysis.intent.replyExpected}`
          : "",
        trusted.capabilityTrusted
          ? `asksAboutAcoustics=${trusted.asksAboutAcoustics}`
          : "",
        diegeticIdentityTurnPremise(trusted.asksAboutAiIdentity),
        trusted.interactionTrusted
          ? `interaction=${trusted.interaction.kind}; targetScope=${trusted.interaction.targetScope}; reactionNeed=${trusted.interaction.reactionNeed}; coarseness=${trusted.interaction.coarseness}; mutualBanterConfidence=${trusted.interaction.mutualBanterConfidence}`
          : "",
        trusted.moderationTrusted
          ? `moderationRisk=${trusted.moderation.risk}; moderationAction=${trusted.moderation.action}`
          : "",
        capabilityScene?.premise ?? "",
      ].filter(Boolean);
      const semanticPremise = trustedSemanticFacts.length > 0
        ? `Trusted multilingual turn facts: ${trustedSemanticFacts.join(". ")}`
        : "No sufficiently confident semantic classification is available for this turn. Infer meaning only from the newest utterance and make no assumptions from a fallback label.";
      const generated = await this.options.lm.generateScene(
        {
          kind: "voice",
          channelId: room.channelId,
          channelName: CHANNELS.find((channel) => channel.id === room.channelId)?.name ?? room.channelId,
          selected: [persona],
          history: transcriptFor(this.options.runtime.getTranscript(room.id), persona.id),
          trigger: { author: entry.speakerName, content: entry.text, messageId: entry.id, createdAt: entry.endedAt },
          mustReplyIds: [persona.id],
          // Every accepted human voice turn that reaches a selected resident is
          // entitled to one reviewed recovery even when semantic intent routing
          // is uncertain. This does not manufacture explicit request ownership.
          responseRecoveryIds: [persona.id],
          requestOwnerIds: (trusted.intentTrusted && trusted.replyExpected === "expected") || invocation
            ? [persona.id]
            : [],
          languageHint: routedLanguageHint(utteranceLanguage),
          semanticContext: {
            ...(utteranceLanguage ? { languageTag: utteranceLanguage } : {}),
            intentTrusted: trusted.intentTrusted,
            replyExpected: trusted.replyExpected,
            answerDepth: trusted.answerDepth,
            operationalMode: trusted.operationalMode,
            operationalModeTrusted: trusted.operationalModeTrusted,
            socialTrusted: trusted.socialTrusted,
            warmth: trusted.social.warmth,
            hostility: trusted.social.hostility,
            playfulness: trusted.social.playfulness,
            absurdity: trusted.social.absurdity,
            urgency: trusted.social.urgency,
            energy: trusted.social.energy,
            pileOnRisk: trusted.social.pileOnRisk,
            claimStrength: trusted.social.claimStrength,
            interactionTrusted: trusted.interactionTrusted,
            interactionKind: trusted.interaction.kind,
            targetScope: trusted.interaction.targetScope,
            reactionNeed: trusted.interaction.reactionNeed,
            coarseness: trusted.interaction.coarseness,
            mutualBanterConfidence: trusted.interaction.mutualBanterConfidence,
            moderationTrusted: trusted.moderationTrusted,
            moderationRisk: trusted.moderation.risk,
            moderationAction: trusted.moderation.action,
            moderationCategories: trusted.moderation.categories,
            asksForList: trusted.asksForList,
            asksAboutAiIdentity: trusted.asksAboutAiIdentity,
            asksAboutAcoustics: trusted.asksAboutAcoustics,
          },
          actorChannelNotes,
          actorExpertiseNotes,
          behaviorTuning,
          voiceContext: {
            latestSpeakerId: entry.speakerId,
            latestUtteranceOrigin: entry.utteranceOrigin,
            acceptedTranscriptAvailable: true,
            acousticEvidenceAvailable: false,
            participants: room.participants.map((participant) => ({
              memberId: participant.memberId,
              name: participant.name,
              kind: participant.kind,
            })),
          },
          ...(relationshipNote ? { relationshipNotes: { [persona.id]: relationshipNote } } : {}),
          ...(relationshipStylePlan
            ? { relationshipStylePlans: { [persona.id]: relationshipStylePlan } }
            : {}),
          ...(this.romanticInteractionPolicy(
            persona.id,
            entry.speakerId,
            entry.speakerKind === "ai" ? "resident" : "human",
          )
            ? { romanticInteractionPolicies: { [persona.id]: "ordinary_only" as const } }
            : {}),
          research: capabilityScene?.research,
          evidenceOutcome: capabilityScene?.evidenceOutcome,
          capabilityContext: sceneCapabilityContext,
          capabilityGroundingInstruction: capabilityScene?.groundingInstruction,
          urlPublicationPolicy: capabilityScene?.urlPublicationPolicy,
          requestedClock: capabilityScene?.requestedClock,
          temporalPolicy: capabilityScene?.temporalPolicy ?? "reactive_only",
          temporalSurfaceActorId: capabilityScene?.temporalPolicy ? persona.id : undefined,
          // Spoken turns should not pay for an optional stylistic rewrite and
          // second review. The mandatory first semantic review remains intact.
          humanizerBudget: { repairsRemaining: 0 },
          premise: `${persona.name} has joined an active multi-participant voice call. Answer the newest complete human utterance once, conversationally. The reply will be spoken aloud; do not narrate actions or produce another speaker. ${semanticPremise}`,
        },
        0,
        generationAbort.signal,
        { continuationOf: voiceRoomWorkScope(room.id) },
      );
      const generatedLine = generated.find((line) => line.personaId === persona.id);
      const reviewedOutputLanguage = generatedLine?.reviewedOutputLanguage &&
        generatedLine.reviewedOutputLanguage.confidence >= CANDIDATE_OUTPUT_LANGUAGE_TRUST_CONFIDENCE
        ? canonicalRegisteredLanguageTag(generatedLine.reviewedOutputLanguage.tag)
        : undefined;
      const outputLanguageConflictsWithRoute = Boolean(
        utteranceLanguage &&
        reviewedOutputLanguage &&
        primaryLanguage(utteranceLanguage) !== primaryLanguage(reviewedOutputLanguage),
      );
      if (
        !utteranceLanguage &&
        reviewedOutputLanguage
      ) {
        utteranceLanguage = reviewedOutputLanguage;
      }
      // The normal LM client rejects and retries this mismatch during semantic
      // review. Recheck at the voice boundary as defence in depth for alternate
      // providers: never feed text known to be another language into the
      // routed voice or persist it under false language metadata.
      spoken = outputLanguageConflictsWithRoute
        ? ""
        : sanitizeSpokenLine(generatedLine?.content ?? "", utteranceLanguage);
    } catch (error) {
      if (!generationAbort.signal.aborted) {
        console.warn("Voice scene used fallback:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (this.generationAbortByRoom.get(room.id) === generationAbort) this.generationAbortByRoom.delete(room.id);
    }
    sceneFinishedAt = performance.now();
    const capabilityFallback = this.options.capabilityRegistry.deterministicFallback(
      resolution,
      new Date(this.now()),
    );
    if (!spoken && capabilityFallback) {
      spoken = sanitizeSpokenLine(
        capabilityFallback.content,
        utteranceLanguage,
      );
    }
    if (!spoken || !this.isCurrent(room.id, epoch, persona.id)) {
      if (this.isCurrent(room.id, epoch, persona.id)) this.setBotState(room.id, persona.id, "listening");
      return;
    }

    const voiceProfile = voiceProfileForPersona(persona.id, utteranceLanguage);
    let audio: { id: string; mimeType: string } | undefined;
    let browserFallbackAllowed = false;
    const speechAbort = new AbortController();
    this.speechAbortByRoom.set(room.id, speechAbort);
    try {
      const capabilities = await this.options.speech.capabilities();
      browserFallbackAllowed = capabilities.browserFallbackAllowed;
      if (
        capabilities.tts.available &&
        ttsModelSupportsLanguage(capabilities.tts.supportedLanguages, utteranceLanguage)
      ) {
        const mappedVoice = mappedProviderVoiceForPersona(persona.id, utteranceLanguage);
        const providerVoice = mappedVoice
          ?? (capabilities.tts.model === "piper-sv" ? voiceProfile?.providerVoice : undefined)
          ?? capabilities.tts.defaultVoice;
        if (!providerVoice) throw new Error("TTS provider has no configured voice for this turn");
        const stored = await this.options.speech.synthesize({
          roomId: room.id,
          text: spoken,
          language: utteranceLanguage,
          voice: providerVoice,
          speed: voiceProfile?.speed ?? 1,
          signal: speechAbort.signal,
        });
        audio = { id: stored.id, mimeType: stored.mimeType };
      }
    } catch (error) {
      if (!speechAbort.signal.aborted) {
        console.warn("Voice TTS unavailable; clients may use their disclosed browser voice:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (this.speechAbortByRoom.get(room.id) === speechAbort) this.speechAbortByRoom.delete(room.id);
    }
    if (!this.isCurrent(room.id, epoch, persona.id)) return;

    const appended = this.options.runtime.appendFinalTranscript(room.id, persona.id, spoken, {
      utteranceOrigin: "ai-tts",
      ...(utteranceLanguage ? { language: utteranceLanguage } : {}),
    });
    if (!appended.ok) return;
    if (utteranceLanguage) this.establishedLanguageByRoom.set(room.id, utteranceLanguage);
    this.options.humanMemory?.updateRelation(entry.speakerId, persona.id, {
      familiarity: Math.min(1, (previousRelation?.familiarity ?? 0) + 0.05),
    });
    this.options.lm.rememberDeliveredLine?.(persona.id, spoken, {
      kind: "voice",
      channelId: room.channelId,
      channelName: room.channelId,
    });
    this.options.actorChannels.markSpoke(persona.id, room.channelId, entry.id);
    this.lastSpokeAtByPersona.set(persona.id, this.now());
    this.setBotState(room.id, persona.id, "speaking");
    this.options.events.transcriptFinal(appended.entry);
    this.captureDeliveredVoiceEpisode(room, entry, appended.entry);
    this.options.events.aiSpeech({
      roomId: room.id,
      memberId: persona.id,
      text: spoken,
      utteranceId: appended.entry.id,
      browserFallbackAllowed,
      ...(utteranceLanguage ? { language: utteranceLanguage } : {}),
      ...(voiceProfile ? {
        // Language belongs to this utterance, never to a persona profile. When
        // classification is unavailable, omit it so the browser uses the
        // human caller's own locale instead of a hard-coded language.
        browserRate: voiceProfile.browserRate,
        browserPitch: voiceProfile.browserPitch,
      } : {}),
      ...(audio ? { audioUrl: `/api/voice/audio/${encodeURIComponent(audio.id)}?roomId=${encodeURIComponent(room.id)}`, mimeType: audio.mimeType } : {}),
    });
    if (process.env.VOICE_LATENCY_LOG === "true") {
      const finishedAt = performance.now();
      console.info(JSON.stringify({
        event: "voice_latency",
        analysisMs: Math.round(analysisFinishedAt - latencyStartedAt),
        capabilityMs: Math.round(capabilityFinishedAt - analysisFinishedAt),
        sceneAndReviewMs: Math.round(sceneFinishedAt - capabilityFinishedAt),
        ttsAndPublishMs: Math.round(finishedAt - sceneFinishedAt),
        totalMs: Math.round(finishedAt - latencyStartedAt),
      }));
    }

    const estimatedSpeakingMs = estimatedSpeechDurationMs(spoken, utteranceLanguage);
    const timer = setTimeout(() => {
      if (this.isCurrent(room.id, epoch, persona.id)) this.setBotState(room.id, persona.id, "listening");
    }, estimatedSpeakingMs);
    timer.unref();
    // Prepare, review and synthesize the other resident while this line is
    // playing. Publication is held until the estimated floor is free, so the
    // second resident follows naturally without paying another router pass or
    // the minute-scale cadence used by autonomous public rooms.
    const invitedIds = new Set(invited.map((candidate) => candidate.id));
    const exactAddressedIds = invited
      .filter((candidate) => explicitlyMentionsPersona(entry.text, candidate.name))
      .map((candidate) => candidate.id);
    // Structural exact mentions are authoritative. Semantic address inference
    // is used only when the transport supplied no exact target, so an
    // over-broad router result can never turn a private @mention into a pile-on.
    const addressedResidents = [...new Set(
      exactAddressedIds.length > 0 ? exactAddressedIds : trusted.inferredAddressedIds,
    )].filter((id) => invitedIds.has(id));
    const relevantResidents = trusted.relevantIds.filter((id) => invitedIds.has(id));
    const semanticallySharedFloor = addressedResidents.length >= 2 ||
      (addressedResidents.length === 0 && relevantResidents.length >= 2) ||
      (trusted.interactionTrusted && ["room", "group"].includes(trusted.interaction.targetScope));
    const moderationOwnsTurn = trusted.moderationTrusted && trusted.moderation.action !== "none";
    const pileOnRisk = trusted.socialTrusted && trusted.social.pileOnRisk >= 0.45;
    // A single trusted addressee owns a private/direct question. The other
    // resident joins only a semantically open/plural floor and never a
    // moderation or likely pile-on turn.
    if (invited.length === 2 && addressedResidents.length !== 1 && semanticallySharedFloor && !moderationOwnsTurn && !pileOnRisk) {
      void this.prepareResidentFollowUp(
        room.id,
        appended.entry,
        epoch,
        utteranceLanguage,
        this.now() + estimatedSpeakingMs,
      );
    }
  }

  private residentFollowUpPersona(
    roomId: string,
    sourceEntry: VoiceTranscriptEntry,
  ): { room: VoiceRoomView; persona: Persona } | undefined {
    if (this.options.residentFollowUpEnabled !== true || sourceEntry.speakerKind !== "ai") return undefined;
    const room = this.options.runtime.getRoom(roomId);
    if (!room || !room.participants.some((participant) => participant.kind === "human" && !participant.deafened)) {
      return undefined;
    }
    const residents = room.participants.filter((participant) => participant.kind === "ai");
    // The runtime already caps AI guests at two. Requiring exactly two here
    // makes the continuation contract explicit and prevents fan-out if that
    // transport limit ever changes.
    if (residents.length !== 2) return undefined;
    const target = residents.find((participant) =>
      participant.memberId !== sourceEntry.speakerId &&
      sourceEntry.heardByPersonaIds.includes(participant.memberId) &&
      ["listening", "thinking", "speaking"].includes(participant.botState ?? "")
    );
    if (!target) return undefined;
    const persona = PERSONAS.find((candidate) => candidate.id === target.memberId);
    return persona ? { room, persona } : undefined;
  }

  /**
   * Produce at most one resident-to-resident continuation for a human-rooted
   * voice turn. This method never calls itself: AI transcript entries remain
   * transport-ineligible triggers, so the chain is structurally bounded.
   */
  private async prepareResidentFollowUp(
    roomId: string,
    sourceEntry: VoiceTranscriptEntry,
    epoch: number,
    language: string | undefined,
    floorAvailableAt: number,
  ): Promise<void> {
    const selected = this.residentFollowUpPersona(roomId, sourceEntry);
    if (!selected || this.epochByRoom.get(roomId) !== epoch) return;
    const { room, persona } = selected;
    const sourceRosterFingerprint = voiceRosterFingerprint(room);
    const configuredGap = this.options.residentFollowUpGapMs ?? DEFAULT_RESIDENT_FOLLOW_UP_GAP_MS;
    const gapMs = Math.max(MIN_RESIDENT_FOLLOW_UP_GAP_MS, Math.min(MAX_RESIDENT_FOLLOW_UP_GAP_MS, configuredGap));
    const publicationTargetAt = floorAvailableAt + gapMs;
    // Optional voice texture is useful only as an immediate floor handoff. A
    // slow local model must never surface it as an unrelated interruption a
    // minute later, even though ordinary LM calls have a much larger timeout.
    const configuredMaxLateness = this.options.residentFollowUpMaxLatenessMs;
    const maxLatenessMs = typeof configuredMaxLateness === "number" && Number.isFinite(configuredMaxLateness)
      ? Math.max(
          MIN_RESIDENT_FOLLOW_UP_MAX_LATENESS_MS,
          Math.min(MAX_RESIDENT_FOLLOW_UP_MAX_LATENESS_MS, configuredMaxLateness),
        )
      : DEFAULT_RESIDENT_FOLLOW_UP_MAX_LATENESS_MS;
    const publicationDeadlineAt = publicationTargetAt + maxLatenessMs;
    const deadlineExpired = (): boolean => this.now() >= publicationDeadlineAt;
    const armDeadlineAbort = (controller: AbortController): ReturnType<typeof setTimeout> | undefined => {
      const remainingMs = publicationDeadlineAt - this.now();
      if (remainingMs <= 0) {
        controller.abort(new Error("Resident voice follow-up deadline exceeded"));
        return undefined;
      }
      const timer = setTimeout(() => {
        controller.abort(new Error("Resident voice follow-up deadline exceeded"));
      }, remainingMs);
      timer.unref();
      return timer;
    };
    this.setBotState(roomId, persona.id, "thinking");

    const behaviorTuning = resolveBehaviorTuning(
      this.options.behaviorTuningProvider,
      room.channelId,
    ).effective;
    const actorChannelNotes = this.options.actorChannels.promptNotes([persona], room.channelId);
    const actorExpertiseNotes = this.options.actorChannels.expertiseNotes([persona], room.channelId);
    const relationshipNote = combinedRelationshipNote(
      this.voiceRelationshipNote(persona.id, sourceEntry.speakerId),
      this.options.socialMemory?.promptNote(
        persona.id,
        sourceEntry.speakerId,
        voiceSocialScope(room),
        {
          romanticSceneEligibility: this.romanticSceneEligibility(
            persona.id,
            sourceEntry.speakerId,
            sourceEntry.speakerKind === "ai" ? "resident" : "human",
          ),
        },
      ),
    );
    const relationshipStylePlan = this.voiceRelationshipStylePlan(persona.id, sourceEntry.speakerId);
    let spoken = "";
    let utteranceLanguage = canonicalRegisteredLanguageTag(language);
    const generationAbort = new AbortController();
    this.generationAbortByRoom.set(roomId, generationAbort);
    const generationDeadlineTimer = armDeadlineAbort(generationAbort);
    try {
      const generated = await this.options.lm.generateScene(
        {
          kind: "voice",
          channelId: room.channelId,
          channelName: CHANNELS.find((channel) => channel.id === room.channelId)?.name ?? room.channelId,
          selected: [persona],
          history: transcriptFor(this.options.runtime.getTranscript(roomId), persona.id),
          trigger: {
            author: sourceEntry.speakerName,
            content: sourceEntry.text,
            messageId: sourceEntry.id,
            createdAt: sourceEntry.endedAt,
          },
          mustReplyIds: [persona.id],
          responseRecoveryIds: [persona.id],
          languageHint: utteranceLanguage ?? "continue in the established language of this live voice conversation",
          semanticContext: {
            ...(utteranceLanguage ? { languageTag: utteranceLanguage } : {}),
            intentTrusted: false,
            replyExpected: "optional",
            answerDepth: "brief",
            operationalMode: "general",
            operationalModeTrusted: false,
            socialTrusted: false,
            interactionTrusted: false,
            moderationTrusted: false,
            asksForList: false,
            asksAboutAiIdentity: false,
            asksAboutAcoustics: false,
          },
          actorChannelNotes,
          actorExpertiseNotes,
          behaviorTuning,
          voiceContext: {
            latestSpeakerId: sourceEntry.speakerId,
            latestSpeakerKind: "ai",
            latestUtteranceOrigin: "ai-tts",
            acceptedTranscriptAvailable: true,
            acousticEvidenceAvailable: false,
            participants: room.participants.map((participant) => ({
              memberId: participant.memberId,
              name: participant.name,
              kind: participant.kind,
            })),
          },
          ...(relationshipNote ? { relationshipNotes: { [persona.id]: relationshipNote } } : {}),
          ...(relationshipStylePlan
            ? { relationshipStylePlans: { [persona.id]: relationshipStylePlan } }
            : {}),
          ...(this.romanticInteractionPolicy(
            persona.id,
            sourceEntry.speakerId,
            sourceEntry.speakerKind === "ai" ? "resident" : "human",
          )
            ? { romanticInteractionPolicies: { [persona.id]: "ordinary_only" as const } }
            : {}),
          capabilityContext: {
            available: [],
            externalEvidenceAvailable: false,
            requestKind: "none",
            discussed: [],
            plannedAction: null,
            executionStatus: "not_requested",
          },
          temporalPolicy: "reactive_only",
          humanizerBudget: { repairsRemaining: 0 },
          premise: `${persona.name} gives one brief, direct peer reaction to ${sourceEntry.speakerName}'s immediately preceding spoken turn. Add a disagreement, question, joke, or concrete thought only if it follows naturally. Do not restart the topic, answer on behalf of a guest, invite a response, or produce more than this single follow-up.`,
        },
        2,
        generationAbort.signal,
        { preemptibleBackground: true },
      );
      const generatedLine = generated.find((line) => line.personaId === persona.id);
      const reviewedOutputLanguage = generatedLine?.reviewedOutputLanguage &&
        generatedLine.reviewedOutputLanguage.confidence >= CANDIDATE_OUTPUT_LANGUAGE_TRUST_CONFIDENCE
        ? canonicalRegisteredLanguageTag(generatedLine.reviewedOutputLanguage.tag)
        : undefined;
      if (!utteranceLanguage && reviewedOutputLanguage) utteranceLanguage = reviewedOutputLanguage;
      const languageConflict = Boolean(
        utteranceLanguage &&
        reviewedOutputLanguage &&
        primaryLanguage(utteranceLanguage) !== primaryLanguage(reviewedOutputLanguage),
      );
      spoken = languageConflict ? "" : sanitizeSpokenLine(generatedLine?.content ?? "", utteranceLanguage);
    } catch (error) {
      if (!generationAbort.signal.aborted && !isBackgroundWorkPreemptedError(error)) {
        console.warn("Resident voice follow-up was skipped:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (generationDeadlineTimer) clearTimeout(generationDeadlineTimer);
      if (this.generationAbortByRoom.get(roomId) === generationAbort) {
        this.generationAbortByRoom.delete(roomId);
      }
    }
    if (!spoken || deadlineExpired() || !this.isCurrent(roomId, epoch, persona.id)) {
      if (this.isCurrent(roomId, epoch, persona.id)) this.setBotState(roomId, persona.id, "listening");
      return;
    }

    const voiceProfile = voiceProfileForPersona(persona.id, utteranceLanguage);
    let audio: { id: string; mimeType: string } | undefined;
    let browserFallbackAllowed = false;
    const speechAbort = new AbortController();
    this.speechAbortByRoom.set(roomId, speechAbort);
    const speechDeadlineTimer = armDeadlineAbort(speechAbort);
    try {
      const capabilities = await this.options.speech.capabilities();
      browserFallbackAllowed = capabilities.browserFallbackAllowed;
      if (
        capabilities.tts.available &&
        ttsModelSupportsLanguage(capabilities.tts.supportedLanguages, utteranceLanguage)
      ) {
        const mappedVoice = mappedProviderVoiceForPersona(persona.id, utteranceLanguage);
        const providerVoice = mappedVoice
          ?? (capabilities.tts.model === "piper-sv" ? voiceProfile?.providerVoice : undefined)
          ?? capabilities.tts.defaultVoice;
        if (!providerVoice) throw new Error("TTS provider has no configured voice for this turn");
        const stored = await this.options.speech.synthesize({
          roomId,
          text: spoken,
          language: utteranceLanguage,
          voice: providerVoice,
          speed: voiceProfile?.speed ?? 1,
          signal: speechAbort.signal,
        });
        audio = { id: stored.id, mimeType: stored.mimeType };
      }
    } catch (error) {
      if (!speechAbort.signal.aborted) {
        console.warn("Resident follow-up TTS unavailable; clients may use browser speech:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (speechDeadlineTimer) clearTimeout(speechDeadlineTimer);
      if (this.speechAbortByRoom.get(roomId) === speechAbort) this.speechAbortByRoom.delete(roomId);
    }
    if (deadlineExpired() || !this.isCurrent(roomId, epoch, persona.id)) {
      if (this.isCurrent(roomId, epoch, persona.id)) this.setBotState(roomId, persona.id, "listening");
      return;
    }

    const delayMs = Math.max(0, publicationTargetAt - this.now());
    const configuredFloorGrace = this.options.residentFollowUpFloorGraceMs ?? DEFAULT_RESIDENT_FOLLOW_UP_FLOOR_GRACE_MS;
    const floorGraceMs = Math.max(0, Math.min(MAX_RESIDENT_FOLLOW_UP_FLOOR_GRACE_MS, configuredFloorGrace));
    let publicationTimer: ReturnType<typeof setTimeout> | undefined;
    const schedulePublication = (delay: number): void => {
      publicationTimer = setTimeout(attemptPublication, delay);
      publicationTimer.unref();
      this.pendingResidentFollowUpTimerByRoom.set(roomId, publicationTimer);
    };
    const attemptPublication = (): void => {
      if (!publicationTimer || this.pendingResidentFollowUpTimerByRoom.get(roomId) !== publicationTimer) return;
      this.pendingResidentFollowUpTimerByRoom.delete(roomId);
      const stillEligible = this.residentFollowUpPersona(roomId, sourceEntry);
      const humanOwnsFloor = stillEligible?.room.participants.some(
        (participant) => participant.kind === "human" && participant.speaking,
      ) ?? false;
      if (
        deadlineExpired() ||
        !stillEligible ||
        stillEligible.persona.id !== persona.id ||
        voiceRosterFingerprint(stillEligible.room) !== sourceRosterFingerprint ||
        !this.isCurrent(roomId, epoch, persona.id) ||
        humanOwnsFloor ||
        this.options.hasPendingHumanIngest?.(roomId)
      ) {
        if (this.isCurrent(roomId, epoch, persona.id)) this.setBotState(roomId, persona.id, "listening");
        return;
      }
      const lastFloorActivityAt = this.options.runtime.lastHumanFloorActivityAt(roomId);
      const floorGraceRemainingMs = lastFloorActivityAt === undefined
        ? 0
        : Math.max(0, lastFloorActivityAt + floorGraceMs - this.now());
      if (floorGraceRemainingMs > 0) {
        // A browser may mark speaking=false a fraction before its HTTP upload
        // reaches the server. Keep the already prepared optional line warm for
        // this short bridge instead of racing the incoming accepted turn.
        schedulePublication(Math.min(
          floorGraceRemainingMs,
          Math.max(1, publicationDeadlineAt - this.now()),
        ));
        return;
      }
      const currentRoom = stillEligible.room;
      const appended = this.options.runtime.appendFinalTranscript(roomId, persona.id, spoken, {
        utteranceOrigin: "ai-tts",
        ...(utteranceLanguage ? { language: utteranceLanguage } : {}),
      });
      if (!appended.ok) {
        this.setBotState(roomId, persona.id, "listening");
        return;
      }
      if (utteranceLanguage) this.establishedLanguageByRoom.set(roomId, utteranceLanguage);
      this.options.lm.rememberDeliveredLine?.(persona.id, spoken, {
        kind: "voice",
        channelId: currentRoom.channelId,
        channelName: currentRoom.channelId,
      });
      this.options.actorChannels.markSpoke(persona.id, currentRoom.channelId, sourceEntry.id);
      this.lastSpokeAtByPersona.set(persona.id, this.now());
      this.setBotState(roomId, persona.id, "speaking");
      this.options.events.transcriptFinal(appended.entry);
      this.options.events.aiSpeech({
        roomId,
        memberId: persona.id,
        text: spoken,
        utteranceId: appended.entry.id,
        browserFallbackAllowed,
        ...(utteranceLanguage ? { language: utteranceLanguage } : {}),
        ...(voiceProfile ? {
          browserRate: voiceProfile.browserRate,
          browserPitch: voiceProfile.browserPitch,
        } : {}),
        ...(audio ? {
          audioUrl: `/api/voice/audio/${encodeURIComponent(audio.id)}?roomId=${encodeURIComponent(roomId)}`,
          mimeType: audio.mimeType,
        } : {}),
      });
      const speakingMs = estimatedSpeechDurationMs(spoken, utteranceLanguage);
      const listeningTimer = setTimeout(() => {
        if (this.isCurrent(roomId, epoch, persona.id)) this.setBotState(roomId, persona.id, "listening");
      }, speakingMs);
      listeningTimer.unref();
    };
    const previous = this.pendingResidentFollowUpTimerByRoom.get(roomId);
    if (previous) clearTimeout(previous);
    schedulePublication(delayMs);
  }

  private captureDeliveredVoiceEpisode(
    room: VoiceRoomView,
    humanEntry: VoiceTranscriptEntry,
    residentEntry: VoiceTranscriptEntry,
  ): void {
    const coordinator = this.options.socialMemory;
    if (!coordinator) return;
    const participants = room.participants.map((participant) => {
      const kind = participant.kind === "ai" ? "resident" as const : "human" as const;
      return {
        id: participant.memberId,
        kind,
        displayName: participant.name,
        romanceEligible: this.romanceEligibleActor(participant.memberId, kind),
      };
    });
    const eligibleResidentOwners = room.participants.flatMap((participant) => {
      if (participant.kind !== "ai") return [];
      const witnessedMessageIds = [
        ...(humanEntry.heardByPersonaIds.includes(participant.memberId) ? [humanEntry.id] : []),
        ...(residentEntry.speakerId === participant.memberId || residentEntry.heardByPersonaIds.includes(participant.memberId)
          ? [residentEntry.id]
          : []),
      ];
      if (witnessedMessageIds.length === 0) return [];
      const persona = PERSONAS.find((candidate) => candidate.id === participant.memberId);
      return [{
        residentId: participant.memberId,
        witnessedMessageIds,
        appraisalNote: (persona?.prompt ?? `${participant.name} is a participant in this voice room.`).slice(0, 480),
      }];
    });
    if (eligibleResidentOwners.length === 0) return;
    const profile = getChannelProfile(room.channelId);
    void coordinator.enqueueDeliveredEpisode({
      episodeId: `voice_${humanEntry.id}_${residentEntry.id}`,
      origin: "human",
      scope: voiceSocialScope(room),
      channel: {
        name: profile?.public.name ?? room.channelId,
        ...(profile?.topic.brief ? { topic: profile.topic.brief } : {}),
      },
      participants,
      messages: [humanEntry, residentEntry].map((entry) => ({
        id: entry.id,
        authorId: entry.speakerId,
        authorKind: entry.speakerKind === "ai" ? "resident" as const : "human" as const,
        content: entry.text,
        createdAt: entry.endedAt,
      })),
      eligibleResidentOwners,
    }).catch((error) => {
      console.warn("Voice social memory capture failed safely:", error instanceof Error ? error.message : error);
    });
  }
}

export { sanitizeSpokenLine };
