/**
 * A browser-independent voice activity / utterance state machine.
 *
 * Feed it normalized RMS samples (normally once per animation frame). All time
 * comes from the caller so behaviour is deterministic in tests and does not
 * depend on timers owned by this class.
 */

export interface VoiceActivitySample {
  nowMs: number;
  /** Normalized RMS energy, normally in the 0..1 range. */
  rms: number;
  /**
   * Temporarily ignore microphone activity (for example while disconnected or
   * deafened). Unlike setMuted(), this rearms on the next unsuppressed sample.
   */
  suppressed?: boolean;
  /** True while an AI clip is audible through this device. */
  playbackActive?: boolean;
}

export interface VoiceActivityOptions {
  /** Consecutive loud samples required before speech begins. */
  startFrames: number;
  /** Voiced time required to keep a segment instead of treating it as a cough/click. */
  minSpeechMs: number;
  /** Quiet time after the last voiced sample before an utterance is complete. */
  silenceHangoverMs: number;
  /** Hard boundary for one recording, allowing another segment to continue afterwards. */
  maxSegmentMs: number;
  /** Caps a single sample gap when accumulating voiced time. */
  maxFrameGapMs: number;
  initialNoiseFloor: number;
  minNoiseFloor: number;
  maxNoiseFloor: number;
  minStartRms: number;
  minContinueRms: number;
  startNoiseMultiplier: number;
  continueNoiseMultiplier: number;
  /** Slow upward tracking prevents speech from becoming the new noise floor. */
  noiseRiseAlpha: number;
  /** Faster downward tracking makes the detector recover in a quieter room. */
  noiseFallAlpha: number;
  /** Raises the onset threshold while device playback may leak into the microphone. */
  playbackThresholdMultiplier: number;
  /** A strong local voice can still barge in over AI playback. */
  playbackMinStartRms: number;
}

export type VoiceActivityEndReason = "silence" | "muted" | "reset" | "suppressed";

export type VoiceActivityEvent =
  | {
      type: "speechStarted";
      atMs: number;
      rms: number;
    }
  | {
      type: "speechEnded";
      atMs: number;
      reason: VoiceActivityEndReason;
    }
  | {
      type: "segmentStarted";
      atMs: number;
      reason: "speech" | "continuation";
    }
  | {
      type: "segmentStopped";
      atMs: number;
      reason: "silence" | "max-duration";
      durationMs: number;
      voicedMs: number;
    }
  | {
      type: "segmentDiscarded";
      atMs: number;
      reason: "too-short" | "muted" | "reset" | "suppressed";
      durationMs: number;
      voicedMs: number;
    };

export interface VoiceActivitySnapshot {
  muted: boolean;
  speechActive: boolean;
  segmentActive: boolean;
  noiseFloor: number;
  startThreshold: number;
  continueThreshold: number;
}

export const DEFAULT_VOICE_ACTIVITY_OPTIONS: Readonly<VoiceActivityOptions> = {
  startFrames: 3,
  minSpeechMs: 220,
  // A short conversational pause should end the microphone turn promptly.
  // The server independently verifies that the normalized clip contains
  // likely speech, so latency does not have to double as our noise filter.
  silenceHangoverMs: 450,
  maxSegmentMs: 26_000,
  maxFrameGapMs: 100,
  initialNoiseFloor: 0.006,
  minNoiseFloor: 0.002,
  maxNoiseFloor: 0.05,
  minStartRms: 0.028,
  minContinueRms: 0.014,
  startNoiseMultiplier: 3.4,
  continueNoiseMultiplier: 1.9,
  noiseRiseAlpha: 0.025,
  noiseFallAlpha: 0.14,
  playbackThresholdMultiplier: 1.8,
  playbackMinStartRms: 0.07,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const finiteNonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number`);
  return value;
};

const normalizedOptions = (overrides: Partial<VoiceActivityOptions>): VoiceActivityOptions => {
  const options = { ...DEFAULT_VOICE_ACTIVITY_OPTIONS, ...overrides };
  options.startFrames = Math.max(1, Math.floor(finiteNonNegative(options.startFrames, "startFrames")));
  options.minSpeechMs = finiteNonNegative(options.minSpeechMs, "minSpeechMs");
  options.silenceHangoverMs = finiteNonNegative(options.silenceHangoverMs, "silenceHangoverMs");
  options.maxSegmentMs = Math.max(1, finiteNonNegative(options.maxSegmentMs, "maxSegmentMs"));
  options.maxFrameGapMs = Math.max(1, finiteNonNegative(options.maxFrameGapMs, "maxFrameGapMs"));
  options.minNoiseFloor = finiteNonNegative(options.minNoiseFloor, "minNoiseFloor");
  options.maxNoiseFloor = Math.max(options.minNoiseFloor, finiteNonNegative(options.maxNoiseFloor, "maxNoiseFloor"));
  options.initialNoiseFloor = clamp(
    finiteNonNegative(options.initialNoiseFloor, "initialNoiseFloor"),
    options.minNoiseFloor,
    options.maxNoiseFloor,
  );
  options.minStartRms = finiteNonNegative(options.minStartRms, "minStartRms");
  options.minContinueRms = finiteNonNegative(options.minContinueRms, "minContinueRms");
  options.startNoiseMultiplier = finiteNonNegative(options.startNoiseMultiplier, "startNoiseMultiplier");
  options.continueNoiseMultiplier = finiteNonNegative(options.continueNoiseMultiplier, "continueNoiseMultiplier");
  options.noiseRiseAlpha = clamp(finiteNonNegative(options.noiseRiseAlpha, "noiseRiseAlpha"), 0, 1);
  options.noiseFallAlpha = clamp(finiteNonNegative(options.noiseFallAlpha, "noiseFallAlpha"), 0, 1);
  options.playbackThresholdMultiplier = Math.max(
    1,
    finiteNonNegative(options.playbackThresholdMultiplier, "playbackThresholdMultiplier"),
  );
  options.playbackMinStartRms = finiteNonNegative(options.playbackMinStartRms, "playbackMinStartRms");
  return options;
};

/**
 * Detects speech presence and turns that presence into bounded recording
 * segments. One instance should be used per local microphone.
 */
export class VoiceActivityDetector {
  readonly options: Readonly<VoiceActivityOptions>;

  private noiseFloor: number;
  private muted = false;
  private lastSampleAt?: number;
  private candidateFrames = 0;
  private candidateStartedAt?: number;
  private speechActive = false;
  private lastVoicedAt?: number;
  private segmentStartedAt?: number;
  private segmentVoicedMs = 0;

  constructor(options: Partial<VoiceActivityOptions> = {}) {
    this.options = normalizedOptions(options);
    this.noiseFloor = this.options.initialNoiseFloor;
  }

  push(sample: VoiceActivitySample): VoiceActivityEvent[] {
    const nowMs = finiteNonNegative(sample.nowMs, "nowMs");
    const rms = clamp(finiteNonNegative(sample.rms, "rms"), 0, 1);
    this.assertMonotonic(nowMs);

    const previousAt = this.lastSampleAt;
    this.lastSampleAt = nowMs;
    if (this.muted) return [];
    if (sample.suppressed) return this.interrupt(nowMs, "suppressed");

    const events: VoiceActivityEvent[] = [];
    if (!this.speechActive) {
      const startThreshold = this.startThreshold(Boolean(sample.playbackActive));
      if (rms >= startThreshold) {
        this.candidateStartedAt ??= nowMs;
        this.candidateFrames += 1;
        if (this.candidateFrames >= this.options.startFrames) {
          this.speechActive = true;
          this.lastVoicedAt = nowMs;
          this.segmentStartedAt = nowMs;
          this.segmentVoicedMs = Math.min(
            nowMs - this.candidateStartedAt,
            this.options.maxFrameGapMs * Math.max(0, this.options.startFrames - 1),
          );
          this.clearCandidate();
          events.push(
            { type: "speechStarted", atMs: nowMs, rms },
            { type: "segmentStarted", atMs: nowMs, reason: "speech" },
          );
        }
      } else {
        this.clearCandidate();
        if (!sample.playbackActive) this.adaptNoiseFloor(rms);
      }
      return events;
    }

    const voiced = rms >= this.continueThreshold();
    if (voiced) {
      this.lastVoicedAt = nowMs;
      if (this.segmentStartedAt === undefined) {
        this.segmentStartedAt = nowMs;
        this.segmentVoicedMs = 0;
        events.push({ type: "segmentStarted", atMs: nowMs, reason: "continuation" });
      } else if (previousAt !== undefined) {
        this.segmentVoicedMs += Math.min(Math.max(0, nowMs - previousAt), this.options.maxFrameGapMs);
      }
    }

    if (
      this.segmentStartedAt !== undefined &&
      nowMs - this.segmentStartedAt >= this.options.maxSegmentMs
    ) {
      events.push(this.stoppedSegment(nowMs, "max-duration"));
    }

    const lastVoicedAt = this.lastVoicedAt ?? nowMs;
    if (nowMs - lastVoicedAt >= this.options.silenceHangoverMs) {
      events.push({ type: "speechEnded", atMs: nowMs, reason: "silence" });
      const terminal = this.finishSegment(nowMs, "silence");
      if (terminal) events.push(terminal);
      this.speechActive = false;
      this.lastVoicedAt = undefined;
      this.clearCandidate();
      this.adaptNoiseFloor(rms);
    }

    return events;
  }

  /** Muting discards any partial recording and prevents new activity. */
  setMuted(muted: boolean, nowMs: number): VoiceActivityEvent[] {
    finiteNonNegative(nowMs, "nowMs");
    this.assertMonotonic(nowMs);
    this.lastSampleAt = nowMs;
    if (muted === this.muted) return [];
    this.muted = muted;
    return muted ? this.interrupt(nowMs, "muted") : [];
  }

  /**
   * Clears transient activity. The learned room noise is retained by default,
   * which makes leave/rejoin and device restarts less twitchy.
   */
  reset(nowMs: number, options: { resetNoiseFloor?: boolean } = {}): VoiceActivityEvent[] {
    finiteNonNegative(nowMs, "nowMs");
    this.assertMonotonic(nowMs);
    this.lastSampleAt = nowMs;
    const events = this.interrupt(nowMs, "reset");
    this.muted = false;
    if (options.resetNoiseFloor) this.noiseFloor = this.options.initialNoiseFloor;
    return events;
  }

  snapshot(playbackActive = false): VoiceActivitySnapshot {
    return {
      muted: this.muted,
      speechActive: this.speechActive,
      segmentActive: this.segmentStartedAt !== undefined,
      noiseFloor: this.noiseFloor,
      startThreshold: this.startThreshold(playbackActive),
      continueThreshold: this.continueThreshold(),
    };
  }

  private assertMonotonic(nowMs: number): void {
    if (this.lastSampleAt !== undefined && nowMs < this.lastSampleAt) {
      throw new RangeError("Voice activity timestamps must be monotonic");
    }
  }

  private startThreshold(playbackActive: boolean): number {
    const ambient = Math.max(
      this.options.minStartRms,
      this.noiseFloor * this.options.startNoiseMultiplier,
    );
    return playbackActive
      ? Math.max(
          this.options.playbackMinStartRms,
          ambient * this.options.playbackThresholdMultiplier,
        )
      : ambient;
  }

  private continueThreshold(): number {
    return Math.max(
      this.options.minContinueRms,
      this.noiseFloor * this.options.continueNoiseMultiplier,
    );
  }

  private adaptNoiseFloor(rms: number): void {
    // Do not let a loud transient (or voice) pull the floor up in one leap.
    // Repeated steady background noise can still raise it gradually.
    const capped = Math.min(rms, this.noiseFloor * 1.5 + 0.001);
    const target = clamp(capped, this.options.minNoiseFloor, this.options.maxNoiseFloor);
    const alpha = target > this.noiseFloor ? this.options.noiseRiseAlpha : this.options.noiseFallAlpha;
    this.noiseFloor = clamp(
      this.noiseFloor + (target - this.noiseFloor) * alpha,
      this.options.minNoiseFloor,
      this.options.maxNoiseFloor,
    );
  }

  private clearCandidate(): void {
    this.candidateFrames = 0;
    this.candidateStartedAt = undefined;
  }

  private stoppedSegment(nowMs: number, reason: "silence" | "max-duration"): VoiceActivityEvent {
    const startedAt = this.segmentStartedAt ?? nowMs;
    const event: VoiceActivityEvent = {
      type: "segmentStopped",
      atMs: nowMs,
      reason,
      durationMs: Math.max(0, nowMs - startedAt),
      voicedMs: this.segmentVoicedMs,
    };
    this.segmentStartedAt = undefined;
    this.segmentVoicedMs = 0;
    return event;
  }

  private finishSegment(nowMs: number, reason: "silence"): VoiceActivityEvent | undefined {
    if (this.segmentStartedAt === undefined) return undefined;
    if (this.segmentVoicedMs >= this.options.minSpeechMs) return this.stoppedSegment(nowMs, reason);

    const startedAt = this.segmentStartedAt;
    const event: VoiceActivityEvent = {
      type: "segmentDiscarded",
      atMs: nowMs,
      reason: "too-short",
      durationMs: Math.max(0, nowMs - startedAt),
      voicedMs: this.segmentVoicedMs,
    };
    this.segmentStartedAt = undefined;
    this.segmentVoicedMs = 0;
    return event;
  }

  private interrupt(nowMs: number, reason: "muted" | "reset" | "suppressed"): VoiceActivityEvent[] {
    const events: VoiceActivityEvent[] = [];
    if (this.speechActive) events.push({ type: "speechEnded", atMs: nowMs, reason });
    if (this.segmentStartedAt !== undefined) {
      events.push({
        type: "segmentDiscarded",
        atMs: nowMs,
        reason,
        durationMs: Math.max(0, nowMs - this.segmentStartedAt),
        voicedMs: this.segmentVoicedMs,
      });
    }
    this.speechActive = false;
    this.lastVoicedAt = undefined;
    this.segmentStartedAt = undefined;
    this.segmentVoicedMs = 0;
    this.clearCandidate();
    return events;
  }
}
