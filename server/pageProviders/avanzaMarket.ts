import type { SafeHttpsFetchPolicy } from "../safeHttpsFetch.js";
import { stripDangerousTextControls } from "../../shared/unicodeSafety.js";
import type { PageProviderAdapter, PageProviderEvidence } from "./types.js";

const jsonPolicy: SafeHttpsFetchPolicy = {
  timeoutMs: 4_000,
  maxRedirects: 0,
  maxBodyBytes: 64 * 1024,
  acceptedMediaTypes: ["application/json"],
  acceptHeader: "application/json",
  userAgent: "TheThirdPlace-AvanzaReader/1.0",
};

const HOSTS = new Set(["avanza.se", "www.avanza.se"]);
const MARKET_PATH = /^\/(?:start|borsen-idag(?:\.html)?|hall-koll\/borsen-idag\.html|marknadsoversikt)?\/?$/iu;

type JsonRecord = Record<string, unknown>;

const jsonRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;

const boundedString = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = stripDangerousTextControls(value.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return cleaned || undefined;
};

const finiteIndexLevel = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? value
    : undefined;

const boundedDailyPercent = (value: unknown): number | undefined => {
  const raw = boundedString(value, 20);
  if (!raw || !/^[+-]?\d{1,3}(?:[,.]\d{1,6})?$/u.test(raw)) return undefined;
  const numeric = Number(raw.replace(",", "."));
  return Number.isFinite(numeric) && Math.abs(numeric) <= 100 ? numeric : undefined;
};

const validMarketTime = (value: unknown): string | undefined => {
  const raw = boundedString(value, 8);
  const match = raw?.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? raw : undefined;
};

interface HeaderIndex {
  orderbookId: string;
  name: string;
  shortName?: string;
  changeToday?: number;
  updated?: string;
}

const parseHeaderIndexes = (body: Buffer): HeaderIndex[] => {
  try {
    const parsed = jsonRecord(JSON.parse(body.toString("utf8")));
    if (!parsed || !Array.isArray(parsed.indexes)) return [];
    return parsed.indexes.slice(0, 8).flatMap((raw): HeaderIndex[] => {
      const row = jsonRecord(raw);
      const link = jsonRecord(row?.link);
      const orderbookId = boundedString(link?.orderbookId, 16);
      const name = boundedString(link?.linkDisplay, 100);
      if (!orderbookId || !/^\d{1,12}$/u.test(orderbookId) || !name) return [];
      const shortName = boundedString(link?.shortLinkDisplay, 24);
      const changeToday = boundedDailyPercent(row?.quoteChangeToday);
      const updated = validMarketTime(row?.todayPriceUpdated);
      return [{
        orderbookId,
        name,
        ...(shortName ? { shortName } : {}),
        ...(changeToday ? { changeToday } : {}),
        ...(updated ? { updated } : {}),
      }];
    });
  } catch {
    return [];
  }
};

const parseLastPrices = (body: Buffer, allowedIds: ReadonlySet<string>): Map<string, number> => {
  const prices = new Map<string, number>();
  try {
    const parsed = jsonRecord(JSON.parse(body.toString("utf8")));
    if (!parsed || !Array.isArray(parsed.orderbooks)) return prices;
    for (const raw of parsed.orderbooks.slice(0, 8)) {
      const row = jsonRecord(raw);
      const orderbookId = boundedString(row?.orderbookId, 16);
      const lastPrice = finiteIndexLevel(row?.lastPrice);
      if (orderbookId && allowedIds.has(orderbookId) && lastPrice !== undefined) prices.set(orderbookId, lastPrice);
    }
  } catch {
    return prices;
  }
  return prices;
};

const readMarketEvidence: PageProviderAdapter["read"] = async ({ fetcher, requestedUrl }) => {
  const headerUrl = new URL("https://www.avanza.se/_api/market-index/header-index");
  const header = await fetcher(headerUrl, jsonPolicy).catch(() => undefined);
  if (!header || header.finalUrl.toString() !== headerUrl.toString()) return undefined;
  const indexes = parseHeaderIndexes(header.body);
  if (indexes.length === 0) return undefined;

  const allowedIds = new Set(indexes.map((index) => index.orderbookId));
  const dataUrl = new URL("https://www.avanza.se/_api/market-overview/data/orderbooks");
  dataUrl.searchParams.set("orderbookIds", [...allowedIds].join(","));
  const data = await fetcher(dataUrl, jsonPolicy).catch(() => undefined);
  const prices = data && data.finalUrl.toString() === dataUrl.toString()
    ? parseLastPrices(data.body, allowedIds)
    : new Map<string, number>();
  const completeIndexes = indexes.filter((index) =>
    prices.has(index.orderbookId) && index.changeToday !== undefined && index.updated !== undefined,
  );
  if (completeIndexes.length === 0) return undefined;

  const retrievedAt = new Date().toISOString();
  // Provider adapters decode bounded fields into inert typed evidence. They do
  // not classify intent or pre-compose a Swedish, English or other chat reply.
  const snippet = JSON.stringify({
    sourceKind: "market_overview",
    retrievedAt,
    scope: "headline indexes only; not individual equities",
    indexes: completeIndexes.map((index) => ({
      name: index.name,
      ...(index.shortName && index.shortName !== index.name ? { symbol: index.shortName } : {}),
      level: prices.get(index.orderbookId)!,
      dailyChangePercent: index.changeToday!,
      updatedLocalTime: index.updated!,
    })),
  });
  return {
    retrievedAt,
    cacheTtlMs: 45_000,
    result: {
      id: "S1",
      title: "Avanza market overview",
      url: requestedUrl.toString(),
      snippet,
    },
  } satisfies PageProviderEvidence;
};

export const avanzaMarketPageProvider: PageProviderAdapter = Object.freeze({
  id: "avanza-market-overview",
  supports: (url: URL) =>
    url.protocol === "https:" && HOSTS.has(url.hostname.toLocaleLowerCase()) && MARKET_PATH.test(url.pathname),
  read: readMarketEvidence,
});
