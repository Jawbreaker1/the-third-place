import { describe, expect, it } from "vitest";
import type { MarketTickerFeedCard } from "../shared/types.js";
import { residentChannelFeedFact } from "./channelFeedFacts.js";

const card = (state: MarketTickerFeedCard["state"]): MarketTickerFeedCard => ({
  id: "market-wire",
  kind: "market_ticker",
  channelId: "stock-market",
  publisher: { id: "bot-market-wire", name: "MarketWire", badge: "BOT", avatar: { color: "#111111", accent: "#eeeeee", glyph: "MW" } },
  revision: 7,
  state,
  title: "Latest reported markets",
  targetId: "COMMUNITY_MAJOR",
  updatedAt: "2026-07-19T12:01:00.000Z",
  retrievedAt: "2026-07-19T12:00:00.000Z",
  requestedIndexIds: ["SE_OMXS30"],
  missingIndexIds: [],
  coverage: { requested: 1, available: 1, ratio: 1, complete: true },
  observations: [{
    indexId: "SE_OMXS30",
    displayName: "OMX Stockholm 30",
    shortName: "OMXS30",
    currency: "SEK",
    level: 2681.4,
    previousClose: 2664.8,
    change: 16.6,
    changePercent: 0.6229,
    changeBasis: "previous_close",
    tradingDate: "2026-07-19",
    observedAt: "2026-07-19T12:00:00.000Z",
    freshness: "recent",
    source: { id: "yahoo-chart", label: "Yahoo Finance", url: "https://finance.yahoo.com/quote/%5EOMX/", retrievedAt: "2026-07-19T12:00:00.000Z", experimental: true },
  }],
});

describe("resident channel feed facts", () => {
  it("keeps typed market facts bounded and makes truthfulness limits explicit", () => {
    const fact = residentChannelFeedFact(card("ready"));
    expect(fact?.publisherName).toBe("MarketWire");
    expect(fact?.content).toContain("2681.40 index points");
    expect(fact?.content).toContain("+0.62% versus previous close");
    expect(fact?.content).not.toContain("0.6229%");
    expect(fact?.content).toContain("versus previous close");
    expect(fact?.content).toContain("not guaranteed live");
    expect(fact?.content).not.toContain("SEK 2681.4");
    expect(fact?.content.length).toBeLessThanOrEqual(2_400);
  });

  it("does not relabel retained observations as fresh after a failed refresh", () => {
    expect(residentChannelFeedFact(card("unavailable"))?.content)
      .toContain("last validated report and may be old");
  });
});
