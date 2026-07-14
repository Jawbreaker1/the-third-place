import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ActionResult,
  CatalogUpdatePayload,
  Channel,
  ChatMessage,
  DirectorEvent,
  DmThread,
  DmUpdatePayload,
  HistoryPage,
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
import { VoicePeerMesh } from "./voicePeer";
import { VoiceActivityDetector, type VoiceActivityEvent } from "./voiceActivity";
import { conversationEntryTarget, type ConversationViewport, type PendingConversationEntry } from "./chatScroll";
import { formatSourceDate, linkPreviewAriaLabel, linkPreviewDomainLabel } from "./linkPreview";
import {
  createBrowserVoicePlaybackController,
  type VoiceAiSpeechPayload,
  type VoicePlaybackController,
} from "./voicePlayback";
import { clearChannelNotice, firstUnreadDmMessageId, nextDmUnread, noteChannelMessage, type ChannelNotices } from "./unread";

const REACTIONS = ["👍", "👀", "😂", "💀", "🤔", "💛", "🔥", "✨"];
const CLIENT_CHANNEL_MESSAGE_LIMIT = 600;

type ConnectionState = "preview" | "connecting" | "live" | "reconnecting" | "offline";
type Panel = "rooms" | "people" | null;
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
      aria-label={`${member.name} avatar`}
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
  const [joinError, setJoinError] = useState("");
  const [joining, setJoining] = useState(false);
  const [showDirector, setShowDirector] = useState(false);
  const [profile, setProfile] = useState<Member | null>(null);
  const [forgettingMemory, setForgettingMemory] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<Panel>(null);
  const [toasts, setToasts] = useState<Array<ToastPayload & { id: number }>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [channelNotices, setChannelNotices] = useState<ChannelNotices>({});
  const [unreadDividers, setUnreadDividers] = useState<Record<string, string | undefined>>({});
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
  const [voiceTranscripts, setVoiceTranscripts] = useState<Record<string, VoiceTranscriptEntry[]>>({});
  const [voiceTypedTurn, setVoiceTypedTurn] = useState("");
  const [, setRemoteStreamRevision] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const meRef = useRef<Member | null>(null);
  const activeChannelRef = useRef("lobby");
  const channelsRef = useRef<Channel[]>([]);
  const membersRef = useRef<Member[]>([]);
  const dmThreadsRef = useRef<DmThread[]>([]);
  const typingTimer = useRef<number | undefined>(undefined);
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
  const voiceAudioBlocked = voiceAiAudioBlocked || voiceRemoteAudioBlocked;
  voiceHasAiListenerRef.current = voiceRooms.some(
    (room) => room.id === joinedVoiceRoomId && room.participants.some((participant) => participant.kind === "ai"),
  );
  voiceRemoteSpeakingRef.current = voiceRooms.some(
    (room) => room.id === joinedVoiceRoomId && room.participants.some(
      (participant) => participant.kind === "human" && participant.memberId !== me?.id && participant.speaking,
    ),
  );

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
    setVoiceVadPaused(false);
  }, []);

  const startVoiceVad = useCallback((stream: MediaStream) => {
    stopVoiceVad();
    if (!("AudioContext" in window)) return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.62;
    context.createMediaStreamSource(stream).connect(analyser);
    voiceAudioContextRef.current = context;
    context.onstatechange = () => setVoiceVadPaused(context.state !== "running" && context.state !== "closed");
    voiceActivityRef.current = new VoiceActivityDetector({ startFrames: 2, minSpeechMs: 140 });
    const samples = new Float32Array(analyser.fftSize);
    const sample = () => {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const value of samples) energy += value * value;
      const rms = Math.sqrt(energy / samples.length);
      const now = performance.now();
      const events = voiceActivityRef.current.push({
        nowMs: now,
        rms,
        suppressed: !joinedVoiceRoomRef.current || voiceMutedRef.current || voiceDeafenedRef.current,
        playbackActive: voicePlaybackActiveRef.current || voiceRemoteSpeakingRef.current,
      });
      for (const event of events) {
        voiceActivityEventRef.current(event);
      }
      voiceVadFrameRef.current = requestAnimationFrame(sample);
    };
    void ensureVoiceVadRunning();
    voiceVadFrameRef.current = requestAnimationFrame(sample);
  }, [ensureVoiceVadRunning, stopVoiceVad]);

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
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

  const applySnapshot = useCallback((snapshot: RoomSnapshot) => {
    shouldStickToBottom.current = true;
    meRef.current = snapshot.me;
    setMe(snapshot.me);
    membersRef.current = snapshot.members;
    setMembers(snapshot.members);
    channelsRef.current = snapshot.channels;
    setChannels(snapshot.channels);
    setMessages(snapshot.messages);
    setHistoryPageInfo(snapshot.historyPageInfo ?? {});
    dmThreadsRef.current = snapshot.dmThreads;
    setDmThreads(snapshot.dmThreads);
    setHealth(snapshot.health);
    setDirectorEvents(snapshot.directorEvents);
    setConnection("live");
  }, []);

  const connectSocket = useCallback(() => {
    socketRef.current?.disconnect();
    setConnection("connecting");
    const socket = io({ transports: ["websocket", "polling"], withCredentials: true, reconnection: true });
    socketRef.current = socket;

    socket.on("room:snapshot", applySnapshot);
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
      // Catalog updates omit offline humans, so only remove a DM when a
      // previously known AI resident has actually left the catalog.
      const survivingThreads = dmThreadsRef.current.filter((thread) => !removedAiIds.has(thread.peerId));
      dmThreadsRef.current = survivingThreads;
      setDmThreads(survivingThreads);
      setProfile((current) => current
        ? payload.members.find((member) => member.id === current.id) ?? null
        : null);

      if (activePublicRoomWasRemoved || activeDmResidentWasRemoved) {
        const fallbackId = payload.channels.find((channel) => channel.id === "lobby")?.id
          ?? payload.channels[0]?.id;
        if (fallbackId) {
          shouldStickToBottom.current = true;
          activeChannelRef.current = fallbackId;
          setActiveChannelId(fallbackId);
          setReplyTo(null);
          setMobilePanel(null);
          setChannelNotices((current) => clearChannelNotice(current, fallbackId));
          pushToast({
            tone: "info",
            title: activeDmResidentWasRemoved ? "Conversation closed" : "Room changed",
            message: activeDmResidentWasRemoved
              ? "That AI resident was removed by an administrator. Existing history remains on the server."
              : "That room was removed by an administrator. You were moved to the lobby.",
          });
        }
      }
    });
    socket.on("typing:member", (payload: TypingMemberPayload) => {
      setTyping((current) => {
        const channel = new Set(current[payload.channelId] ?? []);
        if (payload.active) channel.add(payload.memberId);
        else channel.delete(payload.memberId);
        return { ...current, [payload.channelId]: [...channel] };
      });
    });
    socket.on("director:event", (event: DirectorEvent) => setDirectorEvents((current) => [...current.slice(-23), event]));
    socket.on("health:update", (nextHealth: ServerHealth) => setHealth(nextHealth));
    socket.on("dm:update", (payload: DmUpdatePayload) => {
      const activeChannelId = activeChannelRef.current;
      const activeThreadIsRead = payload.thread.id !== activeChannelId || shouldStickToBottom.current;
      setDmThreads((current) => {
        const previousUnread = current.find((thread) => thread.id === payload.thread.id)?.unread ?? 0;
        const nextThread = {
          ...payload.thread,
          unread: nextDmUnread(
            previousUnread,
            payload.message,
            payload.thread.id,
            activeChannelId,
            meRef.current?.id,
            activeThreadIsRead,
          ),
        };
        const exists = current.some((thread) => thread.id === payload.thread.id);
        const next = exists
          ? current.map((thread) => (thread.id === payload.thread.id ? nextThread : thread))
          : [...current, nextThread];
        dmThreadsRef.current = next;
        return next;
      });
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
    socket.on("toast", pushToast);
    socket.on("session:moderated", (payload: { action: "kick" | "ban"; message?: string }) => {
      pushToast({
        tone: "warning",
        title: payload.action === "ban" ? "Access removed" : "Disconnected by an administrator",
        message: payload.message ?? (payload.action === "ban"
          ? "You have been banned from this room."
          : "You can reconnect after a short cooldown."),
      });
      clearVoiceMedia();
      joinedVoiceRoomRef.current = null;
      setJoinedVoiceRoomId(null);
      setVoiceJoinState("idle");
      meRef.current = null;
      setMe(null);
      setConnection("preview");
      socket.disconnect();
    });
    socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") setConnection("reconnecting");
      if (reason !== "io client disconnect" && joinedVoiceRoomRef.current) setVoiceJoinState("reconnecting");
    });
    socket.on("connect", () => {
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
      if (["AUTH_REQUIRED", "BANNED", "KICK_COOLDOWN"].includes(error.message)) {
        setMe(null);
        meRef.current = null;
        clearVoiceMedia();
        joinedVoiceRoomRef.current = null;
        setJoinedVoiceRoomId(null);
        setVoiceJoinState("idle");
        setConnection("preview");
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
  }, [applySnapshot, clearVoiceMedia, createVoiceMesh, playVoiceAiSpeech, pushToast, upsertVoiceRoom]);

  useEffect(() => {
    let alive = true;
    void fetch("/api/preview")
      .then((response) => response.json())
      .then((data: PublicPreview) => {
        if (!alive) return;
        setPreview(data);
        setMembers(data.members);
        channelsRef.current = data.channels;
        setChannels(data.channels);
        setMessages(data.messages);
        setHealth(data.health);
      })
      .catch(() => setConnection("offline"));
    void fetch("/api/session")
      .then((response) => {
        if (response.ok && alive) connectSocket();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (joinedVoiceRoomRef.current) socketRef.current?.emit("voice:room:leave", { roomId: joinedVoiceRoomRef.current });
      clearVoiceMedia();
      socketRef.current?.disconnect();
    };
  }, [clearVoiceMedia, connectSocket]);

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
  const activeTitle = activeChannel?.name ?? activePeer?.name ?? "conversation";
  const activeDescription = activeChannel?.description ?? (activePeer?.kind === "ai" ? "Private chat with an AI resident" : "Private conversation");
  const typingMembers = (typing[activeChannelId] ?? []).map((id) => memberMap.get(id)).filter((member): member is Member => Boolean(member));
  const activeHistory = historyPageInfo[activeChannelId] ?? { hasMore: false };
  const pendingImage = imageDrafts[activeChannelId];
  const canAttachImage = Boolean(me && activeChannel);
  const voiceRoomInView = voiceRooms.find((room) => room.id === voiceViewRoomId);
  const joinedVoiceRoom = voiceRooms.find((room) => room.id === joinedVoiceRoomId);
  const voiceRoomTranscripts = voiceRoomInView ? voiceTranscripts[voiceRoomInView.id] ?? [] : [];
  const availableVoiceBots = members.filter((member) => member.kind === "ai" && !voiceRoomInView?.participants.some((participant) => participant.memberId === member.id));
  const voicePanelMembers = voiceRoomInView?.participants.map((participant) => memberMap.get(participant.memberId)).filter((member): member is Member => Boolean(member)) ?? [];

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
    if (!me || !channels.some((channel) => channel.id === channelId)) {
      pushToast({ tone: "warning", title: "Public rooms only", message: "Image sharing in private messages is coming later." });
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
    if (!me || !channels.some((channel) => channel.id === channelId)) {
      pushToast({ tone: "warning", title: "Public rooms only", message: "Image sharing in private messages is coming later." });
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
      // bottom anchor only when the guest was already following the latest
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

  const join = async (event: FormEvent) => {
    event.preventDefault();
    setJoinError("");
    setJoining(true);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: joinName, inviteCode: inviteCode || undefined }),
      });
      const result = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !result.ok) {
        setJoinError(result.error ?? "Could not join the room.");
        return;
      }
      connectSocket();
    } catch {
      setJoinError("The room is unreachable right now.");
    } finally {
      setJoining(false);
    }
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
      voicePlaybackRef.current?.bargeIn();
      setVoiceAiAudioBlocked(false);
      setVoiceBrowserSpeech(false);
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
    if (!voiceRoomInView || !socketRef.current) return;
    socketRef.current.emit("voice:bot:invite", { roomId: voiceRoomInView.id, personaId: memberId }, (result: VoiceInviteBotResult) => {
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
      if (!activeChannel || image.status === "preparing" || image.status === "sending") return;
      const channelId = activeChannelId;
      const rawComposer = composer;
      const previousReply = replyTo;
      updateImageDraft(channelId, { ...image, status: "sending", error: undefined });
      const form = new FormData();
      form.set("content", content);
      if (previousReply) form.set("replyToId", previousReply.id);
      if (image.source === "file" && image.file) form.set("image", image.file, image.file.name || "shared-image");
      if (image.source === "url" && image.imageUrl) form.set("imageUrl", image.imageUrl);
      try {
        const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/image-messages`, {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        const result = (await response.json()) as ImageMessageResult;
        if (!response.ok || !result.ok) throw new Error(result.ok ? "Image could not be shared." : result.error);
        setMessages((current) => current.some((message) => message.id === result.message.id)
          ? current
          : boundPublicMessages([...current, result.message]));
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
      const currentThread = dmThreads.find((thread) => thread.id === result.thread!.id);
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

  const report = (message: ChatMessage) => {
    socketRef.current?.emit("message:report", { messageId: message.id }, (result: ActionResult) => {
      if (!result.ok) pushToast({ tone: "warning", title: "Report failed", message: result.error });
    });
  };

  const selectChannel = (id: string) => {
    captureCurrentViewport();
    const firstUnreadMessageId = channelNotices[id]?.firstUnreadMessageId
      ?? firstUnreadDmMessageId(dmThreads.find((thread) => thread.id === id));
    queueConversationEntry(id, firstUnreadMessageId);
    setVoiceViewRoomId(null);
    setVoiceCreateOpen(false);
    activeChannelRef.current = id;
    setActiveChannelId(id);
    setChannelNotices((current) => clearChannelNotice(current, id));
    setDmThreads((current) => current.map((thread) => (thread.id === id ? { ...thread, unread: 0 } : thread)));
    setReplyTo(null);
    setSearch("");
    setImageUrlOpen(false);
    setImageUrlValue("");
    dragDepth.current = 0;
    setDragActive(false);
    setMobilePanel(null);
  };

  const onlineHumans = members.filter((member) => member.kind === "human" && member.status === "online");
  const activeResidents = members.filter((member) => member.kind === "ai" && member.status === "online");
  const quietResidents = members.filter((member) => member.kind === "ai" && member.status !== "online");
  const displayMembers = members.length ? members : preview?.members ?? [];

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
        <div className="sidebar-foot">
          {me ? (
            <><Avatar member={me} size="sm" /><div><strong dir="auto">{me.name}</strong><span>Guest · connected</span></div><span className="signal-bars"><i /><i /><i /></span></>
          ) : (
            <><span className="preview-eye"><Icon name="users" size={16} /></span><div><strong>Live preview</strong><span>Join to take part</span></div></>
          )}
        </div>
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
                  <div><strong dir="auto">{channels.find((channel) => channel.id === voiceRoomInView.channelId)?.name ?? "Voice room"}</strong><span>{voiceRoomInView.participants.length} connected · started by <span dir="auto">{memberMap.get(voiceRoomInView.createdByMemberId)?.name ?? "a guest"}</span></span></div>
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

                  {joinedVoiceRoomId === voiceRoomInView.id && voiceRoomInView.hostMemberId === me?.id && availableVoiceBots.length > 0 && (
                    <div className="voice-invite-panel">
                      <div><strong>Invite an AI friend</strong><span>Up to {voiceCapabilities?.maxBots ?? 2} AI residents can join. They remain visibly labelled.</span></div>
                      <div>{availableVoiceBots.slice(0, 8).map((bot) => <button type="button" key={bot.id} onClick={() => inviteVoiceBot(bot.id)}><Avatar member={bot} size="sm" /><span dir="auto">{bot.name}</span><AiBadge /></button>)}</div>
                    </div>
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
                              ? "Hands-free AI listening is on. Natural pauses send each spoken turn for transcription."
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
            <span className={`connection-pill ${connection}`}><i />{connection === "live" ? "live" : connection}</span>
            <button className={`icon-button ${showDirector ? "active" : ""}`} onClick={() => setShowDirector((value) => !value)} title="Director view"><Icon name="pulse" /></button>
            <button className={`icon-button ${searchOpen ? "active" : ""}`} onClick={() => setSearchOpen((value) => !value)} title="Search"><Icon name="search" /></button>
            <button className="people-button" onClick={() => setMobilePanel("people")}><Icon name="users" /><span>{onlineHumans.length + activeResidents.length}</span></button>
          </div>
          {searchOpen && <div className="search-pop"><Icon name="search" size={15} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search loaded messages in #${activeTitle}`} /><button onClick={() => { setSearch(""); setSearchOpen(false); }}><Icon name="close" size={14} /></button></div>}
        </header>

        <div
          className="message-scroller"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 110;
            shouldStickToBottom.current = atBottom;
            if (atBottom) {
              setChannelNotices((current) => clearChannelNotice(current, activeChannelId));
              setDmThreads((current) => current.map((thread) =>
                thread.id === activeChannelId && thread.unread > 0 ? { ...thread, unread: 0 } : thread,
              ));
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
            {activePeer?.kind === "ai" && <div className="transparency-note"><AiBadge label="AI RESIDENT" /><span>This character is generated by a local language model and remembers this private thread only while the server is running.</span></div>}
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
                className={`message ${grouped ? "grouped" : ""} ${historicalMessageIds.current.has(message.id) ? "historical" : ""}`}
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
                          {attachment.analysis.status === "pending" ? <><span className="analysis-pulse" /><span>AI residents are looking at this…</span></> : null}
                          {attachment.analysis.status === "ready" ? <><Icon name="spark" size={11} /><span>Seen by the room</span></> : null}
                          {attachment.analysis.status === "unavailable" ? <><Icon name="info" size={11} /><span>Visual description unavailable</span></> : null}
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
                  {message.reactions.length > 0 && (
                    <div className="reaction-row">
                      {message.reactions.map((reaction) => (
                        <button key={reaction.emoji} className={me && reaction.memberIds.includes(me.id) ? "mine" : ""} onClick={() => me && react(message, reaction.emoji)} disabled={!me}>
                          <span>{reaction.emoji}</span><b>{reaction.memberIds.length}</b>
                          <i>{reaction.memberIds.slice(0, 3).map((id) => memberMap.get(id)).filter((member): member is Member => Boolean(member)).map((member) => <Avatar key={member.id} member={member} size="sm" showStatus={false} />)}</i>
                        </button>
                      ))}
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
                    <button type="button" onClick={() => react(message, REACTIONS[Math.floor(Math.random() * REACTIONS.length)]!)} title="React"><Icon name="smile" size={16} /></button>
                    <button type="button" onClick={() => beginReply(message)} title="Reply" aria-label={`Reply to ${author.name}`} aria-controls="message-composer-input"><Icon name="reply" size={16} /></button>
                    <div className="reaction-menu">{REACTIONS.slice(0, 5).map((emoji) => <button key={emoji} onClick={() => react(message, emoji)}>{emoji}</button>)}</div>
                    <button onClick={() => report(message)} title="Report"><Icon name="flag" size={15} /></button>
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
            <button type="button" className="attach-button" disabled={!canAttachImage || pendingImage?.status === "sending"} onClick={() => imageInputRef.current?.click()} aria-label="Attach an image" title={activeThread ? "Images are currently available in public rooms" : "Attach image"}><Icon name="image" size={17} /></button>
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
            <button type="button" className="emoji-button" disabled={!me || pendingImage?.status === "sending"} onClick={() => notifyTyping(`${composer}${composer ? " " : ""}✨`)}><Icon name="smile" /></button>
            <button type="submit" className="send-button" disabled={!me || (!composer.trim() && !pendingImage) || pendingImage?.status === "preparing" || pendingImage?.status === "sending"}>{pendingImage?.status === "sending" ? <span className="button-spinner" /> : <Icon name="send" size={17} />}</button>
          </form>
          <div className="composer-note"><Icon name="spark" size={11} /> AI residents may read public messages and view shared images. Public HTTPS links may unfurl; an explicit read/check request lets the server fetch bounded page text. DMs stay out of public context.</div>
        </div>

        <nav className="mobile-nav mobile-only">
          <button onClick={() => setMobilePanel("rooms")}><Icon name="hash" /><span>Rooms</span></button>
          <button className={!voiceViewRoomId ? "active" : ""} onClick={() => setVoiceViewRoomId(null)}><Icon name="message" /><span>Chat</span></button>
          <button className={voiceViewRoomId ? "active voice-nav-button" : "voice-nav-button"} onClick={() => { const room = joinedVoiceRoom ?? voiceRooms[0]; if (room) setVoiceViewRoomId(room.id); else setMobilePanel("rooms"); }}><Icon name="speaker" /><span>Voice</span>{joinedVoiceRoomId && <i />}</button>
          <button onClick={() => setMobilePanel("people")}><Icon name="users" /><span>People</span></button>
        </nav>
      </main>

      <aside className={`member-panel ${mobilePanel === "people" ? "mobile-open" : ""}`}>
        <div className="member-panel-head"><div><strong>{voiceRoomInView ? "In voice" : "In the room"}</strong><span>{voiceRoomInView ? `${voiceRoomInView.participants.length} connected` : `${onlineHumans.length} guests · ${activeResidents.length} active residents`}</span></div><button className="icon-button mobile-only" onClick={() => setMobilePanel(null)}><Icon name="close" /></button></div>
        {!voiceRoomInView && <div className="room-pulse-card" onClick={() => setShowDirector(true)} role="button" tabIndex={0}>
          <div className="pulse-orb"><i /><i /><i /></div>
          <div><strong>Room pulse</strong><span>{typingMembers.length ? `${typingMembers.length} composing now` : directorEvents.at(-1)?.summary ?? "Quietly paying attention"}</span></div>
          <Icon name="chevron" size={15} />
        </div>}
        <div className="member-scroll">
          {voiceRoomInView ? <><MemberGroup title="Connected" members={voicePanelMembers} onSelect={setProfile} /><MemberGroup title="Available AI residents" members={availableVoiceBots.slice(0, 10)} onSelect={setProfile} /></> : <><MemberGroup title="Here now" members={onlineHumans} onSelect={setProfile} /><MemberGroup title="Active residents" members={activeResidents} onSelect={setProfile} /><MemberGroup title="Around · quieter" members={quietResidents} onSelect={setProfile} /></>}
        </div>
        <div className="model-card">
          <div className="model-icon"><Icon name="spark" size={15} /></div>
          <div><span>Local cast engine</span><strong>{health?.model.label ?? "checking LM Studio"}</strong></div>
          <i className={health?.model.connected ? "online" : "offline"} />
        </div>
      </aside>

      {!me && (
        <div className="join-overlay">
          <form className="join-card" onSubmit={join}>
            <div className="join-live"><i /> LIVE ROOM <span>{preview?.health.onlineHumans ?? 0} real guests here now</span></div>
            <div className="join-logo"><BrandMark large /></div>
            <p className="join-kicker">THE THIRD PLACE</p>
            <h2>Join the conversation.</h2>
            <p className="join-copy">A living online room populated by distinct AI characters — and real people like you.</p>
            <label><span>Display name</span><input autoFocus dir="auto" value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="What should everyone call you?" maxLength={24} /></label>
            {preview?.inviteRequired && <label><span>Invite code</span><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="Enter the code" type="password" /></label>}
            {joinError && <div className="join-error">{joinError}</div>}
            <button className="join-button" type="submit" disabled={joining || !validDisplayName(normalizeDisplayName(joinName))}>{joining ? <><span className="spinner" />Opening the door…</> : <>Enter the room <Icon name="chevron" size={17} /></>}</button>
            <div className="join-disclosure"><Icon name="info" size={16} /><span><strong>Humans and AI are always labelled.</strong> This server keeps a small local memory of return visits, rooms you use most, and non-sensitive preferences, activities or technical tools you explicitly share. No account or email is required, and you can erase it from your profile. AI runs locally; optional research, link previews and explicit linked-page reads use the web.</span></div>
            <p className="preview-hint"><i /><span>You're seeing the real room live behind this card.</span></p>
          </form>
        </div>
      )}

      {showDirector && (
        <div className="drawer-backdrop" onClick={() => setShowDirector(false)}>
          <aside className="director-drawer" onClick={(event) => event.stopPropagation()}>
            <header><div className="director-icon"><Icon name="pulse" /></div><div><span>BACKSTAGE</span><h2>Director view</h2></div><button className="icon-button" onClick={() => setShowDirector(false)}><Icon name="close" /></button></header>
            <div className="director-explainer"><Icon name="info" size={17} /><p>This is the restraint layer. It chooses who notices, who reacts and — crucially — who stays quiet. Gemma only writes for the selected cast.</p></div>
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
            <div className="profile-body"><div className="profile-name"><h2 dir="auto">{profile.name}</h2>{profile.kind === "ai" && <AiBadge label="AI RESIDENT" />}</div><p className="profile-role" dir="auto">{profile.role}</p><p className="profile-bio" dir="auto">{profile.bio}</p><div className="profile-facts"><span><small>STATUS</small><b dir="auto"><i className={`presence-${profile.status}`} />{profile.status}</b></span>{profile.activity && <span><small>CURRENTLY</small><b dir="auto">{profile.activity}</b></span>}<span><small>MEMORY</small><b>{me && profile.id === me.id ? "Small local memory" : profile.kind === "ai" ? "Recent room context" : "Human guest"}</b></span></div>{me && profile.id === me.id && <button type="button" className="profile-forget" onClick={() => void forgetAiMemory()} disabled={forgettingMemory} aria-busy={forgettingMemory}>{forgettingMemory ? <><span className="button-spinner" aria-hidden="true" />Forgetting…</> : "Forget what AI remembers"}</button>}{me && profile.id !== me.id && profile.status !== "offline" && <button className="profile-message" onClick={() => openDm(profile)}><Icon name="message" /> Message <span dir="auto">{profile.name}</span></button>}</div>
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
              {lightbox.attachment.analysis.status === "pending" && <span>AI residents are still looking at this image…</span>}
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
