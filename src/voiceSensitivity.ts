import { DEFAULT_VOICE_ACTIVITY_OPTIONS } from "./voiceActivity";

export const VOICE_SENSITIVITY_MIN = 0;
export const VOICE_SENSITIVITY_MAX = 100;
export const DEFAULT_VOICE_SENSITIVITY = 50;
export const VOICE_SENSITIVITY_STORAGE_KEY = "the-third-place.voice-sensitivity.v1";

export interface VoiceInputMeter {
  /** Display positions use the same logarithmic scale, in the 0..1 range. */
  level: number;
  threshold: number;
  aboveThreshold: boolean;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * Accepts a persisted or UI sensitivity value and returns a safe integer.
 * Higher values intentionally mean that quieter voices are easier to pick up.
 */
export const normalizeVoiceSensitivity = (value: unknown): number => {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_VOICE_SENSITIVITY;
  return Math.round(clamp(numeric, VOICE_SENSITIVITY_MIN, VOICE_SENSITIVITY_MAX));
};

/**
 * Maps the human-facing 0..100 sensitivity control to an acoustic threshold.
 * The midpoint preserves the detector's calibrated defaults, while either end
 * changes the threshold by one octave. This stays language- and device-neutral:
 * it scales the adaptive detector instead of classifying words or transcripts.
 */
export const voiceSensitivityThresholdMultiplier = (sensitivity: unknown): number =>
  2 ** ((DEFAULT_VOICE_SENSITIVITY - normalizeVoiceSensitivity(sensitivity)) / DEFAULT_VOICE_SENSITIVITY);

const METER_MIN_RMS = 0.001;
const METER_MAX_RMS = 0.25;

/** Maps RMS amplitude onto a useful logarithmic microphone-meter scale. */
export const voiceRmsMeterPosition = (rms: number): number => {
  if (!Number.isFinite(rms) || rms <= METER_MIN_RMS) return 0;
  if (rms >= METER_MAX_RMS) return 1;
  return Math.log(rms / METER_MIN_RMS) / Math.log(METER_MAX_RMS / METER_MIN_RMS);
};

/**
 * Produces both the live level and the current adaptive start marker on exactly
 * the same scale, so the UI honestly shows whether this microphone would open
 * the hands-free recording gate.
 */
export const voiceInputMeter = (rms: number, startThreshold: number): VoiceInputMeter => {
  const safeRms = Number.isFinite(rms) ? clamp(rms, 0, 1) : 0;
  const safeThreshold = Number.isFinite(startThreshold) && startThreshold >= 0
    ? clamp(startThreshold, 0, 1)
    : DEFAULT_VOICE_ACTIVITY_OPTIONS.minStartRms;
  return {
    level: voiceRmsMeterPosition(safeRms),
    threshold: voiceRmsMeterPosition(safeThreshold),
    aboveThreshold: safeRms >= safeThreshold,
  };
};
