import { describe, expect, it } from "vitest";
import {
  ambientConversationTimingPolicy,
  ambientSchedulingPolicy,
  type AmbientCapacitySnapshot,
} from "./ambientScheduling.js";

const idle: AmbientCapacitySnapshot = {
  connected: true,
  queueDepth: 0,
  activePredictions: 0,
  activeBackgroundPredictions: 0,
  maxConcurrentPredictions: 4,
  maxBackgroundPredictions: 2,
  effectiveMaxBackgroundPredictions: 2,
  foregroundDemandCount: 0,
};

const decide = (input: Partial<Parameters<typeof ambientSchedulingPolicy>[0]> = {}) =>
  ambientSchedulingPolicy({
    health: idle,
    activity: 50,
    configuredWorkers: 2,
    workerId: 0,
    random: 0.5,
    ...input,
  });

describe("capacity-aware ambient scheduling", () => {
  it("makes both workers available without requiring an online or recently active human", () => {
    expect(decide()).toMatchObject({ allowed: true, workerLimit: 2, delayMs: 3_500 });
    expect(decide({ workerId: 1 })).toMatchObject({ allowed: true, workerLimit: 2 });
    expect(decide({ workerId: 2 })).toMatchObject({ allowed: false, reason: "worker-limit" });
  });

  it("uses a 2–5 second lively opportunity cadence with idle capacity", () => {
    expect(decide({ random: 0 }).delayMs).toBe(2_000);
    expect(decide({ random: 1 }).delayMs).toBe(5_000);
    expect(decide({ pace: "calm", random: 0 }).delayMs).toBe(5_000);
    expect(decide({ pace: "calm", random: 1 }).delayMs).toBe(10_000);
    expect(decide({ pace: "party", random: 0 }).delayMs).toBe(1_000);
    expect(decide({ pace: "party", random: 1 }).delayMs).toBe(3_000);
  });

  it("does not delay spare capacity merely because other work is running", () => {
    const partial = decide({ health: { ...idle, queueDepth: 1, activePredictions: 1 } });
    expect(partial).toMatchObject({ allowed: true, delayMs: 3_500 });
    const loaded = decide({ health: { ...idle, queueDepth: 3, activePredictions: 3 } });
    expect(loaded).toMatchObject({ allowed: true, delayMs: 3_500 });
  });

  it("honors foreground reservations across prediction gaps without shutting down all room life", () => {
    const foreground: AmbientCapacitySnapshot = {
      ...idle,
      effectiveMaxBackgroundPredictions: 1,
      foregroundDemandCount: 1,
    };
    expect(decide({ health: foreground })).toMatchObject({
      allowed: true, workerLimit: 1, delayMs: 7_000,
    });
    expect(decide({ health: foreground, workerId: 1 })).toMatchObject({
      allowed: false, reason: "worker-limit", workerLimit: 1,
    });
    expect(decide({ health: { ...foreground, queueDepth: 1, activePredictions: 1,
      activeBackgroundPredictions: 1 } })).toMatchObject({
      allowed: false, reason: "background-full",
    });
  });

  it("does not add optional work to a queue even if the latest active count advertises space", () => {
    expect(decide({ health: { ...idle, queueDepth: 2, activePredictions: 1 } })).toMatchObject({
      allowed: false, reason: "queued", delayMs: 6_000,
    });
  });

  it("honors total and background hard ceilings independently", () => {
    expect(decide({ health: { ...idle, queueDepth: 4, activePredictions: 4 } })).toMatchObject({
      allowed: false, reason: "prediction-full",
    });
    expect(decide({ health: { ...idle, queueDepth: 2, activePredictions: 2,
      activeBackgroundPredictions: 2 } })).toMatchObject({
      allowed: false, reason: "background-full",
    });
    expect(decide({ configuredWorkers: 8 })).toMatchObject({ workerLimit: 2 });
    expect(decide({ configuredWorkers: 8, health: { ...idle, effectiveMaxBackgroundPredictions: 8 } }))
      .toMatchObject({ workerLimit: 2 });
    expect(decide({ health: { ...idle, maxConcurrentPredictions: 1,
      maxBackgroundPredictions: 1, effectiveMaxBackgroundPredictions: 1 } })).toMatchObject({
      allowed: true, workerLimit: 1,
    });
  });

  it("keeps blocked-capacity retries at least 4–8 seconds even at maximum activity", () => {
    const health = { ...idle, queueDepth: 4, activePredictions: 4 };
    expect(decide({ health, activity: 100, pace: "party", random: 0 }).delayMs).toBe(4_000);
    expect(decide({ health, activity: 100, pace: "party", random: 1 }).delayMs).toBe(8_000);
    expect(decide({ health: { ...idle, connected: false }, pace: "party", random: 0 }).delayMs)
      .toBe(4_000);
  });

  it("keeps legacy snapshots conservative but recognizes work already owned by this director", () => {
    expect(decide({ health: { connected: true, queueDepth: 1 } })).toMatchObject({
      allowed: false, reason: "legacy-busy",
    });
    expect(decide({ health: { connected: true, queueDepth: 1 }, ownedAmbientGenerations: 1 }))
      .toMatchObject({ allowed: true });
  });

  it("does not use a health ping's latency as a substitute for scheduler demand", () => {
    const health = { ...idle, latencyMs: 120_000 };
    expect(decide({ health })).toEqual(decide());
  });

  it("keeps off, disconnected, disabled workers and invalid queue snapshots closed", () => {
    expect(decide({ activity: 0 })).toMatchObject({ allowed: false, reason: "off", workerLimit: 0 });
    expect(decide({ health: { ...idle, connected: false } })).toMatchObject({
      allowed: false, reason: "offline",
    });
    expect(decide({ configuredWorkers: 0 })).toMatchObject({ allowed: false, reason: "worker-limit" });
    expect(decide({ workerId: -1 })).toMatchObject({ allowed: false, reason: "worker-limit" });
    expect(decide({ health: { ...idle, queueDepth: NaN } })).toMatchObject({
      allowed: false, reason: "queued",
    });
  });

  it("normalizes controls and speeds up monotonically without removing hard ceilings", () => {
    let previousDelay = Infinity;
    for (let activity = 1; activity <= 100; activity += 1) {
      const policy = decide({ activity });
      expect(policy.allowed).toBe(true);
      expect(policy.delayMs).toBeLessThanOrEqual(previousDelay);
      expect(policy.delayMs).toBeGreaterThanOrEqual(1_000);
      expect(policy.workerLimit).toBe(2);
      previousDelay = policy.delayMs;
    }
    expect(decide({ activity: NaN, random: NaN })).toEqual(decide());
    expect(decide({ activity: 500 })).toEqual(decide({ activity: 100 }));
    expect(decide({ random: -2 })).toEqual(decide({ random: 0 }));
    expect(decide({ random: 2 })).toEqual(decide({ random: 1 }));
  });
});

describe("autonomous room timing", () => {
  it("keeps active conversation turns close and closed-room pauses under two minutes at defaults", () => {
    expect(ambientConversationTimingPolicy({ activity: 50, random: 0 })).toEqual({
      activeConversationDelayMs: 3_000,
      closedConversationCooldownMs: 45_000,
    });
    expect(ambientConversationTimingPolicy({ activity: 50, random: 1 })).toEqual({
      activeConversationDelayMs: 8_000,
      closedConversationCooldownMs: 90_000,
    });
  });

  it("scales room timings monotonically with activity and normalizes invalid random values", () => {
    let previous = ambientConversationTimingPolicy({ activity: 1, random: 0.5 });
    for (let activity = 2; activity <= 100; activity += 1) {
      const policy = ambientConversationTimingPolicy({ activity, random: 0.5 });
      expect(policy.activeConversationDelayMs).toBeLessThanOrEqual(previous.activeConversationDelayMs);
      expect(policy.closedConversationCooldownMs).toBeLessThanOrEqual(previous.closedConversationCooldownMs);
      expect(policy.activeConversationDelayMs).toBeGreaterThanOrEqual(1_000);
      previous = policy;
    }
    expect(ambientConversationTimingPolicy({ activity: NaN, random: NaN }))
      .toEqual(ambientConversationTimingPolicy({ activity: 50, random: 0.5 }));
    expect(ambientConversationTimingPolicy({ activity: 50, random: -2 }))
      .toEqual(ambientConversationTimingPolicy({ activity: 50, random: 0 }));
    expect(ambientConversationTimingPolicy({ activity: 50, random: 3 }))
      .toEqual(ambientConversationTimingPolicy({ activity: 50, random: 1 }));
  });
});
