import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PageReadCandidateSet,
  PageReadRequest,
  PageReader,
} from "../pageReader.js";
import type { ResearchBroker, ResearchPacket } from "../researchBroker.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis } from "../semanticRouter.js";
import type { WeatherForecastResult } from "../weatherForecast.js";
import { TURN_CAPABILITIES, type TurnCapability } from "./catalog.js";
import {
  CapabilityRegistry,
  type CapabilityCompileContext,
  type EvidenceResolution,
  type WeatherForecastCapabilityProvider,
} from "./registry.js";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");

const candidateSet = (url = "https://example.com/article"): PageReadCandidateSet => ({
  requestedAt: new Date(NOW).toISOString(),
  candidates: [{
    id: "U1",
    raw: url,
    url: new URL(url),
    supported: true,
    source: "message",
    messageId: "message-1",
    authorId: "guest-1",
    createdAt: new Date(NOW - 1_000).toISOString(),
  }],
});

const emptyCandidateSet = (): PageReadCandidateSet => ({
  requestedAt: new Date(NOW).toISOString(),
  candidates: [],
});

const pageRequest = (
  url: string,
  overrides: Partial<PageReadRequest> = {},
): PageReadRequest => ({
  url: new URL(url),
  requestedAt: new Date(NOW).toISOString(),
  intent: "inspect the supplied source",
  retry: false,
  source: "message",
  ...overrides,
});

const result = (id: string, url: string, snippet = `Concrete evidence from ${id}`) => ({
  id,
  title: `Source ${id}`,
  url,
  snippet,
});

const pagePacket = (
  url: string,
  results: ResearchPacket["results"] = [result("S1", url)],
): ResearchPacket => ({
  kind: "page",
  query: "inspect the supplied source",
  retrievedAt: new Date(NOW).toISOString(),
  results,
});

const searchPacket = (url: string): ResearchPacket => ({
  kind: "search",
  query: "fresh external facts",
  retrievedAt: new Date(NOW).toISOString(),
  results: [result("S1", url, "Search-result metadata is not answer evidence")],
  search: {
    scope: "generic",
    requestedMode: "web",
    providerMode: "web",
  },
});

const siteSearchPacket = (rootUrl: string, resultUrl: string): ResearchPacket => ({
  kind: "search",
  query: "latest relevant item",
  retrievedAt: new Date(NOW).toISOString(),
  results: [result("S1", resultUrl, "Same-site result metadata")],
  search: {
    scope: "site",
    requestedMode: "web",
    providerMode: "web",
    site: {
      host: new URL(rootUrl).hostname,
      quality: {
        classification: "deep_links",
        resultCount: 1,
        rootResultCount: 0,
        deepLinkResultCount: 1,
        datedResultCount: 0,
        freshResultCount: 0,
      },
    },
  },
});

const forecast: WeatherForecastResult = {
  provider: "open-meteo",
  query: "G\u00f6teborg",
  retrievedAt: new Date(NOW).toISOString(),
  resolved: {
    place: "G\u00f6teborg",
    admin: "V\u00e4stra G\u00f6taland",
    country: "Sverige",
    countryCode: "SE",
    timezone: "Europe/Stockholm",
    latitude: 57.7089,
    longitude: 11.9746,
  },
  sourceUrl: "https://api.open-meteo.com/v1/forecast?latitude=57.7089&longitude=11.9746",
  units: {
    temperature: "\u00b0C",
    precipitationProbability: "%",
    precipitation: "mm",
    weatherCode: "wmo code",
  },
  daily: [{
    date: "2026-07-15",
    temperatureMax: 22.4,
    temperatureMin: 14.1,
    precipitationProbabilityMax: 30,
    precipitationSum: 0.8,
    weatherCode: 2,
  }],
  temperatureTrend: {
    direction: "cooler",
    change: -2.1,
    fromDate: "2026-07-15",
    toDate: "2026-07-21",
    basis: "daily_mean_temperature",
    unit: "\u00b0C",
  },
};

interface AnalysisOverrides {
  goal?: string | null;
  evidenceConfidence?: number;
  capabilityConfidence?: number;
  requestKind?: TurnAnalysis["capabilities"]["requestKind"];
  source?: TurnAnalysis["source"];
  urlRef?: string | null;
  searchMode?: TurnAnalysis["evidence"]["searchMode"];
  query?: string | null;
  timeZone?: string | null;
  timeKind?: TurnAnalysis["evidence"]["timeKind"];
  locationLabel?: string | null;
}

const analysisFor = (
  action: TurnCapability,
  overrides: AnalysisOverrides = {},
): TurnAnalysis => {
  const fallback = createFailClosedTurnAnalysis("disabled");
  return {
    ...fallback,
    source: overrides.source ?? "lm",
    failureReason: null,
    language: { tag: "sv", confidence: 0.99 },
    responseLanguage: { tag: "sv", confidence: 0.99 },
    evidence: {
      ...fallback.evidence,
      need: "required",
      action,
      confidence: overrides.evidenceConfidence ?? 0.99,
      goal: overrides.goal === undefined ? "answer the guest with fresh facts" : overrides.goal,
      query: overrides.query === undefined
        ? action === "web_search" ? "f\u00e4rska externa fakta" : null
        : overrides.query,
      urlRef: overrides.urlRef === undefined ? action === "read_url" ? "U1" : null : overrides.urlRef,
      searchMode: overrides.searchMode === undefined ? action === "web_search" ? "web" : null : overrides.searchMode,
      timeZone: overrides.timeZone === undefined
        ? action === "local_datetime" ? "Europe/Stockholm" : null
        : overrides.timeZone,
      timeKind: overrides.timeKind === undefined
        ? action === "local_datetime" ? "current_datetime" : null
        : overrides.timeKind,
      locationLabel: overrides.locationLabel === undefined
        ? action === "local_datetime" ? "Stockholm" : action === "weather_forecast" ? "G\u00f6teborg" : null
        : overrides.locationLabel,
    },
    capabilities: {
      ...fallback.capabilities,
      discussed: [action],
      requestKind: overrides.requestKind ?? "execute",
      confidence: overrides.capabilityConfidence ?? 0.99,
    },
  } as TurnAnalysis;
};

const compileContext = (
  candidates: PageReadCandidateSet = candidateSet(),
  allowSearch = true,
): CapabilityCompileContext => ({
  medium: "public",
  candidateSet: candidates,
  allowSearch,
  intent: "answer the latest guest request",
  requesterId: "compile-requester",
});

const createHarness = (options: {
  resolveTarget?: PageReadRequest;
  weather?: WeatherForecastCapabilityProvider | null;
} = {}) => {
  const pageReader = {
    resolveTarget: vi.fn(() => options.resolveTarget),
    read: vi.fn(async () => undefined as ResearchPacket | undefined),
  };
  const researchBroker = {
    research: vi.fn(async () => undefined as ResearchPacket | undefined),
    researchSite: vi.fn(async () => undefined as ResearchPacket | undefined),
  };
  const registry = new CapabilityRegistry({
    pageReader: pageReader as unknown as PageReader,
    researchBroker: researchBroker as unknown as Pick<ResearchBroker, "research" | "researchSite">,
    weatherForecastProvider: options.weather === undefined ? null : options.weather,
    now: () => NOW,
  });
  return { registry, pageReader, researchBroker };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("capability registry contract", () => {
  it("covers the complete catalog and reports runtime availability without inventing capabilities", () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    vi.stubEnv("RESEARCH_ENABLED", "true");
    const weather = { forecast: vi.fn(async () => forecast) };
    const { registry } = createHarness({ weather });

    expect(registry.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual(TURN_CAPABILITIES);
    expect(registry.hasExternalEvidence(TURN_CAPABILITIES)).toBe(true);
    expect(registry.hasExternalEvidence(["local_datetime"])).toBe(false);

    expect(registry.available({ medium: "public", candidateSet: emptyCandidateSet(), allowSearch: false })).toEqual([
      "local_datetime",
      "weather_forecast",
    ]);

    vi.stubEnv("LINK_READER_ENABLED", "false");
    vi.stubEnv("RESEARCH_ENABLED", "false");
    expect(registry.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual([
      "local_datetime",
      "weather_forecast",
    ]);

    const noWeather = createHarness({ weather: null }).registry;
    expect(noWeather.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual(["local_datetime"]);
  });

  it("caps availability and compilation to a medium-owned capability inventory", () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    vi.stubEnv("RESEARCH_ENABLED", "true");
    const weather = { forecast: vi.fn(async () => forecast) };
    const { registry } = createHarness({
      resolveTarget: pageRequest("https://example.com/article"),
      weather,
    });
    const voiceContext = {
      ...compileContext(),
      medium: "voice" as const,
      inventory: ["local_datetime"] as const,
    };

    expect(registry.available({ ...compileContext(), medium: "voice" })).toEqual(["local_datetime"]);
    expect(registry.available(voiceContext)).toEqual(["local_datetime"]);
    expect(registry.compile(analysisFor("local_datetime"), voiceContext)).toMatchObject({
      capability: "local_datetime",
    });
    expect(registry.compile(analysisFor("read_url"), voiceContext)).toBeUndefined();
    expect(registry.compile(analysisFor("web_search"), voiceContext)).toBeUndefined();
    expect(registry.compile(analysisFor("weather_forecast"), voiceContext)).toBeUndefined();
  });

  it("compiles only jointly trusted evidence and capability requests", () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    const request = pageRequest("https://example.com/article");
    const { registry } = createHarness({ resolveTarget: request });

    expect(registry.compile(analysisFor("read_url"), compileContext())).toMatchObject({
      capability: "read_url",
      requestKind: "execute",
      externalEvidence: true,
      pageReadRequest: request,
    });
    expect(registry.compile(
      analysisFor("read_url", { source: "fallback" }),
      compileContext(),
    )).toBeUndefined();
    expect(registry.compile(
      analysisFor("read_url", { evidenceConfidence: 0.74 }),
      compileContext(),
    )).toBeUndefined();
    expect(registry.compile(
      analysisFor("read_url", { capabilityConfidence: 0.74 }),
      compileContext(),
    )).toBeUndefined();
  });

  it("fails closed when a capability is unavailable or its arguments cannot form a valid invocation", () => {
    vi.stubEnv("RESEARCH_ENABLED", "true");
    const { registry, pageReader } = createHarness();

    vi.stubEnv("LINK_READER_ENABLED", "false");
    expect(registry.compile(analysisFor("read_url"), compileContext())).toBeUndefined();
    expect(pageReader.resolveTarget).not.toHaveBeenCalled();

    vi.stubEnv("LINK_READER_ENABLED", "true");
    expect(registry.compile(analysisFor("read_url"), compileContext())).toBeUndefined();
    expect(registry.compile(
      analysisFor("web_search"),
      compileContext(candidateSet(), false),
    )).toBeUndefined();
    expect(registry.compile(
      analysisFor("web_search", { query: null }),
      compileContext(),
    )).toBeUndefined();
    expect(registry.compile(
      analysisFor("web_search", { locationLabel: "Stockholm" }),
      compileContext(),
    )).toBeUndefined();
    expect(registry.compile(
      analysisFor("web_search", { goal: null }),
      compileContext(),
    )).toBeUndefined();
    expect(registry.compile(
      analysisFor("web_search", { requestKind: "availability" }),
      compileContext(),
    )).toBeUndefined();
  });

  it("reads a non-root exact URL directly and never turns it into site discovery", async () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    const request = pageRequest("https://example.com/articles/42");
    const { registry, pageReader, researchBroker } = createHarness({ resolveTarget: request });
    pageReader.read.mockResolvedValue(pagePacket(request.url!.toString()));
    const invocation = registry.compile(analysisFor("read_url"), compileContext())!;

    const resolution = await registry.execute(invocation, "guest-1");

    expect(resolution).toMatchObject({ state: "grounding_available", detail: "ok" });
    expect(resolution.research?.results[0]?.url).toBe("https://example.com/articles/42");
    expect(researchBroker.researchSite).not.toHaveBeenCalled();
    expect(pageReader.read).toHaveBeenCalledOnce();
    expect(pageReader.read).toHaveBeenCalledWith(request, "guest-1");
  });

  it("reads an explicit root exactly when the trusted plan did not request same-site discovery", async () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    const root = "https://example.com/";
    const request = pageRequest(root);
    const { registry, pageReader, researchBroker } = createHarness({ resolveTarget: request });
    pageReader.read.mockResolvedValue(pagePacket(root));
    const invocation = registry.compile(
      analysisFor("read_url", { searchMode: null }),
      compileContext(candidateSet(root)),
    )!;

    expect(invocation).not.toHaveProperty("siteResearch");
    expect(await registry.execute(invocation, "guest-1")).toMatchObject({
      state: "grounding_available",
      research: { results: [{ url: root }] },
    });
    expect(researchBroker.researchSite).not.toHaveBeenCalled();
    expect(pageReader.read).toHaveBeenCalledWith(request, "guest-1");
  });

  it("expands bounded same-site results for an explicit root URL before reading the root", async () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    const root = "https://example.com/";
    const deep = "https://example.com/news/item-42";
    const request = pageRequest(root);
    const { registry, pageReader, researchBroker } = createHarness({ resolveTarget: request });
    researchBroker.researchSite.mockResolvedValue(siteSearchPacket(root, deep));
    pageReader.read.mockImplementation(async (candidate: PageReadRequest) =>
      candidate.url?.toString() === deep ? pagePacket(deep) : undefined);
    const invocation = registry.compile(
      analysisFor("read_url", { goal: "find the latest relevant item", searchMode: "web" }),
      compileContext(candidateSet(root)),
    )!;

    const resolution = await registry.execute(invocation, "guest-1");

    expect(researchBroker.researchSite).toHaveBeenCalledWith({
      url: new URL(root),
      query: "find the latest relevant item",
      mode: "web",
      requesterId: "guest-1",
      cachePolicy: "default",
    });
    expect(pageReader.read).toHaveBeenCalledOnce();
    expect(pageReader.read.mock.calls[0]?.[0]).toMatchObject({
      url: new URL(deep),
      initiator: "automatic",
    });
    expect(resolution).toMatchObject({ state: "grounding_available", detail: "ok" });
    expect(resolution.research?.results[0]?.url).toBe(deep);
    expect(resolution.responsePolicy).toMatchObject({
      citations: "model_selected",
      linkCard: "selected",
      maxSources: 2,
    });
  });

  it("falls back to the exact root after same-site expansion yields no answer-bearing page", async () => {
    vi.stubEnv("LINK_READER_ENABLED", "true");
    const root = "https://example.com/";
    const deep = "https://example.com/news/item-42";
    const request = pageRequest(root);
    const { registry, pageReader, researchBroker } = createHarness({ resolveTarget: request });
    researchBroker.researchSite.mockResolvedValue(siteSearchPacket(root, deep));
    pageReader.read.mockImplementation(async (candidate: PageReadRequest) => {
      if (candidate.url?.toString() === root) return pagePacket(root);
      return undefined;
    });
    const invocation = registry.compile(
      analysisFor("read_url", { goal: "find the latest relevant item", searchMode: "web" }),
      compileContext(candidateSet(root)),
    )!;

    const resolution = await registry.execute(invocation, "guest-1");

    expect(pageReader.read.mock.calls.map(([candidate]) => candidate.url?.toString())).toEqual([deep, root]);
    expect(resolution).toMatchObject({ state: "grounding_available", detail: "ok" });
    expect(resolution.research?.results[0]?.url).toBe(root);
  });

  it("distinguishes answer-bearing web-search expansion from retrieved metadata", async () => {
    vi.stubEnv("RESEARCH_ENABLED", "true");
    const sourceUrl = "https://facts.example.org/report";
    const { registry, pageReader, researchBroker } = createHarness();
    researchBroker.research.mockResolvedValue(searchPacket(sourceUrl));
    const invocation = registry.compile(analysisFor("web_search"), compileContext())!;

    pageReader.read.mockResolvedValueOnce(pagePacket(sourceUrl));
    const answer = await registry.execute(invocation, "runtime-requester");
    pageReader.read.mockResolvedValueOnce(undefined);
    const metadataOnly = await registry.execute(invocation, "runtime-requester");

    expect(researchBroker.research).toHaveBeenCalledWith({
      query: "f\u00e4rska externa fakta",
      mode: "web",
      requesterId: "runtime-requester",
    });
    expect(answer).toMatchObject({ state: "grounding_available", detail: "ok" });
    expect(answer.research).toMatchObject({
      kind: "page",
      results: [{ id: "S1", url: sourceUrl, snippet: "Concrete evidence from S1" }],
    });
    expect(metadataOnly).toMatchObject({
      invocation,
      state: "retrieved_only",
      responsePolicy: invocation.responsePolicy,
      detail: "retrieved_without_grounding",
    });
    expect(metadataOnly).not.toHaveProperty("research");
  });

  it("propagates retry intent through both search metadata and page expansion caches", async () => {
    vi.stubEnv("RESEARCH_ENABLED", "true");
    const sourceUrl = "https://facts.example.org/retry-report";
    const { registry, pageReader, researchBroker } = createHarness();
    researchBroker.research.mockResolvedValue(searchPacket(sourceUrl));
    pageReader.read.mockResolvedValue(pagePacket(sourceUrl));
    const invocation = registry.compile(
      analysisFor("web_search", { requestKind: "retry" }),
      compileContext(),
    )!;

    expect(await registry.execute(invocation, "runtime-requester")).toMatchObject({ state: "grounding_available" });
    expect(researchBroker.research).toHaveBeenCalledWith({
      query: "färska externa fakta",
      mode: "web",
      requesterId: "runtime-requester",
      cachePolicy: "bypass",
    });
    expect(pageReader.read).toHaveBeenCalledWith(
      expect.objectContaining({ url: new URL(sourceUrl), retry: true, initiator: "automatic" }),
      "runtime-requester",
    );
  });

  it("uses only the typed weather provider on success and on failure", async () => {
    const weather = {
      forecast: vi.fn()
        .mockResolvedValueOnce(forecast)
        .mockRejectedValueOnce(new Error("provider unavailable")),
    };
    const { registry, researchBroker } = createHarness({ weather });
    const invocation = registry.compile(analysisFor("weather_forecast"), compileContext())!;

    const success = await registry.execute(invocation, "guest-1");
    const failure = await registry.execute(invocation, "guest-1");

    expect(weather.forecast).toHaveBeenNthCalledWith(1, { location: "G\u00f6teborg", requesterId: "guest-1" });
    expect(success).toMatchObject({
      state: "grounding_available",
      research: { kind: "weather", results: [{ id: "S1", title: expect.stringContaining("G\u00f6teborg") }] },
    });
    const structured = JSON.parse(success.research!.results[0]!.snippet) as Record<string, unknown>;
    expect(structured).toMatchObject({
      provider: "open-meteo",
      temperatureTrend: { direction: "cooler", change: -2.1 },
      daily: [{ temperatureMax: 22.4, weatherDescription: "partly cloudy" }],
    });
    expect(failure).toMatchObject({ state: "failed_temporary", detail: "empty" });
    expect(failure).not.toHaveProperty("research");
    expect(researchBroker.research).not.toHaveBeenCalled();
    expect(researchBroker.researchSite).not.toHaveBeenCalled();
  });

  it("resolves and refreshes a deterministic server clock without sources", async () => {
    const { registry } = createHarness();
    const invocation = registry.compile(analysisFor("local_datetime"), compileContext())!;
    const resolution = await registry.execute(invocation, "guest-1");

    expect(resolution).toMatchObject({
      state: "grounding_available",
      requestedClock: {
        timeZone: "Europe/Stockholm",
        locationLabel: "Stockholm",
        languageTag: "sv",
        instant: "2026-07-15T12:00:00.000Z",
        localTime: "14:00:00",
      },
    });
    expect(registry.sourceIds(resolution, ["S1"], true)).toEqual([]);
    expect(registry.deterministicFallback(
      resolution,
      new Date("2026-07-15T13:05:00.000Z"),
    )).toEqual({
      content: expect.stringContaining("15:05:00"),
      sourceIds: [],
    });

    const invalid = registry.compile(
      analysisFor("local_datetime", { timeZone: "not/a-zone" }),
      compileContext(),
    )!;
    expect(await registry.execute(invalid, "guest-1")).toMatchObject({
      state: "failed_temporary",
      detail: "invalid_target",
    });
    expect(registry.deterministicFallback(undefined)).toBeUndefined();
  });

  it("enforces primary, selected and no-source citation policies", async () => {
    vi.stubEnv("RESEARCH_ENABLED", "true");
    const { registry } = createHarness();
    const sources = pagePacket("https://sources.example.org/one", [
      result("S1", "https://sources.example.org/one"),
      result("S2", "https://sources.example.org/two"),
      result("S3", "https://sources.example.org/three"),
      result("S4", "https://sources.example.org/four"),
    ]);
    const readInvocation = registry.planAutomaticRead(
      pageRequest("https://sources.example.org/one"),
      "read it",
    );
    const webInvocation = registry.compile(analysisFor("web_search"), compileContext())!;
    const clockInvocation = registry.compile(analysisFor("local_datetime"), compileContext())!;
    const readResolution: EvidenceResolution = {
      invocation: readInvocation,
      state: "grounding_available",
      research: sources,
      responsePolicy: readInvocation.responsePolicy,
      detail: "ok",
    };
    const webResolution: EvidenceResolution = {
      invocation: webInvocation,
      state: "grounding_available",
      research: sources,
      responsePolicy: webInvocation.responsePolicy,
      detail: "ok",
    };
    const clockResolution = await registry.execute(clockInvocation, "guest-1");
    const opaquePrimaryPacket = pagePacket("https://sources.example.org/opaque", [
      result("page-source-17", "https://sources.example.org/opaque"),
    ]);
    const opaquePrimaryResolution: EvidenceResolution = {
      invocation: readInvocation,
      state: "grounding_available",
      research: opaquePrimaryPacket,
      responsePolicy: readInvocation.responsePolicy,
      detail: "ok",
    };

    expect(registry.sourceIds(readResolution, ["S4", "S2"], true)).toEqual(["S1"]);
    expect(registry.requiresDesignatedResponder(readResolution)).toBe(true);
    expect(registry.requiresDesignatedResponder(undefined)).toBe(false);
    expect(registry.sourceIds(opaquePrimaryResolution, [], true)).toEqual(["page-source-17"]);
    expect(registry.sourceIds(readResolution, ["S1"], false)).toEqual([]);
    expect(registry.sourceIds(webResolution, ["S4", "S2", "S4", "unknown", "S1", "S3"], true)).toEqual([
      "S4",
      "S2",
      "S1",
    ]);
    expect(registry.sourceIds(clockResolution, ["S1"], true)).toEqual([]);
    expect(registry.sourceIds({ ...webResolution, state: "retrieved_only", research: undefined }, ["S1"], true)).toEqual([]);
    expect(registry.linkCardSourceId(readResolution, ["S1"])).toBe("S1");
    expect(registry.linkCardSourceId(readResolution, [])).toBeUndefined();
    expect(registry.linkCardSourceId(opaquePrimaryResolution, ["page-source-17"])).toBe("page-source-17");
    expect(registry.linkCardSourceId(webResolution, ["S4", "S2"])).toBe("S4");
    expect(registry.linkCardSourceId(clockResolution, [])).toBeUndefined();
    expect(registry.linkCardSourceId(
      { ...webResolution, state: "retrieved_only", research: undefined },
      ["S1"],
    )).toBeUndefined();
  });

  it("plans automatic reads as bounded exact-page work with automatic presentation", async () => {
    const root = "https://example.com/";
    const { registry, pageReader, researchBroker } = createHarness();
    pageReader.read.mockResolvedValue(pagePacket(root));
    const invocation = registry.planAutomaticRead(
      pageRequest(root, { initiator: "explicit" }),
      `  ${"g".repeat(400)}  `,
    );

    expect(invocation).toMatchObject({
      capability: "read_url",
      requestKind: "execute",
      externalEvidence: true,
      requiresResearchPersona: false,
      responsePolicy: {
        owner: "designated_responder",
        citations: "force_primary",
        linkCard: "primary",
        maxSources: 1,
      },
      pageReadRequest: { url: new URL(root), initiator: "automatic" },
    });
    expect(invocation.goal).toHaveLength(240);

    const resolution = await registry.execute(invocation, "guest-1");
    const scene = registry.sceneContract(invocation, resolution, { actorName: "Mira" });

    expect(researchBroker.researchSite).not.toHaveBeenCalled();
    expect(pageReader.read).toHaveBeenCalledWith(
      expect.objectContaining({ url: new URL(root), initiator: "automatic" }),
      "guest-1",
    );
    expect(scene).toMatchObject({
      evidenceOutcome: "succeeded",
      urlPublicationPolicy: "server_card",
      externalEvidence: true,
      premise: expect.stringContaining("opened the exact server-bound page that the human just shared"),
      groundingInstruction: expect.stringContaining("one concise, natural comment"),
    });
    expect(registry.sourceIds(resolution, [], true)).toEqual(["S1"]);

    pageReader.read.mockResolvedValueOnce(undefined);
    const failedResolution = await registry.execute(
      registry.planAutomaticRead(pageRequest("https://example.com/missing"), "inspect it"),
      "guest-1",
    );
    const silentFailure = registry.sceneContract(
      failedResolution.invocation,
      failedResolution,
      { actorName: "Mira" },
    );
    expect(silentFailure).toMatchObject({
      evidenceOutcome: "failed",
      suppressResponse: true,
    });
    expect(silentFailure).not.toHaveProperty("urlPublicationPolicy");

    const requiredFailure = registry.sceneContract(
      failedResolution.invocation,
      failedResolution,
      { actorName: "Mira", failureReplyRequired: true },
    );
    expect(requiredFailure).toMatchObject({
      evidenceOutcome: "failed",
      suppressResponse: false,
      premise: expect.stringContaining("returned no readable evidence"),
    });
    expect(requiredFailure).not.toHaveProperty("research");
    expect(requiredFailure).not.toHaveProperty("urlPublicationPolicy");

    const emptyGoal = registry.planAutomaticRead(pageRequest(root), "   ");
    expect(emptyGoal.goal).toBe("shared page");
    const otherRead = registry.planAutomaticRead(
      pageRequest("https://example.com/other"),
      "inspect another page",
    );
    expect(() => registry.sceneContract(otherRead, resolution, { actorName: "Mira" })).toThrow(
      "Capability resolution does not match its invocation",
    );
  });
});
