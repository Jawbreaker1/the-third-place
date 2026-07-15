import { io } from "socket.io-client";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-6);
const INTERNAL_PUBLICATION_MARKER =
  /(?:⟦(?:HUMANIZER_\d+_\d+|[^⟦⟧\r\n]{1,96}_TECH_(?:\d+|n))⟧|\[S\d+\])/iu;

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

const sessionResponse = await fetch(`${baseUrl}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `Weather-${marker}` }),
});
const session = await sessionResponse.json();
if (!sessionResponse.ok) throw new Error(session.error ?? `Session failed: ${sessionResponse.status}`);
const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
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
  const text = "Kan du kolla vädret i Göteborg? Kommer det bli kallare snart?";
  const pendingReply = waitForEvent(
    socket,
    "dm:update",
    (payload) => payload.message?.authorId === "ai-mira" &&
      payload.message?.replyToId &&
      payload.message?.generation === "lm",
  );
  await emitAck(socket, "message:send", { channelId: opened.thread.id, content: text });
  const update = await pendingReply;
  const reply = update.message;
  if (!reply.content || INTERNAL_PUBLICATION_MARKER.test(reply.content)) {
    throw new Error("Weather reply was empty or exposed an internal source marker");
  }
  const weatherSource = reply.sources?.find((source) => {
    try {
      const url = new URL(source.url);
      return url.protocol === "https:" && url.hostname === "api.open-meteo.com" && url.pathname === "/v1/forecast";
    } catch {
      return false;
    }
  });
  if (!weatherSource) throw new Error("Weather reply did not carry the server-bound Open-Meteo source");

  console.log(JSON.stringify({
    ok: true,
    request: text,
    reply: reply.content,
    source: weatherSource,
  }, null, 2));
} finally {
  socket.disconnect();
}
