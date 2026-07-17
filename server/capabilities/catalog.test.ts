import { describe, expect, it } from "vitest";
import {
  FOOTBALL_COMPETITION_IDS,
  FOOTBALL_DATA_VIEWS,
} from "../footballData/catalog.js";
import { MARKET_TARGET_IDS } from "../marketData/catalog.js";
import {
  CAPABILITY_ARGUMENT_FIELDS,
  CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_ENTRIES,
  TURN_CAPABILITIES,
  buildCapabilityRoutingGuidance,
  capabilitiesForMedium,
  capabilityCatalogEntry,
  hasBroadDiscoveryFallbackCapability,
  hasExternalEvidenceCapability,
  isExternalEvidenceCapability,
  validateCapabilityArgumentShape,
  type CapabilityArgumentField,
  type CapabilityArgumentValues,
  type TurnCapability,
} from "./catalog.js";

const emptyArguments = (): CapabilityArgumentValues => ({
  q: null,
  u: null,
  m: null,
  z: null,
  k: null,
  l: null,
  c: null,
  w: null,
  f: null,
});

describe("declarative capability catalog", () => {
  it("owns one stable ID tuple and one complete metadata entry per capability", () => {
    expect(TURN_CAPABILITIES).toEqual([
      "read_url",
      "web_search",
      "market_snapshot",
      "football_data",
      "local_datetime",
      "weather_forecast",
    ]);
    expect(new Set(TURN_CAPABILITIES).size).toBe(TURN_CAPABILITIES.length);
    expect(Object.keys(CAPABILITY_CATALOG)).toEqual(TURN_CAPABILITIES);
    expect(CAPABILITY_CATALOG_ENTRIES.map((entry) => entry.id)).toEqual(TURN_CAPABILITIES);
    for (const id of TURN_CAPABILITIES) {
      expect(capabilityCatalogEntry(id)).toMatchObject({ id });
      expect(CAPABILITY_CATALOG[id].arguments.required.length).toBeGreaterThan(0);
      expect(CAPABILITY_CATALOG[id].routingGuidance.primary).not.toBe("");
      expect(CAPABILITY_CATALOG[id].routingGuidance.verifier).not.toBe("");
    }
  });

  it("classifies generic discovery, exact-source reads and narrow structured lookups declaratively", () => {
    expect(CAPABILITY_CATALOG.web_search.routingClass).toBe("generic_external_default");
    expect(CAPABILITY_CATALOG.web_search.arguments.defaultValues).toEqual({ m: "web" });
    expect(CAPABILITY_CATALOG.read_url.routingClass).toBe("exact_source");
    expect(CAPABILITY_CATALOG.market_snapshot.routingClass).toBe("narrow_structured");
    expect(CAPABILITY_CATALOG.football_data.routingClass).toBe("narrow_structured");
    expect(CAPABILITY_CATALOG.local_datetime.routingClass).toBe("narrow_structured");
    expect(CAPABILITY_CATALOG.local_datetime.arguments.defaultValues).toEqual({
      k: "current_datetime",
    });
    expect(CAPABILITY_CATALOG.weather_forecast.routingClass).toBe("narrow_structured");
    expect(CAPABILITY_CATALOG.web_search.broadDiscoveryFallback).toBe(true);
    expect(CAPABILITY_CATALOG_ENTRIES
      .filter((entry) => entry.broadDiscoveryFallback)
      .map((entry) => entry.id)).toEqual(["web_search"]);
    expect(hasBroadDiscoveryFallbackCapability(["local_datetime"])).toBe(false);
    expect(hasBroadDiscoveryFallbackCapability(["local_datetime", "web_search"])).toBe(true);
    expect(isExternalEvidenceCapability("local_datetime")).toBe(false);
    expect(isExternalEvidenceCapability("read_url")).toBe(true);
    expect(hasExternalEvidenceCapability(["local_datetime"])).toBe(false);
    expect(hasExternalEvidenceCapability(["local_datetime", "weather_forecast"])).toBe(true);
    expect(capabilitiesForMedium("voice")).toEqual(["local_datetime"]);
    expect(capabilitiesForMedium("dm")).toEqual(TURN_CAPABILITIES);
  });

  it("declares every compact q/u/m/z/k/l/c/w/f field exactly once in the shared wire vocabulary", () => {
    expect(CAPABILITY_ARGUMENT_FIELDS).toEqual(["q", "u", "m", "z", "k", "l", "c", "w", "f"]);
    const known = new Set(CAPABILITY_ARGUMENT_FIELDS);
    for (const definition of Object.values(CAPABILITY_CATALOG)) {
      for (const field of [...definition.arguments.required, ...definition.arguments.allowed]) {
        expect(known.has(field)).toBe(true);
      }
      expect(definition.arguments.required.every((field) => definition.arguments.allowed.includes(field))).toBe(true);
      expect(Object.keys(definition.arguments.defaultValues ?? {}).every((field) =>
        definition.arguments.allowed.includes(field as CapabilityArgumentField))).toBe(true);
    }
  });

  it.each<{
    capability: TurnCapability;
    values: Partial<CapabilityArgumentValues>;
  }>([
    { capability: "web_search", values: { q: "今日のニュース", m: "news" } },
    { capability: "market_snapshot", values: { l: "SE_OMXS30" } },
    { capability: "football_data", values: { c: "FIFA_WC_2026", w: "today", f: "Sweden" } },
    { capability: "local_datetime", values: { z: "Asia/Tokyo", k: "current_time", l: "東京" } },
    { capability: "weather_forecast", values: { l: "札幌", q: "Sapporo" } },
  ])("accepts only the declared argument shape for $capability", ({ capability, values }) => {
    const valid = validateCapabilityArgumentShape(capability, { ...emptyArguments(), ...values });
    expect(valid).toEqual({ valid: true, missing: [], forbidden: [], conditional: [], invalidValue: [] });

    const foreignField = capability === "web_search"
      ? { l: "extra" }
      : capability === "weather_forecast"
        ? { m: "web" }
        : { q: "extra" };
    const invalid = validateCapabilityArgumentShape(capability, {
      ...emptyArguments(),
      ...values,
      ...foreignField,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.forbidden).not.toEqual([]);
    expect(invalid.message).toBe(CAPABILITY_CATALOG[capability].validationMessage);
  });

  it("keeps weather display labels separate from an optional canonical geocoding alias", () => {
    expect(validateCapabilityArgumentShape("weather_forecast", {
      ...emptyArguments(),
      l: "Stockholm",
    }).valid).toBe(true);
    expect(validateCapabilityArgumentShape("weather_forecast", {
      ...emptyArguments(),
      l: "Stockholm",
      q: "Stockholm",
    }).valid).toBe(true);
    expect(validateCapabilityArgumentShape("weather_forecast", {
      ...emptyArguments(),
      l: "札幌",
      q: "Sapporo",
    }).valid).toBe(true);
    expect(validateCapabilityArgumentShape("weather_forecast", {
      ...emptyArguments(),
      q: "Sapporo",
    })).toMatchObject({ valid: false, missing: ["l"] });
  });

  it("accepts only canonical exact-index and fixed-basket market targets", () => {
    expect(CAPABILITY_CATALOG.market_snapshot.arguments.allowedStringValues?.l).toEqual(MARKET_TARGET_IDS);
    expect(validateCapabilityArgumentShape("market_snapshot", {
      ...emptyArguments(),
      l: "OMXS30",
    })).toMatchObject({ valid: false, invalidValue: ["l"] });
    expect(validateCapabilityArgumentShape("market_snapshot", {
      ...emptyArguments(),
      l: "DJUS",
    })).toMatchObject({ valid: false, invalidValue: ["l"] });
    expect(validateCapabilityArgumentShape("market_snapshot", {
      ...emptyArguments(),
      l: "US_DJIA",
    }).valid).toBe(true);
    expect(validateCapabilityArgumentShape("market_snapshot", {
      ...emptyArguments(),
      l: "GLOBAL_MAJOR",
    }).valid).toBe(true);
  });

  it("accepts only registered football competitions and provider-neutral data views", () => {
    expect(CAPABILITY_CATALOG.football_data.arguments.allowedStringValues).toEqual({
      c: FOOTBALL_COMPETITION_IDS,
      w: FOOTBALL_DATA_VIEWS,
    });
    for (const view of FOOTBALL_DATA_VIEWS) {
      expect(validateCapabilityArgumentShape("football_data", {
        ...emptyArguments(),
        c: "FIFA_WC_2026",
        w: view,
      }).valid).toBe(true);
    }
    expect(validateCapabilityArgumentShape("football_data", {
      ...emptyArguments(),
      c: "WORLD_CUP",
      w: "today",
    })).toMatchObject({ valid: false, invalidValue: ["c"] });
    expect(validateCapabilityArgumentShape("football_data", {
      ...emptyArguments(),
      c: "FIFA_WC_2026",
      w: "live",
    })).toMatchObject({ valid: false, invalidValue: ["w"] });
    expect(validateCapabilityArgumentShape("football_data", {
      ...emptyArguments(),
      c: "FIFA_WC_2026",
      w: "upcoming",
      f: "Argentina",
      q: "latest score",
    })).toMatchObject({ valid: false, forbidden: ["q"] });
  });

  it("allows read_url mode only for a server-confirmed structural root", () => {
    const exactRead = { ...emptyArguments(), u: "U1", m: null };
    expect(validateCapabilityArgumentShape("read_url", exactRead).valid).toBe(true);

    const rootDiscovery = { ...exactRead, m: "news" };
    expect(validateCapabilityArgumentShape("read_url", rootDiscovery)).toMatchObject({
      valid: false,
      conditional: ["m"],
    });
    expect(validateCapabilityArgumentShape("read_url", rootDiscovery, {
      activeConditions: ["structural_root_only"],
    }).valid).toBe(true);
  });

  it("reports missing requirements separately from foreign capability fields", () => {
    expect(validateCapabilityArgumentShape("web_search", emptyArguments())).toMatchObject({
      valid: false,
      missing: ["q", "m"],
      forbidden: [],
    });
    expect(validateCapabilityArgumentShape("weather_forecast", {
      ...emptyArguments(),
      z: "Europe/Stockholm",
    })).toMatchObject({
      valid: false,
      missing: ["l"],
      forbidden: ["z"],
    });
  });

  it("generates both router audiences from the selected static catalog entries", () => {
    const primary = buildCapabilityRoutingGuidance(["read_url", "weather_forecast"], "primary");
    expect(primary).toContain("- read_url: select exactly one opaque urlCandidates.ref");
    expect(primary).toContain("- weather_forecast: use for a current-day or future daily weather forecast");
    expect(primary).toContain("q is optional and may contain only a short canonical geocoding alias");
    expect(primary).toContain("local/non-Latin-script place name");
    expect(primary).toContain("Never drop or weaken a region/country qualification");
    expect(primary).toContain("q is never a weather search query");
    expect(primary).not.toContain("- web_search:");

    const verifier = buildCapabilityRoutingGuidance(["web_search", "local_datetime"], "verifier");
    expect(verifier).toContain("- web_search: requires q and m");
    expect(verifier).toContain("- local_datetime: requires a valid IANA z");
    expect(verifier).toContain("Retain the guest request's language and writing system");

    const market = buildCapabilityRoutingGuidance(["market_snapshot"], "primary");
    expect(market).toContain("SE_OMXS30: Sweden's OMX Stockholm 30");
    expect(market).toContain("US_DJIA: the United States Dow Jones Industrial Average");
    expect(market).toContain("GLOBAL_MAJOR: a bounded cross-region overview");
    expect(market).toContain("rest of the world or other world markets performed");
    expect(market).toContain("individual entity remains the subject");
    expect(market).toContain("never replace the member with its container");
    expect(market).toContain("returning the registered index/basket's own level");
    expect(market).toContain("cannot be answered by returning the container's level");

    const search = buildCapabilityRoutingGuidance(["web_search"], "verifier");
    expect(search).toContain("instruction to investigate, look up or verify");
    expect(search).toContain("Interpret that communicative act semantically in any language");
    expect(market).toContain("Individual equities, market news, history, causes");

    const football = buildCapabilityRoutingGuidance(["football_data"], "primary");
    expect(football).toContain("structured fixtures");
    expect(football).toContain("FIFA_WC_2026");
    expect(football).toContain("today");
    expect(football).toContain("recent_results");
    expect(football).toContain("upcoming");
    expect(football).toContain("standings");
    expect(football).toContain("in-progress live score");
    expect(football).toContain("news, transfers, injuries");
    expect(football).toContain("tactical or causal analysis");
    expect(football).toContain("remain web_search");
  });
});
