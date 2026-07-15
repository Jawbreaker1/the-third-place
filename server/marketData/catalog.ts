export type MarketRegion = "americas" | "europe" | "asia_pacific";

export interface MarketIndexDefinition {
  readonly displayName: string;
  readonly shortName: string;
  readonly region: MarketRegion;
  readonly countryCode: string;
  readonly exchangeTimeZone: string;
  readonly currency: string;
  /** Provider-neutral meaning supplied to the semantic router. */
  readonly semanticDescription: string;
}

const marketIndexDefinitions = {
  SE_OMXS30: {
    displayName: "OMX Stockholm 30",
    shortName: "OMXS30",
    region: "europe",
    countryCode: "SE",
    exchangeTimeZone: "Europe/Stockholm",
    currency: "SEK",
    semanticDescription: "Sweden's OMX Stockholm 30 headline equity index",
  },
  US_SP500: {
    displayName: "S&P 500",
    shortName: "S&P 500",
    region: "americas",
    countryCode: "US",
    exchangeTimeZone: "America/New_York",
    currency: "USD",
    semanticDescription: "the United States S&P 500 large-cap equity index",
  },
  US_DJIA: {
    displayName: "Dow Jones Industrial Average",
    shortName: "DJIA",
    region: "americas",
    countryCode: "US",
    exchangeTimeZone: "America/New_York",
    currency: "USD",
    semanticDescription: "the United States Dow Jones Industrial Average, not the broader Dow Jones U.S. Index",
  },
  US_NASDAQ_COMPOSITE: {
    displayName: "NASDAQ Composite",
    shortName: "NASDAQ Composite",
    region: "americas",
    countryCode: "US",
    exchangeTimeZone: "America/New_York",
    currency: "USD",
    semanticDescription: "the United States NASDAQ Composite equity index, not an individual NASDAQ-listed share",
  },
  CA_TSX_COMPOSITE: {
    displayName: "S&P/TSX Composite",
    shortName: "TSX Composite",
    region: "americas",
    countryCode: "CA",
    exchangeTimeZone: "America/Toronto",
    currency: "CAD",
    semanticDescription: "Canada's S&P/TSX Composite headline equity index",
  },
  BR_IBOVESPA: {
    displayName: "IBOVESPA",
    shortName: "IBOVESPA",
    region: "americas",
    countryCode: "BR",
    exchangeTimeZone: "America/Sao_Paulo",
    currency: "BRL",
    semanticDescription: "Brazil's IBOVESPA headline equity index",
  },
  EU_STOXX50: {
    displayName: "EURO STOXX 50",
    shortName: "EURO STOXX 50",
    region: "europe",
    countryCode: "EU",
    exchangeTimeZone: "Europe/Berlin",
    currency: "EUR",
    semanticDescription: "the euro area's EURO STOXX 50 blue-chip equity index",
  },
  DE_DAX40: {
    displayName: "DAX",
    shortName: "DAX 40",
    region: "europe",
    countryCode: "DE",
    exchangeTimeZone: "Europe/Berlin",
    currency: "EUR",
    semanticDescription: "Germany's DAX 40 headline equity index",
  },
  GB_FTSE100: {
    displayName: "FTSE 100",
    shortName: "FTSE 100",
    region: "europe",
    countryCode: "GB",
    exchangeTimeZone: "Europe/London",
    currency: "GBP",
    semanticDescription: "the United Kingdom's FTSE 100 headline equity index",
  },
  FR_CAC40: {
    displayName: "CAC 40",
    shortName: "CAC 40",
    region: "europe",
    countryCode: "FR",
    exchangeTimeZone: "Europe/Paris",
    currency: "EUR",
    semanticDescription: "France's CAC 40 headline equity index",
  },
  CH_SMI: {
    displayName: "Swiss Market Index",
    shortName: "SMI",
    region: "europe",
    countryCode: "CH",
    exchangeTimeZone: "Europe/Zurich",
    currency: "CHF",
    semanticDescription: "Switzerland's Swiss Market Index headline equity index",
  },
  JP_NIKKEI225: {
    displayName: "Nikkei 225",
    shortName: "Nikkei 225",
    region: "asia_pacific",
    countryCode: "JP",
    exchangeTimeZone: "Asia/Tokyo",
    currency: "JPY",
    semanticDescription: "Japan's Nikkei 225 headline equity index",
  },
  HK_HSI: {
    displayName: "Hang Seng Index",
    shortName: "Hang Seng",
    region: "asia_pacific",
    countryCode: "HK",
    exchangeTimeZone: "Asia/Hong_Kong",
    currency: "HKD",
    semanticDescription: "Hong Kong's Hang Seng headline equity index",
  },
  CN_CSI300: {
    displayName: "CSI 300",
    shortName: "CSI 300",
    region: "asia_pacific",
    countryCode: "CN",
    exchangeTimeZone: "Asia/Shanghai",
    currency: "CNY",
    semanticDescription: "mainland China's CSI 300 large-cap equity index",
  },
  IN_NIFTY50: {
    displayName: "NIFTY 50",
    shortName: "NIFTY 50",
    region: "asia_pacific",
    countryCode: "IN",
    exchangeTimeZone: "Asia/Kolkata",
    currency: "INR",
    semanticDescription: "India's NIFTY 50 headline equity index",
  },
  AU_ASX200: {
    displayName: "S&P/ASX 200",
    shortName: "ASX 200",
    region: "asia_pacific",
    countryCode: "AU",
    exchangeTimeZone: "Australia/Sydney",
    currency: "AUD",
    semanticDescription: "Australia's S&P/ASX 200 headline equity index",
  },
} as const satisfies Record<string, MarketIndexDefinition>;

export type MarketIndexId = keyof typeof marketIndexDefinitions;

export const MARKET_INDEX_CATALOG: Readonly<Record<MarketIndexId, MarketIndexDefinition>> =
  Object.freeze(marketIndexDefinitions);

export const MARKET_INDEX_IDS = Object.freeze(
  Object.keys(marketIndexDefinitions) as MarketIndexId[],
) as readonly MarketIndexId[];

export interface MarketBasketDefinition {
  readonly displayName: string;
  readonly semanticDescription: string;
  readonly indexIds: readonly MarketIndexId[];
}

const marketBasketDefinitions = {
  GLOBAL_MAJOR: {
    displayName: "Major global markets",
    semanticDescription: "a bounded cross-region overview of major world equity indexes",
    indexIds: [
      "US_SP500",
      "US_DJIA",
      "US_NASDAQ_COMPOSITE",
      "EU_STOXX50",
      "GB_FTSE100",
      "JP_NIKKEI225",
      "HK_HSI",
      "BR_IBOVESPA",
    ],
  },
  US_MAJOR: {
    displayName: "Major United States markets",
    semanticDescription: "a bounded overview of the major United States equity indexes",
    indexIds: ["US_SP500", "US_DJIA", "US_NASDAQ_COMPOSITE"],
  },
  EUROPE_MAJOR: {
    displayName: "Major European markets",
    semanticDescription: "a bounded overview of major European equity indexes",
    indexIds: ["SE_OMXS30", "EU_STOXX50", "DE_DAX40", "GB_FTSE100", "FR_CAC40", "CH_SMI"],
  },
  ASIA_MAJOR: {
    displayName: "Major Asia-Pacific markets",
    semanticDescription: "a bounded overview of major Asia-Pacific equity indexes",
    indexIds: ["JP_NIKKEI225", "HK_HSI", "CN_CSI300", "IN_NIFTY50", "AU_ASX200"],
  },
} as const satisfies Record<string, MarketBasketDefinition>;

export type MarketBasketId = keyof typeof marketBasketDefinitions;
export type MarketTargetId = MarketIndexId | MarketBasketId;

export const MARKET_BASKET_CATALOG: Readonly<Record<MarketBasketId, MarketBasketDefinition>> =
  Object.freeze(marketBasketDefinitions);

export const MARKET_BASKET_IDS = Object.freeze(
  Object.keys(marketBasketDefinitions) as MarketBasketId[],
) as readonly MarketBasketId[];

export const MARKET_TARGET_IDS = Object.freeze([
  ...MARKET_INDEX_IDS,
  ...MARKET_BASKET_IDS,
]) as readonly MarketTargetId[];

const marketIndexIdSet = new Set<string>(MARKET_INDEX_IDS);
const marketBasketIdSet = new Set<string>(MARKET_BASKET_IDS);

export const isMarketIndexId = (value: unknown): value is MarketIndexId =>
  typeof value === "string" && marketIndexIdSet.has(value);

export const isMarketBasketId = (value: unknown): value is MarketBasketId =>
  typeof value === "string" && marketBasketIdSet.has(value);

export const isMarketTargetId = (value: unknown): value is MarketTargetId =>
  isMarketIndexId(value) || isMarketBasketId(value);

export const marketIndexIdsForTarget = (targetId: MarketTargetId): readonly MarketIndexId[] =>
  isMarketIndexId(targetId) ? [targetId] : [...MARKET_BASKET_CATALOG[targetId].indexIds];

export const marketTargetDisplayName = (targetId: MarketTargetId): string =>
  isMarketIndexId(targetId)
    ? MARKET_INDEX_CATALOG[targetId].displayName
    : MARKET_BASKET_CATALOG[targetId].displayName;
