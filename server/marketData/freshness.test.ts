import { describe, expect, it } from "vitest";
import {
  MARKET_OBSERVATION_FUTURE_TOLERANCE_MS,
  MARKET_OBSERVATION_MAX_STRUCTURAL_AGE_MS,
  classifyMarketFreshness,
  isStructurallyAcceptableMarketInstant,
} from "./freshness.js";

describe("market observation freshness", () => {
  const now = Date.parse("2026-07-15T12:00:00.000Z");

  it("uses explicit age classes without claiming that a market is live or open", () => {
    expect(classifyMarketFreshness(now - 30 * 60_000, now)).toBe("recent");
    expect(classifyMarketFreshness(now - 24 * 60 * 60_000, now)).toBe("previous_session");
    expect(classifyMarketFreshness(now - 5 * 24 * 60 * 60_000, now)).toBe("stale");
  });

  it("accepts bounded closed-market history but rejects far-future and ancient observations", () => {
    expect(isStructurallyAcceptableMarketInstant(now, now)).toBe(true);
    expect(isStructurallyAcceptableMarketInstant(now + MARKET_OBSERVATION_FUTURE_TOLERANCE_MS, now)).toBe(true);
    expect(isStructurallyAcceptableMarketInstant(now + MARKET_OBSERVATION_FUTURE_TOLERANCE_MS + 1, now)).toBe(false);
    expect(isStructurallyAcceptableMarketInstant(now - MARKET_OBSERVATION_MAX_STRUCTURAL_AGE_MS, now)).toBe(true);
    expect(isStructurallyAcceptableMarketInstant(now - MARKET_OBSERVATION_MAX_STRUCTURAL_AGE_MS - 1, now)).toBe(false);
  });
});
