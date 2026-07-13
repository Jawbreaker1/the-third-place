import type { VoiceRoomView, VoiceTranscriptEntry } from "../shared/types.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { CHANNELS } from "./channels.js";
import type { HumanMemory } from "./humanMemory.js";
import type { LmStudioClient, TranscriptLine } from "./lmStudio.js";
import { PERSONAS, type Persona } from "./personas.js";
import type { VoiceRoomRuntime } from "./voiceRooms.js";
import type { VoiceSpeechService } from "./voiceSpeech.js";

export interface VoiceAiSpeechPayload {
  roomId: string;
  memberId: string;
  text: string;
  utteranceId: string;
  audioUrl?: string;
  mimeType?: string;
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
    }));

export class VoiceDirector {
  private readonly epochByRoom = new Map<string, number>();
  private readonly lastSpokeAtByPersona = new Map<string, number>();
  private readonly speechAbortByRoom = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: VoiceDirectorOptions) {
    this.now = options.now ?? Date.now;
  }

  onHumanFinal(entry: VoiceTranscriptEntry): void {
    if (entry.speakerKind !== "human" || !entry.final || !entry.trigger.eligible || entry.trigger.source !== "human-final") return;
    const epoch = this.invalidateRoom(entry.roomId);
    for (const participant of this.options.runtime.getRoom(entry.roomId)?.participants ?? []) {
      if (participant.kind === "ai" && (participant.botState === "thinking" || participant.botState === "speaking")) {
        this.setBotState(entry.roomId, participant.memberId, "listening");
      }
    }
    void this.respond(entry, epoch);
  }

  invalidateRoom(roomId: string): number {
    this.speechAbortByRoom.get(roomId)?.abort(new Error("Voice turn superseded"));
    this.speechAbortByRoom.delete(roomId);
    const epoch = (this.epochByRoom.get(roomId) ?? 0) + 1;
    this.epochByRoom.set(roomId, epoch);
    this.options.events.aiStop({ roomId });
    return epoch;
  }

  forgetRoom(roomId: string): void {
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
          ...(relationshipNote ? { relationshipNotes: { [persona.id]: relationshipNote } } : {}),
          premise: `${persona.name} is in a live human-started voice room. Answer the newest human once, conversationally. Do not narrate actions or produce another speaker.`,
        },
        0,
      );
      spoken = sanitizeSpokenLine(generated.find((line) => line.personaId === persona.id)?.content ?? "");
    } catch (error) {
      console.warn("Voice scene used fallback:", error instanceof Error ? error.message : error);
    }
    if (!spoken) spoken = sanitizeSpokenLine(fallbackLine(persona, entry.speakerName));
    if (!spoken || !this.isCurrent(room.id, epoch, persona.id)) return;

    let audio: { id: string; mimeType: string } | undefined;
    const speechAbort = new AbortController();
    this.speechAbortByRoom.set(room.id, speechAbort);
    try {
      const capabilities = await this.options.speech.capabilities();
      if (capabilities.tts.available) {
        const stored = await this.options.speech.synthesize({ roomId: room.id, text: spoken, signal: speechAbort.signal });
        audio = { id: stored.id, mimeType: stored.mimeType };
      }
    } catch (error) {
      console.warn("Voice TTS unavailable; clients may use their disclosed browser voice:", error instanceof Error ? error.message : error);
    } finally {
      if (this.speechAbortByRoom.get(room.id) === speechAbort) this.speechAbortByRoom.delete(room.id);
    }
    if (!this.isCurrent(room.id, epoch, persona.id)) return;

    const appended = this.options.runtime.appendFinalTranscript(room.id, persona.id, spoken);
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
