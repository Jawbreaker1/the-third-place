import type { ChannelFeedCard, MarketTickerFeedCard } from "../shared/types.js";

export interface ResidentChannelFeedFact {
  publisherName: string;
  content: string;
  updatedAt: string;
}

const finite = (value: number, fractionDigits: number): string =>
  Number.isFinite(value) ? value.toFixed(fractionDigits) : "unavailable";

const marketFact = (card: MarketTickerFeedCard): ResidentChannelFeedFact => {
  const status = card.state === "unavailable"
    ? card.observations.length > 0
      ? "The latest refresh failed; the rows below are the last validated report and may be old."
      : "The market provider is currently unavailable and supplied no validated rows."
    : card.state === "partial"
      ? `Partial coverage: ${card.coverage.available} of ${card.coverage.requested} requested indexes.`
      : `Coverage: ${card.coverage.available} of ${card.coverage.requested} requested indexes.`;
  const observations = card.observations.slice(0, 8).map((row) =>
    `${row.shortName}: ${finite(row.level, 2)} index points; ` +
    `${row.changePercent >= 0 ? "+" : ""}${finite(row.changePercent, 2)}% versus previous close; ` +
    `observed ${row.observedAt}; trading date ${row.tradingDate}; freshness ${row.freshness}; ` +
    `source ${row.source.label} (${row.source.url})${row.source.experimental ? ", experimental provider" : ""}.`,
  );
  return {
    publisherName: card.publisher.name,
    updatedAt: card.updatedAt,
    content: [
      `${card.title}. Latest reported values only; this is not guaranteed live data.`,
      status,
      ...observations,
      "Markets can have different reporting times and trading dates. Do not infer news, causes, forecasts, or whether an exchange is open from these rows.",
    ].join("\n").slice(0, 2_400),
  };
};

export const residentChannelFeedFact = (
  card: ChannelFeedCard | undefined,
): ResidentChannelFeedFact | undefined => {
  if (!card) return undefined;
  switch (card.kind) {
    case "market_ticker": return marketFact(card);
  }
};
