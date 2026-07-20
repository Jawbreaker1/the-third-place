import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ActionResult,
  CatalogUpdatePayload,
  Channel,
  ChannelFeedCard,
  ChannelFeedPublisher,
  ChannelFeedSyncPayload,
  ChannelFeedUpdatePayload,
  ChatMessage,
  DirectorEvent,
  DmThread,
  DmUpdatePayload,
  HistoryPage,
  HumanSessionIdentity,
  ImageAnalysisPayload,
  ImageAttachment,
  ImageMessageResult,
  LinkPreviewPayload,
  Member,
  PresencePayload,
  PublicPreview,
  ReactionPayload,
  RoomSnapshot,
  ServerHealth,
  ToastPayload,
  TypingMemberPayload,
  VoiceCapabilities,
  VoiceCreateResult,
  VoiceInviteBotResult,
  VoiceJoinResult,
  VoiceLeaveResult,
  VoiceRoomView,
  VoiceSignalForward,
  VoiceTranscriptEntry,
} from "../shared/types";
import { findExactMentionRanges, findUrlTextCandidates } from "../shared/unicodeBoundaries";
import { normalizeDisplayName, validDisplayName } from "../shared/displayName";
import { unicodeCaselessKey } from "../shared/unicodeSafety";
import { resolveSnapshotConversationId } from "./channelNavigation";
import { VoicePeerMesh } from "./voicePeer";
import { VoiceActivityDetector, type VoiceActivityEvent } from "./voiceActivity";
import {
  DEFAULT_VOICE_SENSITIVITY,
  normalizeVoiceSensitivity,
  voiceInputMeter,
  voiceSensitivityThresholdMultiplier,
  VOICE_SENSITIVITY_STORAGE_KEY,
  type VoiceInputMeter,
} from "./voiceSensitivity";
import { attachBrowserHumanPresenceActivity, HumanPresenceActivityReporter } from "./humanPresenceActivity";
import { conversationEntryTarget, type ConversationViewport, type PendingConversationEntry } from "./chatScroll";
import { formatSourceDate, linkPreviewAriaLabel, linkPreviewDomainLabel } from "./linkPreview";
import { accountUpgradePrefill } from "./accountUpgradePrefill";
import {
  createBrowserVoicePlaybackController,
  type VoiceAiSpeechPayload,
  type VoicePlaybackController,
} from "./voicePlayback";
import { clearChannelNotice, firstUnreadDmMessageId, noteChannelMessage, type ChannelNotices } from "./unread";
import { reduceTypingPresence, TypingPresenceExpiry } from "./typingPresence";
import {
  channelFeedsFor,
  formatMarketChangePercent,
  formatMarketLevel,
  formatMarketObservationTime,
  marketCardStatus,
  marketDirection,
  syncChannelFeeds,
  upsertChannelFeed,
} from "./channelFeeds";
import { EmojiPicker } from "./EmojiPicker";
import { insertEmojiAtSelection } from "./emoji";
import {
  identityJoinError,
  needsIdentityTakeover,
  returnedRecoveryKey,
  type RecoveryKeyResult,
  type SessionResult,
} from "./returnIdentity";

const CLIENT_CHANNEL_MESSAGE_LIMIT = 600;

type ConnectionState = "preview" | "connecting" | "live" | "reconnecting" | "offline";
type Panel = "rooms" | "people" | null;
type AuthJoinMode = "login" | "register" | "guest" | "legacy";
type AuthSessionResult =
  | { ok: true; me: Member; identity?: HumanSessionIdentity; recoveryKey?: string }
  | {
      ok: false;
      error?: string;
      code?: string;
      recoveryConfigured?: boolean;
      online?: boolean;
      me?: Member;
      identity?: HumanSessionIdentity;
    };
type VoiceJoinState = "idle" | "requesting-permission" | "joining" | "connected" | "reconnecting" | "leaving" | "error";
type VoiceRecordingState = "idle" | "recording" | "uploading" | "error";
type ActiveVoiceCapture = {
  generation: number;
  roomId: string;
  utteranceId: string;
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  discard: boolean;
};
type VoiceUploadJob = {
  generation: number;
  roomId: string;
  utteranceId: string;
  blob: Blob;
  mimeType: string;
};
type ImageDraft = {
  id: string;
  channelId: string;
  source: "file" | "url";
  status: "preparing" | "ready" | "sending" | "error";
  file?: File;
  imageUrl?: string;
  previewUrl?: string;
  label: string;
  error?: string;
};
type EmojiPickerTarget =
  | { kind: "reaction"; messageId: string }
  | { kind: "composer" };

const storedVoiceSensitivity = (): number => {
  if (typeof window === "undefined") return DEFAULT_VOICE_SENSITIVITY;
  try {
    return normalizeVoiceSensitivity(window.localStorage.getItem(VOICE_SENSITIVITY_STORAGE_KEY));
  } catch {
    return DEFAULT_VOICE_SENSITIVITY;
  }
};

const initialVoiceInputMeter = (sensitivity: number): VoiceInputMeter => {
  const detector = new VoiceActivityDetector();
  detector.setThresholdMultiplier(voiceSensitivityThresholdMultiplier(sensitivity));
  return voiceInputMeter(0, detector.snapshot().startThreshold);
};

const Icon = ({ name, size = 18 }: { name: string; size?: number }) => {
  const paths: Record<string, ReactNode> = {
    hash: <><path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    pulse: <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    smile: <><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></>,
    reply: <><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />,
    flag: <><path d="M5 22V4" /><path d="M5 5h11l-2 4 2 4H5" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    spark: <><path d="m12 3 1.3 4.2L17.5 9l-4.2 1.8L12 15l-1.3-4.2L6.5 9l4.2-1.8Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    external: <><path d="M14 5h5v5M13 11l6-6" /><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></>,
    speaker: <><path d="M11 5 6 9H2v6h4l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18 5a9 9 0 0 1 0 14" /></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></>,
    micOff: <><path d="m3 3 18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 8V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.4 2.3M12 18v3M8 21h8" /></>,
    headphones: <><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><path d="M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2ZM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2Z" /></>,
    phoneOff: <><path d="M10.7 13.3a16 16 0 0 0 3.9 2.1l1.7-1.7a2 2 0 0 1 2.1-.4l2.5 1a2 2 0 0 1 1.2 1.8v3a2 2 0 0 1-2 2A18 18 0 0 1 3 4a2 2 0 0 1 2-2h3a2 2 0 0 1 1.8 1.2l1 2.5a2 2 0 0 1-.4 2.1L8.7 9.5" /><path d="m3 3 18 18" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    radio: <><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
};

const resolveAvatarImageUrl = (value?: string) => {
  const candidate = value?.trim();
  if (!candidate) return undefined;

  try {
    const parsed = new URL(candidate, window.location.origin);
    const isSameOriginHttp = parsed.protocol === "http:" && parsed.origin === window.location.origin;
    return parsed.protocol === "https:" || isSameOriginHttp ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

const Avatar = ({ member, size = "md", showStatus = true }: { member: Member; size?: "sm" | "md" | "lg" | "xl"; showStatus?: boolean }) => {
  const imageUrl = resolveAvatarImageUrl(member.avatar.imageUrl);
  const [failedImageUrl, setFailedImageUrl] = useState<string>();
  const showImage = Boolean(imageUrl && failedImageUrl !== imageUrl);

  return (
    <span
      aria-label={`${member.name} avatar${showStatus ? `, ${member.status}` : ""}`}
      className={`avatar avatar-${size}`}
      data-avatar-kind={showImage ? "image" : "glyph"}
      role="img"
      style={{ "--avatar": member.avatar.color, "--accent": member.avatar.accent } as React.CSSProperties}
    >
      <span aria-hidden="true" className="avatar-glyph">{member.avatar.glyph}</span>
      {imageUrl && failedImageUrl !== imageUrl && (
        <img
          alt=""
          className="avatar-image"
          decoding="async"
          draggable={false}
          onError={() => setFailedImageUrl(imageUrl)}
          referrerPolicy="no-referrer"
          src={imageUrl}
        />
      )}
      {showStatus && <i aria-hidden="true" className={`presence presence-${member.status}`} />}
    </span>
  );
};

const BrandMark = ({ large = false }: { large?: boolean }) => (
  <span aria-hidden="true" className={`brand-mark${large ? " large" : ""}`}>
    <img
      alt=""
      decoding="async"
      draggable={false}
      src={large ? "/the-third-place-mark.svg?v=2" : "/favicon.svg?v=2"}
    />
  </span>
);

const AiBadge = ({ label = "AI" }: { label?: string }) => <span className="ai-badge"><Icon name="spark" size={10} />{label}</span>;

const BotBadge = () => <span className="bot-badge"><Icon name="radio" size={10} />BOT</span>;

const FeedAvatar = ({ publisher }: { publisher: ChannelFeedPublisher }) => {
  const imageUrl = resolveAvatarImageUrl(publisher.avatar.imageUrl);
  return (
    <span
      aria-label={`${publisher.name} integration avatar`}
      className="feed-avatar"
      role="img"
      style={{ "--avatar": publisher.avatar.color, "--accent": publisher.avatar.accent } as React.CSSProperties}
    >
      {imageUrl
        ? <img alt="" src={imageUrl} decoding="async" draggable={false} referrerPolicy="no-referrer" />
        : <span aria-hidden="true">{publisher.avatar.glyph}</span>}
    </span>
  );
};

export const ChannelFeedPanelCard = ({ card }: { card: ChannelFeedCard }) => {
  if (card.kind !== "market_ticker") return null;
  const experimental = card.observations.some((observation) => observation.source.experimental);
  const sourceCount = new Set(card.observations.map((observation) => observation.source.id)).size;
  return (
    <article
      aria-label={`${card.publisher.name}: ${card.title}`}
      className={`channel-integration-card channel-feed-${card.state}`}
      data-channel-feed-id={card.id}
    >
      <header className="channel-integration-card-header">
        <FeedAvatar publisher={card.publisher} />
        <div className="channel-integration-card-copy">
          <div className="channel-feed-meta">
            <strong>{card.publisher.name}</strong><BotBadge />
            <time dateTime={card.updatedAt}>{formatRelative(card.updatedAt)}</time>
          </div>
          <div className="channel-integration-title">
            <span>MARKET SNAPSHOT</span>
            <strong>{card.title}</strong>
            <small className="market-ticker-status">{marketCardStatus(card)}</small>
          </div>
        </div>
        <span className={`feed-state feed-state-${card.state}`}>{card.state === "ready" ? "reported" : card.state}</span>
      </header>
      {card.observations.length > 0 && (
        <div className="market-ticker-grid">
          {card.observations.map((observation) => {
            const direction = marketDirection(observation);
            return (
              <a
                href={observation.source.url}
                key={observation.indexId}
                rel="noopener noreferrer nofollow"
                referrerPolicy="no-referrer"
                target="_blank"
                title={`Open ${observation.source.label} source for ${observation.displayName}`}
              >
                <span className="market-name">{observation.shortName}</span>
                <span className="market-value">{formatMarketLevel(observation)}</span>
                <span className={`market-change market-${direction}`}>{direction === "up" ? "▲" : direction === "down" ? "▼" : "•"} {formatMarketChangePercent(observation)}</span>
                <small>{formatMarketObservationTime(observation)}</small>
              </a>
            );
          })}
        </div>
      )}
      <footer>
        <span>Change from previous close · latest reported, not live</span>
        <span>{sourceCount > 0 ? `${sourceCount} validated ${sourceCount === 1 ? "source" : "sources"}` : "Waiting for a validated source"}{experimental ? " · experimental data provider" : ""}</span>
      </footer>
    </article>
  );
};

export const ChannelIntegrationsPanel = ({
  cards,
  collapsed,
  onToggle,
}: {
  cards: ChannelFeedCard[];
  collapsed: boolean;
  onToggle: () => void;
}) => {
  if (cards.length === 0) return null;
  const publisherCount = new Set(cards.map((card) => card.publisher.id)).size;
  const summary = publisherCount === 1
    ? `${cards[0].publisher.name} keeps this room current`
    : `${publisherCount} services keep this room current`;

  return (
    <aside
      aria-label="Room integrations"
      className={`channel-integrations-panel${collapsed ? " collapsed" : ""}`}
      data-channel-integrations
    >
      <div className="channel-integrations-toolbar">
        <span className="channel-integrations-icon"><Icon name="radio" size={15} /></span>
        <div>
          <strong>Room integrations</strong>
          <span>{summary}</span>
        </div>
        <button
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Show" : "Hide"} room integrations`}
          onClick={onToggle}
          type="button"
        >
          <span>{collapsed ? "Show" : "Hide"}</span>
          <Icon name="chevron" size={15} />
        </button>
      </div>
      {!collapsed && (
        <div className="channel-integrations-list">
          {cards.map((card) => <ChannelFeedPanelCard card={card} key={card.id} />)}
        </div>
      )}
    </aside>
  );
};

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

const dayKey = (iso: string) => new Date(iso).toDateString();
const formatDayLabel = (iso: string) => {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
};

const formatRelative = (iso: string) => {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  return formatTime(iso);
};

const compareMessages = (a: ChatMessage, b: ChatMessage) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const boundPublicMessages = (items: ChatMessage[]) => {
  const byChannel = new Map<string, ChatMessage[]>();
  for (const message of items) {
    const channel = byChannel.get(message.channelId) ?? [];
    channel.push(message);
    byChannel.set(message.channelId, channel);
  }
  return [...byChannel.values()]
    .flatMap((channel) => channel.sort(compareMessages).slice(-CLIENT_CHANNEL_MESSAGE_LIMIT))
    .sort(compareMessages);
};

const MessageText = ({ content, members }: { content: string; members: Member[] }) => {
  const names = members.map((member) => member.name).sort((a, b) => b.length - a.length);
  const urls = findUrlTextCandidates(content, { allowHttp: true, allowWww: false, limit: 100 });
  const mentions = findExactMentionRanges(content, names, 100);
  const ranges = [
    ...urls.map((url) => ({ kind: "url" as const, value: url.value, start: url.start, end: url.end })),
    ...mentions.map((mention) => ({ kind: "mention" as const, value: mention.value, start: mention.start, end: mention.end })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: Array<{ kind: "text" | "url" | "mention"; value: string }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push({ kind: "text", value: content.slice(cursor, range.start) });
    parts.push({ kind: range.kind, value: range.value });
    cursor = range.end;
  }
  if (cursor < content.length) parts.push({ kind: "text", value: content.slice(cursor) });
  return (
    <>
      {parts.map((part, partIndex) => {
        if (part.kind === "url") {
          return (
            <bdi dir="ltr" key={`${part.value}-${partIndex}`}>
              <a
                aria-label={`Open external link in a new tab: ${part.value}`}
                className="inline-link"
                href={part.value}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                {part.value}
              </a>
            </bdi>
          );
        }
        if (part.kind === "mention") return <bdi className="mention" dir="auto" key={`${part.value}-${partIndex}`}>{part.value}</bdi>;
        return <span key={`${part.value}-${partIndex}`}>{part.value}</span>;
      })}
    </>
  );
};

type RemoteVoiceAudioProps = {
  memberId: string;
  stream?: MediaStream;
  muted: boolean;
  onAttach: (memberId: string, node: HTMLAudioElement | null) => void;
  onPlaybackState: (memberId: string, blocked: boolean) => void;
};

const RemoteVoiceAudio = ({ memberId, stream, muted, onAttach, onPlaybackState }: RemoteVoiceAudioProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const node = audioRef.current;
    if (!node) return;
    onAttach(memberId, node);
    return () => {
      node.srcObject = null;
      onAttach(memberId, null);
    };
  }, [memberId, onAttach]);

  useEffect(() => {
    const node = audioRef.current;
    if (!node) return;
    let current = true;
    node.srcObject = stream ?? null;
    if (!stream) {
      onPlaybackState(memberId, false);
      return;
    }
    void node.play().then(
      () => { if (current) onPlaybackState(memberId, false); },
      () => { if (current) onPlaybackState(memberId, true); },
    );
    return () => {
      current = false;
      if (node.srcObject === stream) node.srcObject = null;
    };
  }, [memberId, onPlaybackState, stream]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  return (
    <audio
      className="remote-audio"
      autoPlay
      playsInline
      muted={muted}
      ref={audioRef}
      onPlaying={() => onPlaybackState(memberId, false)}
      onError={() => onPlaybackState(memberId, true)}
    />
  );
};

export default function App() {
  const [preview, setPreview] = useState<PublicPreview | null>(null);
  const [me, setMe] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelFeeds, setChannelFeeds] = useState<ChannelFeedCard[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [dmThreads, setDmThreads] = useState<DmThread[]>([]);
  const [directorEvents, setDirectorEvents] = useState<DirectorEvent[]>([]);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("preview");
  const [activeChannelId, setActiveChannelId] = useState("lobby");
  const [composer, setComposer] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [typing, setTyping] = useState<Record<string, string[]>>({});
  const [joinName, setJoinName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authJoinMode, setAuthJoinMode] = useState<AuthJoinMode>("login");
  const [loginHandle, setLoginHandle] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState("");
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [pendingAdultAdmission, setPendingAdultAdmission] = useState<{
    me: Member;
    identity?: HumanSessionIdentity;
  } | null>(null);
  const [sessionIdentity, setSessionIdentity] = useState<HumanSessionIdentity | null>(null);
  const [returnKey, setReturnKey] = useState("");
  const [joinError, setJoinError] = useState("");
  const [joining, setJoining] = useState(false);
  const [takeoverRequired, setTakeoverRequired] = useState(false);
  const [recoveryKeyNotice, setRecoveryKeyNotice] = useState<string | null>(null);
  const [recoveryKeyCopied, setRecoveryKeyCopied] = useState(false);
  const [recoveryKeyCopyHelp, setRecoveryKeyCopyHelp] = useState(false);
  const [returnKeyIssueConfirming, setReturnKeyIssueConfirming] = useState(false);
  const [issuingRecoveryKey, setIssuingRecoveryKey] = useState(false);
  const [upgradeLoginHandle, setUpgradeLoginHandle] = useState("");
  const [upgradePassword, setUpgradePassword] = useState("");
  const [upgradePasswordConfirm, setUpgradePasswordConfirm] = useState("");
  const [upgradeError, setUpgradeError] = useState("");
  const [upgradingAccount, setUpgradingAccount] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showDirector, setShowDirector] = useState(false);
  const [profile, setProfile] = useState<Member | null>(null);
  const [forgettingMemory, setForgettingMemory] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<Panel>(null);
  const [toasts, setToasts] = useState<Array<ToastPayload & { id: number }>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<EmojiPickerTarget | null>(null);
  const [channelNotices, setChannelNotices] = useState<ChannelNotices>({});
  const [unreadDividers, setUnreadDividers] = useState<Record<string, string | undefined>>({});
  const [collapsedIntegrationChannels, setCollapsedIntegrationChannels] = useState<Record<string, boolean>>({});
  const [historyPageInfo, setHistoryPageInfo] = useState<Record<string, { before?: string; hasMore: boolean }>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string | undefined>>({});
  const [imageDrafts, setImageDrafts] = useState<Record<string, ImageDraft | undefined>>({});
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const [imageUrlValue, setImageUrlValue] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [lightbox, setLightbox] = useState<{ attachment: ImageAttachment; authorName: string } | null>(null);
  const [voiceCapabilities, setVoiceCapabilities] = useState<VoiceCapabilities | null>(null);
  const [voiceRooms, setVoiceRooms] = useState<VoiceRoomView[]>([]);
  const [voiceViewRoomId, setVoiceViewRoomId] = useState<string | null>(null);
  const [joinedVoiceRoomId, setJoinedVoiceRoomId] = useState<string | null>(null);
  const [voiceJoinState, setVoiceJoinState] = useState<VoiceJoinState>("idle");
  const [voiceMuted, setVoiceMuted] = useState(true);
  const [voiceDeafened, setVoiceDeafened] = useState(false);
  const [voiceHandsFree, setVoiceHandsFree] = useState(true);
  const [voiceRecording, setVoiceRecording] = useState<VoiceRecordingState>("idle");
  const [voicePendingUploads, setVoicePendingUploads] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceCreateOpen, setVoiceCreateOpen] = useState(false);
  const [voiceAiAudioBlocked, setVoiceAiAudioBlocked] = useState(false);
  const [voiceRemoteAudioBlocked, setVoiceRemoteAudioBlocked] = useState(false);
  const [voiceBrowserSpeech, setVoiceBrowserSpeech] = useState(false);
  const [voiceVadPaused, setVoiceVadPaused] = useState(false);
  const [voiceSensitivity, setVoiceSensitivity] = useState(storedVoiceSensitivity);
  const [voiceMicMeter, setVoiceMicMeter] = useState<VoiceInputMeter>(() => initialVoiceInputMeter(voiceSensitivity));
  const [voiceTranscripts, setVoiceTranscripts] = useState<Record<string, VoiceTranscriptEntry[]>>({});
  const [voiceTypedTurn, setVoiceTypedTurn] = useState("");
  const [voiceInvitingBotId, setVoiceInvitingBotId] = useState<string | null>(null);
  const [voiceInviteExpanded, setVoiceInviteExpanded] = useState(false);
  const [, setRemoteStreamRevision] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const presenceActivityCleanupRef = useRef<(() => void) | null>(null);
  const meRef = useRef<Member | null>(null);
  const activeChannelRef = useRef("lobby");
  const channelsRef = useRef<Channel[]>([]);
  const membersRef = useRef<Member[]>([]);
  const dmThreadsRef = useRef<DmThread[]>([]);
  const typingTimer = useRef<number | undefined>(undefined);
  const typingExpiryRef = useRef<TypingPresenceExpiry | null>(null);
  if (!typingExpiryRef.current) {
    typingExpiryRef.current = new TypingPresenceExpiry((payload) => {
      setTyping((current) => reduceTypingPresence(current, payload));
    });
  }
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldStickToBottom = useRef(true);
  const viewportByConversation = useRef(new Map<string, ConversationViewport>());
  const pendingConversationEntry = useRef<PendingConversationEntry | undefined>(undefined);
  const prependingHistoryChannels = useRef(new Set<string>());
  const historyRequestGeneration = useRef<Record<string, number>>({});
  const historyLoadingChannels = useRef(new Set<string>());
  const historicalMessageIds = useRef(new Set<string>());
  const toastId = useRef(1);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const lightboxCloseRef = useRef<HTMLButtonElement | null>(null);
  const lightboxTriggerRef = useRef<HTMLButtonElement | null>(null);
  const recoveryKeyInputRef = useRef<HTMLInputElement | null>(null);
  const upgradePrefillIdentityRef = useRef<string | null>(null);
  const emojiPickerAnchorRef = useRef<HTMLButtonElement | null>(null);
  const imageObjectUrls = useRef(new Set<string>());
  const localVoiceStreamRef = useRef<MediaStream | null>(null);
  const voiceMeshRef = useRef<VoicePeerMesh | null>(null);
  const joinedVoiceRoomRef = useRef<string | null>(null);
  const voiceJoinGeneration = useRef(0);
  const voiceRemoteStreams = useRef(new Map<string, MediaStream>());
  const voiceRemoteAudio = useRef(new Map<string, HTMLAudioElement>());
  const voiceRemoteAudioBlockedMembers = useRef(new Set<string>());
  const voicePlaybackRef = useRef<VoicePlaybackController | null>(null);
  const voicePlaybackActiveRef = useRef(false);
  const voiceRemoteSpeakingRef = useRef(false);
  const voiceCaptureRef = useRef<ActiveVoiceCapture | null>(null);
  const voiceRestartAfterStopRef = useRef(false);
  const voiceBeginCaptureRef = useRef<() => void>(() => undefined);
  const voiceFinishCaptureRef = useRef<(discard: boolean) => void>(() => undefined);
  const voiceSessionGenerationRef = useRef(0);
  const voiceUploadQueueRef = useRef<VoiceUploadJob[]>([]);
  const voiceUploadRunningRef = useRef(false);
  const voiceUploadAbortRef = useRef<AbortController | null>(null);
  const voiceRecordingTimer = useRef<number | undefined>(undefined);
  const voiceCapabilitiesRef = useRef<VoiceCapabilities | null>(null);
  const voiceDeafenedRef = useRef(false);
  const voiceMutedRef = useRef(true);
  const voiceHandsFreeRef = useRef(true);
  const voiceHasAiListenerRef = useRef(false);
  const voiceRecordingRef = useRef(false);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceActivityRef = useRef(new VoiceActivityDetector());
  const voiceActivityEventRef = useRef<(event: VoiceActivityEvent) => void>(() => undefined);
  const voiceVadFrameRef = useRef<number | undefined>(undefined);
  const voiceVadSpeakingRef = useRef(false);
  const voiceSensitivityRef = useRef(voiceSensitivity);
  const voiceMicRmsRef = useRef(0);
  const voiceMicMeterPaintAtRef = useRef(0);
  const voiceInvitingBotIdRef = useRef<string | null>(null);
  const voiceAudioBlocked = voiceAiAudioBlocked || voiceRemoteAudioBlocked;
  voiceHasAiListenerRef.current = voiceRooms.some(
    (room) => room.id === joinedVoiceRoomId && room.participants.some((participant) => participant.kind === "ai"),
  );
  voiceRemoteSpeakingRef.current = voiceRooms.some(
    (room) => room.id === joinedVoiceRoomId && room.participants.some(
      (participant) => participant.kind === "human" && participant.memberId !== me?.id && participant.speaking,
    ),
  );
  voiceSensitivityRef.current = voiceSensitivity;

  const captureCurrentViewport = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")];
    const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > scrollerRect.top + 1);
    const messageId = firstVisible?.dataset.messageId;
    if (!firstVisible || !messageId) return;
    viewportByConversation.current.set(activeChannelRef.current, {
      messageId,
      offsetTop: firstVisible.getBoundingClientRect().top - scrollerRect.top,
      atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 110,
    });
  }, []);

  const queueConversationEntry = useCallback((channelId: string, firstUnreadMessageId?: string) => {
    const target = conversationEntryTarget(
      channelId,
      firstUnreadMessageId,
      viewportByConversation.current.get(channelId),
    );
    pendingConversationEntry.current = target;
    shouldStickToBottom.current = target.kind === "bottom";
    if (firstUnreadMessageId) {
      setUnreadDividers((current) => ({ ...current, [channelId]: firstUnreadMessageId }));
    }
  }, []);

  const getVoicePlayback = useCallback((): VoicePlaybackController => {
    voicePlaybackRef.current ??= createBrowserVoicePlaybackController({
      onAutoplayBlocked: setVoiceAiAudioBlocked,
      onModeChanged: (mode) => setVoiceBrowserSpeech(mode === "browser"),
      onPlaybackActive: (active) => { voicePlaybackActiveRef.current = active; },
      onUnavailable: (_speech, reason) => {
        if (reason === "browser fallback disabled") {
          setVoiceError("AI speech audio is unavailable on this server; the transcript is still shown.");
        }
      },
    });
    return voicePlaybackRef.current;
  }, []);

  const setRemoteAudioPlaybackState = useCallback((memberId: string, blocked: boolean) => {
    if (blocked) voiceRemoteAudioBlockedMembers.current.add(memberId);
    else voiceRemoteAudioBlockedMembers.current.delete(memberId);
    setVoiceRemoteAudioBlocked(voiceRemoteAudioBlockedMembers.current.size > 0);
  }, []);

  const attachRemoteVoiceAudio = useCallback((memberId: string, node: HTMLAudioElement | null) => {
    if (node) voiceRemoteAudio.current.set(memberId, node);
    else {
      voiceRemoteAudio.current.delete(memberId);
      voiceRemoteAudioBlockedMembers.current.delete(memberId);
      setVoiceRemoteAudioBlocked(voiceRemoteAudioBlockedMembers.current.size > 0);
    }
  }, []);

  const revokeDraftPreview = useCallback((draft?: ImageDraft) => {
    if (!draft?.previewUrl || !imageObjectUrls.current.has(draft.previewUrl)) return;
    URL.revokeObjectURL(draft.previewUrl);
    imageObjectUrls.current.delete(draft.previewUrl);
  }, []);

  const clearPrivateSessionState = useCallback(() => {
    dmThreadsRef.current = [];
    setDmThreads([]);
    setReplyTo(null);
    setComposer("");
    setUnreadDividers({});
    setLightbox(null);
    setSearch("");
    setImageUrlOpen(false);
    setImageUrlValue("");
    setImageDrafts((current) => {
      for (const draft of Object.values(current)) revokeDraftPreview(draft);
      return {};
    });
    viewportByConversation.current.clear();
    pendingConversationEntry.current = undefined;
    const fallbackId = channelsRef.current.find((channel) => channel.id === "lobby")?.id
      ?? channelsRef.current[0]?.id
      ?? "lobby";
    activeChannelRef.current = fallbackId;
    setActiveChannelId(fallbackId);
  }, [revokeDraftPreview]);

  useEffect(() => () => {
    for (const url of imageObjectUrls.current) URL.revokeObjectURL(url);
    imageObjectUrls.current.clear();
  }, []);

  const pushToast = useCallback((toast: ToastPayload) => {
    const id = toastId.current++;
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4_500);
  }, []);

  const upsertVoiceRoom = useCallback((room: VoiceRoomView) => {
    setVoiceRooms((current) => {
      const exists = current.some((candidate) => candidate.id === room.id);
      return exists ? current.map((candidate) => candidate.id === room.id ? room : candidate) : [...current, room];
    });
  }, []);

  const ensureVoiceVadRunning = useCallback(async (): Promise<boolean> => {
    const context = voiceAudioContextRef.current;
    if (!context || context.state === "closed") return false;
    try {
      if (context.state === "suspended") await context.resume();
    } catch {
      // Safari may require a fresh user gesture after permission/backgrounding.
    }
    const running = context.state === "running";
    setVoiceVadPaused(!running);
    return running;
  }, []);

  const stopVoiceVad = useCallback(() => {
    if (voiceVadFrameRef.current !== undefined) cancelAnimationFrame(voiceVadFrameRef.current);
    voiceVadFrameRef.current = undefined;
    for (const event of voiceActivityRef.current.reset(performance.now())) voiceActivityEventRef.current(event);
    const context = voiceAudioContextRef.current;
    voiceAudioContextRef.current = null;
    if (context) context.onstatechange = null;
    if (context && context.state !== "closed") void context.close();
    voiceMicRmsRef.current = 0;
    setVoiceMicMeter(voiceInputMeter(0, voiceActivityRef.current.snapshot().startThreshold));
    setVoiceVadPaused(false);
  }, []);

  const startVoiceVad = useCallback((stream: MediaStream) => {
    stopVoiceVad();
    if (!("AudioContext" in window)) return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.62;
    // Remove mains and desk rumble from activity detection only. Peers and STT
    // continue receiving the unfiltered microphone track.
    const highPass = context.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = 80;
    highPass.Q.value = Math.SQRT1_2;
    context.createMediaStreamSource(stream).connect(highPass).connect(analyser);
    voiceAudioContextRef.current = context;
    context.onstatechange = () => setVoiceVadPaused(context.state !== "running" && context.state !== "closed");
    // Keep the detector's conservative defaults. Neural speech validation on
    // the server remains authoritative, while this browser gate only decides
    // when to cut a recording segment.
    voiceActivityRef.current = new VoiceActivityDetector();
    voiceActivityRef.current.setThresholdMultiplier(
      voiceSensitivityThresholdMultiplier(voiceSensitivityRef.current),
    );
    const samples = new Float32Array(analyser.fftSize);
    const sample = () => {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const value of samples) energy += value * value;
      const rms = Math.sqrt(energy / samples.length);
      const now = performance.now();
      const playbackActive = voicePlaybackActiveRef.current || voiceRemoteSpeakingRef.current;
      const events = voiceActivityRef.current.push({
        nowMs: now,
        rms,
        suppressed: !joinedVoiceRoomRef.current || voiceMutedRef.current || voiceDeafenedRef.current,
        playbackActive,
      });
      for (const event of events) {
        voiceActivityEventRef.current(event);
      }
      voiceMicRmsRef.current = rms;
      // React does not need audio-rate updates. A short throttle plus the CSS
      // transition keeps the meter legible without rerendering the app at RAF speed.
      if (now - voiceMicMeterPaintAtRef.current >= 90 || events.length > 0) {
        voiceMicMeterPaintAtRef.current = now;
        const snapshot = voiceActivityRef.current.snapshot(playbackActive);
        setVoiceMicMeter(voiceInputMeter(rms, snapshot.startThreshold));
      }
      voiceVadFrameRef.current = requestAnimationFrame(sample);
    };
    void ensureVoiceVadRunning();
    voiceVadFrameRef.current = requestAnimationFrame(sample);
  }, [ensureVoiceVadRunning, stopVoiceVad]);

  const changeVoiceSensitivity = (value: number) => {
    const next = normalizeVoiceSensitivity(value);
    setVoiceSensitivity(next);
    voiceSensitivityRef.current = next;
    try {
      window.localStorage.setItem(VOICE_SENSITIVITY_STORAGE_KEY, String(next));
    } catch {
      // Private browsing or storage policy can make localStorage unavailable.
    }
    voiceActivityRef.current.setThresholdMultiplier(voiceSensitivityThresholdMultiplier(next));
    const snapshot = voiceActivityRef.current.snapshot(
      voicePlaybackActiveRef.current || voiceRemoteSpeakingRef.current,
    );
    setVoiceMicMeter(voiceInputMeter(voiceMicRmsRef.current, snapshot.startThreshold));
  };

  const clearVoiceMedia = useCallback(() => {
    voiceSessionGenerationRef.current += 1;
    voiceUploadAbortRef.current?.abort();
    voiceUploadAbortRef.current = null;
    voiceUploadQueueRef.current = [];
    voiceRestartAfterStopRef.current = false;
    setVoicePendingUploads(0);
    if (voiceRecordingTimer.current) window.clearTimeout(voiceRecordingTimer.current);
    voiceRecordingTimer.current = undefined;
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (capture?.recorder && capture.recorder.state !== "inactive") {
      capture.recorder.ondataavailable = null;
      capture.recorder.onstop = null;
      capture.recorder.onerror = null;
      capture.recorder.stop();
    }
    stopVoiceVad();
    voiceMeshRef.current?.close();
    voiceMeshRef.current = null;
    for (const track of localVoiceStreamRef.current?.getTracks() ?? []) track.stop();
    localVoiceStreamRef.current = null;
    for (const audio of voiceRemoteAudio.current.values()) audio.srcObject = null;
    voiceRemoteAudio.current.clear();
    voiceRemoteAudioBlockedMembers.current.clear();
    voiceRemoteStreams.current.clear();
    voicePlaybackRef.current?.reset();
    setVoiceAiAudioBlocked(false);
    setVoiceRemoteAudioBlocked(false);
    setVoiceBrowserSpeech(false);
    setRemoteStreamRevision((value) => value + 1);
    voiceMutedRef.current = true;
    voiceRecordingRef.current = false;
    voicePlaybackActiveRef.current = false;
    voiceInvitingBotIdRef.current = null;
    setVoiceInvitingBotId(null);
    setVoiceRecording("idle");
  }, [stopVoiceVad]);

  const createVoiceMesh = useCallback((room: VoiceRoomView, memberId: string, stream?: MediaStream) => {
    voiceMeshRef.current?.close();
    const mesh = new VoicePeerMesh({
      roomId: room.id,
      localMemberId: memberId,
      revision: room.revision,
      iceServers: voiceCapabilitiesRef.current?.iceServers ?? [],
      localStream: stream,
      onSignal: (message) => socketRef.current?.emit("voice:signal", message),
      onRemoteStream: (remoteMemberId, remoteStream) => {
        if (remoteStream) voiceRemoteStreams.current.set(remoteMemberId, remoteStream);
        else voiceRemoteStreams.current.delete(remoteMemberId);
        setRemoteStreamRevision((value) => value + 1);
      },
      onConnectionState: (_remotePeerId, state) => {
        if (state === "failed") setVoiceError("A voice connection failed. Reconnecting…");
      },
    });
    voiceMeshRef.current = mesh;
    mesh.setInputEnabled(!voiceMutedRef.current && !voiceDeafenedRef.current);
    mesh.syncPeers(room.participants.filter((participant) => participant.kind === "human").map((participant) => participant.memberId), room.revision);
  }, []);

  const describeMicrophoneError = (error: unknown): string => {
    if (!(error instanceof DOMException)) return "The microphone could not be opened.";
    if (error.name === "NotAllowedError") return "Microphone access was denied. Allow it in this site's browser settings.";
    if (error.name === "NotFoundError") return "No microphone was found.";
    if (error.name === "NotReadableError" || error.name === "AbortError") return "The microphone is busy or unavailable.";
    if (error.name === "SecurityError") return "Voice requires HTTPS or localhost.";
    return "The microphone could not be opened.";
  };

  const acquireVoiceStream = useCallback(async (): Promise<MediaStream> => {
    if (localVoiceStreamRef.current?.active) return localVoiceStreamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone capture.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Automatic gain can turn quiet fans and keyboard clicks into apparent
        // foreground speech. Echo/noise suppression remain enabled, while the
        // server performs the language-neutral speech decision.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        video: false,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "OverconstrainedError") {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        throw error;
      }
    }
    for (const track of stream.getAudioTracks()) {
      track.enabled = false;
      track.onended = () => {
        if (localVoiceStreamRef.current === stream) localVoiceStreamRef.current = null;
        setVoiceMuted(true);
        voiceMutedRef.current = true;
        voiceMeshRef.current?.setInputEnabled(false);
        stopVoiceVad();
        voiceFinishCaptureRef.current(true);
        if (joinedVoiceRoomRef.current) socketRef.current?.emit("voice:self-state", {
          roomId: joinedVoiceRoomRef.current,
          muted: true,
          deafened: voiceDeafenedRef.current,
          speaking: false,
        });
        setVoiceError("The microphone was disconnected.");
      };
    }
    localVoiceStreamRef.current = stream;
    startVoiceVad(stream);
    return stream;
  }, [startVoiceVad, stopVoiceVad]);

  const playVoiceAiSpeech = useCallback((speech: VoiceAiSpeechPayload) => {
    if (speech.roomId !== joinedVoiceRoomRef.current || voiceDeafenedRef.current) return;
    getVoicePlayback().enqueue(speech);
  }, [getVoicePlayback]);

  const acknowledgeDmRead = useCallback((threadId: string, messageId?: string) => {
    socketRef.current?.emit("dm:read", {
      threadId,
      ...(messageId ? { messageId } : {}),
    });
    setDmThreads((current) => {
      let changed = false;
      const next = current.map((thread) => {
        if (thread.id !== threadId || thread.unread === 0) return thread;
        changed = true;
        return { ...thread, unread: 0 };
      });
      if (changed) dmThreadsRef.current = next;
      return changed ? next : current;
    });
  }, []);

  const applySnapshot = useCallback((snapshot: RoomSnapshot) => {
    const previousActiveId = activeChannelRef.current;
    const nextActiveId = resolveSnapshotConversationId(
      previousActiveId,
      snapshot.channels.map((channel) => channel.id),
      snapshot.dmThreads.map((thread) => thread.id),
    );
    if (nextActiveId && nextActiveId !== previousActiveId) {
      activeChannelRef.current = nextActiveId;
      setActiveChannelId(nextActiveId);
      setReplyTo(null);
      setComposer("");
      setUnreadDividers((current) => {
        if (!(previousActiveId in current)) return current;
        const next = { ...current };
        delete next[previousActiveId];
        return next;
      });
      setChannelNotices((current) => {
        const next = { ...current };
        delete next[previousActiveId];
        return clearChannelNotice(next, nextActiveId);
      });
      setImageDrafts((current) => {
        const draft = current[previousActiveId];
        if (!draft) return current;
        revokeDraftPreview(draft);
        const next = { ...current };
        delete next[previousActiveId];
        return next;
      });
    }
    typingExpiryRef.current?.clear();
    setTyping({});
    shouldStickToBottom.current = true;
    meRef.current = snapshot.me;
    setMe(snapshot.me);
    setSessionIdentity(snapshot.identity);
    membersRef.current = snapshot.members;
    setMembers(snapshot.members);
    channelsRef.current = snapshot.channels;
    setChannels(snapshot.channels);
    setChannelFeeds(snapshot.channelFeeds ?? []);
    setMessages(snapshot.messages);
    setHistoryPageInfo(snapshot.historyPageInfo ?? {});
    dmThreadsRef.current = snapshot.dmThreads;
    setDmThreads(snapshot.dmThreads);
    setHealth(snapshot.health);
    setDirectorEvents(snapshot.directorEvents);
    setConnection("live");
  }, [revokeDraftPreview]);

  const connectSocket = useCallback(() => {
    presenceActivityCleanupRef.current?.();
    presenceActivityCleanupRef.current = null;
    socketRef.current?.disconnect();
    setConnection("connecting");
    let socket!: Socket;
    const presenceReporter = new HumanPresenceActivityReporter(
      (payload) => {
        if (!socket?.connected) return false;
        socket.emit("presence:activity", payload);
        return true;
      },
      () => document.visibilityState === "visible",
    );
    socket = io({
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnection: true,
      auth: (authorize) => authorize({ presence: presenceReporter.snapshot() }),
    });
    socketRef.current = socket;
    presenceActivityCleanupRef.current = attachBrowserHumanPresenceActivity(socket, presenceReporter);

    socket.on("room:snapshot", (snapshot: RoomSnapshot) => {
      if (socketRef.current === socket) applySnapshot(snapshot);
    });
    socket.on("message:new", (message: ChatMessage) => {
      const activeChannelId = activeChannelRef.current;
      const activeChannelIsRead = message.channelId !== activeChannelId || shouldStickToBottom.current;
      setMessages((current) =>
        current.some((item) => item.id === message.id) ? current : boundPublicMessages([...current, message]),
      );
      setChannelNotices((current) => noteChannelMessage(
        current,
        message,
        activeChannelId,
        meRef.current,
        activeChannelIsRead,
      ));
      if (
        message.channelId === activeChannelId &&
        !activeChannelIsRead &&
        message.authorId !== meRef.current?.id
      ) {
        setUnreadDividers((current) => current[message.channelId]
          ? current
          : { ...current, [message.channelId]: message.id });
      }
    });
    socket.on("channel-feed:update", (payload: ChannelFeedUpdatePayload) => {
      setChannelFeeds((current) => upsertChannelFeed(current, payload.card));
    });
    socket.on("channel-feed:sync", (payload: ChannelFeedSyncPayload) => {
      setChannelFeeds(syncChannelFeeds(payload.cards));
    });
    socket.on("reaction:update", (payload: ReactionPayload) => {
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== payload.messageId) return message;
          const reactions = message.reactions.filter((reaction) => reaction.emoji !== payload.reaction.emoji);
          if (payload.reaction.memberIds.length > 0) reactions.push(payload.reaction);
          return { ...message, reactions };
        }),
      );
    });
    socket.on("link-preview:update", (payload: LinkPreviewPayload) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === payload.messageId && message.channelId === payload.channelId
            ? { ...message, linkPreview: payload.linkPreview }
            : message,
        ),
      );
      if (payload.channelId === activeChannelRef.current && shouldStickToBottom.current) {
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      }
    });
    socket.on("image-analysis:update", (payload: ImageAnalysisPayload) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === payload.messageId && message.channelId === payload.channelId
            ? {
                ...message,
                attachments: message.attachments?.map((attachment) =>
                  attachment.id === payload.attachmentId ? { ...attachment, analysis: payload.analysis } : attachment,
                ),
              }
            : message,
        ),
      );
      setDmThreads((current) => {
        const next = current.map((thread) => thread.id !== payload.channelId
          ? thread
          : {
              ...thread,
              messages: thread.messages.map((message) => message.id !== payload.messageId
                ? message
                : {
                    ...message,
                    attachments: message.attachments?.map((attachment) =>
                      attachment.id === payload.attachmentId
                        ? { ...attachment, analysis: payload.analysis }
                        : attachment,
                    ),
                  }),
            });
        dmThreadsRef.current = next;
        return next;
      });
      setLightbox((current) => current?.attachment.id === payload.attachmentId
        ? { ...current, attachment: { ...current.attachment, analysis: payload.analysis } }
        : current);
      if (payload.channelId === activeChannelRef.current && shouldStickToBottom.current) {
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      }
    });
    socket.on("voice:rooms:update", (payload: VoiceRoomView[] | { rooms: VoiceRoomView[] }) => {
      setVoiceRooms(Array.isArray(payload) ? payload : payload.rooms);
    });
    socket.on("voice:room:update", (room: VoiceRoomView) => {
      upsertVoiceRoom(room);
      if (room.id === joinedVoiceRoomRef.current) {
        voiceMeshRef.current?.syncPeers(
          room.participants.filter((participant) => participant.kind === "human").map((participant) => participant.memberId),
          room.revision,
        );
      }
    });
    socket.on("voice:room:closed", (payload: string | { roomId: string }) => {
      const roomId = typeof payload === "string" ? payload : payload.roomId;
      setVoiceRooms((current) => current.filter((room) => room.id !== roomId));
      setVoiceViewRoomId((current) => current === roomId ? null : current);
      if (joinedVoiceRoomRef.current === roomId) {
        clearVoiceMedia();
        joinedVoiceRoomRef.current = null;
        setJoinedVoiceRoomId(null);
        setVoiceJoinState("idle");
        pushToast({ tone: "info", title: "Voice room closed", message: "The last human left the room." });
      }
    });
    socket.on("voice:signal", (payload: VoiceSignalForward) => void voiceMeshRef.current?.handleSignal(payload));
    socket.on("voice:transcript:final", (entry: VoiceTranscriptEntry) => {
      setVoiceTranscripts((current) => ({
        ...current,
        [entry.roomId]: [...(current[entry.roomId] ?? []).slice(-7), entry],
      }));
    });
    socket.on("voice:transcript:history", (entries: VoiceTranscriptEntry[]) => {
      const byRoom = new Map<string, VoiceTranscriptEntry[]>();
      for (const entry of entries) byRoom.set(entry.roomId, [...(byRoom.get(entry.roomId) ?? []), entry]);
      if (byRoom.size > 0) {
        setVoiceTranscripts((current) => ({
          ...current,
          ...Object.fromEntries([...byRoom].map(([roomId, roomEntries]) => [roomId, roomEntries.slice(-8)])),
        }));
      }
    });
    socket.on("voice:ai-speech", playVoiceAiSpeech);
    socket.on("voice:ai-stop", (payload: { roomId: string }) => {
      if (payload.roomId !== joinedVoiceRoomRef.current) return;
      voicePlaybackRef.current?.stop();
      setVoiceAiAudioBlocked(false);
      setVoiceBrowserSpeech(false);
    });
    socket.on("voice:bot:state", (payload: { roomId: string; memberId: string; botState: VoiceRoomView["participants"][number]["botState"]; speaking?: boolean }) => {
      setVoiceRooms((current) => current.map((room) => room.id !== payload.roomId ? room : {
        ...room,
        participants: room.participants.map((participant) => participant.memberId === payload.memberId
          ? { ...participant, botState: payload.botState, speaking: payload.speaking ?? participant.speaking }
          : participant),
      }));
    });
    socket.on("presence:update", (payload: PresencePayload) => {
      membersRef.current = payload.members;
      setMembers(payload.members);
      const currentMe = meRef.current;
      const nextMe = currentMe && payload.members.find((member) => member.id === currentMe.id);
      if (nextMe) {
        meRef.current = nextMe;
        setMe(nextMe);
      }
      setProfile((current) => {
        if (!current) return current;
        const next = payload.members.find((member) => member.id === current.id);
        if (next) return next;
        return current.kind === "human" ? { ...current, status: "offline" } : current;
      });
    });
    socket.on("catalog:update", (payload: CatalogUpdatePayload) => {
      const activeId = activeChannelRef.current;
      const activePublicRoomWasRemoved = channelsRef.current.some((channel) => channel.id === activeId)
        && !payload.channels.some((channel) => channel.id === activeId);
      const activeDmThread = dmThreadsRef.current.find((thread) => thread.id === activeId);
      const nextMemberIds = new Set(payload.members.map((member) => member.id));
      const removedAiIds = new Set(
        membersRef.current
          .filter((member) => member.kind === "ai" && !nextMemberIds.has(member.id))
          .map((member) => member.id),
      );
      const activeDmResidentWasRemoved = Boolean(activeDmThread && removedAiIds.has(activeDmThread.peerId));

      channelsRef.current = payload.channels;
      setChannels(payload.channels);
      membersRef.current = payload.members;
      setMembers(payload.members);
      // Registered humans remain in the catalog while offline. Only remove a
      // DM when a previously known AI resident has actually left the cast.
      const survivingThreads = dmThreadsRef.current.filter((thread) => !removedAiIds.has(thread.peerId));
      dmThreadsRef.current = survivingThreads;
      setDmThreads(survivingThreads);
      setProfile((current) => current
        ? payload.members.find((member) => member.id === current.id) ?? null
        : null);

      if (activePublicRoomWasRemoved || activeDmResidentWasRemoved) {
        const fallbackId = resolveSnapshotConversationId(
          activeId,
          payload.channels.map((channel) => channel.id),
          survivingThreads.map((thread) => thread.id),
        );
        if (fallbackId) {
          shouldStickToBottom.current = true;
          activeChannelRef.current = fallbackId;
          setActiveChannelId(fallbackId);
          setReplyTo(null);
          setComposer("");
          setMobilePanel(null);
          setChannelNotices((current) => clearChannelNotice(current, fallbackId));
          setImageDrafts((current) => {
            const draft = current[activeId];
            if (!draft) return current;
            revokeDraftPreview(draft);
            const next = { ...current };
            delete next[activeId];
            return next;
          });
          const fallbackChannel = payload.channels.find((channel) => channel.id === fallbackId);
          pushToast({
            tone: "info",
            title: activeDmResidentWasRemoved ? "Conversation closed" : "Room changed",
            message: activeDmResidentWasRemoved
              ? "That AI resident was removed by an administrator. Existing history remains on the server."
              : fallbackChannel
                ? `That room changed. You were moved to #${fallbackChannel.name}.`
                : "That room changed. You were moved to another conversation.",
          });
        }
      }
    });
    socket.on("typing:member", (payload: TypingMemberPayload) => {
      typingExpiryRef.current?.observe(payload);
      setTyping((current) => reduceTypingPresence(current, payload));
    });
    socket.on("director:event", (event: DirectorEvent) => setDirectorEvents((current) => [...current.slice(-23), event]));
    socket.on("health:update", (nextHealth: ServerHealth) => setHealth(nextHealth));
    socket.on("dm:update", (payload: DmUpdatePayload) => {
      const activeChannelId = activeChannelRef.current;
      const activeThreadIsRead = payload.thread.id === activeChannelId
        && shouldStickToBottom.current
        && document.visibilityState === "visible";
      const nextThread = activeThreadIsRead
        ? { ...payload.thread, unread: 0 }
        : payload.thread;
      setDmThreads((current) => {
        const exists = current.some((thread) => thread.id === payload.thread.id);
        const next = exists
          ? current.map((thread) => (thread.id === payload.thread.id ? nextThread : thread))
          : [...current, nextThread];
        dmThreadsRef.current = next;
        return next;
      });
      if (activeThreadIsRead) {
        acknowledgeDmRead(payload.thread.id, payload.message?.id ?? payload.thread.messages.at(-1)?.id);
      }
      if (
        payload.message &&
        payload.thread.id === activeChannelId &&
        !activeThreadIsRead &&
        payload.message.authorId !== meRef.current?.id
      ) {
        setUnreadDividers((current) => current[payload.thread.id]
          ? current
          : { ...current, [payload.thread.id]: payload.message!.id });
      }
    });
    socket.on("dm:read:update", (payload: { thread: DmThread }) => {
      if (!payload.thread?.id) return;
      setDmThreads((current) => {
        const exists = current.some((thread) => thread.id === payload.thread.id);
        const next = exists
          ? current.map((thread) => thread.id === payload.thread.id ? payload.thread : thread)
          : [...current, payload.thread];
        dmThreadsRef.current = next;
        return next;
      });
    });
    socket.on("dm:removed", (payload: { threadId: string }) => {
      const threadId = payload.threadId;
      if (!threadId) return;

      const removedThread = dmThreadsRef.current.find((thread) => thread.id === threadId);
      const removedMessageIds = new Set(removedThread?.messages.map((message) => message.id) ?? []);
      const removedAttachmentIds = new Set(
        removedThread?.messages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) ?? []) ?? [],
      );
      const wasActive = activeChannelRef.current === threadId;

      // Remove the conversation synchronously from the ref as well as React
      // state so a following socket event cannot still treat it as available.
      dmThreadsRef.current = dmThreadsRef.current.filter((thread) => thread.id !== threadId);
      setDmThreads((current) => current.filter((thread) => thread.id !== threadId));
      setTyping((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setUnreadDividers((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setChannelNotices((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setImageDrafts((current) => {
        const draft = current[threadId];
        if (!draft) return current;
        revokeDraftPreview(draft);
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setReplyTo((current) => wasActive || current?.channelId === threadId ? null : current);
      setEmojiPickerTarget((current) => wasActive
        || (current?.kind === "reaction" && removedMessageIds.has(current.messageId))
        ? null
        : current);
      setLightbox((current) => current && removedAttachmentIds.has(current.attachment.id) ? null : current);
      setProfile((current) => current?.id === removedThread?.peerId ? null : current);

      viewportByConversation.current.delete(threadId);
      if (pendingConversationEntry.current?.channelId === threadId) pendingConversationEntry.current = undefined;
      historyRequestGeneration.current[threadId] = (historyRequestGeneration.current[threadId] ?? 0) + 1;
      historyLoadingChannels.current.delete(threadId);
      prependingHistoryChannels.current.delete(threadId);
      for (const messageId of removedMessageIds) historicalMessageIds.current.delete(messageId);
      setHistoryPageInfo((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setHistoryLoading((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setHistoryError((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });

      if (!wasActive) return;

      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      typingTimer.current = undefined;
      setComposer("");
      setSearch("");
      setImageUrlOpen(false);
      setImageUrlValue("");
      dragDepth.current = 0;
      setDragActive(false);
      setMobilePanel(null);

      const fallback = channelsRef.current.find((channel) => channel.id === "lobby")
        ?? channelsRef.current[0];
      if (!fallback) return;
      queueConversationEntry(fallback.id);
      activeChannelRef.current = fallback.id;
      setActiveChannelId(fallback.id);
      setChannelNotices((current) => clearChannelNotice(current, fallback.id));
      pushToast({
        tone: "info",
        title: "Private conversation removed",
        message: `A participant's saved identity was deleted. You were moved to #${fallback.name}.`,
      });
    });
    socket.on("toast", pushToast);
    socket.on("session:upgraded", () => {
      // The upgrade response installs a new HttpOnly cookie and reconnects the
      // initiating tab. Every socket admitted under the old guest credential
      // must stop here instead of inheriting the account session.
      if (socketRef.current !== socket) {
        socket.disconnect();
        return;
      }
      clearVoiceMedia();
      clearPrivateSessionState();
      joinedVoiceRoomRef.current = null;
      setJoinedVoiceRoomId(null);
      setVoiceJoinState("idle");
      meRef.current = null;
      setMe(null);
      setSessionIdentity(null);
      setProfile(null);
      setConnection("preview");
      setAuthJoinMode("login");
      presenceActivityCleanupRef.current?.();
      presenceActivityCleanupRef.current = null;
      socket.disconnect();
    });
    socket.on("session:ended", () => {
      if (socketRef.current !== socket) return;
      clearVoiceMedia();
      clearPrivateSessionState();
      joinedVoiceRoomRef.current = null;
      setJoinedVoiceRoomId(null);
      setVoiceJoinState("idle");
      meRef.current = null;
      setMe(null);
      setSessionIdentity(null);
      setProfile(null);
      setConnection("preview");
      setAuthJoinMode("login");
      presenceActivityCleanupRef.current?.();
      presenceActivityCleanupRef.current = null;
      socket.disconnect();
    });
    socket.on("session:moderated", (payload: { action: "kick" | "ban" | "forget" | "recover"; message?: string }) => {
      if (socketRef.current !== socket) return;
      if (payload.action === "recover") {
        const currentIdentity = meRef.current;
        if (currentIdentity) setJoinName(currentIdentity.name);
        setAuthJoinMode("legacy");
        setJoinError("");
        setTakeoverRequired(false);
      }
      pushToast({
        tone: "warning",
        title: payload.action === "recover"
          ? "Identity moved"
          : payload.action === "forget"
          ? "Saved identity removed"
          : payload.action === "ban"
            ? "Access removed"
            : "Disconnected by an administrator",
        message: payload.message ?? (payload.action === "recover"
          ? "This saved identity was opened in another browser. You can return here again with its return key."
          : payload.action === "forget"
          ? "Your saved profile and private history were removed."
          : payload.action === "ban"
            ? "You have been banned from this room."
            : "You can reconnect after a short cooldown."),
      });
      clearVoiceMedia();
      clearPrivateSessionState();
      joinedVoiceRoomRef.current = null;
      setJoinedVoiceRoomId(null);
      setVoiceJoinState("idle");
      meRef.current = null;
      setMe(null);
      setSessionIdentity(null);
      setConnection("preview");
      presenceActivityCleanupRef.current?.();
      presenceActivityCleanupRef.current = null;
      socket.disconnect();
    });
    socket.on("disconnect", (reason) => {
      if (socketRef.current !== socket) return;
      typingExpiryRef.current?.clear();
      setTyping({});
      voiceInvitingBotIdRef.current = null;
      setVoiceInvitingBotId(null);
      if (reason !== "io client disconnect") setConnection("reconnecting");
      if (reason !== "io client disconnect" && joinedVoiceRoomRef.current) setVoiceJoinState("reconnecting");
      if (reason !== "io client disconnect" && meRef.current) {
        const disconnectedMe: Member = { ...meRef.current, status: "offline" };
        meRef.current = disconnectedMe;
        setMe(disconnectedMe);
        setProfile((current) => current?.id === disconnectedMe.id ? disconnectedMe : current);
      }
    });
    socket.on("connect", () => {
      if (socketRef.current !== socket) return;
      setConnection((current) => (current === "live" ? current : "connecting"));
      const roomId = joinedVoiceRoomRef.current;
      const member = meRef.current;
      if (!roomId || !member) return;
      socket.emit("voice:room:join", { roomId }, (result: VoiceJoinResult) => {
        if (!result.ok) {
          setVoiceJoinState("error");
          setVoiceError(result.error);
          return;
        }
        voiceCapabilitiesRef.current = result.capabilities;
        setVoiceCapabilities(result.capabilities);
        upsertVoiceRoom(result.room);
        createVoiceMesh(result.room, member.id, localVoiceStreamRef.current ?? undefined);
        setVoiceJoinState("connected");
      });
    });
    socket.on("connect_error", (error) => {
      if (socketRef.current !== socket) return;
      if (["AUTH_REQUIRED", "BANNED", "KICK_COOLDOWN"].includes(error.message)) {
        clearPrivateSessionState();
        setMe(null);
        meRef.current = null;
        clearVoiceMedia();
        joinedVoiceRoomRef.current = null;
        setJoinedVoiceRoomId(null);
        setVoiceJoinState("idle");
        setConnection("preview");
        presenceActivityCleanupRef.current?.();
        presenceActivityCleanupRef.current = null;
        socket.disconnect();
        if (error.message !== "AUTH_REQUIRED") {
          pushToast({
            tone: "warning",
            title: error.message === "BANNED" ? "Access removed" : "Reconnect cooldown",
            message: error.message === "BANNED"
              ? "This identity has been banned from the room."
              : "An administrator disconnected this identity for a short cooldown.",
          });
        }
      } else {
        setConnection("offline");
      }
    });
  }, [acknowledgeDmRead, applySnapshot, clearPrivateSessionState, clearVoiceMedia, createVoiceMesh, playVoiceAiSpeech, pushToast, queueConversationEntry, revokeDraftPreview, upsertVoiceRoom]);

  useEffect(() => {
    let alive = true;
    void fetch("/api/preview")
      .then((response) => response.json())
      .then((data: PublicPreview) => {
        if (!alive) return;
        setPreview(data);
        // `/api/preview` and `/api/session` start together. Once an
        // authenticated socket owns the screen, a slower anonymous preview
        // must not replace its newer snapshot or feed revisions.
        if (meRef.current) return;
        setMembers(data.members);
        channelsRef.current = data.channels;
        setChannels(data.channels);
        setChannelFeeds(data.channelFeeds ?? []);
        setMessages(data.messages);
        setHealth(data.health);
      })
      .catch(() => setConnection("offline"));
    void fetch("/api/session")
      .then(async (response) => {
        const result = await response.json().catch(() => null) as AuthSessionResult | null;
        if (!alive) return;
        if (response.status === 428 && result && !result.ok &&
            result.code === "ADULT_CONFIRMATION_REQUIRED" && result.me) {
          setPendingAdultAdmission({ me: result.me, identity: result.identity });
          setJoinName(result.me.name);
          return;
        }
        if (!response.ok) return;
        if (!result?.ok || !alive) return;
        if (result.identity) setSessionIdentity(result.identity);
        connectSocket();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      typingExpiryRef.current?.clear();
      if (joinedVoiceRoomRef.current) socketRef.current?.emit("voice:room:leave", { roomId: joinedVoiceRoomRef.current });
      clearVoiceMedia();
      presenceActivityCleanupRef.current?.();
      presenceActivityCleanupRef.current = null;
      socketRef.current?.disconnect();
    };
  }, [clearVoiceMedia, connectSocket]);

  useEffect(() => {
    const next = accountUpgradePrefill(
      { identityId: upgradePrefillIdentityRef.current, handle: upgradeLoginHandle },
      me && sessionIdentity && sessionIdentity.kind !== "registered"
        ? { id: me.id, name: me.name }
        : null,
    );
    upgradePrefillIdentityRef.current = next.identityId;
    if (next.handle !== upgradeLoginHandle) setUpgradeLoginHandle(next.handle);
  }, [me, sessionIdentity, upgradeLoginHandle]);

  useEffect(() => {
    if (!profile || !me || profile.id !== me.id) {
      setReturnKeyIssueConfirming(false);
      setUpgradePassword("");
      setUpgradePasswordConfirm("");
      setUpgradeError("");
    }
  }, [me, profile]);

  useEffect(() => {
    if (!recoveryKeyNotice) return;
    const frame = requestAnimationFrame(() => {
      recoveryKeyInputRef.current?.focus();
      recoveryKeyInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [recoveryKeyNotice]);

  useEffect(() => {
    const acknowledgeVisibleThread = () => {
      if (document.visibilityState !== "visible" || !shouldStickToBottom.current) return;
      const thread = dmThreadsRef.current.find((candidate) => candidate.id === activeChannelRef.current);
      if (thread?.unread) acknowledgeDmRead(thread.id, thread.messages.at(-1)?.id);
    };
    document.addEventListener("visibilitychange", acknowledgeVisibleThread);
    return () => document.removeEventListener("visibilitychange", acknowledgeVisibleThread);
  }, [acknowledgeDmRead]);

  useEffect(() => {
    if (document.visibilityState !== "visible" || !shouldStickToBottom.current) return;
    const thread = dmThreads.find((candidate) => candidate.id === activeChannelId);
    if (thread?.unread) acknowledgeDmRead(thread.id, thread.messages.at(-1)?.id);
  }, [acknowledgeDmRead, activeChannelId, dmThreads]);

  useEffect(() => {
    if (!me || connection !== "live" || !channelsRef.current.some((channel) => channel.id === activeChannelId)) return;
    const reportFocusedChannel = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      socketRef.current?.emit("channel:focus", { channelId: activeChannelId });
    };
    reportFocusedChannel();
    const timer = window.setInterval(reportFocusedChannel, 60_000);
    window.addEventListener("focus", reportFocusedChannel);
    document.addEventListener("visibilitychange", reportFocusedChannel);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reportFocusedChannel);
      document.removeEventListener("visibilitychange", reportFocusedChannel);
    };
  }, [activeChannelId, connection, me]);

  useEffect(() => {
    const onPageHide = () => {
      const roomId = joinedVoiceRoomRef.current;
      if (roomId) socketRef.current?.emit("voice:room:leave", { roomId });
      clearVoiceMedia();
      joinedVoiceRoomRef.current = null;
      setJoinedVoiceRoomId(null);
      setVoiceJoinState("idle");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [clearVoiceMedia]);

  const memberMap = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const activeThread = dmThreads.find((thread) => thread.id === activeChannelId);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId);
  const activePeer = activeThread ? memberMap.get(activeThread.peerId) : undefined;
  const foldedSearch = useMemo(() => unicodeCaselessKey(search.trim()), [search]);
  const activeMessages = useMemo(() => {
    const source = activeThread ? activeThread.messages : messages.filter((message) => message.channelId === activeChannelId);
    if (!foldedSearch) return source;
    return source.filter((message) => unicodeCaselessKey(message.content).includes(foldedSearch));
  }, [activeChannelId, activeThread, foldedSearch, messages]);
  const activeChannelFeeds = useMemo(
    () => activeThread || foldedSearch ? [] : channelFeedsFor(channelFeeds, activeChannelId),
    [activeChannelId, activeThread, channelFeeds, foldedSearch],
  );
  const integrationsCollapsed = collapsedIntegrationChannels[activeChannelId] ?? false;
  const activeTitle = activeChannel?.name ?? activePeer?.name ?? "conversation";
  const activeDescription = activeChannel?.description ?? (activePeer?.kind === "ai" ? "Private chat with an AI resident" : "Private conversation");
  const typingMembers = (typing[activeChannelId] ?? []).map((id) => memberMap.get(id)).filter((member): member is Member => Boolean(member));
  const activeHistory = historyPageInfo[activeChannelId] ?? { hasMore: false };
  const pendingImage = imageDrafts[activeChannelId];
  const canAttachImage = Boolean(me && (activeChannel || activeThread));
  const voiceRoomInView = voiceRooms.find((room) => room.id === voiceViewRoomId);
  const joinedVoiceRoom = voiceRooms.find((room) => room.id === joinedVoiceRoomId);
  const voiceRoomTranscripts = voiceRoomInView ? voiceTranscripts[voiceRoomInView.id] ?? [] : [];
  const voiceBotIdsInOtherRooms = new Set(
    voiceRooms
      .filter((room) => room.id !== voiceRoomInView?.id)
      .flatMap((room) => room.participants.filter((participant) => participant.kind === "ai").map((participant) => participant.memberId)),
  );
  const availableVoiceBots = members.filter((member) =>
    member.kind === "ai" &&
    !voiceRoomInView?.participants.some((participant) => participant.memberId === member.id) &&
    !voiceBotIdsInOtherRooms.has(member.id),
  );
  const voiceBotLimit = voiceCapabilities?.maxBots ?? 2;
  const voiceBotCount = voiceRoomInView?.participants.filter((participant) => participant.kind === "ai").length ?? 0;
  const voiceBotSlotsRemaining = Math.max(0, voiceBotLimit - voiceBotCount);
  const displayedVoiceBots = voiceInviteExpanded ? availableVoiceBots : availableVoiceBots.slice(0, 8);
  const voicePanelMembers = voiceRoomInView?.participants.map((participant) => memberMap.get(participant.memberId)).filter((member): member is Member => Boolean(member)) ?? [];
  const voiceSensitivityCopy = voiceSensitivity < 34
    ? "Low pickup"
    : voiceSensitivity > 66
      ? "High pickup"
      : "Balanced";
  const voiceMicDetected = !voiceMuted && (voiceMicMeter.aboveThreshold || voiceRecording === "recording");
  const voiceMicStatus = voiceMuted
    ? "Muted"
    : !localVoiceStreamRef.current?.active
      ? "No microphone"
      : voiceMicDetected
        ? "Voice detected"
        : "Below speech threshold";

  useEffect(() => setVoiceInviteExpanded(false), [voiceViewRoomId]);

  const updateImageDraft = useCallback((channelId: string, draft: ImageDraft | undefined) => {
    setImageDrafts((current) => {
      const previous = current[channelId];
      if (previous?.previewUrl !== draft?.previewUrl) revokeDraftPreview(previous);
      return { ...current, [channelId]: draft };
    });
  }, [revokeDraftPreview]);

  const removeImageDraft = useCallback((channelId = activeChannelRef.current) => {
    setImageDrafts((current) => {
      revokeDraftPreview(current[channelId]);
      return { ...current, [channelId]: undefined };
    });
  }, [revokeDraftPreview]);

  const queueImageFile = useCallback((file: File, channelId = activeChannelRef.current) => {
    const conversationExists = channels.some((channel) => channel.id === channelId)
      || dmThreadsRef.current.some((thread) => thread.id === channelId);
    if (!me || !conversationExists) {
      pushToast({ tone: "warning", title: "Conversation unavailable", message: "Open a room or private conversation before attaching an image." });
      return;
    }
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) {
      pushToast({ tone: "warning", title: "Image not supported", message: "Choose a JPEG, PNG or WebP image." });
      return;
    }
    if (file.size === 0 || file.size > 8 * 1024 * 1024) {
      pushToast({ tone: "warning", title: "Image too large", message: "Images can be at most 8 MB." });
      return;
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const previewUrl = URL.createObjectURL(file);
    imageObjectUrls.current.add(previewUrl);
    updateImageDraft(channelId, { id, channelId, source: "file", status: "ready", file, previewUrl, label: file.name || "Pasted image" });
  }, [channels, me, pushToast, updateImageDraft]);

  const queueImageUrl = useCallback((raw: string, channelId = activeChannelRef.current): boolean => {
    const conversationExists = channels.some((channel) => channel.id === channelId)
      || dmThreadsRef.current.some((thread) => thread.id === channelId);
    if (!me || !conversationExists) {
      pushToast({ tone: "warning", title: "Conversation unavailable", message: "Open a room or private conversation before attaching an image." });
      return false;
    }
    try {
      const url = new URL(raw.trim());
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe");
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      updateImageDraft(channelId, {
        id,
        channelId,
        source: "url",
        status: "ready",
        imageUrl: url.toString(),
        label: url.hostname,
      });
      setImageUrlOpen(false);
      setImageUrlValue("");
      return true;
    } catch {
      pushToast({ tone: "warning", title: "Not a direct image link", message: "Paste a complete HTTPS image URL." });
      return false;
    }
  }, [channels, me, pushToast, updateImageDraft]);

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = [...event.clipboardData.items]
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (image) {
      event.preventDefault();
      queueImageFile(image);
      return;
    }
    const text = event.clipboardData.getData("text/plain").trim();
    if (/^https:\/\/\S+\.(?:jpe?g|png|webp)(?:[?#]\S*)?$/i.test(text)) {
      event.preventDefault();
      queueImageUrl(text);
    }
  };

  const handleImageUrlKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      queueImageUrl(imageUrlValue);
    }
    if (event.key === "Escape") {
      setImageUrlOpen(false);
      setImageUrlValue("");
    }
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!canAttachImage || voiceViewRoomId) return;
    if (!event.dataTransfer.types.includes("Files") && !event.dataTransfer.types.includes("text/uri-list")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canAttachImage || voiceViewRoomId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!canAttachImage || voiceViewRoomId) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!canAttachImage || voiceViewRoomId) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith("image/"));
    if (file) {
      queueImageFile(file);
      return;
    }
    const imageUrl = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#"))
      ?? event.dataTransfer.getData("text/plain");
    if (imageUrl) queueImageUrl(imageUrl);
  };

  const closeLightbox = useCallback(() => {
    setLightbox(null);
    requestAnimationFrame(() => lightboxTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    lightboxCloseRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeLightbox, lightbox]);

  const loadOlderMessages = useCallback(async () => {
    const channelId = activeChannelId;
    const pageInfo = historyPageInfo[channelId];
    if (
      !me ||
      activeThread ||
      search.trim() ||
      !pageInfo?.hasMore ||
      !pageInfo.before ||
      historyLoadingChannels.current.has(channelId)
    ) {
      return;
    }
    const requestGeneration = (historyRequestGeneration.current[channelId] ?? 0) + 1;
    historyRequestGeneration.current[channelId] = requestGeneration;
    historyLoadingChannels.current.add(channelId);
    prependingHistoryChannels.current.add(channelId);
    setHistoryLoading((current) => ({ ...current, [channelId]: true }));
    setHistoryError((current) => ({ ...current, [channelId]: undefined }));

    const scroller = scrollRef.current;
    const scrollerTop = scroller?.getBoundingClientRect().top;
    const anchor = scroller && scrollerTop !== undefined
      ? [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((row) => row.getBoundingClientRect().bottom > scrollerTop + 1)
      : undefined;
    const anchorId = anchor?.dataset.messageId;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const oldScrollHeight = scroller?.scrollHeight ?? 0;
    const oldScrollTop = scroller?.scrollTop ?? 0;

    try {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/messages?before=${encodeURIComponent(pageInfo.before)}&limit=40`,
      );
      const result = (await response.json()) as
        | { ok: true; page: HistoryPage }
        | { ok: false; error?: string };
      if (!response.ok || !result.ok) throw new Error(!result.ok ? result.error ?? "History unavailable" : "History unavailable");
      if (historyRequestGeneration.current[channelId] !== requestGeneration) {
        prependingHistoryChannels.current.delete(channelId);
        return;
      }
      for (const message of result.page.messages) historicalMessageIds.current.add(message.id);
      setMessages((current) => {
        const merged = new Map(current.map((message) => [message.id, message]));
        for (const message of result.page.messages) merged.set(message.id, message);
        return boundPublicMessages([...merged.values()]);
      });
      setHistoryPageInfo((current) => ({
        ...current,
        [channelId]: { before: result.page.before, hasMore: result.page.hasMore },
      }));

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (activeChannelRef.current === channelId && scrollRef.current) {
            const nextScroller = scrollRef.current;
            const nextAnchor = anchorId
              ? nextScroller.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`)
              : undefined;
            if (nextAnchor && anchorTop !== undefined) {
              nextScroller.scrollTop += nextAnchor.getBoundingClientRect().top - anchorTop;
            } else {
              nextScroller.scrollTop = oldScrollTop + (nextScroller.scrollHeight - oldScrollHeight);
            }
          }
          prependingHistoryChannels.current.delete(channelId);
        });
      });
    } catch (error) {
      prependingHistoryChannels.current.delete(channelId);
      setHistoryError((current) => ({
        ...current,
        [channelId]: error instanceof Error ? error.message : "Could not load older messages.",
      }));
    } finally {
      historyLoadingChannels.current.delete(channelId);
      setHistoryLoading((current) => ({ ...current, [channelId]: false }));
    }
  }, [activeChannelId, activeThread, historyPageInfo, me, search]);

  useLayoutEffect(() => {
    const pending = pendingConversationEntry.current;
    const scroller = scrollRef.current;
    if (!pending || pending.channelId !== activeChannelId || !scroller || foldedSearch) return;

    if (pending.kind === "message") {
      const target = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((row) => row.dataset.messageId === pending.messageId);
      if (target) {
        const scrollerTop = scroller.getBoundingClientRect().top;
        scroller.scrollTop += target.getBoundingClientRect().top - scrollerTop - pending.offsetTop;
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }

    shouldStickToBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 110;
    pendingConversationEntry.current = undefined;
  }, [activeChannelId, activeMessages.length, foldedSearch]);

  useEffect(() => {
    if (prependingHistoryChannels.current.has(activeChannelId)) return;
    if (foldedSearch) return;
    if (!shouldStickToBottom.current) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
  }, [activeMessages.length, activeChannelId, foldedSearch]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Compact layout, the software keyboard, reply banners and attachments
      // can all change the viewport without adding a message. Preserve the
      // bottom anchor only when the reader was already following the latest
      // messages; never pull someone down while they are reading history.
      if (!shouldStickToBottom.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = scrollRef.current;
        if (current && shouldStickToBottom.current) current.scrollTop = current.scrollHeight;
      });
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const submitIdentityJoin = async (takeOver = false) => {
    if (joining) return;
    if (!adultConfirmed) {
      setJoinError("Confirm that you are 18 or older to enter this adult community.");
      return;
    }
    setJoinError("");
    setJoining(true);
    try {
      const endpoint = authJoinMode === "login"
        ? "/api/auth/login"
        : authJoinMode === "register"
          ? "/api/auth/register"
          : authJoinMode === "legacy"
            ? "/api/session/recover"
            : "/api/session";
      const body = authJoinMode === "login"
        ? { loginHandle, password: accountPassword, inviteCode: inviteCode || undefined, adultConfirmed }
        : authJoinMode === "register"
          ? { loginHandle, displayName: joinName, password: accountPassword, inviteCode: inviteCode || undefined, adultConfirmed }
          : authJoinMode === "legacy"
            ? {
              name: joinName,
              recoveryKey: returnKey,
              inviteCode: inviteCode || undefined,
              takeOver: takeOver || undefined,
              adultConfirmed,
            }
            : { name: joinName, inviteCode: inviteCode || undefined, adultConfirmed };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as AuthSessionResult | null;
      if (!response.ok || !result?.ok) {
        if (!takeOver && result && needsIdentityTakeover(
          authJoinMode === "legacy" ? "returning" : "new",
          response.status,
          result as SessionResult<Member>,
        )) {
          setTakeoverRequired(true);
          return;
        }
        setTakeoverRequired(false);
        setJoinError(
          authJoinMode === "legacy"
            ? identityJoinError("returning", result as SessionResult<Member> | null)
            : authJoinMode === "guest"
              ? identityJoinError("new", result as SessionResult<Member> | null)
              : result && !result.ok && result.error
                ? result.error
                : authJoinMode === "login"
                  ? "That username and password did not match."
                  : "The local account could not be created.",
        );
        return;
      }
      const issuedKey = returnedRecoveryKey(result);
      if (issuedKey) {
        setRecoveryKeyCopied(false);
        setRecoveryKeyCopyHelp(false);
        setRecoveryKeyNotice(issuedKey);
      }
      setTakeoverRequired(false);
      setSessionIdentity(result.identity ?? {
        kind: authJoinMode === "login" || authJoinMode === "register" ? "registered" : authJoinMode === "legacy" ? "legacy" : "guest",
        ...(authJoinMode === "login" || authJoinMode === "register" ? { loginHandle, adultConfirmed: true } : {}),
      });
      setAccountPassword("");
      setAccountPasswordConfirm("");
      setReturnKey("");
      connectSocket();
    } catch {
      setJoinError("The room is unreachable right now.");
    } finally {
      setJoining(false);
    }
  };

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (authJoinMode === "register" && (
      !loginHandle.trim() || [...accountPassword].length < 8 || accountPassword !== accountPasswordConfirm
    )) return;
    void submitIdentityJoin(false);
  };

  const confirmPendingAdultAdmission = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingAdultAdmission || joining) return;
    if (!adultConfirmed) {
      setJoinError("Confirm that you are 18 or older to enter this adult community.");
      return;
    }
    setJoinError("");
    setJoining(true);
    try {
      const response = await fetch("/api/session/adult-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ adultConfirmed }),
      });
      const result = await response.json().catch(() => null) as AuthSessionResult | null;
      if (!response.ok || !result?.ok) {
        throw new Error(result && !result.ok && result.error
          ? result.error
          : "The community age acknowledgement could not be saved.");
      }
      setSessionIdentity(result.identity ?? pendingAdultAdmission.identity ?? { kind: "guest" });
      setPendingAdultAdmission(null);
      connectSocket();
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "The room is unreachable right now.");
    } finally {
      setJoining(false);
    }
  };

  const selectAuthJoinMode = (mode: AuthJoinMode) => {
    if (authJoinMode === mode) return;
    if (authJoinMode === "legacy") setReturnKey("");
    setAuthJoinMode(mode);
    setJoinError("");
    setTakeoverRequired(false);
  };

  const issueRecoveryKey = async () => {
    if (issuingRecoveryKey) return;
    setIssuingRecoveryKey(true);
    try {
      const response = await fetch("/api/session/recovery-key", {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const result = await response.json().catch(() => null) as RecoveryKeyResult | null;
      const issuedKey = returnedRecoveryKey(result);
      if (!response.ok || !issuedKey) {
        throw new Error(result && !result.ok ? result.error : undefined);
      }
      setReturnKeyIssueConfirming(false);
      setRecoveryKeyCopied(false);
      setRecoveryKeyCopyHelp(false);
      setRecoveryKeyNotice(issuedKey);
    } catch (error) {
      pushToast({
        tone: "warning",
        title: "Return key not created",
        message: error instanceof Error && error.message ? error.message : "Try again in a moment.",
      });
    } finally {
      setIssuingRecoveryKey(false);
    }
  };

  const copyRecoveryKey = async () => {
    if (!recoveryKeyNotice) return;
    try {
      await navigator.clipboard.writeText(recoveryKeyNotice);
      setRecoveryKeyCopied(true);
      setRecoveryKeyCopyHelp(false);
    } catch {
      recoveryKeyInputRef.current?.focus();
      recoveryKeyInputRef.current?.select();
      setRecoveryKeyCopyHelp(true);
    }
  };

  const closeRecoveryKeyNotice = () => {
    setRecoveryKeyNotice(null);
    setRecoveryKeyCopied(false);
    setRecoveryKeyCopyHelp(false);
  };

  const forgetAiMemory = async () => {
    if (forgettingMemory) return;
    setForgettingMemory(true);
    try {
      const response = await fetch("/api/session/memory", {
        method: "DELETE",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || result?.ok === false) {
        throw new Error(result?.error ?? "The saved memory could not be cleared.");
      }
      setProfile(null);
      pushToast({
        tone: "success",
        title: "AI memory cleared",
        message: "The residents will treat your next visit as a fresh start.",
      });
    } catch (error) {
      pushToast({
        tone: "warning",
        title: "Memory not cleared",
        message: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setForgettingMemory(false);
    }
  };

  const upgradeCurrentIdentity = async (event: FormEvent) => {
    event.preventDefault();
    if (upgradingAccount || sessionIdentity?.kind === "registered") return;
    if (!upgradeLoginHandle.trim() || [...upgradePassword].length < 8 || upgradePassword !== upgradePasswordConfirm) {
      setUpgradeError("Choose a username and enter the same password twice (at least 8 characters).");
      return;
    }
    setUpgradeError("");
    setUpgradingAccount(true);
    try {
      const response = await fetch("/api/auth/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ loginHandle: upgradeLoginHandle, password: upgradePassword }),
      });
      const result = await response.json().catch(() => null) as AuthSessionResult | null;
      if (!response.ok || !result?.ok || result.identity?.kind !== "registered") {
        throw new Error(result && !result.ok && result.error
          ? result.error
          : "The local account could not be created.");
      }
      setSessionIdentity(result.identity);
      meRef.current = result.me;
      setMe(result.me);
      setProfile(null);
      setUpgradePassword("");
      setUpgradePasswordConfirm("");
      setUpgradeError("");
      pushToast({
        tone: "success",
        title: "Identity kept",
        message: "Your relationships, private conversations and history now belong to this local account.",
      });
      connectSocket();
    } catch (error) {
      setUpgradeError(error instanceof Error ? error.message : "Try again in a moment.");
    } finally {
      setUpgradingAccount(false);
    }
  };

  const logOut = async () => {
    if (loggingOut || !sessionIdentity) return;
    setLoggingOut(true);
    try {
      const response = await fetch("/api/session", {
        method: "DELETE",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok && response.status !== 401 && response.status !== 404) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "The session could not be closed.");
      }
      socketRef.current?.disconnect();
      window.location.reload();
    } catch (error) {
      pushToast({
        tone: "warning",
        title: "Could not leave",
        message: error instanceof Error ? error.message : "Try again in a moment.",
      });
      setLoggingOut(false);
    }
  };

  const startVoiceRoom = () => {
    if (!socketRef.current || !me || !activeChannel) return;
    if (joinedVoiceRoomRef.current) {
      pushToast({ tone: "warning", title: "Already in voice", message: "Leave your current voice room before starting another." });
      return;
    }
    setVoiceCreateOpen(false);
    setVoiceJoinState("joining");
    setVoiceError(null);
    socketRef.current.emit("voice:room:create", { channelId: activeChannel.id }, (result: VoiceCreateResult) => {
      if (!result.ok) {
        setVoiceJoinState("error");
        setVoiceError(result.error);
        return;
      }
      voiceCapabilitiesRef.current = result.capabilities;
      setVoiceCapabilities(result.capabilities);
      joinedVoiceRoomRef.current = result.room.id;
      setJoinedVoiceRoomId(result.room.id);
      setVoiceViewRoomId(result.room.id);
      setVoiceMuted(true);
      voiceMutedRef.current = true;
      setVoiceDeafened(false);
      voiceDeafenedRef.current = false;
      socketRef.current?.emit("voice:self-state", { roomId: result.room.id, muted: true, deafened: false, speaking: false }, (stateResult: VoiceInviteBotResult) => {
        const finalRoom = stateResult.ok ? stateResult.room : result.room;
        upsertVoiceRoom(finalRoom);
        createVoiceMesh(finalRoom, me.id);
        setVoiceJoinState("connected");
        setMobilePanel(null);
      });
    });
  };

  const joinVoiceRoom = async (room: VoiceRoomView, withMicrophone: boolean) => {
    if (!socketRef.current || !me) return;
    if (!("RTCPeerConnection" in window)) {
      setVoiceError("This browser does not support WebRTC voice rooms.");
      return;
    }
    if (joinedVoiceRoomRef.current && joinedVoiceRoomRef.current !== room.id) {
      pushToast({ tone: "warning", title: "Already in voice", message: "Leave your current voice room before joining another." });
      return;
    }
    if (joinedVoiceRoomRef.current === room.id) {
      setVoiceViewRoomId(room.id);
      return;
    }
    const generation = ++voiceJoinGeneration.current;
    let stream: MediaStream | undefined;
    if (withMicrophone) {
      setVoiceJoinState("requesting-permission");
      try {
        stream = await acquireVoiceStream();
      } catch (error) {
        if (generation !== voiceJoinGeneration.current) return;
        setVoiceJoinState("error");
        setVoiceError(describeMicrophoneError(error));
        return;
      }
    }
    if (generation !== voiceJoinGeneration.current) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (stream && stream === localVoiceStreamRef.current) {
        localVoiceStreamRef.current = null;
        stopVoiceVad();
      }
      return;
    }
    setVoiceJoinState("joining");
    setVoiceError(null);
    socketRef.current.emit("voice:room:join", { roomId: room.id }, (result: VoiceJoinResult) => {
      if (generation !== voiceJoinGeneration.current) return;
      if (!result.ok) {
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (stream === localVoiceStreamRef.current) {
          localVoiceStreamRef.current = null;
          stopVoiceVad();
        }
        setVoiceJoinState("error");
        setVoiceError(result.error);
        return;
      }
      voiceCapabilitiesRef.current = result.capabilities;
      setVoiceCapabilities(result.capabilities);
      joinedVoiceRoomRef.current = result.room.id;
      setJoinedVoiceRoomId(result.room.id);
      setVoiceViewRoomId(result.room.id);
      const initialMuted = !stream;
      setVoiceMuted(initialMuted);
      voiceMutedRef.current = initialMuted;
      setVoiceDeafened(false);
      voiceDeafenedRef.current = false;
      socketRef.current?.emit("voice:self-state", { roomId: result.room.id, muted: initialMuted, deafened: false, speaking: false }, (stateResult: VoiceInviteBotResult) => {
        const finalRoom = stateResult.ok ? stateResult.room : result.room;
        upsertVoiceRoom(finalRoom);
        createVoiceMesh(finalRoom, me.id, stream);
        setVoiceJoinState("connected");
        setMobilePanel(null);
      });
    });
  };

  const leaveVoiceRoom = useCallback(() => {
    const roomId = joinedVoiceRoomRef.current;
    if (!roomId) return;
    voiceJoinGeneration.current += 1;
    setVoiceJoinState("leaving");
    socketRef.current?.emit("voice:room:leave", { roomId }, (result: VoiceLeaveResult) => {
      if (result.ok) {
        if (result.closed) setVoiceRooms((current) => current.filter((room) => room.id !== result.roomId));
        else upsertVoiceRoom(result.room);
      }
    });
    clearVoiceMedia();
    joinedVoiceRoomRef.current = null;
    setJoinedVoiceRoomId(null);
    setVoiceMuted(true);
    voiceMutedRef.current = true;
    setVoiceDeafened(false);
    voiceDeafenedRef.current = false;
    setVoiceError(null);
    setVoiceJoinState("idle");
  }, [clearVoiceMedia, upsertVoiceRoom]);

  const toggleVoiceMute = async () => {
    if (!joinedVoiceRoomRef.current) return;
    const nextMuted = !voiceMuted;
    if (!nextMuted && voiceDeafenedRef.current) return;
    if (!nextMuted && !localVoiceStreamRef.current) {
      setVoiceJoinState("requesting-permission");
      try {
        const stream = await acquireVoiceStream();
        await voiceMeshRef.current?.setLocalStream(stream);
      } catch (error) {
        setVoiceJoinState("connected");
        setVoiceError(describeMicrophoneError(error));
        return;
      }
    }
    setVoiceMuted(nextMuted);
    voiceMutedRef.current = nextMuted;
    voiceMeshRef.current?.setInputEnabled(!nextMuted && !voiceDeafenedRef.current);
    if (!nextMuted) void ensureVoiceVadRunning();
    else {
      for (const event of voiceActivityRef.current.push({ nowMs: performance.now(), rms: 0, suppressed: true })) {
        voiceActivityEventRef.current(event);
      }
    }
    socketRef.current?.emit("voice:self-state", { roomId: joinedVoiceRoomRef.current, muted: nextMuted, deafened: voiceDeafenedRef.current, speaking: false });
    setVoiceJoinState("connected");
  };

  const toggleVoiceDeafen = () => {
    const next = !voiceDeafened;
    setVoiceDeafened(next);
    voiceDeafenedRef.current = next;
    if (next) {
      setVoiceMuted(true);
      voiceMutedRef.current = true;
      voiceMeshRef.current?.setInputEnabled(false);
      for (const event of voiceActivityRef.current.push({ nowMs: performance.now(), rms: 0, suppressed: true })) {
        voiceActivityEventRef.current(event);
      }
    }
    for (const audio of voiceRemoteAudio.current.values()) audio.muted = next;
    getVoicePlayback().setDeafened(next);
    if (next) {
      voiceRemoteAudioBlockedMembers.current.clear();
      setVoiceAiAudioBlocked(false);
      setVoiceRemoteAudioBlocked(false);
      setVoiceBrowserSpeech(false);
    }
    if (joinedVoiceRoomRef.current) {
      socketRef.current?.emit("voice:self-state", { roomId: joinedVoiceRoomRef.current, muted: next ? true : voiceMutedRef.current, deafened: next, speaking: false });
    }
  };

  const enableVoiceSound = async () => {
    if (voiceDeafenedRef.current) return;
    const remoteEntries = [...voiceRemoteAudio.current.entries()];
    const remoteRetry = Promise.allSettled(remoteEntries.map(async ([, audio]) => {
      audio.muted = false;
      await audio.play();
    }));
    const [remoteResults] = await Promise.all([remoteRetry, getVoicePlayback().retryBlocked()]);
    voiceRemoteAudioBlockedMembers.current.clear();
    remoteResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const memberId = remoteEntries[index]?.[0];
        if (memberId) voiceRemoteAudioBlockedMembers.current.add(memberId);
      }
    });
    setVoiceRemoteAudioBlocked(voiceRemoteAudioBlockedMembers.current.size > 0);
  };

  const pumpVoiceUploads = useCallback(async () => {
    if (voiceUploadRunningRef.current) return;
    voiceUploadRunningRef.current = true;
    try {
      while (voiceUploadQueueRef.current.length > 0) {
        const job = voiceUploadQueueRef.current.shift();
        if (!job || job.generation !== voiceSessionGenerationRef.current) continue;
        setVoicePendingUploads(voiceUploadQueueRef.current.length + 1);
        if (!voiceCaptureRef.current) setVoiceRecording("uploading");
        const abort = new AbortController();
        voiceUploadAbortRef.current = abort;
        const form = new FormData();
        form.set("audio", job.blob, `voice-turn.${job.mimeType.includes("mp4") ? "m4a" : job.mimeType.includes("ogg") ? "ogg" : "webm"}`);
        form.set("utteranceId", job.utteranceId);
        try {
          const response = await fetch(`/api/voice/${encodeURIComponent(job.roomId)}/turns`, {
            method: "POST",
            body: form,
            credentials: "same-origin",
            signal: abort.signal,
          });
          const result = (await response.json()) as { ok: boolean; error?: string };
          if (!response.ok || !result.ok) throw new Error(result.error ?? "The voice turn could not be transcribed.");
        } catch (error) {
          if (!abort.signal.aborted && job.generation === voiceSessionGenerationRef.current) {
            setVoiceRecording("error");
            setVoiceError(error instanceof Error ? error.message : "The voice turn could not be transcribed.");
          }
        } finally {
          if (voiceUploadAbortRef.current === abort) voiceUploadAbortRef.current = null;
        }
      }
    } finally {
      voiceUploadRunningRef.current = false;
      setVoicePendingUploads(0);
      if (!voiceCaptureRef.current) setVoiceRecording((current) => current === "error" ? current : "idle");
    }
  }, []);

  const queueVoiceUpload = useCallback((job: VoiceUploadJob) => {
    if (voiceUploadQueueRef.current.length >= 4) {
      setVoiceRecording("error");
      setVoiceError("Voice transcription is falling behind. Pause for a moment so the room can catch up.");
      return;
    }
    voiceUploadQueueRef.current.push(job);
    setVoicePendingUploads(voiceUploadQueueRef.current.length + (voiceUploadRunningRef.current ? 1 : 0));
    void pumpVoiceUploads();
  }, [pumpVoiceUploads]);

  const finishVoiceCapture = useCallback((discard: boolean) => {
    const capture = voiceCaptureRef.current;
    if (!capture) return;
    capture.discard ||= discard;
    if (voiceRecordingTimer.current) window.clearTimeout(voiceRecordingTimer.current);
    voiceRecordingTimer.current = undefined;
    if (capture.recorder.state === "recording") capture.recorder.stop();
  }, []);

  voiceFinishCaptureRef.current = finishVoiceCapture;

  const beginVoiceCapture = useCallback(() => {
    const roomId = joinedVoiceRoomRef.current;
    const stream = localVoiceStreamRef.current;
    if (
      !roomId || !stream?.active || voiceCaptureRef.current || !voiceHandsFreeRef.current ||
      voiceMutedRef.current || voiceDeafenedRef.current || !voiceHasAiListenerRef.current ||
      !voiceCapabilitiesRef.current?.speechToText || !("MediaRecorder" in window)
    ) return;

    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/webm",
      "audio/mp4",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    try {
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const generation = voiceSessionGenerationRef.current;
      const capture: ActiveVoiceCapture = {
        generation,
        roomId,
        utteranceId: crypto.randomUUID(),
        recorder,
        chunks: [],
        bytes: 0,
        startedAt: performance.now(),
        discard: false,
      };
      voiceCaptureRef.current = capture;
      recorder.ondataavailable = (event) => {
        if (!event.data.size || voiceCaptureRef.current !== capture) return;
        capture.chunks.push(event.data);
        capture.bytes += event.data.size;
        if (capture.bytes > 6 * 1024 * 1024 && recorder.state === "recording") {
          capture.discard = true;
          recorder.stop();
        }
      };
      recorder.onstop = () => {
        if (voiceCaptureRef.current !== capture) return;
        voiceCaptureRef.current = null;
        voiceRecordingRef.current = false;
        if (voiceRecordingTimer.current) window.clearTimeout(voiceRecordingTimer.current);
        voiceRecordingTimer.current = undefined;
        const actualType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(capture.chunks, { type: actualType });
        if (capture.bytes > 6 * 1024 * 1024) {
          setVoiceRecording("error");
          setVoiceError("That voice turn exceeded 6 MB. Try a shorter turn.");
        } else if (!capture.discard && blob.size && capture.generation === voiceSessionGenerationRef.current) {
          queueVoiceUpload({
            generation: capture.generation,
            roomId: capture.roomId,
            utteranceId: capture.utteranceId,
            blob,
            mimeType: actualType,
          });
        } else if (!voiceUploadRunningRef.current && voiceUploadQueueRef.current.length === 0) {
          setVoiceRecording("idle");
        }
        const restartAfterBoundary = voiceRestartAfterStopRef.current && voiceVadSpeakingRef.current;
        voiceRestartAfterStopRef.current = false;
        if (restartAfterBoundary) queueMicrotask(() => voiceBeginCaptureRef.current());
      };
      recorder.onerror = () => {
        if (voiceCaptureRef.current === capture) voiceCaptureRef.current = null;
        voiceRecordingRef.current = false;
        setVoiceRecording("error");
        setVoiceError("Recording failed. You can still use the typed voice turn below.");
      };
      recorder.start(250);
      voiceRecordingRef.current = true;
      setVoiceRecording("recording");
      setVoiceError(null);
      voiceRecordingTimer.current = window.setTimeout(() => finishVoiceCapture(false), 28_000);
    } catch (error) {
      voiceCaptureRef.current = null;
      voiceRecordingRef.current = false;
      setVoiceRecording("error");
      setVoiceError(error instanceof Error ? error.message : "Recording could not start.");
    }
  }, [finishVoiceCapture, queueVoiceUpload]);

  voiceBeginCaptureRef.current = beginVoiceCapture;

  voiceActivityEventRef.current = (event) => {
    const roomId = joinedVoiceRoomRef.current;
    if (event.type === "speechStarted") {
      voiceVadSpeakingRef.current = true;
      // This is only a fast acoustic hint. Keyboard clicks can cross a browser
      // RMS threshold, so never cancel AI audio or generation until the server
      // has accepted a real transcript. The accepted human-final turn will
      // supersede stale AI work; a little overlap is preferable to false stops.
      if (roomId) socketRef.current?.emit("voice:self-state", {
        roomId,
        muted: voiceMutedRef.current,
        deafened: voiceDeafenedRef.current,
        speaking: true,
      });
    } else if (event.type === "segmentStarted") {
      if (event.reason === "continuation") {
        if (voiceCaptureRef.current) voiceRestartAfterStopRef.current = true;
        else voiceBeginCaptureRef.current();
      } else {
        voiceBeginCaptureRef.current();
      }
    } else if (event.type === "speechEnded") {
      voiceVadSpeakingRef.current = false;
      voiceRestartAfterStopRef.current = false;
      if (roomId) socketRef.current?.emit("voice:self-state", {
        roomId,
        muted: voiceMutedRef.current,
        deafened: voiceDeafenedRef.current,
        speaking: false,
      });
    } else if (event.type === "segmentStopped") {
      finishVoiceCapture(false);
    } else if (event.type === "segmentDiscarded") {
      finishVoiceCapture(true);
    }
  };

  const toggleVoiceHandsFree = () => {
    if (!voiceCapabilities?.speechToText || !("MediaRecorder" in window) || !("AudioContext" in window)) {
      setVoiceError("Speech-to-text is unavailable. Send a typed turn instead.");
      return;
    }
    if (voiceHandsFree && voiceVadPaused) {
      void ensureVoiceVadRunning();
      return;
    }
    const next = !voiceHandsFree;
    setVoiceHandsFree(next);
    voiceHandsFreeRef.current = next;
    if (!next) finishVoiceCapture(true);
    else void ensureVoiceVadRunning();
  };

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        for (const event of voiceActivityRef.current.push({ nowMs: performance.now(), rms: 0, suppressed: true })) {
          voiceActivityEventRef.current(event);
        }
      } else if (!voiceMutedRef.current && voiceHandsFreeRef.current) {
        void ensureVoiceVadRunning();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [ensureVoiceVadRunning]);

  const sendTypedVoiceTurn = (event: FormEvent) => {
    event.preventDefault();
    const roomId = joinedVoiceRoomRef.current;
    const text = voiceTypedTurn.trim();
    if (!roomId || !text || !socketRef.current) return;
    voicePlaybackRef.current?.bargeIn();
    setVoiceAiAudioBlocked(false);
    setVoiceBrowserSpeech(false);
    socketRef.current.emit("voice:text-turn", { roomId, text }, (result: ActionResult) => {
      if (!result.ok) {
        setVoiceError(result.error);
        return;
      }
      setVoiceTypedTurn("");
    });
  };

  const inviteVoiceBot = (memberId: string) => {
    if (!voiceRoomInView || !socketRef.current || voiceInvitingBotIdRef.current || voiceBotSlotsRemaining <= 0) return;
    voiceInvitingBotIdRef.current = memberId;
    setVoiceInvitingBotId(memberId);
    setVoiceError(null);
    socketRef.current.emit("voice:bot:invite", { roomId: voiceRoomInView.id, personaId: memberId }, (result: VoiceInviteBotResult) => {
      if (voiceInvitingBotIdRef.current === memberId) voiceInvitingBotIdRef.current = null;
      setVoiceInvitingBotId((current) => current === memberId ? null : current);
      if (result.ok) upsertVoiceRoom(result.room);
      else setVoiceError(result.error);
    });
  };

  const removeVoiceBot = (memberId: string) => {
    if (!voiceRoomInView || !socketRef.current) return;
    socketRef.current.emit("voice:bot:remove", { roomId: voiceRoomInView.id, personaId: memberId }, (result: VoiceInviteBotResult) => {
      if (result.ok) upsertVoiceRoom(result.room);
      else setVoiceError(result.error);
    });
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const content = composer.trim();
    const image = imageDrafts[activeChannelId];
    if ((!content && !image) || !socketRef.current || !me) return;
    if (image) {
      if ((!activeChannel && !activeThread) || image.status === "preparing" || image.status === "sending") return;
      const channelId = activeChannelId;
      const privateThreadId = activeThread?.id;
      const rawComposer = composer;
      const previousReply = replyTo;
      updateImageDraft(channelId, { ...image, status: "sending", error: undefined });
      const form = new FormData();
      form.set("content", content);
      if (previousReply) form.set("replyToId", previousReply.id);
      if (image.source === "file" && image.file) form.set("image", image.file, image.file.name || "shared-image");
      if (image.source === "url" && image.imageUrl) form.set("imageUrl", image.imageUrl);
      try {
        const endpoint = privateThreadId
          ? `/api/dms/${encodeURIComponent(privateThreadId)}/image-messages`
          : `/api/channels/${encodeURIComponent(channelId)}/image-messages`;
        const response = await fetch(endpoint, {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        const result = (await response.json()) as ImageMessageResult;
        if (!response.ok || !result.ok) throw new Error(result.ok ? "Image could not be shared." : result.error);
        if (privateThreadId) {
          setDmThreads((current) => {
            const next = current.map((thread) => thread.id !== privateThreadId
              || thread.messages.some((message) => message.id === result.message.id)
              ? thread
              : { ...thread, messages: [...thread.messages, result.message] });
            dmThreadsRef.current = next;
            return next;
          });
        } else {
          setMessages((current) => current.some((message) => message.id === result.message.id)
            ? current
            : boundPublicMessages([...current, result.message]));
        }
        revokeDraftPreview(image);
        setImageDrafts((current) => current[channelId]?.id === image.id ? { ...current, [channelId]: undefined } : current);
        if (activeChannelRef.current === channelId) {
          setComposer((current) => current === rawComposer ? "" : current);
          setReplyTo((current) => current?.id === previousReply?.id ? null : current);
          socketRef.current?.emit("typing:set", { channelId, active: false });
        }
      } catch (error) {
        setImageDrafts((current) => current[channelId]?.id === image.id
          ? { ...current, [channelId]: { ...image, status: "error", error: error instanceof Error ? error.message : "Image could not be shared." } }
          : current);
        pushToast({ tone: "warning", title: "Image not sent", message: error instanceof Error ? error.message : "Try again in a moment." });
      }
      return;
    }
    if (!content) return;
    setComposer("");
    const previousReply = replyTo;
    setReplyTo(null);
    socketRef.current.emit(
      "message:send",
      { channelId: activeChannelId, content, replyToId: previousReply?.id },
      (result: ActionResult) => {
        if (!result.ok) {
          setComposer(content);
          pushToast({ tone: "warning", title: "Message not sent", message: result.error });
        }
      },
    );
  };

  const notifyTyping = (value: string) => {
    setComposer(value);
    if (!socketRef.current || !me) return;
    socketRef.current.emit("typing:set", { channelId: activeChannelId, active: Boolean(value.trim()) });
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(
      () => socketRef.current?.emit("typing:set", { channelId: activeChannelId, active: false }),
      1_400,
    );
  };

  const focusComposer = () => {
    const input = composerInputRef.current;
    if (voiceViewRoomId || !input || input.disabled) return;
    input.focus({ preventScroll: true });
  };

  const beginReply = (message: ChatMessage) => {
    setReplyTo(message);
    // Keep this synchronous with the click so mobile Safari may open its
    // keyboard under the same user activation. Do not reset the draft/caret.
    focusComposer();
  };

  const cancelReply = () => {
    focusComposer();
    setReplyTo(null);
  };

  const openDm = (peer: Member) => {
    if (!socketRef.current || !me || peer.id === me.id) return;
    socketRef.current.emit("dm:open", { peerId: peer.id }, (result: { ok: boolean; thread?: DmThread; error?: string }) => {
      if (!result.ok || !result.thread) {
        pushToast({ tone: "warning", title: "DM unavailable", message: result.error ?? "Try again in a moment." });
        return;
      }
      captureCurrentViewport();
      const currentThread = dmThreadsRef.current.find((thread) => thread.id === result.thread!.id);
      queueConversationEntry(result.thread.id, firstUnreadDmMessageId(currentThread));
      setDmThreads((current) => {
        const next = current.some((thread) => thread.id === result.thread!.id)
          ? current.map((thread) => (thread.id === result.thread!.id ? result.thread! : thread))
          : [...current, result.thread!];
        dmThreadsRef.current = next;
        return next;
      });
      activeChannelRef.current = result.thread.id;
      setVoiceViewRoomId(null);
      setVoiceCreateOpen(false);
      setActiveChannelId(result.thread.id);
      setProfile(null);
      setMobilePanel(null);
    });
  };

  const react = (message: ChatMessage, emoji: string) => {
    socketRef.current?.emit("reaction:toggle", { channelId: message.channelId, messageId: message.id, emoji }, (result: ActionResult) => {
      if (!result.ok) pushToast({ tone: "warning", title: "Couldn't react", message: result.error });
    });
  };

  const closeEmojiPicker = useCallback((restoreFocus = false) => {
    setEmojiPickerTarget(null);
    if (restoreFocus) requestAnimationFrame(() => emojiPickerAnchorRef.current?.focus({ preventScroll: true }));
  }, []);

  const toggleEmojiPicker = (target: EmojiPickerTarget, anchor: HTMLButtonElement) => {
    const alreadyOpen = emojiPickerTarget?.kind === target.kind && (
      target.kind === "composer" || (
        emojiPickerTarget.kind === "reaction" && emojiPickerTarget.messageId === target.messageId
      )
    );
    emojiPickerAnchorRef.current = anchor;
    setEmojiPickerTarget(alreadyOpen ? null : target);
  };

  const insertComposerEmoji = (emoji: string) => {
    const input = composerInputRef.current;
    const selectionStart = input?.selectionStart ?? composer.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const insertion = insertEmojiAtSelection(composer, emoji, selectionStart, selectionEnd, 500);
    if (!insertion) {
      pushToast({ tone: "warning", title: "Message is full", message: "Remove a character before adding an emoji." });
      return;
    }
    notifyTyping(insertion.value);
    closeEmojiPicker();
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  const report = (message: ChatMessage) => {
    socketRef.current?.emit("message:report", { messageId: message.id }, (result: ActionResult) => {
      if (!result.ok) pushToast({ tone: "warning", title: "Report failed", message: result.error });
    });
  };

  const selectChannel = (id: string) => {
    captureCurrentViewport();
    const selectedDm = dmThreadsRef.current.find((thread) => thread.id === id);
    const firstUnreadMessageId = channelNotices[id]?.firstUnreadMessageId
      ?? firstUnreadDmMessageId(selectedDm);
    queueConversationEntry(id, firstUnreadMessageId);
    setVoiceViewRoomId(null);
    setVoiceCreateOpen(false);
    activeChannelRef.current = id;
    setActiveChannelId(id);
    setChannelNotices((current) => clearChannelNotice(current, id));
    if (selectedDm) acknowledgeDmRead(id, selectedDm.messages.at(-1)?.id);
    setReplyTo(null);
    setSearch("");
    setImageUrlOpen(false);
    setImageUrlValue("");
    setEmojiPickerTarget(null);
    dragDepth.current = 0;
    setDragActive(false);
    setMobilePanel(null);
  };

  const onlineHumans = members.filter((member) => member.kind === "human" && member.status === "online");
  const idleHumans = members.filter((member) => member.kind === "human" && member.status === "idle");
  const offlineHumans = members.filter((member) => member.kind === "human" && member.status === "offline");
  const connectedHumans = [...onlineHumans, ...idleHumans];
  const activeResidents = members.filter((member) => member.kind === "ai" && member.status === "online");
  const quietResidents = members.filter((member) => member.kind === "ai" && member.status !== "online");
  const displayMembers = members.length ? members : preview?.members ?? [];
  const normalizedJoinName = normalizeDisplayName(joinName);
  const joinNameReady = validDisplayName(normalizedJoinName);
  const identityJoinReady = adultConfirmed && (pendingAdultAdmission
    ? true
    : authJoinMode === "login"
      ? Boolean(loginHandle.trim() && accountPassword)
      : authJoinMode === "register"
        ? Boolean(joinNameReady && loginHandle.trim() && [...accountPassword].length >= 8 && accountPassword === accountPasswordConfirm)
        : authJoinMode === "legacy"
          ? Boolean(joinNameReady && returnKey.trim())
          : joinNameReady);
  const joinHeading = pendingAdultAdmission
    ? "Welcome back."
    : authJoinMode === "login"
    ? "Welcome back."
    : authJoinMode === "register"
      ? "Make this place yours."
      : authJoinMode === "legacy"
        ? "Return with an old key."
        : "Drop in as a guest.";
  const joinCopy = pendingAdultAdmission
    ? `Confirm the community age boundary below to continue as ${pendingAdultAdmission.me.name}.`
    : authJoinMode === "login"
    ? "Sign in to the local account stored by this server."
    : authJoinMode === "register"
      ? "Keep your identity, relationships and private conversations between visits."
      : authJoinMode === "legacy"
        ? "Use the display name and private return key from an earlier version of The Third Place."
        : "No account needed. This identity and its private data are erased when you explicitly log out.";

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobilePanel === "rooms" ? "mobile-open" : ""}`}>
        <div className="brand-row">
          <BrandMark />
          <div><strong>The Third Place</strong><small><i /> live social experiment</small></div>
          <button className="icon-button mobile-only" onClick={() => setMobilePanel(null)} aria-label="Close rooms"><Icon name="close" /></button>
        </div>

        <div className="sidebar-scroll">
          <section className="nav-section">
            <p className="eyebrow">Hangouts</p>
            {channels.map((channel) => {
              const isActive = activeChannelId === channel.id;
              const notice = channelNotices[channel.id];
              const hasUnread = Boolean(notice?.unread) && !isActive;
              const mentions = isActive ? 0 : notice?.mentions ?? 0;
              return (
                <button
                  key={channel.id}
                  className={`channel-button ${isActive ? "active" : ""} ${hasUnread ? "unread" : ""}`}
                  onClick={() => selectChannel(channel.id)}
                  aria-label={`${channel.name}${mentions > 0 ? `, ${mentions} unread mention${mentions === 1 ? "" : "s"}` : hasUnread ? ", unread messages" : ""}`}
                >
                  <Icon name="hash" size={17} /><span dir="auto">{channel.name}</span>
                  {mentions > 0 && (
                    <i className="channel-unread" aria-hidden="true">{mentions > 9 ? "9+" : mentions}</i>
                  )}
                </button>
              );
            })}
          </section>

          <section className="nav-section voice-section">
            <p className="eyebrow voice-section-title"><span>Voice</span>{me && activeChannel && <button type="button" onClick={() => setVoiceCreateOpen((value) => !value)} aria-label="Start a voice room"><Icon name="plus" size={13} /></button>}</p>
            {voiceCreateOpen && (
              <div className="voice-create-prompt">
                <span>Start voice for <strong>#{activeChannel?.name ?? "lobby"}</strong>?</span>
                <div><button type="button" onClick={startVoiceRoom}>Start</button><button type="button" onClick={() => setVoiceCreateOpen(false)}>Cancel</button></div>
              </div>
            )}
            {voiceRooms.length === 0 ? (
              <button className="voice-empty" type="button" onClick={() => me && activeChannel && setVoiceCreateOpen(true)} disabled={!me || !activeChannel}><Icon name="speaker" size={15} /> Start a voice room</button>
            ) : voiceRooms.map((room) => {
              const channel = channels.find((candidate) => candidate.id === room.channelId);
              const speaking = room.participants.some((participant) => participant.speaking || participant.botState === "speaking");
              return (
                <div className={`voice-room-group ${voiceViewRoomId === room.id ? "active" : ""}`} key={room.id}>
                  <button className="voice-room-button" type="button" onClick={() => { setVoiceViewRoomId(room.id); setMobilePanel(null); }}>
                    <Icon name="speaker" size={16} /><span dir="auto">{channel?.name ?? "voice room"}</span>{speaking && <i className="voice-wave"><b /><b /><b /></i>}<small>{room.participants.length}</small>
                  </button>
                  <div className="voice-room-members">
                    {room.participants.map((participant) => (
                      <span className={participant.speaking || participant.botState === "speaking" ? "speaking" : ""} dir="auto" key={participant.memberId}>
                        <i />{participant.name}{participant.kind === "ai" && <AiBadge />}{participant.muted && <Icon name="micOff" size={11} />}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="nav-section dm-section">
            <p className="eyebrow">Private <span>{dmThreads.length}</span></p>
            {dmThreads.length === 0 ? (
              <button className="dm-empty" onClick={() => setMobilePanel("people")}><Icon name="message" size={15} /> Click a resident to start a DM</button>
            ) : (
              dmThreads.map((thread) => {
                const peer = memberMap.get(thread.peerId);
                if (!peer) return null;
                return (
                  <button key={thread.id} className={`dm-button ${activeChannelId === thread.id ? "active" : ""}`} onClick={() => selectChannel(thread.id)}>
                    <Avatar member={peer} size="sm" /><span dir="auto">{peer.name}</span>{peer.kind === "ai" && <AiBadge />}{thread.unread > 0 && <i className="channel-unread" aria-label={`${thread.unread} unread messages`}>{thread.unread > 9 ? "9+" : thread.unread}</i>}
                  </button>
                );
              })
            )}
          </section>
        </div>

        {joinedVoiceRoom && (
          <div className={`voice-connection-bar voice-connection-${voiceJoinState}`}>
            <button type="button" className="voice-connection-copy" onClick={() => { setVoiceViewRoomId(joinedVoiceRoom.id); setMobilePanel(null); }}>
              <span><i />{voiceJoinState === "reconnecting" ? "Voice reconnecting" : "Voice connected"}</span>
              <small>#{channels.find((channel) => channel.id === joinedVoiceRoom.channelId)?.name ?? "voice"}</small>
            </button>
            <button type="button" className="voice-quick-leave" onClick={leaveVoiceRoom} aria-label="Disconnect from voice"><Icon name="phoneOff" size={16} /></button>
          </div>
        )}
        {me ? (
          <button className="sidebar-foot sidebar-foot-button" type="button" onClick={() => setProfile(me)} aria-label="Open your profile and identity settings">
            <Avatar member={me} size="sm" /><div><strong dir="auto">{me.name}</strong><span>{sessionIdentity?.kind === "registered" ? "Member" : sessionIdentity?.kind === "legacy" ? "Saved identity" : "Guest"} · {me.status === "offline" ? "reconnecting" : me.status}</span></div><span className="signal-bars" aria-hidden="true"><i /><i /><i /></span>
          </button>
        ) : (
          <div className="sidebar-foot"><span className="preview-eye"><Icon name="users" size={16} /></span><div><strong>Live preview</strong><span>Join to take part</span></div></div>
        )}
      </aside>

      <main
        className={`chat-panel ${dragActive ? "image-drag-active" : ""} ${voiceViewRoomId ? "voice-view" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragActive && !voiceViewRoomId && <div className="image-drop-overlay" aria-hidden="true"><span><Icon name="image" size={28} /></span><strong>Drop image to share</strong><small>JPEG, PNG or WebP · max 8 MB</small></div>}
        {voiceViewRoomId && (
          <section className="voice-stage" aria-label="Voice room" data-voice-room-id={voiceRoomInView?.id}>
            {voiceRoomInView ? (
              <>
                <header className="voice-stage-header">
                  <button type="button" className="icon-button mobile-only" onClick={() => setMobilePanel("rooms")} aria-label="Open rooms"><Icon name="menu" /></button>
                  <span className="voice-stage-icon"><Icon name="speaker" size={19} /></span>
                  <div><strong dir="auto">{channels.find((channel) => channel.id === voiceRoomInView.channelId)?.name ?? "Voice room"}</strong><span>{voiceRoomInView.participants.length} connected · started by <span dir="auto">{memberMap.get(voiceRoomInView.createdByMemberId)?.name ?? "a person"}</span></span></div>
                  <button type="button" className="voice-back-chat" onClick={() => setVoiceViewRoomId(null)}><Icon name="message" size={15} /> Back to chat</button>
                </header>

                <div className="voice-stage-scroll">
                  {voiceError && <div className="voice-error" role="alert"><Icon name="info" size={16} /><span>{voiceError}</span><button type="button" onClick={() => setVoiceError(null)}><Icon name="close" size={14} /></button></div>}
                  {voiceAudioBlocked && <div className="voice-audio-banner"><Icon name="speaker" size={16} /><span>Audio is ready but the browser paused playback.</span><button type="button" onClick={() => void enableVoiceSound()}>Enable sound</button></div>}
                  {voiceBrowserSpeech && <div className="voice-browser-disclosure"><Icon name="info" size={13} /> AI speech is using this browser's disclosed fallback voice.</div>}

                  <div className={`voice-grid voice-grid-${Math.min(voiceRoomInView.participants.length, 4)}`}>
                    {voiceRoomInView.participants.map((participant) => {
                      const member = memberMap.get(participant.memberId);
                      const isMe = participant.memberId === me?.id;
                      const isSpeaking = participant.speaking || participant.botState === "speaking";
                      return (
                        <article className={`voice-tile ${isSpeaking ? "speaking" : ""} ${participant.kind === "ai" ? "ai" : ""}`} key={participant.memberId}>
                          <div className="voice-avatar-wrap">{member ? <Avatar member={member} size="xl" showStatus={false} /> : <span className="voice-avatar-fallback">{participant.name.slice(0, 1)}</span>}<i className="voice-speaking-ring" /></div>
                          <div className="voice-tile-name"><strong dir="auto">{participant.name}{isMe ? " (you)" : ""}</strong>{participant.kind === "ai" && <AiBadge label="AI RESIDENT" />}</div>
                          <span className="voice-tile-state">
                            {participant.muted && <Icon name="micOff" size={13} />}
                            {participant.botState === "thinking" ? "thinking…" : participant.botState === "joining" || participant.botState === "invited" ? "joining…" : isSpeaking ? "speaking" : participant.muted ? "muted" : "listening"}
                          </span>
                          {participant.kind === "ai" && voiceRoomInView.hostMemberId === me?.id && <button type="button" className="voice-remove-bot" onClick={() => removeVoiceBot(participant.memberId)} aria-label={`Remove ${participant.name} from voice`}><Icon name="close" size={13} /></button>}
                          {participant.kind === "human" && !isMe && (
                            <RemoteVoiceAudio
                              memberId={participant.memberId}
                              stream={voiceRemoteStreams.current.get(participant.memberId)}
                              muted={voiceDeafened}
                              onAttach={attachRemoteVoiceAudio}
                              onPlaybackState={setRemoteAudioPlaybackState}
                            />
                          )}
                        </article>
                      );
                    })}
                    {voiceRoomInView.participants.length === 0 && <div className="voice-empty-stage"><Icon name="radio" size={28} /><strong>The room is open.</strong><span>Join and invite someone in.</span></div>}
                  </div>

                  {voiceRoomTranscripts.length > 0 && (
                    <div className="voice-transcript" aria-live="polite">
                      <p className="eyebrow">Recent spoken context</p>
                      {voiceRoomTranscripts.slice(-4).map((entry) => <p key={entry.id}><strong dir="auto">{entry.speakerName}</strong><span dir="auto">{entry.text}</span></p>)}
                    </div>
                  )}

                  {joinedVoiceRoomId === voiceRoomInView.id && (
                    <section className={`voice-mic-setup ${voiceMicDetected ? "detecting" : ""} ${voiceMuted ? "muted" : ""}`} aria-labelledby="voice-mic-level-title">
                      <div className="voice-mic-level-copy">
                        <span><Icon name={voiceMuted ? "micOff" : "mic"} size={15} /><strong id="voice-mic-level-title">Microphone level</strong></span>
                        <output>{voiceMicStatus}</output>
                      </div>
                      <div
                        className="voice-input-meter"
                        role="meter"
                        aria-label="Live microphone input level"
                        aria-describedby="voice-mic-meter-help"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(voiceMicMeter.level * 100)}
                      >
                        <span style={{ width: `${voiceMicMeter.level * 100}%` }} />
                        <i style={{ left: `${voiceMicMeter.threshold * 100}%` }} title="Current speech start threshold" />
                      </div>
                      <div className="voice-sensitivity-head">
                        <label htmlFor="voice-sensitivity">Mic sensitivity</label>
                        <output htmlFor="voice-sensitivity">{voiceSensitivityCopy} · {voiceSensitivity}</output>
                      </div>
                      <input
                        id="voice-sensitivity"
                        className="voice-sensitivity-slider"
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={voiceSensitivity}
                        onChange={(event) => changeVoiceSensitivity(event.currentTarget.valueAsNumber)}
                        aria-valuetext={`${voiceSensitivityCopy}; higher sensitivity picks up quieter speech`}
                      />
                      <div className="voice-sensitivity-scale" aria-hidden="true"><span>Less pickup</span><span>Balanced</span><span>Quieter voices</span></div>
                      <small id="voice-mic-meter-help">The marker is the live speech threshold. Higher sensitivity lowers it and is saved in this browser.</small>
                    </section>
                  )}

                  {joinedVoiceRoomId === voiceRoomInView.id && voiceRoomInView.hostMemberId === me?.id && (
                    <section className="voice-invite-panel" aria-labelledby="voice-invite-title" aria-describedby="voice-invite-description">
                      <header className="voice-invite-head">
                        <span className="voice-invite-icon"><Icon name="users" size={19} /></span>
                        <div className="voice-invite-copy">
                          <strong id="voice-invite-title">Invite an AI friend</strong>
                          <span id="voice-invite-description">{voiceBotCount >= 2
                            ? "Ask the room or address both residents. They can answer each other once without starting an autonomous loop."
                            : "Choose a resident below. Invite two and ask the room to hear a quick resident-to-resident exchange."}</span>
                        </div>
                        <span className={`voice-invite-capacity ${voiceBotSlotsRemaining === 0 ? "full" : ""}`} aria-live="polite">
                          <strong>{voiceBotCount}</strong><span> / {voiceBotLimit} AI seats</span>
                        </span>
                      </header>

                      {voiceBotSlotsRemaining > 0 && availableVoiceBots.length > 0 ? (
                        <>
                          <div className="voice-invite-grid">
                            {displayedVoiceBots.map((bot) => {
                              const pending = voiceInvitingBotId === bot.id;
                              return (
                                <button
                                  aria-busy={pending}
                                  aria-disabled={voiceInvitingBotId !== null}
                                  aria-label={`Invite ${bot.name} to this voice room`}
                                  className={`voice-invite-card ${pending ? "pending" : ""}`}
                                  data-voice-invite-id={bot.id}
                                  disabled={voiceInvitingBotId !== null && !pending}
                                  key={bot.id}
                                  onClick={() => inviteVoiceBot(bot.id)}
                                  type="button"
                                >
                                  <Avatar member={bot} size="sm" />
                                  <span className="voice-invite-person">
                                    <strong dir="auto">{bot.name}</strong>
                                    <span><AiBadge /><small>{pending ? "Joining…" : "Available"}</small></span>
                                  </span>
                                  <span className="voice-invite-action"><Icon name={pending ? "pulse" : "plus"} size={15} /><span>{pending ? "Inviting" : "Invite"}</span></span>
                                </button>
                              );
                            })}
                          </div>
                          {availableVoiceBots.length > 8 && (
                            <button
                              aria-expanded={voiceInviteExpanded}
                              className="voice-invite-more"
                              onClick={() => setVoiceInviteExpanded((expanded) => !expanded)}
                              type="button"
                            >
                              <Icon name="chevron" size={14} />
                              {voiceInviteExpanded ? "Show fewer residents" : `Show ${availableVoiceBots.length - 8} more residents`}
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="voice-invite-full" role="status">
                          <Icon name={voiceBotSlotsRemaining === 0 ? "users" : "info"} size={17} />
                          <span>{voiceBotSlotsRemaining === 0
                            ? "All AI seats are filled. Remove a resident from their voice tile to invite someone else."
                            : "The other AI residents are already in voice calls."}</span>
                        </div>
                      )}
                    </section>
                  )}

                  {joinedVoiceRoomId === voiceRoomInView.id && (
                    <>
                      {voiceCapabilities?.speechToText && voiceHandsFree && (
                        <div className={`voice-listening-note ${!voiceVadPaused && !voiceMuted && voiceRoomInView.participants.some((participant) => participant.kind === "ai") ? "live" : ""}`}>
                          <Icon name="radio" size={14} />
                          <span>{voiceVadPaused
                            ? "The browser paused microphone analysis. Press Resume listening below to continue hands-free."
                            : voiceMuted
                            ? "Hands-free AI is ready and starts only when you unmute."
                            : voiceRoomInView.participants.some((participant) => participant.kind === "ai")
                              ? voiceRoomInView.participants.filter((participant) => participant.kind === "ai").length >= 2
                                ? "Hands-free listening is on. Ask the room or address both residents and the second may follow the first immediately."
                                : "Hands-free AI listening is on. Natural pauses send each spoken turn for transcription."
                              : "Hands-free is ready. Invite an AI resident to let them hear transcribed turns."}</span>
                        </div>
                      )}
                      <form className="voice-typed-turn" onSubmit={sendTypedVoiceTurn}>
                        <Icon name="message" size={15} /><input dir="auto" value={voiceTypedTurn} onChange={(event) => setVoiceTypedTurn(event.target.value)} maxLength={500} placeholder="Typed fallback — treated as something said in this voice room" /><button type="submit" disabled={!voiceTypedTurn.trim()}>Send</button>
                      </form>
                    </>
                  )}
                </div>

                {joinedVoiceRoomId === voiceRoomInView.id ? (
                  <div className="voice-controls" aria-label="Voice controls">
                    <button type="button" className={voiceMuted ? "active" : ""} onClick={() => void toggleVoiceMute()} disabled={voiceJoinState === "requesting-permission" || voiceDeafened} aria-label={voiceMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={voiceMuted}><Icon name={voiceMuted ? "micOff" : "mic"} /><span>{voiceMuted ? "Unmute" : "Mute"}</span></button>
                    <button
                      type="button"
                      className={`voice-record ${voiceHandsFree ? "active" : ""} ${voiceRecording === "recording" ? "recording" : ""}`}
                      onClick={toggleVoiceHandsFree}
                      disabled={!voiceCapabilities?.speechToText || !("MediaRecorder" in window) || !("AudioContext" in window)}
                      aria-label={voiceVadPaused ? "Resume hands-free AI listening" : voiceHandsFree ? "Pause hands-free AI listening" : "Enable hands-free AI listening"}
                      aria-pressed={voiceHandsFree}
                    >
                      <Icon name="radio" />
                      <span>{!voiceCapabilities?.speechToText
                        ? "Typed only"
                        : voiceVadPaused
                          ? "Resume listening"
                        : voiceRecording === "recording"
                        ? "Listening…"
                        : voicePendingUploads > 0
                          ? `Transcribing${voicePendingUploads > 1 ? ` ${voicePendingUploads}` : "…"}`
                          : voiceHandsFree
                            ? voiceMuted ? "Hands-free ready" : "AI listening"
                            : "Enable hands-free"}</span>
                    </button>
                    <button type="button" className={voiceDeafened ? "active" : ""} onClick={toggleVoiceDeafen} aria-label={voiceDeafened ? "Undeafen voice room" : "Deafen voice room"} aria-pressed={voiceDeafened}><Icon name="headphones" /><span>{voiceDeafened ? "Undeafen" : "Deafen"}</span></button>
                    <button type="button" className="voice-disconnect" onClick={leaveVoiceRoom} aria-label="Leave voice room"><Icon name="phoneOff" /><span>Leave</span></button>
                  </div>
                ) : (
                  <div className="voice-prejoin">
                    <div><strong>Join the conversation</strong><span>Your microphone is requested only if you choose it.</span></div>
                    <button type="button" className="join-mic" onClick={() => void joinVoiceRoom(voiceRoomInView, true)} disabled={voiceJoinState === "joining" || voiceJoinState === "requesting-permission"}><Icon name="mic" />{voiceJoinState === "requesting-permission" ? "Waiting for permission…" : "Join with microphone"}</button>
                    <button type="button" onClick={() => void joinVoiceRoom(voiceRoomInView, false)} disabled={voiceJoinState === "joining" || voiceJoinState === "requesting-permission"}><Icon name="headphones" /> Listen only</button>
                  </div>
                )}
              </>
            ) : <div className="voice-room-missing"><Icon name="speaker" size={28} /><strong>This voice room has closed.</strong><button type="button" onClick={() => setVoiceViewRoomId(null)}>Back to chat</button></div>}
          </section>
        )}
        <header className="chat-header">
          <button className="icon-button mobile-only" onClick={() => setMobilePanel("rooms")} aria-label="Open rooms"><Icon name="menu" /></button>
          <span className="channel-symbol">{activeThread ? <Icon name="lock" size={18} /> : <Icon name="hash" size={19} />}</span>
          <div className="channel-heading"><strong dir="auto">{activeTitle}</strong><span dir="auto">{activeDescription}</span></div>
          <div className="header-actions">
            {connection !== "live" && connection !== "preview" && (
              <span aria-live="polite" className={`connection-pill ${connection}`} role="status"><i />{connection}</span>
            )}
            <button className={`icon-button ${showDirector ? "active" : ""}`} onClick={() => setShowDirector((value) => !value)} title="Director view"><Icon name="pulse" /></button>
            <button className={`icon-button ${searchOpen ? "active" : ""}`} onClick={() => setSearchOpen((value) => !value)} title="Search"><Icon name="search" /></button>
            <button className="people-button" onClick={() => setMobilePanel("people")}><Icon name="users" /><span>{connectedHumans.length + activeResidents.length}</span></button>
          </div>
          {searchOpen && <div className="search-pop"><Icon name="search" size={15} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search loaded messages in #${activeTitle}`} /><button onClick={() => { setSearch(""); setSearchOpen(false); }}><Icon name="close" size={14} /></button></div>}
        </header>

        <ChannelIntegrationsPanel
          cards={activeChannelFeeds}
          collapsed={integrationsCollapsed}
          onToggle={() => setCollapsedIntegrationChannels((current) => ({
            ...current,
            [activeChannelId]: !(current[activeChannelId] ?? false),
          }))}
        />

        <div
          className="message-scroller"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 110;
            shouldStickToBottom.current = atBottom;
            if (atBottom) {
              setChannelNotices((current) => clearChannelNotice(current, activeChannelId));
              const thread = dmThreadsRef.current.find((candidate) => candidate.id === activeChannelId);
              if (thread?.unread && document.visibilityState === "visible") {
                acknowledgeDmRead(thread.id, thread.messages.at(-1)?.id);
              }
              setUnreadDividers((current) => current[activeChannelId]
                ? { ...current, [activeChannelId]: undefined }
                : current);
            }
            if (element.scrollTop < 160 && !search.trim()) void loadOlderMessages();
          }}
        >
          {!activeThread && activeHistory.hasMore && (
            historyError[activeChannelId] ? (
              <button className="history-retry" onClick={() => void loadOlderMessages()}>{historyError[activeChannelId]} · Retry</button>
            ) : (
              <div className="history-loader" role="status" aria-live="polite" aria-atomic="true">
                {historyLoading[activeChannelId] && <span className="history-spinner" aria-hidden="true" />}
                <span>{historyLoading[activeChannelId] ? "Loading older messages…" : "Scroll up for older messages"}</span>
              </div>
            )
          )}
          {(activeThread || !activeHistory.hasMore) && <div className="channel-intro">
            <div className="intro-icon">{activePeer ? <Avatar member={activePeer} size="xl" showStatus={false} /> : <Icon name="hash" size={28} />}</div>
            <h1 dir="auto">{activePeer ? activePeer.name : `Welcome to #${activeTitle}`}</h1>
            <p dir="auto">{activeDescription}</p>
            {activePeer?.kind === "ai" && <div className="transparency-note"><AiBadge label="AI RESIDENT" /><span>This character is generated by a local language model. Private history is stored locally by this server.</span></div>}
          </div>}
          {activeMessages.length === 0 && <div className="empty-conversation"><Icon name="message" size={22} /><strong>Quiet, for once.</strong><span>Say something and see who notices.</span></div>}
          {activeMessages.map((message, index) => {
            const author = memberMap.get(message.authorId) ?? message.authorSnapshot;
            const previous = activeMessages[index - 1];
            const startsDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
            const startsUnread = unreadDividers[activeChannelId] === message.id;
            const grouped =
              previous &&
              !startsDay &&
              previous.authorId === message.authorId &&
              !message.replyToId &&
              new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 6 * 60_000;
            const replied = message.replyToId ? activeMessages.find((candidate) => candidate.id === message.replyToId) ?? messages.find((candidate) => candidate.id === message.replyToId) : undefined;
            const replyDisplay = replied
              ? {
                  authorName: memberMap.get(replied.authorId)?.name ?? replied.authorSnapshot?.name ?? "someone",
                  content: replied.content || (replied.attachments?.length ? "📷 Image" : "Message"),
                }
              : message.replyPreview;
            const previewSource = message.linkPreview
              ? message.sources?.find((source) => source.url === message.linkPreview?.url)
              : undefined;
            const remainingSources = message.sources?.filter(
              (source) => !message.linkPreview || source.url !== message.linkPreview.url,
            ) ?? [];
            const previewPublishedDate = formatSourceDate(previewSource?.publishedAt);
            if (message.system) return (
              <Fragment key={message.id}>
                {startsDay && <div className="day-divider"><span>{formatDayLabel(message.createdAt)}</span></div>}
                {startsUnread && <div className="unread-divider" role="separator" aria-label="New messages"><span>New</span></div>}
                <div className="system-message" data-message-id={message.id} dir="auto"><span><Icon name="spark" size={12} /></span>{message.content}<time>{formatTime(message.createdAt)}</time></div>
              </Fragment>
            );
            if (!author) return null;
            return (
              <Fragment key={message.id}>
              {startsDay && <div className="day-divider"><span>{formatDayLabel(message.createdAt)}</span></div>}
              {startsUnread && <div className="unread-divider" role="separator" aria-label="New messages"><span>New</span></div>}
              <article
                className={`message ${grouped ? "grouped" : ""} ${historicalMessageIds.current.has(message.id) ? "historical" : ""} ${emojiPickerTarget?.kind === "reaction" && emojiPickerTarget.messageId === message.id ? "reaction-picker-open" : ""}`}
                data-message-id={message.id}
              >
                {!grouped ? <Avatar member={author} size="md" /> : <time className="group-time">{formatTime(message.createdAt)}</time>}
                <div className="message-body">
                  {replyDisplay && <button className="reply-preview"><Icon name="reply" size={12} /><strong dir="auto">{replyDisplay.authorName}</strong><span dir="auto">{replyDisplay.content.slice(0, 92)}</span></button>}
                  {!grouped && <div className="message-meta"><button dir="auto" onClick={() => setProfile(author)}>{author.name}</button>{author.kind === "ai" && <AiBadge />}<time>{formatTime(message.createdAt)}</time></div>}
                  {message.content && <div className="message-content" dir="auto"><MessageText content={message.content} members={displayMembers} /></div>}
                  {message.attachments?.map((attachment) => {
                    const description = attachment.analysis.status === "ready"
                      ? attachment.analysis.observation.summary
                      : `Image shared by ${author.name}`;
                    return (
                      <figure className="message-image" key={attachment.id}>
                        <button
                          type="button"
                          className="message-image-button"
                          onClick={(event) => {
                            lightboxTriggerRef.current = event.currentTarget;
                            setLightbox({ attachment, authorName: author.name });
                          }}
                          aria-label={`Open full image: ${description}`}
                        >
                          <img
                            src={attachment.thumbnailUrl}
                            alt={description}
                            width={attachment.width}
                            height={attachment.height}
                            loading="lazy"
                            decoding="async"
                          />
                          <span className="image-expand"><Icon name="image" size={14} /> View</span>
                        </button>
                        <figcaption className={`image-analysis image-analysis-${attachment.analysis.status}`}>
                          {attachment.analysis.status === "pending" ? <><span className="analysis-pulse" /><span>{activeThread ? "Image is being viewed…" : "AI residents are looking at this…"}</span></> : null}
                          {attachment.analysis.status === "ready" ? <><Icon name="spark" size={11} /><span>{activeThread ? "Seen in this private chat" : "Seen by the room"}</span></> : null}
                          {attachment.analysis.status === "unavailable" ? <><Icon name="info" size={11} /><span>Visual description unavailable</span></> : null}
                          {attachment.analysis.status === "not_requested" ? <><Icon name="lock" size={11} /><span>Shared privately</span></> : null}
                        </figcaption>
                      </figure>
                    );
                  })}
                  {message.linkPreview && (
                    <div className="link-preview-list">
                      <a
                        className={`link-preview-card${previewSource ? " link-preview-card-sourced" : ""}`}
                        href={message.linkPreview.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        referrerPolicy="no-referrer"
                        aria-label={linkPreviewAriaLabel(message.linkPreview.title, Boolean(previewSource))}
                      >
                        <span className="link-preview-domain">
                          <span>{linkPreviewDomainLabel(message.linkPreview.siteName, message.linkPreview.displayHost)}</span>
                          <Icon name="external" size={11} />
                        </span>
                        <strong className="link-preview-title" dir="auto">{message.linkPreview.title}</strong>
                        {message.linkPreview.description && <span className="link-preview-description" dir="auto">{message.linkPreview.description}</span>}
                        {previewSource && (
                          <span className="link-preview-footer">
                            <span className="link-preview-provenance"><Icon name="search" size={11} /> Looked up</span>
                            {previewPublishedDate && (
                              <>
                                <span className="link-preview-separator" aria-hidden="true">•</span>
                                <time dateTime={previewPublishedDate.dateTime}>Published {previewPublishedDate.label}</time>
                              </>
                            )}
                          </span>
                        )}
                      </a>
                    </div>
                  )}
                  {(message.reactions.length > 0 || (me && !activeThread)) && (
                    <div className={`reaction-row ${message.reactions.length === 0 ? "reaction-row-empty" : ""}`}>
                      {message.reactions.map((reaction) => (
                        <button
                          key={reaction.emoji}
                          aria-label={`${reaction.emoji} reaction, ${reaction.memberIds.length} ${reaction.memberIds.length === 1 ? "person" : "people"}`}
                          aria-pressed={Boolean(me && reaction.memberIds.includes(me.id))}
                          className={me && reaction.memberIds.includes(me.id) ? "mine" : ""}
                          onClick={() => me && react(message, reaction.emoji)}
                          disabled={!me}
                        >
                          <span>{reaction.emoji}</span><b>{reaction.memberIds.length}</b>
                          <i>{reaction.memberIds.slice(0, 3).map((id) => memberMap.get(id)).filter((member): member is Member => Boolean(member)).map((member) => <Avatar key={member.id} member={member} size="sm" showStatus={false} />)}</i>
                        </button>
                      ))}
                      {me && !activeThread && (
                        <button
                          className="reaction-add-touch"
                          type="button"
                          data-emoji-picker-trigger
                          onClick={(event) => toggleEmojiPicker({ kind: "reaction", messageId: message.id }, event.currentTarget)}
                          title="Add reaction"
                          aria-label={`Add a reaction to ${author.name}'s message`}
                          aria-haspopup="dialog"
                          aria-expanded={emojiPickerTarget?.kind === "reaction" && emojiPickerTarget.messageId === message.id}
                        ><Icon name="smile" size={15} /></button>
                      )}
                    </div>
                  )}
                  {remainingSources.length > 0 && (
                    <div className="source-row">
                      <span><Icon name="search" size={11} /> looked up</span>
                      {remainingSources.map((source) => (
                        <a dir="auto" key={source.url} href={source.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={source.title}>
                          {source.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                {me && !activeThread && (
                  <div className="message-actions">
                    <button
                      type="button"
                      data-emoji-picker-trigger
                      onClick={(event) => toggleEmojiPicker({ kind: "reaction", messageId: message.id }, event.currentTarget)}
                      title="Add reaction"
                      aria-label={`Add a reaction to ${author.name}'s message`}
                      aria-haspopup="dialog"
                      aria-expanded={emojiPickerTarget?.kind === "reaction" && emojiPickerTarget.messageId === message.id}
                    ><Icon name="smile" size={16} /></button>
                    <button type="button" onClick={() => beginReply(message)} title="Reply" aria-label={`Reply to ${author.name}`} aria-controls="message-composer-input"><Icon name="reply" size={16} /></button>
                    <button type="button" onClick={() => report(message)} title="Report" aria-label={`Report ${author.name}'s message`}><Icon name="flag" size={15} /></button>
                  </div>
                )}
              </article>
              </Fragment>
            );
          })}
          <div className="scroll-pad" />
        </div>

        <div className="composer-wrap">
          <div className={`typing-line ${typingMembers.length ? "visible" : ""}`}>
            <span className="typing-dots"><i /><i /><i /></span>
            {typingMembers.length > 0 && <span><span dir="auto">{typingMembers.slice(0, 2).map((member) => member.name).join(" and ")}</span>{typingMembers.length > 2 ? ` +${typingMembers.length - 2}` : ""} {typingMembers.length === 1 ? "is" : "are"} composing</span>}
          </div>
          {replyTo && <div className="replying-to" id="replying-to-message"><span>Replying to <strong dir="auto">{memberMap.get(replyTo.authorId)?.name}</strong></span><button type="button" onClick={cancelReply} aria-label="Cancel reply"><Icon name="close" size={15} /></button></div>}
          {pendingImage && (
            <div className={`pending-image pending-image-${pendingImage.status}`} aria-live="polite">
              <div className="pending-image-visual">
                {pendingImage.previewUrl
                  ? <img src={pendingImage.previewUrl} alt="Image ready to share" />
                  : <span><Icon name={pendingImage.source === "url" ? "link" : "image"} size={20} /></span>}
              </div>
              <div className="pending-image-copy">
                <strong dir="auto">{pendingImage.label}</strong>
                <span>
                  {pendingImage.status === "preparing" && "Preparing preview…"}
                  {pendingImage.status === "ready" && (pendingImage.source === "url" ? "Secure server fetch on send" : "Ready to share")}
                  {pendingImage.status === "sending" && "Sanitizing and sharing…"}
                  {pendingImage.status === "error" && (pendingImage.error ?? "Could not share this image.")}
                </span>
              </div>
              {pendingImage.status === "error" && <button className="pending-retry" type="submit" form="message-composer"><Icon name="refresh" size={14} /> Retry</button>}
              <button className="pending-remove" type="button" onClick={() => removeImageDraft()} disabled={pendingImage.status === "sending"} aria-label="Remove attached image"><Icon name="close" size={15} /></button>
            </div>
          )}
          {imageUrlOpen && (
            <div className="image-url-entry">
              <Icon name="link" size={15} />
              <input
                autoFocus
                type="url"
                inputMode="url"
                value={imageUrlValue}
                onChange={(event) => setImageUrlValue(event.target.value)}
                onKeyDown={handleImageUrlKeyDown}
                placeholder="https://example.com/image.jpg"
                aria-label="Direct HTTPS image URL"
              />
              <button type="button" onClick={() => queueImageUrl(imageUrlValue)} disabled={!imageUrlValue.trim()}>Attach</button>
              <button type="button" className="image-url-close" onClick={() => { setImageUrlOpen(false); setImageUrlValue(""); }} aria-label="Cancel image URL"><Icon name="close" size={14} /></button>
            </div>
          )}
          <input
            ref={imageInputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) queueImageFile(file);
              event.currentTarget.value = "";
            }}
          />
          <form id="message-composer" className={`composer ${!me ? "disabled" : ""} ${pendingImage ? "has-image" : ""}`} onSubmit={sendMessage}>
            <button type="button" className="attach-button" disabled={!canAttachImage || pendingImage?.status === "sending"} onClick={() => imageInputRef.current?.click()} aria-label="Attach an image" title="Attach image"><Icon name="image" size={17} /></button>
            <button type="button" className={`attach-button ${imageUrlOpen ? "active" : ""}`} disabled={!canAttachImage || pendingImage?.status === "sending"} onClick={() => setImageUrlOpen((value) => !value)} aria-label="Attach a direct image URL" title="Attach direct HTTPS image URL"><Icon name="link" size={16} /></button>
            <textarea
              ref={composerInputRef}
              id="message-composer-input"
              dir="auto"
              aria-describedby={replyTo ? "replying-to-message" : undefined}
              value={composer}
              onChange={(event) => notifyTyping(event.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={me ? `Message ${activeThread ? activeTitle : `#${activeTitle}`}` : "Join the room to send a message"}
              disabled={!me || pendingImage?.status === "sending"}
              rows={1}
              maxLength={500}
            />
            <span className={`char-count ${composer.length > 440 ? "show" : ""}`}>{500 - composer.length}</span>
            <button
              type="button"
              className={`emoji-button ${emojiPickerTarget?.kind === "composer" ? "active" : ""}`}
              disabled={!me || pendingImage?.status === "sending"}
              data-emoji-picker-trigger
              onClick={(event) => toggleEmojiPicker({ kind: "composer" }, event.currentTarget)}
              aria-label="Choose an emoji"
              aria-haspopup="dialog"
              aria-expanded={emojiPickerTarget?.kind === "composer"}
            ><Icon name="smile" /></button>
            <button type="submit" className="send-button" disabled={!me || (!composer.trim() && !pendingImage) || pendingImage?.status === "preparing" || pendingImage?.status === "sending"}>{pendingImage?.status === "sending" ? <span className="button-spinner" /> : <Icon name="send" size={17} />}</button>
          </form>
          <div className="composer-note"><Icon name="spark" size={11} /> {activeThread
            ? activePeer?.kind === "ai"
              ? "Images and captions stay inside this private conversation. This AI resident can view the sanitized image."
              : "Images and captions stay inside this private conversation."
            : "AI residents may read public messages and view shared images. Public HTTPS links may unfurl; an explicit read/check request lets the server fetch bounded page text. DMs stay out of public context."}</div>
        </div>

        <nav className="mobile-nav mobile-only">
          <button onClick={() => setMobilePanel("rooms")}><Icon name="hash" /><span>Rooms</span></button>
          <button className={!voiceViewRoomId ? "active" : ""} onClick={() => setVoiceViewRoomId(null)}><Icon name="message" /><span>Chat</span></button>
          <button className={voiceViewRoomId ? "active voice-nav-button" : "voice-nav-button"} onClick={() => { const room = joinedVoiceRoom ?? voiceRooms[0]; if (room) setVoiceViewRoomId(room.id); else setMobilePanel("rooms"); }}><Icon name="speaker" /><span>Voice</span>{joinedVoiceRoomId && <i />}</button>
          <button onClick={() => setMobilePanel("people")}><Icon name="users" /><span>People</span></button>
        </nav>
      </main>

      {emojiPickerTarget && (
        <EmojiPicker
          anchor={emojiPickerAnchorRef.current}
          label={emojiPickerTarget.kind === "reaction" ? "Add reaction" : "Choose emoji"}
          onClose={closeEmojiPicker}
          onSelect={(emoji) => {
            if (emojiPickerTarget.kind === "reaction") {
              const message = messages.find((candidate) => candidate.id === emojiPickerTarget.messageId);
              if (message) react(message, emoji);
              closeEmojiPicker(true);
            } else {
              insertComposerEmoji(emoji);
            }
          }}
        />
      )}

      <aside className={`member-panel ${mobilePanel === "people" ? "mobile-open" : ""}`}>
        <div className="member-panel-head"><div><strong>{voiceRoomInView ? "In voice" : "In the room"}</strong><span>{voiceRoomInView ? `${voiceRoomInView.participants.length} connected` : `${connectedHumans.length} people here · ${offlineHumans.length} offline members · ${activeResidents.length} active residents`}</span></div><button className="icon-button mobile-only" onClick={() => setMobilePanel(null)}><Icon name="close" /></button></div>
        {!voiceRoomInView && <div className="room-pulse-card" onClick={() => setShowDirector(true)} role="button" tabIndex={0}>
          <div className="pulse-orb"><i /><i /><i /></div>
          <div><strong>Room pulse</strong><span>{typingMembers.length ? `${typingMembers.length} composing now` : directorEvents.at(-1)?.summary ?? "Quietly paying attention"}</span></div>
          <Icon name="chevron" size={15} />
        </div>}
        <div className="member-scroll">
          {voiceRoomInView ? <><MemberGroup title="Connected" members={voicePanelMembers} onSelect={setProfile} /><MemberGroup title="Available AI residents" members={availableVoiceBots.slice(0, 10)} onSelect={setProfile} /></> : <><MemberGroup title="Online people" members={onlineHumans} onSelect={setProfile} /><MemberGroup title="Idle" members={idleHumans} onSelect={setProfile} /><MemberGroup title="Offline members" members={offlineHumans} onSelect={setProfile} /><MemberGroup title="Active residents" members={activeResidents} onSelect={setProfile} /><MemberGroup title="Around · quieter" members={quietResidents} onSelect={setProfile} /></>}
        </div>
        <div className="model-card">
          <div className="model-icon"><Icon name="spark" size={15} /></div>
          <div><span>Cast engine</span><strong>{health?.model.label ?? "checking AI provider"}</strong></div>
          <i className={health?.model.connected ? "online" : "offline"} />
        </div>
      </aside>

      {!me && (
        <div className="join-overlay">
          <form className="join-card" onSubmit={pendingAdultAdmission ? confirmPendingAdultAdmission : join}>
            <div className="join-live"><i /> LIVE ROOM <span>{(preview?.health.onlineHumans ?? 0) + (preview?.health.idleHumans ?? 0)} real people connected</span></div>
            <div className="join-logo"><BrandMark large /></div>
            <p className="join-kicker">THE THIRD PLACE</p>
            <h2>{joinHeading}</h2>
            <p className="join-copy">{joinCopy}</p>
            {!pendingAdultAdmission && (
              <>
                <div className="join-auth-tabs" role="group" aria-label="Account options">
                  <button type="button" aria-pressed={authJoinMode === "login"} className={authJoinMode === "login" ? "active" : ""} onClick={() => selectAuthJoinMode("login")} disabled={joining}>Log in</button>
                  <button type="button" aria-pressed={authJoinMode === "register"} className={authJoinMode === "register" ? "active" : ""} onClick={() => selectAuthJoinMode("register")} disabled={joining}>Create account</button>
                </div>
                {(authJoinMode === "register" || authJoinMode === "guest" || authJoinMode === "legacy") && <label><span>Display name</span><input autoFocus dir="auto" value={joinName} onChange={(event) => { setJoinName(event.target.value); setJoinError(""); setTakeoverRequired(false); }} placeholder={authJoinMode === "legacy" ? "The exact name you used before" : "What should everyone call you?"} maxLength={24} autoComplete="nickname" /></label>}
                {(authJoinMode === "login" || authJoinMode === "register") && <label><span>Username</span><input autoFocus={authJoinMode === "login"} value={loginHandle} onChange={(event) => { setLoginHandle(event.target.value); setJoinError(""); }} placeholder="Your local username" maxLength={64} autoCapitalize="none" autoComplete="username" spellCheck={false} /></label>}
                {(authJoinMode === "login" || authJoinMode === "register") && <label><span>Password</span><input value={accountPassword} onChange={(event) => { setAccountPassword(event.target.value); setJoinError(""); }} placeholder={authJoinMode === "register" ? "At least 8 characters" : "Your password"} type="password" autoComplete={authJoinMode === "register" ? "new-password" : "current-password"} maxLength={1024} /></label>}
                {authJoinMode === "register" && <label><span>Confirm password</span><input value={accountPasswordConfirm} onChange={(event) => { setAccountPasswordConfirm(event.target.value); setJoinError(""); }} placeholder="Type it once more" type="password" autoComplete="new-password" maxLength={1024} /></label>}
                {authJoinMode === "register" && accountPasswordConfirm && accountPassword !== accountPasswordConfirm && <span className="join-field-hint error" role="alert">The passwords do not match.</span>}
                {authJoinMode === "legacy" && <label><span>Old return key</span><input value={returnKey} onChange={(event) => { setReturnKey(event.target.value); setJoinError(""); setTakeoverRequired(false); }} placeholder="Paste your private return key" type="password" autoComplete="off" spellCheck={false} /></label>}
                {preview?.inviteRequired && <label><span>Invite code</span><input value={inviteCode} onChange={(event) => { setInviteCode(event.target.value); setJoinError(""); setTakeoverRequired(false); }} placeholder="Enter the code" type="password" /></label>}
              </>
            )}
            <label className="join-age-confirmation">
              <input
                type="checkbox"
                checked={adultConfirmed}
                onChange={(event) => {
                  setAdultConfirmed(event.target.checked);
                  setJoinError("");
                  setTakeoverRequired(false);
                }}
              />
              <span>
                <strong>I confirm that I’m 18 or older</strong>
                <small>The Third Place is an adult community. Conversations may include strong language and mature themes.</small>
              </span>
            </label>
            {joinError && <div className="join-error" role="alert">{joinError}</div>}
            {!pendingAdultAdmission && takeoverRequired ? (
              <div className="join-takeover" role="alert">
                <div><Icon name="info" size={17} /><span><strong>Already open somewhere else</strong>This return key is valid, but the identity is currently connected. Taking over will sign out the other browser.</span></div>
                <div className="join-takeover-actions"><button type="button" onClick={() => setTakeoverRequired(false)} disabled={joining}>Not now</button><button type="button" onClick={() => void submitIdentityJoin(true)} disabled={joining || !identityJoinReady}>{joining ? <><span className="button-spinner" />Moving…</> : "Take over identity"}</button></div>
              </div>
            ) : (
              <button className="join-button" type="submit" disabled={joining || !identityJoinReady}>{joining ? <><span className="spinner" />Opening the door…</> : <>{pendingAdultAdmission ? `Continue as ${pendingAdultAdmission.me.name}` : authJoinMode === "login" ? "Log in" : authJoinMode === "register" ? "Create local account" : authJoinMode === "legacy" ? "Return to the room" : "Enter as guest"} <Icon name="chevron" size={17} /></>}</button>
            )}
            {!pendingAdultAdmission && <div className="join-secondary-actions">
              <button type="button" className={authJoinMode === "guest" ? "active" : ""} onClick={() => selectAuthJoinMode(authJoinMode === "guest" ? "login" : "guest")} disabled={joining}>{authJoinMode === "guest" ? "Use a local account" : "Continue as guest"}</button>
              <span aria-hidden="true">·</span>
              <button type="button" className={authJoinMode === "legacy" ? "active" : ""} onClick={() => selectAuthJoinMode(authJoinMode === "legacy" ? "login" : "legacy")} disabled={joining}>{authJoinMode === "legacy" ? "Use a local account" : "I have an old return key"}</button>
            </div>}
            <div className="join-disclosure"><Icon name="info" size={16} /><span><strong>Accounts stay on this computer.</strong> Passwords, sessions, memories and private chats are stored by this server; no email or external identity service is used. Guests are temporary and erased on explicit logout. AI runs locally; optional research and link reads may use the web.</span></div>
            <p className="preview-hint"><i /><span>You're seeing the real room live behind this card.</span></p>
          </form>
        </div>
      )}

      {recoveryKeyNotice && (
        <div className="recovery-key-backdrop" role="presentation">
          <article className="recovery-key-card" role="dialog" aria-modal="true" aria-labelledby="recovery-key-title">
            <span className="recovery-key-icon"><Icon name="lock" size={23} /></span>
            <p className="join-kicker">YOUR RETURN KEY</p>
            <h2 id="recovery-key-title">Save this somewhere private.</h2>
            <p>This key lets you return as the same person — with the same conversations and relationships — from another browser or device while this identity is retained.</p>
            <label><span>Return key</span><input ref={recoveryKeyInputRef} readOnly value={recoveryKeyNotice} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} /></label>
            <button className="recovery-key-copy" type="button" onClick={() => void copyRecoveryKey()}><Icon name={recoveryKeyCopied ? "spark" : "lock"} size={16} />{recoveryKeyCopied ? "Copied" : "Copy return key"}</button>
            {recoveryKeyCopyHelp && <span className="recovery-key-copy-help" role="status">Automatic copy was blocked. The full key is selected; copy it with your browser or keyboard.</span>}
            <div className="recovery-key-warning"><Icon name="info" size={16} /><span><strong>Shown once.</strong> The server cannot reveal this key later. Anyone who has it can open this identity.</span></div>
            <button className="recovery-key-done" type="button" onClick={closeRecoveryKeyNotice}>I’ve saved it</button>
          </article>
        </div>
      )}

      {showDirector && (
        <div className="drawer-backdrop" onClick={() => setShowDirector(false)}>
          <aside className="director-drawer" onClick={(event) => event.stopPropagation()}>
            <header><div className="director-icon"><Icon name="pulse" /></div><div><span>BACKSTAGE</span><h2>Director view</h2></div><button className="icon-button" onClick={() => setShowDirector(false)}><Icon name="close" /></button></header>
            <div className="director-explainer"><Icon name="info" size={17} /><p>This is the restraint layer. It chooses who notices, who reacts and — crucially — who stays quiet. The selected model only writes for that cast.</p></div>
            <div className="director-health">
              <div><span className="metric-value">{health?.model.queueDepth ?? 0}</span><small>in queue</small></div>
              <div><span className="metric-value">{health?.aiPace ?? "lively"}</span><small>room pace</small></div>
              <div><span className={`model-dot ${health?.model.connected ? "on" : ""}`} /><small>{health?.model.connected ? "model live" : "fallback"}</small></div>
            </div>
            <p className="eyebrow director-label">Recent decisions</p>
            <div className="director-feed">
              {[...directorEvents].reverse().map((event) => (
                <article key={event.id}>
                <div className={`event-glyph event-${event.trigger}`}><Icon name={event.trigger === "ambient" ? "spark" : event.trigger === "dm" ? "lock" : event.trigger === "research" ? "search" : "pulse"} size={15} /></div>
                  <div className="event-body"><div><strong>{event.trigger}</strong><time>{formatRelative(event.createdAt)}</time></div><p dir="auto">{event.summary}</p><div className="decision-grid"><span><b>{event.considered}</b> considered</span><span><b>{event.replied}</b> replied</span><span><b>{event.reacted}</b> reacted</span><span className="quiet"><b>{event.stayedQuiet}</b> quiet</span></div></div>
                </article>
              ))}
              {directorEvents.length === 0 && <div className="director-empty"><span className="typing-dots"><i /><i /><i /></span><p>Waiting for the first live decision.</p></div>}
            </div>
          </aside>
        </div>
      )}

      {profile && (
        <div className="profile-backdrop" onClick={() => setProfile(null)}>
          <article className="profile-card" onClick={(event) => event.stopPropagation()}>
            <div className="profile-cover" style={{ "--profile": profile.avatar.color, "--accent": profile.avatar.accent } as React.CSSProperties} />
            <button className="profile-close" onClick={() => setProfile(null)}><Icon name="close" /></button>
            <Avatar member={profile} size="xl" />
            <div className="profile-body">
              <div className="profile-name"><h2 dir="auto">{profile.name}</h2>{profile.kind === "ai" && <AiBadge label="AI RESIDENT" />}</div>
              <p className="profile-role" dir="auto">{profile.role}</p>
              <p className="profile-bio" dir="auto">{profile.bio}</p>
              <div className="profile-facts">
                <span><small>STATUS</small><b dir="auto"><i className={`presence-${profile.status}`} />{profile.status}</b></span>
                {profile.activity && <span><small>CURRENTLY</small><b dir="auto">{profile.activity}</b></span>}
                <span><small>MEMORY</small><b>{me && profile.id === me.id
                  ? sessionIdentity?.kind === "registered"
                    ? "Persistent local account"
                    : sessionIdentity?.kind === "legacy"
                      ? "Legacy saved identity"
                      : "Temporary guest identity"
                  : profile.kind === "ai"
                    ? "Recent room context"
                    : profile.status === "offline"
                      ? "Local member"
                      : "Human visitor"}</b></span>
              </div>
              {me && profile.id === me.id && sessionIdentity?.kind === "registered" && (
                <div className="profile-account-status">
                  <Icon name="lock" size={16} />
                  <span><strong>Local account</strong><small>@{sessionIdentity.loginHandle} · Your identity and private chats remain after logout.</small></span>
                </div>
              )}
              {me && profile.id === me.id && sessionIdentity && sessionIdentity.kind !== "registered" && (
                <form className="profile-upgrade" onSubmit={upgradeCurrentIdentity}>
                  <div><Icon name="lock" size={16} /><span><strong>Keep this identity</strong><small>Create a local account without losing relationships, memories or DMs.</small></span></div>
                  <label><span>Username</span><input value={upgradeLoginHandle} onChange={(event) => { setUpgradeLoginHandle(event.target.value); setUpgradeError(""); }} autoCapitalize="none" autoComplete="username" maxLength={64} spellCheck={false} /></label>
                  <label><span>Password</span><input value={upgradePassword} onChange={(event) => { setUpgradePassword(event.target.value); setUpgradeError(""); }} type="password" autoComplete="new-password" maxLength={1024} placeholder="At least 8 characters" /></label>
                  <label><span>Confirm password</span><input value={upgradePasswordConfirm} onChange={(event) => { setUpgradePasswordConfirm(event.target.value); setUpgradeError(""); }} type="password" autoComplete="new-password" maxLength={1024} placeholder="Type it once more" /></label>
                  {upgradePasswordConfirm && upgradePassword !== upgradePasswordConfirm && <span className="profile-upgrade-error" role="alert">The passwords do not match.</span>}
                  {upgradeError && <span className="profile-upgrade-error" role="alert">{upgradeError}</span>}
                  <button type="submit" disabled={upgradingAccount || !upgradeLoginHandle.trim() || [...upgradePassword].length < 8 || upgradePassword !== upgradePasswordConfirm}>{upgradingAccount ? <><span className="button-spinner" />Creating…</> : "Create account and keep everything"}</button>
                </form>
              )}
              {me && profile.id === me.id && sessionIdentity?.kind === "legacy" && (
                <div className="profile-return-key">
                  <div><Icon name="lock" size={16} /><span><strong>Legacy return key</strong><small>A new key replaces any key you saved earlier.</small></span></div>
                  {returnKeyIssueConfirming ? <div className="profile-return-key-confirm"><span>Generate a fresh private key now?</span><div><button type="button" onClick={() => setReturnKeyIssueConfirming(false)} disabled={issuingRecoveryKey}>Cancel</button><button type="button" onClick={() => void issueRecoveryKey()} disabled={issuingRecoveryKey}>{issuingRecoveryKey ? <><span className="button-spinner" />Creating…</> : "Create new key"}</button></div></div> : <button type="button" onClick={() => setReturnKeyIssueConfirming(true)}>Create or rotate return key</button>}
                </div>
              )}
              {me && profile.id === me.id && <button type="button" className="profile-forget" onClick={() => void forgetAiMemory()} disabled={forgettingMemory} aria-busy={forgettingMemory}>{forgettingMemory ? <><span className="button-spinner" aria-hidden="true" />Forgetting…</> : "Forget what AI remembers"}</button>}
              {me && profile.id === me.id && sessionIdentity && (
                <button type="button" className={`profile-logout ${sessionIdentity.kind === "registered" ? "" : "destructive"}`} onClick={() => void logOut()} disabled={loggingOut} aria-busy={loggingOut}>
                  {loggingOut
                    ? <><span className="button-spinner" />Leaving…</>
                    : sessionIdentity.kind === "registered"
                      ? "Log out — keep account and DMs"
                      : sessionIdentity.kind === "guest"
                        ? "Leave and erase this guest identity"
                        : "Leave and erase this legacy identity"}
                </button>
              )}
              {me && profile.id !== me.id && <button className="profile-message" onClick={() => openDm(profile)}><Icon name="message" /> Message <span dir="auto">{profile.name}</span></button>}
            </div>
          </article>
        </div>
      )}

      {lightbox && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`Image shared by ${lightbox.authorName}`} onMouseDown={(event) => event.currentTarget === event.target && closeLightbox()}>
          <button ref={lightboxCloseRef} type="button" className="lightbox-close" onClick={closeLightbox} aria-label="Close image"><Icon name="close" size={20} /></button>
          <figure>
            <img
              src={lightbox.attachment.url}
              alt={lightbox.attachment.analysis.status === "ready" ? lightbox.attachment.analysis.observation.summary : `Image shared by ${lightbox.authorName}`}
              width={lightbox.attachment.width}
              height={lightbox.attachment.height}
            />
            <figcaption>
              <strong dir="auto">{lightbox.authorName}</strong>
              {lightbox.attachment.analysis.status === "ready" && <span dir="auto">{lightbox.attachment.analysis.observation.summary}</span>}
              {lightbox.attachment.analysis.status === "pending" && <span>{activeThread ? "This AI resident is still looking at the image…" : "AI residents are still looking at this image…"}</span>}
              {lightbox.attachment.analysis.status === "not_requested" && <span>Shared privately without AI image analysis.</span>}
            </figcaption>
          </figure>
        </div>
      )}

      {mobilePanel && <button className="mobile-scrim mobile-only" onClick={() => setMobilePanel(null)} aria-label="Close panel" />}
      <div className="toast-stack">{toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><i /><div><strong dir="auto">{toast.title}</strong><span dir="auto">{toast.message}</span></div><button onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><Icon name="close" size={14} /></button></div>)}</div>
    </div>
  );
}

function MemberGroup({ title, members, onSelect }: { title: string; members: Member[]; onSelect: (member: Member) => void }) {
  if (members.length === 0) return null;
  return (
    <section className="member-group"><p className="eyebrow">{title} <span>{members.length}</span></p>{members.map((member) => <button className="member-row" key={member.id} onClick={() => onSelect(member)}><Avatar member={member} size="sm" /><span className="member-copy"><strong dir="auto">{member.name}{member.kind === "ai" && <AiBadge />}</strong><small dir="auto">{member.activity ?? member.role}</small></span></button>)}</section>
  );
}
