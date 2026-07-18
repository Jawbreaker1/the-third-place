import { describe, expect, it } from "vitest";
import { VoiceActivityDetector } from "./voiceActivity";
import {
  DEFAULT_VOICE_SENSITIVITY,
  normalizeVoiceSensitivity,
  voiceInputMeter,
  voiceRmsMeterPosition,
  voiceSensitivityThresholdMultiplier,
} from "./voiceSensitivity";

describe("voice sensitivity calibration", () => {
  it("normalizes persisted and UI values into the supported range", () => {
    expect(normalizeVoiceSensitivity("72.6")).toBe(73);
    expect(normalizeVoiceSensitivity(-12)).toBe(0);
    expect(normalizeVoiceSensitivity(140)).toBe(100);
    expect(normalizeVoiceSensitivity("not-a-number")).toBe(DEFAULT_VOICE_SENSITIVITY);
  });

  it("keeps the midpoint calibrated to existing VAD behaviour", () => {
    expect(voiceSensitivityThresholdMultiplier(50)).toBe(1);
    expect(voiceSensitivityThresholdMultiplier(0)).toBe(2);
    expect(voiceSensitivityThresholdMultiplier(100)).toBe(0.5);
  });

  it("lowers thresholds monotonically as sensitivity increases", () => {
    const detector = new VoiceActivityDetector();
    detector.setThresholdMultiplier(voiceSensitivityThresholdMultiplier(0));
    const lowSensitivity = detector.snapshot().startThreshold;
    detector.setThresholdMultiplier(voiceSensitivityThresholdMultiplier(50));
    const balanced = detector.snapshot().startThreshold;
    detector.setThresholdMultiplier(voiceSensitivityThresholdMultiplier(100));
    const highSensitivity = detector.snapshot().startThreshold;

    expect(lowSensitivity).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(highSensitivity);
    expect(balanced).toBeCloseTo(0.028);
  });

  it("lets a quiet sustained voice cross the gate only at a suitable setting", () => {
    const quietRms = 0.018;
    const balanced = new VoiceActivityDetector();
    const sensitive = new VoiceActivityDetector();
    sensitive.setThresholdMultiplier(voiceSensitivityThresholdMultiplier(100));

    for (const nowMs of [0, 20, 40]) balanced.push({ nowMs, rms: quietRms });
    const sensitiveEvents = [0, 20, 40].flatMap((nowMs) => sensitive.push({ nowMs, rms: quietRms }));

    expect(balanced.snapshot().speechActive).toBe(false);
    expect(sensitiveEvents.map((event) => event.type)).toEqual(["speechStarted", "segmentStarted"]);
  });

  it("keeps level and adaptive threshold markers on the same logarithmic scale", () => {
    const quiet = voiceRmsMeterPosition(0.004);
    const conversational = voiceRmsMeterPosition(0.04);
    const loud = voiceRmsMeterPosition(0.2);
    expect(quiet).toBeLessThan(conversational);
    expect(conversational).toBeLessThan(loud);

    const below = voiceInputMeter(0.02, 0.028);
    const above = voiceInputMeter(0.04, 0.028);
    expect(below.aboveThreshold).toBe(false);
    expect(below.level).toBeLessThan(below.threshold);
    expect(above.aboveThreshold).toBe(true);
    expect(above.level).toBeGreaterThan(above.threshold);
  });
});
