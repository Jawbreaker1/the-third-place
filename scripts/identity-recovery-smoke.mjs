import { io } from "socket.io-client";

const baseUrl = new URL(process.env.APP_URL ?? "http://127.0.0.1:4000");
const origin = baseUrl.origin;
const name = `return-${process.pid}-${Date.now().toString(36)}`.slice(0, 24);

const cookieFrom = (response) => response.headers.get("set-cookie")?.split(";", 1)[0];
const json = async (response) => await response.json().catch(() => ({}));
const request = async (path, { cookie, body, method = "POST" } = {}) => {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Accept: "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { response, payload: await json(response) };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let cleanupCookie;
let raceCleanupCookie;
let socket;
try {
  const created = await request("/api/session", { body: { name } });
  const firstCookie = cookieFrom(created.response);
  const recoveryKey = created.payload.recoveryKey;
  const humanId = created.payload.me?.id;
  assert(created.response.status === 201, `create failed (${created.response.status})`);
  assert(created.response.headers.get("cache-control")?.includes("no-store"), "create response could cache the one-time return key");
  assert(firstCookie, "create omitted the HttpOnly session cookie");
  assert(typeof recoveryKey === "string" && recoveryKey.startsWith("ttp_"), "create omitted the one-time return key");
  assert(typeof humanId === "string", "create omitted the stable human id");
  cleanupCookie = firstCookie;

  socket = io(origin, {
    transports: ["websocket"],
    extraHeaders: { Cookie: firstCookie, Origin: origin },
    reconnection: false,
  });
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket snapshot timed out")), 8_000);
    socket.once("room:snapshot", (value) => { clearTimeout(timer); resolve(value); });
    socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
  });
  assert(snapshot.me?.id === humanId, "socket did not bind the created stable identity");

  const duplicate = await request("/api/session", { body: { name } });
  assert(duplicate.response.status === 409, "saved name was silently duplicated");
  assert(duplicate.payload.code === "RETURNING_IDENTITY", "saved name did not advertise the return flow");

  const wrong = await request("/api/session/recover", {
    body: { name, recoveryKey: `ttp_${"A".repeat(32)}` },
  });
  assert(wrong.response.status === 401 && wrong.payload.code === "RECOVERY_INVALID", "wrong return key did not fail closed");

  const online = await request("/api/session/recover", { body: { name, recoveryKey } });
  assert(online.response.status === 409 && online.payload.code === "IDENTITY_ONLINE", "online transfer did not require confirmation");

  const replacedNotice = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("old socket did not receive replacement notice")), 8_000);
    socket.once("session:moderated", (payload) => { clearTimeout(timer); resolve(payload); });
  });
  const moved = await request("/api/session/recover", { body: { name, recoveryKey, takeOver: true } });
  const secondCookie = cookieFrom(moved.response);
  assert(moved.response.status === 201, `confirmed transfer failed (${moved.response.status})`);
  assert(secondCookie, "confirmed transfer omitted the replacement cookie");
  assert(moved.payload.me?.id === humanId, "confirmed transfer changed the stable human id");
  assert((await replacedNotice).action === "recover", "old socket received the wrong replacement event");
  cleanupCookie = secondCookie;

  const oldSession = await request("/api/session", { method: "GET", cookie: firstCookie });
  const newSession = await request("/api/session", { method: "GET", cookie: secondCookie });
  assert(oldSession.response.status === 401, "old browser token survived a confirmed transfer");
  assert(newSession.response.status === 200 && newSession.payload.me?.id === humanId, "replacement token lost the identity");

  const reissued = await request("/api/session/recovery-key", { cookie: secondCookie, body: {} });
  const nextRecoveryKey = reissued.payload.recoveryKey;
  assert(reissued.response.status === 201 && typeof nextRecoveryKey === "string", "authenticated key rotation failed");
  const retiredKey = await request("/api/session/recover", { body: { name, recoveryKey } });
  assert(retiredKey.response.status === 401, "rotated return key remained valid");
  const returned = await request("/api/session/recover", { body: { name, recoveryKey: nextRecoveryKey } });
  const thirdCookie = cookieFrom(returned.response);
  assert(returned.response.status === 201 && thirdCookie, "new return key could not restore the identity");
  assert(returned.payload.me?.id === humanId, "key rotation changed the stable human id");
  cleanupCookie = thirdCookie;

  // Race a stale authenticated browser against a portable recovery. Exactly
  // one credential mutation may win; the loser must fail instead of rotating
  // a key for, or deleting, the already-moved identity.
  const raceName = `race-${process.pid}-${Date.now().toString(36)}`.slice(0, 24);
  const raceCreated = await request("/api/session", { body: { name: raceName } });
  const raceOldCookie = cookieFrom(raceCreated.response);
  const raceOldKey = raceCreated.payload.recoveryKey;
  const raceHumanId = raceCreated.payload.me?.id;
  assert(raceCreated.response.status === 201 && raceOldCookie && raceOldKey && raceHumanId, "race identity creation failed");
  raceCleanupCookie = raceOldCookie;
  const [raceMove, raceIssue] = await Promise.all([
    request("/api/session/recover", { body: { name: raceName, recoveryKey: raceOldKey, takeOver: true } }),
    request("/api/session/recovery-key", { cookie: raceOldCookie, body: {} }),
  ]);
  const raceWinners = [raceMove, raceIssue].filter((result) => result.response.status === 201);
  assert(raceWinners.length === 1, "concurrent identity mutations did not produce one serial winner");
  if (raceMove.response.status === 201) {
    raceCleanupCookie = cookieFrom(raceMove.response);
    assert(raceMove.payload.me?.id === raceHumanId && raceCleanupCookie, "recovery race changed the actor");
  } else {
    const raceNextKey = raceIssue.payload.recoveryKey;
    assert(typeof raceNextKey === "string", "key-rotation race won without returning its key");
    const raceReturned = await request("/api/session/recover", { body: { name: raceName, recoveryKey: raceNextKey } });
    raceCleanupCookie = cookieFrom(raceReturned.response);
    assert(raceReturned.response.status === 201 && raceReturned.payload.me?.id === raceHumanId && raceCleanupCookie, "serialized race winner could not restore the actor");
  }

  console.log("Identity recovery smoke passed: stable actor, explicit takeover, token rotation, key rotation and concurrent mutation serialization.");
} finally {
  socket?.disconnect();
  if (raceCleanupCookie) {
    await request("/api/session", { method: "DELETE", cookie: raceCleanupCookie }).catch(() => undefined);
  }
  if (cleanupCookie) {
    await request("/api/session", { method: "DELETE", cookie: cleanupCookie }).catch(() => undefined);
  }
}
