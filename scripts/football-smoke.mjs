import { io } from "socket.io-client";
import { retireSmokeSession } from "./smoke-session.mjs";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-6);
const timeoutFromEnv = Number.parseInt(process.env.FOOTBALL_SMOKE_TIMEOUT_MS ?? "240000", 10);
const replyTimeoutMs = Number.isSafeInteger(timeoutFromEnv)
  ? Math.max(30_000, Math.min(300_000, timeoutFromEnv))
  : 240_000;
const text = process.env.FOOTBALL_SMOKE_TEXT ??
  "Kan du kolla fotbolls-VM 2026 och säga det senaste rapporterade resultatet och vilka matcher som kommer härnäst?";
const INTERNAL_PUBLICATION_MARKER =
  /(?:⟦(?:HUMANIZER_\d+_\d+|[^⟦⟧\r\n]{1,96}_TECH_(?:\d+|n))⟧|\[S\d+\])/iu;

const waitForEvent = (socket, event, predicate = () => true, timeoutMs = replyTimeoutMs) =>
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

const isFootballSource = (source) => {
  try {
    const url = new URL(source?.url);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname === "/upbound-web/worldcup-live.json/blob/master/2026/worldcup.json";
  } catch {
    return false;
  }
};

const response = await fetch(`${baseUrl}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `Football-${marker}`, adultConfirmed: true }),
});
const body = await response.json();
if (!response.ok) throw new Error(`Session failed: ${body.error ?? response.status}`);
const cookie = response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Session endpoint did not return a cookie");

const socket = io(baseUrl, {
  forceNew: true,
  transports: ["websocket"],
  extraHeaders: { Cookie: cookie },
});

try {
  await Promise.race([
    waitForEvent(socket, "room:snapshot", () => true, 10_000),
    new Promise((_, reject) => socket.once("connect_error", reject)),
  ]);
  const opened = await emitAck(socket, "dm:open", { peerId: "ai-mira" });
  const pendingReply = waitForEvent(
    socket,
    "dm:update",
    (payload) => payload.message?.authorId === "ai-mira" &&
      payload.message?.generation === "lm" &&
      Array.isArray(payload.message?.sources) &&
      payload.message.sources.some(isFootballSource),
  );
  await emitAck(socket, "message:send", { channelId: opened.thread.id, content: text });
  const update = await pendingReply;
  const reply = update.message;
  if (!reply?.content || INTERNAL_PUBLICATION_MARKER.test(reply.content)) {
    throw new Error("Football reply was empty or exposed an internal source marker");
  }
  const source = reply.sources.find(isFootballSource);
  if (!source?.title?.includes("FIFA World Cup 2026")) {
    throw new Error(`Football source title was unexpected: ${source?.title ?? "missing"}`);
  }
  console.log(JSON.stringify({
    ok: true,
    medium: "dm",
    request: text,
    reply: reply.content,
    source,
  }, null, 2));
} finally {
  socket.disconnect();
  await retireSmokeSession(baseUrl, cookie);
}
