import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ARGUMENT_FIELDS,
  CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_ENTRIES,
  TURN_CAPABILITIES,
  buildCapabilityRoutingGuidance,
  capabilitiesForMedium,
  capabilityCatalogEntry,
  hasExternalEvidenceCapability,
  isExternalEvidenceCapability,
  validateCapabilityArgumentShape,
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
});

describe("declarative capability catalog", () => {
  it("owns one stable ID tuple and one complete metadata entry per capability", () => {
    expect(TURN_CAPABILITIES).toEqual([
      "read_url",
      "web_search",
      "market_snapshot",
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
    expect(CAPABILITY_CATALOG.read_url.routingClass).toBe("exact_source");
    expect(CAPABILITY_CATALOG.market_snapshot.routingClass).toBe("narrow_structured");
    expect(CAPABILITY_CATALOG.local_datetime.routingClass).toBe("narrow_structured");
    expect(CAPABILITY_CATALOG.weather_forecast.routingClass).toBe("narrow_structured");
    expect(isExternalEvidenceCapability("local_datetime")).toBe(false);
    expect(isExternalEvidenceCapability("read_url")).toBe(true);
    expect(hasExternalEvidenceCapability(["local_datetime"])).toBe(false);
    expect(hasExternalEvidenceCapability(["local_datetime", "weather_forecast"])).toBe(true);
    expect(capabilitiesForMedium("voice")).toEqual(["local_datetime"]);
    expect(capabilitiesForMedium("dm")).toEqual(TURN_CAPABILITIES);
  });

  it("declares every compact q/u/m/z/k/l field exactly once in the shared wire vocabulary", () => {
    expect(CAPABILITY_ARGUMENT_FIELDS).toEqual(["q", "u", "m", "z", "k", "l"]);
    const known = new Set(CAPABILITY_ARGUMENT_FIELDS);
    for (const definition of Object.values(CAPABILITY_CATALOG)) {
      for (const field of [...definition.arguments.required, ...definition.arguments.allowed]) {
        expect(known.has(field)).toBe(true);
      }
      expect(definition.arguments.required.every((field) => definition.arguments.allowed.includes(field))).toBe(true);
    }
  });

  it.each<{
    capability: TurnCapability;
    values: Partial<CapabilityArgumentValues>;
  }>([
    { capability: "web_search", values: { q: "今日のニュース", m: "news" } },
    { capability: "market_snapshot", values: { l: "OMXS30" } },
    { capability: "local_datetime", values: { z: "Asia/Tokyo", k: "current_time", l: "東京" } },
    { capability: "weather_forecast", values: { l: "Ciudad de México" } },
  ])("accepts only the declared argument shape for $capability", ({ capability, values }) => {
    const valid = validateCapabilityArgumentShape(capability, { ...emptyArguments(), ...values });
    expect(valid).toEqual({ valid: true, missing: [], forbidden: [], conditional: [], invalidValue: [] });

    const foreignField = capability === "web_search" ? { l: "extra" } : { q: "extra" };
    const invalid = validateCapabilityArgumentShape(capability, {
      ...emptyArguments(),
      ...values,
      ...foreignField,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.forbidden).not.toEqual([]);
    expect(invalid.message).toBe(CAPABILITY_CATALOG[capability].validationMessage);
  });

  it("rejects provider identifiers outside a capability's declarative fixed set", () => {
    expect(validateCapabilityArgumentShape("market_snapshot", {
      ...emptyArguments(),
      l: "NASDAQ",
    })).toMatchObject({ valid: false, invalidValue: ["l"] });
    expect(validateCapabilityArgumentShape("market_snapshot", {
      ...emptyArguments(),
      l: "DJUS",
    }).valid).toBe(true);
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
    expect(primary).toContain("- weather_forecast: use for current conditions");
    expect(primary).not.toContain("- web_search:");

    const verifier = buildCapabilityRoutingGuidance(["web_search", "local_datetime"], "verifier");
    expect(verifier).toContain("- web_search: requires q and m");
    expect(verifier).toContain("- local_datetime: requires a valid IANA z");
    expect(verifier).toContain("Retain the guest request's language and writing system");
  });
});
