import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PageReadCandidateSet,
  PageReadRequest,
  PageReader,
} from "../pageReader.js";
import type { ResearchBroker, ResearchPacket } from "../researchBroker.js";
import { createFailClosedTurnAnalysis, type TurnAnalysis } from "../semanticRouter.js";
import type { WeatherForecastResult } from "../weatherForecast.js";
import type { FootballCompetitionSnapshot } from "../footballCompetition.js";
import {
  FOOTBALL_DATA_VIEWS,
  type FootballDataView,
} from "../footballData/catalog.js";
import {
  MARKET_INDEX_CATALOG,
  isMarketIndexId,
  marketIndexIdsForTarget,
  type MarketIndexId,
  type MarketTargetId,
} from "../marketData/catalog.js";
import type { MarketObservation, MarketSnapshot } from "../marketData/types.js";
import { TURN_CAPABILITIES, type TurnCapability } from "./catalog.js";
import {
  CapabilityRegistry,
  type CapabilityCompileContext,
  type EvidenceResolution,
  type FootballCompetitionCapabilityProvider,
  type MarketSnapshotCapabilityProvider,
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

const marketObservation = (
  indexId: MarketIndexId,
  providerId = "test-market",
): MarketObservation => {
  const definition = MARKET_INDEX_CATALOG[indexId];
  const observedAt = NOW - 60 * 60_000;
  const level = 3_150;
  const previousClose = 3_100;
  return {
    indexId,
    displayName: definition.displayName,
    shortName: definition.shortName,
    region: definition.region,
    countryCode: definition.countryCode,
    exchangeTimeZone: definition.exchangeTimeZone,
    tradingDate: "2026-07-15",
    currency: definition.currency,
    level,
    previousClose,
    change: level - previousClose,
    changePercent: (level - previousClose) / previousClose * 100,
    changeBasis: "previous_close",
    freshness: {
      status: "recent",
      observedAt: new Date(observedAt).toISOString(),
      ageMs: NOW - observedAt,
    },
    provider: {
      id: providerId,
      experimental: false,
      sourceUrl: `https://example.com/markets/${indexId}`,
      retrievedAt: new Date(NOW).toISOString(),
    },
  };
};

const marketSnapshot = (
  targetId: MarketTargetId,
  availableIds: readonly MarketIndexId[] = marketIndexIdsForTarget(targetId),
): MarketSnapshot => {
  const requestedIndexIds = marketIndexIdsForTarget(targetId);
  const observations = requestedIndexIds
    .filter((id) => availableIds.includes(id))
    .map((id) => marketObservation(id));
  const missingIndexIds = requestedIndexIds.filter((id) => !availableIds.includes(id));
  return {
    targetId,
    targetKind: isMarketIndexId(targetId) ? "index" : "basket",
    retrievedAt: new Date(NOW).toISOString(),
    requestedIndexIds,
    observations,
    missingIndexIds,
    coverage: {
      requested: requestedIndexIds.length,
      available: observations.length,
      ratio: observations.length / requestedIndexIds.length,
      complete: observations.length === requestedIndexIds.length,
      recent: observations.length,
      previousSession: 0,
      stale: 0,
    },
    providerAttempts: [{
      providerId: "test-market",
      status: observations.length === requestedIndexIds.length ? "complete" : observations.length ? "partial" : "failed",
      requested: requestedIndexIds.length,
      accepted: observations.length,
    }],
  };
};

const footballSnapshot = (
  view: FootballDataView = "overview",
  focus?: string,
): FootballCompetitionSnapshot => ({
  provider: "openfootball-live",
  targetId: "FIFA_WC_2026",
  competition: {
    name: "FIFA World Cup 2026",
    startDate: "2026-06-11",
    endDate: "2026-07-19",
    hosts: ["Canada", "Mexico", "United States"],
    teams: 48,
    scheduledMatches: 104,
    lifecycle: "ongoing",
  },
  retrievedAt: new Date(NOW).toISOString(),
  sourceUrl: "https://github.com/upbound-web/worldcup-live.json/blob/master/2026/worldcup.json",
  latency: "community-updated-within-hours-not-live",
  view,
  displayTimeZone: "Europe/Stockholm",
  ...(focus ? { focus } : {}),
  coverage: {
    totalMatches: 104,
    matchingMatches: focus ? 3 : 104,
    finished: 1,
    awaitingResult: 1,
    scheduled: 1,
  },
  recentResults: [{
    fixtureKey: "2026-07-14T19:00:00.000Z|France|Spain",
    kickoffUtc: "2026-07-14T19:00:00.000Z",
    providerLocalDate: "2026-07-14",
    providerLocalTime: "12:00 UTC-7",
    status: "finished",
    round: "Semi-finals",
    homeTeam: "France",
    awayTeam: "Spain",
    score: { halftime: [1, 1], fulltime: [2, 1] },
    venue: "MetLife Stadium",
  }],
  awaitingResults: [{
    fixtureKey: "2026-07-15T10:00:00.000Z|Sweden|Brazil",
    kickoffUtc: "2026-07-15T10:00:00.000Z",
    providerLocalDate: "2026-07-15",
    providerLocalTime: "03:00 UTC-7",
    status: "awaiting_result",
    round: "Semi-finals",
    homeTeam: "Sweden",
    awayTeam: "Brazil",
    venue: "SoFi Stadium",
  }],
  upcomingMatches: [{
    fixtureKey: "2026-07-15T19:00:00.000Z|England|Argentina",
    kickoffUtc: "2026-07-15T19:00:00.000Z",
    providerLocalDate: "2026-07-15",
    providerLocalTime: "12:00 UTC-7",
    status: "scheduled",
    round: "Semi-finals",
    homeTeam: "England",
    awayTeam: "Argentina",
    venue: "AT&T Stadium",
  }],
  groupStandings: [{
    group: "Group A",
    rankingBasis: "provisional_points_goal_difference_goals_for",
    rows: [{
      position: 1,
      team: "Sweden",
      played: 3,
      won: 2,
      drawn: 1,
      lost: 0,
      goalsFor: 6,
      goalsAgainst: 2,
      goalDifference: 4,
      points: 7,
    }],
  }],
});

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
  competitionTarget?: TurnAnalysis["evidence"]["competitionTarget"];
  footballView?: TurnAnalysis["evidence"]["footballView"];
  footballFilter?: string | null;
  languageTag?: string;
  responseLanguageTag?: string;
  languageConfidence?: number;
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
    language: {
      tag: overrides.languageTag ?? "sv",
      confidence: overrides.languageConfidence ?? 0.99,
    },
    responseLanguage: {
      tag: overrides.responseLanguageTag ?? overrides.languageTag ?? "sv",
      confidence: overrides.languageConfidence ?? 0.99,
    },
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
        ? action === "local_datetime" ? "Stockholm"
          : action === "weather_forecast" ? "G\u00f6teborg"
            : action === "market_snapshot" ? "SE_OMXS30"
              : null
        : overrides.locationLabel,
      competitionTarget: overrides.competitionTarget === undefined
        ? action === "football_data" ? "FIFA_WC_2026" : null
        : overrides.competitionTarget,
      footballView: overrides.footballView === undefined
        ? action === "football_data" ? "overview" : null
        : overrides.footballView,
      footballFilter: overrides.footballFilter ?? null,
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
  defaultMarket?: boolean;
  defaultFootball?: boolean;
  market?: MarketSnapshotCapabilityProvider | null;
  football?: FootballCompetitionCapabilityProvider | null;
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
    marketSnapshotProvider: options.defaultMarket ? undefined : options.market === undefined ? null : options.market,
    footballCompetitionProvider: options.defaultFootball
      ? undefined
      : options.football === undefined ? null : options.football,
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
    const market: MarketSnapshotCapabilityProvider = {
      snapshot: vi.fn(async ({ targetId }) => marketSnapshot(targetId)),
    };
    const football: FootballCompetitionCapabilityProvider = {
      snapshot: vi.fn(async ({ view, focus }) => footballSnapshot(view, focus)),
    };
    const { registry } = createHarness({ market, football, weather });

    expect(registry.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual(TURN_CAPABILITIES);
    expect(registry.hasExternalEvidence(TURN_CAPABILITIES)).toBe(true);
    expect(registry.hasExternalEvidence(["local_datetime"])).toBe(false);

    expect(registry.available({ medium: "public", candidateSet: emptyCandidateSet(), allowSearch: false })).toEqual([
      "market_snapshot",
      "football_data",
      "local_datetime",
      "weather_forecast",
    ]);

    vi.stubEnv("LINK_READER_ENABLED", "false");
    vi.stubEnv("RESEARCH_ENABLED", "false");
    expect(registry.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual([
      "market_snapshot",
      "football_data",
      "local_datetime",
      "weather_forecast",
    ]);

    const defaultMarket = createHarness({ defaultMarket: true }).registry;
    expect(defaultMarket.available({ medium: "public", candidateSet: emptyCandidateSet(), allowSearch: false })).toEqual([
      "market_snapshot",
      "local_datetime",
    ]);

    const noWeather = createHarness({ weather: null }).registry;
    expect(noWeather.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual(["local_datetime"]);

    vi.stubEnv("MARKET_SNAPSHOT_ENABLED", "false");
    const disabledMarket = createHarness({ market, football, weather }).registry;
    expect(disabledMarket.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual([
      "football_data",
      "local_datetime",
      "weather_forecast",
    ]);

    vi.stubEnv("FOOTBALL_DATA_ENABLED", "false");
    const disabledFootball = createHarness({ market, football, weather }).registry;
    expect(disabledFootball.available({ medium: "public", candidateSet: candidateSet(), allowSearch: true })).toEqual([
      "local_datetime",
      "weather_forecast",
    ]);
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
    expect(registry.compile(analysisFor("market_snapshot"), voiceContext)).toBeUndefined();
    expect(registry.compile(analysisFor("football_data"), voiceContext)).toBeUndefined();
    expect(registry.compile(analysisFor("weather_forecast"), voiceContext)).toBeUndefined();
  });

  it("executes canonical exact-index and fixed-basket snapshots without using PageReader", async () => {
    vi.stubEnv("LINK_READER_ENABLED", "false");
    const market: MarketSnapshotCapabilityProvider = {
      snapshot: vi.fn(async ({ targetId }) => marketSnapshot(targetId)),
    };
    const { registry, pageReader } = createHarness({ market });

    const invocation = registry.compile(analysisFor("market_snapshot"), compileContext())!;
    expect(invocation).toMatchObject({
      capability: "market_snapshot",
      marketTargetId: "SE_OMXS30",
      requiresResearchPersona: false,
      responsePolicy: { citations: "model_selected", maxSources: 3 },
    });
    expect(registry.compile(
      analysisFor("market_snapshot", { locationLabel: "OMXS30" }),
      compileContext(),
    )).toBeUndefined();

    const resolution = await registry.execute(invocation, "guest-1");
    expect(pageReader.read).not.toHaveBeenCalled();
    expect(market.snapshot).toHaveBeenCalledWith({ targetId: "SE_OMXS30" });
    expect(resolution).toMatchObject({
      state: "grounding_available",
      research: {
        kind: "market",
        query: "SE_OMXS30",
        results: [{
          id: "S1",
          url: "https://example.com/markets/SE_OMXS30",
          publishedAt: new Date(NOW - 60 * 60_000).toISOString(),
        }],
      },
    });
    const exactEvidence = JSON.parse(
      resolution.state === "grounding_available" ? resolution.research!.results[0]!.snippet : "{}",
    );
    expect(exactEvidence).toMatchObject({
      sourceKind: "market_snapshot",
      target: { id: "SE_OMXS30", kind: "index" },
      coverage: { requested: 1, available: 1, complete: true },
      observation: {
        indexId: "SE_OMXS30",
        changeBasis: "previous_close",
        freshness: { status: "recent", observedAt: new Date(NOW - 60 * 60_000).toISOString() },
        provider: { id: "test-market", experimental: false },
      },
    });
    expect(exactEvidence.observation.provider).not.toHaveProperty("sourceUrl");
    expect(registry.sceneContract(invocation, resolution, { actorName: "Vale" })).toMatchObject({
      evidenceOutcome: "succeeded",
      urlPublicationPolicy: "server_card",
      premise: expect.stringContaining("provider-neutral validated market snapshot"),
    });

    const basketInvocation = registry.compile(
      analysisFor("market_snapshot", { locationLabel: "GLOBAL_MAJOR" }),
      compileContext(),
    )!;
    const basketResolution = await registry.execute(basketInvocation, "guest-2");
    expect(basketResolution).toMatchObject({
      state: "grounding_available",
      research: { kind: "market", results: expect.arrayContaining([expect.objectContaining({ id: "S1" })]) },
    });
    if (basketResolution.state !== "grounding_available" || !basketResolution.research) {
      throw new Error("expected grounded basket evidence");
    }
    expect(basketResolution.research.results).toHaveLength(8);
    expect(JSON.parse(basketResolution.research.results[0]!.snippet)).toMatchObject({
      target: { id: "GLOBAL_MAJOR", kind: "basket" },
      coverage: { requested: 8, available: 8, complete: true },
      missingIndexIds: [],
    });

    const retryInvocation = registry.compile(
      analysisFor("market_snapshot", { requestKind: "retry" }),
      compileContext(),
    )!;
    await registry.execute(retryInvocation, "guest-3");
    expect(market.snapshot).toHaveBeenLastCalledWith({ targetId: "SE_OMXS30", cachePolicy: "bypass" });
  });

  it("fails closed when a typed market provider returns no rows or a mismatched target", async () => {
    const market: MarketSnapshotCapabilityProvider = {
      snapshot: vi.fn(async ({ targetId }) => marketSnapshot(targetId, [])),
    };
    const { registry } = createHarness({ market });
    const invocation = registry.compile(analysisFor("market_snapshot"), compileContext())!;
    await expect(registry.execute(invocation, "guest-empty")).resolves.toMatchObject({
      state: "failed_temporary",
      detail: "empty",
    });

    market.snapshot = vi.fn(async () => marketSnapshot("US_SP500"));
    await expect(registry.execute(invocation, "guest-mismatch")).resolves.toMatchObject({
      state: "failed_temporary",
      detail: "empty",
    });
  });

  it("removes stale rows and requires representative basket coverage", async () => {
    const stale = marketSnapshot("SE_OMXS30");
    const staleObservation = stale.observations[0]!;
    const staleSnapshot: MarketSnapshot = {
      ...stale,
      observations: [{
        ...staleObservation,
        freshness: {
          status: "stale",
          observedAt: new Date(NOW - 5 * 24 * 60 * 60_000).toISOString(),
          ageMs: 5 * 24 * 60 * 60_000,
        },
      }],
      coverage: { ...stale.coverage, recent: 0, stale: 1 },
    };
    const market: MarketSnapshotCapabilityProvider = { snapshot: vi.fn(async () => staleSnapshot) };
    const { registry } = createHarness({ market });
    const exactInvocation = registry.compile(analysisFor("market_snapshot"), compileContext())!;
    await expect(registry.execute(exactInvocation, "guest-stale")).resolves.toMatchObject({
      state: "failed_temporary",
      detail: "empty",
    });

    const globalIds = marketIndexIdsForTarget("GLOBAL_MAJOR");
    market.snapshot = vi.fn(async () => marketSnapshot("GLOBAL_MAJOR", globalIds.slice(0, 4)));
    const basketInvocation = registry.compile(
      analysisFor("market_snapshot", { locationLabel: "GLOBAL_MAJOR" }),
      compileContext(),
    )!;
    await expect(registry.execute(basketInvocation, "guest-thin-basket")).resolves.toMatchObject({
      state: "failed_temporary",
      detail: "empty",
    });

    market.snapshot = vi.fn(async () => marketSnapshot("GLOBAL_MAJOR", globalIds.slice(0, 5)));
    const grounded = await registry.execute(basketInvocation, "guest-covered-basket");
    expect(grounded).toMatchObject({
      state: "grounding_available",
      research: { results: expect.any(Array) },
    });
    if (grounded.state !== "grounding_available" || !grounded.research) throw new Error("expected market evidence");
    expect(grounded.research.results).toHaveLength(5);
    expect(JSON.parse(grounded.research.results[0]!.snippet)).toMatchObject({
      coverage: { requested: 8, available: 5, complete: false, stale: 0 },
      missingIndexIds: globalIds.slice(5),
    });
  });

  it("compiles and executes every registered football view through the typed provider", async () => {
    const football: FootballCompetitionCapabilityProvider = {
      snapshot: vi.fn(async ({ view, focus }) => footballSnapshot(view, focus)),
    };
    const { registry, pageReader, researchBroker } = createHarness({ football });

    for (const view of FOOTBALL_DATA_VIEWS) {
      const invocation = registry.compile(analysisFor("football_data", { footballView: view }), compileContext())!;
      expect(invocation).toMatchObject({
        capability: "football_data",
        competitionId: "FIFA_WC_2026",
        view,
        requiresResearchPersona: false,
        responsePolicy: {
          citations: "force_primary",
          linkCard: "primary",
          maxSources: 1,
        },
      });
      await expect(registry.execute(invocation, `guest-${view}`)).resolves.toMatchObject({
        state: "grounding_available",
        research: {
          kind: "football",
          query: `FIFA_WC_2026:${view}`,
          results: [{
            id: "S1",
            url: "https://github.com/upbound-web/worldcup-live.json/blob/master/2026/worldcup.json",
          }],
        },
      });
    }

    const filtered = registry.compile(analysisFor("football_data", {
      footballView: "upcoming",
      footballFilter: "  Sweden  ",
    }), compileContext())!;
    expect(filtered).toMatchObject({
      capability: "football_data",
      competitionId: "FIFA_WC_2026",
      view: "upcoming",
      focus: "Sweden",
    });
    const resolution = await registry.execute(filtered, "guest-filtered");
    expect(football.snapshot).toHaveBeenLastCalledWith({
      targetId: "FIFA_WC_2026",
      view: "upcoming",
      focus: "Sweden",
      requesterId: "guest-filtered",
    });
    expect(pageReader.read).not.toHaveBeenCalled();
    expect(researchBroker.research).not.toHaveBeenCalled();
    expect(researchBroker.researchSite).not.toHaveBeenCalled();
    if (resolution.state !== "grounding_available" || !resolution.research) {
      throw new Error("expected grounded football evidence");
    }
    const evidence = JSON.parse(resolution.research.results[0]!.snippet) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      provider: "openfootball-live",
      latency: "community-updated-within-hours-not-live",
      displayTimeZone: "Europe/Stockholm",
      requested: {
        competition: "FIFA_WC_2026",
        view: "upcoming",
        focus: "Sweden",
      },
      coverage: { totalMatches: 104, matchingMatches: 3 },
      recentResults: [{
        home: "France",
        away: "Spain",
        status: "finished",
        score: { ht: [1, 1], ft: [2, 1] },
      }],
      awaitingResults: [{ home: "Sweden", away: "Brazil", status: "awaiting_result" }],
      upcomingMatches: [{ home: "England", away: "Argentina", status: "scheduled" }],
      groupStandings: [{
        group: "Group A",
        rankingBasis: "provisional_points_goal_difference_goals_for",
        rows: [{ team: "Sweden", p: 3, pts: 7 }],
      }],
    });
    expect(resolution.research.results[0]!.snippet).not.toContain("sourceUrl");
    expect(registry.sourceIds(resolution, [], true)).toEqual(["S1"]);
    expect(registry.linkCardSourceId(resolution, ["S1"])).toBe("S1");
    expect(registry.sceneContract(filtered, resolution, { actorName: "Mira" })).toMatchObject({
      evidenceOutcome: "succeeded",
      urlPublicationPolicy: "server_card",
      suppressResponse: false,
      premise: expect.stringContaining("validated provider-neutral football snapshot"),
      groundingInstruction: expect.stringContaining("Do not invent live minute"),
    });

    const retry = registry.compile(analysisFor("football_data", {
      footballView: "today",
      requestKind: "retry",
    }), compileContext())!;
    await registry.execute(retry, "guest-retry");
    expect(football.snapshot).toHaveBeenLastCalledWith({
      targetId: "FIFA_WC_2026",
      view: "today",
      requesterId: "guest-retry",
      cachePolicy: "bypass",
    });
  });

  it("fails football compilation and execution closed for foreign fields and invalid provider results", async () => {
    const football: FootballCompetitionCapabilityProvider = {
      snapshot: vi.fn(async ({ view }) => footballSnapshot(view)),
    };
    const { registry } = createHarness({ football });

    expect(registry.compile(analysisFor("football_data", {
      competitionTarget: "WORLD_CUP" as TurnAnalysis["evidence"]["competitionTarget"],
    }), compileContext())).toBeUndefined();
    expect(registry.compile(analysisFor("football_data", {
      footballView: "live" as TurnAnalysis["evidence"]["footballView"],
    }), compileContext())).toBeUndefined();
    expect(registry.compile(analysisFor("football_data", { query: "live score" }), compileContext())).toBeUndefined();
    expect(registry.compile(analysisFor("football_data", { locationLabel: "United States" }), compileContext()))
      .toBeUndefined();

    const invocation = registry.compile(analysisFor("football_data"), compileContext())!;
    football.snapshot = vi.fn(async () => footballSnapshot("today"));
    await expect(registry.execute(invocation, "guest-mismatch")).resolves.toMatchObject({
      state: "failed_temporary",
      detail: "empty",
    });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    football.snapshot = vi.fn(async () => { throw new Error("provider unavailable"); });
    const failure = await registry.execute(invocation, "guest-failure");
    expect(failure).toMatchObject({ state: "failed_temporary", detail: "empty" });
    expect(failure).not.toHaveProperty("research");
    expect(warning).toHaveBeenCalledWith("Typed football lookup failed safely:", "provider unavailable");
    expect(registry.sceneContract(invocation, failure, { actorName: "Mira" })).toMatchObject({
      evidenceOutcome: "failed",
      suppressResponse: false,
      premise: expect.stringContaining("returned no validated result this time"),
    });

    const unavailable = createHarness({ football: null }).registry;
    expect(unavailable.compile(analysisFor("football_data"), compileContext())).toBeUndefined();
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
    expect(registry.sceneContract(invocation, answer, { actorName: "Mira" }).groundingInstruction)
      .toContain("name that exact missing datum naturally");
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

    expect(weather.forecast).toHaveBeenNthCalledWith(1, {
      location: "G\u00f6teborg",
      languageTag: "sv",
      requesterId: "guest-1",
    });
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

  it("compiles optional weather aliases without replacing the display location and propagates trusted language", async () => {
    const weather = { forecast: vi.fn(async () => forecast) };
    const { registry } = createHarness({ weather });

    const plain = registry.compile(analysisFor("weather_forecast", {
      locationLabel: "Stockholm",
      query: null,
    }), compileContext())!;
    expect(plain).toMatchObject({
      capability: "weather_forecast",
      location: "Stockholm",
      languageTag: "sv",
    });
    expect(plain).not.toHaveProperty("providerQuery");

    const simpleAlias = registry.compile(analysisFor("weather_forecast", {
      locationLabel: "Stockholm",
      query: "Stockholm",
    }), compileContext())!;
    expect(simpleAlias).toMatchObject({
      capability: "weather_forecast",
      location: "Stockholm",
      providerQuery: "Stockholm",
      languageTag: "sv",
    });

    const nativeLabel = registry.compile(analysisFor("weather_forecast", {
      locationLabel: "札幌",
      query: "Sapporo",
      languageTag: "ja",
      responseLanguageTag: "ja",
    }), compileContext())!;
    expect(nativeLabel).toMatchObject({
      capability: "weather_forecast",
      location: "札幌",
      providerQuery: "Sapporo",
      languageTag: "ja",
    });

    const untrustedLanguage = registry.compile(analysisFor("weather_forecast", {
      locationLabel: "Stockholm",
      query: null,
      languageTag: "sv",
      responseLanguageTag: "sv",
      languageConfidence: 0.69,
    }), compileContext())!;
    expect(untrustedLanguage).not.toHaveProperty("languageTag");

    await registry.execute(nativeLabel, "guest-ja");
    expect(weather.forecast).toHaveBeenCalledWith({
      location: "札幌",
      lookupQuery: "Sapporo",
      languageTag: "ja",
      requesterId: "guest-ja",
    });
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
      premise: expect.stringContaining("did not yield readable material for the requested answer this time"),
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
