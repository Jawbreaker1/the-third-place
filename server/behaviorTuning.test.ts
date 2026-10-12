import { describe, expect, it } from "vitest";
import {
  ambientDebateChance,
  autonomousActivityLimits,
  autonomousPublicationBudget,
  isAutonomousPublicationBudgetState,
  type AutonomousPublicationBudgetState,
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

describe("continuous autonomous publication budget", () => {
  const start = Date.parse("2026-10-11T09:00:00.000Z");
  const limits = autonomousActivityLimits(10, 50);
  const empty: AutonomousPublicationBudgetState = {
    tokens: 0, updatedAt: start, refillPerMinute: 10, burstCapacity: 3,
  };

  it("admits a bounded initial burst and refills continuously rather than at window boundaries", () => {
    let state: AutonomousPublicationBudgetState | undefined;
    for (let slots = 3; slots > 0; slots -= 1) {
      const budget = autonomousPublicationBudget({ now: start, limits, state });
      expect(budget.slots).toBe(slots);
      expect(budget.nextSlotDelayMs).toBe(0);
      state = budget.consumedState;
    }
    expect(state).toEqual(empty);
    expect(autonomousPublicationBudget({ now: start, limits, state })).toMatchObject({
      slots: 0, nextSlotDelayMs: 6_000, consumedState: undefined,
    });
    expect(autonomousPublicationBudget({ now: start + 5_999, limits, state })).toMatchObject({
      slots: 0, nextSlotDelayMs: 1, consumedState: undefined,
    });
    expect(autonomousPublicationBudget({ now: start + 6_000, limits, state })).toMatchObject({
      slots: 1, nextSlotDelayMs: 0, consumedState: { tokens: 0 },
    });
    expect(autonomousPublicationBudget({ now: start + 18_000, limits, state }).slots).toBe(3);
  });

  it("remains active for a full day without the former 120/hour or daily cliff", () => {
    let state = empty;
    const hourlyCounts = Array<number>(24).fill(0);
    for (let second = 6; second <= 24 * 3_600; second += 6) {
      const budget = autonomousPublicationBudget({ now: start + second * 1_000, limits, state });
      expect(budget.slots).toBe(1);
      expect(budget.consumedState).toBeDefined();
      state = budget.consumedState!;
      hourlyCounts[Math.floor((second - 1) / 3_600)]! += 1;
    }
    expect(hourlyCounts).toEqual(Array<number>(24).fill(600));
    expect(state.tokens).toBe(0);
    expect(autonomousPublicationBudget({ now: state.updatedAt, limits, state }).slots).toBe(0);
  });

  it("reuses a durable checkpoint without granting a new burst after restart", () => {
    const persisted = JSON.parse(JSON.stringify(empty)) as AutonomousPublicationBudgetState;
    expect(autonomousPublicationBudget({ now: start + 3_000, limits, state: persisted }))
      .toMatchObject({ slots: 0, nextSlotDelayMs: 3_000, currentState: { tokens: 0.5 } });
    expect(autonomousPublicationBudget({ now: start + 3_000, limits, state: persisted }))
      .toEqual(autonomousPublicationBudget({ now: start + 3_000, limits, state: empty }));
    expect(persisted).toEqual(empty);
  });

  it("caps long-idle accumulation at the burst and handles exact fractional token boundaries", () => {
    expect(autonomousPublicationBudget({ now: start + 30 * 24 * 3_600_000, limits, state: empty }))
      .toMatchObject({ slots: 3, currentState: { tokens: 3 } });
    const state = { ...empty, tokens: 1 - 1e-12 };
    expect(autonomousPublicationBudget({ now: start, limits, state }))
      .toMatchObject({ slots: 1, consumedState: { tokens: 0 } });
  });

  it("accrues at the old rate before applying a changed activity limit without retroactive windfalls", () => {
    const faster = autonomousActivityLimits(10, 100);
    const changed = autonomousPublicationBudget({ now: start + 3_000, limits: faster, state: empty });
    expect(changed).toMatchObject({
      slots: 0,
      nextSlotDelayMs: 1_500,
      currentState: { tokens: 0.5, refillPerMinute: 20, burstCapacity: 5 },
    });
    expect(autonomousPublicationBudget({
      now: start + 4_500, limits: faster, state: changed.currentState,
    })).toMatchObject({ slots: 1 });
    expect(autonomousPublicationBudget({
      now: start, limits: { perMinute: 2, perTwelveSeconds: 1 }, state: { ...empty, tokens: 3 },
    })).toMatchObject({ slots: 1, currentState: { tokens: 1 } });
  });

  it("keeps zero activity disabled and does not accrue tokens while checkpointed off", () => {
    const disabled = autonomousPublicationBudget({ now: start, limits: autonomousActivityLimits(10, 0) });
    expect(disabled).toMatchObject({ slots: 0, nextSlotDelayMs: Infinity, consumedState: undefined });
    expect(autonomousPublicationBudget({
      now: start + 3_600_000, limits, state: disabled.currentState,
    })).toMatchObject({ slots: 0, currentState: { tokens: 0 }, nextSlotDelayMs: 6_000 });
  });

  it("fails closed for invalid inputs and clock rollback", () => {
    for (const now of [NaN, Infinity, -1]) {
      expect(autonomousPublicationBudget({ now, limits }).slots).toBe(0);
    }
    for (const invalid of [NaN, Infinity, -1]) {
      expect(autonomousPublicationBudget({
        now: start, limits: { perMinute: invalid, perTwelveSeconds: 3 },
      })).toMatchObject({ slots: 0, consumedState: undefined });
      expect(autonomousPublicationBudget({
        now: start, limits, state: { ...empty, tokens: invalid },
      })).toMatchObject({ slots: 0, consumedState: undefined });
    }
    expect(autonomousPublicationBudget({ now: start - 1_000, limits, state: empty }))
      .toMatchObject({ slots: 0, nextSlotDelayMs: 7_000, consumedState: undefined });
  });

  it("validates persisted checkpoints without accepting malformed or impossible token counts", () => {
    expect(isAutonomousPublicationBudgetState(empty)).toBe(true);
    expect(isAutonomousPublicationBudgetState({ ...empty, tokens: 0.25 })).toBe(true);
    for (const invalid of [null, {}, "state", { ...empty, tokens: "0" },
      { ...empty, tokens: 4 }, { ...empty, burstCapacity: 2.5 }, { ...empty, unexpected: true },
      { ...empty, updatedAt: Infinity }, { ...empty, refillPerMinute: -1 }]) {
      expect(isAutonomousPublicationBudgetState(invalid)).toBe(false);
    }
  });
});
