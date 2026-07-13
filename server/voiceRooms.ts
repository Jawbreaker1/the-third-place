import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  VoiceActionFailure,
  VoiceBotState,
  VoiceCapabilities,
  VoiceCreateResult,
  VoiceInviteBotResult,
  VoiceJoinResult,
  VoiceLeaveResult,
  VoiceParticipantView,
  VoiceRoomView,
  VoiceSignalForward,
  VoiceSignalPayload,
  VoiceTranscriptEntry,
} from "../shared/types.js";

const MAX_HUMANS = 6;
const MAX_BOTS = 2;
const MAX_TRANSCRIPT_ENTRIES = 60;
const MAX_TRANSCRIPT_CHARACTERS = 12_000;
const MAX_TRANSCRIPT_AGE_MS = 30 * 60_000;
const MAX_UTTERANCE_CHARACTERS = 2_000;

const sessionDescriptionSchema = z
  .object({
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(65_536),
  })
  .strict();

const iceCandidateSchema = z
  .object({
    candidate: z.string().max(2_048).optional(),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(256).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

const iceSignalSchema = z
  .object({
    type: z.literal("ice"),
    candidate: iceCandidateSchema.nullable(),
  })
  .strict();

export const voiceSignalPayloadSchema = z
  .object({
    roomId: z.string().uuid(),
    toMemberId: z.string().min(1).max(100),
    revision: z.number().int().min(1),
    signal: z.union([sessionDescriptionSchema, iceSignalSchema]),
  })
  .strict();

export interface VoiceHumanIdentity {
  socketId: string;
  memberId: string;
  name: string;
}

export interface VoiceBotIdentity {
  personaId: string;
  name: string;
}

export interface VoiceRoomRuntimeOptions {
  now?: () => number;
  idFactory?: () => string;
  capabilities?: Partial<Pick<VoiceCapabilities, "transcription" | "speechToText" | "textToSpeech" | "iceServers">>;
}

export type VoiceSignalRouteResult =
  | { ok: true; targetSocketId: string; forward: VoiceSignalForward }
  | VoiceActionFailure;

export type VoiceTranscriptAppendResult =
  | { ok: true; entry: VoiceTranscriptEntry }
  | VoiceActionFailure;

interface InternalParticipant {
  view: VoiceParticipantView;
  socketId?: string;
  joinOrder: number;
}

interface InternalRoom {
  id: string;
  channelId: string;
  createdByMemberId: string;
  hostMemberId: string;
  createdAt: string;
  revision: number;
  participants: Map<string, InternalParticipant>;
  transcript: VoiceTranscriptEntry[];
  nextTranscriptSequence: number;
  nextJoinOrder: number;
}

const failure = (code: VoiceActionFailure["code"], error: string): VoiceActionFailure => ({ ok: false, code, error });

const cleanName = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);

const cleanTranscript = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_UTTERANCE_CHARACTERS);

const cloneCapabilities = (capabilities: VoiceCapabilities): VoiceCapabilities => ({
  ...capabilities,
  iceServers: capabilities.iceServers.map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  })),
});

export class VoiceRoomRuntime {
  private readonly channelIds: Set<string>;
  private readonly rooms = new Map<string, InternalRoom>();
  private readonly roomIdByChannel = new Map<string, string>();
  private readonly roomIdBySocket = new Map<string, string>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly runtimeCapabilities: VoiceCapabilities;

  constructor(channelIds: readonly string[], options: VoiceRoomRuntimeOptions = {}) {
    this.channelIds = new Set(channelIds);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.runtimeCapabilities = {
      transport: "webrtc-p2p",
      maxHumans: MAX_HUMANS,
      maxBots: MAX_BOTS,
      transcription: options.capabilities?.transcription ?? false,
      speechToText: options.capabilities?.speechToText ?? false,
      textToSpeech: options.capabilities?.textToSpeech ?? false,
      iceServers: options.capabilities?.iceServers?.map((server) => ({
        ...server,
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      })) ?? [],
    };
  }

  capabilities(): VoiceCapabilities {
    return cloneCapabilities(this.runtimeCapabilities);
  }

  listRooms(): VoiceRoomView[] {
    return [...this.rooms.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((room) => this.view(room));
  }

  getRoom(roomId: string): VoiceRoomView | undefined {
    const room = this.rooms.get(roomId);
    return room ? this.view(room) : undefined;
  }

  getRoomForSocket(socketId: string): VoiceRoomView | undefined {
    const roomId = this.roomIdBySocket.get(socketId);
    return roomId ? this.getRoom(roomId) : undefined;
  }

  getRoomForMember(memberId: string): VoiceRoomView | undefined {
    const room = [...this.rooms.values()].find((candidate) => candidate.participants.has(memberId));
    return room ? this.view(room) : undefined;
  }

  isMemberInRoom(roomId: string, memberId: string): boolean {
    return this.rooms.get(roomId)?.participants.has(memberId) ?? false;
  }

  getSocketIdForMember(roomId: string, memberId: string): string | undefined {
    return this.rooms.get(roomId)?.participants.get(memberId)?.socketId;
  }

  createRoom(channelId: string, human: VoiceHumanIdentity): VoiceCreateResult {
    if (!this.channelIds.has(channelId)) return failure("CHANNEL_NOT_FOUND", "That public channel does not exist.");
    if (this.roomIdBySocket.has(human.socketId)) {
      return failure("ALREADY_IN_ROOM", "Leave the current voice room before creating another one.");
    }
    if (this.roomIdByChannel.has(channelId)) return failure("ROOM_EXISTS", "That channel already has a voice room.");

    const now = this.now();
    const id = this.idFactory();
    const name = cleanName(human.name);
    if (!name || !human.memberId || !human.socketId) return failure("NOT_AUTHORIZED", "A valid human session is required.");
    const host: InternalParticipant = {
      socketId: human.socketId,
      joinOrder: 0,
      view: {
        memberId: human.memberId,
        name,
        kind: "human",
        role: "host",
        joinedAt: new Date(now).toISOString(),
        muted: false,
        deafened: false,
        speaking: false,
      },
    };
    const room: InternalRoom = {
      id,
      channelId,
      createdByMemberId: human.memberId,
      hostMemberId: human.memberId,
      createdAt: new Date(now).toISOString(),
      revision: 1,
      participants: new Map([[human.memberId, host]]),
      transcript: [],
      nextTranscriptSequence: 1,
      nextJoinOrder: 1,
    };
    this.rooms.set(id, room);
    this.roomIdByChannel.set(channelId, id);
    this.roomIdBySocket.set(human.socketId, id);
    return { ok: true, room: this.view(room), capabilities: this.capabilities() };
  }

  joinRoom(roomId: string, human: VoiceHumanIdentity): VoiceJoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    if (this.roomIdBySocket.has(human.socketId)) {
      return failure("ALREADY_IN_ROOM", "This browser connection is already in a voice room.");
    }
    if (room.participants.has(human.memberId)) {
      return failure("ALREADY_JOINED", "That member is already in this voice room.");
    }
    if (this.humanParticipants(room).length >= MAX_HUMANS) return failure("ROOM_FULL", "That voice room is full.");
    const name = cleanName(human.name);
    if (!name || !human.memberId || !human.socketId) return failure("NOT_AUTHORIZED", "A valid human session is required.");

    room.participants.set(human.memberId, {
      socketId: human.socketId,
      joinOrder: room.nextJoinOrder++,
      view: {
        memberId: human.memberId,
        name,
        kind: "human",
        role: "guest",
        joinedAt: new Date(this.now()).toISOString(),
        muted: false,
        deafened: false,
        speaking: false,
      },
    });
    this.roomIdBySocket.set(human.socketId, room.id);
    room.revision += 1;
    return { ok: true, room: this.view(room), capabilities: this.capabilities() };
  }

  rebindHumanSocket(roomId: string, memberId: string, newSocketId: string): VoiceJoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    if (!newSocketId) return failure("NOT_AUTHORIZED", "A valid browser connection is required.");
    const mappedRoomId = this.roomIdBySocket.get(newSocketId);
    if (mappedRoomId) return failure("ALREADY_IN_ROOM", "This browser connection is already in a voice room.");
    const participant = room.participants.get(memberId);
    if (!participant || participant.view.kind !== "human" || !participant.socketId) {
      return failure("NOT_AUTHORIZED", "That human member cannot resume this voice room.");
    }

    this.roomIdBySocket.delete(participant.socketId);
    participant.socketId = newSocketId;
    this.roomIdBySocket.set(newSocketId, room.id);
    // A transport rebind changes neither membership nor topology. Keeping the
    // revision stable lets the resumed peer finish its existing negotiation.
    return { ok: true, room: this.view(room), capabilities: this.capabilities() };
  }

  leaveRoom(socketId: string): VoiceLeaveResult {
    const roomId = this.roomIdBySocket.get(socketId);
    if (!roomId) return failure("NOT_IN_ROOM", "This browser connection is not in a voice room.");
    const room = this.rooms.get(roomId);
    if (!room) {
      this.roomIdBySocket.delete(socketId);
      return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    }
    const departing = [...room.participants.values()].find((participant) => participant.socketId === socketId);
    if (!departing || departing.view.kind !== "human") return failure("NOT_IN_ROOM", "That participant is not in this room.");

    room.participants.delete(departing.view.memberId);
    this.roomIdBySocket.delete(socketId);
    room.revision += 1;
    const humans = this.humanParticipants(room);
    if (humans.length === 0) {
      const closedRevision = room.revision;
      this.rooms.delete(room.id);
      this.roomIdByChannel.delete(room.channelId);
      return { ok: true, closed: true, roomId: room.id, revision: closedRevision };
    }

    if (room.hostMemberId === departing.view.memberId) {
      const nextHost = [...humans].sort(
        (a, b) => a.joinOrder - b.joinOrder || a.view.memberId.localeCompare(b.view.memberId),
      )[0]!;
      room.hostMemberId = nextHost.view.memberId;
      for (const participant of humans) {
        participant.view.role = participant.view.memberId === room.hostMemberId ? "host" : "guest";
      }
    }
    return { ok: true, closed: false, room: this.view(room) };
  }

  inviteBot(roomId: string, requesterSocketId: string, bot: VoiceBotIdentity): VoiceInviteBotResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    if (!this.isHumanSocketInRoom(room, requesterSocketId)) {
      return failure("NOT_AUTHORIZED", "Join the voice room before inviting an AI resident.");
    }
    if (room.participants.has(bot.personaId)) {
      return failure("BOT_ALREADY_INVITED", "That AI resident is already in the voice room.");
    }
    if (this.botParticipants(room).length >= MAX_BOTS) return failure("BOT_LIMIT", "A voice room can have at most two AI residents.");
    const name = cleanName(bot.name);
    if (!name || !bot.personaId.startsWith("ai-")) return failure("NOT_AUTHORIZED", "That AI resident is not available.");

    room.participants.set(bot.personaId, {
      joinOrder: room.nextJoinOrder++,
      view: {
        memberId: bot.personaId,
        name,
        kind: "ai",
        role: "ai",
        joinedAt: new Date(this.now()).toISOString(),
        muted: false,
        deafened: false,
        speaking: false,
        botState: "invited",
      },
    });
    room.revision += 1;
    return { ok: true, room: this.view(room) };
  }

  removeBot(roomId: string, requesterSocketId: string, personaId: string): VoiceInviteBotResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    if (!this.isHumanSocketInRoom(room, requesterSocketId)) {
      return failure("NOT_AUTHORIZED", "Join the voice room before removing an AI resident.");
    }
    const participant = room.participants.get(personaId);
    if (!participant || participant.view.kind !== "ai") {
      return failure("TARGET_NOT_FOUND", "That AI resident is not in the room.");
    }
    room.participants.delete(personaId);
    room.revision += 1;
    return { ok: true, room: this.view(room) };
  }

  setHumanState(
    roomId: string,
    socketId: string,
    state: { muted?: boolean; deafened?: boolean; speaking?: boolean },
  ): VoiceInviteBotResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    const participant = [...room.participants.values()].find((candidate) => candidate.socketId === socketId);
    if (!participant || participant.view.kind !== "human") {
      return failure("NOT_AUTHORIZED", "Join the voice room before changing voice state.");
    }
    let changed = false;
    for (const key of ["muted", "deafened", "speaking"] as const) {
      const value = state[key];
      if (value !== undefined && participant.view[key] !== value) {
        participant.view[key] = value;
        changed = true;
      }
    }
    if (changed) room.revision += 1;
    return { ok: true, room: this.view(room) };
  }

  setBotState(roomId: string, personaId: string, state: VoiceBotState): VoiceInviteBotResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    const participant = room.participants.get(personaId);
    if (!participant || participant.view.kind !== "ai") return failure("TARGET_NOT_FOUND", "That AI resident is not in the room.");
    if (participant.view.botState !== state) {
      participant.view.botState = state;
      participant.view.speaking = state === "speaking";
      room.revision += 1;
    }
    return { ok: true, room: this.view(room) };
  }

  routeSignal(fromSocketId: string, rawPayload: unknown): VoiceSignalRouteResult {
    const parsed = voiceSignalPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return failure("INVALID_SIGNAL", "That WebRTC signal was invalid.");
    const payload = parsed.data as VoiceSignalPayload;
    const mappedRoomId = this.roomIdBySocket.get(fromSocketId);
    if (!mappedRoomId || mappedRoomId !== payload.roomId) {
      return failure("NOT_AUTHORIZED", "Join that voice room before signaling a peer.");
    }
    const room = this.rooms.get(payload.roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    // Older ICE candidates remain valid while both human endpoints are still
    // members. State changes such as mute or bot activity must not break an
    // in-flight human peer connection. A future revision is never legitimate.
    if (payload.revision > room.revision) return failure("STALE_REVISION", "Refresh the voice room before renegotiating.");
    const sender = [...room.participants.values()].find((participant) => participant.socketId === fromSocketId);
    const target = room.participants.get(payload.toMemberId);
    if (!sender || sender.view.kind !== "human") return failure("NOT_AUTHORIZED", "Only a human peer may signal from this connection.");
    if (!target?.socketId || target.view.kind !== "human" || target.socketId === fromSocketId) {
      return failure("TARGET_NOT_FOUND", "That human peer is not available in this room.");
    }
    const forward: VoiceSignalForward = {
      roomId: room.id,
      fromMemberId: sender.view.memberId,
      toMemberId: target.view.memberId,
      revision: room.revision,
      signal: payload.signal,
    };
    return { ok: true, targetSocketId: target.socketId, forward };
  }

  appendFinalTranscript(
    roomId: string,
    speakerId: string,
    text: string,
    timing: { startedAt?: number; endedAt?: number } = {},
  ): VoiceTranscriptAppendResult {
    const room = this.rooms.get(roomId);
    if (!room) return failure("ROOM_NOT_FOUND", "That voice room no longer exists.");
    const speaker = room.participants.get(speakerId);
    if (!speaker) return failure("NOT_AUTHORIZED", "That speaker is not in the voice room.");
    const cleaned = cleanTranscript(text);
    if (!cleaned) return failure("INVALID_TRANSCRIPT", "The final transcript was empty.");
    const now = this.now();
    const endedAt = timing.endedAt ?? now;
    const startedAt = timing.startedAt ?? endedAt;
    if (startedAt > endedAt || endedAt > now + 5_000 || endedAt - startedAt > 5 * 60_000) {
      return failure("INVALID_TRANSCRIPT", "The final transcript timing was invalid.");
    }

    this.trimTranscript(room, now);
    const heardByPersonaIds = this.botParticipants(room)
      .filter(
        (participant) =>
          participant.view.memberId !== speakerId &&
          ["listening", "thinking", "speaking"].includes(participant.view.botState ?? ""),
      )
      .map((participant) => participant.view.memberId)
      .sort();
    const isHuman = speaker.view.kind === "human";
    const entry: VoiceTranscriptEntry = {
      id: randomUUID(),
      roomId: room.id,
      sequence: room.nextTranscriptSequence++,
      speakerId: speaker.view.memberId,
      speakerName: speaker.view.name,
      speakerKind: speaker.view.kind,
      text: cleaned,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      final: true,
      heardByPersonaIds,
      trigger: isHuman
        ? { eligible: true, source: "human-final" }
        : { eligible: false, source: "ai-final" },
    };
    room.transcript.push(entry);
    this.trimTranscript(room, now);
    return { ok: true, entry: this.cloneTranscriptEntry(entry) };
  }

  getTranscript(roomId: string): VoiceTranscriptEntry[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    this.trimTranscript(room, this.now());
    return room.transcript.map((entry) => this.cloneTranscriptEntry(entry));
  }

  private trimTranscript(room: InternalRoom, now: number): void {
    const cutoff = now - MAX_TRANSCRIPT_AGE_MS;
    room.transcript = room.transcript.filter((entry) => new Date(entry.endedAt).getTime() >= cutoff);
    while (room.transcript.length > MAX_TRANSCRIPT_ENTRIES) room.transcript.shift();
    let characters = room.transcript.reduce((total, entry) => total + entry.text.length, 0);
    while (characters > MAX_TRANSCRIPT_CHARACTERS && room.transcript.length > 0) {
      const removed = room.transcript.shift();
      characters -= removed?.text.length ?? 0;
    }
  }

  private humanParticipants(room: InternalRoom): InternalParticipant[] {
    return [...room.participants.values()].filter((participant) => participant.view.kind === "human");
  }

  private botParticipants(room: InternalRoom): InternalParticipant[] {
    return [...room.participants.values()].filter((participant) => participant.view.kind === "ai");
  }

  private isHumanSocketInRoom(room: InternalRoom, socketId: string): boolean {
    return [...room.participants.values()].some(
      (participant) => participant.view.kind === "human" && participant.socketId === socketId,
    );
  }

  private view(room: InternalRoom): VoiceRoomView {
    return {
      id: room.id,
      channelId: room.channelId,
      createdByMemberId: room.createdByMemberId,
      hostMemberId: room.hostMemberId,
      createdAt: room.createdAt,
      revision: room.revision,
      participants: [...room.participants.values()]
        .sort((a, b) => a.joinOrder - b.joinOrder || a.view.memberId.localeCompare(b.view.memberId))
        .map((participant) => ({ ...participant.view })),
    };
  }

  private cloneTranscriptEntry(entry: VoiceTranscriptEntry): VoiceTranscriptEntry {
    return {
      ...entry,
      heardByPersonaIds: [...entry.heardByPersonaIds],
      trigger: { ...entry.trigger },
    };
  }
}
