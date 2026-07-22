export type Presence = "online" | "idle" | "dnd" | "offline";
/**
 * `agent` is an externally operated, visibly labelled participant. It is not a
 * browser human and it is not one of the server-owned AI residents.
 */
export type MemberKind = "human" | "ai" | "agent";
export type HumanIdentityKind = "registered" | "guest" | "legacy";

export interface HumanSessionIdentity {
  kind: HumanIdentityKind;
  /** Present only for the authenticated owner of a registered account. */
  loginHandle?: string;
  /**
   * Owner-only acknowledgement that The Third Place is an adult community.
   * This is not identity verification or consent to a particular interaction.
   */
  adultConfirmed?: boolean;
}

/** Browser hint only; the server owns activity timestamps and aggregation. */
export interface PresenceActivityPayload {
  visible: boolean;
  active: boolean;
}

export interface Member {
  id: string;
  name: string;
  kind: MemberKind;
  status: Presence;
  avatar: {
    color: string;
    accent: string;
    glyph: string;
    /** Optional same-origin path or HTTPS URL. Clients must retain a glyph fallback. */
    imageUrl?: string;
  };
  role?: string;
  bio?: string;
  activity?: string;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

export interface Reaction {
  emoji: string;
  memberIds: string[];
}

export interface MessageSource {
  title: string;
  url: string;
  publishedAt?: string;
}

export interface LinkPreview {
  url: string;
  displayHost: string;
  title: string;
  description?: string;
  siteName: string;
  fetchedAt: string;
}

/**
 * A server-owned utility publisher. Feed publishers are deliberately not
 * members: they have no presence, profile, relationships, DMs or voice role.
 */
export interface ChannelFeedPublisher {
  id: string;
  name: string;
  badge: "BOT";
  avatar: {
    color: string;
    accent: string;
    glyph: string;
    /** Feed artwork is server-owned and served from the same origin. */
    imageUrl?: string;
  };
}

/** Attribution for structured feed data, not article publication metadata. */
export interface ChannelFeedSource {
  id: string;
  label: string;
  url: string;
  retrievedAt: string;
  experimental: boolean;
}

export type MarketTickerFreshness = "recent" | "previous_session" | "stale";

export interface MarketTickerFeedObservation {
  indexId: string;
  displayName: string;
  shortName: string;
  currency: string;
  level: number;
  previousClose: number;
  change: number;
  changePercent: number;
  changeBasis: "previous_close";
  tradingDate: string;
  observedAt: string;
  freshness: MarketTickerFreshness;
  source: ChannelFeedSource;
}

export interface MarketTickerFeedCoverage {
  requested: number;
  available: number;
  ratio: number;
  complete: boolean;
}

export interface MarketTickerFeedCard {
  id: string;
  kind: "market_ticker";
  channelId: string;
  publisher: ChannelFeedPublisher;
  /** Store-owned, monotonically increasing revision used for idempotent UI updates. */
  revision: number;
  /** Outcome of the latest refresh; observations may retain the last good snapshot. */
  state: "ready" | "partial" | "unavailable";
  title: string;
  targetId: string;
  updatedAt: string;
  /** Absent only when no successful or partial snapshot has ever been obtained. */
  retrievedAt?: string;
  requestedIndexIds: string[];
  missingIndexIds: string[];
  coverage: MarketTickerFeedCoverage;
  observations: MarketTickerFeedObservation[];
}

/** Add future deterministic integrations as new discriminants, not as Members. */
export type ChannelFeedCard = MarketTickerFeedCard;

export interface ChannelFeedUpdatePayload {
  card: ChannelFeedCard;
}

/** Authoritative visible feed set; unlike an upsert it can remove a disabled integration. */
export interface ChannelFeedSyncPayload {
  cards: ChannelFeedCard[];
}

export interface ReplyPreview {
  authorId: string;
  authorName: string;
  content: string;
}

export interface VisualObservation {
  summary: string;
  details: string[];
  visibleText: string[];
  topics: string[];
  uncertainties: string[];
  analyzedAt: string;
}

export type ImageAnalysis =
  | { status: "pending" }
  | { status: "ready"; observation: VisualObservation }
  | { status: "unavailable" }
  | { status: "not_requested" };

export interface ImageAttachment {
  id: string;
  kind: "image";
  url: string;
  thumbnailUrl: string;
  mimeType: "image/webp";
  width: number;
  height: number;
  sizeBytes: number;
  analysis: ImageAnalysis;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: string;
  reactions: Reaction[];
  replyToId?: string;
  replyPreview?: ReplyPreview;
  system?: boolean;
  /** Frozen display metadata keeps departed human authors visible in history. */
  authorSnapshot?: Member;
  /** Internal observability for tests/director; the UI does not present this as model provenance. */
  generation?: "lm" | "fallback";
  sources?: MessageSource[];
  linkPreview?: LinkPreview;
  attachments?: ImageAttachment[];
}

export interface ImageAnalysisPayload {
  channelId: string;
  messageId: string;
  attachmentId: string;
  analysis: ImageAnalysis;
}

export type ImageMessageResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; error: string };

export interface HistoryPage {
  channelId: string;
  messages: ChatMessage[];
  before?: string;
  hasMore: boolean;
}

export interface LinkPreviewPayload {
  channelId: string;
  messageId: string;
  linkPreview: LinkPreview;
}

export interface DmThread {
  id: string;
  peerId: string;
  messages: ChatMessage[];
  unread: number;
}

export interface ServerHealth {
  ok: boolean;
  model: {
    connected: boolean;
    id?: string;
    label: string;
    latencyMs?: number;
    queueDepth: number;
    /** Predictions currently executing in the configured model backend. */
    activePredictions?: number;
    /** Active optional/background predictions that may yield to live turns. */
    activeBackgroundPredictions?: number;
    /** Local scheduler ceiling; the backend may enforce an additional shared limit. */
    maxConcurrentPredictions?: number;
    /** Background ceiling that deliberately reserves capacity for live turns. */
    maxBackgroundPredictions?: number;
    /** Runtime ceiling after foreground demand has temporarily claimed capacity. */
    effectiveMaxBackgroundPredictions?: number;
    /** Reference-counted live public, DM, image or voice work spanning model gaps. */
    foregroundDemandCount?: number;
    provider?: "lmstudio" | "codex";
  };
  onlineHumans: number;
  idleHumans: number;
  aiPace: "calm" | "lively" | "party";
}

export interface DirectorEvent {
  id: string;
  createdAt: string;
  trigger: "join" | "message" | "mention" | "reaction" | "dm" | "ambient" | "research";
  summary: string;
  considered: number;
  noticed: number;
  replied: number;
  reacted: number;
  stayedQuiet: number;
}

export interface RoomSnapshot {
  me: Member;
  identity: HumanSessionIdentity;
  members: Member[];
  channels: Channel[];
  channelFeeds: ChannelFeedCard[];
  messages: ChatMessage[];
  historyPageInfo: Record<string, { before?: string; hasMore: boolean }>;
  dmThreads: DmThread[];
  inviteRequired: boolean;
  health: ServerHealth;
  directorEvents: DirectorEvent[];
}

export interface PublicPreview {
  members: Member[];
  channels: Channel[];
  channelFeeds: ChannelFeedCard[];
  messages: ChatMessage[];
  inviteRequired: boolean;
  health: ServerHealth;
}

export interface JoinPayload {
  name: string;
  inviteCode?: string;
}

export type JoinResult =
  | { ok: true; me: Member; recoveryKey?: string }
  | {
      ok: false;
      error: string;
      code?:
        | "NAME_RESERVED"
        | "RETURNING_IDENTITY"
        | "IDENTITY_ONLINE"
        | "RECOVERY_INVALID"
        | "RECOVERY_CHANGED"
        | "RECOVERY_UNAVAILABLE"
        | "RECOVERY_RATE_LIMITED"
        | "ORIGIN_REQUIRED"
        | "BANNED"
        | "KICK_COOLDOWN"
        | "INVITE_INVALID"
        | "VALIDATION";
      recoveryConfigured?: boolean;
      online?: boolean;
    };

export interface SendMessagePayload {
  channelId: string;
  content: string;
  replyToId?: string;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface TypingPayload {
  channelId: string;
  memberIds: string[];
}

export interface TypingMemberPayload {
  channelId: string;
  memberId: string;
  active: boolean;
}

/** Refreshes one already-owned composing state without creating a new speaker. */
export interface TypingHeartbeatPayload {
  channelId: string;
  memberId: string;
}

export interface PresencePayload {
  members: Member[];
}

export interface CatalogUpdatePayload {
  members: Member[];
  channels: Channel[];
}

export interface ReactionPayload {
  messageId: string;
  channelId: string;
  reaction: Reaction;
}

export interface ToastPayload {
  tone: "info" | "success" | "warning";
  title: string;
  message: string;
}

export interface DmUpdatePayload {
  thread: DmThread;
  message?: ChatMessage;
}

export type VoiceBotState = "invited" | "joining" | "listening" | "thinking" | "speaking" | "unavailable";
export type VoiceParticipantRole = "host" | "guest" | "ai";

export interface VoiceParticipantView {
  memberId: string;
  name: string;
  /** External API agents are deliberately outside the v1 voice transport. */
  kind: Exclude<MemberKind, "agent">;
  role: VoiceParticipantRole;
  joinedAt: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  botState?: VoiceBotState;
}

export interface VoiceRoomView {
  id: string;
  channelId: string;
  createdByMemberId: string;
  hostMemberId: string;
  createdAt: string;
  revision: number;
  participants: VoiceParticipantView[];
}

export interface VoiceIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface VoiceCapabilities {
  transport: "webrtc-p2p";
  maxHumans: 6;
  maxBots: 2;
  transcription: boolean;
  speechToText: boolean;
  textToSpeech: boolean;
  iceServers: VoiceIceServer[];
}

export type VoiceErrorCode =
  | "CHANNEL_NOT_FOUND"
  | "ROOM_NOT_FOUND"
  | "ROOM_EXISTS"
  | "ALREADY_IN_ROOM"
  | "ALREADY_JOINED"
  | "ROOM_FULL"
  | "NOT_IN_ROOM"
  | "NOT_AUTHORIZED"
  | "BOT_ALREADY_INVITED"
  | "BOT_IN_ANOTHER_ROOM"
  | "BOT_LIMIT"
  | "INVALID_SIGNAL"
  | "STALE_REVISION"
  | "TARGET_NOT_FOUND"
  | "INVALID_TRANSCRIPT";

export interface VoiceActionFailure {
  ok: false;
  code: VoiceErrorCode;
  error: string;
}

export type VoiceCreateResult =
  | { ok: true; room: VoiceRoomView; capabilities: VoiceCapabilities }
  | VoiceActionFailure;

export type VoiceJoinResult =
  | { ok: true; room: VoiceRoomView; capabilities: VoiceCapabilities }
  | VoiceActionFailure;

export type VoiceLeaveResult =
  | { ok: true; closed: false; room: VoiceRoomView }
  | { ok: true; closed: true; roomId: string; revision: number }
  | VoiceActionFailure;

export type VoiceInviteBotResult =
  | { ok: true; room: VoiceRoomView }
  | VoiceActionFailure;

export type VoiceSessionDescriptionSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string };

export interface VoiceIceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface VoiceIceSignal {
  type: "ice";
  candidate: VoiceIceCandidate | null;
}

export type VoicePeerSignal = VoiceSessionDescriptionSignal | VoiceIceSignal;

export interface VoiceSignalPayload {
  roomId: string;
  toMemberId: string;
  revision: number;
  signal: VoicePeerSignal;
}

export interface VoiceSignalForward {
  roomId: string;
  fromMemberId: string;
  toMemberId: string;
  revision: number;
  signal: VoicePeerSignal;
}

export type VoiceTranscriptTrigger =
  | { eligible: true; source: "human-final" }
  | { eligible: false; source: "ai-final" };

/**
 * Trusted transport metadata for a finalized voice-room utterance. It is kept
 * separate from transcript text so the model cannot mistake microphone speech
 * for an ordinary chat message (or vice versa).
 */
export type VoiceUtteranceOrigin = "microphone-stt" | "typed-voice-fallback" | "ai-tts";

export interface VoiceTranscriptEntry {
  id: string;
  roomId: string;
  sequence: number;
  speakerId: string;
  speakerName: string;
  speakerKind: MemberKind;
  utteranceOrigin: VoiceUtteranceOrigin;
  /** Canonical BCP-47 language reported by STT, when known; never `und`. */
  language?: string;
  text: string;
  startedAt: string;
  endedAt: string;
  final: true;
  heardByPersonaIds: string[];
  trigger: VoiceTranscriptTrigger;
}
