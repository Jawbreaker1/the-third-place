import type { VoiceRoomView, VoiceTranscriptEntry } from "../shared/types.js";
import { speechTimingUnits, truncateSpokenText } from "../shared/spokenText.js";
import { containsExactMention } from "../shared/unicodeBoundaries.js";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { CHANNELS, getChannelProfile } from "./channels.js";
import type { HumanMemory } from "./humanMemory.js";
import type { LmStudioClient, TranscriptLine } from "./lmStudio.js";
import { PERSONAS, type Persona } from "./personas.js";
import { voiceProfileForPersona } from "./personaVoices.js";
import {
  projectTrustedTurnAnalysis,
  type TurnAnalysis,
  type TurnAnalysisInput,
} from "./semanticRouter.js";
import type { VoiceRoomRuntime } from "./voiceRooms.js";
import { ttsLanguageIsSupported, type VoiceSpeechService } from "./voiceSpeech.js";
import { resolveLocalDateTime } from "./timeResolver.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";

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

export interface VoiceDirectorOptions {
  runtime: VoiceRoomRuntime;
  lm: Pick<LmStudioClient, "analyzeTurn" | "generateScene"> & Partial<Pick<LmStudioClient, "rememberDeliveredLine">>;
  speech: Pick<VoiceSpeechService, "capabilities" | "synthesize">;
  actorChannels: ActorChannelRuntime;
  events: VoiceDirectorEvents;
  humanMemory?: Pick<HumanMemory, "promptNote" | "getRelation" | "updateRelation">;
  now?: () => number;
  /** Quiet floor after the latest completed human turn; production uses this to coalesce overlapping speakers. */
  floorSilenceMs?: number;
  /** True while a human clip in this room is queued, uploading or being transcribed. */
  hasPendingHumanIngest?: (roomId: string) => boolean;
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

const analysisInputFor = (
  entry: VoiceTranscriptEntry,
  room: VoiceRoomView,
  transcript: VoiceTranscriptEntry[],
  invited: Persona[],
): TurnAnalysisInput => {
  const channel = getChannelProfile(room.channelId);
  const transportLanguageHint = canonicalRegisteredLanguageTag(entry.language);
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
    recentMessages: transcript
      .filter((candidate) => candidate.id !== entry.id)
      .slice(-8)
      .map((candidate) => ({
        id: candidate.id,
        authorId: candidate.speakerId,
        authorName: candidate.speakerName.slice(0, 80),
        content: candidate.text.slice(0, 1_200),
        createdAt: candidate.endedAt,
      })),
    personaCandidates: invited.map((persona) => ({
      id: persona.id,
      name: persona.name,
      interests: persona.interests.slice(0, 16),
    })),
    // Voice never fetches URLs or performs open web search. Server-clock facts
    // are safe, bounded and useful in exactly the same languages as text chat.
    availableCapabilities: ["local_datetime"],
    urlCandidates: [],
    ...(transportLanguageHint ? { transportLanguageHint } : {}),
  };
};

const routedLanguage = (analysis: TurnAnalysis | undefined, transcriptLanguage?: string): string | undefined => {
  const transcribed = canonicalRegisteredLanguageTag(transcriptLanguage);
  const classified = canonicalRegisteredLanguageTag(projectTrustedTurnAnalysis(analysis).languageTag);
  // Provider-reported STT language is trusted transport metadata. It wins over
  // a semantic router guess; typed voice turns have no such transport hint.
  return transcribed ?? classified;
};

const routedLanguageHint = (language: string | undefined): string =>
  language ?? "infer and mirror the language of the latest human utterance directly";

/** Server TTS is allowed only for provider-declared BCP-47 ranges. */
export const ttsModelSupportsLanguage = (
  supportedLanguages: readonly string[] | undefined,
  language: string | undefined,
): boolean => ttsLanguageIsSupported(supportedLanguages, language);

export class VoiceDirector {
  private readonly epochByRoom = new Map<string, number>();
  private readonly lastSpokeAtByPersona = new Map<string, number>();
  private readonly speechAbortByRoom = new Map<string, AbortController>();
  private readonly generationAbortByRoom = new Map<string, AbortController>();
  private readonly pendingResponseTimerByRoom = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly options: VoiceDirectorOptions) {
    this.now = options.now ?? Date.now;
  }

  onHumanFinal(entry: VoiceTranscriptEntry): void {
    if (entry.speakerKind !== "human" || !entry.final || !entry.trigger.eligible || entry.trigger.source !== "human-final") return;
    const epoch = this.invalidateRoom(entry.roomId);
    this.resetBotsToListening(entry.roomId);
    const floorSilenceMs = Math.max(0, this.options.floorSilenceMs ?? 0);
    if (floorSilenceMs === 0) {
      void this.respond(entry, epoch);
      return;
    }
    this.scheduleFloorResponse(entry, epoch, floorSilenceMs);
  }

  /** Human speech owns the floor immediately, before STT has finished. */
  onHumanSpeechStarted(roomId: string): void {
    const hasActiveAiWork = this.pendingResponseTimerByRoom.has(roomId) ||
      this.generationAbortByRoom.has(roomId) ||
      this.speechAbortByRoom.has(roomId) ||
      (this.options.runtime.getRoom(roomId)?.participants.some(
        (participant) => participant.kind === "ai" && (participant.botState === "thinking" || participant.botState === "speaking"),
      ) ?? false);
    if (!hasActiveAiWork) return;
    this.invalidateRoom(roomId);
    this.resetBotsToListening(roomId);
  }

  invalidateRoom(roomId: string): number {
    const pending = this.pendingResponseTimerByRoom.get(roomId);
    if (pending) clearTimeout(pending);
    this.pendingResponseTimerByRoom.delete(roomId);
    this.generationAbortByRoom.get(roomId)?.abort(new Error("Voice turn superseded"));
    this.generationAbortByRoom.delete(roomId);
    this.speechAbortByRoom.get(roomId)?.abort(new Error("Voice turn superseded"));
    this.speechAbortByRoom.delete(roomId);
    const epoch = (this.epochByRoom.get(roomId) ?? 0) + 1;
    this.epochByRoom.set(roomId, epoch);
    this.options.events.aiStop({ roomId });
    return epoch;
  }

  forgetRoom(roomId: string): void {
    const pending = this.pendingResponseTimerByRoom.get(roomId);
    if (pending) clearTimeout(pending);
    this.pendingResponseTimerByRoom.delete(roomId);
    this.generationAbortByRoom.get(roomId)?.abort(new Error("Voice room closed"));
    this.generationAbortByRoom.delete(roomId);
    this.speechAbortByRoom.get(roomId)?.abort(new Error("Voice room closed"));
    this.speechAbortByRoom.delete(roomId);
    this.epochByRoom.delete(roomId);
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
    const explicitMention = invited.find((persona) => explicitlyMentionsPersona(entry.text, persona.name));
    if (explicitMention) return explicitMention;
    const inferredIds = projectTrustedTurnAnalysis(analysis).inferredAddressedIds;
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

  private scheduleFloorResponse(entry: VoiceTranscriptEntry, epoch: number, delayMs: number): void {
    const timer = setTimeout(() => {
      if (this.pendingResponseTimerByRoom.get(entry.roomId) !== timer) return;
      const humanStillSpeaking = this.options.runtime.getRoom(entry.roomId)?.participants.some(
        (participant) => participant.kind === "human" && participant.speaking,
      ) ?? false;
      if (humanStillSpeaking || this.options.hasPendingHumanIngest?.(entry.roomId)) {
        this.scheduleFloorResponse(entry, epoch, 250);
        return;
      }
      this.pendingResponseTimerByRoom.delete(entry.roomId);
      if (this.epochByRoom.get(entry.roomId) === epoch) void this.respond(entry, epoch);
    }, delayMs);
    timer.unref();
    this.pendingResponseTimerByRoom.set(entry.roomId, timer);
  }

  private async respond(entry: VoiceTranscriptEntry, epoch: number): Promise<void> {
    const room = this.options.runtime.getRoom(entry.roomId);
    if (!room) return;
    const invited = this.invitedPersonas(entry);
    if (invited.length === 0) return;
    const transcript = this.options.runtime.getTranscript(room.id);
    let analysis: TurnAnalysis | undefined;
    try {
      analysis = await this.options.lm.analyzeTurn(analysisInputFor(entry, room, transcript, invited));
    } catch (error) {
      console.warn("Voice semantic analysis unavailable; using neutral routing:", error instanceof Error ? error.message : error);
    }
    if (this.epochByRoom.get(room.id) !== epoch) return;
    const trusted = projectTrustedTurnAnalysis(analysis);
    const utteranceLanguage = routedLanguage(analysis, entry.language);
    const localDateTime = analysis?.source === "lm" &&
      trusted.evidenceTrusted &&
      analysis.evidence.action === "local_datetime" &&
      analysis.evidence.timeZone &&
      analysis.evidence.locationLabel
      ? resolveLocalDateTime({
          timeZone: analysis.evidence.timeZone,
          locationLabel: analysis.evidence.locationLabel,
          languageTag: utteranceLanguage,
          now: new Date(this.now()),
        })
      : undefined;
    const persona = this.selectPersona(entry, room, invited, analysis);
    if (!persona) return;
    this.setBotState(room.id, persona.id, "thinking");

    // Capture only the memory that predates this turn. Voice transcripts never
    // enter long-term memory; a completed exchange merely strengthens rapport.
    const relationshipNote = this.options.humanMemory?.promptNote(entry.speakerId, persona.id);
    const previousRelation = this.options.humanMemory?.getRelation(entry.speakerId, persona.id);

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
        localDateTime
          ? `${localDateTime.promptFact} Answer from this server clock fact without estimating.`
          : "",
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
          trigger: { author: entry.speakerName, content: entry.text, messageId: entry.id },
          mustReplyIds: [persona.id],
          languageHint: routedLanguageHint(utteranceLanguage),
          semanticContext: {
            ...(utteranceLanguage ? { languageTag: utteranceLanguage } : {}),
            asksForList: trusted.asksForList,
            asksAboutAiIdentity: trusted.asksAboutAiIdentity,
            asksAboutAcoustics: trusted.asksAboutAcoustics,
          },
          actorChannelNotes: this.options.actorChannels.promptNotes([persona], room.channelId),
          actorExpertiseNotes: this.options.actorChannels.expertiseNotes([persona], room.channelId),
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
          premise: `${persona.name} has joined an active multi-participant voice call. Answer the newest complete human utterance once, conversationally. The reply will be spoken aloud; do not narrate actions or produce another speaker. ${semanticPremise}`,
        },
        0,
        generationAbort.signal,
      );
      spoken = sanitizeSpokenLine(generated.find((line) => line.personaId === persona.id)?.content ?? "", utteranceLanguage);
    } catch (error) {
      if (!generationAbort.signal.aborted) {
        console.warn("Voice scene used fallback:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (this.generationAbortByRoom.get(room.id) === generationAbort) this.generationAbortByRoom.delete(room.id);
    }
    if (!spoken && localDateTime) spoken = sanitizeSpokenLine(localDateTime.fallbackText, utteranceLanguage);
    if (!spoken || !this.isCurrent(room.id, epoch, persona.id)) {
      if (this.isCurrent(room.id, epoch, persona.id)) this.setBotState(room.id, persona.id, "listening");
      return;
    }

    const voiceProfile = voiceProfileForPersona(persona.id);
    if (!voiceProfile) {
      console.warn(`Voice profile missing for ${persona.id}; server synthesis is disabled for this turn.`);
    }
    let audio: { id: string; mimeType: string } | undefined;
    let browserFallbackAllowed = false;
    const speechAbort = new AbortController();
    this.speechAbortByRoom.set(room.id, speechAbort);
    try {
      const capabilities = await this.options.speech.capabilities();
      browserFallbackAllowed = capabilities.browserFallbackAllowed;
      if (
        capabilities.tts.available &&
        voiceProfile &&
        ttsModelSupportsLanguage(capabilities.tts.supportedLanguages, utteranceLanguage)
      ) {
        const providerVoice = capabilities.tts.model === "piper-sv"
          ? voiceProfile.providerVoice
          : capabilities.tts.defaultVoice;
        if (!providerVoice) throw new Error("TTS provider has no configured voice for this turn");
        const stored = await this.options.speech.synthesize({
          roomId: room.id,
          text: spoken,
          language: utteranceLanguage,
          voice: providerVoice,
          speed: voiceProfile.speed,
          signal: speechAbort.signal,
        });
        audio = { id: stored.id, mimeType: stored.mimeType };
      }
    } catch (error) {
      console.warn("Voice TTS unavailable; clients may use their disclosed browser voice:", error instanceof Error ? error.message : error);
    } finally {
      if (this.speechAbortByRoom.get(room.id) === speechAbort) this.speechAbortByRoom.delete(room.id);
    }
    if (!this.isCurrent(room.id, epoch, persona.id)) return;

    const appended = this.options.runtime.appendFinalTranscript(room.id, persona.id, spoken, {
      utteranceOrigin: "ai-tts",
      ...(utteranceLanguage ? { language: utteranceLanguage } : {}),
    });
    if (!appended.ok) return;
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
