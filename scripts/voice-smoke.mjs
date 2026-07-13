import assert from "node:assert/strict";
import { io } from "socket.io-client";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-6);

const waitForEvent = (socket, event, predicate = () => true, timeoutMs = 120_000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });

const emitAck = (socket, event, payload, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No acknowledgement for ${event}`)), timeoutMs);
    socket.emit(event, payload, (result) => {
      clearTimeout(timeout);
      if (!result?.ok) reject(new Error(result?.error ?? `${event} failed`));
      else resolve(result);
    });
  });

const createSession = async (name) => {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Could not create ${name}: ${body.error ?? response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Session endpoint did not return a cookie");
  return cookie;
};

const connect = async (cookie) => {
  const socket = io(baseUrl, {
    forceNew: true,
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie },
  });
  const failure = new Promise((_, reject) => socket.once("connect_error", reject));
  const snapshot = await Promise.race([waitForEvent(socket, "room:snapshot", () => true, 10_000), failure]);
  return { socket, snapshot };
};

const sockets = [];
let roomId;
try {
  const [cookieA, cookieB] = await Promise.all([
    createSession(`Voice-A-${marker}`),
    createSession(`Voice-B-${marker}`),
  ]);
  const [a, b] = await Promise.all([connect(cookieA), connect(cookieB)]);
  sockets.push(a.socket, b.socket);

  const created = await emitAck(a.socket, "voice:room:create", { channelId: "lobby" });
  roomId = created.room.id;
  assert.equal(created.room.hostMemberId, a.snapshot.me.id);
  assert.equal(created.room.participants.length, 1);
  assert.equal(created.room.participants[0]?.memberId, a.snapshot.me.id);

  const joined = await emitAck(b.socket, "voice:room:join", { roomId });
  assert.equal(joined.room.participants.filter((participant) => participant.kind === "human").length, 2);

  const signal = {
    roomId,
    toMemberId: b.snapshot.me.id,
    revision: joined.room.revision,
    signal: {
      type: "offer",
      sdp: `v=0\r\no=voice-smoke-${marker} 1 1 IN IP4 127.0.0.1\r\ns=The Third Place voice smoke\r\nt=0 0\r\n`,
    },
  };
  const forwardedPromise = waitForEvent(
    b.socket,
    "voice:signal",
    (payload) => payload.roomId === roomId && payload.fromMemberId === a.snapshot.me.id,
    10_000,
  );
  await emitAck(a.socket, "voice:signal", signal);
  const forwarded = await forwardedPromise;
  assert.deepEqual(forwarded, {
    roomId,
    fromMemberId: a.snapshot.me.id,
    toMemberId: b.snapshot.me.id,
    revision: joined.room.revision,
    signal: signal.signal,
  });

  const invited = await emitAck(a.socket, "voice:bot:invite", { roomId, personaId: "ai-sana" });
  assert.ok(invited.room.participants.some((participant) => participant.memberId === "ai-sana" && participant.kind === "ai"));

  const typedTurn = `Sana, ge oss ett mycket kort voice-svar om banandrivna servrar. ${marker}`;
  const humanTranscriptPromise = waitForEvent(
    b.socket,
    "voice:transcript:final",
    (entry) => entry.roomId === roomId && entry.speakerId === a.snapshot.me.id && entry.text === typedTurn,
    15_000,
  );
  const aiTranscriptPromise = waitForEvent(
    b.socket,
    "voice:transcript:final",
    (entry) => entry.roomId === roomId && entry.speakerId === "ai-sana" && entry.speakerKind === "ai",
    120_000,
  );
  const aiSpeechPromise = waitForEvent(
    b.socket,
    "voice:ai-speech",
    (payload) => payload.roomId === roomId && payload.memberId === "ai-sana" && typeof payload.text === "string" && payload.text.length > 0,
    120_000,
  );

  await emitAck(a.socket, "voice:text-turn", { roomId, text: typedTurn });
  const [humanTranscript, aiTranscript, aiSpeech] = await Promise.all([
    humanTranscriptPromise,
    aiTranscriptPromise,
    aiSpeechPromise,
  ]);
  assert.equal(humanTranscript.trigger.eligible, true);
  assert.ok(humanTranscript.heardByPersonaIds.includes("ai-sana"));
  assert.equal(aiTranscript.trigger.eligible, false);
  assert.equal(aiTranscript.text, aiSpeech.text);
  let ttsAudioUrl;
  if (process.env.EXPECT_TTS === "true") {
    assert.equal(typeof aiSpeech.audioUrl, "string", "TTS smoke expected a room-scoped server audio URL");
    ttsAudioUrl = new URL(aiSpeech.audioUrl, baseUrl);
    const anonymousAudioResponse = await fetch(ttsAudioUrl);
    assert.equal(anonymousAudioResponse.status, 401, "anonymous clients must not fetch room audio");
    const audioResponse = await fetch(ttsAudioUrl, { headers: { Cookie: cookieB } });
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get("content-type"), "audio/wav");
    assert.equal(audioResponse.headers.get("cache-control"), "private, no-store");
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(audio.subarray(8, 12).toString("ascii"), "WAVE");
  }

  const bLeft = await emitAck(b.socket, "voice:room:leave", { roomId });
  assert.equal(bLeft.closed, false);
  assert.ok(!bLeft.room.participants.some((participant) => participant.memberId === b.snapshot.me.id));
  if (ttsAudioUrl) {
    const leftMemberAudioResponse = await fetch(ttsAudioUrl, { headers: { Cookie: cookieB } });
    assert.equal(leftMemberAudioResponse.status, 403, "a member who left must lose room-audio access");
  }

  const roomGonePromise = waitForEvent(
    b.socket,
    "voice:rooms:update",
    (rooms) => Array.isArray(rooms) && !rooms.some((room) => room.id === roomId),
    10_000,
  );
  const aLeft = await emitAck(a.socket, "voice:room:leave", { roomId });
  assert.equal(aLeft.closed, true);
  assert.equal(aLeft.roomId, roomId);
  await roomGonePromise;
  roomId = undefined;

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  console.log(JSON.stringify({
    ok: true,
    humans: [a.snapshot.me.name, b.snapshot.me.name],
    strictSignalForward: true,
    invitedBot: "ai-sana",
    humanTranscript: humanTranscript.text,
    aiTranscript: aiTranscript.text,
    aiSpeech: {
      text: aiSpeech.text,
      serverAudio: Boolean(aiSpeech.audioUrl),
      mimeType: aiSpeech.mimeType,
    },
    modelConnected: Boolean(health.model?.connected),
    roomClosed: true,
  }, null, 2));
} finally {
  if (roomId) {
    for (const socket of sockets) socket.emit("voice:room:leave", { roomId });
  }
  for (const socket of sockets) socket.disconnect();
}
