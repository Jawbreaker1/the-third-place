import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import dotenv from "dotenv";
import Busboy from "busboy";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { Server } from "socket.io";
import { z } from "zod";
import type {
  ActionResult,
  ChatMessage,
  HistoryPage,
  ImageAnalysis,
  ImageAnalysisPayload,
  ImageMessageResult,
  JoinResult,
  LinkPreviewPayload,
  Member,
  PublicPreview,
  RoomSnapshot,
  ServerHealth,
  VoiceCreateResult,
  VoiceIceServer,
  VoiceInviteBotResult,
  VoiceJoinResult,
  VoiceLeaveResult,
  VoiceRoomView,
  VoiceTranscriptEntry,
} from "../shared/types.js";
import { isPublicReactionEmoji } from "../shared/reactions.js";
import type { AdminHumanMember } from "../shared/adminTypes.js";
import { displayNameGlyph, normalizeDisplayName, validDisplayName } from "../shared/displayName.js";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { AdminAuthManager } from "./adminAuth.js";
import { AdminModerationGuard } from "./adminModeration.js";
import { createAdminRouter } from "./adminRouter.js";
import { AdminStateError, AdminStateStore } from "./adminState.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import { AmbientEpisodeLedger } from "./ambientEpisodeLedger.js";
import { LinkPreviewBroker } from "./linkPreviewBroker.js";
import { fetchRemoteImage, ImageStore, ImageStoreError } from "./imageStore.js";
import { HUMAN_MEMORY_DEFAULTS, HumanMemoryStore } from "./humanMemory.js";
import { LmStudioClient } from "./lmStudio.js";
import { LmStudioBackend } from "./lmStudioBackend.js";
import { CodexBackend } from "./codexBackend.js";
import { ModelProviderManager } from "./modelProviderManager.js";
import { SwitchableSocialModel } from "./switchableModel.js";
import { CHANNELS } from "./channels.js";
import { PERSONAS, memberView } from "./personas.js";
import { configuredProviderVoiceIds } from "./personaVoices.js";
import { participantIdentityKey } from "./participantIdentity.js";
import {
  configuredWebOrigin,
  parseWebOriginConfiguration,
  socketOriginAllowed,
} from "./originPolicy.js";
import { ResearchBroker } from "./researchBroker.js";
import { PageReader } from "./pageReader.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { MarketSnapshotService } from "./marketData/service.js";
import { YahooChartMarketDataProvider } from "./marketData/providers/yahooChart.js";
import { FootballCompetitionProvider } from "./footballCompetition.js";
import { resolveCommunityTimeZone } from "./timeResolver.js";
import {
  JsonFileMarketPulseStateStore,
  MarketPulseCoordinator,
} from "./marketPulse.js";
import { safeMarketPulseFeedFetcher } from "./marketPulseFetch.js";
import {
  ADMIN_JSON_BODY_LIMIT_BYTES,
  PUBLIC_JSON_BODY_LIMIT_BYTES,
  isAdminApiPath,
} from "./requestBodyPolicy.js";
import { installSpaHosting } from "./spaHosting.js";
import { createMessage, type HistoryPosition, RoomStore } from "./store.js";
import { VoiceDirector } from "./voiceDirector.js";
import { preferredRequestLanguage } from "./requestLanguage.js";
import { VoiceIngestGate, VoiceIngestGateError, type VoiceIngestRelease } from "./voiceIngestGate.js";
import { VoiceRoomRuntime } from "./voiceRooms.js";
import { VoiceSpeechError, VoiceSpeechService } from "./voiceSpeech.js";

dotenv.config();

const PORT = Number.parseInt(process.env.PORT ?? "4000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const INVITE_CODE = process.env.ROOM_INVITE_CODE?.trim();
const SESSION_COOKIE = "atrium_session";
const SESSION_RETENTION_MS = HUMAN_MEMORY_DEFAULTS.retentionMs;
const SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(SESSION_RETENTION_MS / 1_000);
const SESSION_HEARTBEAT_MS = 10 * 60_000;
const PACE: ServerHealth["aiPace"] =
  process.env.AI_PACE === "calm" || process.env.AI_PACE === "party" ? process.env.AI_PACE : "lively";
const VOICE_ENABLED = process.env.VOICE_ENABLED !== "false";
const VOICE_RECONNECT_GRACE_MS = Math.max(
  3_000,
  Math.min(60_000, Number.parseInt(process.env.VOICE_RECONNECT_GRACE_MS ?? "15000", 10) || 15_000),
);

const readVoiceIceServers = (): VoiceIceServer[] => {
  const configured = process.env.VOICE_ICE_SERVERS_JSON?.trim();
  if (!configured) {
    return [
      {
        urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
      },
    ];
  }
  try {
    const parsed = z
      .array(
        z
          .object({
            urls: z.union([z.string().url(), z.array(z.string().url()).min(1).max(8)]),
            username: z.string().max(256).optional(),
            credential: z.string().max(512).optional(),
          })
          .strict(),
      )
      .max(8)
      .parse(JSON.parse(configured));
    return parsed;
  } catch (error) {
    console.warn("VOICE_ICE_SERVERS_JSON is invalid; voice will use public STUN only:", error instanceof Error ? error.message : error);
    return [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
  }
};

interface HumanSession {
  tokenHash: string;
  member: Member;
  socketIds: Set<string>;
  lastSeenAt: number;
  createdAt: number;
  historyBucket: TokenBucket;
  imageBucket: TokenBucket;
  voiceBucket: TokenBucket;
}

class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) / 1_000) * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

const createHumanSession = (
  tokenHash: string,
  member: Member,
  lastSeenAt = Date.now(),
  createdAt = lastSeenAt,
): HumanSession => ({
  tokenHash,
  member: { ...member, avatar: { ...member.avatar }, status: "offline" },
  socketIds: new Set(),
  lastSeenAt,
  createdAt,
  historyBucket: new TokenBucket(8, 1),
  imageBucket: new TokenBucket(3, 1 / 25),
  voiceBucket: new TokenBucket(12, 0.5),
});

const joinSchema = z.object({
  name: z.string().min(1).max(128),
  inviteCode: z.string().max(100).optional(),
});
const messageSchema = z.object({
  channelId: z.string().min(1).max(160),
  content: z.string().min(1).max(500),
  replyToId: z.string().max(100).optional(),
});
const reactionSchema = z.object({
  channelId: z.string().min(1).max(80),
  messageId: z.string().min(1).max(100),
  emoji: z.string().min(1).max(12),
});
const voiceRoomIdSchema = z.object({ roomId: z.string().uuid() }).strict();
const voiceCreateSchema = z.object({ channelId: z.string().min(1).max(80) }).strict();
const voiceStateSchema = z
  .object({ roomId: z.string().uuid(), muted: z.boolean().optional(), deafened: z.boolean().optional(), speaking: z.boolean().optional() })
  .strict();
const voiceBotSchema = z.object({ roomId: z.string().uuid(), personaId: z.string().min(1).max(100) }).strict();
const voiceTextTurnSchema = z.object({ roomId: z.string().uuid(), text: z.string().min(1).max(500) }).strict();

interface ImageMessageForm {
  content: string;
  replyToId?: string;
  imageUrl?: string;
  file?: { body: Buffer; mimeType: string };
}

const parseImageMessageForm = async (request: Request): Promise<ImageMessageForm> =>
  await new Promise((resolveForm, rejectForm) => {
    if (!request.headers["content-type"]?.toLocaleLowerCase().startsWith("multipart/form-data")) {
      rejectForm(new ImageStoreError("Send the image as multipart form data.", 415));
      return;
    }
    const parser = Busboy({
      headers: request.headers,
      limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 3, parts: 4, fieldSize: 2_048 },
    });
    const fields = new Map<string, string>();
    let file: ImageMessageForm["file"];
    let fileSeen = false;
    let parseError: Error | undefined;
    parser.on("field", (name, value) => {
      if (["content", "replyToId", "imageUrl"].includes(name)) fields.set(name, value);
    });
    parser.on("file", (_name, stream, info) => {
      if (fileSeen) {
        parseError = new ImageStoreError("Attach one image at a time.");
        stream.resume();
        return;
      }
      fileSeen = true;
      const chunks: Buffer[] = [];
      let limited = false;
      stream.on("limit", () => {
        limited = true;
        parseError = new ImageStoreError("Images can be at most 8 MB.", 413);
      });
      stream.on("data", (chunk: Buffer) => {
        if (!limited) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (!limited) file = { body: Buffer.concat(chunks), mimeType: info.mimeType };
      });
    });
    parser.on("filesLimit", () => {
      parseError = new ImageStoreError("Attach one image at a time.");
    });
    parser.on("fieldsLimit", () => {
      parseError = new ImageStoreError("Too many image message fields.");
    });
    parser.on("partsLimit", () => {
      parseError = new ImageStoreError("Too many image message parts.");
    });
    parser.on("error", rejectForm);
    request.once("aborted", () => rejectForm(new ImageStoreError("The image upload was interrupted.")));
    parser.on("finish", () => {
      if (parseError) {
        rejectForm(parseError);
        return;
      }
      resolveForm({
        content: fields.get("content") ?? "",
        ...(fields.get("replyToId") ? { replyToId: fields.get("replyToId") } : {}),
        ...(fields.get("imageUrl") ? { imageUrl: fields.get("imageUrl") } : {}),
        ...(file ? { file } : {}),
      });
    });
    request.pipe(parser);
  });

interface VoiceTurnForm {
  audio: Buffer;
  mimeType: string;
  utteranceId?: string;
}

const parseVoiceTurnForm = async (request: Request): Promise<VoiceTurnForm> =>
  await new Promise((resolveForm, rejectForm) => {
    if (!request.headers["content-type"]?.toLocaleLowerCase().startsWith("multipart/form-data")) {
      rejectForm(new VoiceSpeechError("Send the voice turn as multipart form data.", 415, "INVALID_MULTIPART"));
      return;
    }
    const parser = Busboy({
      headers: request.headers,
      limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 2, parts: 4, fieldSize: 256 },
    });
    let audio: Buffer | undefined;
    let mimeType = "";
    let seenFile = false;
    let utteranceId: string | undefined;
    let parseError: Error | undefined;
    parser.on("file", (_name, stream, info) => {
      if (seenFile) {
        parseError = new VoiceSpeechError("Send one voice clip at a time.", 400, "TOO_MANY_AUDIO_FILES");
        stream.resume();
        return;
      }
      seenFile = true;
      const chunks: Buffer[] = [];
      let limited = false;
      stream.on("limit", () => {
        limited = true;
        parseError = new VoiceSpeechError("Voice clips can be at most 6 MB.", 413, "AUDIO_TOO_LARGE");
      });
      stream.on("data", (chunk: Buffer) => {
        if (!limited) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (!limited) {
          audio = Buffer.concat(chunks);
          mimeType = info.mimeType;
        }
      });
    });
    parser.on("filesLimit", () => {
      parseError = new VoiceSpeechError("Send one voice clip at a time.", 400, "TOO_MANY_AUDIO_FILES");
    });
    parser.on("field", (name, value) => {
      // Older tabs sent this redundant field. The file part remains the only
      // trusted MIME source, but accepting the bounded name keeps hot reloads compatible.
      if (name === "utteranceId") {
        if (!z.string().uuid().safeParse(value).success) {
          parseError = new VoiceSpeechError("That voice turn id is invalid.", 400, "INVALID_UTTERANCE_ID");
        } else {
          utteranceId = value;
        }
      } else if (name !== "mimeType") {
        parseError = new VoiceSpeechError("Voice turns accept one audio file.", 400, "TOO_MANY_AUDIO_PARTS");
      }
    });
    parser.on("fieldsLimit", () => {
      parseError = new VoiceSpeechError("Voice turns accept one audio file.", 400, "TOO_MANY_AUDIO_PARTS");
    });
    parser.on("partsLimit", () => {
      parseError = new VoiceSpeechError("Too many voice turn fields.", 400, "TOO_MANY_AUDIO_PARTS");
    });
    parser.on("error", rejectForm);
    request.once("aborted", () => rejectForm(new VoiceSpeechError("The voice upload was interrupted.", 400, "UPLOAD_ABORTED")));
    parser.on("finish", () => {
      if (parseError) return rejectForm(parseError);
      if (!audio?.length || !mimeType) {
        rejectForm(new VoiceSpeechError("Choose a voice clip to transcribe.", 400, "EMPTY_AUDIO"));
        return;
      }
      resolveForm({ audio, mimeType, ...(utteranceId ? { utteranceId } : {}) });
    });
    request.pipe(parser);
  });

const parseCookies = (header?: string): Record<string, string> =>
  Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const safeNameKey = participantIdentityKey;
const randomAvatar = (): Member["avatar"] => {
  const palettes = [
    ["#ff7163", "#ffb866"],
    ["#5f73ea", "#8ad8ff"],
    ["#4abf98", "#a7e7c4"],
    ["#bb65db", "#f6a5dd"],
    ["#d8934d", "#f4d47d"],
  ];
  const [color, accent] = palettes[Math.floor(Math.random() * palettes.length)] as [string, string];
  return { color, accent, glyph: "?" };
};

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'"],
      },
    },
  }),
);
app.use((_request, response, next) => {
  response.setHeader("Permissions-Policy", "microphone=(self)");
  next();
});
// Forty multilingual room seeds can exceed 64 KiB in UTF-8 while remaining
// inside the strict character schema. Keep admin writes separately bounded.
const publicJsonParser = express.json({ limit: PUBLIC_JSON_BODY_LIMIT_BYTES });
const adminJsonParser = express.json({ limit: ADMIN_JSON_BODY_LIMIT_BYTES });
app.use((request, response, next) => {
  (isAdminApiPath(request.path) ? adminJsonParser : publicJsonParser)(request, response, next);
});

const httpServer = createServer(app);
const { configuredOrigins, publicOrigin } = parseWebOriginConfiguration(
  process.env.ALLOWED_ORIGINS,
  process.env.PUBLIC_ORIGIN,
);
const io = new Server(httpServer, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 22_000,
  pingTimeout: 20_000,
  connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: false },
  cors: {
    origin: (origin, callback) => {
      if (socketOriginAllowed(origin, configuredOrigins, publicOrigin)) callback(null, true);
      else callback(new Error("Origin not allowed"));
    },
    credentials: true,
  },
});

const store = new RoomStore();
const humanMemory = new HumanMemoryStore();
const ambientEpisodeLedger = new AmbientEpisodeLedger();
await ambientEpisodeLedger.load();
let adminState!: AdminStateStore;
const behaviorTuningProvider = (channelId?: string) => adminState?.behaviorTuning(channelId);
const lmStudioBackend = new LmStudioBackend();
const codexBackend = new CodexBackend();
const lmStudioClient = new LmStudioClient({ behaviorTuningProvider, backend: lmStudioBackend });
const codexClient = new LmStudioClient({
  behaviorTuningProvider,
  backend: codexBackend,
  timeoutMs: Number.parseInt(process.env.CODEX_TIMEOUT_MS ?? "120000", 10),
});
const lm = new SwitchableSocialModel({ lmstudio: lmStudioClient, codex: codexClient });
const modelProviders = new ModelProviderManager(lm, codexBackend);
await modelProviders.load();
const researchBroker = new ResearchBroker();
const linkPreviewBroker = new LinkPreviewBroker();
const imageStore = new ImageStore();
const allowedTtsVoiceIds = configuredProviderVoiceIds(
  process.env.TTS_MODEL,
  process.env.TTS_VOICE,
  process.env.TTS_VOICES,
);
const voiceSpeech = new VoiceSpeechService({
  ttsVoices: allowedTtsVoiceIds,
});
const voiceSpeechCapabilities = await voiceSpeech.capabilities();
const exposedTtsVoiceIds = voiceSpeechCapabilities.tts.available ? allowedTtsVoiceIds : [];
const exposedTtsLanguages = [...(voiceSpeechCapabilities.tts.supportedLanguages ?? [])];
adminState = new AdminStateStore({
  configuredVoiceIds: allowedTtsVoiceIds,
  voiceOptions: {
    languages: exposedTtsLanguages,
    voices: exposedTtsVoiceIds.map((id) => ({
      id,
      label: id,
      languages: exposedTtsLanguages,
    })),
  },
});
await adminState.load();
const adminAuth = new AdminAuthManager({ password: process.env.ADMIN_PASSWORD });
const adminModeration = new AdminModerationGuard({
  kickCooldownMs: Number.parseInt(process.env.ADMIN_KICK_COOLDOWN_MS ?? "300000", 10),
});
const actorChannels = new ActorChannelRuntime();
const voiceRooms = new VoiceRoomRuntime(
  CHANNELS.map((channel) => channel.id),
  {
    capabilities: {
      transcription: true,
      speechToText: voiceSpeechCapabilities.stt.available,
      textToSpeech: voiceSpeechCapabilities.tts.available,
      iceServers: readVoiceIceServers(),
    },
  },
);
const sessions = new Map<string, HumanSession>();
const synchronizeOfflineSessionsWithMemory = (): void => {
  const rememberedTokenHashes = new Set(humanMemory.listRestorableProfiles().map((profile) => profile.tokenHash));
  for (const [tokenHash, session] of sessions) {
    if (session.socketIds.size > 0 || rememberedTokenHashes.has(tokenHash)) continue;
    sessions.delete(tokenHash);
    store.forgetDmParticipant(session.member.id);
  }
};
const joinAttempts = new Map<string, number[]>();
const socketBuckets = new Map<
  string,
  {
    messages: TokenBucket;
    reactions: TokenBucket;
    typing: TokenBucket;
    voiceActions: TokenBucket;
    voiceSignals: TokenBucket;
  }
>();
const MAX_CONCURRENT_IMAGE_INGESTS = 2;
let activeImageIngests = 0;
const voiceIngestGate = new VoiceIngestGate({ maxActive: 2, maxQueued: 10 });
const voiceIngestGatesByRoom = new Map<string, VoiceIngestGate>();
const pendingVoiceIngestsByRoom = new Map<string, number>();
const pendingVoiceIngestsByMember = new Map<string, number>();
const completedVoiceTurns = new Map<string, { expiresAt: number; entry: VoiceTranscriptEntry }>();
const VOICE_TURN_DEDUP_TTL_MS = 10 * 60_000;
const VOICE_QUEUE_TIMEOUT_MS = 15_000;

const adjustCounter = (counts: Map<string, number>, key: string, delta: number): number => {
  const next = Math.max(0, (counts.get(key) ?? 0) + delta);
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
  return next;
};

const voiceIngestGateForRoom = (roomId: string): VoiceIngestGate => {
  const existing = voiceIngestGatesByRoom.get(roomId);
  if (existing) return existing;
  const created = new VoiceIngestGate({ maxActive: 1, maxQueued: 6 });
  voiceIngestGatesByRoom.set(roomId, created);
  return created;
};

const forgetVoiceIngestRoom = (roomId: string): void => {
  const gate = voiceIngestGatesByRoom.get(roomId);
  if (!gate || (gate.activeCount === 0 && gate.queuedCount === 0)) voiceIngestGatesByRoom.delete(roomId);
  pendingVoiceIngestsByRoom.delete(roomId);
  for (const key of completedVoiceTurns.keys()) {
    if (key.startsWith(`${roomId}:`)) completedVoiceTurns.delete(key);
  }
};

const encodeHistoryCursor = (message: Pick<ChatMessage, "createdAt" | "id">): string =>
  Buffer.from(JSON.stringify({ v: 1, createdAt: message.createdAt, id: message.id }), "utf8").toString("base64url");

const decodeHistoryCursor = (raw: string | undefined): HistoryPosition | undefined => {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const parsed = z
      .object({ v: z.literal(1), createdAt: z.string().datetime(), id: z.string().min(1).max(100) })
      .safeParse(decoded);
    return parsed.success ? { createdAt: parsed.data.createdAt, id: parsed.data.id } : undefined;
  } catch {
    return undefined;
  }
};

const historyPageFor = (channelId: string, before?: HistoryPosition, limit = 40): HistoryPage => {
  const page = store.getHistoryPage(channelId, before, limit);
  const first = page.messages[0];
  return {
    ...page,
    ...(page.hasMore && first ? { before: encodeHistoryCursor(first) } : {}),
  };
};

const getMembers = (): Member[] => [
  ...PERSONAS.map((persona) => ({ ...memberView(persona), activity: actorChannels.activityLabel(persona) })),
  ...[...sessions.values()]
    .filter((session) => session.member.status === "online")
    .map((session) => ({ ...session.member })),
];
const replyPreviewFor = (message: ChatMessage) => ({
  authorId: message.authorId,
  authorName:
    getMembers().find((member) => member.id === message.authorId)?.name ??
    message.authorSnapshot?.name ??
    (message.system ? "room" : "someone"),
  content: (message.content || (message.attachments?.length ? "Shared an image" : "")).slice(0, 140),
});
const onlineHumanCount = () => [...sessions.values()].filter((session) => session.member.status === "online").length;
const getHealth = (): ServerHealth => ({
  ok: true,
  model: lm.health(),
  onlineHumans: onlineHumanCount(),
  aiPace: PACE,
});
const marketSnapshotProvider = process.env.MARKET_SNAPSHOT_ENABLED === "false"
  ? null
  : new MarketSnapshotService({
      providers: [new YahooChartMarketDataProvider()],
    });
const footballCompetitionProvider = process.env.FOOTBALL_DATA_ENABLED === "false"
  ? null
  : new FootballCompetitionProvider({
      displayTimeZone: resolveCommunityTimeZone({
        configuredTimeZone: process.env.COMMUNITY_TIME_ZONE,
      }),
    });
const marketPulseCoordinator = process.env.MARKET_PULSE_ENABLED === "false"
  ? null
  : new MarketPulseCoordinator(
      safeMarketPulseFeedFetcher,
      new JsonFileMarketPulseStateStore(
        resolve(process.env.MARKET_PULSE_STATE_PATH ?? "./data/market-pulse-state.json"),
      ),
    );
const director = new SocialDirector(
  io,
  store,
  lm,
  actorChannels,
  researchBroker,
  humanMemory,
  getMembers,
  onlineHumanCount,
  {
    behaviorTuningProvider,
    marketSnapshotProvider,
    footballCompetitionProvider,
    marketPulseCoordinator,
    ambientEpisodeLedger,
  },
);

const voiceSocketRoom = (roomId: string) => `voice:${roomId}`;
const publishVoiceRooms = (): void => {
  io.to("public").emit("voice:rooms:update", voiceRooms.listRooms());
  director.setVoiceRoomActive(voiceRooms.listRooms().length > 0);
};
const publishVoiceRoom = (room: VoiceRoomView): void => {
  io.to(voiceSocketRoom(room.id)).emit("voice:room:update", room);
  publishVoiceRooms();
};
const voiceCapabilityRegistry = new CapabilityRegistry({
  pageReader: new PageReader(),
  researchBroker,
  weatherForecastProvider: null,
  marketSnapshotProvider: null,
  footballCompetitionProvider: null,
});
const voiceDirector = new VoiceDirector({
  runtime: voiceRooms,
  capabilityRegistry: voiceCapabilityRegistry,
  lm,
  speech: voiceSpeech,
  actorChannels,
  humanMemory,
  establishedChannelLanguage: (channelId) => director.trustedLanguageForChannel(channelId),
  recentChannelMessages: (channelId) => store.getRecent(channelId, 6)
    .filter((message) => !message.system && Boolean(message.content.trim()))
    .map((message) => ({
      id: message.id,
      authorId: message.authorId,
      authorName:
        getMembers().find((member) => member.id === message.authorId)?.name ??
        message.authorSnapshot?.name ??
        "someone",
      content: message.content,
      createdAt: message.createdAt,
    })),
  floorSilenceMs: 650,
  hasPendingHumanIngest: (roomId) => (pendingVoiceIngestsByRoom.get(roomId) ?? 0) > 0,
  events: {
    roomChanged: publishVoiceRoom,
    transcriptFinal: (entry) => io.to(voiceSocketRoom(entry.roomId)).emit("voice:transcript:final", entry),
    aiSpeech: (payload) => io.to(voiceSocketRoom(payload.roomId)).emit("voice:ai-speech", payload),
    aiStop: (payload) => io.to(voiceSocketRoom(payload.roomId)).emit("voice:ai-stop", payload),
  },
});

const analyzeImageMessage = (message: ChatMessage, human: Member): void => {
  const attachment = message.attachments?.[0];
  if (!attachment) return;
  void imageStore.read(attachment.id).then(async (image) => {
    let analysis: ImageAnalysis = { status: "unavailable" };
    try {
      if (!image) throw new Error("Sanitized image was unavailable");
      const observation = await lm.analyzeImage(image, message.content, 1);
      analysis = { status: "ready", observation };
    } catch (error) {
      console.warn("Image analysis unavailable:", error instanceof Error ? error.message : error);
    }
    const updated = store.setImageAnalysis(message.channelId, message.id, attachment.id, analysis);
    if (!updated) return;
    imageStore.update(updated);
    const payload: ImageAnalysisPayload = {
      channelId: message.channelId,
      messageId: message.id,
      attachmentId: attachment.id,
      analysis,
    };
    io.to("public").emit("image-analysis:update", payload);
    director.onHumanImageReady(message, human, analysis.status === "ready" ? analysis.observation : undefined);
  });
};

const sessionFromRequest = (request: Request): HumanSession | undefined => {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const session = token ? sessions.get(hashToken(token)) : undefined;
  if (!session || adminState.isBanned(session.member.id, session.member.name) || adminModeration.isKicked(session.member.id, session.member.name)) {
    return undefined;
  }
  return session;
};

const authenticatedSessionFromRequest = (
  request: Request,
): { session: HumanSession; token: string } | undefined => {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return undefined;
  const session = sessions.get(hashToken(token));
  if (!session || adminState.isBanned(session.member.id, session.member.name) || adminModeration.isKicked(session.member.id, session.member.name)) {
    return undefined;
  }
  return { session, token };
};

const clientIp = (request: Request): string => {
  if (process.env.TRUST_PROXY === "true") {
    const cloudflareIp = request.headers["cf-connecting-ip"];
    if (typeof cloudflareIp === "string") return cloudflareIp;
  }
  return request.ip || request.socket.remoteAddress || "unknown";
};

const hasAllowedOrigin = (request: Request): boolean => {
  const origin = request.headers.origin;
  if (!origin) return true;
  const normalized = configuredWebOrigin(origin);
  if (normalized && (configuredOrigins.includes(normalized) || publicOrigin === normalized)) return true;
  try {
    return new URL(origin).host === request.get("host");
  } catch {
    return false;
  }
};

const allowJoinAttempt = (ip: string): boolean => {
  const now = Date.now();
  const recent = (joinAttempts.get(ip) ?? []).filter((timestamp) => now - timestamp < 10 * 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  joinAttempts.set(ip, recent);
  return true;
};

const snapshotFor = (session: HumanSession): RoomSnapshot => {
  const pages = CHANNELS.map((channel) => historyPageFor(channel.id));
  return {
    me: { ...session.member },
    members: getMembers(),
    channels: CHANNELS,
    messages: pages
      .flatMap((page) => page.messages)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    historyPageInfo: Object.fromEntries(
      pages.map((page) => [page.channelId, { before: page.before, hasMore: page.hasMore }]),
    ),
    dmThreads: store.getDmThreads(session.member.id),
    inviteRequired: Boolean(INVITE_CODE),
    health: getHealth(),
    directorEvents: director.getEvents(),
  };
};

const attachLinkPreview = (message: ChatMessage, requesterId: string): void => {
  void linkPreviewBroker.previewMessage(message.content, requesterId).then((linkPreview) => {
    if (!linkPreview || !store.setLinkPreview(message.channelId, message.id, linkPreview)) return;
    const payload: LinkPreviewPayload = { channelId: message.channelId, messageId: message.id, linkPreview };
    io.to("public").emit("link-preview:update", payload);
  });
};

const setSessionCookie = (request: Request, response: Response, token: string): void => {
  const secure = request.secure || publicOrigin?.startsWith("https://");
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
  );
};

const adminHumans = (): AdminHumanMember[] => [...sessions.values()]
  .map((session) => ({
    id: session.member.id,
    name: session.member.name,
    status: session.member.status,
    joinedAt: new Date(session.createdAt).toISOString(),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const disconnectModeratedHuman = (
  memberId: string,
  reason: string | undefined,
  reconnectCooldown: boolean,
): AdminHumanMember | undefined => {
  const session = [...sessions.values()].find((candidate) => candidate.member.id === memberId);
  if (!session) return undefined;
  if (reconnectCooldown) adminModeration.kick(session.member.id, session.member.name);
  for (const socketId of [...session.socketIds]) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.emit("session:moderated", {
      action: reconnectCooldown ? "kick" : "ban",
      message: reason || (reconnectCooldown ? "You were removed from the room for a short cooldown." : "You were banned from this room."),
    });
    const voiceRoom = voiceRooms.getRoomForSocket(socketId);
    const voiceResult = voiceRooms.leaveRoom(socketId);
    if (voiceRoom && voiceResult.ok) {
      if (voiceResult.closed) {
        voiceDirector.forgetRoom(voiceResult.roomId);
        forgetVoiceIngestRoom(voiceResult.roomId);
        voiceSpeech.audioStore.deleteRoom(voiceResult.roomId);
        io.to(voiceSocketRoom(voiceResult.roomId)).emit("voice:room:closed", { roomId: voiceResult.roomId });
        publishVoiceRooms();
      } else {
        publishVoiceRoom(voiceResult.room);
      }
    }
    socket?.disconnect(true);
  }
  session.member.status = "offline";
  io.to("public").emit("presence:update", { members: getMembers() });
  return {
    id: session.member.id,
    name: session.member.name,
    status: session.member.status,
    joinedAt: new Date(session.createdAt).toISOString(),
  };
};

adminState.setHooks({
  validateChannelIds: (channelIds) => {
    const result = voiceRooms.validateChannelIds(channelIds);
    if (!result.ok) {
      throw new AdminStateError(409, "CHANNEL_IN_USE", `Close the active voice room in #${result.channelIds[0]} before removing that channel.`);
    }
  },
  validatePersonaIds: (personaIds) => {
    const result = voiceRooms.validatePersonaIds(personaIds);
    if (!result.ok) {
      throw new AdminStateError(409, "PERSONA_IN_VOICE", `Remove ${result.personaIds[0]} from voice chat before disabling that persona.`);
    }
  },
  validatePersonaNames: (personas) => {
    const humansByName = new Map<string, string>();
    for (const session of sessions.values()) humansByName.set(safeNameKey(session.member.name), session.member.name);
    for (const profile of humanMemory.listRestorableProfiles()) {
      humansByName.set(safeNameKey(profile.member.name), profile.member.name);
    }
    for (const persona of personas) {
      const reservedBy = humansByName.get(safeNameKey(persona.name));
      if (!reservedBy) continue;
      throw new AdminStateError(
        409,
        "PERSONA_NAME_RESERVED",
        `The resident name ${persona.name} conflicts with the remembered human identity ${reservedBy}.`,
      );
    }
  },
  reconcileCatalog: () => {
    actorChannels.reconcileCatalog();
    const channelResult = voiceRooms.setChannelIds(CHANNELS.map((channel) => channel.id));
    if (!channelResult.ok) {
      throw new AdminStateError(409, "CHANNEL_IN_USE", "An active voice room still references a removed channel.");
    }
    for (const room of voiceRooms.reconcileBotCatalog(PERSONAS)) publishVoiceRoom(room);
  },
  onCommitted: (_snapshot, catalogChanged) => {
    if (!catalogChanged) return;
    director.reconcileCatalog();
    voiceDirector.onCatalogChanged(voiceRooms.listRooms().map((room) => room.id));
    io.to("public").emit("catalog:update", {
      channels: CHANNELS.map((channel) => ({ ...channel })),
      members: getMembers(),
    });
  },
});

const adminOrigins = [
  ...configuredOrigins,
  ...(publicOrigin ? [publicOrigin] : []),
];
app.use("/api/admin", createAdminRouter({
  auth: adminAuth,
  state: adminState,
  configuredOrigins: adminOrigins,
  getHumans: adminHumans,
  getAutonomousResearchDiagnostics: () => director.getAutonomousResearchDiagnostics(),
  kickHuman: (memberId, reason) => disconnectModeratedHuman(memberId, reason, true),
  banHuman: (memberId, reason) => disconnectModeratedHuman(memberId, reason, false),
  isSecure: (request) => request.secure || publicOrigin?.startsWith("https://") === true,
  llmProviders: modelProviders,
  onLlmProviderChanged: async () => {
    await lm.probe();
    director.reconcileCatalog();
    voiceDirector.onCatalogChanged(voiceRooms.listRooms().map((room) => room.id));
    io.to("public").emit("health:update", getHealth());
  },
}));

app.get("/api/voice/capabilities", (_request, response) => {
  const capabilities = voiceRooms.capabilities();
  response.json({
    ok: true,
    enabled: VOICE_ENABLED,
    capabilities: {
      ...capabilities,
      // TURN credentials are delivered only in authenticated create/join acks.
      iceServers: capabilities.iceServers.map(({ urls }) => ({ urls })),
    },
    speech: voiceSpeechCapabilities,
  });
});

app.get("/api/voice/audio/:audioId", (request, response) => {
  const session = sessionFromRequest(request);
  const roomId = typeof request.query.roomId === "string" ? request.query.roomId : "";
  if (!session) {
    response.status(401).json({ ok: false, error: "Join the room to hear AI voice audio." });
    return;
  }
  if (!z.string().uuid().safeParse(roomId).success || !voiceRooms.isMemberInRoom(roomId, session.member.id)) {
    response.status(403).json({ ok: false, error: "Join that voice room to hear its audio." });
    return;
  }
  const audio = voiceSpeech.lookupAudio(request.params.audioId, roomId);
  if (!audio) {
    response.status(404).json({ ok: false, error: "That voice response has expired." });
    return;
  }
  response.setHeader("Content-Type", audio.metadata.mimeType);
  response.setHeader("Content-Length", String(audio.body.length));
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Disposition", "inline");
  response.send(audio.body);
});

app.post("/api/voice/:roomId/turns", async (request, response) => {
  const session = sessionFromRequest(request);
  const roomId = request.params.roomId;
  if (!session) {
    response.status(401).json({ ok: false, error: "Join the room before sending a voice turn." });
    return;
  }
  if (!VOICE_ENABLED || !voiceSpeechCapabilities.stt.available) {
    response.status(503).json({ ok: false, error: "Server speech-to-text is not configured. Use the typed voice turn instead." });
    return;
  }
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "That voice upload origin is not allowed." });
    return;
  }
  if (!z.string().uuid().safeParse(roomId).success || !voiceRooms.isMemberInRoom(roomId, session.member.id)) {
    response.status(403).json({ ok: false, error: "Join that voice room before sending audio." });
    return;
  }
  if (!session.voiceBucket.take()) {
    response.status(429).json({ ok: false, error: "Voice turn cooldown — let the room answer first." });
    return;
  }
  const memberPendingKey = `${roomId}:${session.member.id}`;
  if ((pendingVoiceIngestsByMember.get(memberPendingKey) ?? 0) >= 2) {
    response.status(429).json({ ok: false, error: "Finish the voice turns already being transcribed before sending another." });
    return;
  }
  adjustCounter(pendingVoiceIngestsByMember, memberPendingKey, 1);
  adjustCounter(pendingVoiceIngestsByRoom, roomId, 1);
  const speechAbort = new AbortController();
  let releaseIngest: VoiceIngestRelease | undefined;
  let releaseRoomIngest: VoiceIngestRelease | undefined;
  let queueTimedOut = false;
  const queueTimeout = setTimeout(() => {
    queueTimedOut = true;
    speechAbort.abort(new Error("Voice transcription queue timed out"));
  }, VOICE_QUEUE_TIMEOUT_MS);
  queueTimeout.unref();
  const roomIngestGate = voiceIngestGateForRoom(roomId);
  const abortSpeech = () => speechAbort.abort(new Error("Voice upload connection closed"));
  const abortOnEarlyResponseClose = () => {
    if (!response.writableEnded) abortSpeech();
  };
  request.once("aborted", abortSpeech);
  response.once("close", abortOnEarlyResponseClose);
  try {
    releaseRoomIngest = await roomIngestGate.acquire(speechAbort.signal);
    releaseIngest = await voiceIngestGate.acquire(speechAbort.signal);
    clearTimeout(queueTimeout);
    if (!voiceRooms.isMemberInRoom(roomId, session.member.id)) {
      throw new VoiceSpeechError("That voice room closed before this turn could be transcribed.", 409, "ROOM_CLOSED");
    }
    const form = await parseVoiceTurnForm(request);
    const now = Date.now();
    for (const [key, completed] of completedVoiceTurns) {
      if (completed.expiresAt <= now) completedVoiceTurns.delete(key);
    }
    const completedKey = form.utteranceId ? `${roomId}:${session.member.id}:${form.utteranceId}` : undefined;
    const previous = completedKey ? completedVoiceTurns.get(completedKey) : undefined;
    if (previous) {
      response.status(200).json({ ok: true, text: previous.entry.text, entry: previous.entry, deduplicated: true });
      return;
    }
    const transcript = await voiceSpeech.transcribe({ audio: form.audio, mimeType: form.mimeType, signal: speechAbort.signal });
    const appended = voiceRooms.appendFinalTranscript(roomId, session.member.id, transcript.text, {
      utteranceOrigin: "microphone-stt",
      ...(transcript.language ? { language: transcript.language } : {}),
    });
    if (!appended.ok) throw new VoiceSpeechError(appended.error, 409, appended.code);
    if (completedKey) completedVoiceTurns.set(completedKey, { expiresAt: now + VOICE_TURN_DEDUP_TTL_MS, entry: appended.entry });
    io.to(voiceSocketRoom(roomId)).emit("voice:transcript:final", appended.entry);
    const room = voiceRooms.getRoom(roomId);
    if (room) director.noteHumanVoiceActivity(room.channelId);
    voiceDirector.onHumanFinal(appended.entry);
    response.status(201).json({ ok: true, text: appended.entry.text, entry: appended.entry });
  } catch (error) {
    const normalized = error instanceof VoiceIngestGateError
      ? new VoiceSpeechError(
          error.code === "QUEUE_FULL"
            ? "The transcription queue is full. Pause for a moment and try again."
            : queueTimedOut ? "The transcription queue took too long. Try that turn again." : "The voice upload was interrupted.",
          error.code === "QUEUE_FULL" || queueTimedOut ? 503 : 400,
          error.code,
        )
      : error;
    if (!request.readableEnded && !request.destroyed) request.resume();
    const status = normalized instanceof VoiceSpeechError ? normalized.status : 400;
    response.status(status).json({ ok: false, error: normalized instanceof Error ? normalized.message : "That voice turn could not be transcribed." });
  } finally {
    clearTimeout(queueTimeout);
    releaseIngest?.();
    releaseRoomIngest?.();
    adjustCounter(pendingVoiceIngestsByRoom, roomId, -1);
    adjustCounter(pendingVoiceIngestsByMember, memberPendingKey, -1);
    if (roomIngestGate.activeCount === 0 && roomIngestGate.queuedCount === 0) voiceIngestGatesByRoom.delete(roomId);
    request.removeListener("aborted", abortSpeech);
    response.removeListener("close", abortOnEarlyResponseClose);
  }
});

app.get("/api/images/:imageId", async (request, response) => {
  if (!sessionFromRequest(request)) {
    response.status(401).json({ ok: false, error: "Join the room to view shared images." });
    return;
  }
  const image = await imageStore.read(request.params.imageId, request.query.variant === "thumbnail");
  if (!image) {
    response.status(404).json({ ok: false, error: "That image is no longer available." });
    return;
  }
  response.setHeader("Content-Type", "image/webp");
  response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Disposition", "inline");
  response.send(image);
});

app.post("/api/channels/:channelId/image-messages", async (request, response) => {
  const session = sessionFromRequest(request);
  if (!session) {
    response.status(401).json({ ok: false, error: "Join the room before sharing an image." } satisfies ImageMessageResult);
    return;
  }
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "That upload origin is not allowed." } satisfies ImageMessageResult);
    return;
  }
  if (!session.imageBucket.take()) {
    response.status(429).json({ ok: false, error: "Image cooldown — give the room a moment." } satisfies ImageMessageResult);
    return;
  }
  if (activeImageIngests >= MAX_CONCURRENT_IMAGE_INGESTS) {
    response
      .status(503)
      .json({ ok: false, error: "The image desk is busy — try again in a moment." } satisfies ImageMessageResult);
    return;
  }
  const channelId = request.params.channelId;
  if (!CHANNELS.some((channel) => channel.id === channelId)) {
    response.status(404).json({ ok: false, error: "That public channel does not exist." } satisfies ImageMessageResult);
    return;
  }

  let attachmentId: string | undefined;
  activeImageIngests += 1;
  try {
    const form = await parseImageMessageForm(request);
    const content = stripDangerousTextControls(form.content).trim();
    if (content.length > 500) throw new ImageStoreError("Captions can be up to 500 characters.");
    if (form.replyToId && form.replyToId.length > 100) throw new ImageStoreError("That reply target is invalid.");
    if (form.imageUrl && form.imageUrl.length > 2_048) throw new ImageStoreError("That image URL is too long.");
    if (Boolean(form.file) === Boolean(form.imageUrl)) {
      throw new ImageStoreError("Attach exactly one uploaded image or direct HTTPS image URL.");
    }
    const replied = form.replyToId ? store.getMessage(form.replyToId) : undefined;
    if (form.replyToId && (!replied || replied.channelId !== channelId)) {
      throw new ImageStoreError("That reply target is no longer available in this channel.");
    }

    const input = form.file ?? (form.imageUrl ? await fetchRemoteImage(form.imageUrl) : undefined);
    if (!input) throw new ImageStoreError("Choose an image to share.");
    const attachment = await imageStore.create(input.body, "mimeType" in input ? input.mimeType : input.contentType);
    attachmentId = attachment.id;
    const message = createMessage(channelId, session.member.id, content, {
      replyToId: form.replyToId,
      ...(replied ? { replyPreview: replyPreviewFor(replied) } : {}),
      authorSnapshot: { ...session.member, status: "offline" },
      attachments: [attachment],
    });
    store.addPublicMessage(message);
    io.to("public").emit("message:new", message);
    if (message.content) humanMemory.notePublicMessage(session.member.id, message.channelId, message.content);
    director.onHumanImagePosted(message);
    analyzeImageMessage(message, session.member);
    response.status(201).json({ ok: true, message } satisfies ImageMessageResult);
  } catch (error) {
    if (attachmentId) await imageStore.remove(attachmentId);
    const status = error instanceof ImageStoreError ? error.status : 400;
    const message = error instanceof Error ? error.message : "That image could not be shared.";
    response.status(status).json({ ok: false, error: message } satisfies ImageMessageResult);
  } finally {
    activeImageIngests -= 1;
  }
});

app.get("/api/preview", (_request, response) => {
  const preview: PublicPreview = {
    members: getMembers().filter((member) => member.kind === "ai" || member.status === "online"),
    channels: CHANNELS,
    messages: CHANNELS.flatMap((channel) => store.getRecent(channel.id, 15))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((message) =>
        message.attachments?.length
          ? { ...message, content: message.content || "Shared an image — join to view", attachments: undefined }
          : message,
      ),
    inviteRequired: Boolean(INVITE_CODE),
    health: getHealth(),
  };
  response.json(preview);
});

app.get("/api/health", (_request, response) => response.json(getHealth()));

app.get("/api/channels/:channelId/messages", (request, response) => {
  const session = sessionFromRequest(request);
  if (!session) {
    response.status(401).json({ ok: false, error: "Join the room to load history." });
    return;
  }
  if (!session.historyBucket.take()) {
    response.status(429).json({ ok: false, error: "History is loading too quickly. Try again in a moment." });
    return;
  }
  const channelId = request.params.channelId;
  if (!CHANNELS.some((channel) => channel.id === channelId)) {
    response.status(404).json({ ok: false, error: "That channel does not exist." });
    return;
  }
  const beforeRaw = typeof request.query.before === "string" ? request.query.before : undefined;
  if (beforeRaw && beforeRaw.length > 256) {
    response.status(400).json({ ok: false, error: "Invalid history cursor." });
    return;
  }
  const before = decodeHistoryCursor(beforeRaw);
  if (beforeRaw && !before) {
    response.status(400).json({ ok: false, error: "Invalid history cursor." });
    return;
  }
  const requestedLimit = typeof request.query.limit === "string" ? Number.parseInt(request.query.limit, 10) : 40;
  const limit = Number.isFinite(requestedLimit) ? Math.max(20, Math.min(80, requestedLimit)) : 40;
  response.json({ ok: true, page: historyPageFor(channelId, before, limit) });
});

app.get("/api/session", (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  const authenticated = authenticatedSessionFromRequest(request);
  if (!authenticated) {
    response.status(401).json({ ok: false });
    return;
  }
  authenticated.session.lastSeenAt = Date.now();
  humanMemory.noteSeen(authenticated.session.member.id, authenticated.session.lastSeenAt);
  setSessionCookie(request, response, authenticated.token);
  response.json({ ok: true, me: authenticated.session.member });
});

app.get("/api/session/memory", (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  const authenticated = authenticatedSessionFromRequest(request);
  if (!authenticated) {
    response.status(401).json({ ok: false, error: "Join the room to view your saved memory." });
    return;
  }
  authenticated.session.lastSeenAt = Date.now();
  humanMemory.noteSeen(authenticated.session.member.id, authenticated.session.lastSeenAt);
  setSessionCookie(request, response, authenticated.token);
  response.json({ ok: true, memory: humanMemory.clientSummary(authenticated.session.member.id) });
});

app.delete("/api/session/memory", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "This memory request did not come from the room." });
    return;
  }
  const authenticated = authenticatedSessionFromRequest(request);
  if (!authenticated) {
    response.status(401).json({ ok: false, error: "Join the room before clearing saved memory." });
    return;
  }
  authenticated.session.lastSeenAt = Date.now();
  humanMemory.resetRememberedDetails(authenticated.session.member.id, authenticated.session.lastSeenAt);
  await humanMemory.flush();
  setSessionCookie(request, response, authenticated.token);
  response.json({ ok: true, memory: humanMemory.clientSummary(authenticated.session.member.id) });
});

app.post("/api/session", async (request, response) => {
  if (!allowJoinAttempt(clientIp(request))) {
    response.status(429).json({ ok: false, error: "Too many join attempts. Wait a few minutes and try again." });
    return;
  }
  const parsed = joinSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, error: "Choose a display name between 1 and 24 graphemes." });
    return;
  }
  if (INVITE_CODE && parsed.data.inviteCode !== INVITE_CODE) {
    response.status(403).json({ ok: false, error: "That invite code doesn't open this room." });
    return;
  }

  const name = normalizeDisplayName(parsed.data.name);
  if (!validDisplayName(name)) {
    response.status(400).json({ ok: false, error: "Use 1–24 letters, numbers, spaces, dots, dashes or underscores." });
    return;
  }
  if (adminState.isBanned(undefined, name)) {
    response.status(403).json({ ok: false, error: "That identity is banned from this room." });
    return;
  }
  if (adminModeration.isKicked(undefined, name)) {
    response.status(429).json({ ok: false, error: "That identity is on a short reconnect cooldown." });
    return;
  }
  const reserved = new Set([
    ...PERSONAS.map((persona) => safeNameKey(persona.name)),
    ...humanMemory.listRestorableProfiles().map((profile) => safeNameKey(profile.member.name)),
  ]);
  if (reserved.has(safeNameKey(name))) {
    response.status(409).json({ ok: false, error: "That name is already in the room. Try a small variation." });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const avatar = randomAvatar();
  avatar.glyph = displayNameGlyph(name);
  const session = createHumanSession(tokenHash, {
    id: `human-${randomUUID()}`,
    name,
    kind: "human",
    status: "offline",
    avatar,
    role: "Guest",
    bio: "A real person visiting The Third Place.",
  });
  sessions.set(tokenHash, session);
  humanMemory.upsertSession({ tokenHash, member: session.member, seenAt: session.lastSeenAt });
  synchronizeOfflineSessionsWithMemory();
  try {
    await humanMemory.flush();
  } catch (error) {
    sessions.delete(tokenHash);
    humanMemory.forgetProfile(session.member.id);
    throw error;
  }
  setSessionCookie(request, response, token);
  response.status(201).json({ ok: true, me: session.member });
});

io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
  const session = token ? sessions.get(hashToken(token)) : undefined;
  if (!session) {
    next(new Error("AUTH_REQUIRED"));
    return;
  }
  if (adminState.isBanned(session.member.id, session.member.name)) {
    next(new Error("BANNED"));
    return;
  }
  if (adminModeration.isKicked(session.member.id, session.member.name)) {
    next(new Error("KICK_COOLDOWN"));
    return;
  }
  socket.data.sessionHash = session.tokenHash;
  next();
});

io.on("connection", (socket) => {
  const session = sessions.get(socket.data.sessionHash as string);
  if (!session) return socket.disconnect(true);
  const wasOffline = session.socketIds.size === 0;
  session.socketIds.add(socket.id);
  session.member.status = "online";
  session.lastSeenAt = Date.now();
  humanMemory.noteSeen(session.member.id, session.lastSeenAt);
  socket.join("public");
  socket.join(`user:${session.member.id}`);
  socketBuckets.set(socket.id, {
    messages: new TokenBucket(5, 0.45),
    reactions: new TokenBucket(12, 1.6),
    typing: new TokenBucket(8, 2),
    voiceActions: new TokenBucket(12, 1),
    voiceSignals: new TokenBucket(120, 40),
  });

  socket.emit("room:snapshot", snapshotFor(session));
  socket.emit("voice:rooms:update", voiceRooms.listRooms());
  io.to("public").emit("presence:update", { members: getMembers() });

  if (wasOffline) {
    const visit = humanMemory.noteVisit(session.member.id, session.lastSeenAt);
    // A tab refresh or brief network reconnect is transport recovery, not a
    // social arrival. Only a first visit or a genuinely later return gets a
    // room event and one light welcome.
    if (!visit || visit.counted) {
      const joinMessage = createMessage(
        "lobby",
        "system",
        visit?.returning ? `${session.member.name} came back` : `${session.member.name} joined the room`,
        { system: true },
      );
      store.addPublicMessage(joinMessage);
      io.to("public").emit("message:new", joinMessage);
      void director.welcome(session.member, {
        returning: visit?.returning ?? false,
        languageHint: preferredRequestLanguage(socket.handshake.headers["accept-language"]),
      });
    }
  }

  const voiceFailure = (error: string): VoiceCreateResult => ({ ok: false, code: "NOT_AUTHORIZED", error });
  const joinedVoiceIdentity = () => ({
    socketId: socket.id,
    memberId: session.member.id,
    name: session.member.name,
  });
  const leaveVoiceRoom = (): VoiceLeaveResult => {
    const existing = voiceRooms.getRoomForSocket(socket.id);
    const result = voiceRooms.leaveRoom(socket.id);
    if (!result.ok) return result;
    if (existing) void socket.leave(voiceSocketRoom(existing.id));
    if (result.closed) {
      voiceDirector.forgetRoom(result.roomId);
      forgetVoiceIngestRoom(result.roomId);
      voiceSpeech.audioStore.deleteRoom(result.roomId);
      io.to(voiceSocketRoom(result.roomId)).emit("voice:room:closed", { roomId: result.roomId });
      publishVoiceRooms();
    } else {
      publishVoiceRoom(result.room);
    }
    return result;
  };

  socket.on("voice:room:create", (raw: unknown, acknowledge?: (result: VoiceCreateResult) => void) => {
    if (!VOICE_ENABLED) {
      acknowledge?.(voiceFailure("Voice rooms are disabled on this server."));
      return;
    }
    if (!socketBuckets.get(socket.id)?.voiceActions.take()) {
      acknowledge?.(voiceFailure("Voice controls are moving too quickly. Give it a moment."));
      return;
    }
    const parsed = voiceCreateSchema.safeParse(raw);
    if (!parsed.success) {
      acknowledge?.(voiceFailure("Choose a valid public channel for voice."));
      return;
    }
    const result = voiceRooms.createRoom(parsed.data.channelId, joinedVoiceIdentity());
    if (result.ok) {
      void socket.join(voiceSocketRoom(result.room.id));
      publishVoiceRoom(result.room);
      socket.emit("voice:transcript:history", voiceRooms.getTranscript(result.room.id));
    }
    acknowledge?.(result);
  });

  socket.on("voice:room:join", (raw: unknown, acknowledge?: (result: VoiceJoinResult) => void) => {
    if (!VOICE_ENABLED) {
      acknowledge?.(voiceFailure("Voice rooms are disabled on this server."));
      return;
    }
    if (!socketBuckets.get(socket.id)?.voiceActions.take()) {
      acknowledge?.(voiceFailure("Voice controls are moving too quickly. Give it a moment."));
      return;
    }
    const parsed = voiceRoomIdSchema.safeParse(raw);
    if (!parsed.success) {
      acknowledge?.(voiceFailure("That voice room is invalid."));
      return;
    }
    const alreadyOnSocket = voiceRooms.getRoomForSocket(socket.id);
    let result: VoiceJoinResult;
    if (alreadyOnSocket?.id === parsed.data.roomId) {
      result = { ok: true, room: alreadyOnSocket, capabilities: voiceRooms.capabilities() };
    } else {
      const existingMemberRoom = voiceRooms.getRoomForMember(session.member.id);
      const oldSocketId = existingMemberRoom?.id === parsed.data.roomId
        ? voiceRooms.getSocketIdForMember(parsed.data.roomId, session.member.id)
        : undefined;
      result = oldSocketId && !io.sockets.sockets.has(oldSocketId)
        ? voiceRooms.rebindHumanSocket(parsed.data.roomId, session.member.id, socket.id)
        : voiceRooms.joinRoom(parsed.data.roomId, joinedVoiceIdentity());
    }
    if (result.ok) {
      void socket.join(voiceSocketRoom(result.room.id));
      publishVoiceRoom(result.room);
      socket.emit("voice:transcript:history", voiceRooms.getTranscript(result.room.id));
    }
    acknowledge?.(result);
  });

  socket.on("voice:room:leave", (raw: unknown, acknowledge?: (result: VoiceLeaveResult) => void) => {
    const parsed = voiceRoomIdSchema.safeParse(raw);
    const current = voiceRooms.getRoomForSocket(socket.id);
    if (!parsed.success || !current || current.id !== parsed.data.roomId) {
      acknowledge?.({ ok: false, code: "NOT_IN_ROOM", error: "You are not in that voice room." });
      return;
    }
    acknowledge?.(leaveVoiceRoom());
  });

  socket.on("voice:self-state", (raw: unknown, acknowledge?: (result: VoiceInviteBotResult) => void) => {
    if (!socketBuckets.get(socket.id)?.voiceActions.take(0.25)) return;
    const parsed = voiceStateSchema.safeParse(raw);
    if (!parsed.success) {
      acknowledge?.({ ok: false, code: "NOT_AUTHORIZED", error: "That voice state is invalid." });
      return;
    }
    const wasSpeaking = voiceRooms.getRoom(parsed.data.roomId)?.participants
      .find((participant) => participant.memberId === session.member.id)?.speaking ?? false;
    const result = voiceRooms.setHumanState(parsed.data.roomId, socket.id, parsed.data);
    if (result.ok) {
      publishVoiceRoom(result.room);
      const isSpeakingNow = result.room.participants.find(
        (participant) => participant.memberId === session.member.id,
      )?.speaking ?? false;
      if (parsed.data.speaking === true && !wasSpeaking && isSpeakingNow) {
        voiceDirector.onHumanSpeechStarted(parsed.data.roomId);
        director.noteHumanVoiceActivity(result.room.channelId);
      }
    }
    acknowledge?.(result);
  });

  socket.on("voice:signal", (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
    if (!socketBuckets.get(socket.id)?.voiceSignals.take()) {
      acknowledge?.({ ok: false, error: "Voice signaling rate limit reached." });
      return;
    }
    const result = voiceRooms.routeSignal(socket.id, raw);
    if (!result.ok) {
      acknowledge?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.targetSocketId).emit("voice:signal", result.forward);
    acknowledge?.({ ok: true });
  });

  socket.on("voice:bot:invite", (raw: unknown, acknowledge?: (result: VoiceInviteBotResult) => void) => {
    if (!socketBuckets.get(socket.id)?.voiceActions.take(2)) {
      acknowledge?.({ ok: false, code: "NOT_AUTHORIZED", error: "Wait a moment before changing the AI guests." });
      return;
    }
    const parsed = voiceBotSchema.safeParse(raw);
    const persona = parsed.success ? PERSONAS.find((candidate) => candidate.id === parsed.data.personaId) : undefined;
    if (!parsed.success || !persona) {
      acknowledge?.({ ok: false, code: "TARGET_NOT_FOUND", error: "That AI resident is not available." });
      return;
    }
    let result = voiceRooms.inviteBot(parsed.data.roomId, socket.id, { personaId: persona.id, name: persona.name });
    if (result.ok) result = voiceRooms.setBotState(parsed.data.roomId, persona.id, "listening");
    if (result.ok) {
      voiceDirector.invalidateRoom(parsed.data.roomId);
      publishVoiceRoom(result.room);
    }
    acknowledge?.(result);
  });

  socket.on("voice:bot:remove", (raw: unknown, acknowledge?: (result: VoiceInviteBotResult) => void) => {
    if (!socketBuckets.get(socket.id)?.voiceActions.take(2)) return;
    const parsed = voiceBotSchema.safeParse(raw);
    if (!parsed.success) {
      acknowledge?.({ ok: false, code: "TARGET_NOT_FOUND", error: "That AI resident is invalid." });
      return;
    }
    const result = voiceRooms.removeBot(parsed.data.roomId, socket.id, parsed.data.personaId);
    if (result.ok) {
      voiceDirector.invalidateRoom(parsed.data.roomId);
      publishVoiceRoom(result.room);
    }
    acknowledge?.(result);
  });

  socket.on("voice:text-turn", (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
    if (!socketBuckets.get(socket.id)?.voiceActions.take() || !session.voiceBucket.take(0.5)) {
      acknowledge?.({ ok: false, error: "Voice turn cooldown — let the room answer first." });
      return;
    }
    const parsed = voiceTextTurnSchema.safeParse(raw);
    if (!parsed.success || !voiceRooms.isMemberInRoom(parsed.data.roomId, session.member.id)) {
      acknowledge?.({ ok: false, error: "Join that voice room before speaking to its AI residents." });
      return;
    }
    const appended = voiceRooms.appendFinalTranscript(parsed.data.roomId, session.member.id, parsed.data.text, {
      utteranceOrigin: "typed-voice-fallback",
    });
    if (!appended.ok) {
      acknowledge?.({ ok: false, error: appended.error });
      return;
    }
    io.to(voiceSocketRoom(parsed.data.roomId)).emit("voice:transcript:final", appended.entry);
    const room = voiceRooms.getRoom(parsed.data.roomId);
    if (room) director.noteHumanVoiceActivity(room.channelId);
    voiceDirector.onHumanFinal(appended.entry);
    acknowledge?.({ ok: true });
  });

  socket.on("message:send", (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
    const bucket = socketBuckets.get(socket.id)?.messages;
    if (!bucket?.take()) {
      acknowledge?.({ ok: false, error: "Slow down for a moment — the room is listening." });
      return;
    }
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) {
      acknowledge?.({ ok: false, error: "Messages can be up to 500 characters." });
      return;
    }
    const content = stripDangerousTextControls(parsed.data.content).trim();
    if (!content) {
      acknowledge?.({ ok: false, error: "That message came through empty." });
      return;
    }

    if (CHANNELS.some((channel) => channel.id === parsed.data.channelId)) {
      const replied = parsed.data.replyToId ? store.getMessage(parsed.data.replyToId) : undefined;
      if (parsed.data.replyToId && (!replied || replied.channelId !== parsed.data.channelId)) {
        acknowledge?.({ ok: false, error: "That reply target is no longer available in this channel." });
        return;
      }
      const message = createMessage(parsed.data.channelId, session.member.id, content, {
        replyToId: parsed.data.replyToId,
        ...(replied ? { replyPreview: replyPreviewFor(replied) } : {}),
        // Current presence comes from the live member map. The persisted
        // fallback must never show a stale green dot after the guest leaves.
        authorSnapshot: { ...session.member, status: "offline" },
      });
      store.addPublicMessage(message);
      io.to("public").emit("message:new", message);
      attachLinkPreview(message, session.member.id);
      humanMemory.notePublicMessage(session.member.id, message.channelId, message.content);
      director.onHumanMessage(message, session.member);
      acknowledge?.({ ok: true });
      return;
    }

    const participants = store.getDmParticipants(parsed.data.channelId);
    if (!participants?.includes(session.member.id)) {
      acknowledge?.({ ok: false, error: "That private conversation isn't available." });
      return;
    }
    const message = store.addDmMessage(parsed.data.channelId, session.member.id, content, parsed.data.replyToId);
    if (!message) {
      acknowledge?.({ ok: false, error: "Could not send that private message." });
      return;
    }
    emitDmUpdate(participants, message);
    const peerId = participants.find((id) => id !== session.member.id);
    const persona = PERSONAS.find((candidate) => candidate.id === peerId);
    if (persona) void director.onDirectMessage(message, session.member, persona);
    acknowledge?.({ ok: true });
  });

  socket.on("dm:open", (raw: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = z.object({ peerId: z.string().min(1).max(100) }).safeParse(raw);
    const peer = parsed.success ? getMembers().find((member) => member.id === parsed.data.peerId) : undefined;
    if (!peer || peer.id === session.member.id || peer.status === "offline") {
      acknowledge?.({ ok: false, error: "That person isn't available for a private chat." });
      return;
    }
    acknowledge?.({ ok: true, thread: store.openDm(session.member.id, peer.id) });
  });

  socket.on("reaction:toggle", (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
    if (!socketBuckets.get(socket.id)?.reactions.take()) {
      acknowledge?.({ ok: false, error: "Reaction cooldown — one beat." });
      return;
    }
    const parsed = reactionSchema.safeParse(raw);
    if (!parsed.success || !isPublicReactionEmoji(parsed.data.emoji)) {
      acknowledge?.({ ok: false, error: "That reaction isn't available." });
      return;
    }
    const reaction = store.togglePublicReaction(
      parsed.data.channelId,
      parsed.data.messageId,
      parsed.data.emoji,
      session.member.id,
    );
    if (!reaction) {
      acknowledge?.({ ok: false, error: "That message is no longer available." });
      return;
    }
    io.to("public").emit("reaction:update", {
      channelId: parsed.data.channelId,
      messageId: parsed.data.messageId,
      reaction,
    });
    if (reaction.memberIds.includes(session.member.id)) {
      director.onHumanReaction({
        channelId: parsed.data.channelId,
        messageId: parsed.data.messageId,
        emoji: parsed.data.emoji,
      }, session.member);
    }
    acknowledge?.({ ok: true });
  });

  socket.on("typing:set", (raw: unknown) => {
    if (!socketBuckets.get(socket.id)?.typing.take(0.25)) return;
    const parsed = z.object({ channelId: z.string().max(160), active: z.boolean() }).safeParse(raw);
    if (!parsed.success) return;
    const payload = { channelId: parsed.data.channelId, memberId: session.member.id, active: parsed.data.active };
    if (CHANNELS.some((channel) => channel.id === parsed.data.channelId)) {
      socket.to("public").emit("typing:member", payload);
      return;
    }
    const participants = store.getDmParticipants(parsed.data.channelId);
    const peerId = participants?.find((id) => id !== session.member.id);
    if (peerId) socket.to(`user:${peerId}`).emit("typing:member", payload);
  });

  socket.on("message:report", (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
    const parsed = z.object({ messageId: z.string().max(100), reason: z.string().max(120).optional() }).safeParse(raw);
    if (!parsed.success || !store.getMessage(parsed.data.messageId)) {
      acknowledge?.({ ok: false, error: "That message couldn't be reported." });
      return;
    }
    console.info("Simulated moderation report", { messageId: parsed.data.messageId, reporterId: session.member.id });
    socket.emit("toast", {
      tone: "success",
      title: "Sent to Runa",
      message: "This is an internal simulation report; nothing was sent outside the room.",
    });
    acknowledge?.({ ok: true });
  });

  socket.on("disconnect", () => {
    if (voiceRooms.getRoomForSocket(socket.id)) {
      const timer = setTimeout(() => {
        if (!io.sockets.sockets.has(socket.id) && voiceRooms.getRoomForSocket(socket.id)) leaveVoiceRoom();
      }, VOICE_RECONNECT_GRACE_MS);
      timer.unref();
    }
    socketBuckets.delete(socket.id);
    session.socketIds.delete(socket.id);
    session.lastSeenAt = Date.now();
    humanMemory.noteSeen(session.member.id, session.lastSeenAt);
    if (session.socketIds.size === 0) session.member.status = "offline";
    io.to("public").emit("presence:update", { members: getMembers() });
  });
});

function emitDmUpdate(participants: [string, string], message: ChatMessage): void {
  for (const viewerId of participants) {
    const peerId = participants.find((id) => id !== viewerId);
    if (!peerId || viewerId.startsWith("ai-")) continue;
    io.to(`user:${viewerId}`).emit("dm:update", {
      thread: store.openDm(viewerId, peerId),
      message,
    });
  }
}

const distPath = resolve(process.cwd(), "dist");
if (existsSync(distPath)) {
  // This is a fast-moving live demo: always let reloads pick up the newest
  // hashed asset manifest instead of holding an old index page for an hour.
  installSpaHosting(app, distPath);
}

app.use((error: unknown, request: Request, response: Response, _next: unknown) => {
  const metadata = error as { type?: unknown; status?: unknown };
  const malformedJson = metadata.type === "entity.parse.failed";
  const bodyTooLarge = metadata.type === "entity.too.large" || metadata.status === 413;
  const adminRequest = request.originalUrl.startsWith("/api/admin");
  if (adminRequest) {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Pragma", "no-cache");
  }
  if (adminRequest || malformedJson || bodyTooLarge) {
    // Body-parser errors can carry the raw malformed JSON in `error.body`.
    // Never hand that object to a logger on the credential boundary.
    console.error("Admin request failed safely.", {
      type: malformedJson ? "malformed-json" : bodyTooLarge ? "body-too-large" : "internal",
      status: typeof metadata.status === "number" ? metadata.status : undefined,
    });
  } else {
    console.error(error);
  }
  response.status(bodyTooLarge ? 413 : malformedJson ? 400 : 500).json({
    ok: false,
    error: bodyTooLarge
      ? "The request body is too large."
      : malformedJson
        ? "The request body is not valid JSON."
        : "The room tripped over a cable.",
  });
});

await humanMemory.load();
for (const profile of humanMemory.listRestorableProfiles()) {
  sessions.set(profile.tokenHash, createHumanSession(profile.tokenHash, profile.member, profile.lastSeenAt));
}
adminState.validateActiveCatalog();
await store.load();
await imageStore.initialize(store.getAllMessages());
store.onMessagesRemoved((removed) => {
  for (const message of removed) {
    for (const attachment of message.attachments ?? []) void imageStore.remove(attachment.id);
  }
});
for (const message of store.getAllMessages()) {
  for (const attachment of message.attachments ?? []) {
    if (attachment.analysis.status !== "pending") continue;
    const unavailable: ImageAnalysis = { status: "unavailable" };
    const updated = store.setImageAnalysis(message.channelId, message.id, attachment.id, unavailable);
    if (updated) imageStore.update(updated);
  }
}
actorChannels.restore(store.getAllMessages());
await lm.probe();
director.start();

const healthInterval = setInterval(async () => {
  const now = Date.now();
  for (const [tokenHash, session] of sessions) {
    if (session.socketIds.size > 0) {
      if (now - session.lastSeenAt >= SESSION_HEARTBEAT_MS) {
        session.lastSeenAt = now;
        humanMemory.noteSeen(session.member.id, now);
      }
      continue;
    }
    if (session.socketIds.size === 0 && now - session.lastSeenAt > SESSION_RETENTION_MS) {
      sessions.delete(tokenHash);
      humanMemory.forgetProfile(session.member.id);
      store.forgetDmParticipant(session.member.id);
    }
  }
  humanMemory.prune(now);
  adminAuth.prune(now);
  adminModeration.prune(now);
  synchronizeOfflineSessionsWithMemory();
  for (const [ip, timestamps] of joinAttempts) {
    const recent = timestamps.filter((timestamp) => now - timestamp < 10 * 60_000);
    if (recent.length > 0) joinAttempts.set(ip, recent);
    else joinAttempts.delete(ip);
  }
  try {
    await lm.probe();
  } catch (error) {
    console.warn("AI provider health probe was invalidated:", error instanceof Error ? error.message : error);
  }
  io.to("public").emit("health:update", getHealth());
}, 15_000);
healthInterval.unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`The Third Place is live on http://${HOST}:${PORT}`);
  console.log(`AI provider (${lm.activeProvider()}): ${lm.health().connected ? lm.health().id : "offline — model-driven replies are unavailable"}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal}: closing the room gracefully…`);
  clearInterval(healthInterval);
  director.stop();
  io.close();
  await Promise.all([
    store.flush(),
    humanMemory.flush(),
    ambientEpisodeLedger.flush(),
    adminState.flush(),
    modelProviders.close(),
  ]);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
