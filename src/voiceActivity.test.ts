import { describe, expect, it } from "vitest";
import { VoiceActivityDetector, type VoiceActivityEvent } from "./voiceActivity";

const eventTypes = (events: VoiceActivityEvent[]): VoiceActivityEvent["type"][] =>
  events.map((event) => event.type);

const beginSpeech = (
  detector: VoiceActivityDetector,
  startAt = 0,
  rms = 0.08,
  playbackActive = false,
): VoiceActivityEvent[] => {
  detector.push({ nowMs: startAt, rms, playbackActive });
  detector.push({ nowMs: startAt + 20, rms, playbackActive });
  return detector.push({ nowMs: startAt + 40, rms, playbackActive });
};

describe("VoiceActivityDetector", () => {
  it("requires sustained loud frames before starting a recording segment", () => {
    const detector = new VoiceActivityDetector();

    expect(detector.push({ nowMs: 0, rms: 0.08 })).toEqual([]);
    expect(detector.push({ nowMs: 20, rms: 0.08 })).toEqual([]);
    expect(eventTypes(detector.push({ nowMs: 40, rms: 0.08 }))).toEqual([
      "speechStarted",
      "segmentStarted",
    ]);
  });

  it("tracks steady room noise slowly without mistaking it for speech", () => {
    const detector = new VoiceActivityDetector({ minStartRms: 0.04 });
    const before = detector.snapshot();

    for (let frame = 0; frame < 160; frame += 1) {
      expect(detector.push({ nowMs: frame * 20, rms: 0.02 })).toEqual([]);
    }

    const after = detector.snapshot();
    expect(after.noiseFloor).toBeGreaterThan(before.noiseFloor);
    expect(after.startThreshold).toBeGreaterThanOrEqual(0.04);
    expect(after.speechActive).toBe(false);
  });

  it("uses hysteresis so ordinary syllable dips do not chop a turn", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);

    // Below the onset threshold, but above the lower continuation threshold.
    for (let nowMs = 60; nowMs <= 500; nowMs += 40) {
      expect(detector.push({ nowMs, rms: 0.018 })).toEqual([]);
    }

    expect(detector.snapshot().speechActive).toBe(true);
    expect(detector.snapshot().segmentActive).toBe(true);
  });

  it("waits for the silence hangover and discards cough-sized activity", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);
    detector.push({ nowMs: 100, rms: 0.08 });
    const boundary = 100 + detector.options.silenceHangoverMs;

    expect(detector.push({ nowMs: boundary - 1, rms: 0.001 })).toEqual([]);
    const ended = detector.push({ nowMs: boundary, rms: 0.001 });

    expect(eventTypes(ended)).toEqual(["speechEnded", "segmentDiscarded"]);
    expect(ended[1]).toMatchObject({ reason: "too-short" });
    expect(detector.snapshot().speechActive).toBe(false);
  });

  it("keeps a real utterance after the conversational silence boundary", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);
    for (let nowMs = 80; nowMs <= 440; nowMs += 40) {
      detector.push({ nowMs, rms: 0.06 });
    }
    const boundary = 440 + detector.options.silenceHangoverMs;

    expect(detector.push({ nowMs: boundary - 1, rms: 0.002 })).toEqual([]);
    const ended = detector.push({ nowMs: boundary, rms: 0.002 });

    expect(eventTypes(ended)).toEqual(["speechEnded", "segmentStopped"]);
    expect(ended[1]).toMatchObject({ reason: "silence" });
    if (ended[1]?.type === "segmentStopped") expect(ended[1].voicedMs).toBeGreaterThanOrEqual(220);
  });

  it("gates likely speaker echo but permits a strong human barge-in", () => {
    const detector = new VoiceActivityDetector();
    for (let frame = 0; frame < 5; frame += 1) {
      expect(detector.push({ nowMs: frame * 20, rms: 0.055, playbackActive: true })).toEqual([]);
    }
    expect(detector.snapshot(true).startThreshold).toBeGreaterThan(0.055);

    detector.push({ nowMs: 120, rms: 0.09, playbackActive: true });
    detector.push({ nowMs: 140, rms: 0.09, playbackActive: true });
    expect(eventTypes(detector.push({ nowMs: 160, rms: 0.09, playbackActive: true }))).toEqual([
      "speechStarted",
      "segmentStarted",
    ]);
  });

  it("bounds long recordings and opens a continuation segment", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);

    let boundary: VoiceActivityEvent[] = [];
    for (let nowMs = 140; nowMs <= 26_040; nowMs += 100) {
      const events = detector.push({ nowMs, rms: 0.06 });
      if (events.length > 0) boundary = events;
    }
    expect(boundary).toHaveLength(1);
    expect(boundary[0]).toMatchObject({ type: "segmentStopped", reason: "max-duration" });
    expect(detector.snapshot().speechActive).toBe(true);
    expect(detector.snapshot().segmentActive).toBe(false);

    expect(detector.push({ nowMs: 26_060, rms: 0.06 })).toEqual([
      { type: "segmentStarted", atMs: 26_060, reason: "continuation" },
    ]);
  });

  it("discards an active turn on mute and rearms after unmuting", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);

    expect(eventTypes(detector.setMuted(true, 100))).toEqual(["speechEnded", "segmentDiscarded"]);
    expect(detector.push({ nowMs: 120, rms: 0.09 })).toEqual([]);
    expect(detector.snapshot().muted).toBe(true);

    expect(detector.setMuted(false, 140)).toEqual([]);
    expect(eventTypes(beginSpeech(detector, 160))).toEqual(["speechStarted", "segmentStarted"]);
  });

  it("temporarily suppresses a sample and rearms without a mute transition", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);

    const suppressed = detector.push({ nowMs: 100, rms: 0.08, suppressed: true });
    expect(eventTypes(suppressed)).toEqual(["speechEnded", "segmentDiscarded"]);
    expect(suppressed).toEqual([
      { type: "speechEnded", atMs: 100, reason: "suppressed" },
      {
        type: "segmentDiscarded",
        atMs: 100,
        reason: "suppressed",
        durationMs: 60,
        voicedMs: 40,
      },
    ]);

    expect(eventTypes(beginSpeech(detector, 120))).toEqual(["speechStarted", "segmentStarted"]);
  });

  it("can reset transient state and optionally reset the learned noise floor", () => {
    const detector = new VoiceActivityDetector({ minStartRms: 0.04 });
    for (let frame = 0; frame < 100; frame += 1) detector.push({ nowMs: frame * 20, rms: 0.02 });
    const learned = detector.snapshot().noiseFloor;
    expect(learned).toBeGreaterThan(detector.options.initialNoiseFloor);

    expect(detector.reset(2_000)).toEqual([]);
    expect(detector.snapshot().noiseFloor).toBeCloseTo(learned);
    expect(detector.reset(2_020, { resetNoiseFloor: true })).toEqual([]);
    expect(detector.snapshot().noiseFloor).toBe(detector.options.initialNoiseFloor);
  });

  it("rejects non-monotonic timestamps", () => {
    const detector = new VoiceActivityDetector();
    detector.push({ nowMs: 100, rms: 0.001 });
    expect(() => detector.push({ nowMs: 99, rms: 0.001 })).toThrow(/monotonic/iu);
  });

  it("updates threshold sensitivity without resetting active speech", () => {
    const detector = new VoiceActivityDetector();
    beginSpeech(detector);
    const before = detector.snapshot();

    detector.setThresholdMultiplier(0.5);
    const after = detector.snapshot();

    expect(after.speechActive).toBe(true);
    expect(after.segmentActive).toBe(true);
    expect(after.thresholdMultiplier).toBe(0.5);
    expect(after.startThreshold).toBeCloseTo(before.startThreshold / 2);
    expect(after.continueThreshold).toBeCloseTo(before.continueThreshold / 2);
    expect(() => detector.setThresholdMultiplier(0)).toThrow(/positive/iu);
  });
});
