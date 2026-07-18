import { describe, expect, it } from "vitest";
import type { MarketTickerFeedCard } from "../shared/types";
import {
  formatMarketChangePercent,
  formatMarketLevel,
  formatMarketObservationTime,
  marketCardStatus,
  marketDirection,
  upsertChannelFeed,
} from "./channelFeeds";

const card = (revision: number, state: MarketTickerFeedCard["state"] = "ready"): MarketTickerFeedCard => ({
  id: "market-wire",
  kind: "market_ticker",
  channelId: "stock-market",
  publisher: {
    id: "bot-market-wire",
    name: "MarketWire",
    badge: "BOT",
    avatar: { color: "#123456", accent: "#abcdef", glyph: "MW" },
  },
  revision,
  state,
  title: "Latest reported markets",
  targetId: "COMMUNITY_MAJOR",
  updatedAt: "2026-07-19T13:05:00.000Z",
  retrievedAt: "2026-07-19T13:04:00.000Z",
  requestedIndexIds: ["SE_OMXS30"],
  missingIndexIds: [],
  coverage: { requested: 1, available: 1, ratio: 1, complete: true },
  observations: [{
    indexId: "SE_OMXS30",
    displayName: "OMX Stockholm 30",
    shortName: "OMXS30",
    currency: "SEK",
    level: 2681.42,
    previousClose: 2664.9,
    change: 16.52,
    changePercent: 0.62,
    changeBasis: "previous_close",
    tradingDate: "2026-07-19",
    observedAt: "2026-07-19T13:00:00.000Z",
    freshness: "recent",
    source: {
      id: "yahoo-chart",
      label: "Yahoo Finance",
      url: "https://finance.yahoo.com/quote/%5EOMX/",
      retrievedAt: "2026-07-19T13:04:00.000Z",
      experimental: true,
    },
  }],
});

describe("channel feed client reducer", () => {
  it("accepts only a newer revision and never manufactures chat state", () => {
    const first = [card(2)];
    expect(upsertChannelFeed(first, card(1))).toBe(first);
    expect(upsertChannelFeed(first, card(2))).toBe(first);
    expect(upsertChannelFeed(first, card(3))[0]?.revision).toBe(3);
  });

  it("formats index points rather than currency and preserves direction", () => {
    const observation = card(1).observations[0]!;
    expect(formatMarketLevel(observation)).toContain("2");
    expect(formatMarketLevel(observation)).not.toContain("SEK");
    expect(formatMarketChangePercent(observation)).toContain("0.62");
    expect(marketDirection(observation)).toBe("up");
    expect(formatMarketObservationTime(observation)).toContain("reported");
  });

  it("labels partial and delayed state without presenting old values as fresh", () => {
    const partial = { ...card(1, "partial"), coverage: { requested: 6, available: 4, ratio: 4 / 6, complete: false } };
    expect(marketCardStatus(partial)).toBe("4 of 6 indexes reported");
    expect(marketCardStatus(card(2, "unavailable"))).toContain("last validated");
    expect(formatMarketObservationTime({ ...card(1).observations[0]!, freshness: "previous_session" }))
      .toContain("last session");
  });
});
