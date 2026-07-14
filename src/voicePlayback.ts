import { normalizeSpokenLanguageTag, speechTimingUnits } from "../shared/spokenText";

export interface VoiceAiSpeechPayload {
  roomId: string;
  memberId: string;
  text: string;
  utteranceId: string;
  audioUrl?: string;
  mimeType?: string;
  browserFallbackAllowed?: boolean;
  /** Backward-compatible alias while older voice servers are still in flight. */
  fallbackAllowed?: boolean;
  language?: string;
  browserRate?: number;
  browserPitch?: number;
}

export interface VoicePlaybackAudio {
  src: string;
  preload: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  canPlayType(mimeType: string): string;
}

export interface VoicePlaybackVoice {
  default: boolean;
  lang: string;
  localService: boolean;
  name: string;
  voiceURI: string;
}

export interface VoicePlaybackUtterance {
  lang: string;
  pitch: number;
  rate: number;
  voice: VoicePlaybackVoice | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

export interface VoicePlaybackSpeechSynthesis {
  readonly pending: boolean;
  readonly speaking: boolean;
  cancel(): void;
  getVoices(): VoicePlaybackVoice[];
  pause(): void;
  resume(): void;
  speak(utterance: VoicePlaybackUtterance): void;
}

export interface VoicePlaybackEnvironment {
  origin: string;
  defaultLanguage?: string;
  createAudio(): VoicePlaybackAudio;
  createUtterance?: (text: string) => VoicePlaybackUtterance;
  speechSynthesis?: VoicePlaybackSpeechSynthesis;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(timer: number): void;
}

export type VoicePlaybackMode = "server" | "browser" | null;

export interface VoicePlaybackCallbacks {
  onAutoplayBlocked?: (blocked: boolean) => void;
  onModeChanged?: (mode: VoicePlaybackMode) => void;
  /** True only while AI audio is actually audible, not while it is queued or autoplay-blocked. */
  onPlaybackActive?: (active: boolean) => void;
  onUnavailable?: (speech: VoiceAiSpeechPayload, reason: string) => void;
}

type ServerPlayback = {
  kind: "server";
  token: number;
  speech: VoiceAiSpeechPayload;
  audio: VoicePlaybackAudio;
  startWatchdog?: number;
  terminalWatchdog?: number;
  blocked: boolean;
};

type BrowserPlayback = {
  kind: "browser";
  token: number;
  speech: VoiceAiSpeechPayload;
  utterance?: VoicePlaybackUtterance;
  startWatchdog?: number;
  terminalWatchdog?: number;
  started: boolean;
  blocked: boolean;
};

type ActivePlayback = ServerPlayback | BrowserPlayback;

const DEFAULT_SEEN_UTTERANCES = 64;
const BROWSER_START_WATCHDOG_MS = 3_000;
const SERVER_START_WATCHDOG_MS = 8_000;

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

export const terminalWatchdogMs = (speech: VoiceAiSpeechPayload, browser: boolean): number => {
  const units = Math.max(1, speechTimingUnits(speech.text, speech.language));
  const rate = browser ? clamp(finiteOr(speech.browserRate, 1), 0.5, 2) : 1;
  return clamp(Math.round(4_000 + (units * 700) / rate), 8_000, 30_000);
};

const normalizedLanguage = (value: string | undefined, fallback?: string): string => {
  for (const candidate of [value, fallback]) {
    const normalized = normalizeSpokenLanguageTag(candidate);
    if (normalized) return normalized;
  }
  return "";
};

const stableHash = (value: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const autoplayWasBlocked = (error: unknown): boolean => {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) return error.name === "NotAllowedError";
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name ?? "");
  return name === "NotAllowedError" || name === "NotSupportedError: autoplay";
};

const fallbackAllowed = (speech: VoiceAiSpeechPayload): boolean =>
  speech.browserFallbackAllowed ?? speech.fallbackAllowed ?? true;

/**
 * Owns AI voice playback for one browser tab. Socket events may arrive faster
 * than audio can finish, but only one clip/utterance is ever active at once.
 */
export class VoicePlaybackController {
  private readonly queue: VoiceAiSpeechPayload[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private active?: ActivePlayback;
  private token = 0;
  private deafened = false;
  private playbackActive = false;

  constructor(
    private readonly environment: VoicePlaybackEnvironment,
    private readonly callbacks: VoicePlaybackCallbacks = {},
    private readonly maxSeenUtterances = DEFAULT_SEEN_UTTERANCES,
  ) {}

  enqueue(speech: VoiceAiSpeechPayload): boolean {
    const utteranceId = speech.utteranceId?.trim();
    if (!utteranceId || !speech.text?.trim() || this.seen.has(utteranceId)) return false;
    this.remember(utteranceId);
    if (this.deafened) return false;
    this.queue.push({ ...speech, utteranceId, text: speech.text.trim() });
    this.pump();
    return true;
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (deafened) this.stop();
  }

  /** Stop the bot immediately when a local human starts a new turn. */
  bargeIn(): void {
    this.stop();
  }

  stop(options: { resetSeen?: boolean } = {}): void {
    this.token += 1;
    this.queue.length = 0;
    this.disposeActive();
    this.setPlaybackActive(false);
    this.callbacks.onAutoplayBlocked?.(false);
    this.callbacks.onModeChanged?.(null);
    if (options.resetSeen) {
      this.seen.clear();
      this.seenOrder.length = 0;
    }
  }

  reset(): void {
    this.deafened = false;
    this.stop({ resetSeen: true });
  }

  async retryBlocked(): Promise<boolean> {
    const active = this.active;
    if (!active?.blocked || this.deafened) return !active?.blocked;
    active.blocked = false;
    this.callbacks.onAutoplayBlocked?.(false);
    if (active.kind === "server") return await this.playServerAudio(active);

    const speech = active.speech;
    const token = active.token;
    this.cleanupBrowser(active);
    this.active = undefined;
    this.environment.speechSynthesis?.resume();
    this.beginBrowser(speech, token);
    return true;
  }

  private remember(utteranceId: string): void {
    this.seen.add(utteranceId);
    this.seenOrder.push(utteranceId);
    const limit = Math.max(1, Math.floor(this.maxSeenUtterances));
    while (this.seenOrder.length > limit) {
      const expired = this.seenOrder.shift();
      if (expired) this.seen.delete(expired);
    }
  }

  private pump(): void {
    if (this.active || this.deafened) return;
    const speech = this.queue.shift();
    if (!speech) return;
    const token = ++this.token;
    const audioUrl = this.safeAudioUrl(speech.audioUrl);
    if (audioUrl) {
      this.beginServer(speech, audioUrl, token);
      return;
    }
    this.beginBrowser(speech, token, speech.audioUrl ? "unsafe server audio URL" : "server audio unavailable");
  }

  private safeAudioUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
      const url = new URL(raw, this.environment.origin);
      const origin = new URL(this.environment.origin).origin;
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private beginServer(speech: VoiceAiSpeechPayload, audioUrl: string, token: number): void {
    const audio = this.environment.createAudio();
    const mimeType = speech.mimeType?.split(";", 1)[0]?.trim().toLocaleLowerCase();
    if (mimeType && !audio.canPlayType(mimeType)) {
      audio.pause();
      audio.src = "";
      this.beginBrowser(speech, token, `unsupported server audio type ${mimeType}`);
      return;
    }
    audio.preload = "auto";
    audio.src = audioUrl;
    const active: ServerPlayback = { kind: "server", token, speech, audio, blocked: false };
    this.active = active;
    this.callbacks.onModeChanged?.("server");
    audio.onended = () => this.complete(active);
    audio.onerror = () => this.failServer(active, "server audio failed to load");
    void this.playServerAudio(active);
  }

  private async playServerAudio(active: ServerPlayback): Promise<boolean> {
    this.armServerStartWatchdog(active);
    try {
      await active.audio.play();
      if (!this.isActive(active)) return false;
      this.clearServerStartWatchdog(active);
      active.blocked = false;
      this.callbacks.onAutoplayBlocked?.(false);
      this.callbacks.onModeChanged?.("server");
      this.setPlaybackActive(true);
      this.armTerminalWatchdog(active);
      return true;
    } catch (error) {
      if (!this.isActive(active)) return false;
      this.clearServerStartWatchdog(active);
      if (autoplayWasBlocked(error)) {
        active.blocked = true;
        this.callbacks.onAutoplayBlocked?.(true);
        return false;
      }
      this.failServer(active, "server audio playback failed");
      return false;
    }
  }

  private failServer(active: ServerPlayback, reason: string): void {
    if (!this.isActive(active)) return;
    this.cleanupServer(active);
    this.setPlaybackActive(false);
    this.active = undefined;
    this.callbacks.onAutoplayBlocked?.(false);
    this.beginBrowser(active.speech, active.token, reason);
  }

  private beginBrowser(speech: VoiceAiSpeechPayload, token: number, reason = "browser fallback requested"): void {
    const synthesis = this.environment.speechSynthesis;
    const createUtterance = this.environment.createUtterance;
    if (!fallbackAllowed(speech) || !synthesis || !createUtterance || this.deafened || token !== this.token) {
      this.active = undefined;
      this.callbacks.onModeChanged?.(null);
      if (!this.deafened) this.callbacks.onUnavailable?.(speech, fallbackAllowed(speech) ? reason : "browser fallback disabled");
      this.pump();
      return;
    }

    synthesis.cancel();
    const utterance = createUtterance(speech.text);
    const language = normalizedLanguage(speech.language, this.environment.defaultLanguage);
    utterance.lang = language;
    utterance.rate = clamp(finiteOr(speech.browserRate, 1), 0.5, 2);
    utterance.pitch = clamp(finiteOr(speech.browserPitch, 1), 0.5, 2);
    utterance.voice = this.pickVoice(synthesis.getVoices(), language, speech.memberId);

    const active: BrowserPlayback = {
      kind: "browser",
      token,
      speech,
      utterance,
      started: false,
      blocked: false,
    };
    this.active = active;
    this.callbacks.onModeChanged?.("browser");
    utterance.onstart = () => {
      if (!this.isActive(active)) return;
      active.started = true;
      active.blocked = false;
      this.clearBrowserStartWatchdog(active);
      this.armTerminalWatchdog(active);
      this.callbacks.onAutoplayBlocked?.(false);
      this.setPlaybackActive(true);
    };
    utterance.onend = () => this.complete(active);
    utterance.onerror = (event) => {
      if (!this.isActive(active)) return;
      const code = event.error?.toLocaleLowerCase() ?? "";
      if (code === "not-allowed" || code === "audio-busy") {
        this.cleanupBrowser(active);
        active.utterance = undefined;
        active.blocked = true;
        this.setPlaybackActive(false);
        this.callbacks.onAutoplayBlocked?.(true);
        return;
      }
      this.callbacks.onUnavailable?.(speech, code || "browser speech failed");
      this.complete(active);
    };

    try {
      synthesis.speak(utterance);
      if (this.isActive(active) && !active.started && !active.blocked) {
        active.startWatchdog = this.environment.setTimer(() => {
          if (!this.isActive(active) || active.started) return;
          active.startWatchdog = undefined;
          if (synthesis.speaking) {
            active.started = true;
            this.setPlaybackActive(true);
            this.armTerminalWatchdog(active);
            this.callbacks.onAutoplayBlocked?.(false);
            return;
          }
          this.cleanupBrowser(active);
          active.utterance = undefined;
          active.blocked = true;
          this.callbacks.onAutoplayBlocked?.(true);
        }, BROWSER_START_WATCHDOG_MS);
      }
    } catch (error) {
      if (autoplayWasBlocked(error)) {
        this.cleanupBrowser(active);
        active.utterance = undefined;
        active.blocked = true;
        this.callbacks.onAutoplayBlocked?.(true);
      } else {
        this.callbacks.onUnavailable?.(speech, "browser speech could not start");
        this.complete(active);
      }
    }
  }

  private pickVoice(voices: VoicePlaybackVoice[], language: string, memberId: string): VoicePlaybackVoice | null {
    const lowerLanguage = language.toLocaleLowerCase();
    const baseLanguage = lowerLanguage.split("-", 1)[0];
    const exact = voices.filter((voice) => voice.lang.toLocaleLowerCase() === lowerLanguage);
    const matching = exact.length > 0
      ? exact
      : voices.filter((voice) => voice.lang.toLocaleLowerCase().split("-", 1)[0] === baseLanguage);
    if (matching.length === 0) return null;
    const stable = [...matching].sort((left, right) =>
      `${left.voiceURI}\u0000${left.name}`.localeCompare(`${right.voiceURI}\u0000${right.name}`));
    return stable[stableHash(memberId) % stable.length] ?? null;
  }

  private complete(active: ActivePlayback, cancelBrowser = false): void {
    if (!this.isActive(active)) return;
    if (active.kind === "server") this.cleanupServer(active);
    else this.cleanupBrowser(active, cancelBrowser);
    this.setPlaybackActive(false);
    this.active = undefined;
    this.callbacks.onAutoplayBlocked?.(false);
    this.callbacks.onModeChanged?.(null);
    this.pump();
  }

  private disposeActive(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) {
      this.environment.speechSynthesis?.cancel();
      this.setPlaybackActive(false);
      return;
    }
    if (active.kind === "server") this.cleanupServer(active);
    else this.cleanupBrowser(active);
    this.setPlaybackActive(false);
  }

  private setPlaybackActive(active: boolean): void {
    if (this.playbackActive === active) return;
    this.playbackActive = active;
    this.callbacks.onPlaybackActive?.(active);
  }

  private cleanupServer(active: ServerPlayback): void {
    this.clearServerStartWatchdog(active);
    if (active.terminalWatchdog !== undefined) this.environment.clearTimer(active.terminalWatchdog);
    active.terminalWatchdog = undefined;
    active.audio.onended = null;
    active.audio.onerror = null;
    active.audio.pause();
    active.audio.src = "";
  }

  private cleanupBrowser(active: BrowserPlayback, cancel = true): void {
    this.clearBrowserStartWatchdog(active);
    if (active.terminalWatchdog !== undefined) this.environment.clearTimer(active.terminalWatchdog);
    active.terminalWatchdog = undefined;
    if (active.utterance) {
      active.utterance.onstart = null;
      active.utterance.onend = null;
      active.utterance.onerror = null;
    }
    if (cancel) this.environment.speechSynthesis?.cancel();
  }

  private isActive(active: ActivePlayback): boolean {
    return this.active === active && active.token === this.token;
  }

  private armServerStartWatchdog(active: ServerPlayback): void {
    this.clearServerStartWatchdog(active);
    active.startWatchdog = this.environment.setTimer(() => {
      if (!this.isActive(active) || active.blocked) return;
      active.startWatchdog = undefined;
      this.failServer(active, "server audio did not start");
    }, SERVER_START_WATCHDOG_MS);
  }

  private clearServerStartWatchdog(active: ServerPlayback): void {
    if (active.startWatchdog !== undefined) this.environment.clearTimer(active.startWatchdog);
    active.startWatchdog = undefined;
  }

  private clearBrowserStartWatchdog(active: BrowserPlayback): void {
    if (active.startWatchdog !== undefined) this.environment.clearTimer(active.startWatchdog);
    active.startWatchdog = undefined;
  }

  private armTerminalWatchdog(active: ActivePlayback): void {
    if (active.terminalWatchdog !== undefined) this.environment.clearTimer(active.terminalWatchdog);
    active.terminalWatchdog = this.environment.setTimer(() => {
      if (!this.isActive(active)) return;
      active.terminalWatchdog = undefined;
      // A browser/media implementation may occasionally omit ended/error.
      // Bound that failure so one bad utterance can never starve the FIFO.
      this.complete(active, active.kind === "browser");
    }, terminalWatchdogMs(active.speech, active.kind === "browser"));
  }
}

export const createBrowserVoicePlaybackController = (
  callbacks: VoicePlaybackCallbacks,
  maxSeenUtterances = DEFAULT_SEEN_UTTERANCES,
): VoicePlaybackController => new VoicePlaybackController(
  {
    origin: window.location.origin,
    defaultLanguage: navigator.language,
    createAudio: () => new Audio() as unknown as VoicePlaybackAudio,
    ...(typeof window.SpeechSynthesisUtterance === "function" && "speechSynthesis" in window
      ? {
          createUtterance: (text: string) => new SpeechSynthesisUtterance(text) as unknown as VoicePlaybackUtterance,
          speechSynthesis: window.speechSynthesis as unknown as VoicePlaybackSpeechSynthesis,
        }
      : {}),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (timer) => window.clearTimeout(timer),
  },
  callbacks,
  maxSeenUtterances,
);
