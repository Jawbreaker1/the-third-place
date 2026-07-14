import { io } from "socket.io-client";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-5);

const waitForEvent = (socket, event, predicate, timeoutMs = 30_000) =>
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

const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.emit(event, payload, (result) =>
      result?.ok ? resolve(result) : reject(new Error(result?.error ?? `${event} failed`)),
    );
  });

const sessionResponse = await fetch(`${baseUrl}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `History-${marker}` }),
});
if (!sessionResponse.ok) throw new Error(`Could not create history session: ${sessionResponse.status}`);
const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Session endpoint did not return a cookie");

const socket = io(baseUrl, { forceNew: true, transports: ["websocket"], extraHeaders: { Cookie: cookie } });
try {
  const snapshot = await waitForEvent(socket, "room:snapshot", () => true, 10_000);
  for (const channel of snapshot.channels) {
    const count = snapshot.messages.filter((message) => message.channelId === channel.id).length;
    if (count > 40) throw new Error(`Snapshot sent ${count} messages for ${channel.id}`);
  }
  const lobbyPageInfo = snapshot.historyPageInfo?.lobby;
  if (!lobbyPageInfo?.hasMore || !lobbyPageInfo.before) throw new Error("Seeded lobby did not expose an older-page cursor");
  const historyResponse = await fetch(
    `${baseUrl}/api/channels/lobby/messages?before=${encodeURIComponent(lobbyPageInfo.before)}&limit=40`,
    { headers: { Cookie: cookie } },
  );
  const historyBody = await historyResponse.json();
  if (!historyResponse.ok || !historyBody.ok || historyBody.page.messages.length === 0) {
    throw new Error(historyBody.error ?? "Older history page was empty");
  }
  const initialIds = new Set(snapshot.messages.map((message) => message.id));
  if (historyBody.page.messages.some((message) => initialIds.has(message.id))) {
    throw new Error("History page overlapped the initial snapshot");
  }

  const content = `Safe preview smoke ${marker}: https://example.com/`;
  const sentMessagePromise = waitForEvent(
    socket,
    "message:new",
    (message) => message.authorId === snapshot.me.id && message.content === content,
    10_000,
  );
  const previewPromise = waitForEvent(
    socket,
    "link-preview:update",
    (payload) => payload.linkPreview?.displayHost === "example.com",
    20_000,
  );
  await emitAck(socket, "message:send", { channelId: "lobby", content });
  const sentMessage = await sentMessagePromise;
  const preview = await previewPromise;
  if (preview.messageId !== sentMessage.id) throw new Error("Preview was attached to the wrong message");
  if (preview.linkPreview.url !== "https://example.com/") {
    throw new Error(`Preview republished an unexpected click URL: ${preview.linkPreview.url}`);
  }
  if (typeof preview.linkPreview.title !== "string" || preview.linkPreview.title.length === 0) {
    throw new Error("Preview did not publish a bounded title");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        initialLobbyMessages: snapshot.messages.filter((message) => message.channelId === "lobby").length,
        olderPageMessages: historyBody.page.messages.length,
        hasMore: historyBody.page.hasMore,
        linkPreview: preview.linkPreview,
      },
      null,
      2,
    ),
  );
} finally {
  socket.disconnect();
}
