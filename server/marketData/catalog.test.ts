import { describe, expect, it } from "vitest";
import {
  MARKET_BASKET_CATALOG,
  MARKET_BASKET_IDS,
  MARKET_INDEX_CATALOG,
  MARKET_INDEX_IDS,
  MARKET_TARGET_IDS,
  isMarketBasketId,
  isMarketIndexId,
  isMarketTargetId,
  marketIndexIdsForTarget,
} from "./catalog.js";

describe("canonical market target catalog", () => {
  it("defines one bounded provider-neutral inventory with valid static metadata", () => {
    expect(MARKET_INDEX_IDS).toHaveLength(16);
    expect(new Set(MARKET_INDEX_IDS).size).toBe(MARKET_INDEX_IDS.length);
    expect(new Set(MARKET_TARGET_IDS).size).toBe(MARKET_TARGET_IDS.length);
    expect(MARKET_INDEX_IDS).toContain("US_DJIA");
    expect(MARKET_INDEX_IDS).not.toContain("DJUS" as never);

    for (const id of MARKET_INDEX_IDS) {
      const definition = MARKET_INDEX_CATALOG[id];
      expect(definition.displayName).not.toBe("");
      expect(definition.semanticDescription).not.toBe("");
      expect(definition.countryCode).toMatch(/^[A-Z]{2}$/u);
      expect(definition.currency).toMatch(/^[A-Z]{3}$/u);
      expect(() => new Intl.DateTimeFormat("en", { timeZone: definition.exchangeTimeZone })).not.toThrow();
      expect(isMarketIndexId(id)).toBe(true);
      expect(isMarketTargetId(id)).toBe(true);
    }
  });

  it("keeps every overview basket fixed, unique and small enough for one bounded provider read", () => {
    expect(MARKET_BASKET_IDS).toEqual([
      "GLOBAL_MAJOR",
      "COMMUNITY_MAJOR",
      "US_MAJOR",
      "EUROPE_MAJOR",
      "ASIA_MAJOR",
    ]);
    for (const id of MARKET_BASKET_IDS) {
      const basket = MARKET_BASKET_CATALOG[id];
      expect(basket.indexIds.length).toBeGreaterThan(1);
      expect(basket.indexIds.length).toBeLessThanOrEqual(8);
      expect(new Set(basket.indexIds).size).toBe(basket.indexIds.length);
      expect(basket.indexIds.every(isMarketIndexId)).toBe(true);
      expect(marketIndexIdsForTarget(id)).toEqual(basket.indexIds);
      expect(isMarketBasketId(id)).toBe(true);
      expect(isMarketTargetId(id)).toBe(true);
    }

    const globalRegions = new Set(
      MARKET_BASKET_CATALOG.GLOBAL_MAJOR.indexIds.map((id) => MARKET_INDEX_CATALOG[id].region),
    );
    expect(globalRegions).toEqual(new Set(["americas", "europe", "asia_pacific"]));
    expect(MARKET_BASKET_CATALOG.COMMUNITY_MAJOR.indexIds).toEqual([
      "SE_OMXS30",
      "EU_STOXX50",
      "US_SP500",
      "US_NASDAQ_COMPOSITE",
      "JP_NIKKEI225",
      "HK_HSI",
    ]);
  });

  it("fails closed for unknown runtime identifiers and returns defensive basket arrays", () => {
    expect(isMarketIndexId("S&P 500")).toBe(false);
    expect(isMarketBasketId("world")).toBe(false);
    expect(isMarketTargetId("US_DJUS")).toBe(false);
    const first = marketIndexIdsForTarget("GLOBAL_MAJOR");
    const second = marketIndexIdsForTarget("GLOBAL_MAJOR");
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
