export const MARKET_OBSERVATION_FUTURE_TOLERANCE_MS = 5 * 60_000;
export const MARKET_OBSERVATION_MAX_STRUCTURAL_AGE_MS = 14 * 24 * 60 * 60_000;
export const MARKET_OBSERVATION_RECENT_AGE_MS = 2 * 60 * 60_000;
export const MARKET_OBSERVATION_PREVIOUS_SESSION_AGE_MS = 4 * 24 * 60 * 60_000;

export type MarketFreshnessStatus = "recent" | "previous_session" | "stale";

export const marketObservationAgeMs = (observedAtMs: number, now: number): number =>
  Math.max(0, now - observedAtMs);

export const classifyMarketFreshness = (
  observedAtMs: number,
  now: number,
): MarketFreshnessStatus => {
  const ageMs = marketObservationAgeMs(observedAtMs, now);
  if (ageMs <= MARKET_OBSERVATION_RECENT_AGE_MS) return "recent";
  if (ageMs <= MARKET_OBSERVATION_PREVIOUS_SESSION_AGE_MS) return "previous_session";
  return "stale";
};

export const isStructurallyAcceptableMarketInstant = (
  observedAtMs: number,
  now: number,
): boolean => Number.isSafeInteger(observedAtMs) &&
  observedAtMs <= now + MARKET_OBSERVATION_FUTURE_TOLERANCE_MS &&
  observedAtMs >= now - MARKET_OBSERVATION_MAX_STRUCTURAL_AGE_MS;
