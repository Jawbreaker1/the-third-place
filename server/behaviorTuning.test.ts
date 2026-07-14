import { describe, expect, it } from "vitest";
import { ambientDebateChance } from "./behaviorTuning.js";

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
