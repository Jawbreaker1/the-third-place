import { describe, expect, it } from "vitest";
import type { PageProviderFetcher } from "./types.js";
import { avanzaMarketPageProvider } from "./avanzaMarket.js";

describe("Avanza market page provider", () => {
  it("matches only the validated HTTPS market-overview URL shapes", () => {
    for (const raw of [
      "https://avanza.se/",
      "https://www.avanza.se/start",
      "https://www.avanza.se/borsen-idag.html",
      "https://www.avanza.se/hall-koll/borsen-idag.html",
      "https://www.avanza.se/marknadsoversikt",
    ]) {
      expect(avanzaMarketPageProvider.supports(new URL(raw)), raw).toBe(true);
    }
    for (const raw of [
      "http://www.avanza.se/",
      "https://evil.example/",
      "https://avanza.se.evil.example/",
      "https://www.avanza.se/aktier/om-aktien.html",
    ]) {
      expect(avanzaMarketPageProvider.supports(new URL(raw)), raw).toBe(false);
    }
  });

  it("decodes bounded provider fields into typed evidence under the strict JSON policy", async () => {
    const requests: string[] = [];
    const updatedAt = Date.now() - 60_000;
    const fetcher: PageProviderFetcher = async (rawUrl, policy) => {
      const url = new URL(String(rawUrl));
      requests.push(url.toString());
      expect(policy).toMatchObject({
        timeoutMs: 4_000,
        maxRedirects: 0,
        maxBodyBytes: 64 * 1024,
        acceptedMediaTypes: ["application/json"],
        acceptHeader: "application/json",
      });
      if (url.pathname === "/_api/market-index/header-index") {
        return {
          finalUrl: url,
          mediaType: "application/json",
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ indexes: [
            {
              link: { orderbookId: "19002", linkDisplay: "OMX Stockholm 30", shortLinkDisplay: "OMXS30" },
              quoteChangeToday: "-0,33",
              todayPriceUpdated: "17:30",
            },
            {
              link: { orderbookId: "155458", linkDisplay: "Dow Jones U.S. Index", shortLinkDisplay: "DJUS" },
              quoteChangeToday: "0,00",
              todayPriceUpdated: "19:20",
            },
          ] })),
        };
      }
      return {
        finalUrl: url,
        mediaType: "application/json",
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ orderbooks: [
          { orderbookId: "19002", lastPrice: 3167.16, updated: updatedAt },
          { orderbookId: "155458", lastPrice: 1834.44, updated: updatedAt },
        ] })),
      };
    };

    const requestedUrl = new URL("https://www.avanza.se/");
    const evidence = await avanzaMarketPageProvider.read({ fetcher, requestedUrl });
    expect(requests).toHaveLength(2);
    expect(evidence?.result.url).toBe(requestedUrl.toString());
    expect(JSON.parse(evidence?.result.snippet ?? "{}")).toMatchObject({
      sourceKind: "market_overview",
      scope: "headline indexes only; not individual equities",
      indexes: [{
        name: "OMX Stockholm 30",
        symbol: "OMXS30",
        level: 3167.16,
        dailyChangePercent: -0.33,
        updatedLocalTime: "17:30",
        updatedAt: new Date(updatedAt).toISOString(),
      }, {
        name: "Dow Jones U.S. Index",
        symbol: "DJUS",
        level: 1834.44,
        dailyChangePercent: 0,
        updatedLocalTime: "19:20",
        updatedAt: new Date(updatedAt).toISOString(),
      }],
    });
  });

  it("fails closed on malformed data or a redirected provider endpoint", async () => {
    const malformed: PageProviderFetcher = async (rawUrl) => {
      const url = new URL(String(rawUrl));
      return {
        finalUrl: url,
        mediaType: "application/json",
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(url.pathname.includes("header-index")
          ? {
              indexes: [{
                link: { orderbookId: "19002", linkDisplay: "OMXS30" },
                quoteChangeToday: "999999",
                todayPriceUpdated: "99:99",
              }],
            }
          : { orderbooks: [{ orderbookId: "19002", lastPrice: -1, updated: Date.now() }] })),
      };
    };
    expect(await avanzaMarketPageProvider.read({
      fetcher: malformed,
      requestedUrl: new URL("https://www.avanza.se/"),
    })).toBeUndefined();

    const redirected: PageProviderFetcher = async () => ({
      finalUrl: new URL("https://www.avanza.se/unexpected"),
      mediaType: "application/json",
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ indexes: [] })),
    });
    expect(await avanzaMarketPageProvider.read({
      fetcher: redirected,
      requestedUrl: new URL("https://www.avanza.se/"),
    })).toBeUndefined();
  });
});
