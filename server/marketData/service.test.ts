import { describe, expect, it, vi } from "vitest";
import { MARKET_INDEX_CATALOG, MARKET_INDEX_IDS, type MarketIndexId } from "./catalog.js";
import { classifyMarketFreshness, marketObservationAgeMs } from "./freshness.js";
import { MarketSnapshotService } from "./service.js";
import type {
  MarketDataProvider,
  MarketObservation,
  MarketProviderBatch,
  MarketProviderRequest,
} from "./types.js";

const START = Date.parse("2026-07-15T12:00:00.000Z");

const observation = (
  indexId: MarketIndexId,
  providerId: string,
  now: number,
  options: Partial<MarketObservation> & { observedAt?: number; level?: number; previousClose?: number } = {},
): MarketObservation => {
  const definition = MARKET_INDEX_CATALOG[indexId];
  const observedAtMs = options.observedAt ?? now - 60_000;
  const level = options.level ?? 102;
  const previousClose = options.previousClose ?? 100;
  const change = level - previousClose;
  return {
    indexId,
    displayName: definition.displayName,
    shortName: definition.shortName,
    region: definition.region,
    countryCode: definition.countryCode,
    exchangeTimeZone: definition.exchangeTimeZone,
    tradingDate: "2026-07-15",
    currency: definition.currency,
    level,
    previousClose,
    change,
    changePercent: change / previousClose * 100,
    changeBasis: "previous_close",
    freshness: {
      status: classifyMarketFreshness(observedAtMs, now),
      observedAt: new Date(observedAtMs).toISOString(),
      ageMs: marketObservationAgeMs(observedAtMs, now),
    },
    provider: {
      id: providerId,
      experimental: false,
      sourceUrl: `https://example.com/markets/${indexId}`,
      retrievedAt: new Date(now).toISOString(),
    },
    ...options,
  };
};

const batch = (
  providerId: string,
  now: number,
  observations: readonly MarketObservation[],
  requested: readonly MarketIndexId[],
): MarketProviderBatch => ({
  providerId,
  retrievedAt: new Date(now).toISOString(),
  observations,
  failures: requested
    .filter((id) => !observations.some((candidate) => candidate.indexId === id))
    .map((indexId) => ({ indexId, reason: "missing_observation" as const })),
});
const provider = (
  id: string,
  supportedIndexIds: readonly MarketIndexId[],
  read: (request: MarketProviderRequest) => Promise<MarketProviderBatch>,
): MarketDataProvider => ({
  id,
  experimental: false,
  supportedIndexIds,
  read: vi.fn(read),
});

describe("provider-neutral market snapshot service", () => {
  it("fills only missing rows from ordered fallback providers without mixing observations", async () => {
    const primary = provider("primary", MARKET_INDEX_IDS, async (request) =>
      batch("primary", request.now, [observation("US_SP500", "primary", request.now)], request.indexIds));
    const fallback = provider("fallback", MARKET_INDEX_IDS, async (request) =>
      batch("fallback", request.now, request.indexIds.map((id) => observation(id, "fallback", request.now)), request.indexIds));
    const service = new MarketSnapshotService({ providers: [primary, fallback], now: () => START });

    const result = await service.snapshot({ targetId: "US_MAJOR" });
    expect(result.coverage).toMatchObject({ requested: 3, available: 3, ratio: 1, complete: true });
    expect(result.missingIndexIds).toEqual([]);
    expect(result.observations.map((item) => [item.indexId, item.provider.id])).toEqual([
      ["US_SP500", "primary"],
      ["US_DJIA", "fallback"],
      ["US_NASDAQ_COMPOSITE", "fallback"],
    ]);
    expect(primary.read).toHaveBeenCalledWith({
      indexIds: ["US_SP500", "US_DJIA", "US_NASDAQ_COMPOSITE"],
      now: START,
    });
    expect(fallback.read).toHaveBeenCalledWith({
      indexIds: ["US_DJIA", "US_NASDAQ_COMPOSITE"],
      now: START,
    });
    expect(result.providerAttempts).toEqual([
      { providerId: "primary", status: "partial", requested: 3, accepted: 1 },
      { providerId: "fallback", status: "complete", requested: 2, accepted: 2 },
    ]);
  });

  it("validates the fixed community market-wire basket through the normal provider boundary", async () => {
    const communityIds = [
      "SE_OMXS30",
      "EU_STOXX50",
      "US_SP500",
      "US_NASDAQ_COMPOSITE",
      "JP_NIKKEI225",
      "HK_HSI",
    ] as const;
    const backing = provider("backing", MARKET_INDEX_IDS, async (request) =>
      batch(
        "backing",
        request.now,
        request.indexIds.map((id) => observation(id, "backing", request.now)),
        request.indexIds,
      ));
    const result = await new MarketSnapshotService({ providers: [backing], now: () => START })
      .snapshot({ targetId: "COMMUNITY_MAJOR" });

    expect(backing.read).toHaveBeenCalledWith({ indexIds: communityIds, now: START });
    expect(result.requestedIndexIds).toEqual(communityIds);
    expect(result.coverage).toMatchObject({ requested: 6, available: 6, complete: true });
  });

  it("coalesces in-flight work, caches completed snapshots and refreshes cached age labels", async () => {
    let now = START;
    const observedAt = START - 119 * 60_000;
    const backing = provider("backing", ["US_SP500"], async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return batch("backing", request.now, [observation("US_SP500", "backing", request.now, { observedAt })], request.indexIds);
    });
    const service = new MarketSnapshotService({
      providers: [backing],
      now: () => now,
      cacheTtlMs: 10 * 60_000,
    });

    const [first, joined] = await Promise.all([
      service.snapshot({ targetId: "US_SP500" }),
      service.snapshot({ targetId: "US_SP500" }),
    ]);
    expect(first).toEqual(joined);
    expect(backing.read).toHaveBeenCalledTimes(1);
    expect(first.observations[0]!.freshness.status).toBe("recent");

    now += 2 * 60_000;
    const cached = await service.snapshot({ targetId: "US_SP500" });
    expect(backing.read).toHaveBeenCalledTimes(1);
    expect(cached.observations[0]!.freshness.status).toBe("previous_session");
    expect(cached.observations[0]!.freshness.ageMs).toBe(121 * 60_000);

    now += 10 * 60_000;
    await service.snapshot({ targetId: "US_SP500" });
    expect(backing.read).toHaveBeenCalledTimes(2);
  });

  it("returns explicit partial world coverage instead of silently presenting it as global", async () => {
    const limited = provider("limited", ["US_SP500"], async (request) =>
      batch("limited", request.now, [observation("US_SP500", "limited", request.now)], request.indexIds));
    const result = await new MarketSnapshotService({ providers: [limited], now: () => START })
      .snapshot({ targetId: "GLOBAL_MAJOR" });
    expect(result.coverage).toEqual({
      requested: 8,
      available: 1,
      ratio: 0.125,
      complete: false,
      recent: 1,
      previousSession: 0,
      stale: 0,
    });
    expect(result.missingIndexIds).toHaveLength(7);
    expect(result.requestedIndexIds).toEqual([
      "US_SP500",
      "US_DJIA",
      "US_NASDAQ_COMPOSITE",
      "EU_STOXX50",
      "GB_FTSE100",
      "JP_NIKKEI225",
      "HK_HSI",
      "BR_IBOVESPA",
    ]);
  });

  it("opens a short provider circuit after bounded consecutive failures and retries after cooldown", async () => {
    let now = START;
    const broken = provider("broken", MARKET_INDEX_IDS, async () => {
      throw new Error("provider down");
    });
    const fallback = provider("fallback", MARKET_INDEX_IDS, async (request) =>
      batch("fallback", request.now, request.indexIds.map((id) => observation(id, "fallback", request.now)), request.indexIds));
    const service = new MarketSnapshotService({
      providers: [broken, fallback],
      now: () => now,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 1_000,
    });

    await service.snapshot({ targetId: "US_SP500", cachePolicy: "bypass" });
    await service.snapshot({ targetId: "US_DJIA", cachePolicy: "bypass" });
    const third = await service.snapshot({ targetId: "US_NASDAQ_COMPOSITE", cachePolicy: "bypass" });
    expect(broken.read).toHaveBeenCalledTimes(2);
    expect(third.providerAttempts[0]).toEqual({
      providerId: "broken",
      status: "circuit_open",
      requested: 1,
      accepted: 0,
    });

    now += 1_001;
    await service.snapshot({ targetId: "SE_OMXS30", cachePolicy: "bypass" });
    expect(broken.read).toHaveBeenCalledTimes(3);
  });

  it("bounds a hanging provider call and continues with the next provider", async () => {
    const hanging = provider("hanging", ["US_SP500"], async () => new Promise<MarketProviderBatch>(() => {}));
    const fallback = provider("fallback", ["US_SP500"], async (request) =>
      batch("fallback", request.now, [observation("US_SP500", "fallback", request.now)], request.indexIds));
    const service = new MarketSnapshotService({
      providers: [hanging, fallback],
      now: () => START,
      providerCallTimeoutMs: 10,
      circuitFailureThreshold: 1,
    });
    const result = await service.snapshot({ targetId: "US_SP500" });
    expect(result.observations[0]!.provider.id).toBe("fallback");
    expect(result.providerAttempts[0]).toMatchObject({ providerId: "hanging", status: "timed_out" });
  });

  it("rejects malformed provider observations and uses a complete fallback row", async () => {
    const malformed = provider("malformed", ["US_SP500"], async (request) => {
      const candidate = observation("US_SP500", "malformed", request.now);
      return batch("malformed", request.now, [{ ...candidate, changePercent: 99 }], request.indexIds);
    });
    const fallback = provider("fallback", ["US_SP500"], async (request) =>
      batch("fallback", request.now, [observation("US_SP500", "fallback", request.now)], request.indexIds));
    const result = await new MarketSnapshotService({ providers: [malformed, fallback], now: () => START })
      .snapshot({ targetId: "US_SP500" });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.provider.id).toBe("fallback");
    expect(result.providerAttempts).toEqual([
      { providerId: "malformed", status: "failed", requested: 1, accepted: 0 },
      { providerId: "fallback", status: "complete", requested: 1, accepted: 1 },
    ]);
  });

  it("rejects unbounded or ambiguous provider inventories and unknown runtime targets", async () => {
    const read = async (request: MarketProviderRequest): Promise<MarketProviderBatch> =>
      batch("valid", request.now, [], request.indexIds);
    expect(() => new MarketSnapshotService({ providers: [] })).toThrow(TypeError);
    const valid = provider("valid", ["US_SP500"], read);
    expect(() => new MarketSnapshotService({ providers: [valid, valid] })).toThrow(TypeError);
    const tooMany = Array.from({ length: 5 }, (_, index) => provider(`provider-${index}`, ["US_SP500"], read));
    expect(() => new MarketSnapshotService({ providers: tooMany })).toThrow(TypeError);
    await expect(new MarketSnapshotService({ providers: [valid], now: () => START }).snapshot({
      targetId: "world" as never,
    })).rejects.toThrow(TypeError);
  });
});
