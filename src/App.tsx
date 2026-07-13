import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ActionResult,
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
import { VoicePeerMesh } from "./voicePeer";

const REACTIONS = ["👍", "👀", "😂", "💀", "🤔", "💛", "🔥", "✨"];
const CLIENT_CHANNEL_MESSAGE_LIMIT = 600;

type ConnectionState = "preview" | "connecting" | "live" | "reconnecting" | "offline";
type Panel = "rooms" | "people" | null;
type VoiceJoinState = "idle" | "requesting-permission" | "joining" | "connected" | "reconnecting" | "leaving" | "error";
type VoiceRecordingState = "idle" | "recording" | "uploading" | "error";
type VoiceAiSpeech = { roomId: string; memberId: string; text: string; audioUrl?: string };
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
      src={large ? "/the-third-place-mark.svg" : "/favicon.svg"}
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
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(https?:\\/\\/[^\\s<>"']+${escaped.length ? `|@(?:${escaped.join("|")})` : ""})`, "gi");
  const parts = content.split(matcher);
  return (
    <>
      {parts.map((part, index) =>
        /^https?:\/\//i.test(part) ? (
          <Fragment key={`${part}-${index}`}>
            <a
              className="inline-link"
              href={part.replace(/[),.!?;:\]]+$/g, "")}
              target="_blank"
              rel="noopener noreferrer nofollow"
              referrerPolicy="no-referrer"
              aria-label={`Open external link in a new tab: ${part.replace(/[),.!?;:\]]+$/g, "")}`}
            >
              {part.replace(/[),.!?;:\]]+$/g, "")}
            </a>
            {part.slice(part.replace(/[),.!?;:\]]+$/g, "").length)}
          </Fragment>
        ) : part.startsWith("@") && names.some((name) => name.toLocaleLowerCase() === part.slice(1).toLocaleLowerCase()) ? (
          <span className="mention" key={`${part}-${index}`}>{part}</span>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
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
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [channelActivity, setChannelActivity] = useState<Record<string, number>>({});
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
  const [voiceRecording, setVoiceRecording] = useState<VoiceRecordingState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceCreateOpen, setVoiceCreateOpen] = useState(false);
  const [voiceAudioBlocked, setVoiceAudioBlocked] = useState(false);
  const [voiceBrowserSpeech, setVoiceBrowserSpeech] = useState(false);
  const [voiceTranscripts, setVoiceTranscripts] = useState<Record<string, VoiceTranscriptEntry[]>>({});
  const [voiceTypedTurn, setVoiceTypedTurn] = useState("");
  const [, setRemoteStreamRevision] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const meRef = useRef<Member | null>(null);
  const activeChannelRef = useRef("lobby");
  const typingTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottom = useRef(true);
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
  const voiceAiAudio = useRef(new Set<HTMLAudioElement>());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTurnBytesRef = useRef(0);
  const voiceRecordingTimer = useRef<number | undefined>(undefined);
  const voiceCapabilitiesRef = useRef<VoiceCapabilities | null>(null);
  const voiceDeafenedRef = useRef(false);
  const voiceMutedRef = useRef(true);
  const voiceRecordingRef = useRef(false);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceVadFrameRef = useRef<number | undefined>(undefined);
  const voiceVadSpeakingRef = useRef(false);
  const voiceVadLastEmitRef = useRef(0);

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

  const stopVoiceVad = useCallback(() => {
    if (voiceVadFrameRef.current !== undefined) cancelAnimationFrame(voiceVadFrameRef.current);
    voiceVadFrameRef.current = undefined;
    if (voiceVadSpeakingRef.current && joinedVoiceRoomRef.current) {
      socketRef.current?.emit("voice:self-state", {
        roomId: joinedVoiceRoomRef.current,
        muted: voiceMutedRef.current,
        deafened: voiceDeafenedRef.current,
        speaking: false,
      });
    }
    voiceVadSpeakingRef.current = false;
    const context = voiceAudioContextRef.current;
    voiceAudioContextRef.current = null;
    if (context && context.state !== "closed") void context.close();
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
    const samples = new Float32Array(analyser.fftSize);
    let loudFrames = 0;
    let quietSince = performance.now();
    const emitSpeaking = (speaking: boolean, now: number) => {
      if (voiceVadSpeakingRef.current === speaking || now - voiceVadLastEmitRef.current < 250) return;
      voiceVadSpeakingRef.current = speaking;
      voiceVadLastEmitRef.current = now;
      if (!joinedVoiceRoomRef.current) return;
      socketRef.current?.emit("voice:self-state", {
        roomId: joinedVoiceRoomRef.current,
        muted: voiceMutedRef.current,
        deafened: voiceDeafenedRef.current,
        speaking,
      });
    };
    const sample = () => {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const value of samples) energy += value * value;
      const rms = Math.sqrt(energy / samples.length);
      const now = performance.now();
      if (voiceRecordingRef.current) {
        loudFrames = 0;
        quietSince = now;
        voiceVadFrameRef.current = requestAnimationFrame(sample);
        return;
      }
      const suppressed = voiceMutedRef.current || voiceDeafenedRef.current;
      if (!suppressed && rms > 0.042) {
        loudFrames += 1;
        quietSince = now;
        if (loudFrames >= 3) emitSpeaking(true, now);
      } else {
        loudFrames = 0;
        if (rms > 0.021 && !suppressed) quietSince = now;
        if (suppressed || now - quietSince > 360) emitSpeaking(false, now);
      }
      voiceVadFrameRef.current = requestAnimationFrame(sample);
    };
    void context.resume();
    voiceVadFrameRef.current = requestAnimationFrame(sample);
  }, [stopVoiceVad]);

  const clearVoiceMedia = useCallback(() => {
    if (voiceRecordingTimer.current) window.clearTimeout(voiceRecordingTimer.current);
    voiceRecordingTimer.current = undefined;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    mediaRecorderRef.current = null;
    voiceChunksRef.current = [];
    voiceTurnBytesRef.current = 0;
    stopVoiceVad();
    voiceMeshRef.current?.close();
    voiceMeshRef.current = null;
    for (const track of localVoiceStreamRef.current?.getTracks() ?? []) track.stop();
    localVoiceStreamRef.current = null;
    for (const audio of voiceRemoteAudio.current.values()) audio.srcObject = null;
    voiceRemoteAudio.current.clear();
    voiceRemoteStreams.current.clear();
    for (const audio of voiceAiAudio.current) {
      audio.onerror = null;
      audio.onended = null;
      audio.pause();
      audio.src = "";
    }
    voiceAiAudio.current.clear();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setRemoteStreamRevision((value) => value + 1);
    voiceMutedRef.current = true;
    voiceRecordingRef.current = false;
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
    mesh.setInputEnabled(false);
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
        setVoiceMuted(true);
        voiceMutedRef.current = true;
        setVoiceError("The microphone was disconnected.");
      };
    }
    localVoiceStreamRef.current = stream;
    startVoiceVad(stream);
    return stream;
  }, [startVoiceVad]);

  const speakWithBrowserVoice = useCallback((speech: VoiceAiSpeech) => {
    if (speech.roomId !== joinedVoiceRoomRef.current || voiceDeafenedRef.current || !speech.text || !("speechSynthesis" in window)) return;
    setVoiceBrowserSpeech(true);
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(speech.text));
  }, []);

  const playVoiceAiSpeech = useCallback((speech: VoiceAiSpeech) => {
    if (speech.roomId !== joinedVoiceRoomRef.current || voiceDeafenedRef.current) return;
    if (speech.audioUrl) {
      try {
        const url = new URL(speech.audioUrl, window.location.origin);
        if (url.origin !== window.location.origin) throw new Error("cross-origin voice audio");
        const audio = new Audio(url.toString());
        let fellBack = false;
        const fallBack = () => {
          if (fellBack) return;
          fellBack = true;
          voiceAiAudio.current.delete(audio);
          audio.onerror = null;
          audio.pause();
          audio.src = "";
          speakWithBrowserVoice(speech);
        };
        voiceAiAudio.current.add(audio);
        audio.onended = () => voiceAiAudio.current.delete(audio);
        audio.onerror = fallBack;
        void audio.play().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "NotAllowedError") {
            setVoiceAudioBlocked(true);
            return;
          }
          fallBack();
        });
        return;
      } catch {
        // Fall through to the clearly disclosed browser voice.
      }
    }
    speakWithBrowserVoice(speech);
  }, [speakWithBrowserVoice]);

  const applySnapshot = useCallback((snapshot: RoomSnapshot) => {
    shouldStickToBottom.current = true;
    meRef.current = snapshot.me;
    setMe(snapshot.me);
    setMembers(snapshot.members);
    setChannels(snapshot.channels);
    setMessages(snapshot.messages);
    setHistoryPageInfo(snapshot.historyPageInfo ?? {});
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
      setMessages((current) =>
        current.some((item) => item.id === message.id) ? current : boundPublicMessages([...current, message]),
      );
      setChannelActivity((current) => ({ ...current, [message.channelId]: Date.now() }));
      if (message.channelId !== activeChannelRef.current) {
        setUnread((current) => ({ ...current, [message.channelId]: Math.min(99, (current[message.channelId] ?? 0) + 1) }));
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
      for (const audio of voiceAiAudio.current) {
        audio.onerror = null;
        audio.onended = null;
        audio.pause();
        audio.src = "";
      }
      voiceAiAudio.current.clear();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    });
    socket.on("voice:bot:state", (payload: { roomId: string; memberId: string; botState: VoiceRoomView["participants"][number]["botState"]; speaking?: boolean }) => {
      setVoiceRooms((current) => current.map((room) => room.id !== payload.roomId ? room : {
        ...room,
        participants: room.participants.map((participant) => participant.memberId === payload.memberId
          ? { ...participant, botState: payload.botState, speaking: payload.speaking ?? participant.speaking }
          : participant),
      }));
    });
    socket.on("presence:update", (payload: PresencePayload) => setMembers(payload.members));
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
      setDmThreads((current) => {
        const previousUnread = current.find((thread) => thread.id === payload.thread.id)?.unread ?? 0;
        const nextThread = {
          ...payload.thread,
          unread:
            payload.message && payload.thread.id !== activeChannelRef.current
              ? Math.min(99, previousUnread + 1)
              : payload.thread.id === activeChannelRef.current
                ? 0
                : previousUnread,
        };
        const exists = current.some((thread) => thread.id === payload.thread.id);
        return exists ? current.map((thread) => (thread.id === payload.thread.id ? nextThread : thread)) : [...current, nextThread];
      });
    });
    socket.on("toast", pushToast);
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
      if (error.message === "AUTH_REQUIRED") {
        setMe(null);
        meRef.current = null;
        clearVoiceMedia();
        joinedVoiceRoomRef.current = null;
        setJoinedVoiceRoomId(null);
        setVoiceJoinState("idle");
        setConnection("preview");
        socket.disconnect();
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
  const activeMessages = useMemo(() => {
    const source = activeThread ? activeThread.messages : messages.filter((message) => message.channelId === activeChannelId);
    if (!search.trim()) return source;
    return source.filter((message) => message.content.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  }, [activeChannelId, activeThread, messages, search]);
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
    const anchor = scroller?.querySelector<HTMLElement>("[data-message-id]");
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

  useEffect(() => {
    if (prependingHistoryChannels.current.has(activeChannelId)) return;
    if (!shouldStickToBottom.current) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
  }, [activeMessages.length, activeChannelId]);

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
      return;
    }
    setVoiceJoinState("joining");
    setVoiceError(null);
    socketRef.current.emit("voice:room:join", { roomId: room.id }, (result: VoiceJoinResult) => {
      if (generation !== voiceJoinGeneration.current) return;
      if (!result.ok) {
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (stream === localVoiceStreamRef.current) localVoiceStreamRef.current = null;
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
    voiceMeshRef.current?.setInputEnabled(!nextMuted);
    socketRef.current?.emit("voice:self-state", { roomId: joinedVoiceRoomRef.current, muted: nextMuted, deafened: voiceDeafened });
    setVoiceJoinState("connected");
  };

  const toggleVoiceDeafen = () => {
    const next = !voiceDeafened;
    setVoiceDeafened(next);
    voiceDeafenedRef.current = next;
    for (const audio of voiceRemoteAudio.current.values()) audio.muted = next;
    for (const audio of voiceAiAudio.current) audio.muted = next;
    if (next && "speechSynthesis" in window) window.speechSynthesis.cancel();
    if (joinedVoiceRoomRef.current) {
      socketRef.current?.emit("voice:self-state", { roomId: joinedVoiceRoomRef.current, muted: voiceMuted, deafened: next });
    }
  };

  const uploadVoiceTurn = useCallback(async (roomId: string, blob: Blob, mimeType: string) => {
    voiceRecordingRef.current = false;
    setVoiceRecording("uploading");
    const form = new FormData();
    form.set("audio", blob, `voice-turn.${mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm"}`);
    form.set("mimeType", mimeType);
    try {
      const response = await fetch(`/api/voice/${encodeURIComponent(roomId)}/turns`, { method: "POST", body: form, credentials: "same-origin" });
      const result = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? "The voice turn could not be transcribed.");
      setVoiceRecording("idle");
    } catch (error) {
      setVoiceRecording("error");
      setVoiceError(error instanceof Error ? error.message : "The voice turn could not be transcribed.");
    }
  }, []);

  const stopVoiceRecording = useCallback(() => {
    if (voiceRecordingTimer.current) window.clearTimeout(voiceRecordingTimer.current);
    voiceRecordingTimer.current = undefined;
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  const toggleVoiceRecording = async () => {
    const roomId = joinedVoiceRoomRef.current;
    if (!roomId || voiceRecording === "uploading") return;
    if (voiceRecording === "recording") {
      stopVoiceRecording();
      return;
    }
    if (!voiceCapabilities?.speechToText || !("MediaRecorder" in window)) {
      setVoiceError("Speech-to-text is unavailable. Send a typed turn instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await acquireVoiceStream();
      await voiceMeshRef.current?.setLocalStream(stream);
    } catch (error) {
      setVoiceError(describeMicrophoneError(error));
      return;
    }
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/webm",
      "audio/mp4",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    try {
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      voiceTurnBytesRef.current = 0;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        voiceChunksRef.current.push(event.data);
        voiceTurnBytesRef.current += event.data.size;
        if (voiceTurnBytesRef.current > 6 * 1024 * 1024 && recorder.state === "recording") recorder.stop();
      };
      recorder.onstop = () => {
        voiceRecordingRef.current = false;
        mediaRecorderRef.current = null;
        voiceMeshRef.current?.setInputEnabled(!voiceMuted);
        socketRef.current?.emit("voice:self-state", { roomId, muted: voiceMuted, deafened: voiceDeafened, speaking: false });
        const actualType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(voiceChunksRef.current, { type: actualType });
        const exceededLimit = voiceTurnBytesRef.current > 6 * 1024 * 1024;
        voiceChunksRef.current = [];
        voiceTurnBytesRef.current = 0;
        if (exceededLimit) {
          setVoiceRecording("error");
          setVoiceError("That voice turn exceeded 6 MB. Try a shorter turn.");
        } else if (blob.size) void uploadVoiceTurn(roomId, blob, actualType);
        else setVoiceRecording("error");
      };
      recorder.onerror = () => {
        voiceRecordingRef.current = false;
        setVoiceRecording("error");
        setVoiceError("Recording failed. Try the typed turn instead.");
      };
      voiceMeshRef.current?.setInputEnabled(true);
      socketRef.current?.emit("voice:self-state", { roomId, muted: false, deafened: voiceDeafened, speaking: !voiceDeafened });
      recorder.start(500);
      voiceRecordingRef.current = true;
      setVoiceRecording("recording");
      // Stop just inside the server's 30-second decoded-audio ceiling.
      voiceRecordingTimer.current = window.setTimeout(stopVoiceRecording, 29_000);
    } catch (error) {
      voiceRecordingRef.current = false;
      setVoiceError(error instanceof Error ? error.message : "Recording could not start.");
      setVoiceRecording("error");
    }
  };

  const sendTypedVoiceTurn = (event: FormEvent) => {
    event.preventDefault();
    const roomId = joinedVoiceRoomRef.current;
    const text = voiceTypedTurn.trim();
    if (!roomId || !text || !socketRef.current) return;
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

  const openDm = (peer: Member) => {
    if (!socketRef.current || !me || peer.id === me.id) return;
    socketRef.current.emit("dm:open", { peerId: peer.id }, (result: { ok: boolean; thread?: DmThread; error?: string }) => {
      if (!result.ok || !result.thread) {
        pushToast({ tone: "warning", title: "DM unavailable", message: result.error ?? "Try again in a moment." });
        return;
      }
      setDmThreads((current) =>
        current.some((thread) => thread.id === result.thread!.id)
          ? current.map((thread) => (thread.id === result.thread!.id ? result.thread! : thread))
          : [...current, result.thread!],
      );
      activeChannelRef.current = result.thread.id;
      setVoiceViewRoomId(null);
      setVoiceCreateOpen(false);
      shouldStickToBottom.current = true;
      setActiveChannelId(result.thread.id);
      setUnread((current) => ({ ...current, [result.thread!.id]: 0 }));
      setChannelActivity((current) => ({ ...current, [result.thread!.id]: 0 }));
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
    setVoiceViewRoomId(null);
    setVoiceCreateOpen(false);
    activeChannelRef.current = id;
    shouldStickToBottom.current = true;
    setActiveChannelId(id);
    setUnread((current) => ({ ...current, [id]: 0 }));
    setChannelActivity((current) => ({ ...current, [id]: 0 }));
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
            {channels.map((channel) => (
              <button key={channel.id} className={`channel-button ${activeChannelId === channel.id ? "active" : ""}`} onClick={() => selectChannel(channel.id)}>
                <Icon name="hash" size={17} /><span>{channel.name}</span>
                {(unread[channel.id] ?? 0) > 0 ? (
                  <i className="channel-unread" aria-label={`${unread[channel.id]} unread messages`}>{unread[channel.id]! > 9 ? "9+" : unread[channel.id]}</i>
                ) : channelActivity[channel.id] && activeChannelId !== channel.id ? (
                  <i className="activity-wave"><b /><b /><b /></i>
                ) : null}
              </button>
            ))}
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
                    <Icon name="speaker" size={16} /><span>{channel?.name ?? "voice room"}</span>{speaking && <i className="voice-wave"><b /><b /><b /></i>}<small>{room.participants.length}</small>
                  </button>
                  <div className="voice-room-members">
                    {room.participants.map((participant) => (
                      <span className={participant.speaking || participant.botState === "speaking" ? "speaking" : ""} key={participant.memberId}>
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
                    <Avatar member={peer} size="sm" /><span>{peer.name}</span>{peer.kind === "ai" && <AiBadge />}{thread.unread > 0 && <i className="channel-unread" aria-label={`${thread.unread} unread messages`}>{thread.unread > 9 ? "9+" : thread.unread}</i>}
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
            <><Avatar member={me} size="sm" /><div><strong>{me.name}</strong><span>Guest · connected</span></div><span className="signal-bars"><i /><i /><i /></span></>
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
          <section className="voice-stage" aria-label="Voice room">
            {voiceRoomInView ? (
              <>
                <header className="voice-stage-header">
                  <button type="button" className="icon-button mobile-only" onClick={() => setMobilePanel("rooms")} aria-label="Open rooms"><Icon name="menu" /></button>
                  <span className="voice-stage-icon"><Icon name="speaker" size={19} /></span>
                  <div><strong>{channels.find((channel) => channel.id === voiceRoomInView.channelId)?.name ?? "Voice room"}</strong><span>{voiceRoomInView.participants.length} connected · started by {memberMap.get(voiceRoomInView.createdByMemberId)?.name ?? "a guest"}</span></div>
                  <button type="button" className="voice-back-chat" onClick={() => setVoiceViewRoomId(null)}><Icon name="message" size={15} /> Back to chat</button>
                </header>

                <div className="voice-stage-scroll">
                  {voiceError && <div className="voice-error" role="alert"><Icon name="info" size={16} /><span>{voiceError}</span><button type="button" onClick={() => setVoiceError(null)}><Icon name="close" size={14} /></button></div>}
                  {voiceAudioBlocked && <div className="voice-audio-banner"><Icon name="speaker" size={16} /><span>Audio is ready but the browser paused playback.</span><button type="button" onClick={() => { for (const audio of [...voiceRemoteAudio.current.values(), ...voiceAiAudio.current]) void audio.play(); setVoiceAudioBlocked(false); }}>Enable sound</button></div>}
                  {voiceBrowserSpeech && <div className="voice-browser-disclosure"><Icon name="info" size={13} /> AI speech is using your browser's synthetic voice because local TTS is unavailable.</div>}

                  <div className={`voice-grid voice-grid-${Math.min(voiceRoomInView.participants.length, 4)}`}>
                    {voiceRoomInView.participants.map((participant) => {
                      const member = memberMap.get(participant.memberId);
                      const isMe = participant.memberId === me?.id;
                      const isSpeaking = participant.speaking || participant.botState === "speaking";
                      return (
                        <article className={`voice-tile ${isSpeaking ? "speaking" : ""} ${participant.kind === "ai" ? "ai" : ""}`} key={participant.memberId}>
                          <div className="voice-avatar-wrap">{member ? <Avatar member={member} size="xl" showStatus={false} /> : <span className="voice-avatar-fallback">{participant.name.slice(0, 1)}</span>}<i className="voice-speaking-ring" /></div>
                          <div className="voice-tile-name"><strong>{participant.name}{isMe ? " (you)" : ""}</strong>{participant.kind === "ai" && <AiBadge label="AI RESIDENT" />}</div>
                          <span className="voice-tile-state">
                            {participant.muted && <Icon name="micOff" size={13} />}
                            {participant.botState === "thinking" ? "thinking…" : participant.botState === "joining" || participant.botState === "invited" ? "joining…" : isSpeaking ? "speaking" : participant.muted ? "muted" : "listening"}
                          </span>
                          {participant.kind === "ai" && voiceRoomInView.hostMemberId === me?.id && <button type="button" className="voice-remove-bot" onClick={() => removeVoiceBot(participant.memberId)} aria-label={`Remove ${participant.name} from voice`}><Icon name="close" size={13} /></button>}
                          {participant.kind === "human" && !isMe && (
                            <audio
                              className="remote-audio"
                              autoPlay
                              playsInline
                              ref={(node) => {
                                if (!node) {
                                  voiceRemoteAudio.current.delete(participant.memberId);
                                  return;
                                }
                                voiceRemoteAudio.current.set(participant.memberId, node);
                                node.srcObject = voiceRemoteStreams.current.get(participant.memberId) ?? null;
                                node.muted = voiceDeafened;
                                if (node.srcObject) void node.play().catch(() => setVoiceAudioBlocked(true));
                              }}
                            />
                          )}
                        </article>
                      );
                    })}
                    {voiceRoomInView.participants.length === 0 && <div className="voice-empty-stage"><Icon name="radio" size={28} /><strong>The room is open.</strong><span>Join and invite someone in.</span></div>}
                  </div>

                  {voiceRoomTranscripts.length > 0 && (
                    <div className="voice-transcript" aria-live="polite">
                      <p className="eyebrow">Recent voice context</p>
                      {voiceRoomTranscripts.slice(-4).map((entry) => <p key={entry.id}><strong>{entry.speakerName}</strong><span>{entry.text}</span></p>)}
                    </div>
                  )}

                  {joinedVoiceRoomId === voiceRoomInView.id && voiceRoomInView.hostMemberId === me?.id && availableVoiceBots.length > 0 && (
                    <div className="voice-invite-panel">
                      <div><strong>Invite an AI friend</strong><span>Up to {voiceCapabilities?.maxBots ?? 2} AI residents can join. They remain visibly labelled.</span></div>
                      <div>{availableVoiceBots.slice(0, 8).map((bot) => <button type="button" key={bot.id} onClick={() => inviteVoiceBot(bot.id)}><Avatar member={bot} size="sm" /><span>{bot.name}</span><AiBadge /></button>)}</div>
                    </div>
                  )}

                  {joinedVoiceRoomId === voiceRoomInView.id && (
                    <form className="voice-typed-turn" onSubmit={sendTypedVoiceTurn}>
                      <Icon name="message" size={15} /><input value={voiceTypedTurn} onChange={(event) => setVoiceTypedTurn(event.target.value)} maxLength={500} placeholder="Type what you want to say to the AI residents" /><button type="submit" disabled={!voiceTypedTurn.trim()}>Send</button>
                    </form>
                  )}
                </div>

                {joinedVoiceRoomId === voiceRoomInView.id ? (
                  <div className="voice-controls" aria-label="Voice controls">
                    <button type="button" className={voiceMuted ? "active" : ""} onClick={() => void toggleVoiceMute()} disabled={voiceJoinState === "requesting-permission" || voiceRecording === "recording" || voiceRecording === "uploading"} aria-label={voiceMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={voiceMuted}><Icon name={voiceMuted ? "micOff" : "mic"} /><span>{voiceMuted ? "Unmute" : "Mute"}</span></button>
                    <button type="button" className={`voice-record ${voiceRecording === "recording" ? "recording" : ""}`} onClick={() => void toggleVoiceRecording()} disabled={voiceRecording === "uploading"} aria-label={voiceRecording === "recording" ? "Stop and send AI voice turn" : voiceRecording === "uploading" ? "Transcribing AI voice turn" : "Talk to AI"} aria-pressed={voiceRecording === "recording"}><Icon name={voiceRecording === "recording" ? "stop" : "radio"} /><span>{voiceRecording === "recording" ? "Stop & send" : voiceRecording === "uploading" ? "Transcribing…" : "Talk to AI"}</span></button>
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
          <div className="channel-heading"><strong>{activeTitle}</strong><span>{activeDescription}</span></div>
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
            shouldStickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 110;
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
            <h1>{activePeer ? activePeer.name : `Welcome to #${activeTitle}`}</h1>
            <p>{activeDescription}</p>
            {activePeer?.kind === "ai" && <div className="transparency-note"><AiBadge label="AI RESIDENT" /><span>This character is generated by a local language model and remembers this private thread only while the server is running.</span></div>}
          </div>}
          {activeMessages.length === 0 && <div className="empty-conversation"><Icon name="message" size={22} /><strong>Quiet, for once.</strong><span>Say something and see who notices.</span></div>}
          {activeMessages.map((message, index) => {
            const author = memberMap.get(message.authorId) ?? message.authorSnapshot;
            const previous = activeMessages[index - 1];
            const startsDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
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
            if (message.system) return (
              <Fragment key={message.id}>
                {startsDay && <div className="day-divider"><span>{formatDayLabel(message.createdAt)}</span></div>}
                <div className="system-message" data-message-id={message.id}><span><Icon name="spark" size={12} /></span>{message.content}<time>{formatTime(message.createdAt)}</time></div>
              </Fragment>
            );
            if (!author) return null;
            return (
              <Fragment key={message.id}>
              {startsDay && <div className="day-divider"><span>{formatDayLabel(message.createdAt)}</span></div>}
              <article
                className={`message ${grouped ? "grouped" : ""} ${historicalMessageIds.current.has(message.id) ? "historical" : ""}`}
                data-message-id={message.id}
              >
                {!grouped ? <Avatar member={author} size="md" /> : <time className="group-time">{formatTime(message.createdAt)}</time>}
                <div className="message-body">
                  {replyDisplay && <button className="reply-preview"><Icon name="reply" size={12} /><strong>{replyDisplay.authorName}</strong><span>{replyDisplay.content.slice(0, 92)}</span></button>}
                  {!grouped && <div className="message-meta"><button onClick={() => setProfile(author)}>{author.name}</button>{author.kind === "ai" && <AiBadge />}<time>{formatTime(message.createdAt)}</time></div>}
                  {message.content && <div className="message-content"><MessageText content={message.content} members={displayMembers} /></div>}
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
                  {message.linkPreview && !message.sources?.some((source) => source.url === message.linkPreview?.url) && (
                    <div className="link-preview-list">
                      <a
                        className="link-preview-card"
                        href={message.linkPreview.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        referrerPolicy="no-referrer"
                        aria-label={`Open link preview: ${message.linkPreview.title} (opens in a new tab)`}
                      >
                        <span className="link-preview-domain">
                          {message.linkPreview.siteName === message.linkPreview.displayHost
                            ? message.linkPreview.displayHost
                            : `${message.linkPreview.siteName} · ${message.linkPreview.displayHost}`}
                          <Icon name="external" size={11} />
                        </span>
                        <strong className="link-preview-title" dir="auto">{message.linkPreview.title}</strong>
                        {message.linkPreview.description && <span className="link-preview-description" dir="auto">{message.linkPreview.description}</span>}
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
                  {message.sources && message.sources.length > 0 && (
                    <div className="source-row">
                      <span><Icon name="search" size={11} /> looked up</span>
                      {message.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={source.title}>
                          {source.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                {me && !activeThread && (
                  <div className="message-actions">
                    <button onClick={() => react(message, REACTIONS[Math.floor(Math.random() * REACTIONS.length)]!)} title="React"><Icon name="smile" size={16} /></button>
                    <button onClick={() => setReplyTo(message)} title="Reply"><Icon name="reply" size={16} /></button>
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
            {typingMembers.length > 0 && <span>{typingMembers.slice(0, 2).map((member) => member.name).join(" and ")}{typingMembers.length > 2 ? ` +${typingMembers.length - 2}` : ""} {typingMembers.length === 1 ? "is" : "are"} composing</span>}
          </div>
          {replyTo && <div className="replying-to"><span>Replying to <strong>{memberMap.get(replyTo.authorId)?.name}</strong></span><button onClick={() => setReplyTo(null)}><Icon name="close" size={15} /></button></div>}
          {pendingImage && (
            <div className={`pending-image pending-image-${pendingImage.status}`} aria-live="polite">
              <div className="pending-image-visual">
                {pendingImage.previewUrl
                  ? <img src={pendingImage.previewUrl} alt="Image ready to share" />
                  : <span><Icon name={pendingImage.source === "url" ? "link" : "image"} size={20} /></span>}
              </div>
              <div className="pending-image-copy">
                <strong>{pendingImage.label}</strong>
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
          <div className="composer-note"><Icon name="spark" size={11} /> AI residents may read public messages and view shared images. Public HTTPS links may unfurl; DMs stay out of public context.</div>
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
            <label><span>Display name</span><input autoFocus value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="What should everyone call you?" maxLength={24} /></label>
            {preview?.inviteRequired && <label><span>Invite code</span><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="Enter the code" type="password" /></label>}
            {joinError && <div className="join-error">{joinError}</div>}
            <button className="join-button" type="submit" disabled={joining || joinName.trim().length < 2}>{joining ? <><span className="spinner" />Opening the door…</> : <>Enter the room <Icon name="chevron" size={17} /></>}</button>
            <div className="join-disclosure"><Icon name="info" size={16} /><span><strong>Humans and AI are always labelled.</strong> This server keeps a small local memory of return visits, rooms you use most, and non-sensitive preferences, activities or technical tools you explicitly share. No account or email is required, and you can erase it from your profile. AI runs locally; optional research and public link previews use the web.</span></div>
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
                  <div className="event-body"><div><strong>{event.trigger}</strong><time>{formatRelative(event.createdAt)}</time></div><p>{event.summary}</p><div className="decision-grid"><span><b>{event.considered}</b> considered</span><span><b>{event.replied}</b> replied</span><span><b>{event.reacted}</b> reacted</span><span className="quiet"><b>{event.stayedQuiet}</b> quiet</span></div></div>
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
            <div className="profile-body"><div className="profile-name"><h2>{profile.name}</h2>{profile.kind === "ai" && <AiBadge label="AI RESIDENT" />}</div><p className="profile-role">{profile.role}</p><p className="profile-bio">{profile.bio}</p><div className="profile-facts"><span><small>STATUS</small><b><i className={`presence-${profile.status}`} />{profile.status}</b></span>{profile.activity && <span><small>CURRENTLY</small><b>{profile.activity}</b></span>}<span><small>MEMORY</small><b>{me && profile.id === me.id ? "Small local memory" : profile.kind === "ai" ? "Recent room context" : "Human guest"}</b></span></div>{me && profile.id === me.id && <button type="button" className="profile-forget" onClick={() => void forgetAiMemory()} disabled={forgettingMemory} aria-busy={forgettingMemory}>{forgettingMemory ? <><span className="button-spinner" aria-hidden="true" />Forgetting…</> : "Forget what AI remembers"}</button>}{me && profile.id !== me.id && profile.status !== "offline" && <button className="profile-message" onClick={() => openDm(profile)}><Icon name="message" /> Message {profile.name}</button>}</div>
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
              <strong>{lightbox.authorName}</strong>
              {lightbox.attachment.analysis.status === "ready" && <span>{lightbox.attachment.analysis.observation.summary}</span>}
              {lightbox.attachment.analysis.status === "pending" && <span>AI residents are still looking at this image…</span>}
            </figcaption>
          </figure>
        </div>
      )}

      {mobilePanel && <button className="mobile-scrim mobile-only" onClick={() => setMobilePanel(null)} aria-label="Close panel" />}
      <div className="toast-stack">{toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><i /><div><strong>{toast.title}</strong><span>{toast.message}</span></div><button onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><Icon name="close" size={14} /></button></div>)}</div>
    </div>
  );
}

function MemberGroup({ title, members, onSelect }: { title: string; members: Member[]; onSelect: (member: Member) => void }) {
  if (members.length === 0) return null;
  return (
    <section className="member-group"><p className="eyebrow">{title} <span>{members.length}</span></p>{members.map((member) => <button className="member-row" key={member.id} onClick={() => onSelect(member)}><Avatar member={member} size="sm" /><span className="member-copy"><strong>{member.name}{member.kind === "ai" && <AiBadge />}</strong><small>{member.activity ?? member.role}</small></span></button>)}</section>
  );
}
