import { io } from "socket.io-client";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-5);

const waitForEvent = (socket, event, predicate, timeoutMs = 180_000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for sourced ${event}`));
    }, timeoutMs);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });

const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.emit(event, payload, (result) => (result?.ok ? resolve(result) : reject(new Error(result?.error ?? `${event} failed`))));
  });

const response = await fetch(`${baseUrl}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `Research-${marker}` }),
});
if (!response.ok) throw new Error(`Could not create research session: ${response.status}`);
const cookie = response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Session endpoint did not return a cookie");

const socket = io(baseUrl, { forceNew: true, transports: ["websocket"], extraHeaders: { Cookie: cookie } });
try {
  const snapshot = await waitForEvent(socket, "room:snapshot", () => true, 10_000);
  const text = `@Mira, vilka är de senaste AI-nyheterna idag? Svara med ett konkret fynd och en relevant källa. [${marker}]`;
  const humanMessagePromise = waitForEvent(
    socket,
    "message:new",
    (message) => message.authorId === snapshot.me.id && message.content === text,
    10_000,
  );
  await emitAck(socket, "message:send", { channelId: "ai-lab", content: text });
  const humanMessage = await humanMessagePromise;
  const reply = await waitForEvent(
    socket,
    "message:new",
    (message) =>
      message.replyToId === humanMessage.id &&
      message.authorId === "ai-mira" &&
      message.generation === "lm" &&
      Array.isArray(message.sources) &&
      message.sources.length > 0,
  );
  console.log(JSON.stringify({ ok: true, reply: reply.content, sources: reply.sources }, null, 2));
} finally {
  socket.disconnect();
}
