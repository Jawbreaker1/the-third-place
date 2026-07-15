import { describe, expect, it, vi } from "vitest";
import type { SafeHttpsFetchResult } from "../../safeHttpsFetch.js";
import { MARKET_INDEX_IDS, type MarketIndexId } from "../catalog.js";
import {
  YAHOO_CHART_HOSTS,
  YAHOO_CHART_PROVIDER_ID,
  YAHOO_CHART_SYMBOLS,
  YAHOO_CHART_TIME_ZONES,
  YahooChartMarketDataProvider,
  type YahooChartFetcher,
} from "./yahooChart.js";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");

const payload = (options: {
  symbol?: string;
  level?: number;
  previousClose?: number;
  observedAt?: number;
  currency?: string;
  instrumentType?: string;
  exchangeTimezoneName?: string;
} = {}) => ({
  chart: {
    result: [(() => {
      const observedAt = options.observedAt ?? NOW - 60_000;
      const level = options.level ?? 6_250;
      const previousClose = options.previousClose ?? 6_200;
      return {
        meta: {
          symbol: options.symbol ?? "^GSPC",
          instrumentType: options.instrumentType ?? "INDEX",
          exchangeTimezoneName: options.exchangeTimezoneName ?? "America/New_York",
          regularMarketPrice: level,
          previousClose,
          chartPreviousClose: previousClose,
          regularMarketTime: Math.floor(observedAt / 1_000),
          currency: options.currency ?? "USD",
        },
        timestamp: [
          Math.floor((observedAt - 5 * 60_000) / 1_000),
          Math.floor(observedAt / 1_000),
        ],
        indicators: { quote: [{ close: [level - 1, level] }] },
      };
    })()],
    error: null,
  },
});

const jsonResponse = (url: URL, body: unknown, overrides: Partial<SafeHttpsFetchResult> = {}): SafeHttpsFetchResult => ({
  finalUrl: url,
  mediaType: "application/json",
  contentType: "application/json; charset=utf-8",
  body: Buffer.from(JSON.stringify(body)),
  ...overrides,
});

describe("experimental Yahoo chart market provider", () => {
  it("owns a complete fixed symbol mapping and keeps DJIA distinct from DJUS", () => {
    expect(Object.keys(YAHOO_CHART_SYMBOLS)).toEqual(MARKET_INDEX_IDS);
    expect(YAHOO_CHART_SYMBOLS.US_DJIA).toBe("^DJI");
    expect(Object.values(YAHOO_CHART_SYMBOLS)).not.toContain("DJUS");
    expect(Object.keys(YAHOO_CHART_TIME_ZONES)).toEqual(MARKET_INDEX_IDS);
    expect(YAHOO_CHART_TIME_ZONES.EU_STOXX50).toBe("Europe/Zurich");
  });

  it("fetches only the fixed query host/path/parameters and computes change from previous close", async () => {
    const requested: URL[] = [];
    const fetcher: YahooChartFetcher = vi.fn(async (url, policy) => {
      requested.push(url);
      expect(policy).toMatchObject({
        timeoutMs: 4_000,
        maxRedirects: 0,
        maxBodyBytes: 256 * 1024,
        acceptedMediaTypes: ["application/json"],
      });
      return jsonResponse(url, payload());
    });
    const provider = new YahooChartMarketDataProvider(fetcher);
    const result = await provider.read({ indexIds: ["US_SP500"], now: NOW });

    expect(requested).toHaveLength(1);
    expect(requested[0]!.protocol).toBe("https:");
    expect(requested[0]!.hostname).toBe(YAHOO_CHART_HOSTS[0]);
    expect(decodeURIComponent(requested[0]!.pathname)).toBe("/v8/finance/chart/^GSPC");
    expect(Object.fromEntries(requested[0]!.searchParams)).toEqual({
      interval: "5m",
      range: "1d",
      includePrePost: "false",
    });
    expect(result).toMatchObject({
      providerId: YAHOO_CHART_PROVIDER_ID,
      failures: [],
      observations: [{
        indexId: "US_SP500",
        level: 6_250,
        previousClose: 6_200,
        change: 50,
        changeBasis: "previous_close",
        freshness: {
          status: "recent",
          observedAt: new Date(NOW - 60_000).toISOString(),
          ageMs: 60_000,
        },
        provider: {
          id: YAHOO_CHART_PROVIDER_ID,
          experimental: true,
          sourceUrl: "https://finance.yahoo.com/quote/%5EGSPC/",
          retrievedAt: new Date(NOW).toISOString(),
        },
      }],
    });
    expect(result.observations[0]!.changePercent).toBeCloseTo(50 / 6_200 * 100, 12);
  });

  it("accepts a real zero move and falls back only from query1 to the fixed query2 host", async () => {
    const requested: URL[] = [];
    const fetcher: YahooChartFetcher = async (url) => {
      requested.push(url);
      return url.hostname === YAHOO_CHART_HOSTS[0]
        ? undefined
        : jsonResponse(url, payload({ level: 6_200, previousClose: 6_200 }));
    };
    const result = await new YahooChartMarketDataProvider(fetcher).read({ indexIds: ["US_SP500"], now: NOW });
    expect(requested.map((url) => url.hostname)).toEqual(YAHOO_CHART_HOSTS);
    expect(result.observations[0]).toMatchObject({ change: 0, changePercent: 0 });
    expect(result.failures).toEqual([]);
  });

  it("accepts a not-yet-finalized trailing intraday candle but rejects conflicting previous-close metadata", async () => {
    const fetcher: YahooChartFetcher = async (url) => {
      const body = payload();
      body.chart.result[0]!.timestamp.push(Math.floor(NOW / 1_000));
      body.chart.result[0]!.indicators.quote[0]!.close.push(null as never);
      return jsonResponse(url, body);
    };
    const accepted = await new YahooChartMarketDataProvider(fetcher)
      .read({ indexIds: ["US_SP500"], now: NOW });
    expect(accepted.observations).toHaveLength(1);

    const conflicting: YahooChartFetcher = async (url) => {
      const body = payload();
      body.chart.result[0]!.meta.chartPreviousClose = 5_900;
      return jsonResponse(url, body);
    };
    const rejected = await new YahooChartMarketDataProvider(conflicting)
      .read({ indexIds: ["US_SP500"], now: NOW });
    expect(rejected.observations).toEqual([]);
    expect(rejected.failures).toEqual([{ indexId: "US_SP500", reason: "invalid_response" }]);
  });

  it("labels older bounded data as stale and preserves its absolute exchange-local trading date", async () => {
    const observedAt = NOW - 5 * 24 * 60 * 60_000;
    const fetcher: YahooChartFetcher = async (url) =>
      jsonResponse(url, payload({
        symbol: "^N225",
        currency: "JPY",
        exchangeTimezoneName: "Asia/Tokyo",
        observedAt,
      }));
    const result = await new YahooChartMarketDataProvider(fetcher).read({ indexIds: ["JP_NIKKEI225"], now: NOW });
    expect(result.observations[0]).toMatchObject({
      indexId: "JP_NIKKEI225",
      exchangeTimeZone: "Asia/Tokyo",
      tradingDate: "2026-07-10",
      freshness: {
        status: "stale",
        observedAt: new Date(observedAt).toISOString(),
        ageMs: 5 * 24 * 60 * 60_000,
      },
    });
  });

  it("fails closed on identity, instrument, timezone, timestamp or redirect mismatches", async () => {
    const cases: Array<{ name: string; response: (url: URL) => SafeHttpsFetchResult }> = [
      { name: "symbol", response: (url) => jsonResponse(url, payload({ symbol: "^DJI" })) },
      { name: "instrument", response: (url) => jsonResponse(url, payload({ instrumentType: "MUTUALFUND" })) },
      { name: "timezone", response: (url) => jsonResponse(url, payload({ exchangeTimezoneName: "Europe/London" })) },
      { name: "currency", response: (url) => jsonResponse(url, payload({ currency: "EUR" })) },
      { name: "future", response: (url) => jsonResponse(url, payload({ observedAt: NOW + 6 * 60_000 })) },
      {
        name: "redirect",
        response: (url) => jsonResponse(url, payload(), { finalUrl: new URL("https://example.com/redirected") }),
      },
    ];
    for (const testCase of cases) {
      const fetcher: YahooChartFetcher = vi.fn(async (url) => testCase.response(url));
      const result = await new YahooChartMarketDataProvider(fetcher).read({ indexIds: ["US_SP500"], now: NOW });
      expect(result.observations, testCase.name).toEqual([]);
      expect(result.failures, testCase.name).toEqual([{ indexId: "US_SP500", reason: "invalid_response" }]);
      expect(fetcher, testCase.name).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects unknown, duplicate and oversized target inventories before any network request", async () => {
    const fetcher: YahooChartFetcher = vi.fn();
    const provider = new YahooChartMarketDataProvider(fetcher);
    await expect(provider.read({ indexIds: ["not-a-target" as MarketIndexId], now: NOW })).rejects.toThrow(TypeError);
    await expect(provider.read({ indexIds: ["US_SP500", "US_SP500"], now: NOW })).rejects.toThrow(TypeError);
    await expect(provider.read({ indexIds: MARKET_INDEX_IDS.slice(0, 9), now: NOW })).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
