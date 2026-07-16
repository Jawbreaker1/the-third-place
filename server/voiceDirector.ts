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
  lm: Pick<SocialModelClient, "analyzeTurn" | "generateScene"> & Partial<Pick<SocialModelClient, "rememberDeliveredLine">>;
  speech: Pick<VoiceSpeechService, "capabilities" | "synthesize">;
  actorChannels: ActorChannelRuntime;
  events: VoiceDirectorEvents;
  humanMemory?: Pick<HumanMemory, "promptNote" | "getRelation" | "updateRelation">;
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
    return [...invited].sort((a, b) => {
      const score = (persona: Persona) => {
        const age = this.now() - (this.lastSpokeAtByPersona.get(persona.id) ?? 0);
        const cooldownPenalty = age < persona.cooldownMs ? 0.9 : 0;
        return this.options.actorChannels.affinity(persona.id, channelId) + persona.talkativeness * 0.45 + persona.curiosity * 0.2 - cooldownPenalty;
      };
      return score(b) - score(a) || a.id.localeCompare(b.id);
    })[0];
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
      ? this.options.humanMemory?.promptNote(entry.speakerId, solePersona.id)
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

    // Capture only the memory that predates this turn. Voice transcripts never
    // enter long-term memory; a completed exchange merely strengthens rapport.
    const relationshipNote = solePersona?.id === persona.id
      ? soleRelationshipNote
      : this.options.humanMemory?.promptNote(entry.speakerId, persona.id);
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
            acousticEvidenceAvailable: false,
            participants: room.participants.map((participant) => ({
              memberId: participant.memberId,
              name: participant.name,
              kind: participant.kind,
            })),
          },
          ...(relationshipNote ? { relationshipNotes: { [persona.id]: relationshipNote } } : {}),
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

    const estimatedSpeakingMs = Math.max(
      1_200,
      Math.min(12_000, 550 + speechTimingUnits(spoken, utteranceLanguage) * 310),
    );
    const timer = setTimeout(() => {
      if (this.isCurrent(room.id, epoch, persona.id)) this.setBotState(room.id, persona.id, "listening");
    }, estimatedSpeakingMs);
    timer.unref();
  }
}

export { sanitizeSpokenLine };
