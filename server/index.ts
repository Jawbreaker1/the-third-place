import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
  LinkPreviewPayload,
  Member,
  HumanSessionIdentity,
  PresenceActivityPayload,
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
import { HUMAN_IDLE_AFTER_MS } from "../shared/presence.js";
import { AdminAuthManager } from "./adminAuth.js";
import { AccountStore, type AuthenticatedAccountSession } from "./accountStore.js";
import { AdminModerationGuard } from "./adminModeration.js";
import { createAdminRouter } from "./adminRouter.js";
import { AdminStateError, AdminStateStore } from "./adminState.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { ActorPublicationGate } from "./actorPublicationGate.js";
import { addressedPersonaIds, analyzeSocialSignals, SocialDirector } from "./director.js";
import { AmbientEpisodeLedger } from "./ambientEpisodeLedger.js";
import { LinkPreviewBroker } from "./linkPreviewBroker.js";
import { fetchRemoteImage, ImageStore, ImageStoreError } from "./imageStore.js";
import { planDmImageVision, startPlannedDmImageVision } from "./dmImagePolicy.js";
import {
  assertHumanMemoryContinuity,
  HUMAN_MEMORY_DEFAULTS,
  HumanMemoryStore,
  reconcilePendingActorForgets,
} from "./humanMemory.js";
import {
  generateHumanIdentityRecoveryKey,
  hashHumanIdentityRecoveryKey,
  normalizeHumanIdentityRecoveryKey,
} from "./humanIdentityRecovery.js";
import { HumanIdentityMutationCoordinator } from "./humanIdentityMutation.js";
import { HumanPresenceRuntime } from "./humanPresence.js";
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
import { SocialMemoryStore } from "./socialMemory.js";
import { SocialMemoryAdmin } from "./socialMemoryAdmin.js";
import { SocialMemoryCoordinator } from "./socialMemoryCoordinator.js";
import { SocialMemoryLifecycleManager } from "./socialMemoryLifecycle.js";
import { VoiceIngestGate, VoiceIngestGateError, type VoiceIngestRelease } from "./voiceIngestGate.js";
import { VoiceRoomRuntime } from "./voiceRooms.js";
import { VoiceSpeechError, VoiceSpeechService } from "./voiceSpeech.js";
import { parseCookieHeader } from "./cookies.js";
import { buildAdminHumanCatalog } from "./adminHumanCatalog.js";

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
  identityKind: HumanSessionIdentity["kind"];
  accountId?: string;
  accountSessionId?: string;
  expiresAt?: number;
  member: Member;
  socketIds: Set<string>;
  presence: HumanPresenceRuntime;
  /** Blocks HTTP and socket actions while a credential transfer commits. */
  revoked: boolean;
  lastSeenAt: number;
  createdAt: number;
  historyBucket: TokenBucket;
  imageBucket: TokenBucket;
  voiceBucket: TokenBucket;
}

interface HumanSessionCredential {
  kind: HumanSessionIdentity["kind"];
  accountId?: string;
  accountSessionId?: string;
  expiresAt?: number;
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
  identity: HumanSessionCredential = { kind: "legacy" },
): HumanSession => ({
  tokenHash,
  identityKind: identity.kind,
  ...(identity.accountId ? { accountId: identity.accountId } : {}),
  ...(identity.accountSessionId ? { accountSessionId: identity.accountSessionId } : {}),
  ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {}),
  member: { ...member, avatar: { ...member.avatar }, status: "offline" },
  socketIds: new Set(),
  presence: new HumanPresenceRuntime(HUMAN_IDLE_AFTER_MS),
  revoked: false,
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
const accountRegisterSchema = z.object({
  loginHandle: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
  inviteCode: z.string().max(100).optional(),
}).strict();
const accountLoginSchema = z.object({
  loginHandle: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
  inviteCode: z.string().max(100).optional(),
}).strict();
const accountUpgradeSchema = z.object({
  loginHandle: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
}).strict();
const accountDeleteSchema = z.object({
  password: z.string().min(1).max(1_024),
}).strict();
const recoverSessionSchema = z.object({
  name: z.string().min(1).max(128),
  recoveryKey: z.string().min(1).max(96),
  inviteCode: z.string().max(100).optional(),
  takeOver: z.boolean().optional(),
}).strict();
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
const presenceActivitySchema = z.object({
  visible: z.boolean(),
  active: z.boolean(),
}).strict();
const presenceHandshakeSchema = presenceActivitySchema;
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
const accountStore = new AccountStore();
const socialMemoryStore = new SocialMemoryStore({
  filePath: resolve(process.env.SOCIAL_MEMORY_PATH ?? "./data/social-memory.sqlite"),
});
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
let socialMemory!: SocialMemoryCoordinator;
const socialMemoryLifecycle = new SocialMemoryLifecycleManager(lm, socialMemoryStore, {
  onError: (error) => {
    console.warn(
      "Social memory lifecycle failed safely:",
      error instanceof Error ? error.message : error,
    );
  },
  onStateChanged: () => socialMemory?.invalidatePromptNotes(),
});
socialMemory = new SocialMemoryCoordinator(lm, socialMemoryStore, {
  onError: (error, episodeId) => {
    console.warn(
      `Social memory episode ${episodeId} failed safely:`,
      error instanceof Error ? error.message : error,
    );
  },
  lifecycle: socialMemoryLifecycle,
});
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
const protectedHumanActorIds = (...extraActorIds: string[]): Set<string> => new Set([
  ...accountStore.listAccounts().map((account) => account.actorId),
  ...extraActorIds,
  ...[...sessions.values()]
    .filter((session) => session.socketIds.size > 0 || session.revoked)
    .map((session) => session.member.id),
]);
const identityMutations = new HumanIdentityMutationCoordinator();
const actorPublicationGate = new ActorPublicationGate();
const isActiveHumanSession = (session: HumanSession): boolean =>
  sessions.get(session.tokenHash) === session &&
  !session.revoked &&
  (session.expiresAt === undefined || session.expiresAt > Date.now()) &&
  (session.identityKind !== "registered" || Boolean(
    session.accountId && session.accountSessionId &&
    accountStore.isSessionActive(session.accountId, session.accountSessionId)
  )) &&
  !adminState.isBanned(session.member.id, session.member.name) &&
  !adminModeration.isKicked(session.member.id, session.member.name);
let actorForgetReconciliationTail: Promise<unknown> = Promise.resolve();
const reconcilePendingHumanActorForgets = (): Promise<number> => {
  const operation = actorForgetReconciliationTail.then(async () => {
    const removedPrivateThreads: Array<{
      id: string;
      participantIds: [string, string];
      forgottenActorId: string;
    }> = [];
    return await reconcilePendingActorForgets(
      humanMemory,
      humanMemory.listPendingActorForgets(),
      {
        forgetActor: async (actorId) => {
          const account = accountStore.getAccountByActorId(actorId);
          if (account) await accountStore.deleteAccount(account.id);
          await socialMemory.forgetActor(actorId);
          const removed = store.forgetDmParticipant(actorId);
          removedPrivateThreads.push(...removed.map((thread) => ({
            id: thread.id,
            participantIds: thread.participantIds,
            forgottenActorId: actorId,
          })));
          await Promise.all(removed.flatMap((thread) => thread.messages).flatMap((message) =>
            (message.attachments ?? []).map((attachment) => imageStore.remove(attachment.id)),
          ));
        },
        flushDownstream: async () => {
          if (removedPrivateThreads.length > 0) await store.flush();
          for (const thread of removedPrivateThreads) {
            for (const participantId of thread.participantIds) {
              if (participantId === thread.forgottenActorId) continue;
              io.to(`user:${participantId}`).emit("dm:removed", { threadId: thread.id });
            }
          }
        },
      },
    );
  });
  // Serialize callers without letting one transient failure poison every later
  // health-cycle retry. Tombstones remain durable until a full attempt succeeds.
  actorForgetReconciliationTail = operation.then(() => undefined, () => undefined);
  return operation;
};
const synchronizeOfflineSessionsWithMemory = async (): Promise<void> => {
  const rememberedTokenHashes = new Set(humanMemory.listRestorableProfiles().map((profile) => profile.tokenHash));
  for (const [tokenHash, session] of sessions) {
    if (session.identityKind === "registered") {
      if (!accountStore.getAccountByActorId(session.member.id)) sessions.delete(tokenHash);
      continue;
    }
    if (session.socketIds.size > 0 || rememberedTokenHashes.has(tokenHash)) continue;
    sessions.delete(tokenHash);
    humanMemory.queuePendingActorForget(session.member.id);
  }
  await reconcilePendingHumanActorForgets();
};
const joinAttempts = new Map<string, number[]>();
const joinAttemptHashKey = randomBytes(32);
const JOIN_ATTEMPT_SOURCE_CAPACITY = 512;
const MAX_ACTIVE_ACCOUNT_CRYPTO = 2;
let activeAccountCrypto = 0;
type AccountCryptoAttempt<T> = { accepted: true; value: T } | { accepted: false };
const runAccountCrypto = async <T>(operation: () => Promise<T>): Promise<AccountCryptoAttempt<T>> => {
  if (activeAccountCrypto >= MAX_ACTIVE_ACCOUNT_CRYPTO) return { accepted: false };
  activeAccountCrypto += 1;
  try {
    return { accepted: true, value: await operation() };
  } finally {
    activeAccountCrypto -= 1;
  }
};
const recoveryAttempts = new Map<string, number[]>();
const recoveryIpAttempts = new Map<string, number[]>();
const selfRecoveryKeyRotations = new Map<string, number[]>();
const RECOVERY_ATTEMPT_WINDOW_MS = 15 * 60_000;
const SELF_RECOVERY_KEY_WINDOW_MS = 10 * 60_000;
const RECOVERY_ATTEMPT_MAX_KEYS = 5_000;
const socketBuckets = new Map<
  string,
  {
    messages: TokenBucket;
    reactions: TokenBucket;
    typing: TokenBucket;
    presence: TokenBucket;
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

const humanPresenceRank = (status: Member["status"]): number =>
  status === "online" ? 3 : status === "idle" ? 2 : status === "dnd" ? 1 : 0;
const getMembers = (): Member[] => {
  const humans = new Map<string, Member>();
  // A registered account is durable community membership, not a connection.
  // Keep it visible while offline without admitting legacy/guest profiles to
  // the member directory merely because they have old local memory.
  for (const account of accountStore.listAccounts()) {
    if (account.profileState !== "ready" || adminState.isBanned(account.actorId, account.displayName)) continue;
    const profile = humanMemory.findByHumanId(account.actorId);
    if (!profile) continue;
    humans.set(account.actorId, {
      ...profile.member,
      name: account.displayName,
      status: "offline",
      avatar: { ...profile.member.avatar },
    });
  }
  for (const session of sessions.values()) {
    if (!isActiveHumanSession(session) ||
        (session.identityKind !== "registered" && session.member.status === "offline")) continue;
    const current = humans.get(session.member.id);
    if (!current || humanPresenceRank(session.member.status) > humanPresenceRank(current.status)) {
      humans.set(session.member.id, { ...session.member, avatar: { ...session.member.avatar } });
    }
  }
  return [
    ...PERSONAS.map((persona) => ({ ...memberView(persona), activity: actorChannels.activityLabel(persona) })),
    ...humans.values(),
  ];
};
const replyPreviewFor = (message: ChatMessage) => ({
  authorId: message.authorId,
  authorName:
    getMembers().find((member) => member.id === message.authorId)?.name ??
    message.authorSnapshot?.name ??
    (message.system ? "room" : "someone"),
  content: (message.content || (message.attachments?.length ? "Shared an image" : "")).slice(0, 140),
});
const publicTurnTargetIds = (content: string, replyTarget?: ChatMessage): string[] =>
  addressedPersonaIds(analyzeSocialSignals(content).mentionedIds, replyTarget);
const countHumanActorsWith = (predicate: (session: HumanSession) => boolean): number =>
  new Set([...sessions.values()].filter(predicate).map((session) => session.member.id)).size;
const onlineHumanCount = () => countHumanActorsWith((session) => isActiveHumanSession(session) && session.member.status === "online");
const idleHumanCount = () => countHumanActorsWith((session) => isActiveHumanSession(session) && session.member.status === "idle");
const connectedHumanCount = () => countHumanActorsWith((session) => isActiveHumanSession(session) && session.socketIds.size > 0);
const refreshHumanPresence = (session: HumanSession, now = Date.now()): boolean => {
  const actorSessions = [...sessions.values()].filter((candidate) =>
    candidate.member.id === session.member.id && isActiveHumanSession(candidate)
  );
  const aggregate = actorSessions.reduce<Member["status"]>(
    (best, candidate) => {
      const raw = candidate.presence.status(now);
      return humanPresenceRank(raw) > humanPresenceRank(best)
        ? raw
        : best;
    },
    "offline",
  );
  let changed = false;
  for (const candidate of actorSessions) {
    if (candidate.member.status === aggregate) continue;
    candidate.member.status = aggregate;
    changed = true;
  }
  return changed;
};
const publishHumanPresenceIfChanged = (session: HumanSession, now = Date.now()): void => {
  if (refreshHumanPresence(session, now)) {
    io.to("public").emit("presence:update", { members: getMembers() });
  }
};
const getHealth = (): ServerHealth => ({
  ok: true,
  model: lm.health(),
  onlineHumans: onlineHumanCount(),
  idleHumans: idleHumanCount(),
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
  connectedHumanCount,
  {
    behaviorTuningProvider,
    marketSnapshotProvider,
    footballCompetitionProvider,
    marketPulseCoordinator,
    ambientEpisodeLedger,
    socialMemory,
  },
);

const voiceSocketRoom = (roomId: string) => `voice:${roomId}`;
const publishVoiceRooms = (): void => {
  const rooms = voiceRooms.listRooms();
  io.to("public").emit("voice:rooms:update", rooms);
  director.setActiveVoicePersonaIds(
    rooms.flatMap((room) => room.participants
      .filter((participant) => participant.kind === "ai")
      .map((participant) => participant.memberId)),
  );
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
  socialMemory,
  behaviorTuningProvider,
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
  // The browser has already observed a quiet boundary and the server has
  // accepted real speech. Start immediately; a later accepted human turn may
  // supersede this one, but an untrusted RMS hint never can.
  floorSilenceMs: 0,
  events: {
    roomChanged: publishVoiceRoom,
    transcriptFinal: (entry) => io.to(voiceSocketRoom(entry.roomId)).emit("voice:transcript:final", entry),
    aiSpeech: (payload) => io.to(voiceSocketRoom(payload.roomId)).emit("voice:ai-speech", payload),
    aiStop: (payload) => io.to(voiceSocketRoom(payload.roomId)).emit("voice:ai-stop", payload),
  },
});

type ImageAnalysisAudience =
  | { kind: "public"; isAuthorCurrent?: () => boolean }
  | {
    kind: "dm";
    participants: [string, string];
    completeDirectImage?: () => void;
  };

const analyzeImageMessage = (
  message: ChatMessage,
  human: Member,
  audience: ImageAnalysisAudience = { kind: "public" },
): void => {
  const attachment = message.attachments?.[0];
  if (!attachment) return;
  void (async () => {
    let analysis: ImageAnalysis = { status: "unavailable" };
    try {
      const image = await imageStore.read(attachment.id);
      if (!image) throw new Error("Sanitized image was unavailable");
      const observation = await lm.analyzeImage(image, message.content, 1);
      analysis = { status: "ready", observation };
    } catch (error) {
      console.warn("Image analysis unavailable:", error instanceof Error ? error.message : error);
    }
    const updated = store.setImageAnalysis(message.channelId, message.id, attachment.id, analysis);
    if (!updated) {
      if (audience.kind === "dm") audience.completeDirectImage?.();
      return;
    }
    imageStore.update(updated);
    const payload: ImageAnalysisPayload = {
      channelId: message.channelId,
      messageId: message.id,
      attachmentId: attachment.id,
      analysis,
    };
    if (audience.kind === "public") {
      io.to("public").emit("image-analysis:update", payload);
      if (audience.isAuthorCurrent && !audience.isAuthorCurrent()) return;
      director.onHumanImageReady(message, human, analysis.status === "ready" ? analysis.observation : undefined);
      return;
    }
    for (const participantId of audience.participants) {
      io.to(`user:${participantId}`).emit("image-analysis:update", payload);
    }
    audience.completeDirectImage?.();
  })().catch((error) => {
    console.warn("Image analysis finalization failed safely:", error instanceof Error ? error.message : error);
    if (audience.kind === "dm") audience.completeDirectImage?.();
  });
};

const hydrateRegisteredSession = (
  token: string,
  authenticated: AuthenticatedAccountSession,
): HumanSession | undefined => {
  const tokenHash = hashToken(token);
  const existing = sessions.get(tokenHash);
  if (existing) return existing;
  const profile = humanMemory.findByHumanId(authenticated.account.actorId);
  if (!profile) return undefined;
  const member: Member = {
    ...profile.member,
    name: authenticated.account.displayName,
    status: "offline",
    avatar: { ...profile.member.avatar },
  };
  const session = createHumanSession(
    tokenHash,
    member,
    Date.now(),
    Date.parse(authenticated.session.createdAt),
    {
      kind: "registered",
      accountId: authenticated.account.id,
      accountSessionId: authenticated.session.id,
      expiresAt: Date.parse(authenticated.session.expiresAt),
    },
  );
  sessions.set(tokenHash, session);
  return session;
};

const disconnectEvictedAccountSessions = (accountId: string): boolean => {
  let disconnected = false;
  for (const runtime of [...sessions.values()]) {
    if (runtime.identityKind !== "registered" || runtime.accountId !== accountId ||
        !runtime.accountSessionId || accountStore.isSessionActive(accountId, runtime.accountSessionId)) continue;
    runtime.revoked = true;
    for (const socketId of [...runtime.socketIds]) {
      const socket = io.sockets.sockets.get(socketId);
      socket?.emit("session:ended", { reason: "device-limit" });
      socket?.disconnect(true);
    }
    runtime.socketIds.clear();
    runtime.presence.clear();
    sessions.delete(runtime.tokenHash);
    disconnected = true;
  }
  return disconnected;
};

const sessionForToken = (token: string | undefined): HumanSession | undefined => {
  if (!token) return undefined;
  const tokenHash = hashToken(token);
  const runtime = sessions.get(tokenHash);
  if (runtime) return runtime;
  const authenticated = accountStore.authenticateSession(token);
  return authenticated ? hydrateRegisteredSession(token, authenticated) : undefined;
};

const sessionFromRequest = (request: Request): HumanSession | undefined => {
  const token = parseCookieHeader(request.headers.cookie)[SESSION_COOKIE];
  const session = sessionForToken(token);
  return session && isActiveHumanSession(session) ? session : undefined;
};

const authenticatedSessionFromRequest = (
  request: Request,
): { session: HumanSession; token: string } | undefined => {
  const token = parseCookieHeader(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return undefined;
  const session = sessionForToken(token);
  if (!session || !isActiveHumanSession(session)) return undefined;
  return { session, token };
};

const clientIp = (request: Request): string => {
  // Express derives this from the configured trusted-proxy hop. Never accept
  // vendor-specific forwarding headers directly from an untrusted caller.
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
  const sourceKey = createHmac("sha256", joinAttemptHashKey)
    .update((ip || "unknown").slice(0, 512), "utf8")
    .digest("hex");
  const existing = joinAttempts.get(sourceKey);
  if (!existing && joinAttempts.size >= JOIN_ATTEMPT_SOURCE_CAPACITY) {
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [key, timestamps] of joinAttempts) {
      const lastSeenAt = timestamps.at(-1) ?? 0;
      if (lastSeenAt < oldestTimestamp) {
        oldestKey = key;
        oldestTimestamp = lastSeenAt;
      }
    }
    if (oldestKey) joinAttempts.delete(oldestKey);
  }
  const recent = (existing ?? []).filter((timestamp) => now - timestamp < 10 * 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  joinAttempts.set(sourceKey, recent);
  return true;
};

const allowRecoveryAttempt = (ip: string, name: string): boolean => {
  const now = Date.now();
  // Keep only opaque, process-local limiter keys. A per-IP ceiling prevents a
  // source from bypassing the identity limit with unlimited invented names.
  const ipKey = hashToken(ip);
  const identityKey = hashToken(`${ip}\u0000${safeNameKey(name)}`);
  const recentIp = (recoveryIpAttempts.get(ipKey) ?? [])
    .filter((timestamp) => now - timestamp < RECOVERY_ATTEMPT_WINDOW_MS);
  const recentIdentity = (recoveryAttempts.get(identityKey) ?? [])
    .filter((timestamp) => now - timestamp < RECOVERY_ATTEMPT_WINDOW_MS);
  if (recentIp.length >= 24 || recentIdentity.length >= 5) return false;
  recentIp.push(now);
  recentIdentity.push(now);
  recoveryIpAttempts.set(ipKey, recentIp);
  recoveryAttempts.set(identityKey, recentIdentity);

  // The IP ceiling bounds ordinary abuse; this hard cap also bounds memory if
  // an attacker can present a very large number of source addresses.
  for (const attempts of [recoveryAttempts, recoveryIpAttempts]) {
    while (attempts.size > RECOVERY_ATTEMPT_MAX_KEYS) {
      const oldestKey = attempts.keys().next().value as string | undefined;
      if (!oldestKey) break;
      attempts.delete(oldestKey);
    }
  }
  return true;
};

const allowSelfRecoveryKeyRotation = (actorId: string): boolean => {
  const now = Date.now();
  const recent = (selfRecoveryKeyRotations.get(actorId) ?? [])
    .filter((timestamp) => now - timestamp < SELF_RECOVERY_KEY_WINDOW_MS);
  if (recent.length >= 2) return false;
  recent.push(now);
  selfRecoveryKeyRotations.set(actorId, recent);
  while (selfRecoveryKeyRotations.size > RECOVERY_ATTEMPT_MAX_KEYS) {
    const oldestKey = selfRecoveryKeyRotations.keys().next().value as string | undefined;
    if (!oldestKey) break;
    selfRecoveryKeyRotations.delete(oldestKey);
  }
  return true;
};

const snapshotFor = (session: HumanSession): RoomSnapshot => {
  const pages = CHANNELS.map((channel) => historyPageFor(channel.id));
  const account = session.accountId ? accountStore.getAccount(session.accountId) : undefined;
  return {
    me: { ...session.member },
    identity: {
      kind: session.identityKind,
      ...(account ? { loginHandle: account.loginHandle } : {}),
    },
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

const setSessionCookie = (
  request: Request,
  response: Response,
  token: string,
  maxAgeSeconds = SESSION_COOKIE_MAX_AGE_SECONDS,
): void => {
  const secure = request.secure || publicOrigin?.startsWith("https://");
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure ? "; Secure" : ""}`,
  );
};

const refreshSessionCookie = (
  request: Request,
  response: Response,
  token: string,
  session: HumanSession,
): void => {
  const remainingSeconds = session.expiresAt === undefined
    ? SESSION_COOKIE_MAX_AGE_SECONDS
    : Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1_000));
  setSessionCookie(request, response, token, remainingSeconds);
};

const clearSessionCookie = (request: Request, response: Response): void => {
  const secure = request.secure || publicOrigin?.startsWith("https://");
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
  );
};

const adminHumans = (): AdminHumanMember[] => buildAdminHumanCatalog({
  profiles: humanMemory.listProfiles(),
  visibleMembers: getMembers(),
  accounts: accountStore.listAccounts(),
  hasRecoveryKey: (actorId) => humanMemory.hasRecoveryKey(actorId),
});

const socialMemoryAdmin = new SocialMemoryAdmin({
  store: socialMemoryStore,
  onStateChanged: () => {
    socialMemory.invalidatePromptNotes();
    socialMemoryLifecycle.notifyMemoryChanged();
  },
  getActors: () => {
    const actors = new Map<string, { id: string; name: string; kind: "resident" | "human" }>();
    for (const persona of PERSONAS) {
      actors.set(persona.id, { id: persona.id, name: persona.name, kind: "resident" });
    }
    for (const profile of humanMemory.listProfiles()) {
      actors.set(profile.member.id, { id: profile.member.id, name: profile.member.name, kind: "human" });
    }
    for (const session of sessions.values()) {
      actors.set(session.member.id, { id: session.member.id, name: session.member.name, kind: "human" });
    }
    return [...actors.values()];
  },
});

const disconnectHumanSockets = (
  memberId: string,
  notice: { action: "kick" | "ban" | "forget" | "recover"; message: string },
): AdminHumanMember | undefined => {
  // Revoke every already-admitted async HTTP publication before touching
  // sockets or durable state. A slow upload retains its old lease and fails at
  // the commit boundary even if its fetch/decoder ignores cancellation.
  actorPublicationGate.invalidate(memberId);
  const matchingSessions = [...sessions.values()].filter((candidate) => candidate.member.id === memberId);
  const first = matchingSessions[0];
  if (!first) return undefined;
  for (const session of matchingSessions) {
    for (const socketId of [...session.socketIds]) {
      const socket = io.sockets.sockets.get(socketId);
      socket?.emit("session:moderated", {
        action: notice.action,
        message: notice.message,
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
          // Leaving changes the trusted participant set. Abort any reply or
          // social-memory capture built against the previous audience before
          // publishing the surviving room state.
          voiceDirector.invalidateRoom(voiceResult.room.id);
          publishVoiceRoom(voiceResult.room);
        }
      }
      socket?.disconnect(true);
    }
    // A socket id may already be absent from Socket.IO, in which case no
    // disconnect callback will clean the session set. Forced revocation owns
    // both registries and must leave neither stale liveness nor stale presence.
    session.socketIds.clear();
    session.presence.clear();
    session.member.status = "offline";
  }
  io.to("public").emit("presence:update", { members: getMembers() });
  return {
    id: first.member.id,
    name: first.member.name,
    status: first.member.status,
    joinedAt: new Date(first.createdAt).toISOString(),
  };
};

const disconnectModeratedHuman = (
  memberId: string,
  reason: string | undefined,
  reconnectCooldown: boolean,
): AdminHumanMember | undefined => {
  const session = [...sessions.values()].find((candidate) => candidate.member.id === memberId);
  if (!session) return undefined;
  if (reconnectCooldown) adminModeration.kick(session.member.id, session.member.name);
  store.cancelPendingPublicTurnsForActor(session.member.id);
  return disconnectHumanSockets(memberId, {
    action: reconnectCooldown ? "kick" : "ban",
    message: reason || (reconnectCooldown
      ? "You were removed from the room for a short cooldown."
      : "You were banned from this room."),
  });
};

const currentIdentitySessionMatches = (actorId: string, expectedTokenHash: string): boolean => {
  const runtime = sessions.get(expectedTokenHash);
  const durable = humanMemory.findByHumanId(actorId);
  return runtime?.member.id === actorId && !runtime.revoked && durable?.tokenHash === expectedTokenHash;
};

const forgetHumanActorUnlocked = async (actorId: string): Promise<boolean> => {
  if (PERSONAS.some((persona) => persona.id === actorId)) return false;
  const profile = humanMemory.findByHumanId(actorId);
  const runtimeSessions = [...sessions.entries()].filter(([, session]) => session.member.id === actorId);
  // Human erasure is authorized only by the trusted durable profile/session
  // catalog. Historical SQLite IDs never become humans through naming rules.
  if (!profile && runtimeSessions.length === 0) return false;
  const trustedMember = profile?.member ?? runtimeSessions[0]?.[1].member;
  if (!trustedMember) return false;

  // No await before all runtime publication paths are closed: the event loop
  // cannot accept another turn between cancellation, disconnect and token
  // eviction. Durable work begins only after the actor can no longer publish.
  director.cancelDirectTurnsForActor(actorId);
  // Public generations, reactions and human-rooted ambient work use an
  // actor-local gate. Self-retirement must never cancel somebody else's DM,
  // room reply or autonomous discussion.
  director.invalidatePublicWorkForHumanActor(actorId);
  disconnectHumanSockets(actorId, {
    action: "forget",
    message: "Your saved profile and private history were removed by an administrator. You may join again with a new identity.",
  });
  for (const [tokenHash] of runtimeSessions) sessions.delete(tokenHash);

  // Public history intentionally survives account retirement. Legacy rows may
  // predate author snapshots, so freeze the still-trusted profile and make
  // those snapshots durable *before* removing the profile or persisting its
  // tombstone. A crash in this window can safely restore the old profile; it
  // can never strand an unrenderable historical row without its last trusted
  // display metadata. Runtime publication was already revoked above.
  const frozenLegacyRows = store.freezePublicAuthorSnapshot(trustedMember);
  if (frozenLegacyRows > 0) await store.flush();

  if (profile) humanMemory.forgetProfile(actorId);
  else humanMemory.queuePendingActorForget(actorId);

  await reconcilePendingHumanActorForgets();
  io.to("public").emit("presence:update", { members: getMembers() });
  return true;
};

const forgetHumanActor = async (
  actorId: string,
  expectedTokenHash?: string,
): Promise<boolean> => await identityMutations.run(async () => {
  if (expectedTokenHash && !currentIdentitySessionMatches(actorId, expectedTokenHash)) return false;
  return await forgetHumanActorUnlocked(actorId);
});

type HumanRecoveryKeyIssueResult =
  | { status: "issued"; name: string; recoveryKey: string }
  | { status: "not_found" | "account_owned" | "session_changed" | "rate_limited" };

const issueHumanRecoveryKeyMutation = async (
  actorId: string,
  expectedTokenHash?: string,
  enforceSelfServiceLimit = false,
): Promise<HumanRecoveryKeyIssueResult> => {
  return await identityMutations.run(async () => {
    const current = humanMemory.findByHumanId(actorId);
    if (!current) return { status: "not_found" };
    if (!current.tokenHash) return { status: "account_owned" };
    if (expectedTokenHash && !currentIdentitySessionMatches(actorId, expectedTokenHash)) {
      return { status: "session_changed" };
    }
    // Charge only after the expected token is revalidated inside the identity
    // transaction. Stale requests queued before takeover cannot consume the
    // recovered owner's rotation allowance.
    if (enforceSelfServiceLimit && !allowSelfRecoveryKeyRotation(actorId)) {
      return { status: "rate_limited" };
    }
    const recoveryKey = generateHumanIdentityRecoveryKey();
    const recoveryKeyHash = hashHumanIdentityRecoveryKey(recoveryKey);
    const previousHash = humanMemory.replaceRecoveryKeyHash(actorId, recoveryKeyHash);
    try {
      await humanMemory.flush();
    } catch (error) {
      humanMemory.replaceRecoveryKeyHash(actorId, previousHash);
      await humanMemory.flush().catch(() => undefined);
      throw error;
    }
    return { status: "issued", name: current.member.name, recoveryKey };
  });
};

const issueHumanRecoveryKey = async (
  actorId: string,
): Promise<{ name: string; recoveryKey: string } | undefined> => {
  const result = await issueHumanRecoveryKeyMutation(actorId);
  return result.status === "issued"
    ? { name: result.name, recoveryKey: result.recoveryKey }
    : undefined;
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
    for (const profile of humanMemory.listProfiles()) {
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
  issueHumanRecoveryKey,
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
  socialMemory: socialMemoryAdmin,
  forgetHumanActor,
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
    // Silence and background noise are expected in hands-free mode. Treat a
    // rejected acoustic segment as a successful no-op: no transcript, no bot
    // trigger and no alarming error banner in the browser.
    if (normalized instanceof VoiceSpeechError && normalized.code === "NO_SPEECH") {
      response.status(200).json({ ok: true, ignored: true });
      return;
    }
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

type ImageMessageDestination =
  | { kind: "public"; channelId: string }
  | { kind: "dm"; threadId: string; participants: [string, string] };

const handleImageMessageUpload = async (
  request: Request,
  response: Response,
  session: HumanSession,
  destination: ImageMessageDestination,
): Promise<void> => {
  const publicationLease = actorPublicationGate.capture(session.member.id);
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "That upload origin is not allowed." } satisfies ImageMessageResult);
    return;
  }
  if (!session.imageBucket.take()) {
    response.status(429).json({ ok: false, error: "Image cooldown — give the conversation a moment." } satisfies ImageMessageResult);
    return;
  }
  if (activeImageIngests >= MAX_CONCURRENT_IMAGE_INGESTS) {
    response
      .status(503)
      .json({ ok: false, error: "The image desk is busy — try again in a moment." } satisfies ImageMessageResult);
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
    const conversationId = destination.kind === "public" ? destination.channelId : destination.threadId;
    const replied = form.replyToId
      ? destination.kind === "public"
        ? store.getMessage(form.replyToId)
        : store.getDmMessages(destination.threadId).find((message) => message.id === form.replyToId)
      : undefined;
    if (form.replyToId && (!replied || replied.channelId !== conversationId)) {
      throw new ImageStoreError("That reply target is no longer available in this conversation.");
    }

    const input = form.file ?? (form.imageUrl ? await fetchRemoteImage(form.imageUrl) : undefined);
    if (!input) throw new ImageStoreError("Choose an image to share.");
    const attachment = await imageStore.create(input.body, "mimeType" in input ? input.mimeType : input.contentType);
    attachmentId = attachment.id;
    if (!isActiveHumanSession(session) || !actorPublicationGate.isCurrent(publicationLease)) {
      throw new ImageStoreError("Your session ended before the image could be shared.", 401);
    }
    if (destination.kind === "public") {
      const message = createMessage(destination.channelId, session.member.id, content, {
        replyToId: form.replyToId,
        ...(replied ? { replyPreview: replyPreviewFor(replied) } : {}),
        authorSnapshot: { ...session.member, status: "offline" },
        attachments: [attachment],
      });
      const targetPersonaIds = publicTurnTargetIds(content, replied);
      if (targetPersonaIds.length > 0) {
        try {
          await store.addPublicMessageDurably(message, undefined, { targetPersonaIds });
        } catch (error) {
          console.error(
            "Could not durably accept a direct public image turn:",
            error instanceof Error ? error.message : error,
          );
          throw new ImageStoreError("That direct image could not be saved safely. Please try again.", 503);
        }
      } else {
        store.addPublicMessage(message);
      }
      attachmentId = undefined;
      io.to("public").emit("message:new", message);
      if (message.content) humanMemory.notePublicMessage(session.member.id, message.channelId, message.content);
      director.onHumanImagePosted(message);
      analyzeImageMessage(message, session.member, {
        kind: "public",
        isAuthorCurrent: () =>
          isActiveHumanSession(session) && actorPublicationGate.isCurrent(publicationLease),
      });
      response.status(201).json({ ok: true, message } satisfies ImageMessageResult);
      return;
    }

    const visionPlan = planDmImageVision(
      destination.participants,
      session.member.id,
      new Set(PERSONAS.map((persona) => persona.id)),
    );
    attachment.analysis = visionPlan.initialAnalysis;
    const message = store.addDmMessage(
      destination.threadId,
      session.member.id,
      content,
      form.replyToId,
      undefined,
      undefined,
      undefined,
      [attachment],
      { ...session.member, status: "offline" },
    );
    if (!message) throw new ImageStoreError("That private conversation is no longer available.", 404);
    attachmentId = undefined;
    emitDmUpdate(destination.participants, message);
    startPlannedDmImageVision(visionPlan, (residentId) => {
      const persona = PERSONAS.find((candidate) => candidate.id === residentId);
      if (!persona) return;
      const pendingDirectImage = director.onDirectImagePosted(message, session.member, persona);
      analyzeImageMessage(message, session.member, {
        kind: "dm",
        participants: destination.participants,
        completeDirectImage: pendingDirectImage.complete,
      });
    });
    response.status(201).json({ ok: true, message } satisfies ImageMessageResult);
  } catch (error) {
    if (attachmentId) await imageStore.remove(attachmentId);
    const status = error instanceof ImageStoreError ? error.status : 400;
    const message = error instanceof Error ? error.message : "That image could not be shared.";
    response.status(status).json({ ok: false, error: message } satisfies ImageMessageResult);
  } finally {
    activeImageIngests -= 1;
  }
};

app.get("/api/images/:imageId", async (request, response) => {
  const session = sessionFromRequest(request);
  if (!session) {
    response.status(401).json({ ok: false, error: "Join the room to view shared images." });
    return;
  }
  const visibility = store.imageAttachmentVisibilityFor(request.params.imageId, session.member.id);
  if (!visibility) {
    response.status(404).json({ ok: false, error: "That image is no longer available." });
    return;
  }
  const image = await imageStore.read(request.params.imageId, request.query.variant === "thumbnail");
  if (!image) {
    response.status(404).json({ ok: false, error: "That image is no longer available." });
    return;
  }
  response.setHeader("Content-Type", "image/webp");
  response.setHeader(
    "Cache-Control",
    visibility === "private" ? "private, no-store" : "private, max-age=31536000, immutable",
  );
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
  const channelId = request.params.channelId;
  if (!CHANNELS.some((channel) => channel.id === channelId)) {
    response.status(404).json({ ok: false, error: "That public channel does not exist." } satisfies ImageMessageResult);
    return;
  }
  await handleImageMessageUpload(request, response, session, { kind: "public", channelId });
});

app.post("/api/dms/:threadId/image-messages", async (request, response) => {
  const session = sessionFromRequest(request);
  if (!session) {
    response.status(401).json({ ok: false, error: "Join before sharing an image." } satisfies ImageMessageResult);
    return;
  }
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "That upload origin is not allowed." } satisfies ImageMessageResult);
    return;
  }
  const threadId = request.params.threadId;
  const participants = store.getDmParticipants(threadId);
  if (!participants?.includes(session.member.id)) {
    // Do not reveal whether an inaccessible private thread exists.
    response.status(404).json({ ok: false, error: "That private conversation is not available." } satisfies ImageMessageResult);
    return;
  }
  await handleImageMessageUpload(request, response, session, { kind: "dm", threadId, participants });
});

app.get("/api/preview", (_request, response) => {
  const preview: PublicPreview = {
    members: getMembers().filter((member) => member.kind === "ai" || member.status !== "offline"),
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

app.post("/api/auth/login", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, code: "ORIGIN_REQUIRED", error: "That login did not come from the room." });
    return;
  }
  const parsed = accountLoginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, code: "VALIDATION", error: "Enter your username and password." });
    return;
  }
  if (INVITE_CODE && parsed.data.inviteCode !== INVITE_CODE) {
    response.status(403).json({ ok: false, code: "INVITE_INVALID", error: "That invite code doesn't open this room." });
    return;
  }
  const attempted = await runAccountCrypto(() => accountStore.login({
    loginHandle: parsed.data.loginHandle,
    password: parsed.data.password,
    sourceIdentity: clientIp(request),
  }));
  if (!attempted.accepted) {
    response.setHeader("Retry-After", "2");
    response.status(503).json({ ok: false, code: "AUTH_BUSY", error: "Local account verification is busy. Try again in a moment." });
    return;
  }
  const result = attempted.value;
  if (!result.ok) {
    if (result.code === "RATE_LIMITED") {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))));
      response.status(429).json({ ok: false, code: result.code, error: "Too many login attempts. Wait a moment and try again." });
      return;
    }
    response.status(401).json({ ok: false, code: result.code, error: "That username and password did not match." });
    return;
  }
  if (adminState.isBanned(result.account.actorId, result.account.displayName)) {
    await accountStore.revokeSession(result.token);
    response.status(403).json({ ok: false, code: "BANNED", error: "That account is banned from this room." });
    return;
  }
  if (adminModeration.isKicked(result.account.actorId, result.account.displayName)) {
    await accountStore.revokeSession(result.token);
    response.status(429).json({ ok: false, code: "KICK_COOLDOWN", error: "That account is on a short reconnect cooldown." });
    return;
  }
  const evictedAccountSession = disconnectEvictedAccountSessions(result.account.id);
  const authenticated = accountStore.authenticateSession(result.token);
  const session = authenticated ? hydrateRegisteredSession(result.token, authenticated) : undefined;
  if (!session) {
    await accountStore.revokeSession(result.token);
    response.status(503).json({ ok: false, code: "ACCOUNT_UNAVAILABLE", error: "That account's local social profile is unavailable." });
    return;
  }
  const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1_000));
  setSessionCookie(request, response, result.token, maxAgeSeconds);
  if (evictedAccountSession) io.to("public").emit("presence:update", { members: getMembers() });
  response.status(201).json({
    ok: true,
    me: session.member,
    identity: { kind: "registered", loginHandle: result.account.loginHandle } satisfies HumanSessionIdentity,
  });
});

app.post("/api/auth/register", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, code: "ORIGIN_REQUIRED", error: "That registration did not come from the room." });
    return;
  }
  if (!allowJoinAttempt(clientIp(request))) {
    response.status(429).json({ ok: false, code: "RATE_LIMITED", error: "Too many account attempts. Wait a few minutes." });
    return;
  }
  const parsed = accountRegisterSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, code: "VALIDATION", error: "Enter a username, display name and password." });
    return;
  }
  if (INVITE_CODE && parsed.data.inviteCode !== INVITE_CODE) {
    response.status(403).json({ ok: false, code: "INVITE_INVALID", error: "That invite code doesn't open this room." });
    return;
  }
  const name = normalizeDisplayName(parsed.data.displayName);
  if (!validDisplayName(name)) {
    response.status(400).json({ ok: false, code: "VALIDATION", error: "Choose a display name of 1–24 readable characters." });
    return;
  }
  const identityKey = safeNameKey(name);
  if (PERSONAS.some((persona) => safeNameKey(persona.name) === identityKey)) {
    response.status(409).json({ ok: false, code: "NAME_RESERVED", error: "That display name belongs to an AI resident." });
    return;
  }
  if (adminState.isBanned(undefined, name)) {
    response.status(403).json({ ok: false, code: "BANNED", error: "That identity is banned from this room." });
    return;
  }

  const attempted = await runAccountCrypto(() => identityMutations.run(async () => {
    const existingProfile = humanMemory.listProfiles().find((profile) =>
      safeNameKey(profile.member.name) === identityKey
    );
    if (existingProfile) {
      return {
        ok: false as const,
        status: 409,
        code: "SAVED_IDENTITY",
        error: "That display name belongs to an existing local identity. Sign in if it is yours, use an existing return key, ask the host, or choose another name.",
      };
    }
    const actorId = `human-${randomUUID()}`;
    const registration = await accountStore.register({
      loginHandle: parsed.data.loginHandle,
      displayName: name,
      password: parsed.data.password,
      actorId,
    });
    if (!registration.ok) {
      const status = registration.code === "HANDLE_TAKEN" || registration.code === "ACTOR_ALREADY_LINKED" ? 409 : 400;
      return {
        ok: false as const,
        status,
        code: registration.code,
        error: registration.code === "HANDLE_TAKEN"
          ? "That username is already registered."
          : registration.code === "WEAK_PASSWORD"
            ? "Use a password with at least 8 characters."
            : "Choose a username containing letters, numbers, dots, dashes or underscores.",
      };
    }
    const avatar = randomAvatar();
    avatar.glyph = displayNameGlyph(name);
    const member: Member = {
      id: actorId,
      name,
      kind: "human",
      status: "offline",
      avatar,
      role: "Member",
      bio: "A member of The Third Place.",
    };
    humanMemory.upsertProfile({
      member,
      seenAt: Date.now(),
      protectedHumanIds: protectedHumanActorIds(actorId),
    });
    try {
      await synchronizeOfflineSessionsWithMemory();
      await humanMemory.flush();
      if (!await accountStore.markProfileReady(registration.account.id)) {
        throw new Error("The pending local account disappeared before its social profile committed.");
      }
    } catch (error) {
      humanMemory.forgetProfile(actorId);
      await humanMemory.flush().catch(() => undefined);
      await accountStore.deleteAccount(registration.account.id).catch(() => undefined);
      throw error;
    }
    const issued = await accountStore.issueSession(registration.account.id);
    if (!issued) {
      return { ok: false as const, status: 503, code: "ACCOUNT_UNAVAILABLE", error: "The local account could not open a session." };
    }
    const authenticated = accountStore.authenticateSession(issued.token);
    const session = authenticated ? hydrateRegisteredSession(issued.token, authenticated) : undefined;
    if (!session) {
      await accountStore.revokeSession(issued.token);
      return { ok: false as const, status: 503, code: "ACCOUNT_UNAVAILABLE", error: "The local account could not open its social profile." };
    }
    return { ok: true as const, issued, session };
  }));

  if (!attempted.accepted) {
    response.setHeader("Retry-After", "2");
    response.status(503).json({ ok: false, code: "AUTH_BUSY", error: "Local account creation is busy. Try again in a moment." });
    return;
  }
  const result = attempted.value;

  if (!result.ok) {
    response.status(result.status).json({ ok: false, code: result.code, error: result.error });
    return;
  }
  const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(result.issued.expiresAt) - Date.now()) / 1_000));
  setSessionCookie(request, response, result.issued.token, maxAgeSeconds);
  response.status(201).json({
    ok: true,
    me: result.session.member,
    identity: { kind: "registered", loginHandle: result.issued.account.loginHandle } satisfies HumanSessionIdentity,
  });
});

app.post("/api/auth/upgrade", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, code: "ORIGIN_REQUIRED", error: "That account upgrade did not come from the room." });
    return;
  }
  const parsed = accountUpgradeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, code: "VALIDATION", error: "Enter a username and a password of at least 8 characters." });
    return;
  }
  const authenticated = authenticatedSessionFromRequest(request);
  if (!authenticated) {
    response.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Join the room before keeping this identity." });
    return;
  }
  if (authenticated.session.identityKind === "registered") {
    response.status(409).json({ ok: false, code: "ALREADY_REGISTERED", error: "This identity already belongs to a local account." });
    return;
  }
  if (!allowJoinAttempt(clientIp(request))) {
    response.status(429).json({ ok: false, code: "RATE_LIMITED", error: "Too many account attempts. Wait a few minutes." });
    return;
  }

  const attempted = await runAccountCrypto(() => identityMutations.run(async () => {
    const session = authenticated.session;
    if (!currentIdentitySessionMatches(session.member.id, session.tokenHash)) {
      return {
        ok: false as const,
        status: 409,
        code: "IDENTITY_CHANGED",
        error: "That identity changed while the account was being created. Reopen it and try again.",
      };
    }
    const registration = await accountStore.register({
      loginHandle: parsed.data.loginHandle,
      displayName: session.member.name,
      password: parsed.data.password,
      actorId: session.member.id,
    });
    if (!registration.ok) {
      return {
        ok: false as const,
        status: registration.code === "HANDLE_TAKEN" || registration.code === "ACTOR_ALREADY_LINKED" ? 409 : 400,
        code: registration.code,
        error: registration.code === "HANDLE_TAKEN"
          ? "That username is already registered."
          : registration.code === "WEAK_PASSWORD"
            ? "Use a password with at least 8 characters."
            : registration.code === "ACTOR_ALREADY_LINKED"
              ? "This identity is already linked to a local account. Log in with that account instead."
              : "Choose a username containing letters, numbers, dots, dashes or underscores.",
      };
    }

    let issued: Awaited<ReturnType<AccountStore["issueSession"]>>;
    try {
      issued = await accountStore.issueSession(registration.account.id, { allowPendingProfile: true });
    } catch (error) {
      await accountStore.deleteAccount(registration.account.id).catch(() => undefined);
      throw error;
    }
    if (!issued) {
      await accountStore.deleteAccount(registration.account.id).catch(() => undefined);
      return {
        ok: false as const,
        status: 503,
        code: "ACCOUNT_UNAVAILABLE",
        error: "The local account could not open a session.",
      };
    }

    const previousMember: Member = { ...session.member, avatar: { ...session.member.avatar } };
    const upgradedMember: Member = {
      ...previousMember,
      role: "Member",
      bio: "A member of The Third Place.",
    };
    session.revoked = true;
    humanMemory.upsertProfile({
      member: upgradedMember,
      seenAt: Date.now(),
      protectedHumanIds: protectedHumanActorIds(session.member.id),
    });
    const detached = humanMemory.detachCredential(session.member.id, session.tokenHash);
    if (!detached) {
      humanMemory.upsertProfile({ member: previousMember, protectedHumanIds: protectedHumanActorIds(session.member.id) });
      session.revoked = false;
      await accountStore.deleteAccount(registration.account.id).catch(() => undefined);
      return {
        ok: false as const,
        status: 409,
        code: "IDENTITY_CHANGED",
        error: "That identity changed while the account was being created. Reopen it and try again.",
      };
    }
    try {
      await humanMemory.flush();
      if (!await accountStore.markProfileReady(registration.account.id)) {
        throw new Error("The pending local account disappeared before its social profile committed.");
      }
    } catch {
      humanMemory.upsertProfile({ member: previousMember, protectedHumanIds: protectedHumanActorIds(session.member.id) });
      humanMemory.restoreCredential(session.member.id, detached);
      await humanMemory.flush().catch(() => undefined);
      await accountStore.deleteAccount(registration.account.id).catch(() => undefined);
      session.revoked = false;
      return {
        ok: false as const,
        status: 503,
        code: "UPGRADE_UNAVAILABLE",
        error: "The account could not be saved safely. Your guest identity is still active; try again shortly.",
      };
    }

    // A credential transfer is a hard session boundary. Never re-key the same
    // mutable runtime object: every socket admitted with the guest credential
    // closes over it and would otherwise inherit account authority.
    const previousTokenHash = session.tokenHash;
    for (const socketId of [...session.socketIds]) {
      const socket = io.sockets.sockets.get(socketId);
      socket?.emit("session:upgraded");
      socket?.disconnect(true);
    }
    session.socketIds.clear();
    session.presence.clear();
    sessions.delete(previousTokenHash);

    const registeredSession = createHumanSession(
      hashToken(issued.token),
      { ...upgradedMember, status: "offline", avatar: { ...upgradedMember.avatar } },
      Date.now(),
      Date.parse(issued.account.createdAt),
      {
        kind: "registered",
        accountId: issued.account.id,
        accountSessionId: issued.sessionId,
        expiresAt: Date.parse(issued.expiresAt),
      },
    );
    sessions.set(registeredSession.tokenHash, registeredSession);
    return { ok: true as const, issued, session: registeredSession };
  }));

  if (!attempted.accepted) {
    response.setHeader("Retry-After", "2");
    response.status(503).json({ ok: false, code: "AUTH_BUSY", error: "Local account creation is busy. Try again in a moment." });
    return;
  }
  const result = attempted.value;

  if (!result.ok) {
    response.status(result.status).json({ ok: false, code: result.code, error: result.error });
    return;
  }
  const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(result.issued.expiresAt) - Date.now()) / 1_000));
  setSessionCookie(request, response, result.issued.token, maxAgeSeconds);
  io.to("public").emit("presence:update", { members: getMembers() });
  response.status(201).json({
    ok: true,
    me: result.session.member,
    identity: { kind: "registered", loginHandle: result.issued.account.loginHandle } satisfies HumanSessionIdentity,
  });
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
  refreshSessionCookie(request, response, authenticated.token, authenticated.session);
  const account = authenticated.session.accountId
    ? accountStore.getAccount(authenticated.session.accountId)
    : undefined;
  response.json({
    ok: true,
    me: authenticated.session.member,
    identity: {
      kind: authenticated.session.identityKind,
      ...(account ? { loginHandle: account.loginHandle } : {}),
    } satisfies HumanSessionIdentity,
  });
});

app.delete("/api/account", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "That account request did not come from the room." });
    return;
  }
  if (!allowJoinAttempt(clientIp(request))) {
    response.status(429).json({ ok: false, error: "Too many account checks. Wait a few minutes and try again." });
    return;
  }
  const parsed = accountDeleteSchema.safeParse(request.body);
  const authenticated = authenticatedSessionFromRequest(request);
  if (!parsed.success || !authenticated || authenticated.session.identityKind !== "registered" ||
      !authenticated.session.accountId) {
    response.status(authenticated ? 400 : 401).json({ ok: false, error: "A registered local account is required." });
    return;
  }
  const verification = await runAccountCrypto(() =>
    accountStore.verifyPassword(authenticated.session.accountId!, parsed.data.password)
  );
  if (!verification.accepted) {
    response.setHeader("Retry-After", "2");
    response.status(503).json({ ok: false, error: "Local account verification is busy. Try again in a moment." });
    return;
  }
  if (!verification.value) {
    response.status(401).json({ ok: false, error: "That password did not match this local account." });
    return;
  }
  const removed = await identityMutations.run(async () => {
    const account = accountStore.getAccount(authenticated.session.accountId!);
    if (!account || account.actorId !== authenticated.session.member.id || !isActiveHumanSession(authenticated.session)) {
      return false;
    }
    return await forgetHumanActorUnlocked(account.actorId);
  });
  clearSessionCookie(request, response);
  if (!removed) {
    response.status(409).json({ ok: false, error: "That account changed while it was being removed." });
    return;
  }
  response.status(204).end();
});

// Registered sessions log out here while retaining the account. Ephemeral
// guest/legacy sessions use the durable erasure coordinator, so explicit
// logout removes their private history and social identity rather than merely
// hiding it from the member list.
app.delete("/api/session", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "This identity request did not come from the room." });
    return;
  }
  const authenticated = authenticatedSessionFromRequest(request);
  if (!authenticated) {
    clearSessionCookie(request, response);
    response.status(401).json({ ok: false, error: "That saved identity is no longer active." });
    return;
  }
  if (authenticated.session.identityKind === "registered") {
    authenticated.session.revoked = true;
    await accountStore.revokeSession(authenticated.token);
    for (const socketId of [...authenticated.session.socketIds]) {
      const socket = io.sockets.sockets.get(socketId);
      socket?.emit("session:ended", { reason: "logout" });
      socket?.disconnect(true);
    }
    authenticated.session.socketIds.clear();
    authenticated.session.presence.clear();
    sessions.delete(authenticated.session.tokenHash);
    const sibling = [...sessions.values()].find((candidate) =>
      candidate.member.id === authenticated.session.member.id && isActiveHumanSession(candidate)
    );
    if (sibling) refreshHumanPresence(sibling);
    io.to("public").emit("presence:update", { members: getMembers() });
    clearSessionCookie(request, response);
    response.status(204).end();
    return;
  }
  if (!await forgetHumanActor(authenticated.session.member.id, authenticated.session.tokenHash)) {
    clearSessionCookie(request, response);
    response.status(404).json({ ok: false, error: "That saved identity is no longer retained." });
    return;
  }
  clearSessionCookie(request, response);
  response.status(204).end();
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
  refreshSessionCookie(request, response, authenticated.token, authenticated.session);
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
  const memory = await identityMutations.run(async () => {
    const sessionStillOwnsActor = authenticated.session.identityKind === "registered"
      ? isActiveHumanSession(authenticated.session) &&
        accountStore.getAccount(authenticated.session.accountId ?? "")?.actorId === authenticated.session.member.id
      : currentIdentitySessionMatches(authenticated.session.member.id, authenticated.session.tokenHash);
    if (!sessionStillOwnsActor) {
      return undefined;
    }
    authenticated.session.lastSeenAt = Date.now();
    humanMemory.resetRememberedDetails(authenticated.session.member.id, authenticated.session.lastSeenAt);
    await socialMemory.forgetActor(authenticated.session.member.id);
    await humanMemory.flush();
    return humanMemory.clientSummary(authenticated.session.member.id);
  });
  if (!memory) {
    clearSessionCookie(request, response);
    response.status(409).json({ ok: false, error: "That identity moved while its memory was being cleared. Reopen it and try again." });
    return;
  }
  refreshSessionCookie(request, response, authenticated.token, authenticated.session);
  response.json({ ok: true, memory });
});

app.post("/api/session/recovery-key", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, error: "That return-key request did not come from the room." });
    return;
  }
  if (!z.object({}).strict().safeParse(request.body ?? {}).success) {
    response.status(400).json({ ok: false, error: "That return-key request is invalid." });
    return;
  }
  const authenticated = authenticatedSessionFromRequest(request);
  if (!authenticated) {
    response.status(401).json({ ok: false, error: "Join the room before creating a return key." });
    return;
  }
  if (authenticated.session.identityKind !== "legacy") {
    response.status(409).json({
      ok: false,
      error: authenticated.session.identityKind === "registered"
        ? "This account already returns with its username and password."
        : "Create an account to keep this guest identity across devices.",
    });
    return;
  }
  const issued = await issueHumanRecoveryKeyMutation(
    authenticated.session.member.id,
    authenticated.session.tokenHash,
    true,
  );
  if (issued.status === "rate_limited") {
    response.status(429).json({ ok: false, error: "Too many return-key changes. Wait a few minutes and try again." });
    return;
  }
  if (issued.status !== "issued") {
    clearSessionCookie(request, response);
    response.status(409).json({ ok: false, error: "That identity moved before a return key could be created. Reopen it and try again." });
    return;
  }
  setSessionCookie(request, response, authenticated.token);
  response.status(201).json({ ok: true, recoveryKey: issued.recoveryKey });
});

app.post("/api/session/recover", async (request, response) => {
  response.setHeader("Cache-Control", "private, no-store");
  if (!hasAllowedOrigin(request)) {
    response.status(403).json({ ok: false, code: "ORIGIN_REQUIRED", error: "That return request did not come from the room." });
    return;
  }
  const parsed = recoverSessionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, code: "VALIDATION", error: "Enter a display name and its complete return key." });
    return;
  }
  if (INVITE_CODE && parsed.data.inviteCode !== INVITE_CODE) {
    response.status(403).json({ ok: false, code: "INVITE_INVALID", error: "That invite code doesn't open this room." });
    return;
  }
  const name = normalizeDisplayName(parsed.data.name);
  if (!validDisplayName(name)) {
    response.status(400).json({ ok: false, code: "VALIDATION", error: "Use the same valid display name that was saved before." });
    return;
  }
  if (!allowRecoveryAttempt(clientIp(request), name)) {
    response.status(429).json({ ok: false, code: "RECOVERY_RATE_LIMITED", error: "Too many return attempts. Wait a while and try again." });
    return;
  }

  const normalizedRecoveryKey = normalizeHumanIdentityRecoveryKey(parsed.data.recoveryKey);
  const recoveryKeyHash = normalizedRecoveryKey
    ? hashHumanIdentityRecoveryKey(normalizedRecoveryKey)
    : "invalid";
  const result = await identityMutations.run(async () => {
    const current = humanMemory.findByRecoveryKey(name, recoveryKeyHash);
    if (!current) {
      return {
        ok: false as const,
        status: 401,
        code: "RECOVERY_INVALID",
        error: "That display name and return key did not match a saved identity.",
      };
    }
    if (adminState.isBanned(current.member.id, current.member.name)) {
      return { ok: false as const, status: 403, code: "BANNED", error: "That identity is banned from this room." };
    }
    if (adminModeration.isKicked(current.member.id, current.member.name)) {
      return { ok: false as const, status: 429, code: "KICK_COOLDOWN", error: "That identity is on a short reconnect cooldown." };
    }
    const identityIsOnline = [...sessions.values()].some(
      (session) => session.member.id === current.member.id && session.socketIds.size > 0,
    );
    if (identityIsOnline && parsed.data.takeOver !== true) {
      return {
        ok: false as const,
        status: 409,
        code: "IDENTITY_ONLINE",
        error: "That identity is connected in another browser. Confirm that you want to move it here.",
      };
    }

    // Quiesce the old credential before the first await. HTTP authentication
    // and socket packet middleware now reject it, while the live connection is
    // kept long enough to receive an accurate success notice. On a failed
    // durable commit, clearing this flag makes the previous login usable again.
    const previousRuntimeSessions = [...sessions.values()].filter(
      (session) => session.member.id === current.member.id,
    );
    for (const session of previousRuntimeSessions) session.revoked = true;
    actorPublicationGate.invalidate(current.member.id);

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const recoveredAt = Date.now();
    const rotated = humanMemory.rotateSessionToken(
      current.member.id,
      current.tokenHash,
      tokenHash,
      recoveredAt,
    );
    if (!rotated) {
      for (const session of previousRuntimeSessions) session.revoked = false;
      return {
        ok: false as const,
        status: 409,
        code: "RECOVERY_CHANGED",
        error: "That identity changed during the return attempt. Try the key again.",
      };
    }
    try {
      await humanMemory.flush();
    } catch {
      humanMemory.rotateSessionToken(current.member.id, tokenHash, current.tokenHash, current.lastSeenAt);
      await humanMemory.flush().catch(() => undefined);
      for (const session of previousRuntimeSessions) session.revoked = false;
      return {
        ok: false as const,
        status: 503,
        code: "RECOVERY_UNAVAILABLE",
        error: "The identity could not be moved safely. Its previous login remains valid; try again shortly.",
      };
    }

    disconnectHumanSockets(current.member.id, {
      action: "recover",
      message: "This saved identity was opened in another browser. Use the return key to move it back here.",
    });
    for (const [existingHash, session] of [...sessions]) {
      if (session.member.id === current.member.id) sessions.delete(existingHash);
    }
    const replacement = createHumanSession(
      tokenHash,
      rotated.member,
      recoveredAt,
      rotated.createdAt,
    );
    sessions.set(tokenHash, replacement);
    return { ok: true as const, token, session: replacement };
  });

  if (!result.ok) {
    response.status(result.status).json({ ok: false, code: result.code, error: result.error });
    return;
  }
  setSessionCookie(request, response, result.token);
  response.status(201).json({ ok: true, me: result.session.member });
});

app.post("/api/session", async (request, response) => {
  // Guest credentials are carried only by the HttpOnly cookie. Prevent
  // browsers and intermediaries from retaining identity responses.
  response.setHeader("Cache-Control", "private, no-store");
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
  const identityKey = safeNameKey(name);
  if (PERSONAS.some((persona) => safeNameKey(persona.name) === identityKey)) {
    response.status(409).json({
      ok: false,
      code: "NAME_RESERVED",
      error: "That display name belongs to an AI resident. Choose another name.",
    });
    return;
  }
  await identityMutations.run(async () => {
    if (adminState.isBanned(undefined, name)) {
      response.status(403).json({ ok: false, code: "BANNED", error: "That identity is banned from this room." });
      return;
    }
    if (adminModeration.isKicked(undefined, name)) {
      response.status(429).json({ ok: false, code: "KICK_COOLDOWN", error: "That identity is on a short reconnect cooldown." });
      return;
    }
    // Persona edits are validated against humans too, but repeat this check
    // after waiting for the identity transaction so simultaneous catalog/name
    // changes cannot create a human/resident collision.
    if (PERSONAS.some((persona) => safeNameKey(persona.name) === identityKey)) {
      response.status(409).json({
        ok: false,
        code: "NAME_RESERVED",
        error: "That display name belongs to an AI resident. Choose another name.",
      });
      return;
    }
    const retainedMatches = humanMemory.listProfiles()
      .filter((profile) => safeNameKey(profile.member.name) === identityKey);
    if (retainedMatches.length > 0) {
      const registered = retainedMatches.some((profile) =>
        accountStore.getAccountByActorId(profile.member.id) !== undefined
      );
      const recoveryConfigured = retainedMatches.some((profile) => humanMemory.hasRecoveryKey(profile.member.id));
      const retainedIds = new Set(retainedMatches.map((profile) => profile.member.id));
      const online = [...sessions.values()].some(
        (session) => retainedIds.has(session.member.id) && session.socketIds.size > 0,
      );
      response.status(409).json({
        ok: false,
        code: "RETURNING_IDENTITY",
        error: registered
          ? "That display name belongs to a local account. Log in instead of creating a guest variation."
          : retainedMatches.length === 1
          ? recoveryConfigured
            ? "That name belongs to a saved identity. Use its return key instead of creating a variation."
            : "That name belongs to a saved identity without a return key yet. Ask the server host to issue one."
          : recoveryConfigured
            ? "More than one legacy identity matches that name. A matching return key can select the right one; otherwise ask the server owner."
            : "More than one legacy identity matches that name and none has a return key yet. Ask the server owner for help restoring it safely.",
        online,
        recoveryConfigured,
      });
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
    }, undefined, undefined, { kind: "guest" });
    sessions.set(tokenHash, session);
    humanMemory.upsertSession({
      tokenHash,
      member: session.member,
      seenAt: session.lastSeenAt,
      protectedHumanIds: protectedHumanActorIds(session.member.id),
    });
    try {
      await synchronizeOfflineSessionsWithMemory();
      await humanMemory.flush();
    } catch (error) {
      sessions.delete(tokenHash);
      humanMemory.forgetProfile(session.member.id);
      await humanMemory.flush().catch(() => undefined);
      throw error;
    }
    setSessionCookie(request, response, token);
    response.status(201).json({
      ok: true,
      me: session.member,
      identity: { kind: "guest" } satisfies HumanSessionIdentity,
    });
  });
});

io.use((socket, next) => {
  const token = parseCookieHeader(socket.handshake.headers.cookie)[SESSION_COOKIE];
  const session = sessionForToken(token);
  if (!session || !isActiveHumanSession(session)) {
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
  socket.use((_packet, next) => {
    if (!isActiveHumanSession(session)) {
      next(new Error("AUTH_REQUIRED"));
      return;
    }
    next();
  });
  const wasOffline = ![...sessions.values()].some((candidate) =>
    candidate.member.id === session.member.id && candidate.socketIds.size > 0
  );
  const connectedAt = Date.now();
  const initialPresence = presenceHandshakeSchema.safeParse(socket.handshake.auth?.presence);
  session.socketIds.add(socket.id);
  session.presence.connect(
    socket.id,
    initialPresence.success ? initialPresence.data : { visible: true, active: true },
    connectedAt,
  );
  refreshHumanPresence(session, connectedAt);
  session.lastSeenAt = connectedAt;
  humanMemory.noteSeen(session.member.id, session.lastSeenAt);
  socket.join("public");
  socket.join(`user:${session.member.id}`);
  socketBuckets.set(socket.id, {
    messages: new TokenBucket(5, 0.45),
    reactions: new TokenBucket(12, 1.6),
    typing: new TokenBucket(8, 2),
    presence: new TokenBucket(8, 0.5),
    voiceActions: new TokenBucket(12, 1),
    voiceSignals: new TokenBucket(120, 40),
  });

  socket.emit("room:snapshot", snapshotFor(session));
  socket.emit("voice:rooms:update", voiceRooms.listRooms());
  io.to("public").emit("presence:update", { members: getMembers() });

  socket.on("presence:activity", (raw: unknown) => {
    if (!socketBuckets.get(socket.id)?.presence.take()) return;
    const parsed = presenceActivitySchema.safeParse(raw);
    if (!parsed.success) return;
    const signal: PresenceActivityPayload = parsed.data;
    if (!session.presence.update(socket.id, signal, Date.now())) return;
    publishHumanPresenceIfChanged(session);
  });

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
    session.presence.setVoiceConnected(socket.id, false);
    publishHumanPresenceIfChanged(session);
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
      session.presence.setVoiceConnected(socket.id, true);
      publishHumanPresenceIfChanged(session);
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
      session.presence.setVoiceConnected(socket.id, true);
      publishHumanPresenceIfChanged(session);
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
    const result = voiceRooms.setHumanState(parsed.data.roomId, socket.id, parsed.data);
    if (result.ok) {
      publishVoiceRoom(result.room);
      // `speaking` is an untrusted, low-latency UI hint from the browser RMS
      // detector. Do not let keyboard clicks or room noise cancel generation.
      // Accepted STT turns notify both directors in the voice upload endpoint.
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
      // Invalidation resets any obsolete thinking/speaking state. Publish the
      // post-invalidation runtime snapshot, never the stale mutation result.
      publishVoiceRoom(voiceRooms.getRoom(parsed.data.roomId) ?? result.room);
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
      publishVoiceRoom(voiceRooms.getRoom(parsed.data.roomId) ?? result.room);
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

  socket.on("message:send", async (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
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
      const targetPersonaIds = publicTurnTargetIds(content, replied);
      if (targetPersonaIds.length > 0) {
        try {
          // The visible row and its per-resident response obligation cross the
          // same durability barrier before either the browser or director can
          // observe success. A deploy can no longer acknowledge and then lose
          // the only work item that should answer an exact @mention/reply.
          await store.addPublicMessageDurably(message, undefined, { targetPersonaIds });
        } catch (error) {
          console.error("Could not durably accept a direct public turn:", error instanceof Error ? error.message : error);
          acknowledge?.({ ok: false, error: "That direct message could not be saved safely. Please try again." });
          return;
        }
      } else {
        store.addPublicMessage(message);
      }
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
    const peerId = participants.find((id) => id !== session.member.id);
    if (!peerId || !getMembers().some((member) => member.id === peerId)) {
      acknowledge?.({ ok: false, error: "That person isn't available for a private message." });
      return;
    }
    const message = store.addDmMessage(parsed.data.channelId, session.member.id, content, parsed.data.replyToId);
    if (!message) {
      acknowledge?.({ ok: false, error: "Could not send that private message." });
      return;
    }
    emitDmUpdate(participants, message);
    const persona = PERSONAS.find((candidate) => candidate.id === peerId);
    if (persona) void director.onDirectMessage(message, session.member, persona);
    acknowledge?.({ ok: true });
  });

  socket.on("dm:open", (raw: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = z.object({ peerId: z.string().min(1).max(100) }).safeParse(raw);
    const peer = parsed.success ? getMembers().find((member) => member.id === parsed.data.peerId) : undefined;
    if (!peer || peer.id === session.member.id) {
      acknowledge?.({ ok: false, error: "That person isn't available for a private chat." });
      return;
    }
    const thread = store.openDm(session.member.id, peer.id);
    io.to(`user:${session.member.id}`).emit("dm:read:update", { thread });
    acknowledge?.({ ok: true, thread });
  });

  socket.on("dm:read", (raw: unknown, acknowledge?: (result: ActionResult) => void) => {
    const parsed = z.object({
      threadId: z.string().min(1).max(256),
      messageId: z.string().min(1).max(100).optional(),
    }).strict().safeParse(raw);
    if (!parsed.success) {
      acknowledge?.({ ok: false, error: "That private read position is invalid." });
      return;
    }
    const thread = store.markDmRead(parsed.data.threadId, session.member.id, parsed.data.messageId);
    if (!thread) {
      acknowledge?.({ ok: false, error: "That private conversation isn't available." });
      return;
    }
    io.to(`user:${session.member.id}`).emit("dm:read:update", { thread });
    acknowledge?.({ ok: true });
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
    session.presence.disconnect(socket.id);
    session.lastSeenAt = Date.now();
    humanMemory.noteSeen(session.member.id, session.lastSeenAt);
    refreshHumanPresence(session);
    io.to("public").emit("presence:update", { members: getMembers() });
  });
});

function emitDmUpdate(participants: [string, string], message: ChatMessage): void {
  for (const viewerId of participants) {
    const peerId = participants.find((id) => id !== viewerId);
    if (!peerId || PERSONAS.some((persona) => persona.id === viewerId)) continue;
    const thread = store.getDmThread(viewerId, peerId);
    if (!thread) continue;
    io.to(`user:${viewerId}`).emit("dm:update", {
      thread,
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

await accountStore.load();
const humanMemoryLoad = await humanMemory.load();
adminState.validateActiveCatalog();
await store.load();
let cancelledBannedPublicTurnTargets = 0;
for (const ban of adminState.snapshot().bans) {
  cancelledBannedPublicTurnTargets += store.cancelPendingPublicTurnsForActor(ban.memberId);
}
if (cancelledBannedPublicTurnTargets > 0) await store.flush();
const socialActorInventory = socialMemoryStore.overview();
const dmActorIds = store.getAllDmParticipantIds();
const publicParticipantActorIds = store.getAllPublicParticipantActorIds();
// Registration/upgrade spans two local stores. A durable pending bit makes
// recovery precise: a pending account with no profile and no downstream actor
// evidence was never usable and can be rolled back; a ready account whose
// profile vanished is corruption and must stop startup rather than inventing
// a blank person with lost memories.
const downstreamActorIds = new Set([
  ...socialActorInventory.actorIds,
  ...dmActorIds,
  ...publicParticipantActorIds,
]);
const pendingForgetActorIds = new Set(humanMemoryLoad.pendingActorForgetIds);
const accountsNeedingProfileCommit: string[] = [];
let reconciledAccountProfiles = false;
for (const account of accountStore.listAccounts()) {
  if (pendingForgetActorIds.has(account.actorId)) continue;
  const profile = humanMemory.findByHumanId(account.actorId);
  if (!profile) {
    if (account.profileState === "pending" && !downstreamActorIds.has(account.actorId)) {
      await accountStore.deleteAccount(account.id);
      console.warn(`Rolled back incomplete local account ${account.id}; its social profile was never committed.`);
      continue;
    }
    throw new Error(
      `Local account continuity is incomplete for actor ${account.actorId}. ` +
      "Restore the human-memory file before starting the server.",
    );
  }
  if (
    profile.member.name !== account.displayName ||
    profile.member.role !== "Member" ||
    profile.member.bio !== "A member of The Third Place."
  ) {
    humanMemory.upsertProfile({
      member: {
        ...profile.member,
        name: account.displayName,
        role: "Member",
        bio: "A member of The Third Place.",
      },
      protectedHumanIds: protectedHumanActorIds(account.actorId),
    });
    reconciledAccountProfiles = true;
  }
  if (profile.tokenHash && humanMemory.detachCredential(account.actorId, profile.tokenHash)) {
    reconciledAccountProfiles = true;
  }
  if (account.profileState === "pending") accountsNeedingProfileCommit.push(account.id);
}
if (reconciledAccountProfiles) await humanMemory.flush();
for (const accountId of accountsNeedingProfileCommit) {
  if (!await accountStore.markProfileReady(accountId)) {
    throw new Error(`Pending local account ${accountId} disappeared during startup reconciliation.`);
  }
}
const accountActorIds = new Set(accountStore.listAccounts().map((account) => account.actorId));
const orphanedAccountProfiles = humanMemory.listProfiles().filter((profile) =>
  profile.tokenHash === undefined &&
  !accountActorIds.has(profile.member.id) &&
  !pendingForgetActorIds.has(profile.member.id)
);
if (orphanedAccountProfiles.length > 0) {
  throw new Error(
    "Local account continuity is incomplete: credentialless social profiles have no matching account record. " +
    "Restore the account-state file before starting the server.",
  );
}
assertHumanMemoryContinuity({
  continuityVerified: humanMemoryLoad.continuityVerified,
  socialActorIds: socialActorInventory.actorIds,
  socialActorCount: socialActorInventory.stats.actors,
  retainedHumanActorIds: humanMemory.listProfiles().map((profile) => profile.member.id),
  residentActorIds: PERSONAS.map((persona) => persona.id),
  pendingActorForgetIds: humanMemoryLoad.pendingActorForgetIds,
  additionalActorInventories: [
    { actorIds: dmActorIds, actorCount: dmActorIds.length },
    { actorIds: publicParticipantActorIds, actorCount: publicParticipantActorIds.length },
    {
      actorIds: accountStore.listAccounts().map((account) => account.actorId),
      actorCount: accountStore.listAccounts().length,
    },
  ],
});
await reconcilePendingHumanActorForgets();
if (!humanMemoryLoad.continuityVerified) {
  humanMemory.confirmContinuityBaseline();
  await humanMemory.flush();
}
for (const profile of humanMemory.listRestorableProfiles()) {
  sessions.set(profile.tokenHash, createHumanSession(
    profile.tokenHash,
    profile.member,
    profile.lastSeenAt,
    undefined,
    { kind: humanMemory.hasRecoveryKey(profile.member.id) ? "legacy" : "guest" },
  ));
}
await imageStore.initialize(store.getAllImageMessages());
store.onMessagesRemoved((removed) => {
  for (const message of removed) {
    for (const attachment of message.attachments ?? []) void imageStore.remove(attachment.id);
  }
});
for (const message of store.getAllImageMessages()) {
  for (const attachment of message.attachments ?? []) {
    if (attachment.analysis.status !== "pending") continue;
    const unavailable: ImageAnalysis = { status: "unavailable" };
    const updated = store.setImageAnalysis(message.channelId, message.id, attachment.id, unavailable);
    if (updated) imageStore.update(updated);
  }
}
actorChannels.restore(store.getAllMessages());
await lm.probe();
socialMemoryLifecycle.start();
director.start();
const recoveredDirectTurns = director.recoverPendingPublicTurns({ ignoreAttemptCooldown: true });
if (recoveredDirectTurns > 0) {
  console.info(`Recovered ${recoveredDirectTurns} durable unanswered direct human turn(s) after startup.`);
}

const healthInterval = setInterval(async () => {
  const now = Date.now();
  let presenceChanged = false;
  for (const session of [...sessions.values()]) {
    if (session.identityKind === "registered" && session.expiresAt !== undefined && session.expiresAt <= now) {
      session.revoked = true;
      for (const socketId of [...session.socketIds]) {
        const socket = io.sockets.sockets.get(socketId);
        socket?.emit("session:ended", { reason: "expired" });
        socket?.disconnect(true);
      }
      session.socketIds.clear();
      session.presence.clear();
      sessions.delete(session.tokenHash);
      presenceChanged = true;
      continue;
    }
    if (session.socketIds.size > 0) {
      if (now - session.lastSeenAt >= SESSION_HEARTBEAT_MS) {
        session.lastSeenAt = now;
        humanMemory.noteSeen(session.member.id, now);
      }
    }
    if (refreshHumanPresence(session, now)) presenceChanged = true;
  }
  if (presenceChanged) io.to("public").emit("presence:update", { members: getMembers() });
  adminAuth.prune(now);
  adminModeration.prune(now);
  try {
    await identityMutations.run(async () => {
      // Derive expiry only after obtaining the same transaction used by
      // recovery. Revalidate immediately before the synchronous revocation in
      // forgetHumanActorUnlocked so a freshly recovered/connected identity can
      // never be erased from a stale health-cycle snapshot.
      const expiredActorIds = new Set(
        [...sessions.values()]
          .filter((session) =>
            session.identityKind !== "registered" &&
            session.socketIds.size === 0 &&
            now - session.lastSeenAt > SESSION_RETENTION_MS
          )
          .map((session) => session.member.id),
      );
      for (const actorId of expiredActorIds) {
        const currentSessions = [...sessions.values()].filter((session) => session.member.id === actorId);
        if (
          currentSessions.length === 0 ||
          currentSessions.some(
            (session) => session.revoked || session.socketIds.size > 0 || now - session.lastSeenAt <= SESSION_RETENTION_MS,
          )
        ) continue;
        await forgetHumanActorUnlocked(actorId);
      }
      // All retained profiles have a reconstructed runtime session. This pass
      // now primarily expires bounded facts and catches configured overflow,
      // while still sharing the identity transaction boundary.
      humanMemory.prune(
        now,
        new Set(
          [...sessions.values()]
            .filter((session) => session.socketIds.size > 0 || session.revoked)
            .map((session) => session.member.id),
        ),
      );
      await synchronizeOfflineSessionsWithMemory();
    });
  } catch (error) {
    console.warn(
      "Deferred actor-memory erasure will be retried from its durable tombstone.",
      error instanceof Error ? error.message : error,
    );
  }
  for (const [sourceKey, timestamps] of joinAttempts) {
    const recent = timestamps.filter((timestamp) => now - timestamp < 10 * 60_000);
    if (recent.length > 0) joinAttempts.set(sourceKey, recent);
    else joinAttempts.delete(sourceKey);
  }
  for (const [key, timestamps] of recoveryAttempts) {
    const recent = timestamps.filter((timestamp) => now - timestamp < RECOVERY_ATTEMPT_WINDOW_MS);
    if (recent.length > 0) recoveryAttempts.set(key, recent);
    else recoveryAttempts.delete(key);
  }
  for (const [key, timestamps] of recoveryIpAttempts) {
    const recent = timestamps.filter((timestamp) => now - timestamp < RECOVERY_ATTEMPT_WINDOW_MS);
    if (recent.length > 0) recoveryIpAttempts.set(key, recent);
    else recoveryIpAttempts.delete(key);
  }
  for (const [actorId, timestamps] of selfRecoveryKeyRotations) {
    const recent = timestamps.filter((timestamp) => now - timestamp < SELF_RECOVERY_KEY_WINDOW_MS);
    if (recent.length > 0) selfRecoveryKeyRotations.set(actorId, recent);
    else selfRecoveryKeyRotations.delete(actorId);
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
  await socialMemory.close();
  await socialMemoryLifecycle.close();
  await Promise.all([
    accountStore.flush(),
    store.flush(),
    humanMemory.flush(),
    ambientEpisodeLedger.flush(),
    adminState.flush(),
    modelProviders.close(),
  ]);
  socialMemoryStore.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
