import { createHash } from "node:crypto";
import type {
  ChannelFeedPublisher,
  ChannelFeedSource,
  MarketTickerFeedCard,
} from "../shared/types.js";
import type {
  ChannelFeedAdapter,
  ChannelFeedPollContext,
  ChannelFeedPollResult,
} from "./channelFeeds.js";
import {
  MARKET_BASKET_CATALOG,
  MARKET_INDEX_CATALOG,
  type MarketIndexId,
} from "./marketData/catalog.js";
import { classifyMarketFreshness, marketObservationAgeMs } from "./marketData/freshness.js";
import type { MarketSnapshotService } from "./marketData/service.js";
import type { MarketObservation, MarketSnapshot } from "./marketData/types.js";
import { YAHOO_CHART_PROVIDER_ID } from "./marketData/providers/yahooChart.js";

const MINUTE_MS = 60_000;

export const MARKET_WIRE_FEED_ID = "market-wire" as const;
export const MARKET_WIRE_CHANNEL_ID = "stock-market" as const;
export const MARKET_WIRE_TARGET_ID = "COMMUNITY_MAJOR" as const;
export const MARKET_WIRE_ACTOR = Object.freeze({
  id: "bot-market-wire",
  name: "MarketWire",
  badge: "BOT" as const,
  avatar: Object.freeze({ color: "#3f8f87", accent: "#9fe0cf", glyph: "MW" }),
}) satisfies ChannelFeedPublisher;
export const MARKET_WIRE_SCHEDULE = Object.freeze({
  activeEveryMs: 5 * MINUTE_MS,
  idleEveryMs: 30 * MINUTE_MS,
  activityWindowMs: 15 * MINUTE_MS,
});

export const MARKET_WIRE_INDEX_IDS = Object.freeze([
  ...MARKET_BASKET_CATALOG[MARKET_WIRE_TARGET_ID].indexIds,
]) as readonly MarketIndexId[];

const marketWireIndexIdSet = new Set<MarketIndexId>(MARKET_WIRE_INDEX_IDS);

export type MarketWireSnapshotProvider = Pick<MarketSnapshotService, "snapshot">;
export type MarketWireVisibleFreshness = Exclude<MarketObservation["freshness"]["status"], "stale">;

export type MarketWireSource = ChannelFeedSource;

export interface MarketWireRow {
  indexId: MarketIndexId;
  displayName: string;
  shortName: string;
  region: MarketObservation["region"];
  countryCode: string;
  currency: string;
  level: number;
  unit: "index_points";
  previousClose: number;
  change: number;
  changePercent: number;
  changeBasis: "previous_close";
  observedAt: string;
  tradingDate: string;
  exchangeTimeZone: string;
  freshness: MarketWireVisibleFreshness;
  source: MarketWireSource;
}

export interface MarketWireCoverage {
  requested: number;
  available: number;
  complete: boolean;
  requestedIndexIds: readonly MarketIndexId[];
  missingIndexIds: readonly MarketIndexId[];
}

export interface MarketWireSnapshotV1 {
  kind: "market_wire_v1";
  feedId: typeof MARKET_WIRE_FEED_ID;
  channelId: typeof MARKET_WIRE_CHANNEL_ID;
  targetId: typeof MARKET_WIRE_TARGET_ID;
  checkedAt: string;
  status: "complete" | "partial" | "unavailable";
  coverage: MarketWireCoverage;
  rows: readonly MarketWireRow[];
  fingerprint: string;
}

export type MarketWireCardV1 = MarketTickerFeedCard;

const exactInventory = (actual: readonly MarketIndexId[]): boolean =>
  actual.length === MARKET_WIRE_INDEX_IDS.length &&
  actual.every((id, index) => id === MARKET_WIRE_INDEX_IDS[index]);

const safeInstant = (value: string): number | undefined => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const safeSourceUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
};

const finite = (value: number): boolean => Number.isFinite(value);

const trustedVisibleObservation = (
  observation: MarketObservation,
  checkedAtMs: number,
): boolean => {
  if (!marketWireIndexIdSet.has(observation.indexId) || observation.freshness.status === "stale") return false;
  const definition = MARKET_INDEX_CATALOG[observation.indexId];
  if (
    observation.displayName !== definition.displayName ||
    observation.shortName !== definition.shortName ||
    observation.region !== definition.region ||
    observation.countryCode !== definition.countryCode ||
    observation.exchangeTimeZone !== definition.exchangeTimeZone ||
    observation.currency !== definition.currency ||
    observation.changeBasis !== "previous_close" ||
    !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(observation.provider.id) ||
    typeof observation.provider.experimental !== "boolean" ||
    !safeSourceUrl(observation.provider.sourceUrl) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(observation.tradingDate)
  ) return false;
  if (
    !finite(observation.level) || observation.level <= 0 || observation.level > 1_000_000_000 ||
    !finite(observation.previousClose) || observation.previousClose <= 0 || observation.previousClose > 1_000_000_000 ||
    !finite(observation.change) ||
    !finite(observation.changePercent) || Math.abs(observation.changePercent) > 100
  ) return false;

  const observedAtMs = safeInstant(observation.freshness.observedAt);
  const retrievedAtMs = safeInstant(observation.provider.retrievedAt);
  if (
    observedAtMs === undefined ||
    retrievedAtMs === undefined ||
    observedAtMs > checkedAtMs + 5 * MINUTE_MS ||
    observedAtMs < checkedAtMs - 14 * 24 * 60 * MINUTE_MS ||
    Math.abs(retrievedAtMs - checkedAtMs) > 5 * MINUTE_MS
  ) return false;

  const expectedChange = observation.level - observation.previousClose;
  const expectedPercent = expectedChange / observation.previousClose * 100;
  const numericTolerance = Math.max(1e-8, Math.abs(expectedChange) * 1e-8);
  const percentTolerance = Math.max(1e-8, Math.abs(expectedPercent) * 1e-8);
  if (
    Math.abs(observation.change - expectedChange) > numericTolerance ||
    Math.abs(observation.changePercent - expectedPercent) > percentTolerance
  ) return false;

  return observation.freshness.ageMs === marketObservationAgeMs(observedAtMs, checkedAtMs) &&
    observation.freshness.status === classifyMarketFreshness(observedAtMs, checkedAtMs);
};

const rowFromObservation = (observation: MarketObservation): MarketWireRow => ({
  indexId: observation.indexId,
  displayName: observation.displayName,
  shortName: observation.shortName,
  region: observation.region,
  countryCode: observation.countryCode,
  currency: observation.currency,
  level: observation.level,
  unit: "index_points",
  previousClose: observation.previousClose,
  change: observation.change,
  changePercent: observation.changePercent,
  changeBasis: "previous_close",
  observedAt: observation.freshness.observedAt,
  tradingDate: observation.tradingDate,
  exchangeTimeZone: observation.exchangeTimeZone,
  freshness: observation.freshness.status as MarketWireVisibleFreshness,
  source: {
    id: observation.provider.id,
    label: observation.provider.id === YAHOO_CHART_PROVIDER_ID
      ? "Yahoo Finance"
      : observation.provider.id,
    experimental: observation.provider.experimental,
    url: observation.provider.sourceUrl,
    retrievedAt: observation.provider.retrievedAt,
  },
});

const marketWireFingerprint = (
  status: MarketWireSnapshotV1["status"],
  rows: readonly MarketWireRow[],
  missingIndexIds: readonly MarketIndexId[],
): string => {
  const stableRows = rows.map((row) => ({
    ...row,
    source: {
      id: row.source.id,
      label: row.source.label,
      experimental: row.source.experimental,
      url: row.source.url,
    },
  }));
  const hash = createHash("sha256")
    .update(JSON.stringify({ status, rows: stableRows, missingIndexIds }))
    .digest("hex")
    .slice(0, 32);
  return `market-wire:${hash}`;
};

/**
 * Narrows only the already validated market service contract into the public
 * MarketWire payload. Stale or structurally inconsistent rows fail closed and
 * become explicit missing coverage; no model participates in this mapping.
 */
export const marketWireSnapshotFromMarketSnapshot = (
  snapshot: MarketSnapshot,
): MarketWireSnapshotV1 | undefined => {
  if (
    snapshot.targetId !== MARKET_WIRE_TARGET_ID ||
    snapshot.targetKind !== "basket" ||
    !exactInventory(snapshot.requestedIndexIds)
  ) return undefined;
  const checkedAtMs = safeInstant(snapshot.retrievedAt);
  if (checkedAtMs === undefined) return undefined;

  const observationsById = new Map<MarketIndexId, MarketObservation>();
  for (const observation of snapshot.observations) {
    if (
      observationsById.has(observation.indexId) ||
      !trustedVisibleObservation(observation, checkedAtMs)
    ) continue;
    observationsById.set(observation.indexId, observation);
  }
  const rows = MARKET_WIRE_INDEX_IDS.flatMap((indexId) => {
    const observation = observationsById.get(indexId);
    return observation ? [rowFromObservation(observation)] : [];
  });
  const missingIndexIds = MARKET_WIRE_INDEX_IDS.filter((indexId) => !observationsById.has(indexId));
  const status: MarketWireSnapshotV1["status"] = rows.length === 0
    ? "unavailable"
    : missingIndexIds.length > 0
      ? "partial"
      : "complete";
  const coverage: MarketWireCoverage = {
    requested: MARKET_WIRE_INDEX_IDS.length,
    available: rows.length,
    complete: status === "complete",
    requestedIndexIds: MARKET_WIRE_INDEX_IDS,
    missingIndexIds,
  };
  return {
    kind: "market_wire_v1",
    feedId: MARKET_WIRE_FEED_ID,
    channelId: MARKET_WIRE_CHANNEL_ID,
    targetId: MARKET_WIRE_TARGET_ID,
    checkedAt: new Date(checkedAtMs).toISOString(),
    status,
    coverage,
    rows,
    fingerprint: marketWireFingerprint(status, rows, missingIndexIds),
  };
};

export const marketWireCardFromSnapshot = (
  snapshot: MarketWireSnapshotV1,
): MarketWireCardV1 => ({
  id: MARKET_WIRE_FEED_ID,
  kind: "market_ticker",
  channelId: MARKET_WIRE_CHANNEL_ID,
  publisher: MARKET_WIRE_ACTOR,
  revision: 0,
  title: "Latest reported markets",
  targetId: MARKET_WIRE_TARGET_ID,
  updatedAt: snapshot.checkedAt,
  ...(snapshot.rows.length > 0 ? { retrievedAt: snapshot.checkedAt } : {}),
  state: snapshot.status === "complete"
    ? "ready"
    : snapshot.status,
  requestedIndexIds: [...snapshot.coverage.requestedIndexIds],
  missingIndexIds: [...snapshot.coverage.missingIndexIds],
  coverage: {
    requested: snapshot.coverage.requested,
    available: snapshot.coverage.available,
    ratio: snapshot.coverage.requested > 0
      ? snapshot.coverage.available / snapshot.coverage.requested
      : 0,
    complete: snapshot.coverage.complete,
  },
  observations: snapshot.rows.map((row) => ({
    indexId: row.indexId,
    displayName: row.displayName,
    shortName: row.shortName,
    currency: row.currency,
    level: row.level,
    previousClose: row.previousClose,
    change: row.change,
    changePercent: row.changePercent,
    changeBasis: row.changeBasis,
    tradingDate: row.tradingDate,
    observedAt: row.observedAt,
    freshness: row.freshness,
    source: row.source,
  })),
});

export const marketWireCardFingerprint = (card: MarketTickerFeedCard): string => {
  const stableObservations = card.observations.map((observation) => ({
    ...observation,
    source: {
      id: observation.source.id,
      label: observation.source.label,
      url: observation.source.url,
      experimental: observation.source.experimental,
    },
  }));
  return `market-wire-card:${createHash("sha256")
    .update(JSON.stringify({
      id: card.id,
      kind: card.kind,
      channelId: card.channelId,
      state: card.state,
      title: card.title,
      targetId: card.targetId,
      requestedIndexIds: card.requestedIndexIds,
      missingIndexIds: card.missingIndexIds,
      coverage: card.coverage,
      observations: stableObservations,
    }))
    .digest("hex")
    .slice(0, 32)}`;
};

const unavailableSnapshot = (checkedAtMs: number): MarketWireSnapshotV1 => {
  const missingIndexIds = [...MARKET_WIRE_INDEX_IDS];
  const coverage: MarketWireCoverage = {
    requested: MARKET_WIRE_INDEX_IDS.length,
    available: 0,
    complete: false,
    requestedIndexIds: MARKET_WIRE_INDEX_IDS,
    missingIndexIds,
  };
  return {
    kind: "market_wire_v1",
    feedId: MARKET_WIRE_FEED_ID,
    channelId: MARKET_WIRE_CHANNEL_ID,
    targetId: MARKET_WIRE_TARGET_ID,
    checkedAt: new Date(checkedAtMs).toISOString(),
    status: "unavailable",
    coverage,
    rows: [],
    fingerprint: marketWireFingerprint("unavailable", [], missingIndexIds),
  };
};

const unavailableCard = (
  now: number,
  previous?: MarketTickerFeedCard,
): MarketTickerFeedCard => {
  const checkedAt = new Date(now).toISOString();
  if (!previous || previous.id !== MARKET_WIRE_FEED_ID || previous.kind !== "market_ticker") {
    return marketWireCardFromSnapshot(unavailableSnapshot(now));
  }
  const observations = previous.observations.flatMap((observation) => {
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt)) return [];
    const freshness = classifyMarketFreshness(observedAt, now);
    return freshness === "stale" ? [] : [{ ...observation, freshness }];
  });
  const availableIds = new Set(observations.map((observation) => observation.indexId));
  const missingIndexIds = MARKET_WIRE_INDEX_IDS.filter((indexId) => !availableIds.has(indexId));
  const { retrievedAt: previousRetrievedAt, ...previousWithoutRetrievedAt } = previous;
  return {
    ...previousWithoutRetrievedAt,
    revision: 0,
    state: "unavailable",
    updatedAt: checkedAt,
    ...(observations.length > 0 && previousRetrievedAt ? { retrievedAt: previousRetrievedAt } : {}),
    requestedIndexIds: [...MARKET_WIRE_INDEX_IDS],
    missingIndexIds,
    coverage: {
      requested: MARKET_WIRE_INDEX_IDS.length,
      available: observations.length,
      ratio: observations.length / MARKET_WIRE_INDEX_IDS.length,
      complete: observations.length === MARKET_WIRE_INDEX_IDS.length,
    },
    observations,
  };
};

export class MarketWireAdapter implements ChannelFeedAdapter<MarketTickerFeedCard> {
  readonly id = MARKET_WIRE_FEED_ID;
  readonly channelId = MARKET_WIRE_CHANNEL_ID;
  readonly metadata = Object.freeze({
    kind: "market_ticker",
    label: "MarketWire",
    description: "Validated major-market index snapshots for the stock-market room.",
    publisher: Object.freeze({
      id: MARKET_WIRE_ACTOR.id,
      name: MARKET_WIRE_ACTOR.name,
      badge: MARKET_WIRE_ACTOR.badge,
    }),
    defaultEnabled: true,
    defaultDiscussionFrequency: 50,
  });
  activeIntervalMs = MARKET_WIRE_SCHEDULE.activeEveryMs;
  idleIntervalMs = MARKET_WIRE_SCHEDULE.idleEveryMs;
  activityWindowMs = MARKET_WIRE_SCHEDULE.activityWindowMs;
  minAttemptGapMs = MARKET_WIRE_SCHEDULE.activeEveryMs;
  pollTimeoutMs = 18_000;

  constructor(private readonly provider: MarketWireSnapshotProvider) {}

  /**
   * A stored successful snapshot proves what was retrieved then, not what is
   * current after a restart. Reclassify every row against the new clock and
   * expose it only as a visibly delayed last report until polling succeeds.
   */
  restorePersistedCard(card: MarketTickerFeedCard, now: number): MarketTickerFeedCard {
    return { ...unavailableCard(now, card), revision: card.revision };
  }

  async poll(
    context: ChannelFeedPollContext<MarketTickerFeedCard>,
  ): Promise<ChannelFeedPollResult<MarketTickerFeedCard>> {
    if (context.signal.aborted) {
      return { kind: "unavailable", card: unavailableCard(context.now, context.previous) };
    }
    let raw: MarketSnapshot;
    try {
      raw = await this.provider.snapshot({ targetId: MARKET_WIRE_TARGET_ID, cachePolicy: "bypass" });
    } catch {
      return { kind: "unavailable", card: unavailableCard(context.now, context.previous) };
    }
    if (context.signal.aborted) {
      return { kind: "unavailable", card: unavailableCard(context.now, context.previous) };
    }
    const snapshot = marketWireSnapshotFromMarketSnapshot(raw);
    if (!snapshot) {
      return { kind: "unavailable", card: unavailableCard(context.now, context.previous) };
    }
    if (snapshot.status === "unavailable") {
      return { kind: "unavailable", card: unavailableCard(context.now, context.previous) };
    }
    const card = marketWireCardFromSnapshot(snapshot);
    return context.previous &&
      marketWireCardFingerprint(context.previous) === marketWireCardFingerprint(card)
      ? { kind: "unchanged" }
      : { kind: "updated", card };
  }

  present(snapshot: MarketWireSnapshotV1): MarketWireCardV1 {
    return marketWireCardFromSnapshot(snapshot);
  }
}
