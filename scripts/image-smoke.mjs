import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const fixturePath = process.env.IMAGE_FIXTURE ?? "docs/assets/third-place-chat.jpg";
const marker = Date.now().toString(36).slice(-6);

const waitForEvent = (socket, event, predicate, timeoutMs) =>
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

const sessionResponse = await fetch(`${baseUrl}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `Vision-${marker}` }),
});
const sessionBody = await sessionResponse.json();
if (!sessionResponse.ok) throw new Error(sessionBody.error ?? `Session failed: ${sessionResponse.status}`);
const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Session endpoint did not return a cookie");

const socket = io(baseUrl, {
  forceNew: true,
  transports: ["websocket"],
  extraHeaders: { Cookie: cookie },
});

try {
  const connectFailure = new Promise((_, reject) => socket.once("connect_error", reject));
  const snapshot = await Promise.race([
    waitForEvent(socket, "room:snapshot", () => true, 10_000),
    connectFailure,
  ]);

  const postedMessages = [];
  const analysisUpdates = [];
  socket.on("message:new", (message) => postedMessages.push(message));
  socket.on("image-analysis:update", (payload) => analysisUpdates.push(payload));

  const bytes = await readFile(fixturePath);
  const form = new FormData();
  form.set("content", `Vad ser ni i bilden? Kommentera den mest slående detaljen. [${marker}]`);
  form.set("image", new Blob([bytes], { type: "image/jpeg" }), "vision-smoke.jpg");
  const uploadResponse = await fetch(`${baseUrl}/api/channels/3d-visualisation/image-messages`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: baseUrl },
    body: form,
  });
  const upload = await uploadResponse.json();
  if (!uploadResponse.ok || !upload.ok) throw new Error(upload.error ?? `Upload failed: ${uploadResponse.status}`);
  const message = upload.message;
  const attachment = message.attachments?.[0];
  if (!attachment || attachment.analysis.status !== "pending") throw new Error("Upload did not return a pending image attachment");

  const mediaResponse = await fetch(`${baseUrl}${attachment.url}`, { headers: { Cookie: cookie } });
  if (!mediaResponse.ok || mediaResponse.headers.get("content-type") !== "image/webp") {
    throw new Error(`Sanitized media endpoint failed: ${mediaResponse.status} ${mediaResponse.headers.get("content-type")}`);
  }
  if ((await mediaResponse.arrayBuffer()).byteLength === 0) throw new Error("Sanitized media response was empty");

  const existingAnalysis = analysisUpdates.find((payload) => payload.messageId === message.id);
  const analysis =
    existingAnalysis ??
    (await waitForEvent(socket, "image-analysis:update", (payload) => payload.messageId === message.id, 150_000));
  if (analysis.analysis.status !== "ready") throw new Error("Gemma did not produce a visual observation");

  const existingReply = postedMessages.find(
    (candidate) => candidate.replyToId === message.id && candidate.authorId.startsWith("ai-") && candidate.generation === "lm",
  );
  const reply =
    existingReply ??
    (await waitForEvent(
      socket,
      "message:new",
      (candidate) => candidate.replyToId === message.id && candidate.authorId.startsWith("ai-") && candidate.generation === "lm",
      180_000,
    ));

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  console.log(
    JSON.stringify(
      {
        ok: true,
        guest: snapshot.me.name,
        messageId: message.id,
        sanitizedImage: {
          width: attachment.width,
          height: attachment.height,
          mimeType: attachment.mimeType,
        },
        observation: analysis.analysis.observation,
        aiReply: { authorId: reply.authorId, content: reply.content },
        model: health.model,
      },
      null,
      2,
    ),
  );
} finally {
  socket.disconnect();
}
