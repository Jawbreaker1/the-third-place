import type { VoiceRoomView, VoiceTranscriptEntry, VoiceUtteranceOrigin } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { CHANNELS } from "./channels.js";
import type { HumanMemory } from "./humanMemory.js";
import type { LmStudioClient, TranscriptLine } from "./lmStudio.js";
import { PERSONAS, type Persona } from "./personas.js";
import { voiceProfileForPersona } from "./personaVoices.js";
import type { VoiceRoomRuntime } from "./voiceRooms.js";
import type { VoiceSpeechService } from "./voiceSpeech.js";

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
  lm: Pick<LmStudioClient, "generateScene"> & Partial<Pick<LmStudioClient, "rememberDeliveredLine">>;
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

const languageHint = (content: string): string => {
  const lower = ` ${content.toLocaleLowerCase()} `;
  return /[åäö]/i.test(content) || [" jag ", " och ", " inte ", " vad ", " hur ", " är "].some((word) => lower.includes(word))
    ? "Swedish"
    : "the language of the latest human utterance";
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const mentionsPersona = (content: string, name: string): boolean =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(content);

const sanitizeSpokenLine = (value: string): string => {
  const cleaned = value
    .normalize("NFKC")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\[[^\]]{0,100}\]|\([^)]*(?:laughs?|sighs?|pauses?|music|sound)[^)]*\)/giu, " ")
    .replace(/[*_~`#>|]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 25);
  return words.join(" ").slice(0, 240).trim();
};

export type VoiceGroundingIssue = "written-medium" | "unsupported-acoustics";

const WRITTEN_MEDIUM_ILLUSION = [
  /\b(?:på|i)\s+(?:text(?:en|et)?|chat(?:ten)?|meddelande(?:t)?|the\s+(?:text|chat|message))\b/iu,
  /\b(?:läser|läste|read(?:ing)?)\b.{0,50}\b(?:vad|det|what|that)\b.{0,30}\b(?:du|ni|you)\b.{0,20}\b(?:skriver|skrev|skrivit|write|wrote|typed?)\b/iu,
  /\b(?:du|ni|you)\b.{0,50}\b(?:skriver|skrev|skrivit|typed?|wrote|texted|posted|sent (?:a )?(?:text|message))\b/iu,
  /\b(?:ditt|ert|your)\s+(?:skrivna\s+)?(?:meddelande|message|text|post)\b/iu,
];

const SAFE_ACOUSTIC_LIMITATION = [
  /^(?!.*\b(?:men|but|however|dock)\b).{0,45}\b(?:kan\s+inte|går\s+inte|gar\s+inte|can't|cannot)\b.{0,55}\b(?:avgöra|determine|tell|höra|hora|hear)\b.{0,90}(?:transkrib\p{L}*|\borden\b|\bwords\b).{0,25}[.!?]?$/iu,
  /^(?!.*\b(?:men|but|however|dock)\b).{0,45}(?:transkrib\p{L}*|\borden\b|\bwords\b).{0,80}\b(?:kan\s+inte|går\s+inte|gar\s+inte|can't|cannot)\b.{0,45}\b(?:avgöra|determine|tell|höra|hora|hear)\b.{0,25}[.!?]?$/iu,
];
const UNSUPPORTED_ACOUSTIC_ASSERTION = [
  /\b(?:du|ni|you)\b.{0,45}\b(?:skriker|skrek|ropar|ropade|viskar|viskade|hörs|hors|høres|shout(?:ing|ed)?|yell(?:ing|ed)?|scream(?:ing|ed)?|whisper(?:ing|ed)?|loud|quiet)\b/iu,
  /\b(?:det|that)\s+(?:låter|later|sounds?)\b.{0,65}\b(?:du|ni|you)\b.{0,30}\b(?:skriker|ropar|viskar|shout(?:ing)?|yell(?:ing)?|scream(?:ing)?|whisper(?:ing)?|arg|angry|upprörd|upprord|nervös|nervos|nervous)\b/iu,
  /\b(?:hör|hor|heard|hear)\b.{0,35}\b(?:att|that)\b.{0,20}\b(?:du|ni|you)\b.{0,25}\b(?:skriker|ropar|viskar|shout(?:ing)?|yell(?:ing)?|scream(?:ing)?|whisper(?:ing)?)\b/iu,
  /\b(?:din\s+röst|din\s+rost|stemmen\s+din|your\s+voice)\b.{0,35}\b(?:låter|later|høres|sounds?)?\b.{0,20}\b(?:arg|angry|frustrerad|frustrert|frustrated|upprörd|upprord|nervös|nervos|nervous|ledsen|sad|glad|happy|trött|trott|tired)\b/iu,
  /\b(?:hör|hor|hører|heard|hear)\b.{0,35}\b(?:frustration(?:en)?|anger|ilska(?:n)?|nervositet|nervousness|sorg|sadness)\b.{0,35}\b(?:röst|rost|stemme|voice)?\b/iu,
];

/** Rejects medium-confusion and acoustic claims that cannot be grounded in STT words. */
export const detectVoiceGroundingIssue = (
  value: string,
  origin: VoiceUtteranceOrigin,
): VoiceGroundingIssue | undefined => {
  const normalized = value.normalize("NFKC");
  if (origin === "microphone-stt" && WRITTEN_MEDIUM_ILLUSION.some((pattern) => pattern.test(normalized))) {
    return "written-medium";
  }
  const unsupportedAcousticClaim = UNSUPPORTED_ACOUSTIC_ASSERTION.some((pattern) => pattern.test(normalized));
  const isSafeLimitationOnly = SAFE_ACOUSTIC_LIMITATION.some((pattern) => pattern.test(normalized));
  if (origin !== "ai-tts" && unsupportedAcousticClaim && !isSafeLimitationOnly) {
    return "unsupported-acoustics";
  }
  return undefined;
};

const asksAboutAcoustics = (value: string): boolean =>
  /\b(?:skriker|skrek|ropar|viskar|shout(?:ing)?|yell(?:ing)?|scream(?:ing)?|whisper(?:ing)?|högt|hogt|loud|tyst|quiet|volym|volume|ton(?:fall)?|tone|accent|röst|rost|voice)\b/iu.test(value);

const fallbackLine = (persona: Persona, humanName: string): string => {
  if (persona.id === "ai-bosse") return `Okej ${humanName}, den där behöver du nästan utveckla innan jag gör det värre.`;
  if (persona.mischief > 0.7) return `Jag hör dig, ${humanName}. Min första invändning är redan på väg.`;
  if (persona.warmth > 0.8) return `Mm, jag hör dig ${humanName}. Säg lite mer om den sista delen.`;
  return `Jag hör dig. Den sista delen är nog den intressanta — utveckla den.`;
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

  private selectPersona(entry: VoiceTranscriptEntry): Persona | undefined {
    const room = this.options.runtime.getRoom(entry.roomId);
    if (!room) return undefined;
    const eligibleIds = new Set(entry.heardByPersonaIds);
    const invited = room.participants
      .filter((participant) => participant.kind === "ai" && eligibleIds.has(participant.memberId))
      .map((participant) => PERSONAS.find((persona) => persona.id === participant.memberId))
      .filter((persona): persona is Persona => Boolean(persona));
    if (invited.length === 0) return undefined;
    const mentioned = invited.find((persona) => mentionsPersona(entry.text, persona.name));
    if (mentioned) return mentioned;
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
    const persona = this.selectPersona(entry);
    if (!persona) return;
    const room = this.options.runtime.getRoom(entry.roomId);
    if (!room) return;
    this.setBotState(room.id, persona.id, "thinking");

    // Capture only the memory that predates this turn. Voice transcripts never
    // enter long-term memory; a completed exchange merely strengthens rapport.
    const relationshipNote = this.options.humanMemory?.promptNote(entry.speakerId, persona.id);
    const previousRelation = this.options.humanMemory?.getRelation(entry.speakerId, persona.id);

    let spoken = "";
    const generationAbort = new AbortController();
    this.generationAbortByRoom.set(room.id, generationAbort);
    try {
      const generated = await this.options.lm.generateScene(
        {
          kind: "voice",
          channelId: room.channelId,
          channelName: CHANNELS.find((channel) => channel.id === room.channelId)?.name ?? room.channelId,
          selected: [persona],
          history: transcriptFor(this.options.runtime.getTranscript(room.id), persona.id),
          trigger: { author: entry.speakerName, content: entry.text, messageId: entry.id },
          mustReplyIds: [persona.id],
          languageHint: languageHint(entry.text),
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
          premise: `${persona.name} has joined an active multi-participant voice call. Answer the newest complete human utterance once, conversationally. The reply will be spoken aloud; do not narrate actions or produce another speaker.`,
        },
        0,
        generationAbort.signal,
      );
      spoken = sanitizeSpokenLine(generated.find((line) => line.personaId === persona.id)?.content ?? "");
    } catch (error) {
      if (!generationAbort.signal.aborted) {
        console.warn("Voice scene used fallback:", error instanceof Error ? error.message : error);
      }
    } finally {
      if (this.generationAbortByRoom.get(room.id) === generationAbort) this.generationAbortByRoom.delete(room.id);
    }
    const groundingIssue = spoken ? detectVoiceGroundingIssue(spoken, entry.utteranceOrigin) : undefined;
    if (groundingIssue) {
      spoken = asksAboutAcoustics(entry.text) || groundingIssue === "unsupported-acoustics"
        ? "Jag får orden via transkriberingen, inte en pålitlig volymnivå, så det kan jag faktiskt inte avgöra."
        : fallbackLine(persona, entry.speakerName);
    }
    if (!spoken) spoken = sanitizeSpokenLine(fallbackLine(persona, entry.speakerName));
    if (!spoken || !this.isCurrent(room.id, epoch, persona.id)) return;

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
      if (capabilities.tts.available && voiceProfile) {
        const stored = await this.options.speech.synthesize({
          roomId: room.id,
          text: spoken,
          voice: voiceProfile.providerVoice,
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

    const appended = this.options.runtime.appendFinalTranscript(room.id, persona.id, spoken, { utteranceOrigin: "ai-tts" });
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
      ...(voiceProfile ? {
        language: voiceProfile.language,
        browserRate: voiceProfile.browserRate,
        browserPitch: voiceProfile.browserPitch,
      } : {}),
      ...(audio ? { audioUrl: `/api/voice/audio/${encodeURIComponent(audio.id)}?roomId=${encodeURIComponent(room.id)}`, mimeType: audio.mimeType } : {}),
    });

    const estimatedSpeakingMs = Math.max(1_200, Math.min(12_000, 550 + spoken.split(/\s+/).length * 310));
    const timer = setTimeout(() => {
      if (this.isCurrent(room.id, epoch, persona.id)) this.setBotState(room.id, persona.id, "listening");
    }, estimatedSpeakingMs);
    timer.unref();
  }
}

export { sanitizeSpokenLine };
