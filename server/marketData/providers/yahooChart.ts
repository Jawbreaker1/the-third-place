import { fetchPublicHttps, type SafeHttpsFetchPolicy, type SafeHttpsFetchResult } from "../../safeHttpsFetch.js";
import {
  MARKET_INDEX_CATALOG,
  MARKET_INDEX_IDS,
  isMarketIndexId,
  type MarketIndexId,
} from "../catalog.js";
import {
  classifyMarketFreshness,
  isStructurallyAcceptableMarketInstant,
  marketObservationAgeMs,
} from "../freshness.js";
import type {
  MarketDataProvider,
  MarketObservation,
  MarketProviderBatch,
  MarketProviderFailureReason,
} from "../types.js";

export type YahooChartFetcher = (
  url: URL,
  policy: SafeHttpsFetchPolicy,
) => Promise<SafeHttpsFetchResult | undefined>;

export const YAHOO_CHART_PROVIDER_ID = "yahoo-chart-experimental";
export const YAHOO_CHART_HOSTS = Object.freeze([
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
]) as readonly [string, string];

export const YAHOO_CHART_SYMBOLS: Readonly<Record<MarketIndexId, string>> = Object.freeze({
  SE_OMXS30: "^OMX",
  US_SP500: "^GSPC",
  US_DJIA: "^DJI",
  US_NASDAQ_COMPOSITE: "^IXIC",
  CA_TSX_COMPOSITE: "^GSPTSE",
  BR_IBOVESPA: "^BVSP",
  EU_STOXX50: "^STOXX50E",
  DE_DAX40: "^GDAXI",
  GB_FTSE100: "^FTSE",
  FR_CAC40: "^FCHI",
  CH_SMI: "^SSMI",
  JP_NIKKEI225: "^N225",
  HK_HSI: "^HSI",
  CN_CSI300: "000300.SS",
  IN_NIFTY50: "^NSEI",
  AU_ASX200: "^AXJO",
});

/** Provider metadata zones, which may differ from our canonical display zone. */
export const YAHOO_CHART_TIME_ZONES: Readonly<Record<MarketIndexId, string>> = Object.freeze({
  ...Object.fromEntries(MARKET_INDEX_IDS.map((id) => [id, MARKET_INDEX_CATALOG[id].exchangeTimeZone])),
  EU_STOXX50: "Europe/Zurich",
}) as Readonly<Record<MarketIndexId, string>>;

const yahooJsonPolicy: SafeHttpsFetchPolicy = Object.freeze({
  timeoutMs: 2_000,
  maxRedirects: 0,
  maxBodyBytes: 256 * 1024,
  acceptedMediaTypes: ["application/json"],
  acceptHeader: "application/json",
  userAgent: "TheThirdPlace-YahooChartExperimental/1.0",
});

const MAX_TARGETS_PER_READ = 8;
// Keep the burst deliberately small, but finish a six-index basket inside the
// enclosing provider deadline even when one fixed host fallback is needed.
const MAX_CONCURRENT_READS = 2;

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

const positiveFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? value
    : undefined;

const absoluteEpochSeconds = (value: unknown, now: number): number | undefined => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  const milliseconds = value * 1_000;
  return isStructurallyAcceptableMarketInstant(milliseconds, now) ? milliseconds : undefined;
};

const tradingDateInZone = (instantMs: number, timeZone: string): string | undefined => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instantMs));
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((candidate) => candidate.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
};

const sourceUrlFor = (indexId: MarketIndexId): string => {
  const symbol = YAHOO_CHART_SYMBOLS[indexId];
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
};

const chartUrlFor = (host: string, indexId: MarketIndexId): URL => {
  if (!YAHOO_CHART_HOSTS.includes(host)) throw new TypeError("Unsupported Yahoo chart host");
  const symbol = YAHOO_CHART_SYMBOLS[indexId];
  const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`);
  // In a one-session chart, chartPreviousClose is the previous session close.
  // On a multi-day range it instead precedes the whole range and is unusable
  // for a current session-change calculation.
  url.searchParams.set("interval", "5m");
  url.searchParams.set("range", "1d");
  url.searchParams.set("includePrePost", "false");
  return url;
};

const previousSessionClose = (
  result: JsonRecord,
  meta: JsonRecord,
  level: number,
  observedAtMs: number,
  now: number,
): number | undefined => {
  const timestamps = result.timestamp;
  const indicators = record(result.indicators);
  const quotes = indicators?.quote;
  if (
    !Array.isArray(timestamps) ||
    timestamps.length < 1 ||
    timestamps.length > 256 ||
    !Array.isArray(quotes) ||
    quotes.length !== 1
  ) return undefined;
  const closes = record(quotes[0])?.close;
  if (!Array.isArray(closes) || closes.length !== timestamps.length) return undefined;

  const points: Array<{ timestamp: number; close?: number }> = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = absoluteEpochSeconds(timestamps[index], now);
    const rawClose = closes[index];
    const close = rawClose === null ? undefined : positiveFinite(rawClose);
    if (timestamp === undefined || (rawClose !== null && close === undefined)) return undefined;
    if (points.at(-1) && timestamp <= points.at(-1)!.timestamp) return undefined;
    points.push({ timestamp, ...(close !== undefined ? { close } : {}) });
  }
  const latest = [...points].reverse().find((point) => point.close !== undefined);
  if (!latest || latest.close === undefined) return undefined;
  if (
    latest.timestamp > observedAtMs + 5 * 60_000 ||
    observedAtMs - latest.timestamp > 24 * 60 * 60_000 ||
    Math.abs(latest.close - level) > Math.max(0.01, Math.abs(level) * 0.00001)
  ) return undefined;
  const previousClose = positiveFinite(meta.previousClose);
  const chartPreviousClose = positiveFinite(meta.chartPreviousClose);
  if (
    previousClose !== undefined &&
    chartPreviousClose !== undefined &&
    Math.abs(previousClose - chartPreviousClose) > Math.max(0.01, previousClose * 0.00001)
  ) return undefined;
  return previousClose ?? chartPreviousClose;
};

const parseObservation = (
  response: SafeHttpsFetchResult,
  requestedUrl: URL,
  indexId: MarketIndexId,
  now: number,
): MarketObservation | undefined => {
  if (
    response.finalUrl.toString() !== requestedUrl.toString() ||
    response.mediaType.toLocaleLowerCase() !== "application/json" ||
    response.body.length === 0 ||
    response.body.length > yahooJsonPolicy.maxBodyBytes
  ) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(response.body.toString("utf8"));
  } catch {
    return undefined;
  }
  const chart = record(record(raw)?.chart);
  if (!chart || (chart.error !== null && chart.error !== undefined) || !Array.isArray(chart.result) || chart.result.length !== 1) {
    return undefined;
  }
  const chartResult = record(chart.result[0]);
  const meta = record(chartResult?.meta);
  const expectedSymbol = YAHOO_CHART_SYMBOLS[indexId];
  if (!meta || meta.symbol !== expectedSymbol || meta.instrumentType !== "INDEX") return undefined;
  const level = positiveFinite(meta.regularMarketPrice);
  const observedAtMs = absoluteEpochSeconds(meta.regularMarketTime, now);
  if (level === undefined || observedAtMs === undefined || !chartResult) return undefined;
  const previousClose = previousSessionClose(chartResult, meta, level, observedAtMs, now);
  if (previousClose === undefined) return undefined;
  const definition = MARKET_INDEX_CATALOG[indexId];
  if (typeof meta.currency === "string" && meta.currency !== definition.currency) return undefined;
  if (
    typeof meta.exchangeTimezoneName === "string" &&
    meta.exchangeTimezoneName !== YAHOO_CHART_TIME_ZONES[indexId]
  ) return undefined;
  const tradingDate = tradingDateInZone(observedAtMs, definition.exchangeTimeZone);
  if (!tradingDate) return undefined;
  const change = level - previousClose;
  const changePercent = change / previousClose * 100;
  if (!Number.isFinite(change) || !Number.isFinite(changePercent) || Math.abs(changePercent) > 100) return undefined;
  const observedAt = new Date(observedAtMs).toISOString();
  const retrievedAt = new Date(now).toISOString();
  return {
    indexId,
    displayName: definition.displayName,
    shortName: definition.shortName,
    region: definition.region,
    countryCode: definition.countryCode,
    exchangeTimeZone: definition.exchangeTimeZone,
    tradingDate,
    currency: definition.currency,
    level,
    previousClose,
    change,
    changePercent,
    changeBasis: "previous_close",
    freshness: {
      status: classifyMarketFreshness(observedAtMs, now),
      observedAt,
      ageMs: marketObservationAgeMs(observedAtMs, now),
    },
    provider: {
      id: YAHOO_CHART_PROVIDER_ID,
      experimental: true,
      sourceUrl: sourceUrlFor(indexId),
      retrievedAt,
    },
  };
};

interface YahooReadResult {
  observation?: MarketObservation;
  failure?: MarketProviderFailureReason;
}

const readOne = async (
  indexId: MarketIndexId,
  now: number,
  fetcher: YahooChartFetcher,
): Promise<YahooReadResult> => {
  let sawResponse = false;
  for (const host of YAHOO_CHART_HOSTS) {
    const url = chartUrlFor(host, indexId);
    const response = await fetcher(url, yahooJsonPolicy).catch(() => undefined);
    if (!response) continue;
    sawResponse = true;
    const observation = parseObservation(response, url, indexId, now);
    if (observation) return { observation };
  }
  return { failure: sawResponse ? "invalid_response" : "transport" };
};

const boundedMap = async <T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
};

export class YahooChartMarketDataProvider implements MarketDataProvider {
  readonly id = YAHOO_CHART_PROVIDER_ID;
  readonly experimental = true;
  readonly supportedIndexIds = MARKET_INDEX_IDS;

  constructor(private readonly fetcher: YahooChartFetcher = fetchPublicHttps) {}

  async read(request: { readonly indexIds: readonly MarketIndexId[]; readonly now: number }): Promise<MarketProviderBatch> {
    if (
      request.indexIds.length === 0 ||
      request.indexIds.length > MAX_TARGETS_PER_READ ||
      new Set(request.indexIds).size !== request.indexIds.length ||
      request.indexIds.some((id) => !isMarketIndexId(id)) ||
      !Number.isSafeInteger(request.now)
    ) throw new TypeError("Invalid bounded Yahoo chart market request");
    const results = await boundedMap(request.indexIds, MAX_CONCURRENT_READS, (id) =>
      readOne(id, request.now, this.fetcher));
    const observations: MarketObservation[] = [];
    const failures: Array<{ indexId: MarketIndexId; reason: MarketProviderFailureReason }> = [];
    results.forEach((result, index) => {
      const indexId = request.indexIds[index]!;
      if (result.observation) observations.push(result.observation);
      else failures.push({ indexId, reason: result.failure ?? "missing_observation" });
    });
    return {
      providerId: this.id,
      retrievedAt: new Date(request.now).toISOString(),
      observations,
      failures,
    };
  }
}
