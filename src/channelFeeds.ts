import type {
  ChannelFeedCard,
  MarketTickerFeedCard,
  MarketTickerFeedObservation,
} from "../shared/types";

const MAX_CLIENT_FEEDS = 32;

/** Revision-aware reducer used by the socket transport and covered separately
 * from chat messages so a feed refresh can never create unread state. */
export const upsertChannelFeed = (
  current: readonly ChannelFeedCard[],
  incoming: ChannelFeedCard,
): ChannelFeedCard[] => {
  const existing = current.find((card) => card.id === incoming.id);
  if (existing && existing.revision >= incoming.revision) return current as ChannelFeedCard[];
  return [...current.filter((card) => card.id !== incoming.id), incoming]
    .sort((left, right) => left.channelId.localeCompare(right.channelId) || left.id.localeCompare(right.id))
    .slice(-MAX_CLIENT_FEEDS);
};

export const channelFeedsFor = (
  cards: readonly ChannelFeedCard[],
  channelId: string,
): ChannelFeedCard[] => cards.filter((card) => card.channelId === channelId);

const compactNumber = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const signedPercent = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  signDisplay: "always",
  style: "percent",
});

export const formatMarketLevel = (observation: MarketTickerFeedObservation): string =>
  compactNumber.format(observation.level);

export const formatMarketChangePercent = (observation: MarketTickerFeedObservation): string =>
  signedPercent.format(observation.changePercent / 100);

export const marketDirection = (
  observation: MarketTickerFeedObservation,
): "up" | "down" | "flat" => observation.changePercent > 0
  ? "up"
  : observation.changePercent < 0
    ? "down"
    : "flat";

const safeDate = (value: string): Date | undefined => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

export const formatMarketObservationTime = (observation: MarketTickerFeedObservation): string => {
  if (observation.freshness === "previous_session") return `last session · ${observation.tradingDate}`;
  if (observation.freshness === "stale") return `stale · ${observation.tradingDate}`;
  const date = safeDate(observation.observedAt);
  return date
    ? `reported ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)}`
    : `reported ${observation.tradingDate}`;
};

export const marketCardStatus = (card: MarketTickerFeedCard): string => {
  if (card.state === "unavailable") return card.observations.length > 0
    ? "Refresh delayed · showing the last validated report"
    : "Market source temporarily unavailable";
  if (card.state === "partial") {
    return `${card.coverage.available} of ${card.coverage.requested} indexes reported`;
  }
  return `${card.coverage.available} indexes reported`;
};
