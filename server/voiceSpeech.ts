import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";

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
  /** Required for server TTS; unknown language must fall back to the browser. */
  language?: string;
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
  /** Language-independent evidence measured from normalized PCM before STT. */
  speechPresence?: VoiceSpeechPresence;
}

export interface VoiceSpeechPresence {
  /** Only `noise` is safe to discard before the transcription provider. */
  classification: "speech" | "noise" | "uncertain";
  activeMs: number;
  noiseFloorRms: number;
  highEnergyRms: number;
  peakRms: number;
  /** Fraction of a stable active window explained by a 50/60 Hz mains tone or its first harmonic. */
  stationaryToneRatio: number;
  activeRunCount: number;
  longestActiveRunMs: number;
  activeOccupancy: number;
  /** Median sample-peak / RMS crest factor across active 20 ms frames. */
  activeMedianCrestRatio: number;
  dynamicRangeDb: number;
  activeVariationDb: number;
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
    /** Explicit BCP-47 ranges; an empty list means server TTS is default-deny. */
    supportedLanguages?: string[];
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
  /** Test/embedding seam for the optional local Silero preflight process. */
  sttVadRunner?: AudioProcessRunner;
  /** Existing directory under which private per-turn VAD directories are created. */
  sttVadTempRoot?: string;
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

interface SttVadConfig {
  command: string;
  modelPath: string;
  threshold: number;
  minSpeechMs: number;
  timeoutMs: number;
}

interface TtsProviderConfig extends ProviderConfig {
  defaultVoice?: string;
  defaultFormat: TtsFormat;
  allowedVoices: ReadonlySet<string>;
  supportedLanguages: readonly string[];
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
const PCM_FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const PCM_MIN_ACTIVE_MS = 100;
const PCM_CONFIDENT_SILENCE_RMS = 0.001;
const PCM_CONFIDENT_SILENCE_PEAK_RMS = 0.0035;
const PCM_MAX_CLICK_MS = 40;
const PCM_MIN_CLICK_PEAK_RMS = 0.05;
const PCM_MIN_CLICK_CREST_RATIO = 4;
const PCM_MIN_HIGH_ENERGY_RMS = 0.005;
const PCM_MIN_STATIONARY_MS = 300;
const PCM_MIN_DYNAMIC_RANGE_DB = 5;
const PCM_MIN_ACTIVE_VARIATION_DB = 2;
// A 60 Hz tone spans 1.2 cycles per 20 ms frame, so its frame RMS naturally
// ripples by about 1 dB even with a perfectly constant amplitude.
const PCM_MAX_STATIONARY_VARIATION_DB = 1.25;
const PCM_MIN_STATIONARY_TONE_RATIO = 0.65;
const PCM_STATIONARY_WINDOW_FRAMES = PCM_MIN_STATIONARY_MS / 20;
const PCM_MAINS_TONE_FREQUENCIES = [50, 60, 100, 120] as const;
const PCM_TRANSIENT_MIN_RUNS = 3;
const PCM_TRANSIENT_MAX_RUN_MS = 80;
const PCM_TRANSIENT_MAX_OCCUPANCY = 0.45;
const PCM_TRANSIENT_MIN_MEDIAN_CREST = 2.8;

const clampInteger = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const clampNumber = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const normalizeMimeType = (value: string): string => value.split(";", 1)[0]!.trim().toLocaleLowerCase();

const sanitizeText = (value: string, maxLength: number): string =>
  stripDangerousTextControls(value.normalize("NFKC"))
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

const sanitizeLanguage = canonicalRegisteredLanguageTag;

interface WavDataChunk {
  offset: number;
  bytes: number;
}

const findWavDataChunk = (wav: Buffer): WavDataChunk | undefined => {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("ascii");
    const declaredSize = wav.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const available = wav.length - dataOffset;
    // WAV written to a non-seekable ffmpeg pipe may retain an unknown/maximum
    // data size in its header. The bounded process output is the authority.
    if (id === "data") return { offset: dataOffset, bytes: Math.min(declaredSize, available) || available };
    if (declaredSize > available) return undefined;
    offset = dataOffset + declaredSize + (declaredSize % 2);
  }
  return undefined;
};

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
};

const ratioDb = (high: number, low: number): number =>
  20 * Math.log10(Math.max(high, 1e-7) / Math.max(low, 1e-7));

const stationaryMainsToneRatio = (
  wav: Buffer,
  chunk: WavDataChunk,
  activeFrameIndexes: readonly number[],
): number => {
  let runStart = -1;
  let runLength = 0;
  let previous = -2;
  for (const frameIndex of activeFrameIndexes) {
    if (frameIndex === previous + 1) runLength += 1;
    else {
      runStart = frameIndex;
      runLength = 1;
    }
    previous = frameIndex;
    if (runLength >= PCM_STATIONARY_WINDOW_FRAMES) break;
  }
  if (runStart < 0 || runLength < PCM_STATIONARY_WINDOW_FRAMES) return 0;

  const sampleCount = PCM_STATIONARY_WINDOW_FRAMES * PCM_FRAME_SAMPLES;
  const sampleOffset = chunk.offset + runStart * PCM_FRAME_SAMPLES * 2;
  const samples = new Float64Array(sampleCount);
  let mean = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = wav.readInt16LE(sampleOffset + index * 2) / 32_768;
    samples[index] = sample;
    mean += sample;
  }
  mean /= sampleCount;
  let totalEnergy = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = (samples[index] ?? 0) - mean;
    totalEnergy += (samples[index] ?? 0) ** 2;
  }
  if (totalEnergy <= 1e-12) return 0;

  let strongestRatio = 0;
  for (const frequency of PCM_MAINS_TONE_FREQUENCIES) {
    const angularStep = (2 * Math.PI * frequency) / 16_000;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = samples[index] ?? 0;
      const phase = angularStep * index;
      real += sample * Math.cos(phase);
      imaginary -= sample * Math.sin(phase);
    }
    const fittedToneEnergy = (2 * (real * real + imaginary * imaginary)) / sampleCount;
    strongestRatio = Math.max(strongestRatio, Math.min(1, fittedToneEnergy / totalEnergy));
  }
  return strongestRatio;
};

/**
 * Conservative speech-presence evidence for normalized mono PCM. This is not
 * language recognition and never examines transcript words. Only near-silence,
 * an isolated high-crest click, or a stable narrow-band mains tone is labelled
 * noise; every acoustically ambiguous clip reaches the transcription provider.
 */
export const analyzePcmSpeechPresence = (
  wav: Buffer,
  chunk = findWavDataChunk(wav),
): VoiceSpeechPresence => {
  if (!chunk || chunk.bytes < PCM_FRAME_SAMPLES * 2) {
    return {
      classification: "noise",
      activeMs: 0,
      noiseFloorRms: 0,
      highEnergyRms: 0,
      peakRms: 0,
      stationaryToneRatio: 0,
      activeRunCount: 0,
      longestActiveRunMs: 0,
      activeOccupancy: 0,
      activeMedianCrestRatio: 0,
      dynamicRangeDb: 0,
      activeVariationDb: 0,
    };
  }

  const frameRms: number[] = [];
  const framePeaks: number[] = [];
  const dataEnd = chunk.offset + chunk.bytes;
  for (let frameOffset = chunk.offset; frameOffset + PCM_FRAME_SAMPLES * 2 <= dataEnd; frameOffset += PCM_FRAME_SAMPLES * 2) {
    let squared = 0;
    let peak = 0;
    for (let sampleOffset = frameOffset; sampleOffset < frameOffset + PCM_FRAME_SAMPLES * 2; sampleOffset += 2) {
      const normalized = wav.readInt16LE(sampleOffset) / 32_768;
      squared += normalized * normalized;
      peak = Math.max(peak, Math.abs(normalized));
    }
    frameRms.push(Math.sqrt(squared / PCM_FRAME_SAMPLES));
    framePeaks.push(peak);
  }

  if (frameRms.length === 0) {
    return {
      classification: "noise",
      activeMs: 0,
      noiseFloorRms: 0,
      highEnergyRms: 0,
      peakRms: 0,
      stationaryToneRatio: 0,
      activeRunCount: 0,
      longestActiveRunMs: 0,
      activeOccupancy: 0,
      activeMedianCrestRatio: 0,
      dynamicRangeDb: 0,
      activeVariationDb: 0,
    };
  }

  const sorted = [...frameRms].sort((a, b) => a - b);
  const noiseFloorRms = percentile(sorted, 0.2);
  const highEnergyRms = percentile(sorted, 0.9);
  const peakRms = sorted.at(-1) ?? 0;
  const activeThreshold = Math.max(0.0035, noiseFloorRms * 1.8);
  const activeFrameIndexes = frameRms
    .map((rms, index) => rms >= activeThreshold ? index : -1)
    .filter((index) => index >= 0);
  const active = activeFrameIndexes.map((index) => frameRms[index] ?? 0).sort((a, b) => a - b);
  const activeMs = active.length * 20;
  let activeRunCount = 0;
  let longestActiveRunFrames = 0;
  let currentActiveRunFrames = 0;
  let previousActiveFrame = -2;
  for (const frameIndex of activeFrameIndexes) {
    if (frameIndex === previousActiveFrame + 1) currentActiveRunFrames += 1;
    else {
      activeRunCount += 1;
      currentActiveRunFrames = 1;
    }
    longestActiveRunFrames = Math.max(longestActiveRunFrames, currentActiveRunFrames);
    previousActiveFrame = frameIndex;
  }
  const longestActiveRunMs = longestActiveRunFrames * 20;
  const activeOccupancy = activeFrameIndexes.length / frameRms.length;
  const activeCrestRatios = activeFrameIndexes
    .map((index) => (framePeaks[index] ?? 0) / Math.max(frameRms[index] ?? 0, 1e-7))
    .sort((a, b) => a - b);
  const activeMedianCrestRatio = percentile(activeCrestRatios, 0.5);
  const dynamicRangeDb = ratioDb(highEnergyRms, noiseFloorRms);
  const activeVariationDb = active.length > 1
    ? ratioDb(percentile(active, 0.9), percentile(active, 0.1))
    : 0;
  const positiveSpeechEvidence = activeMs >= PCM_MIN_ACTIVE_MS &&
    highEnergyRms >= PCM_MIN_HIGH_ENERGY_RMS &&
    dynamicRangeDb >= PCM_MIN_DYNAMIC_RANGE_DB &&
    activeVariationDb >= PCM_MIN_ACTIVE_VARIATION_DB;
  const allFrameIndexes = frameRms.map((_rms, index) => index);
  const stationaryFrameIndexes = activeFrameIndexes.length >= PCM_STATIONARY_WINDOW_FRAMES
    ? activeFrameIndexes
    : dynamicRangeDb <= PCM_MAX_STATIONARY_VARIATION_DB
      ? allFrameIndexes
      : [];
  const stationaryToneRatio = stationaryMainsToneRatio(wav, chunk, stationaryFrameIndexes);
  const confidentSilence = highEnergyRms <= PCM_CONFIDENT_SILENCE_RMS &&
    peakRms <= PCM_CONFIDENT_SILENCE_PEAK_RMS;
  const confidentClick = activeMs > 0 && activeMs <= PCM_MAX_CLICK_MS &&
    peakRms >= PCM_MIN_CLICK_PEAK_RMS &&
    peakRms / Math.max(highEnergyRms, 1e-7) >= PCM_MIN_CLICK_CREST_RATIO;
  // Stable RMS alone is ambiguous with sustained voicing. Hard rejection also
  // requires a narrow-band 50/60 Hz mains signature (or first harmonic).
  const stationaryVariationDb = activeFrameIndexes.length >= PCM_STATIONARY_WINDOW_FRAMES
    ? activeVariationDb
    : dynamicRangeDb;
  const confidentStationaryNoise = stationaryFrameIndexes.length * 20 >= PCM_MIN_STATIONARY_MS &&
    stationaryVariationDb <= PCM_MAX_STATIONARY_VARIATION_DB &&
    stationaryToneRatio >= PCM_MIN_STATIONARY_TONE_RATIO;
  // Repeated keyboard/key-tap impulses often form sparse, high-crest bursts,
  // but plosives and short paused speech can share that envelope. Keep this as
  // diagnostic/uncertain evidence for the provider's neural VAD, never as a
  // local hard rejection.
  const keyboardLikeTransientCluster = activeMs >= PCM_MIN_ACTIVE_MS &&
    activeRunCount >= PCM_TRANSIENT_MIN_RUNS &&
    longestActiveRunMs <= PCM_TRANSIENT_MAX_RUN_MS &&
    activeOccupancy <= PCM_TRANSIENT_MAX_OCCUPANCY &&
    activeMedianCrestRatio >= PCM_TRANSIENT_MIN_MEDIAN_CREST;
  const confidentNoise = confidentSilence || confidentClick || confidentStationaryNoise;
  const classification: VoiceSpeechPresence["classification"] = confidentNoise
    ? "noise"
    : keyboardLikeTransientCluster
      ? "uncertain"
      : positiveSpeechEvidence
      ? "speech"
      : "uncertain";

  return {
    classification,
    activeMs,
    noiseFloorRms,
    highEnergyRms,
    peakRms,
    stationaryToneRatio,
    activeRunCount,
    longestActiveRunMs,
    activeOccupancy,
    activeMedianCrestRatio,
    dynamicRangeDb,
    activeVariationDb,
  };
};

/**
 * OpenAI Whisper's verbose JSON reports the detected language as one of the
 * fixed English names from its tokenizer, while other compatible providers
 * may already return an ISO/BCP-47 tag. Keep that provider-specific wire
 * vocabulary here; the general IANA canonicalizer intentionally does not
 * accept language names or perform language detection.
 *
 * Source: openai/whisper `LANGUAGES` and `TO_LANGUAGE_CODE`.
 */
const WHISPER_LANGUAGE_NAME_TO_TAG: ReadonlyMap<string, string> = new Map([
  ["english", "en"],
  ["chinese", "zh"],
  ["german", "de"],
  ["spanish", "es"],
  ["russian", "ru"],
  ["korean", "ko"],
  ["french", "fr"],
  ["japanese", "ja"],
  ["portuguese", "pt"],
  ["turkish", "tr"],
  ["polish", "pl"],
  ["catalan", "ca"],
  ["dutch", "nl"],
  ["arabic", "ar"],
  ["swedish", "sv"],
  ["italian", "it"],
  ["indonesian", "id"],
  ["hindi", "hi"],
  ["finnish", "fi"],
  ["vietnamese", "vi"],
  ["hebrew", "he"],
  ["ukrainian", "uk"],
  ["greek", "el"],
  ["malay", "ms"],
  ["czech", "cs"],
  ["romanian", "ro"],
  ["danish", "da"],
  ["hungarian", "hu"],
  ["tamil", "ta"],
  ["norwegian", "no"],
  ["thai", "th"],
  ["urdu", "ur"],
  ["croatian", "hr"],
  ["bulgarian", "bg"],
  ["lithuanian", "lt"],
  ["latin", "la"],
  ["maori", "mi"],
  ["malayalam", "ml"],
  ["welsh", "cy"],
  ["slovak", "sk"],
  ["telugu", "te"],
  ["persian", "fa"],
  ["latvian", "lv"],
  ["bengali", "bn"],
  ["serbian", "sr"],
  ["azerbaijani", "az"],
  ["slovenian", "sl"],
  ["kannada", "kn"],
  ["estonian", "et"],
  ["macedonian", "mk"],
  ["breton", "br"],
  ["basque", "eu"],
  ["icelandic", "is"],
  ["armenian", "hy"],
  ["nepali", "ne"],
  ["mongolian", "mn"],
  ["bosnian", "bs"],
  ["kazakh", "kk"],
  ["albanian", "sq"],
  ["swahili", "sw"],
  ["galician", "gl"],
  ["marathi", "mr"],
  ["punjabi", "pa"],
  ["sinhala", "si"],
  ["khmer", "km"],
  ["shona", "sn"],
  ["yoruba", "yo"],
  ["somali", "so"],
  ["afrikaans", "af"],
  ["occitan", "oc"],
  ["georgian", "ka"],
  ["belarusian", "be"],
  ["tajik", "tg"],
  ["sindhi", "sd"],
  ["gujarati", "gu"],
  ["amharic", "am"],
  ["yiddish", "yi"],
  ["lao", "lo"],
  ["uzbek", "uz"],
  ["faroese", "fo"],
  ["haitian creole", "ht"],
  ["pashto", "ps"],
  ["turkmen", "tk"],
  ["nynorsk", "nn"],
  ["maltese", "mt"],
  ["sanskrit", "sa"],
  ["luxembourgish", "lb"],
  ["myanmar", "my"],
  ["tibetan", "bo"],
  ["tagalog", "tl"],
  ["malagasy", "mg"],
  ["assamese", "as"],
  ["tatar", "tt"],
  ["hawaiian", "haw"],
  ["lingala", "ln"],
  ["hausa", "ha"],
  ["bashkir", "ba"],
  ["javanese", "jw"],
  ["sundanese", "su"],
  ["cantonese", "yue"],
  ["burmese", "my"],
  ["valencian", "ca"],
  ["flemish", "nl"],
  ["haitian", "ht"],
  ["letzeburgesch", "lb"],
  ["pushto", "ps"],
  ["panjabi", "pa"],
  ["moldavian", "ro"],
  ["moldovan", "ro"],
  ["sinhalese", "si"],
  ["castilian", "es"],
  ["mandarin", "zh"],
]);

const normalizeSttProviderLanguage = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const canonicalTag = sanitizeLanguage(raw);
  if (canonicalTag) return canonicalTag;
  const providerName = raw.trim().toLowerCase();
  if (!providerName || providerName.length > 32) return undefined;
  const whisperTag = WHISPER_LANGUAGE_NAME_TO_TAG.get(providerName);
  if (whisperTag) return sanitizeLanguage(whisperTag);
  return undefined;
};

export const ttsLanguageIsSupported = (
  supportedLanguages: readonly string[] | undefined,
  language: string | undefined,
): boolean => {
  const target = sanitizeLanguage(language)?.toLocaleLowerCase();
  if (!target || !supportedLanguages?.length) return false;
  return supportedLanguages.some((raw) => {
    const range = sanitizeLanguage(raw)?.toLocaleLowerCase();
    return Boolean(range && (target === range || target.startsWith(`${range}-`)));
  });
};

const configuredTtsLanguages = (raw: string | undefined, model: string): string[] => {
  if (model.toLocaleLowerCase() === "piper-sv") return ["sv"];
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (values.length > 32) {
    throw new VoiceSpeechError("TTS_LANGUAGES contains too many language ranges.", 500, "INVALID_TTS_LANGUAGES");
  }
  const normalized = values.map((value) => sanitizeLanguage(value));
  if (normalized.some((value) => !value)) {
    throw new VoiceSpeechError("TTS_LANGUAGES must contain valid BCP-47 ranges and never und.", 500, "INVALID_TTS_LANGUAGES");
  }
  return [...new Set(normalized as string[])];
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

const sttVadConfig = (env: NodeJS.ProcessEnv): SttVadConfig | undefined => {
  const modelPath = env.STT_VAD_MODEL_PATH?.trim();
  if (!modelPath || modelPath.length > 4_096 || /[\u0000-\u001f\u007f]/.test(modelPath)) return undefined;
  const configuredCommand = env.STT_VAD_COMMAND?.trim();
  const command = configuredCommand || "whisper-vad-speech-segments";
  if (command.length > 1_024 || /[\u0000-\u001f\u007f]/.test(command)) return undefined;
  return {
    command,
    modelPath,
    // A slightly firmer neural threshold plus Silero's own 250 ms speech
    // minimum rejects keyboard/fan bursts before Whisper can hallucinate a
    // fluent phrase. This remains acoustic and language-independent: decoded
    // words never participate in the decision.
    threshold: clampNumber(env.STT_VAD_THRESHOLD, 0.6, 0.05, 0.95),
    minSpeechMs: clampInteger(env.STT_VAD_MIN_SPEECH_MS, 250, 150, 1_000),
    timeoutMs: clampInteger(env.STT_VAD_TIMEOUT_MS, 5_000, 250, 30_000),
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

type SttVadDecision = "speech" | "no-speech" | "unknown";

const parseSttVadDecision = (output: Buffer): SttVadDecision => {
  const prefix = "Detected ";
  const pluralSuffix = " speech segments:";
  const singularSuffix = " speech segment:";
  const summaries: number[] = [];
  for (const rawLine of output.toString("utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    const suffix = line.endsWith(pluralSuffix)
      ? pluralSuffix
      : line.endsWith(singularSuffix)
        ? singularSuffix
        : undefined;
    if (!suffix) continue;
    const digits = line.slice(prefix.length, line.length - suffix.length);
    if (!digits || (digits.length > 1 && digits[0] === "0")) continue;
    let allDigits = true;
    for (let index = 0; index < digits.length; index += 1) {
      const code = digits.charCodeAt(index);
      if (code < 48 || code > 57) {
        allDigits = false;
        break;
      }
    }
    if (!allDigits) continue;
    const count = Number(digits);
    if (Number.isSafeInteger(count)) summaries.push(count);
  }
  if (summaries.length !== 1) return "unknown";
  return summaries[0] === 0 ? "no-speech" : "speech";
};

class SttVadPreflight {
  constructor(
    private readonly config: SttVadConfig,
    private readonly runner: AudioProcessRunner,
    private readonly tempRoot: string,
  ) {}

  async classify(audio: NormalizedVoiceAudio, signal?: AbortSignal): Promise<SttVadDecision> {
    let directory: string | undefined;
    let audioPath: string | undefined;
    try {
      this.throwIfCancelled(signal);
      directory = await mkdtemp(join(this.tempRoot, "third-place-stt-vad-"));
      audioPath = join(directory, "utterance.wav");
      this.throwIfCancelled(signal);
      await writeFile(audioPath, audio.body, { flag: "wx", mode: 0o600 });
      this.throwIfCancelled(signal);
      const output = await this.runner(
        this.config.command,
        [
          "--no-prints",
          "--vad-model",
          this.config.modelPath,
          "--vad-threshold",
          String(this.config.threshold),
          "--vad-min-speech-duration-ms",
          String(this.config.minSpeechMs),
          "--file",
          audioPath,
        ],
        Buffer.alloc(0),
        {
          timeoutMs: this.config.timeoutMs,
          maxOutputBytes: 64 * 1024,
          ...(signal ? { signal } : {}),
        },
      );
      this.throwIfCancelled(signal);
      return parseSttVadDecision(output);
    } catch (error) {
      if (error instanceof VoiceSpeechError && error.code === "REQUEST_CANCELLED") throw error;
      this.throwIfCancelled(signal);
      // This preflight is an optional guard, never a dependency of STT. Missing
      // binaries/models, bad output, timeouts, and filesystem failures all pass
      // the already-normalized WAV through to the transcription provider.
      return "unknown";
    } finally {
      if (audioPath) await unlink(audioPath).catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new VoiceSpeechError("Audio processing was cancelled.", 499, "REQUEST_CANCELLED");
    }
  }
}

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
    const dataChunk = findWavDataChunk(output);
    if (!dataChunk) {
      throw new VoiceSpeechError("The normalized audio was malformed.", 415, "MALFORMED_NORMALIZED_AUDIO");
    }
    const decodedDurationMs = Math.round((dataChunk.bytes / (16_000 * 2)) * 1_000);
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
      speechPresence: analyzePcmSpeechPresence(output, dataChunk),
    };
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
    // Verbose JSON is the OpenAI-compatible shape that can carry the detected
    // language and segment timings. Plain JSON commonly contains text only.
    form.set("response_format", "verbose_json");
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
    let text = sanitizeText((payload as { text: string }).text, TRANSCRIPT_MAX_CHARS);
    if (!text) throw new VoiceSpeechError("No speech was detected.", 422, "NO_SPEECH");
    const returnedLanguage = normalizeSttProviderLanguage((payload as { language?: unknown }).language);
    const rawSegments = Array.isArray((payload as { segments?: unknown }).segments)
      ? (payload as { segments: unknown[] }).segments
      : [];
    const providerSegments = rawSegments
      .slice(0, 100)
      .map((segment) => {
        if (!segment || typeof segment !== "object") return undefined;
        const raw = segment as {
          start?: unknown;
          end?: unknown;
          text?: unknown;
          no_speech_prob?: unknown;
          avg_logprob?: unknown;
        };
        const start = typeof raw.start === "number" ? raw.start : Number.NaN;
        const end = typeof raw.end === "number" ? raw.end : Number.NaN;
        const segmentText = typeof raw.text === "string" ? sanitizeText(raw.text, 500) : "";
        const noSpeechProbability = typeof raw.no_speech_prob === "number" &&
          Number.isFinite(raw.no_speech_prob) && raw.no_speech_prob >= 0 && raw.no_speech_prob <= 1
          ? raw.no_speech_prob
          : undefined;
        const averageLogProbability = typeof raw.avg_logprob === "number" && Number.isFinite(raw.avg_logprob)
          ? raw.avg_logprob
          : undefined;
        // Whisper's no-speech probability is not sufficient by itself: short
        // real speech after leading silence can have a high no-speech token
        // probability while the decoded words remain strongly supported.
        const likelyNoSpeech = noSpeechProbability !== undefined &&
          noSpeechProbability >= 0.6 &&
          (averageLogProbability === undefined || averageLogProbability < -1);
        return {
          text: segmentText,
          likelyNoSpeech,
          timed: Number.isFinite(start) && Number.isFinite(end) && end >= start && segmentText
            ? {
                startMs: Math.max(0, Math.round(start * 1_000)),
                endMs: Math.max(0, Math.round(end * 1_000)),
                text: segmentText,
              } satisfies VoiceTranscriptSegment
            : undefined,
        };
      })
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
    const rejectedSegments = providerSegments.filter((segment) => segment.likelyNoSpeech);
    const acceptedSegments = providerSegments.filter((segment) => !segment.likelyNoSpeech && segment.text);
    if (providerSegments.length > 0 && rejectedSegments.length === providerSegments.length) {
      throw new VoiceSpeechError("No speech was detected.", 422, "NO_SPEECH");
    }
    // If only part of a verbose Whisper result is confidently marked as
    // no-speech, omit that provider segment instead of preserving its common
    // silence hallucination in the top-level aggregate text.
    if (rejectedSegments.length > 0 && acceptedSegments.length > 0) {
      text = sanitizeText(acceptedSegments.map((segment) => segment.text).join(" "), TRANSCRIPT_MAX_CHARS);
    }
    if (!text) throw new VoiceSpeechError("No speech was detected.", 422, "NO_SPEECH");
    const segments = acceptedSegments
      .map((segment) => segment.timed)
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
    const language = sanitizeLanguage(input.language);
    if (!ttsLanguageIsSupported(this.config.supportedLanguages, language)) {
      throw new VoiceSpeechError("That language is not configured for server speech synthesis.", 400, "UNSUPPORTED_TTS_LANGUAGE");
    }
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
  private readonly sttVad?: SttVadPreflight;
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
    const supportedTtsLanguages = baseTtsConfig
      ? configuredTtsLanguages(env.TTS_LANGUAGES, baseTtsConfig.model)
      : [];
    this.ttsConfig = baseTtsConfig && perCallTtsVoices.size > 0 && supportedTtsLanguages.length > 0
      ? {
          ...baseTtsConfig,
          ...(defaultTtsVoice ? { defaultVoice: defaultTtsVoice } : {}),
          defaultFormat: parseTtsFormat(env.TTS_FORMAT, baseTtsConfig.model === "piper-sv" ? "wav" : "mp3"),
          allowedVoices: perCallTtsVoices,
          supportedLanguages: supportedTtsLanguages,
        }
      : undefined;
    this.normalizer = options.normalizer ?? new AudioNormalizer({
      ffmpegPath: env.FFMPEG_PATH?.trim() || undefined,
      ffprobePath: env.FFPROBE_PATH?.trim() || undefined,
    });
    const ttlMs = clampInteger(env.TTS_AUDIO_TTL_MS, DEFAULT_TTS_TTL_MS, 5_000, 300_000);
    this.audioStore = options.audioStore ?? new TtsAudioStore(ttlMs, options.now ?? Date.now);
    this.browserFallbackAllowed = env.VOICE_BROWSER_FALLBACK?.toLocaleLowerCase() !== "false";
    if (this.sttConfig) {
      this.stt = new OpenAiCompatibleSttProvider(this.sttConfig, fetchImpl);
      const vadConfig = sttVadConfig(env);
      if (vadConfig) {
        this.sttVad = new SttVadPreflight(
          vadConfig,
          options.sttVadRunner ?? runProcess,
          options.sttVadTempRoot ?? tmpdir(),
        );
      }
    }
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
        supportedLanguages: [...(this.ttsConfig?.supportedLanguages ?? [])],
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
    if (normalized.speechPresence?.classification === "noise") {
      throw new VoiceSpeechError("No speech was detected.", 422, "NO_SPEECH");
    }
    const vadDecision = this.sttVad
      ? await this.sttVad.classify(normalized, input.signal)
      : undefined;
    if (vadDecision === "no-speech") throw new VoiceSpeechError("No speech was detected.", 422, "NO_SPEECH");
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
