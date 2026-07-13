import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export const VOICE_AUDIO_INPUT_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
] as const;

export type TtsFormat = "mp3" | "opus" | "aac" | "wav" | "flac" | "pcm";

export interface VoiceTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface VoiceTranscriptionInput {
  audio: Buffer;
  mimeType: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface VoiceTranscriptionResult {
  text: string;
  language?: string;
  segments?: VoiceTranscriptSegment[];
}

export interface VoiceSynthesisInput {
  roomId: string;
  text: string;
  voice?: string;
  format?: TtsFormat;
  speed?: number;
  instructions?: string;
  signal?: AbortSignal;
  ttlMs?: number;
}

export interface NormalizedVoiceAudio {
  body: Buffer;
  mimeType: "audio/wav";
  durationMs?: number;
  sampleRate: 16_000;
  channels: 1;
}

export interface StoredTtsAudioMetadata {
  id: string;
  roomId: string;
  mimeType: string;
  bytes: number;
  expiresAt: string;
}

export interface StoredTtsAudio {
  metadata: StoredTtsAudioMetadata;
  body: Buffer;
}

export interface VoiceSpeechCapabilities {
  stt: {
    available: boolean;
    provider: "openai-compatible" | "disabled";
    model?: string;
    inputMimeTypes: string[];
  };
  tts: {
    available: boolean;
    provider: "openai-compatible" | "disabled";
    model?: string;
    formats: TtsFormat[];
    defaultVoice?: string;
  };
  normalizer: {
    available: boolean;
    maxInputBytes: number;
    maxDurationMs: number;
  };
  browserFallbackAllowed: boolean;
}

export class VoiceSpeechError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "VOICE_SPEECH_ERROR",
  ) {
    super(message);
    this.name = "VoiceSpeechError";
  }
}

interface ProcessRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type AudioProcessRunner = (
  command: string,
  args: string[],
  input: Buffer,
  options: ProcessRunOptions,
) => Promise<Buffer>;

export interface AudioNormalizerOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  maxDurationMs?: number;
  runner?: AudioProcessRunner;
}

interface AudioNormalizerLike {
  available(): Promise<boolean>;
  normalize(input: Buffer, mimeType: string, signal?: AbortSignal): Promise<NormalizedVoiceAudio>;
}

export interface VoiceSpeechServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  normalizer?: AudioNormalizerLike;
  audioStore?: TtsAudioStore;
  now?: () => number;
  /** Provider voice IDs that callers can supply on each synthesis request. */
  ttsVoices?: readonly string[];
}

interface ProviderConfig {
  baseUrl: URL;
  model: string;
  token?: string;
  timeoutMs: number;
}

interface SttProviderConfig extends ProviderConfig {}

interface TtsProviderConfig extends ProviderConfig {
  defaultVoice?: string;
  defaultFormat: TtsFormat;
  allowedVoices: ReadonlySet<string>;
}

interface ProcessFailureOptions {
  missing?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  overflow?: boolean;
  stderr?: string;
}

class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly details: ProcessFailureOptions = {},
  ) {
    super(message);
  }
}

const MAX_AUDIO_INPUT_BYTES = 6 * 1024 * 1024;
const MAX_NORMALIZED_BYTES = 4 * 1024 * 1024;
const MAX_STT_JSON_BYTES = 256 * 1024;
const MAX_TTS_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_AUDIO_DURATION_MS = 30_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 20_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_TTL_MS = 60_000;
const MAX_TTS_STORE_BYTES = 32 * 1024 * 1024;
const MAX_TTS_STORE_ENTRIES = 128;
const TRANSCRIPT_MAX_CHARS = 4_000;
const TTS_TEXT_MAX_CHARS = 600;

const clampInteger = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const normalizeMimeType = (value: string): string => value.split(";", 1)[0]!.trim().toLocaleLowerCase();

const sanitizeText = (value: string, maxLength: number): string =>
  value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const sanitizeIdentifier = (value: string, label: string, maxLength = 160): string => {
  const cleaned = value.normalize("NFKC").trim();
  if (!cleaned || cleaned.length > maxLength || !/^[\p{L}\p{N}._:-]+$/u.test(cleaned)) {
    throw new VoiceSpeechError(`Invalid ${label}.`, 400, "INVALID_IDENTIFIER");
  }
  return cleaned;
};

const sanitizeLanguage = (language: string | undefined): string | undefined => {
  if (!language) return undefined;
  const cleaned = language.trim();
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(cleaned) ? cleaned : undefined;
};

const parseTtsFormat = (raw: string | undefined, fallback: TtsFormat = "mp3"): TtsFormat => {
  const normalized = raw?.trim().toLocaleLowerCase();
  return normalized === "mp3" ||
    normalized === "opus" ||
    normalized === "aac" ||
    normalized === "wav" ||
    normalized === "flac" ||
    normalized === "pcm"
    ? normalized
    : fallback;
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet)) && Number(octets[0]) === 127;
};

const validateConfiguredBaseUrl = (raw: string): URL => {
  if (raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new VoiceSpeechError("Speech provider URL is invalid.", 500, "INVALID_PROVIDER_URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VoiceSpeechError("Speech provider URL is invalid.", 500, "INVALID_PROVIDER_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new VoiceSpeechError("Speech provider URL must be a trusted HTTP(S) base URL.", 500, "INVALID_PROVIDER_URL");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new VoiceSpeechError(
      "Plain HTTP speech providers must use a loopback hostname; use HTTPS for remote providers.",
      500,
      "INSECURE_PROVIDER_URL",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
};

const endpointFor = (baseUrl: URL, suffix: string): URL =>
  new URL(`${baseUrl.pathname}/${suffix}`.replace(/\/{2,}/g, "/"), baseUrl.origin);

const providerConfig = (
  prefix: "STT" | "TTS",
  env: NodeJS.ProcessEnv,
): ProviderConfig | undefined => {
  if (env[`${prefix}_ENABLED`]?.toLocaleLowerCase() === "false") return undefined;
  const rawBaseUrl = env[`${prefix}_BASE_URL`]?.trim();
  const model = env[`${prefix}_MODEL`]?.trim();
  if (!rawBaseUrl || !model) return undefined;
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new VoiceSpeechError(`${prefix}_MODEL is invalid.`, 500, "INVALID_PROVIDER_MODEL");
  }
  return {
    baseUrl: validateConfiguredBaseUrl(rawBaseUrl),
    model,
    ...(env[`${prefix}_API_KEY`]?.trim() ? { token: env[`${prefix}_API_KEY`]!.trim() } : {}),
    timeoutMs: clampInteger(env[`${prefix}_TIMEOUT_MS`], DEFAULT_PROVIDER_TIMEOUT_MS, 1_000, 120_000),
  };
};

const responseContentType = (response: Response): string =>
  normalizeMimeType(response.headers.get("content-type") ?? "");

const readBoundedResponse = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const announced = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(announced) && announced > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceSpeechError("Speech provider response was too large.", 502, "PROVIDER_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new VoiceSpeechError("Speech provider response was too large.", 502, "PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
};

const requestSignal = (external: AbortSignal | undefined, timeoutMs: number) => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Speech provider timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
};

const providerFetch = async (
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{
  response: Response;
  timedOut: () => boolean;
  cleanup: () => void;
}> => {
  const bounded = requestSignal(externalSignal, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: bounded.signal });
    return { response, timedOut: bounded.timedOut, cleanup: bounded.cleanup };
  } catch (error) {
    bounded.cleanup();
    if (bounded.timedOut()) {
      throw new VoiceSpeechError("Speech provider timed out.", 504, "PROVIDER_TIMEOUT");
    }
    if (externalSignal?.aborted) {
      throw new VoiceSpeechError("Speech request was cancelled.", 499, "REQUEST_CANCELLED");
    }
    throw new VoiceSpeechError(
      `Speech provider was unreachable${error instanceof Error && error.message ? `: ${sanitizeText(error.message, 120)}` : "."}`,
      502,
      "PROVIDER_UNREACHABLE",
    );
  }
};

const mapProviderBodyError = (
  error: unknown,
  request: { timedOut: () => boolean },
  externalSignal?: AbortSignal,
): never => {
  if (error instanceof VoiceSpeechError) throw error;
  if (request.timedOut()) throw new VoiceSpeechError("Speech provider timed out.", 504, "PROVIDER_TIMEOUT");
  if (externalSignal?.aborted) throw new VoiceSpeechError("Speech request was cancelled.", 499, "REQUEST_CANCELLED");
  throw new VoiceSpeechError("Speech provider response could not be read.", 502, "INVALID_PROVIDER_RESPONSE");
};

const providerError = async (response: Response): Promise<VoiceSpeechError> => {
  let detail = "";
  try {
    detail = sanitizeText((await readBoundedResponse(response, 8 * 1024)).toString("utf8"), 180);
  } catch {
    // The status is enough when an error body itself is malformed or oversized.
  }
  return new VoiceSpeechError(
    `Speech provider returned ${response.status}${detail ? `: ${detail}` : "."}`,
    502,
    "PROVIDER_ERROR",
  );
};

const expectedTtsMimeTypes: Record<TtsFormat, ReadonlySet<string>> = {
  mp3: new Set(["audio/mpeg", "audio/mp3"]),
  opus: new Set(["audio/ogg", "audio/opus", "application/ogg"]),
  aac: new Set(["audio/aac", "audio/mp4", "audio/x-m4a"]),
  wav: new Set(["audio/wav", "audio/x-wav", "audio/wave"]),
  flac: new Set(["audio/flac", "audio/x-flac"]),
  pcm: new Set(["audio/pcm", "audio/l16"]),
};

const runProcess: AudioProcessRunner = async (command, args, input, options) =>
  await new Promise<Buffer>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessFailure("Audio processing was cancelled.", { aborted: true }));
      return;
    }
    let settled = false;
    let timedOut = false;
    let overflow = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result ?? Buffer.alloc(0));
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(new ProcessFailure("Audio processing was cancelled.", { aborted: true }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new ProcessFailure("Audio processor could not start.", { missing: error.code === "ENOENT" }));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 16 * 1024) return;
      const accepted = chunk.subarray(0, 16 * 1024 - stderrBytes);
      stderrBytes += accepted.length;
      stderr.push(accepted);
    });
    child.on("close", (code) => {
      const detail = sanitizeText(Buffer.concat(stderr).toString("utf8"), 400);
      if (overflow) {
        finish(new ProcessFailure("Audio processor output exceeded its limit.", { overflow: true, stderr: detail }));
      } else if (timedOut) {
        finish(new ProcessFailure("Audio processing timed out.", { timedOut: true, stderr: detail }));
      } else if (code !== 0) {
        finish(new ProcessFailure("Audio processor rejected the media.", { stderr: detail }));
      } else {
        finish(undefined, Buffer.concat(stdout, stdoutBytes));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

export class AudioNormalizer implements AudioNormalizerLike {
  readonly maxInputBytes = MAX_AUDIO_INPUT_BYTES;
  readonly maxDurationMs: number;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly timeoutMs: number;
  private readonly runner: AudioProcessRunner;
  private availability?: Promise<boolean>;

  constructor(options: AudioNormalizerOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH?.trim() ?? "ffmpeg";
    this.ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH?.trim() ?? "ffprobe";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_AUDIO_DURATION_MS;
    this.runner = options.runner ?? runProcess;
  }

  available(): Promise<boolean> {
    this.availability ??= Promise.all([
      this.runner(this.ffmpegPath, ["-version"], Buffer.alloc(0), { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }),
      this.runner(this.ffprobePath, ["-version"], Buffer.alloc(0), { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }),
    ]).then(() => true, () => false);
    return this.availability;
  }

  async normalize(input: Buffer, mimeType: string, signal?: AbortSignal): Promise<NormalizedVoiceAudio> {
    if (!Buffer.isBuffer(input) || input.length === 0) {
      throw new VoiceSpeechError("The audio was empty.", 400, "EMPTY_AUDIO");
    }
    if (input.length > this.maxInputBytes) {
      throw new VoiceSpeechError("Voice clips can be at most 6 MB.", 413, "AUDIO_TOO_LARGE");
    }
    const normalizedMime = normalizeMimeType(mimeType);
    if (!(VOICE_AUDIO_INPUT_MIME_TYPES as readonly string[]).includes(normalizedMime)) {
      throw new VoiceSpeechError("Unsupported voice audio format.", 415, "UNSUPPORTED_AUDIO_TYPE");
    }

    let probe: Buffer;
    try {
      probe = await this.runner(
        this.ffprobePath,
        [
          "-v", "error",
          "-protocol_whitelist", "pipe,data",
          "-show_entries", "stream=codec_type,duration:format=duration",
          "-of", "json",
          "pipe:0",
        ],
        input,
        { timeoutMs: Math.min(this.timeoutMs, 8_000), maxOutputBytes: 128 * 1024, signal },
      );
    } catch (error) {
      throw this.processingError(error, "inspect");
    }

    let parsed: { streams?: Array<{ codec_type?: string; duration?: string }>; format?: { duration?: string } };
    try {
      parsed = JSON.parse(probe.toString("utf8")) as typeof parsed;
    } catch {
      throw new VoiceSpeechError("The audio metadata was malformed.", 415, "MALFORMED_AUDIO");
    }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
    if (audioStreams.length !== 1 || streams.some((stream) => stream.codec_type === "video")) {
      throw new VoiceSpeechError("Voice clips must contain exactly one audio stream and no video.", 415, "INVALID_AUDIO_STREAMS");
    }
    const durationSeconds = Number.parseFloat(parsed.format?.duration ?? audioStreams[0]?.duration ?? "");
    if (Number.isFinite(durationSeconds) && durationSeconds * 1_000 > this.maxDurationMs) {
      throw new VoiceSpeechError(`Voice clips can be at most ${Math.round(this.maxDurationMs / 1_000)} seconds.`, 413, "AUDIO_TOO_LONG");
    }

    let output: Buffer;
    try {
      output = await this.runner(
        this.ffmpegPath,
        [
          "-v", "error",
          "-nostdin",
          "-protocol_whitelist", "pipe,data",
          "-i", "pipe:0",
          "-map", "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-ac", "1",
          "-ar", "16000",
          "-c:a", "pcm_s16le",
          "-f", "wav",
          "pipe:1",
        ],
        input,
        { timeoutMs: this.timeoutMs, maxOutputBytes: MAX_NORMALIZED_BYTES, signal },
      );
    } catch (error) {
      throw this.processingError(error, "decode");
    }
    if (output.length < 44 || output.subarray(0, 4).toString("ascii") !== "RIFF" || output.subarray(8, 12).toString("ascii") !== "WAVE") {
      throw new VoiceSpeechError("The normalized audio was malformed.", 415, "MALFORMED_NORMALIZED_AUDIO");
    }
    const dataBytes = this.wavDataBytes(output);
    if (dataBytes === undefined) {
      throw new VoiceSpeechError("The normalized audio was malformed.", 415, "MALFORMED_NORMALIZED_AUDIO");
    }
    const decodedDurationMs = Math.round((dataBytes / (16_000 * 2)) * 1_000);
    if (decodedDurationMs > this.maxDurationMs + 100) {
      throw new VoiceSpeechError(`Voice clips can be at most ${Math.round(this.maxDurationMs / 1_000)} seconds.`, 413, "AUDIO_TOO_LONG");
    }
    return {
      body: output,
      mimeType: "audio/wav",
      durationMs: Number.isFinite(durationSeconds)
        ? Math.max(0, Math.round(durationSeconds * 1_000))
        : decodedDurationMs,
      sampleRate: 16_000,
      channels: 1,
    };
  }

  private wavDataBytes(output: Buffer): number | undefined {
    let offset = 12;
    while (offset + 8 <= output.length) {
      const id = output.subarray(offset, offset + 4).toString("ascii");
      const declaredSize = output.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      if (id === "data") return Math.max(0, output.length - dataOffset);
      if (declaredSize > output.length - dataOffset) return undefined;
      offset = dataOffset + declaredSize + (declaredSize % 2);
    }
    return undefined;
  }

  private processingError(error: unknown, phase: "inspect" | "decode"): VoiceSpeechError {
    if (error instanceof ProcessFailure) {
      if (error.details.missing) {
        return new VoiceSpeechError("FFmpeg and ffprobe are required for server speech recognition.", 503, "AUDIO_TOOLS_UNAVAILABLE");
      }
      if (error.details.aborted) return new VoiceSpeechError("Audio processing was cancelled.", 499, "REQUEST_CANCELLED");
      if (error.details.timedOut) return new VoiceSpeechError("Audio processing timed out.", 408, "AUDIO_PROCESSING_TIMEOUT");
      if (error.details.overflow) {
        return new VoiceSpeechError(`Voice clips can be at most ${Math.round(this.maxDurationMs / 1_000)} seconds.`, 413, "AUDIO_TOO_LONG");
      }
    }
    return new VoiceSpeechError(
      phase === "inspect" ? "That audio could not be inspected safely." : "That audio could not be decoded safely.",
      415,
      "MALFORMED_AUDIO",
    );
  }
}

class OpenAiCompatibleSttProvider {
  constructor(
    private readonly config: SttProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async transcribe(
    audio: NormalizedVoiceAudio,
    options: Pick<VoiceTranscriptionInput, "language" | "prompt" | "signal">,
  ): Promise<VoiceTranscriptionResult> {
    const form = new FormData();
    form.set("model", this.config.model);
    form.set("response_format", "json");
    const language = sanitizeLanguage(options.language);
    const prompt = options.prompt ? sanitizeText(options.prompt, 400) : "";
    if (language) form.set("language", language);
    if (prompt) form.set("prompt", prompt);
    form.set("file", new Blob([new Uint8Array(audio.body)], { type: audio.mimeType }), "utterance.wav");
    const request = await providerFetch(
      this.fetchImpl,
      endpointFor(this.config.baseUrl, "audio/transcriptions"),
      {
        method: "POST",
        headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : undefined,
        body: form,
      },
      this.config.timeoutMs,
      options.signal,
    );
    const response = request.response;
    let body: Buffer = Buffer.alloc(0);
    try {
      if (!response.ok) throw await providerError(response);
      if (responseContentType(response) !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        throw new VoiceSpeechError("Speech transcription provider returned a non-JSON response.", 502, "INVALID_PROVIDER_MIME");
      }
      body = await readBoundedResponse(response, MAX_STT_JSON_BYTES);
    } catch (error) {
      mapProviderBodyError(error, request, options.signal);
    } finally {
      request.cleanup();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new VoiceSpeechError("Speech transcription provider returned invalid JSON.", 502, "INVALID_PROVIDER_JSON");
    }
    if (!payload || typeof payload !== "object" || typeof (payload as { text?: unknown }).text !== "string") {
      throw new VoiceSpeechError("Speech transcription provider omitted the transcript.", 502, "INVALID_PROVIDER_JSON");
    }
    const text = sanitizeText((payload as { text: string }).text, TRANSCRIPT_MAX_CHARS);
    if (!text) throw new VoiceSpeechError("No speech was detected.", 422, "NO_SPEECH");
    const returnedLanguage = sanitizeText(String((payload as { language?: unknown }).language ?? ""), 32) || undefined;
    const rawSegments = Array.isArray((payload as { segments?: unknown }).segments)
      ? (payload as { segments: unknown[] }).segments
      : [];
    const segments = rawSegments
      .slice(0, 100)
      .map((segment): VoiceTranscriptSegment | undefined => {
        if (!segment || typeof segment !== "object") return undefined;
        const raw = segment as { start?: unknown; end?: unknown; text?: unknown };
        const start = typeof raw.start === "number" ? raw.start : Number.NaN;
        const end = typeof raw.end === "number" ? raw.end : Number.NaN;
        const segmentText = typeof raw.text === "string" ? sanitizeText(raw.text, 500) : "";
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !segmentText) return undefined;
        return { startMs: Math.max(0, Math.round(start * 1_000)), endMs: Math.max(0, Math.round(end * 1_000)), text: segmentText };
      })
      .filter((segment): segment is VoiceTranscriptSegment => Boolean(segment));
    return {
      text,
      ...(returnedLanguage ? { language: returnedLanguage } : {}),
      ...(segments.length > 0 ? { segments } : {}),
    };
  }
}

class OpenAiCompatibleTtsProvider {
  constructor(
    private readonly config: TtsProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async synthesize(input: Omit<VoiceSynthesisInput, "roomId" | "ttlMs">): Promise<{ body: Buffer; mimeType: string }> {
    const text = sanitizeText(input.text, TTS_TEXT_MAX_CHARS);
    if (!text) throw new VoiceSpeechError("Speech text was empty.", 400, "EMPTY_SPEECH_TEXT");
    const voice = sanitizeIdentifier(input.voice ?? this.config.defaultVoice ?? "", "TTS voice", 80);
    if (!this.config.allowedVoices.has(voice)) {
      throw new VoiceSpeechError("That TTS voice is not configured for this server.", 400, "UNCONFIGURED_TTS_VOICE");
    }
    const format = parseTtsFormat(input.format, this.config.defaultFormat);
    if (input.speed !== undefined && !Number.isFinite(input.speed)) {
      throw new VoiceSpeechError("TTS speed is invalid.", 400, "INVALID_TTS_SPEED");
    }
    const speed = input.speed === undefined ? 1 : Math.max(0.5, Math.min(2, input.speed));
    const instructions = input.instructions ? sanitizeText(input.instructions, 400) : "";
    const request = await providerFetch(
      this.fetchImpl,
      endpointFor(this.config.baseUrl, "audio/speech"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          input: text,
          voice,
          response_format: format,
          speed,
          ...(instructions ? { instructions } : {}),
        }),
      },
      this.config.timeoutMs,
      input.signal,
    );
    const response = request.response;
    let mimeType = "";
    let body: Buffer = Buffer.alloc(0);
    try {
      if (!response.ok) throw await providerError(response);
      mimeType = responseContentType(response);
      if (!expectedTtsMimeTypes[format].has(mimeType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new VoiceSpeechError("Speech synthesis provider returned an unexpected audio type.", 502, "INVALID_PROVIDER_MIME");
      }
      body = await readBoundedResponse(response, MAX_TTS_RESPONSE_BYTES);
    } catch (error) {
      mapProviderBodyError(error, request, input.signal);
    } finally {
      request.cleanup();
    }
    if (body.length === 0) throw new VoiceSpeechError("Speech synthesis provider returned empty audio.", 502, "EMPTY_PROVIDER_AUDIO");
    return { body, mimeType };
  }
}

export class TtsAudioStore {
  private readonly entries = new Map<string, { metadata: StoredTtsAudioMetadata; body: Buffer }>();
  private totalBytes = 0;

  constructor(
    private readonly defaultTtlMs = DEFAULT_TTS_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  put(roomId: string, mimeType: string, body: Buffer, ttlMs = this.defaultTtlMs): StoredTtsAudioMetadata {
    const safeRoomId = sanitizeIdentifier(roomId, "voice room id");
    const normalizedMime = normalizeMimeType(mimeType);
    if (![...Object.values(expectedTtsMimeTypes)].some((allowed) => allowed.has(normalizedMime))) {
      throw new VoiceSpeechError("Unsupported synthesized audio type.", 415, "UNSUPPORTED_TTS_TYPE");
    }
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_TTS_RESPONSE_BYTES) {
      throw new VoiceSpeechError("Synthesized audio has an invalid size.", 413, "INVALID_TTS_SIZE");
    }
    this.prune();
    const id = randomUUID();
    const expiresAtMs = this.now() + Math.max(5_000, Math.min(300_000, ttlMs));
    const metadata: StoredTtsAudioMetadata = {
      id,
      roomId: safeRoomId,
      mimeType: normalizedMime,
      bytes: body.length,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.entries.set(id, { metadata, body: Buffer.from(body) });
    this.totalBytes += body.length;
    this.enforceLimits();
    return { ...metadata };
  }

  get(id: string, roomId: string): StoredTtsAudio | undefined {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.metadata.roomId !== roomId) return undefined;
    return { metadata: { ...entry.metadata }, body: Buffer.from(entry.body) };
  }

  delete(id: string, roomId: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.metadata.roomId !== roomId) return false;
    this.entries.delete(id);
    this.totalBytes -= entry.body.length;
    return true;
  }

  deleteRoom(roomId: string): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.metadata.roomId !== roomId) continue;
      this.entries.delete(id);
      this.totalBytes -= entry.body.length;
      removed += 1;
    }
    return removed;
  }

  prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (new Date(entry.metadata.expiresAt).getTime() > now) continue;
      this.entries.delete(id);
      this.totalBytes -= entry.body.length;
    }
  }

  private enforceLimits(): void {
    while (this.entries.size > MAX_TTS_STORE_ENTRIES || this.totalBytes > MAX_TTS_STORE_BYTES) {
      const oldest = this.entries.entries().next().value as [string, { body: Buffer }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].body.length;
    }
  }
}

export class VoiceSpeechService {
  readonly audioStore: TtsAudioStore;
  private readonly normalizer: AudioNormalizerLike;
  private readonly sttConfig?: SttProviderConfig;
  private readonly ttsConfig?: TtsProviderConfig;
  private readonly stt?: OpenAiCompatibleSttProvider;
  private readonly tts?: OpenAiCompatibleTtsProvider;
  private readonly browserFallbackAllowed: boolean;

  constructor(options: VoiceSpeechServiceOptions = {}) {
    const env = options.env ?? process.env;
    const fetchImpl = options.fetchImpl ?? fetch;
    const baseSttConfig = providerConfig("STT", env);
    const baseTtsConfig = providerConfig("TTS", env);
    this.sttConfig = baseSttConfig;
    const defaultTtsVoice = env.TTS_VOICE?.trim()
      ? sanitizeIdentifier(env.TTS_VOICE.trim(), "TTS voice", 80)
      : undefined;
    const perCallTtsVoices = new Set(
      (options.ttsVoices ?? []).map((voice) => sanitizeIdentifier(voice, "TTS voice", 80)),
    );
    if (defaultTtsVoice) perCallTtsVoices.add(defaultTtsVoice);
    this.ttsConfig = baseTtsConfig && perCallTtsVoices.size > 0
      ? {
          ...baseTtsConfig,
          ...(defaultTtsVoice ? { defaultVoice: defaultTtsVoice } : {}),
          defaultFormat: parseTtsFormat(env.TTS_FORMAT, baseTtsConfig.model === "piper-sv" ? "wav" : "mp3"),
          allowedVoices: perCallTtsVoices,
        }
      : undefined;
    this.normalizer = options.normalizer ?? new AudioNormalizer({
      ffmpegPath: env.FFMPEG_PATH?.trim() || undefined,
      ffprobePath: env.FFPROBE_PATH?.trim() || undefined,
    });
    const ttlMs = clampInteger(env.TTS_AUDIO_TTL_MS, DEFAULT_TTS_TTL_MS, 5_000, 300_000);
    this.audioStore = options.audioStore ?? new TtsAudioStore(ttlMs, options.now ?? Date.now);
    this.browserFallbackAllowed = env.VOICE_BROWSER_FALLBACK?.toLocaleLowerCase() !== "false";
    if (this.sttConfig) this.stt = new OpenAiCompatibleSttProvider(this.sttConfig, fetchImpl);
    if (this.ttsConfig) this.tts = new OpenAiCompatibleTtsProvider(this.ttsConfig, fetchImpl);
  }

  async capabilities(): Promise<VoiceSpeechCapabilities> {
    const normalizerAvailable = await this.normalizer.available();
    return {
      stt: {
        available: Boolean(this.stt && normalizerAvailable),
        provider: this.stt ? "openai-compatible" : "disabled",
        ...(this.sttConfig ? { model: this.sttConfig.model } : {}),
        inputMimeTypes: [...VOICE_AUDIO_INPUT_MIME_TYPES],
      },
      tts: {
        available: Boolean(this.tts),
        provider: this.tts ? "openai-compatible" : "disabled",
        ...(this.ttsConfig ? { model: this.ttsConfig.model } : {}),
        formats: this.ttsConfig?.model === "piper-sv"
          ? ["wav"]
          : ["mp3", "opus", "aac", "wav", "flac", "pcm"],
        ...(this.ttsConfig?.defaultVoice ? { defaultVoice: this.ttsConfig.defaultVoice } : {}),
      },
      normalizer: {
        available: normalizerAvailable,
        maxInputBytes: MAX_AUDIO_INPUT_BYTES,
        maxDurationMs: this.normalizer instanceof AudioNormalizer ? this.normalizer.maxDurationMs : DEFAULT_AUDIO_DURATION_MS,
      },
      browserFallbackAllowed: this.browserFallbackAllowed,
    };
  }

  async transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult> {
    if (!this.stt) throw new VoiceSpeechError("Server speech recognition is not configured.", 503, "STT_DISABLED");
    const normalized = await this.normalizer.normalize(input.audio, input.mimeType, input.signal);
    return await this.stt.transcribe(normalized, input);
  }

  async synthesize(input: VoiceSynthesisInput): Promise<StoredTtsAudioMetadata> {
    if (!this.tts) throw new VoiceSpeechError("Server speech synthesis is not configured.", 503, "TTS_DISABLED");
    const roomId = sanitizeIdentifier(input.roomId, "voice room id");
    const output = await this.tts.synthesize(input);
    return this.audioStore.put(roomId, output.mimeType, output.body, input.ttlMs);
  }

  lookupAudio(id: string, roomId: string): StoredTtsAudio | undefined {
    return this.audioStore.get(id, roomId);
  }
}
