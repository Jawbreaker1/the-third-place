import type { ChatMessage } from "../shared/types.js";
import { CHANNELS, getChannelProfile } from "./channels.js";
import { PERSONAS, type Persona } from "./personas.js";
import {
  buildRoomExpertiseMatrix,
  expertisePromptNote,
  EXPERTISE_RANK,
  type ActorRoomExpertise,
  type RoomExpertiseMatrix,
} from "./roomExpertise.js";

interface ActorChannelState {
  personaId: string;
  subscribedChannels: string[];
  focusChannelId: string;
  attentionByChannel: Record<string, number>;
  unreadByChannel: Record<string, number>;
  lastReadMessageByChannel: Record<string, string | undefined>;
  lastReadAtByChannel: Record<string, number | undefined>;
  lastSpokeAtByChannel: Record<string, number | undefined>;
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

const expertiseAffinityBonus = [0.02, 0.08, 0.14, 0.2, 0.26] as const;
const SUBSCRIPTION_AFFINITY_THRESHOLD = 0.4;

const deriveAffinity = (persona: Persona, channelId: string, expertise: ActorRoomExpertise): number => {
  const explicit = persona.channelAffinity?.[channelId];
  if (explicit !== undefined) return explicit;
  if (persona.id === "ai-runa") return 0.82;
  if (channelId === "lobby") return 0.55 + persona.warmth * 0.16 + persona.mischief * 0.08;
  const tags = new Set(getChannelProfile(channelId)?.topic.tags.map((topic) => topic.toLocaleLowerCase()) ?? []);
  const matches = persona.interests.filter((interest) => tags.has(interest.toLocaleLowerCase())).length;
  return clamp(
    0.18 + matches * 0.11 + persona.curiosity * 0.08 + expertiseAffinityBonus[EXPERTISE_RANK[expertise.level]],
  );
};

export class ActorChannelRuntime {
  private readonly states = new Map<string, ActorChannelState>();
  private readonly expertiseMatrix: RoomExpertiseMatrix;

  constructor(private readonly personas = PERSONAS) {
    this.expertiseMatrix = buildRoomExpertiseMatrix(personas);
    for (const persona of this.personas) {
      const affinities = Object.fromEntries(
        CHANNELS.map((channel) => [
          channel.id,
          deriveAffinity(persona, channel.id, this.expertise(persona.id, channel.id)),
        ]),
      );
      const focusChannelId = [...CHANNELS].sort(
        (a, b) => (affinities[b.id] ?? 0) - (affinities[a.id] ?? 0),
      )[0]?.id ?? "lobby";
      this.states.set(persona.id, {
        personaId: persona.id,
        subscribedChannels: CHANNELS.filter(
          (channel) => (affinities[channel.id] ?? 0) >= SUBSCRIPTION_AFFINITY_THRESHOLD,
        ).map(
          (channel) => channel.id,
        ),
        focusChannelId,
        attentionByChannel: affinities,
        unreadByChannel: Object.fromEntries(CHANNELS.map((channel) => [channel.id, 0])),
        lastReadMessageByChannel: Object.fromEntries(CHANNELS.map((channel) => [channel.id, undefined])),
        lastReadAtByChannel: Object.fromEntries(CHANNELS.map((channel) => [channel.id, undefined])),
        lastSpokeAtByChannel: Object.fromEntries(CHANNELS.map((channel) => [channel.id, undefined])),
      });
    }
  }

  restore(messages: ChatMessage[]): void {
    const recentPerChannel = CHANNELS.flatMap((channel) =>
      messages.filter((message) => message.channelId === channel.id).slice(-300),
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const message of recentPerChannel) {
      this.noteChannelEvent(message);
      if (!message.authorId.startsWith("ai-")) continue;
      const state = this.states.get(message.authorId);
      if (!state) continue;
      if (state.subscribedChannels.includes(message.channelId)) {
        this.markSpoke(message.authorId, message.channelId, message.id);
      } else {
        // Keep historical metadata without resurrecting an obsolete focus in a
        // room this actor no longer subscribes to after a roster change.
        state.lastSpokeAtByChannel[message.channelId] = Date.now();
        state.lastReadMessageByChannel[message.channelId] = message.id;
        state.lastReadAtByChannel[message.channelId] = Date.now();
        state.unreadByChannel[message.channelId] = 0;
      }
    }
  }

  noteChannelEvent(message: ChatMessage): void {
    for (const state of this.states.values()) {
      if (!state.subscribedChannels.includes(message.channelId) || state.personaId === message.authorId) continue;
      if (state.focusChannelId === message.channelId && (state.attentionByChannel[message.channelId] ?? 0) > 0.66) {
        state.lastReadMessageByChannel[message.channelId] = message.id;
        state.lastReadAtByChannel[message.channelId] = Date.now();
        continue;
      }
      state.unreadByChannel[message.channelId] = Math.min(99, (state.unreadByChannel[message.channelId] ?? 0) + 1);
      state.attentionByChannel[message.channelId] = clamp((state.attentionByChannel[message.channelId] ?? 0.2) + 0.025);
    }
  }

  markRead(personaId: string, channelId: string, messageId?: string): void {
    const state = this.states.get(personaId);
    if (!state) return;
    state.unreadByChannel[channelId] = 0;
    state.lastReadMessageByChannel[channelId] = messageId;
    state.lastReadAtByChannel[channelId] = Date.now();
    state.attentionByChannel[channelId] = clamp((state.attentionByChannel[channelId] ?? 0.2) + 0.16);
  }

  markSpoke(personaId: string, channelId: string, messageId?: string): void {
    const state = this.states.get(personaId);
    if (!state) return;
    state.focusChannelId = channelId;
    state.lastSpokeAtByChannel[channelId] = Date.now();
    this.markRead(personaId, channelId, messageId);
    for (const channel of CHANNELS) {
      if (channel.id === channelId) continue;
      state.attentionByChannel[channel.id] = clamp((state.attentionByChannel[channel.id] ?? 0.2) - 0.035, 0.12, 1);
    }
  }

  candidatesFor(channelId: string, mentionedIds: string[] = []): Persona[] {
    return this.personas.filter((persona) => {
      if (mentionedIds.includes(persona.id)) return true;
      const state = this.states.get(persona.id);
      return Boolean(state?.subscribedChannels.includes(channelId) && (state.attentionByChannel[channelId] ?? 0) >= 0.24);
    });
  }

  affinity(personaId: string, channelId: string): number {
    return this.states.get(personaId)?.attentionByChannel[channelId] ?? 0.2;
  }

  expertise(personaId: string, channelId: string): ActorRoomExpertise {
    return this.expertiseMatrix.get(channelId)?.get(personaId) ?? {
      level: "basic",
      specialties: [],
      blindSpots: [],
    };
  }

  promptNotes(personas: Persona[], currentChannelId?: string): Record<string, string> {
    return Object.fromEntries(
      personas.map((persona) => {
        const state = this.states.get(persona.id);
        if (!state) {
          return [
            persona.id,
            currentChannelId ? `You are reading #${currentChannelId}.` : "You are replying in a private conversation.",
          ];
        }
        const unread = CHANNELS.filter((channel) => (state.unreadByChannel[channel.id] ?? 0) > 0)
          .map((channel) => `${state.unreadByChannel[channel.id]} unread in #${channel.name}`)
          .join(", ");
        return [
          persona.id,
          currentChannelId
            ? `You are currently focused on #${state.focusChannelId} and are now reading #${currentChannelId}. ${unread || "No known unread channel backlog."} You only know the supplied transcript and messages you have actually read; never pretend to know unread content.`
            : `You are replying in a private conversation while your public-room focus remains #${state.focusChannelId}. ${unread || "No known unread channel backlog."} You only know the supplied transcript and messages you have actually read; never pretend to know unread content.`,
        ];
      }),
    );
  }

  expertiseNotes(personas: Persona[], channelId: string): Record<string, string> {
    const profile = getChannelProfile(channelId);
    if (!profile) return {};
    return Object.fromEntries(
      personas.map((persona) => [persona.id, expertisePromptNote(profile, this.expertise(persona.id, channelId))]),
    );
  }

  activityLabel(persona: Persona): string {
    const state = this.states.get(persona.id);
    if (!state) return persona.activity ?? "around";
    const channel = CHANNELS.find((candidate) => candidate.id === state.focusChannelId)?.name ?? state.focusChannelId;
    return `#${channel} · ${persona.activity ?? "listening"}`;
  }

  snapshot(personaId: string): Readonly<ActorChannelState> | undefined {
    return this.states.get(personaId);
  }
}
