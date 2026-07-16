import { describe, expect, it } from "vitest";
import {
  ambientDebateChance,
  hasUnattendedAmbientCapacity,
  unattendedAmbientPolicy,
} from "./behaviorTuning.js";

describe("ambient debate tuning", () => {
  it("preserves every room baseline at the default aggression level", () => {
    expect(ambientDebateChance(0.08, 25)).toBeCloseTo(0.08);
    expect(ambientDebateChance(0.14, 25)).toBeCloseTo(0.14);
    expect(ambientDebateChance(0.28, 25)).toBeCloseTo(0.28);
  });

  it("makes maximum-aggression pub debates clearly more frequent without making them constant", () => {
    expect(ambientDebateChance(0.08, 0)).toBeCloseTo(0.04);
    expect(ambientDebateChance(0.08, 100)).toBeCloseTo(0.43);
    expect(ambientDebateChance(0.08, 100)).toBeGreaterThan(ambientDebateChance(0.08, 25));
  });

  it("normalizes runtime inputs and never exceeds the safety cap", () => {
    expect(ambientDebateChance(0.6, 100)).toBe(0.7);
    expect(ambientDebateChance(4, 100)).toBe(0.7);
    expect(ambientDebateChance(-1, 100)).toBe(0.35);
    expect(ambientDebateChance(0.08, Number.NaN)).toBeCloseTo(0.08);
  });
});

describe("unattended ambient tuning", () => {
  it("maps Activity onto a slow, bounded zero-human budget", () => {
    expect(unattendedAmbientPolicy(0)).toMatchObject({ enabled: false, hourlyCap: 0, dailyCap: 0 });
    expect(unattendedAmbientPolicy(1)).toMatchObject({
      enabled: true,
      minimumGapMs: 20 * 60_000,
      attemptCooldownMs: 30 * 60_000,
      hourlyCap: 1,
      dailyCap: 24,
    });
    expect(unattendedAmbientPolicy(50)).toMatchObject({
      enabled: true,
      minimumGapMs: 6 * 60_000,
      attemptCooldownMs: 10 * 60_000,
      hourlyCap: 3,
      dailyCap: 72,
    });
    expect(unattendedAmbientPolicy(100)).toMatchObject({
      enabled: true,
      minimumGapMs: 3 * 60_000,
      attemptCooldownMs: 5 * 60_000,
      hourlyCap: 6,
      dailyCap: 144,
    });
  });

  it("enforces minimum-gap and rolling hourly/daily capacity boundaries", () => {
    const now = Date.parse("2026-07-16T09:00:00.000Z");
    const policy = unattendedAmbientPolicy(50);
    const open = {
      now,
      policy,
      unattendedPublicationTimestamps: [] as number[],
    };
    expect(hasUnattendedAmbientCapacity(open)).toBe(true);
    expect(hasUnattendedAmbientCapacity({
      ...open,
      lastAutonomousPublicationAt: now - policy.minimumGapMs + 1,
    })).toBe(false);
    expect(hasUnattendedAmbientCapacity({
      ...open,
      lastAutonomousPublicationAt: now - policy.minimumGapMs,
      unattendedPublicationTimestamps: Array.from({ length: policy.hourlyCap }, (_, index) =>
        now - 60_000 - index * 60_000),
    })).toBe(false);
    expect(hasUnattendedAmbientCapacity({
      ...open,
      lastAutonomousPublicationAt: now - policy.minimumGapMs,
      unattendedPublicationTimestamps: Array.from({ length: policy.dailyCap }, (_, index) =>
        now - 2 * 60 * 60_000 - index * 10_000),
    })).toBe(false);
    expect(hasUnattendedAmbientCapacity({
      ...open,
      lastAutonomousPublicationAt: now - policy.minimumGapMs,
      unattendedPublicationTimestamps: [now - 24 * 60 * 60_000],
    })).toBe(true);
  });
});
