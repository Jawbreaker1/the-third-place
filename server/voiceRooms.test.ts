import { describe, expect, it } from "vitest";
import { VoiceRoomRuntime, voiceSignalPayloadSchema, type VoiceHumanIdentity } from "./voiceRooms.js";

const human = (number: number): VoiceHumanIdentity => ({
  socketId: `socket-${number}`,
  memberId: `human-${number}`,
  name: `Human ${number}`,
});

const runtimeFactory = (now: () => number = () => Date.UTC(2026, 6, 13, 12)) => {
  let nextId = 1;
  return new VoiceRoomRuntime(["lobby", "ai-lab"], {
    now,
    idFactory: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    capabilities: {
      transcription: true,
      speechToText: true,
      textToSpeech: true,
      iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
    },
  });
};

describe("voice room runtime", () => {
  it("allows one human-created room per public channel and one room per socket", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.room.revision).toBe(1);
    expect(created.room.hostMemberId).toBe("human-1");
    expect(created.room.participants).toMatchObject([{ memberId: "human-1", role: "host", kind: "human" }]);
    expect(created.capabilities).toMatchObject({ transport: "webrtc-p2p", maxHumans: 6, maxBots: 2 });
    expect(runtime.createRoom("ai-lab", human(1))).toMatchObject({ ok: false, code: "ALREADY_IN_ROOM" });
    expect(runtime.createRoom("lobby", human(2))).toMatchObject({ ok: false, code: "ROOM_EXISTS" });
    expect(runtime.createRoom("missing", human(3))).toMatchObject({ ok: false, code: "CHANNEL_NOT_FOUND" });
  });

  it("caps a small P2P room at six human peers", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);
    for (let index = 2; index <= 6; index += 1) {
      expect(runtime.joinRoom(created.room.id, human(index)).ok).toBe(true);
    }

    expect(runtime.getRoom(created.room.id)?.participants.filter((participant) => participant.kind === "human")).toHaveLength(6);
    expect(runtime.joinRoom(created.room.id, human(7))).toMatchObject({ ok: false, code: "ROOM_FULL" });
  });

  it("transfers host deterministically and closes when the last human leaves", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);
    const joinedTwo = runtime.joinRoom(created.room.id, human(2));
    const joinedThree = runtime.joinRoom(created.room.id, human(3));
    if (!joinedTwo.ok || !joinedThree.ok) throw new Error("join failed");

    const hostLeft = runtime.leaveRoom("socket-1");
    expect(hostLeft).toMatchObject({ ok: true, closed: false, room: { hostMemberId: "human-2", revision: 4 } });
    if (hostLeft.ok && !hostLeft.closed) {
      expect(hostLeft.room.participants.find((participant) => participant.memberId === "human-2")?.role).toBe("host");
    }
    expect(runtime.leaveRoom("socket-2")).toMatchObject({ ok: true, closed: false });
    const closed = runtime.leaveRoom("socket-3");
    expect(closed).toMatchObject({ ok: true, closed: true, roomId: created.room.id, revision: 6 });
    expect(runtime.getRoom(created.room.id)).toBeUndefined();

    expect(runtime.createRoom("lobby", human(4)).ok).toBe(true);
  });

  it("atomically rebinds a reconnecting human without closing or revising the room", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);
    const originalRevision = created.room.revision;

    const rebound = runtime.rebindHumanSocket(created.room.id, "human-1", "socket-reconnected");
    expect(rebound).toMatchObject({ ok: true, room: { id: created.room.id, revision: originalRevision } });
    expect(runtime.getRoomForSocket("socket-1")).toBeUndefined();
    expect(runtime.getRoomForSocket("socket-reconnected")?.id).toBe(created.room.id);
    expect(runtime.getSocketIdForMember(created.room.id, "human-1")).toBe("socket-reconnected");
    expect(runtime.leaveRoom("socket-1")).toMatchObject({ ok: false, code: "NOT_IN_ROOM" });
    expect(runtime.leaveRoom("socket-reconnected")).toMatchObject({ ok: true, closed: true });
  });

  it("rejects reconnect rebinds for absent members, AI residents and occupied sockets", () => {
    const runtime = runtimeFactory();
    const lobby = runtime.createRoom("lobby", human(1));
    const lab = runtime.createRoom("ai-lab", human(2));
    if (!lobby.ok || !lab.ok) throw new Error("create failed");
    expect(runtime.inviteBot(lobby.room.id, "socket-1", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);

    expect(runtime.rebindHumanSocket(lobby.room.id, "human-missing", "socket-new")).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    expect(runtime.rebindHumanSocket(lobby.room.id, "ai-sana", "socket-new")).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    expect(runtime.rebindHumanSocket(lobby.room.id, "human-1", "socket-2")).toMatchObject({
      ok: false,
      code: "ALREADY_IN_ROOM",
    });
    expect(runtime.getSocketIdForMember(lobby.room.id, "human-1")).toBe("socket-1");
  });

  it("allows room humans to invite at most two AI residents", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);

    expect(runtime.inviteBot(created.room.id, "not-in-room", { personaId: "ai-sana", name: "Sana" })).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    expect(runtime.inviteBot(created.room.id, "socket-1", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    expect(runtime.inviteBot(created.room.id, "socket-1", { personaId: "ai-pixel", name: "Pixel" }).ok).toBe(true);
    expect(runtime.inviteBot(created.room.id, "socket-1", { personaId: "ai-nox", name: "Nox" })).toMatchObject({
      ok: false,
      code: "BOT_LIMIT",
    });
    expect(runtime.inviteBot(created.room.id, "socket-1", { personaId: "ai-sana", name: "Sana" })).toMatchObject({
      ok: false,
      code: "BOT_ALREADY_INVITED",
    });
    expect(runtime.isMemberInRoom(created.room.id, "ai-sana")).toBe(true);
    expect(runtime.getRoomForMember("ai-sana")?.id).toBe(created.room.id);
    expect(runtime.getSocketIdForMember(created.room.id, "human-1")).toBe("socket-1");
    expect(runtime.getSocketIdForMember(created.room.id, "ai-sana")).toBeUndefined();
  });

  it("updates human self-state and lets a room human remove an invited bot", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);
    const invited = runtime.inviteBot(created.room.id, "socket-1", { personaId: "ai-sana", name: "Sana" });
    if (!invited.ok) throw new Error(invited.error);

    const state = runtime.setHumanState(created.room.id, "socket-1", { muted: true, deafened: true });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error(state.error);
    expect(state.room.participants.find((participant) => participant.memberId === "human-1")).toMatchObject({
      muted: true,
      deafened: true,
    });
    expect(runtime.setHumanState(created.room.id, "not-in-room", { muted: true })).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    expect(runtime.removeBot(created.room.id, "not-in-room", "ai-sana")).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    expect(runtime.removeBot(created.room.id, "socket-1", "ai-sana").ok).toBe(true);
    expect(runtime.isMemberInRoom(created.room.id, "ai-sana")).toBe(false);
  });

  it("strictly validates and unicasts signaling with a server-derived sender", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);
    const joined = runtime.joinRoom(created.room.id, human(2));
    if (!joined.ok) throw new Error(joined.error);
    const payload = {
      roomId: created.room.id,
      toMemberId: "human-2",
      revision: joined.room.revision,
      signal: { type: "offer" as const, sdp: "v=0\r\n" },
    };

    expect(runtime.routeSignal("socket-1", payload)).toEqual({
      ok: true,
      targetSocketId: "socket-2",
      forward: {
        roomId: created.room.id,
        fromMemberId: "human-1",
        toMemberId: "human-2",
        revision: joined.room.revision,
        signal: payload.signal,
      },
    });
    expect(runtime.routeSignal("not-in-room", payload)).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
    expect(runtime.setHumanState(created.room.id, "socket-2", { muted: true }).ok).toBe(true);
    expect(runtime.routeSignal("socket-1", { ...payload, revision: 1 })).toMatchObject({
      ok: true,
      forward: { revision: 3 },
    });
    expect(runtime.routeSignal("socket-1", { ...payload, revision: 4 })).toMatchObject({
      ok: false,
      code: "STALE_REVISION",
    });
    expect(runtime.routeSignal("socket-1", { ...payload, toMemberId: "human-1" })).toMatchObject({
      ok: false,
      code: "TARGET_NOT_FOUND",
    });
    expect(runtime.routeSignal("socket-1", { ...payload, fromMemberId: "human-999" })).toMatchObject({
      ok: false,
      code: "INVALID_SIGNAL",
    });
  });

  it("rejects oversized, malformed and field-smuggling peer signals", () => {
    const valid = {
      roomId: "00000000-0000-4000-8000-000000000001",
      toMemberId: "human-2",
      revision: 2,
      signal: {
        type: "ice",
        candidate: { candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      },
    };
    expect(voiceSignalPayloadSchema.safeParse(valid).success).toBe(true);
    expect(voiceSignalPayloadSchema.safeParse({ ...valid, extra: "smuggled" }).success).toBe(false);
    expect(
      voiceSignalPayloadSchema.safeParse({
        ...valid,
        signal: { ...valid.signal, candidate: { ...valid.signal.candidate, extra: "smuggled" } },
      }).success,
    ).toBe(false);
    expect(
      voiceSignalPayloadSchema.safeParse({ ...valid, signal: { type: "offer", sdp: "x".repeat(65_537) } }).success,
    ).toBe(false);
  });

  it("snapshots which listening bots heard each final utterance and never makes AI output trigger-eligible", () => {
    const runtime = runtimeFactory();
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);
    const invited = runtime.inviteBot(created.room.id, "socket-1", { personaId: "ai-sana", name: "Sana" });
    if (!invited.ok) throw new Error(invited.error);
    expect(runtime.setBotState(created.room.id, "ai-sana", "listening").ok).toBe(true);

    const humanFinal = runtime.appendFinalTranscript(created.room.id, "human-1", "  hello\u0000   Sana  ");
    expect(humanFinal).toMatchObject({
      ok: true,
      entry: {
        text: "hello Sana",
        final: true,
        heardByPersonaIds: ["ai-sana"],
        trigger: { eligible: true, source: "human-final" },
      },
    });
    const aiFinal = runtime.appendFinalTranscript(created.room.id, "ai-sana", "I heard you.");
    expect(aiFinal).toMatchObject({
      ok: true,
      entry: { speakerKind: "ai", trigger: { eligible: false, source: "ai-final" } },
    });
    expect(JSON.stringify(runtime.getTranscript(created.room.id))).not.toMatch(/audio|buffer|base64/i);
  });

  it("bounds final transcript memory by entry count, characters and age", () => {
    let now = Date.UTC(2026, 6, 13, 12);
    const runtime = runtimeFactory(() => now);
    const created = runtime.createRoom("lobby", human(1));
    if (!created.ok) throw new Error(created.error);

    for (let index = 0; index < 65; index += 1) {
      expect(runtime.appendFinalTranscript(created.room.id, "human-1", `short utterance ${index}`).ok).toBe(true);
    }
    expect(runtime.getTranscript(created.room.id)).toHaveLength(60);

    for (let index = 0; index < 7; index += 1) {
      expect(runtime.appendFinalTranscript(created.room.id, "human-1", `${index}${"x".repeat(1_999)}`).ok).toBe(true);
    }
    const characterBound = runtime.getTranscript(created.room.id);
    expect(characterBound.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(12_000);
    expect(characterBound).toHaveLength(6);

    now += 30 * 60_000 + 1;
    expect(runtime.getTranscript(created.room.id)).toEqual([]);
  });
});
