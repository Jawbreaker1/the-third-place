import { io } from "socket.io-client";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-5);

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

const emitAck = (socket, event, payload, timeoutMs = 8_000) =>
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
try {
  const [cookieA, cookieB] = await Promise.all([
    createSession(`Ada-${marker}`),
    createSession(`Bo-${marker}`),
  ]);
  const [a, b] = await Promise.all([connect(cookieA), connect(cookieB)]);
  sockets.push(a.socket, b.socket);

  const text = `@Nox tänk om bananen driver hela servern?! [${marker}]`;
  const humanSeen = waitForEvent(
    b.socket,
    "message:new",
    (message) => message.authorId === a.snapshot.me.id && message.content === text,
    10_000,
  );
  await emitAck(a.socket, "message:send", { channelId: "lobby", content: text });
  const humanMessage = await humanSeen;

  const reactionSeen = waitForEvent(
    a.socket,
    "reaction:update",
    (payload) => payload.messageId === humanMessage.id && payload.reaction.memberIds.includes(b.snapshot.me.id),
    10_000,
  );
  await emitAck(b.socket, "reaction:toggle", {
    channelId: "lobby",
    messageId: humanMessage.id,
    emoji: "👀",
  });
  await reactionSeen;

  const aiReply = await waitForEvent(
    b.socket,
    "message:new",
    (message) => message.replyToId === humanMessage.id && message.authorId === "ai-nox" && message.generation === "lm",
    120_000,
  );

  const openDm = await emitAck(a.socket, "dm:open", { peerId: "ai-mira" });
  const dmText = `Privat smoke-test ${marker}: ge mig en superkort hälsning.`;
  const dmReply = waitForEvent(
    a.socket,
    "dm:update",
    (payload) => payload.message?.authorId === "ai-mira" && payload.message?.replyToId && payload.message?.generation === "lm",
    120_000,
  );
  await emitAck(a.socket, "message:send", { channelId: openDm.thread.id, content: dmText });
  const dmUpdate = await dmReply;

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  if (!health.model.connected) throw new Error("App completed the flow but reports LM Studio offline");

  console.log(
    JSON.stringify(
      {
        ok: true,
        humans: [a.snapshot.me.name, b.snapshot.me.name],
        publicBroadcast: humanMessage.id,
        publicAiReply: { authorId: aiReply.authorId, content: aiReply.content },
        reactionBroadcast: true,
        dmAiReply: { authorId: dmUpdate.message.authorId, content: dmUpdate.message.content },
        model: health.model,
      },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.disconnect();
}
