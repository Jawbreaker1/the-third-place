import { io } from "socket.io-client";
import { retireSmokeSession } from "./smoke-session.mjs";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4000";
const marker = Date.now().toString(36).slice(-6);
const timeoutFromEnv = Number.parseInt(process.env.WEATHER_SMOKE_TIMEOUT_MS ?? "180000", 10);
const replyTimeoutMs = Number.isSafeInteger(timeoutFromEnv)
  ? Math.max(30_000, Math.min(300_000, timeoutFromEnv))
  : 180_000;
const INTERNAL_PUBLICATION_MARKER =
  /(?:⟦(?:HUMANIZER_\d+_\d+|[^⟦⟧\r\n]{1,96}_TECH_(?:\d+|n))⟧|\[S\d+\])/iu;

const quickCases = [
  {
    id: "public-stockholm-ranked-homonym",
    medium: "public",
    // This is the exact sentence that exposed the live lobby regression.
    text: "hur blir vädret i stockholm imorrn? shortsväder?",
    expectedTitle: /Stockholm/iu,
    expectedCoordinates: { latitude: 59.32938, longitude: 18.06871 },
  },
  {
    id: "dm-gothenburg-local-name",
    medium: "dm",
    text: "Kan du kolla vädret i Göteborg? Kommer det bli kallare snart?",
    expectedTitle: /Gothenburg|Göteborg/iu,
    expectedCoordinates: { latitude: 57.70716, longitude: 11.96679 },
  },
];

const matrixCases = [
  ...quickCases,
  {
    id: "public-barcelona-ranked-homonym",
    medium: "public",
    text: "¿Va a hacer más frío en Barcelona durante los próximos días?",
    expectedTitle: /Barcelona/iu,
    expectedCoordinates: { latitude: 41.38879, longitude: 2.15899 },
  },
  {
    id: "dm-seattle-ranked-homonym",
    medium: "dm",
    text: "Could you check whether it will rain in Seattle tomorrow?",
    expectedTitle: /Seattle/iu,
    expectedCoordinates: { latitude: 47.60621, longitude: -122.33207 },
  },
  {
    id: "public-mexico-city-local-name",
    medium: "public",
    text: "¿Va a refrescar pronto en Ciudad de México?",
    expectedTitle: /Mexico City|Ciudad de México/iu,
    expectedCoordinates: { latitude: 19.42847, longitude: -99.12766 },
  },
  {
    id: "dm-sapporo-local-name",
    medium: "dm",
    text: "明日の札幌は雪になりますか？天気を確認して。",
    expectedTitle: /Sapporo|札幌/iu,
    expectedCoordinates: { latitude: 43.06667, longitude: 141.35 },
  },
];

const requestedIds = new Set(
  (process.env.WEATHER_SMOKE_ONLY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCases = (process.env.WEATHER_SMOKE_MATRIX === "true" ? matrixCases : quickCases)
  .filter((testCase) => requestedIds.size === 0 || requestedIds.has(testCase.id));
if (selectedCases.length === 0) {
  throw new Error("WEATHER_SMOKE_ONLY did not match a known weather smoke case");
}

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

const createConnection = async (caseId, index) => {
  let cookie;
  let socket;
  try {
    const response = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Weather-${marker}-${index + 1}`, adultConfirmed: true }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${caseId}: session failed: ${body.error ?? response.status}`);
    cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error(`${caseId}: session endpoint did not return a cookie`);
    socket = io(baseUrl, {
      forceNew: true,
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie },
    });
    const snapshot = await Promise.race([
      waitForEvent(socket, "room:snapshot", () => true, 10_000),
      new Promise((_, reject) => socket.once("connect_error", reject)),
    ]);
    return { cookie, socket, snapshot };
  } catch (error) {
    socket?.disconnect();
    if (cookie) await retireSmokeSession(baseUrl, cookie);
    throw error;
  }
};

const openMeteoSource = (reply) => reply?.sources?.find((candidate) => {
  try {
    const url = new URL(candidate.url);
    return url.protocol === "https:" &&
      url.hostname === "api.open-meteo.com" &&
      url.pathname === "/v1/forecast" &&
      url.searchParams.has("latitude") &&
      url.searchParams.has("longitude") &&
      url.searchParams.get("forecast_days") === "7";
  } catch {
    return false;
  }
});

const assertWeatherReply = (testCase, reply) => {
  if (!reply?.content || INTERNAL_PUBLICATION_MARKER.test(reply.content)) {
    throw new Error(`${testCase.id}: reply was empty or exposed an internal source marker`);
  }
  const source = openMeteoSource(reply);
  if (!source) throw new Error(`${testCase.id}: reply did not carry a server-bound Open-Meteo source`);
  if (!testCase.expectedTitle.test(source.title)) {
    throw new Error(`${testCase.id}: source resolved an unexpected place: ${source.title}`);
  }
  const sourceUrl = new URL(source.url);
  const latitude = Number(sourceUrl.searchParams.get("latitude"));
  const longitude = Number(sourceUrl.searchParams.get("longitude"));
  const tolerance = 0.75;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude - testCase.expectedCoordinates.latitude) > tolerance ||
    Math.abs(longitude - testCase.expectedCoordinates.longitude) > tolerance
  ) {
    throw new Error(`${testCase.id}: source resolved unexpected coordinates: ${latitude}, ${longitude}`);
  }
  return source;
};

const runPublicCase = async (testCase, socket, me) => {
  const humanMessagePromise = waitForEvent(
    socket,
    "message:new",
    (message) => message.authorId === me.id && message.content === testCase.text,
    10_000,
  );
  await emitAck(socket, "message:send", { channelId: "lobby", content: testCase.text });
  const humanMessage = await humanMessagePromise;
  const reply = await waitForEvent(
    socket,
    "message:new",
    (message) => message.replyToId === humanMessage.id &&
      message.authorId?.startsWith("ai-") &&
      message.generation === "lm" &&
      Boolean(openMeteoSource(message)),
  );
  return reply;
};

const runDmCase = async (testCase, socket) => {
  const opened = await emitAck(socket, "dm:open", { peerId: "ai-mira" });
  const pendingReply = waitForEvent(
    socket,
    "dm:update",
    (payload) => payload.message?.authorId === "ai-mira" &&
      payload.message?.replyToId &&
      payload.message?.generation === "lm" &&
      Boolean(openMeteoSource(payload.message)),
  );
  await emitAck(socket, "message:send", { channelId: opened.thread.id, content: testCase.text });
  const update = await pendingReply;
  return update.message;
};

const results = [];
for (const [index, testCase] of selectedCases.entries()) {
  const { cookie, socket, snapshot } = await createConnection(testCase.id, index);
  try {
    const reply = testCase.medium === "public"
      ? await runPublicCase(testCase, socket, snapshot.me)
      : await runDmCase(testCase, socket);
    const source = assertWeatherReply(testCase, reply);
    results.push({
      id: testCase.id,
      medium: testCase.medium,
      request: testCase.text,
      reply: reply.content,
      source,
    });
  } finally {
    socket.disconnect();
    await retireSmokeSession(baseUrl, cookie);
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: process.env.WEATHER_SMOKE_MATRIX === "true" ? "matrix" : "quick",
  cases: results,
}, null, 2));
