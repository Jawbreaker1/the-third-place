import { describe, expect, it, vi } from "vitest";
import {
  MARKET_BASKET_CATALOG,
  MARKET_INDEX_CATALOG,
  type MarketIndexId,
} from "./marketData/catalog.js";
import { classifyMarketFreshness, marketObservationAgeMs } from "./marketData/freshness.js";
import type { MarketObservation, MarketSnapshot } from "./marketData/types.js";
import {
  MARKET_WIRE_INDEX_IDS,
  MARKET_WIRE_SCHEDULE,
  MARKET_WIRE_TARGET_ID,
  MarketWireAdapter,
  marketWireCardFingerprint,
  marketWireCardFromSnapshot,
  marketWireSnapshotFromMarketSnapshot,
} from "./marketWire.js";

const NOW = Date.parse("2026-07-20T13:35:00.000Z");

const observation = (
  indexId: MarketIndexId,
  options: {
    checkedAt?: number;
    observedAt?: number;
    level?: number;
    previousClose?: number;
    freshness?: MarketObservation["freshness"]["status"];
    sourceUrl?: string;
    providerId?: string;
  } = {},
): MarketObservation => {
  const checkedAt = options.checkedAt ?? NOW;
  const observedAt = options.observedAt ?? checkedAt - 60_000;
  const level = options.level ?? 2_020;
  const previousClose = options.previousClose ?? 2_000;
  const change = level - previousClose;
  const definition = MARKET_INDEX_CATALOG[indexId];
  return {
    indexId,
    displayName: definition.displayName,
    shortName: definition.shortName,
    region: definition.region,
    countryCode: definition.countryCode,
    exchangeTimeZone: definition.exchangeTimeZone,
    tradingDate: "2026-07-20",
    currency: definition.currency,
    level,
    previousClose,
    change,
    changePercent: change / previousClose * 100,
    changeBasis: "previous_close",
    freshness: {
      status: options.freshness ?? classifyMarketFreshness(observedAt, checkedAt),
      observedAt: new Date(observedAt).toISOString(),
      ageMs: marketObservationAgeMs(observedAt, checkedAt),
    },
    provider: {
      id: options.providerId ?? "trusted-market-provider",
      experimental: true,
      sourceUrl: options.sourceUrl ?? `https://example.com/markets/${indexId}`,
      retrievedAt: new Date(checkedAt).toISOString(),
    },
  };
};

const marketSnapshot = (
  observations: readonly MarketObservation[],
  checkedAt = NOW,
  overrides: Partial<MarketSnapshot> = {},
): MarketSnapshot => {
  const available = observations.length;
  return {
    targetId: MARKET_WIRE_TARGET_ID,
    targetKind: "basket",
    retrievedAt: new Date(checkedAt).toISOString(),
    requestedIndexIds: MARKET_WIRE_INDEX_IDS,
    observations,
    missingIndexIds: MARKET_WIRE_INDEX_IDS.filter(
      (indexId) => !observations.some((candidate) => candidate.indexId === indexId),
    ),
    coverage: {
      requested: MARKET_WIRE_INDEX_IDS.length,
      available,
      ratio: available / MARKET_WIRE_INDEX_IDS.length,
      complete: available === MARKET_WIRE_INDEX_IDS.length,
      recent: observations.filter((item) => item.freshness.status === "recent").length,
      previousSession: observations.filter((item) => item.freshness.status === "previous_session").length,
      stale: observations.filter((item) => item.freshness.status === "stale").length,
    },
    providerAttempts: [],
    ...overrides,
  };
};

describe("MarketWire typed adapter", () => {
  it("owns one fixed six-index cross-region basket headed by OMXS30", () => {
    expect(MARKET_WIRE_INDEX_IDS).toEqual([
      "SE_OMXS30",
      "EU_STOXX50",
      "US_SP500",
      "US_NASDAQ_COMPOSITE",
      "JP_NIKKEI225",
      "HK_HSI",
    ]);
    expect(MARKET_BASKET_CATALOG.COMMUNITY_MAJOR.indexIds).toEqual(MARKET_WIRE_INDEX_IDS);
    expect(new Set(MARKET_WIRE_INDEX_IDS.map((id) => MARKET_INDEX_CATALOG[id].region))).toEqual(
      new Set(["europe", "americas", "asia_pacific"]),
    );
    expect(MARKET_WIRE_SCHEDULE).toEqual({
      activeEveryMs: 5 * 60_000,
      idleEveryMs: 30 * 60_000,
      activityWindowMs: 15 * 60_000,
    });
  });

  it("preserves validated row values, session metadata and per-row attribution in catalog order", () => {
    const sourceRows = [...MARKET_WIRE_INDEX_IDS].reverse().map((indexId, index) =>
      observation(indexId, {
        level: 1_000 + index * 25,
        previousClose: 990 + index * 25,
        observedAt: NOW - (index + 1) * 60_000,
        sourceUrl: `https://example.com/markets/${indexId}`,
      }));
    const result = marketWireSnapshotFromMarketSnapshot(marketSnapshot(sourceRows));

    expect(result).toMatchObject({
      kind: "market_wire_v1",
      feedId: "market-wire",
      channelId: "stock-market",
      targetId: "COMMUNITY_MAJOR",
      checkedAt: new Date(NOW).toISOString(),
      status: "complete",
      coverage: { requested: 6, available: 6, complete: true, missingIndexIds: [] },
    });
    expect(result?.rows.map((row) => row.indexId)).toEqual(MARKET_WIRE_INDEX_IDS);
    expect(result?.rows[0]).toMatchObject({
      indexId: "SE_OMXS30",
      unit: "index_points",
      changeBasis: "previous_close",
      observedAt: expect.any(String),
      tradingDate: "2026-07-20",
      exchangeTimeZone: "Europe/Stockholm",
      freshness: "recent",
      source: {
        id: "trusted-market-provider",
        label: "trusted-market-provider",
        experimental: true,
        url: "https://example.com/markets/SE_OMXS30",
        retrievedAt: new Date(NOW).toISOString(),
      },
    });
  });

  it("gives the production experimental provider a human-readable source label", () => {
    const result = marketWireSnapshotFromMarketSnapshot(marketSnapshot([
      observation("SE_OMXS30", { providerId: "yahoo-chart-experimental" }),
    ]));
    expect(result?.rows[0]?.source).toMatchObject({
      id: "yahoo-chart-experimental",
      label: "Yahoo Finance",
      experimental: true,
    });
  });

  it("hides stale and invalid rows while making resulting partial coverage explicit", () => {
    const recent = observation("SE_OMXS30");
    const previousSession = observation("EU_STOXX50", {
      observedAt: NOW - 3 * 60 * 60_000,
    });
    const stale = observation("US_SP500", {
      observedAt: NOW - 5 * 24 * 60 * 60_000,
    });
    const untrusted = {
      ...observation("US_NASDAQ_COMPOSITE"),
      changePercent: 99,
    } satisfies MarketObservation;
    const result = marketWireSnapshotFromMarketSnapshot(
      marketSnapshot([recent, previousSession, stale, untrusted]),
    );

    expect(result?.status).toBe("partial");
    expect(result?.rows.map((row) => [row.indexId, row.freshness])).toEqual([
      ["SE_OMXS30", "recent"],
      ["EU_STOXX50", "previous_session"],
    ]);
    expect(result?.coverage).toEqual({
      requested: 6,
      available: 2,
      complete: false,
      requestedIndexIds: MARKET_WIRE_INDEX_IDS,
      missingIndexIds: [
        "US_SP500",
        "US_NASDAQ_COMPOSITE",
        "JP_NIKKEI225",
        "HK_HSI",
      ],
    });
  });

  it("fails closed on a wrong target inventory or unsafe per-row source", () => {
    expect(marketWireSnapshotFromMarketSnapshot(marketSnapshot([], NOW, {
      targetId: "GLOBAL_MAJOR",
    }))).toBeUndefined();
    expect(marketWireSnapshotFromMarketSnapshot(marketSnapshot([], NOW, {
      requestedIndexIds: MARKET_WIRE_INDEX_IDS.slice(0, 5),
    }))).toBeUndefined();

    const unsafe = marketWireSnapshotFromMarketSnapshot(marketSnapshot([
      observation("SE_OMXS30", { sourceUrl: "http://example.com/market" }),
    ]));
    expect(unsafe?.status).toBe("unavailable");
    expect(unsafe?.rows).toEqual([]);
    expect(unsafe?.coverage.missingIndexIds).toEqual(MARKET_WIRE_INDEX_IDS);
  });

  it("uses a stable fingerprint which ignores check and provider retrieval times", () => {
    const firstObservation = observation("SE_OMXS30", {
      checkedAt: NOW,
      observedAt: NOW - 5 * 60_000,
    });
    const later = NOW + 60_000;
    const secondObservation = observation("SE_OMXS30", {
      checkedAt: later,
      observedAt: NOW - 5 * 60_000,
    });
    const first = marketWireSnapshotFromMarketSnapshot(marketSnapshot([firstObservation], NOW));
    const second = marketWireSnapshotFromMarketSnapshot(marketSnapshot([secondObservation], later));
    const changedObservation = observation("SE_OMXS30", {
      checkedAt: later,
      observedAt: NOW - 5 * 60_000,
      level: 2_030,
    });
    const changed = marketWireSnapshotFromMarketSnapshot(marketSnapshot([changedObservation], later));

    expect(first?.checkedAt).not.toBe(second?.checkedAt);
    expect(first?.rows[0]?.source.retrievedAt).not.toBe(second?.rows[0]?.source.retrievedAt);
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(changed?.fingerprint).not.toBe(second?.fingerprint);
    expect(marketWireCardFingerprint(marketWireCardFromSnapshot(first!))).toBe(
      marketWireCardFingerprint(marketWireCardFromSnapshot(second!)),
    );
  });

  it("builds a deterministic BOT card which never claims data is live or shares one trading day", () => {
    const snapshot = marketWireSnapshotFromMarketSnapshot(marketSnapshot([
      observation("SE_OMXS30"),
      observation("US_SP500", { observedAt: NOW - 3 * 60 * 60_000 }),
    ]));
    expect(snapshot).toBeDefined();
    const card = marketWireCardFromSnapshot(snapshot!);
    expect(card).toMatchObject({
      id: "market-wire",
      kind: "market_ticker",
      publisher: { id: "bot-market-wire", name: "MarketWire", badge: "BOT" },
      title: "Latest reported markets",
      state: "partial",
      targetId: "COMMUNITY_MAJOR",
      coverage: { requested: 6, available: 2, ratio: 2 / 6, complete: false },
    });
    expect(JSON.stringify(card)).not.toMatch(/\blive\b|\btoday\b/iu);
    expect(card.observations).toHaveLength(2);
    expect(card.observations.every((row) => row.changeBasis === "previous_close")).toBe(true);
  });

  it("polls only the server-owned basket, bypasses short direct-turn cache and reports unchanged snapshots", async () => {
    const first = marketSnapshot([observation("SE_OMXS30")]);
    const provider = { snapshot: vi.fn(async () => first) };
    const adapter = new MarketWireAdapter(provider);
    const published = await adapter.poll({ now: NOW, signal: new AbortController().signal });
    expect(provider.snapshot).toHaveBeenCalledWith({
      targetId: "COMMUNITY_MAJOR",
      cachePolicy: "bypass",
    });
    expect(published.kind).toBe("updated");
    const previous = published.kind === "updated" ? published.card : undefined;
    const unchanged = await adapter.poll({
      now: NOW,
      previous,
      signal: new AbortController().signal,
    });
    expect(unchanged.kind).toBe("unchanged");
  });

  it("returns typed unavailable outcomes for provider failure, invalid envelopes and empty current coverage", async () => {
    const providerFailure = new MarketWireAdapter({
      snapshot: vi.fn(async () => { throw new Error("offline"); }),
    });
    await expect(providerFailure.poll({
      now: NOW,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: "unavailable",
      card: { state: "unavailable", observations: [] },
    });

    const invalid = new MarketWireAdapter({
      snapshot: vi.fn(async () => marketSnapshot([], NOW, { targetId: "GLOBAL_MAJOR" })),
    });
    await expect(invalid.poll({
      now: NOW,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: "unavailable",
      card: { state: "unavailable", observations: [] },
    });

    const noRows = new MarketWireAdapter({ snapshot: vi.fn(async () => marketSnapshot([])) });
    await expect(noRows.poll({
      now: NOW,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: "unavailable",
      card: { state: "unavailable", observations: [] },
    });
  });

  it("retains a bounded last-good row during an outage but removes it once stale", async () => {
    const goodSnapshot = marketWireSnapshotFromMarketSnapshot(marketSnapshot([
      observation("SE_OMXS30"),
    ]));
    const previous = marketWireCardFromSnapshot(goodSnapshot!);
    const adapter = new MarketWireAdapter({
      snapshot: vi.fn(async () => { throw new Error("offline"); }),
    });

    const previousSession = await adapter.poll({
      now: NOW + 3 * 60 * 60_000,
      previous,
      signal: new AbortController().signal,
    });
    expect(previousSession).toMatchObject({
      kind: "unavailable",
      card: {
        state: "unavailable",
        retrievedAt: new Date(NOW).toISOString(),
        observations: [{ indexId: "SE_OMXS30", freshness: "previous_session" }],
      },
    });

    const stale = await adapter.poll({
      now: NOW + 5 * 24 * 60 * 60_000,
      previous,
      signal: new AbortController().signal,
    });
    expect(stale).toMatchObject({
      kind: "unavailable",
      card: { state: "unavailable", observations: [] },
    });
    if (stale.kind === "unavailable") expect(stale.card).not.toHaveProperty("retrievedAt");
  });

  it("reclassifies a persisted card before exposing it after restart", () => {
    const snapshot = marketWireSnapshotFromMarketSnapshot(marketSnapshot([
      observation("SE_OMXS30"),
    ]));
    const previous = marketWireCardFromSnapshot(snapshot!);
    previous.revision = 9;
    const adapter = new MarketWireAdapter({ snapshot: vi.fn() });

    expect(adapter.restorePersistedCard(previous, NOW + 3 * 60 * 60_000)).toMatchObject({
      revision: 9,
      state: "unavailable",
      observations: [{ indexId: "SE_OMXS30", freshness: "previous_session" }],
    });
    const stale = adapter.restorePersistedCard(previous, NOW + 5 * 24 * 60 * 60_000);
    expect(stale).toMatchObject({ state: "unavailable", observations: [] });
    expect(stale).not.toHaveProperty("retrievedAt");
  });
});
