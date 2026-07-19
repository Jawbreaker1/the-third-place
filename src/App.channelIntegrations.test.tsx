import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChannelFeedCard } from "../shared/types";
import { ChannelIntegrationsPanel } from "./App";

const marketFeed = (id: string, publisherId = id): ChannelFeedCard => ({
  id,
  kind: "market_ticker",
  channelId: "stock-market",
  publisher: {
    id: publisherId,
    name: publisherId === "market-wire" ? "MarketWire" : "Closing Bell",
    badge: "BOT",
    avatar: { color: "#173f3a", accent: "#56d5ad", glyph: "MW" },
  },
  revision: 1,
  state: "ready",
  title: "World markets",
  targetId: "global-indices",
  updatedAt: "2026-07-19T12:00:00.000Z",
  retrievedAt: "2026-07-19T12:00:00.000Z",
  requestedIndexIds: ["omx30"],
  missingIndexIds: [],
  coverage: { requested: 1, available: 1, ratio: 1, complete: true },
  observations: [{
    indexId: "omx30",
    displayName: "OMX Stockholm 30",
    shortName: "OMXS30",
    currency: "SEK",
    level: 2_742.15,
    previousClose: 2_730,
    change: 12.15,
    changePercent: 0.45,
    changeBasis: "previous_close",
    tradingDate: "2026-07-19",
    observedAt: "2026-07-19T12:00:00.000Z",
    freshness: "recent",
    source: {
      id: "source",
      label: "Market source",
      url: "https://example.com/markets",
      retrievedAt: "2026-07-19T12:00:00.000Z",
      experimental: false,
    },
  }],
});

describe("ChannelIntegrationsPanel", () => {
  it("renders nothing when the room has no integrations", () => {
    expect(renderToStaticMarkup(
      <ChannelIntegrationsPanel cards={[]} collapsed={false} onToggle={vi.fn()} />,
    )).toBe("");
  });

  it("renders multiple feed cards inside one room-level panel", () => {
    const markup = renderToStaticMarkup(
      <ChannelIntegrationsPanel
        cards={[marketFeed("market-wire", "market-wire"), marketFeed("closing-bell", "closing-bell")]}
        collapsed={false}
        onToggle={vi.fn()}
      />,
    );

    expect(markup).toContain("data-channel-integrations");
    expect(markup).toContain("2 services keep this room current");
    expect(markup).toContain('data-channel-feed-id="market-wire"');
    expect(markup).toContain('data-channel-feed-id="closing-bell"');
    expect(markup).toContain('aria-expanded="true"');
  });

  it("keeps its toolbar available while the feed cards are collapsed", () => {
    const markup = renderToStaticMarkup(
      <ChannelIntegrationsPanel cards={[marketFeed("market-wire", "market-wire")]} collapsed onToggle={vi.fn()} />,
    );

    expect(markup).toContain("Room integrations");
    expect(markup).toContain("MarketWire keeps this room current");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("data-channel-feed-id");
  });
});
