import { io } from "socket.io-client";

const baseUrl = new URL(process.env.APP_BASE_URL ?? process.env.APP_URL ?? "http://127.0.0.1:4000");
const origin = baseUrl.origin;
const inviteCode = process.env.SMOKE_INVITE_CODE || undefined;
const suffix = `${process.pid}${Date.now().toString(36)}`.slice(-12);
const guestName = `guest-${suffix}`.slice(0, 24);
const senderName = `sender-${suffix}`.slice(0, 24);
const loginHandle = `account_${suffix}`;
const password = `Local-${suffix}-password`;

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
const socketSnapshot = async (cookie) => {
  const socket = io(origin, {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: origin },
    reconnection: false,
  });
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket snapshot timed out")), 8_000);
    socket.once("room:snapshot", (value) => { clearTimeout(timer); resolve(value); });
    socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
  });
  return { socket, snapshot };
};
const emitAck = (socket, event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 8_000);
  socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
});
const login = () => request("/api/auth/login", {
  body: { loginHandle, password, adultConfirmed: true, ...(inviteCode ? { inviteCode } : {}) },
});

let accountCookie;
let senderCookie;
let cleanupGuestCookie;
const sockets = new Set();
try {
  const malformedHttp = await request("/api/session", {
    method: "GET",
    cookie: "atrium_session=%",
  });
  assert(malformedHttp.response.status === 401, "malformed HTTP cookie was not rejected safely");
  const malformedSocket = io(origin, {
    transports: ["websocket"],
    extraHeaders: { Cookie: "atrium_session=%", Origin: origin },
    reconnection: false,
    forceNew: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("malformed websocket cookie did not resolve")), 8_000);
    malformedSocket.once("connect", () => {
      clearTimeout(timer);
      reject(new Error("malformed websocket cookie was authenticated"));
    });
    malformedSocket.once("connect_error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  malformedSocket.disconnect();
  const healthAfterMalformedCookies = await request("/api/health", { method: "GET" });
  assert(healthAfterMalformedCookies.response.status === 200, "server crashed after malformed cookie handshakes");

  const guest = await request("/api/session", {
    body: { name: guestName, adultConfirmed: true, ...(inviteCode ? { inviteCode } : {}) },
  });
  const guestCookie = cookieFrom(guest.response);
  cleanupGuestCookie = guestCookie;
  const actorId = guest.payload.me?.id;
  assert(guest.response.status === 201 && guestCookie && actorId, "guest creation failed");
  assert(guest.payload.identity?.kind === "guest", "guest identity kind was omitted");
  const guestConnection = await socketSnapshot(guestCookie);
  sockets.add(guestConnection.socket);
  assert(guestConnection.snapshot.identity?.kind === "guest", "guest socket snapshot lost identity kind");

  const guestSocketRevoked = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("guest socket survived account upgrade")), 8_000);
    guestConnection.socket.once("session:upgraded", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const upgraded = await request("/api/auth/upgrade", {
    cookie: guestCookie,
    body: { loginHandle, password },
  });
  accountCookie = cookieFrom(upgraded.response);
  assert(upgraded.response.status === 201 && accountCookie, `guest upgrade failed (${upgraded.response.status})`);
  cleanupGuestCookie = undefined;
  assert(upgraded.payload.me?.id === actorId, "guest upgrade changed the social actor id");
  assert(upgraded.payload.identity?.kind === "registered", "upgrade did not return a registered identity");
  await guestSocketRevoked;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(!guestConnection.socket.connected, "pre-upgrade guest socket remained connected with account authority");
  sockets.delete(guestConnection.socket);
  const retiredGuestToken = await request("/api/session", { method: "GET", cookie: guestCookie });
  assert(retiredGuestToken.response.status === 401, "old guest token survived account upgrade");

  const loggedOut = await request("/api/session", { method: "DELETE", cookie: accountCookie });
  assert(loggedOut.response.status === 204, "registered logout failed");
  accountCookie = undefined;

  const firstLogin = await login();
  const secondLogin = await login();
  const firstDeviceCookie = cookieFrom(firstLogin.response);
  const secondDeviceCookie = cookieFrom(secondLogin.response);
  assert(firstLogin.response.status === 201 && firstDeviceCookie, "first account device login failed");
  assert(secondLogin.response.status === 201 && secondDeviceCookie, "second account device login failed");
  assert(firstLogin.payload.me?.id === actorId && secondLogin.payload.me?.id === actorId, "device login changed the actor id");
  await request("/api/session", { method: "DELETE", cookie: firstDeviceCookie });
  const survivingDevice = await request("/api/session", { method: "GET", cookie: secondDeviceCookie });
  assert(survivingDevice.response.status === 200, "logging out one device revoked another device");
  await request("/api/session", { method: "DELETE", cookie: secondDeviceCookie });

  const sender = await request("/api/session", {
    body: { name: senderName, adultConfirmed: true, ...(inviteCode ? { inviteCode } : {}) },
  });
  senderCookie = cookieFrom(sender.response);
  assert(sender.response.status === 201 && senderCookie, "offline-DM sender creation failed");
  const senderConnection = await socketSnapshot(senderCookie);
  sockets.add(senderConnection.socket);
  const offlineAccount = senderConnection.snapshot.members?.find((member) => member.id === actorId);
  assert(offlineAccount?.status === "offline", "registered account was not visible as an offline member");
  const opened = await emitAck(senderConnection.socket, "dm:open", { peerId: actorId });
  assert(opened?.ok && opened.thread?.id, "offline registered member could not receive a DM");
  const sent = await emitAck(senderConnection.socket, "message:send", {
    channelId: opened.thread.id,
    content: "Offline delivery integration check",
  });
  assert(sent?.ok, "offline DM could not be sent");

  const unreadLoginOne = await login();
  const unreadLoginTwo = await login();
  const unreadCookieOne = cookieFrom(unreadLoginOne.response);
  const unreadCookieTwo = cookieFrom(unreadLoginTwo.response);
  assert(unreadCookieOne && unreadCookieTwo, "account could not return for its offline DM");
  const readerOne = await socketSnapshot(unreadCookieOne);
  const readerTwo = await socketSnapshot(unreadCookieTwo);
  sockets.add(readerOne.socket);
  sockets.add(readerTwo.socket);
  const unreadThread = readerOne.snapshot.dmThreads?.find((thread) => thread.id === opened.thread.id);
  assert(unreadThread?.unread === 1, `offline DM unread was ${unreadThread?.unread ?? "missing"}, expected 1`);
  const crossDeviceRead = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second device did not receive DM read state")), 8_000);
    readerTwo.socket.once("dm:read:update", (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
  const read = await emitAck(readerOne.socket, "dm:read", {
    threadId: unreadThread.id,
    messageId: unreadThread.messages.at(-1)?.id,
  });
  assert(read?.ok, "DM read acknowledgement failed");
  assert((await crossDeviceRead)?.thread?.unread === 0, "DM read state did not synchronize to the second device");
  readerOne.socket.disconnect();
  readerTwo.socket.disconnect();
  sockets.delete(readerOne.socket);
  sockets.delete(readerTwo.socket);
  await request("/api/session", { method: "DELETE", cookie: unreadCookieOne });
  await request("/api/session", { method: "DELETE", cookie: unreadCookieTwo });

  const readLogin = await login();
  accountCookie = cookieFrom(readLogin.response);
  assert(accountCookie, "account could not reopen after reading its DM");
  const finalReader = await socketSnapshot(accountCookie);
  sockets.add(finalReader.socket);
  const readThread = finalReader.snapshot.dmThreads?.find((thread) => thread.id === opened.thread.id);
  assert(readThread?.unread === 0, "DM read cursor did not survive a new account session");

  const removedNotice = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("guest erasure did not remove the private thread")), 8_000);
    finalReader.socket.once("dm:removed", (payload) => { clearTimeout(timer); resolve(payload); });
  });
  const retiredSenderCookie = senderCookie;
  const retiredSender = await request("/api/session", { method: "DELETE", cookie: retiredSenderCookie });
  senderCookie = undefined;
  assert(retiredSender.response.status === 204, "explicit guest logout failed");
  assert((await removedNotice)?.threadId === opened.thread.id, "guest logout left its private DM behind");
  const erasedGuest = await request("/api/session", { method: "GET", cookie: retiredSenderCookie });
  assert(erasedGuest.response.status === 401, "explicit guest logout left its session usable");

  const oldestDeviceEvicted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("oldest connected account device survived the session cap")), 20_000);
    finalReader.socket.once("session:ended", (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
  const oldestDeviceCookie = accountCookie;
  const cappedDeviceCookies = [];
  const cappedDeviceSockets = [];
  for (let index = 0; index < 12; index += 1) {
    const deviceLogin = await login();
    const deviceCookie = cookieFrom(deviceLogin.response);
    assert(deviceLogin.response.status === 201 && deviceCookie, `capped device ${index + 1} could not log in`);
    accountCookie = deviceCookie;
    const deviceConnection = await socketSnapshot(deviceCookie);
    cappedDeviceCookies.push(deviceCookie);
    cappedDeviceSockets.push(deviceConnection.socket);
    sockets.add(deviceConnection.socket);
  }
  assert((await oldestDeviceEvicted)?.reason === "device-limit", "oldest device did not receive the session-cap reason");
  assert(!finalReader.socket.connected, "oldest connected device retained live account authority");
  const evictedDeviceHttp = await request("/api/session", { method: "GET", cookie: oldestDeviceCookie });
  assert(evictedDeviceHttp.response.status === 401, "evicted device cookie retained HTTP account authority");
  sockets.delete(finalReader.socket);
  accountCookie = cappedDeviceCookies.at(-1);
  for (const deviceSocket of cappedDeviceSockets) {
    deviceSocket.disconnect();
    sockets.delete(deviceSocket);
  }
  const deleted = await request("/api/account", {
    method: "DELETE",
    cookie: accountCookie,
    body: { password },
  });
  accountCookie = undefined;
  assert(deleted.response.status === 204, `account cleanup failed (${deleted.response.status})`);
  const removedLogin = await login();
  assert(removedLogin.response.status === 401, "deleted account could still log in");

  console.log("Local identity smoke passed: malformed-cookie safety, hard guest upgrade, bounded devices, stable actor, offline DM, cross-device read state and explicit erasure.");
} finally {
  for (const socket of sockets) socket.disconnect();
  if (cleanupGuestCookie) {
    await request("/api/session", { method: "DELETE", cookie: cleanupGuestCookie }).catch(() => undefined);
  }
  if (senderCookie) {
    await request("/api/session", { method: "DELETE", cookie: senderCookie }).catch(() => undefined);
  }
  if (accountCookie) {
    await request("/api/account", {
      method: "DELETE",
      cookie: accountCookie,
      body: { password },
    }).catch(() => undefined);
  }
}
