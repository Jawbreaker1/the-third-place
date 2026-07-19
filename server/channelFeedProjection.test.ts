import { describe, expect, it } from "vitest";
import type { MarketTickerFeedCard } from "../shared/types.js";
import { projectChannelFeedFactsForRoom } from "./channelFeedProjection.js";

const NOW = Date.parse("2026-07-20T13:35:00.000Z");

const card = (
  id: string,
  channelId: string,
  revision: number,
  shortName: string,
): MarketTickerFeedCard => ({
  id,
  kind: "market_ticker",
  channelId,
  publisher: {
    id: `bot-${id}`,
    name: id === "market-wire" ? "MarketWire" : "SectorWire",
    badge: "BOT",
    avatar: { color: "#111111", accent: "#eeeeee", glyph: "W" },
  },
  revision,
  state: "ready",
  title: "Latest reported markets",
  targetId: "COMMUNITY_MAJOR",
  updatedAt: new Date(NOW).toISOString(),
  retrievedAt: new Date(NOW).toISOString(),
  requestedIndexIds: [`${id}-index`],
  missingIndexIds: [],
  coverage: { requested: 1, available: 1, ratio: 1, complete: true },
  observations: [{
    indexId: `${id}-index`,
    displayName: shortName,
    shortName,
    currency: "SEK",
    level: 2_020,
    previousClose: 2_000,
    change: 20,
    changePercent: 1,
    changeBasis: "previous_close",
    tradingDate: "2026-07-20",
    observedAt: new Date(NOW - 60_000).toISOString(),
    freshness: "recent",
    source: {
      id: `${id}-provider`,
      label: `${id} provider`,
      url: `https://example.com/${id}`,
      retrievedAt: new Date(NOW).toISOString(),
      experimental: true,
    },
  }],
});

describe("projectChannelFeedFactsForRoom", () => {
  it("projects every room-owned card with its own cue and discussion control", () => {
    const contexts = projectChannelFeedFactsForRoom([
      card("sector-wire", "stock-market", 4, "Tech 20"),
      card("market-wire", "stock-market", 9, "OMXS30"),
      card("fixture-wire", "football-talk", 2, "Fixture index"),
    ], [
      { id: "market-wire", discussionFrequency: 85 },
      { id: "sector-wire", discussionFrequency: 35 },
      { id: "fixture-wire", discussionFrequency: 100 },
    ], "stock-market");

    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => ({
      revisionKey: context.conversationCue?.revisionKey,
      frequency: context.discussionFrequency,
    }))).toEqual([
      { revisionKey: "market_ticker:market-wire:9", frequency: 85 },
      { revisionKey: "market_ticker:sector-wire:4", frequency: 35 },
    ]);
    expect(contexts[0]?.content).toContain("OMXS30");
    expect(contexts[1]?.content).toContain("Tech 20");
  });

  it("fails a missing or malformed control closed without hiding trusted facts", () => {
    const [context] = projectChannelFeedFactsForRoom(
      [card("market-wire", "stock-market", 9, "OMXS30")],
      [{ id: "market-wire", discussionFrequency: Number.NaN }],
      "stock-market",
    );
    expect(context).toMatchObject({ discussionFrequency: 0 });
    expect(context?.conversationCue?.feedId).toBe("market-wire");
  });
});
