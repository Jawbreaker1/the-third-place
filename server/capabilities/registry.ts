import {
  hasSpecificSiteResearchResults,
  type ResearchBroker,
  type ResearchPacket,
  type ResearchRequest,
  type SearchMode,
} from "../researchBroker.js";
import {
  type PageReadCandidateSet,
  type PageReadRequest,
  type PageReader,
} from "../pageReader.js";
import { resolveSearchEvidence } from "../evidenceResolver.js";
import {
  MARKET_INDEX_CATALOG,
  isMarketIndexId,
  isMarketTargetId,
  marketIndexIdsForTarget,
  type MarketTargetId,
} from "../marketData/catalog.js";
import { MarketSnapshotService } from "../marketData/service.js";
import type { MarketSnapshot } from "../marketData/types.js";
import {
  FootballCompetitionProvider,
  type FootballCompetitionSnapshot,
} from "../footballCompetition.js";
import {
  isFootballCompetitionId,
  isFootballDataView,
  type FootballCompetitionId,
  type FootballDataView,
} from "../footballData/catalog.js";
import { YahooChartMarketDataProvider } from "../marketData/providers/yahooChart.js";
import {
  refreshLocalDateTime,
  resolveLocalDateTime,
  type LocalDateTimeResult,
} from "../timeResolver.js";
import {
  WeatherForecastProvider,
  type WeatherForecastResult,
} from "../weatherForecast.js";
import {
  projectTrustedTurnAnalysis,
  type TurnAnalysis,
} from "../semanticRouter.js";
import {
  CAPABILITY_CATALOG,
  TURN_CAPABILITIES,
  hasExternalEvidenceCapability,
  validateCapabilityArgumentShape,
  type TurnCapability,
  type CapabilityMedium,
} from "./catalog.js";

export type { ResearchPacket } from "../researchBroker.js";
export type WeatherForecastCapabilityProvider = Pick<WeatherForecastProvider, "forecast">;
export type MarketSnapshotCapabilityProvider = Pick<MarketSnapshotService, "snapshot">;
export type FootballCompetitionCapabilityProvider = Pick<FootballCompetitionProvider, "snapshot">;

export type CapabilityExecutionRequestKind = "execute" | "retry" | "correct_limitation";
export type EvidenceResolutionState = "grounding_available" | "retrieved_only" | "failed_temporary";

export interface CapabilityResponsePolicy {
  owner: "designated_responder";
  citations: "none" | "force_primary" | "model_selected";
  linkCard: "none" | "primary" | "selected";
  maxSources: number;
}

interface CapabilityInvocationBase {
  capability: TurnCapability;
  goal: string;
  requestKind: CapabilityExecutionRequestKind;
  externalEvidence: boolean;
  requiresResearchPersona: boolean;
  responsePolicy: CapabilityResponsePolicy;
}

export interface ReadUrlInvocation extends CapabilityInvocationBase {
  capability: "read_url";
  pageReadRequest: PageReadRequest;
  siteResearch?: { goal: string; mode: SearchMode };
}

export interface WebSearchInvocation extends CapabilityInvocationBase {
  capability: "web_search";
  searchRequest: ResearchRequest;
}

export interface MarketSnapshotInvocation extends CapabilityInvocationBase {
  capability: "market_snapshot";
  marketTargetId: MarketTargetId;
}

export interface FootballDataInvocation extends CapabilityInvocationBase {
  capability: "football_data";
  competitionId: FootballCompetitionId;
  view: FootballDataView;
  focus?: string;
}

export interface LocalDateTimeInvocation extends CapabilityInvocationBase {
  capability: "local_datetime";
  timeZone: string;
  timeKind: "current_time" | "current_date" | "current_datetime";
  locationLabel: string;
  languageTag?: string;
}

export interface WeatherForecastInvocation extends CapabilityInvocationBase {
  capability: "weather_forecast";
  location: string;
  /** Optional provider-compatible fallback alias; the human-facing location is attempted first. */
  providerQuery?: string;
  languageTag?: string;
}

export type CapabilityInvocation =
  | ReadUrlInvocation
  | WebSearchInvocation
  | MarketSnapshotInvocation
  | FootballDataInvocation
  | LocalDateTimeInvocation
  | WeatherForecastInvocation;

interface EvidenceResolutionBase {
  invocation: CapabilityInvocation;
  state: EvidenceResolutionState;
  responsePolicy: CapabilityResponsePolicy;
  /** Server diagnostics only; never pass this value to the dialogue model. */
  detail:
    | "ok"
    | "empty"
    | "retrieved_without_grounding"
    | "invalid_target"
    | "transport";
}

export type EvidenceResolution =
  | (EvidenceResolutionBase & {
      state: "grounding_available";
      research: ResearchPacket;
      requestedClock?: never;
    })
  | (EvidenceResolutionBase & {
      state: "grounding_available";
      research?: never;
      requestedClock: LocalDateTimeResult;
    })
  | (EvidenceResolutionBase & {
      state: "retrieved_only" | "failed_temporary";
      research?: never;
      requestedClock?: never;
    });

export interface CapabilitySceneContract {
  research?: ResearchPacket;
  requestedClock?: LocalDateTimeResult;
  evidenceOutcome?: "succeeded" | "failed";
  urlPublicationPolicy?: "server_card";
  temporalPolicy?: "direct_answer";
  groundingInstruction: string;
  premise: string;
  externalEvidence: boolean;
  /** Whether this failed passive event may stay silent under trusted response-obligation policy. */
  suppressResponse: boolean;
  responsePolicy: CapabilityResponsePolicy;
}

export interface CapabilityAvailabilityContext {
  medium: CapabilityMedium;
  candidateSet: PageReadCandidateSet;
  allowSearch: boolean;
  /** Optional medium-owned inventory cap; adapters outside it remain unavailable. */
  inventory?: readonly TurnCapability[];
}

export interface CapabilityCompileContext extends CapabilityAvailabilityContext {
  intent: string;
  requesterId: string;
}

interface CapabilityRuntimeDependencies {
  pageReader: PageReader;
  researchBroker: Pick<ResearchBroker, "research" | "researchSite">;
  marketSnapshotProvider?: MarketSnapshotCapabilityProvider;
  footballCompetitionProvider?: FootballCompetitionCapabilityProvider;
  weatherForecastProvider?: WeatherForecastCapabilityProvider;
  now: () => number;
}

export interface CapabilityRegistryOptions {
  pageReader: PageReader;
  researchBroker: Pick<ResearchBroker, "research" | "researchSite">;
  marketSnapshotProvider?: MarketSnapshotCapabilityProvider | null;
  footballCompetitionProvider?: FootballCompetitionCapabilityProvider | null;
  weatherForecastProvider?: WeatherForecastCapabilityProvider | null;
  now?: () => number;
}

interface CapabilityPresentationContext {
  actorName: string;
  automatic?: boolean;
  /**
   * Server-owned social obligation from an exact address/reply or trusted
   * semantic response decision. Adapters may use it only to decide whether a
   * real failed attempt should be surfaced; it grants no execution authority.
   */
  failureReplyRequired?: boolean;
}

interface CapabilityAdapter<I extends CapabilityInvocation = CapabilityInvocation> {
  id: I["capability"];
  available(context: CapabilityAvailabilityContext, runtime: CapabilityRuntimeDependencies): boolean;
  compile(
    analysis: TurnAnalysis,
    context: CapabilityCompileContext,
    runtime: CapabilityRuntimeDependencies,
  ): I | undefined;
  execute(
    invocation: I,
    requesterId: string,
    runtime: CapabilityRuntimeDependencies,
  ): Promise<EvidenceResolution>;
  scene(
    invocation: I,
    resolution: EvidenceResolution,
    context: CapabilityPresentationContext,
  ): CapabilitySceneContract;
}

const executionKinds = new Set<CapabilityExecutionRequestKind>([
  "execute",
  "retry",
  "correct_limitation",
]);

const requestKindFor = (analysis: TurnAnalysis): CapabilityExecutionRequestKind | undefined => {
  const kind = analysis.capabilities.requestKind;
  return executionKinds.has(kind as CapabilityExecutionRequestKind)
    ? kind as CapabilityExecutionRequestKind
    : undefined;
};

const analysisArgumentShapeIsValid = (
  capability: TurnCapability,
  analysis: TurnAnalysis,
  candidateSet: PageReadCandidateSet,
): boolean => {
  const selectedCandidate = analysis.evidence.urlRef
    ? candidateSet.candidates.find((candidate) => candidate.id === analysis.evidence.urlRef)
    : undefined;
  const structuralRoot = Boolean(
    selectedCandidate?.url &&
    selectedCandidate.url.pathname === "/" &&
    selectedCandidate.url.search === "",
  );
  return validateCapabilityArgumentShape(capability, {
    q: analysis.evidence.query,
    u: analysis.evidence.urlRef,
    m: analysis.evidence.searchMode,
    z: analysis.evidence.timeZone,
    k: analysis.evidence.timeKind,
    l: analysis.evidence.locationLabel,
    c: analysis.evidence.competitionTarget,
    w: analysis.evidence.footballView,
    f: analysis.evidence.footballFilter,
  }, {
    activeConditions: structuralRoot ? ["structural_root_only"] : [],
  }).valid;
};

const baseInvocation = (
  capability: TurnCapability,
  analysis: TurnAnalysis,
  responsePolicy: CapabilityResponsePolicy,
  requiresResearchPersona: boolean,
): CapabilityInvocationBase | undefined => {
  const goal = analysis.evidence.goal?.trim();
  const requestKind = requestKindFor(analysis);
  if (!goal || !requestKind) return undefined;
  return {
    capability,
    goal,
    requestKind,
    externalEvidence: hasExternalEvidenceCapability([capability]),
    requiresResearchPersona,
    responsePolicy,
  };
};

const primarySourcePolicy: CapabilityResponsePolicy = Object.freeze({
  owner: "designated_responder",
  citations: "force_primary",
  linkCard: "primary",
  maxSources: 1,
});

const selectedSourcePolicy: CapabilityResponsePolicy = Object.freeze({
  owner: "designated_responder",
  citations: "model_selected",
  linkCard: "selected",
  maxSources: 3,
});

const marketSourcePolicy: CapabilityResponsePolicy = Object.freeze({
  owner: "designated_responder",
  citations: "model_selected",
  linkCard: "selected",
  maxSources: 3,
});

const boundedSiteSourcePolicy: CapabilityResponsePolicy = Object.freeze({
  owner: "designated_responder",
  citations: "model_selected",
  linkCard: "selected",
  maxSources: 2,
});

const noSourcePolicy: CapabilityResponsePolicy = Object.freeze({
  owner: "designated_responder",
  citations: "none",
  linkCard: "none",
  maxSources: 0,
});

const packetHasPrimaryContent = (packet: ResearchPacket | undefined): packet is ResearchPacket =>
  Boolean(packet?.results[0]?.id && packet.results[0].snippet.trim().length > 0);

const weatherCodeLabel = (code: number): string => ({
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snowfall",
  73: "moderate snowfall",
  75: "heavy snowfall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
}[code] ?? `WMO weather code ${code}`);

/** Converts validated fixed-provider data into the common evidence transport. */
export const weatherForecastEvidencePacket = (forecast: WeatherForecastResult): ResearchPacket => {
  const place = [forecast.resolved.place, forecast.resolved.admin, forecast.resolved.country]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join(", ");
  return {
    kind: "weather",
    query: forecast.query,
    retrievedAt: forecast.retrievedAt,
    results: [{
      id: "S1",
      title: `7-day Open-Meteo forecast for ${place}`,
      url: forecast.sourceUrl,
      snippet: JSON.stringify({
        provider: forecast.provider,
        resolvedLocation: {
          label: place,
          latitude: forecast.resolved.latitude,
          longitude: forecast.resolved.longitude,
          timezone: forecast.resolved.timezone,
        },
        units: forecast.units,
        daily: forecast.daily.map((day) => ({
          ...day,
          weatherDescription: weatherCodeLabel(day.weatherCode),
        })),
        temperatureTrend: forecast.temperatureTrend,
      }),
    }],
  };
};

/** Converts provider-neutral validated market observations into inert evidence rows. */
export const marketSnapshotEvidencePacket = (snapshot: MarketSnapshot): ResearchPacket => ({
  kind: "market",
  query: snapshot.targetId,
  retrievedAt: snapshot.retrievedAt,
  results: snapshot.observations.slice(0, 8).map((observation, index) => ({
    id: `S${index + 1}`,
    title: `${observation.displayName} latest reported market snapshot`,
    url: observation.provider.sourceUrl,
    publishedAt: observation.freshness.observedAt,
    snippet: JSON.stringify({
      sourceKind: "market_snapshot",
      target: {
        id: snapshot.targetId,
        kind: snapshot.targetKind,
      },
      snapshotRetrievedAt: snapshot.retrievedAt,
      coverage: snapshot.coverage,
      missingIndexIds: snapshot.missingIndexIds,
      observation: {
        indexId: observation.indexId,
        displayName: observation.displayName,
        shortName: observation.shortName,
        region: observation.region,
        countryCode: observation.countryCode,
        exchangeTimeZone: observation.exchangeTimeZone,
        tradingDate: observation.tradingDate,
        currency: observation.currency,
        level: observation.level,
        previousClose: observation.previousClose,
        change: observation.change,
        changePercent: observation.changePercent,
        changeBasis: observation.changeBasis,
        freshness: observation.freshness,
        provider: {
          id: observation.provider.id,
          experimental: observation.provider.experimental,
          retrievedAt: observation.provider.retrievedAt,
        },
      },
    }),
  })),
});

const compactFootballScore = (score: FootballCompetitionSnapshot["recentResults"][number]["score"]): unknown =>
  score ? {
    ...(score.halftime ? { ht: score.halftime } : {}),
    ...(score.fulltime ? { ft: score.fulltime } : {}),
    ...(score.extraTime ? { et: score.extraTime } : {}),
    ...(score.penalties ? { pens: score.penalties } : {}),
  } : undefined;

const compactFootballMatch = (match: FootballCompetitionSnapshot["recentResults"][number]) => ({
  kickoffUtc: match.kickoffUtc,
  status: match.status,
  round: match.round,
  ...(match.group ? { group: match.group } : {}),
  home: match.homeTeam,
  away: match.awayTeam,
  ...(match.score ? { score: compactFootballScore(match.score) } : {}),
  venue: match.venue,
});

/** Converts one validated provider batch into a bounded, provider-neutral evidence row. */
export const footballCompetitionEvidencePacket = (
  snapshot: FootballCompetitionSnapshot,
): ResearchPacket => ({
  kind: "football",
  query: `${snapshot.targetId}:${snapshot.view}${snapshot.focus ? `:${snapshot.focus}` : ""}`,
  retrievedAt: snapshot.retrievedAt,
  results: [{
    id: "S1",
    title: `${snapshot.competition.name} fixtures and latest reported results`,
    url: snapshot.sourceUrl,
    snippet: JSON.stringify({
      provider: snapshot.provider,
      retrievedAt: snapshot.retrievedAt,
      latency: snapshot.latency,
      displayTimeZone: snapshot.displayTimeZone,
      requested: {
        competition: snapshot.targetId,
        view: snapshot.view,
        ...(snapshot.focus ? { focus: snapshot.focus } : {}),
      },
      competition: snapshot.competition,
      coverage: snapshot.coverage,
      recentResults: snapshot.recentResults.map(compactFootballMatch),
      awaitingResults: snapshot.awaitingResults.map(compactFootballMatch),
      upcomingMatches: snapshot.upcomingMatches.map(compactFootballMatch),
      ...((snapshot.view === "standings" || snapshot.focus) ? {
        groupStandings: snapshot.groupStandings.map((table) => ({
          group: table.group,
          rankingBasis: table.rankingBasis,
          rows: table.rows.map((row) => ({
            pos: row.position,
            team: row.team,
            p: row.played,
            w: row.won,
            d: row.drawn,
            l: row.lost,
            gf: row.goalsFor,
            ga: row.goalsAgainst,
            gd: row.goalDifference,
            pts: row.points,
          })),
        })),
      } : {}),
    }),
  }],
});

const groundingAvailable = (
  invocation: CapabilityInvocation,
  research: ResearchPacket,
  responsePolicy = invocation.responsePolicy,
): EvidenceResolution => ({
  invocation,
  state: "grounding_available",
  research,
  responsePolicy,
  detail: "ok",
});

const resolvedClock = (
  invocation: CapabilityInvocation,
  requestedClock: LocalDateTimeResult,
): EvidenceResolution => ({
  invocation,
  state: "grounding_available",
  requestedClock,
  responsePolicy: invocation.responsePolicy,
  detail: "ok",
});

const retrievedOnly = (invocation: CapabilityInvocation): EvidenceResolution => ({
  invocation,
  state: "retrieved_only",
  responsePolicy: invocation.responsePolicy,
  detail: "retrieved_without_grounding",
});

const failed = (
  invocation: CapabilityInvocation,
  detail: EvidenceResolution["detail"] = "transport",
): EvidenceResolution => ({
  invocation,
  state: "failed_temporary",
  responsePolicy: invocation.responsePolicy,
  detail,
});

const readUrlAdapter: CapabilityAdapter<ReadUrlInvocation> = {
  id: "read_url",
  available: (context) => process.env.LINK_READER_ENABLED !== "false" && context.candidateSet.candidates.length > 0,
  compile: (analysis, context, runtime) => {
    if (analysis.evidence.action !== "read_url" || !analysis.evidence.urlRef) return undefined;
    const base = baseInvocation("read_url", analysis, primarySourcePolicy, false);
    if (!base) return undefined;
    const pageReadRequest = runtime.pageReader.resolveTarget({
      candidateSet: context.candidateSet,
      targetRef: analysis.evidence.urlRef,
      intent: analysis.evidence.goal ?? context.intent,
      retry: analysis.capabilities.requestKind === "retry" ||
        analysis.capabilities.requestKind === "correct_limitation",
    });
    if (!pageReadRequest) return undefined;
    return {
      ...base,
      capability: "read_url",
      pageReadRequest,
      ...(analysis.evidence.goal && analysis.evidence.searchMode
        ? { siteResearch: { goal: analysis.evidence.goal, mode: analysis.evidence.searchMode } }
        : {}),
    };
  },
  execute: async (invocation, requesterId, runtime) => {
    const pageUrl = invocation.pageReadRequest.url;
    const explicitRootUrl = pageUrl &&
      invocation.pageReadRequest.initiator !== "automatic" &&
      pageUrl.pathname === "/" &&
      pageUrl.search === "";
    let retrievedMetadata = false;
    if (explicitRootUrl && invocation.siteResearch) {
      const sameSite = await runtime.researchBroker.researchSite({
        url: pageUrl,
        query: invocation.siteResearch.goal,
        mode: invocation.siteResearch.mode,
        requesterId,
        cachePolicy: invocation.pageReadRequest.retry ? "bypass" : "default",
      }).catch((error) => {
        console.warn("Bounded same-site lookup failed safely:", error instanceof Error ? error.message : error);
        return undefined;
      });
      retrievedMetadata = Boolean(sameSite?.results.length);
      const quality = sameSite?.search?.site?.quality;
      if (sameSite?.results.length && (!quality || hasSpecificSiteResearchResults(quality))) {
        const expanded = await resolveSearchEvidence({
          packet: sameSite,
          semanticGoal: invocation.siteResearch.goal,
          requesterId,
          now: runtime.now(),
          pageReader: runtime.pageReader,
          retry: invocation.pageReadRequest.retry,
        });
        if (expanded.readiness === "grounding_available" && packetHasPrimaryContent(expanded.packet)) {
          return groundingAvailable(invocation, expanded.packet, boundedSiteSourcePolicy);
        }
      }
    }
    const page = await runtime.pageReader.read(invocation.pageReadRequest, requesterId).catch((error) => {
      console.warn("Exact linked-page read failed safely:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (page?.kind === "page" && packetHasPrimaryContent(page)) return groundingAvailable(invocation, page);
    return page || retrievedMetadata ? retrievedOnly(invocation) : failed(invocation, "empty");
  },
  scene: (invocation, resolution, context) => {
    const success = resolution.state === "grounding_available" && resolution.research;
    const automatic = context.automatic || invocation.pageReadRequest.initiator === "automatic";
    const groundingInstruction = automatic
      ? "Make one concise, natural comment on the shared page with at least one concrete detail supported by the primary supplied source and one room-relevant reaction, implication or question. Attach that server-issued source ID; a title-only acknowledgement or tooling narration is not a response."
      : "Answer the human's actual request with at least one concrete detail supported by freshResearch. If the readable source genuinely omits the requested detail, state that specific gap naturally instead of inventing it or claiming the page was inaccessible. Attach the supporting server-issued source ID and do not substitute a title-only reaction, capability statement or unsupported guess.";
    const premise = success
      ? automatic
        ? `${context.actorName} opened the exact server-bound page that the human just shared and is solely responsible for one grounded response. ${groundingInstruction}`
        : `${context.actorName} opened the server-bound linked source and is solely responsible for answering from the supplied page evidence. ${groundingInstruction}`
      : `${context.actorName} alone reports in the human's classified language that this specific linked-page attempt did not yield readable material for the requested answer this time. Describe only that temporary human-visible result, without implementation jargon; do not invent a cause or page contents.`;
    return {
      ...(success ? { research: resolution.research } : {}),
      evidenceOutcome: success ? "succeeded" : "failed",
      ...(success ? { urlPublicationPolicy: "server_card" as const } : {}),
      groundingInstruction,
      premise,
      externalEvidence: true,
      suppressResponse: Boolean(automatic && !success && !context.failureReplyRequired),
      responsePolicy: resolution.responsePolicy,
    };
  },
};

const webSearchAdapter: CapabilityAdapter<WebSearchInvocation> = {
  id: "web_search",
  available: (context) => context.allowSearch && process.env.RESEARCH_ENABLED === "true",
  compile: (analysis, context) => {
    if (
      analysis.evidence.action !== "web_search" ||
      !analysis.evidence.query ||
      !analysis.evidence.searchMode
    ) return undefined;
    const base = baseInvocation("web_search", analysis, selectedSourcePolicy, true);
    if (!base) return undefined;
    return {
      ...base,
      capability: "web_search",
      searchRequest: {
        query: analysis.evidence.query,
        mode: analysis.evidence.searchMode,
        requesterId: context.requesterId,
        ...(base.requestKind === "execute" ? {} : { cachePolicy: "bypass" as const }),
      },
    };
  },
  execute: async (invocation, requesterId, runtime) => {
    const search = await runtime.researchBroker.research({
      ...invocation.searchRequest,
      requesterId,
    }).catch((error) => {
      console.warn("Fresh evidence lookup failed safely:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (!search) return failed(invocation, "empty");
    const expanded = await resolveSearchEvidence({
      packet: search,
      semanticGoal: invocation.goal,
      requesterId,
      now: runtime.now(),
      pageReader: runtime.pageReader,
      retry: invocation.requestKind !== "execute",
    });
    return expanded.readiness === "grounding_available" && packetHasPrimaryContent(expanded.packet)
      ? groundingAvailable(invocation, expanded.packet)
      : retrievedOnly(invocation);
  },
  scene: (invocation, resolution, context) => {
    const success = resolution.state === "grounding_available" && resolution.research;
    const groundingInstruction = "Answer the classified external-information request only from freshResearch and attach only source IDs that support each claim. Search rank, title or search snippet alone is never evidence. If the readable supplied pages genuinely omit the requested fact, name that exact missing datum naturally, attach the source IDs for the inspected pages that establish the gap, and stop there; do not broaden it into a permanent or generic no-live-data claim and do not substitute unrelated background.";
    const premise = success
      ? `${context.actorName} ran the classified fresh lookup and is responsible for the sourced answer. ${groundingInstruction}`
      : `${context.actorName} alone reports in the human's classified language that this specific lookup did not yield readable material for the requested answer this time. Describe only that temporary human-visible result, without search-system or implementation jargon, and invent no current facts.`;
    return {
      ...(success ? { research: resolution.research } : {}),
      evidenceOutcome: success ? "succeeded" : "failed",
      groundingInstruction,
      premise,
      externalEvidence: true,
      suppressResponse: false,
      responsePolicy: resolution.responsePolicy,
    };
  },
};

const exactStringArray = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const snapshotMatchesTarget = (snapshot: MarketSnapshot, targetId: MarketTargetId): boolean => {
  if (snapshot.targetId !== targetId || !Number.isFinite(Date.parse(snapshot.retrievedAt))) return false;
  const expected = marketIndexIdsForTarget(targetId);
  if (!exactStringArray(snapshot.requestedIndexIds, expected)) return false;
  if (snapshot.targetKind !== (expected.length === 1 ? "index" : "basket")) return false;
  const observedIds = snapshot.observations.map((observation) => observation.indexId);
  if (
    new Set(observedIds).size !== observedIds.length ||
    observedIds.some((id) => !isMarketIndexId(id) || !expected.includes(id))
  ) return false;
  const missing = expected.filter((id) => !observedIds.includes(id));
  if (!exactStringArray(snapshot.missingIndexIds, missing)) return false;
  const freshnessCounts = {
    recent: snapshot.observations.filter((item) => item.freshness.status === "recent").length,
    previousSession: snapshot.observations.filter((item) => item.freshness.status === "previous_session").length,
    stale: snapshot.observations.filter((item) => item.freshness.status === "stale").length,
  };
  if (
    snapshot.coverage.requested !== expected.length ||
    snapshot.coverage.available !== snapshot.observations.length ||
    snapshot.coverage.ratio !== snapshot.observations.length / expected.length ||
    snapshot.coverage.complete !== (snapshot.observations.length === expected.length) ||
    snapshot.coverage.recent !== freshnessCounts.recent ||
    snapshot.coverage.previousSession !== freshnessCounts.previousSession ||
    snapshot.coverage.stale !== freshnessCounts.stale
  ) return false;
  return snapshot.observations.every((observation) => {
    const definition = MARKET_INDEX_CATALOG[observation.indexId];
    const observedAt = Date.parse(observation.freshness.observedAt);
    const providerRetrievedAt = Date.parse(observation.provider.retrievedAt);
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(observation.provider.sourceUrl);
    } catch {
      return false;
    }
    const expectedChange = observation.level - observation.previousClose;
    const expectedPercent = expectedChange / observation.previousClose * 100;
    return observation.displayName === definition.displayName &&
      observation.shortName === definition.shortName &&
      observation.region === definition.region &&
      observation.countryCode === definition.countryCode &&
      observation.exchangeTimeZone === definition.exchangeTimeZone &&
      observation.currency === definition.currency &&
      observation.changeBasis === "previous_close" &&
      Number.isFinite(observation.level) && observation.level > 0 &&
      Number.isFinite(observation.previousClose) && observation.previousClose > 0 &&
      Number.isFinite(observation.change) &&
      Number.isFinite(observation.changePercent) && Math.abs(observation.changePercent) <= 100 &&
      Math.abs(observation.change - expectedChange) <= Math.max(1e-8, Math.abs(expectedChange) * 1e-8) &&
      Math.abs(observation.changePercent - expectedPercent) <= Math.max(1e-8, Math.abs(expectedPercent) * 1e-8) &&
      Number.isFinite(observedAt) && Number.isFinite(providerRetrievedAt) &&
      Number.isFinite(observation.freshness.ageMs) && observation.freshness.ageMs >= 0 &&
      ["recent", "previous_session", "stale"].includes(observation.freshness.status) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(observation.tradingDate) &&
      /^[a-z0-9][a-z0-9._-]{1,63}$/u.test(observation.provider.id) &&
      sourceUrl.protocol === "https:" && !sourceUrl.username && !sourceUrl.password && !sourceUrl.search;
  });
};

/**
 * Stale rows are structurally valid provider output but not answer-bearing
 * current evidence. Baskets also need bounded breadth so one surviving row is
 * never presented as a regional or global overview.
 */
const usableMarketSnapshot = (snapshot: MarketSnapshot): MarketSnapshot | undefined => {
  const observations = snapshot.observations.filter((item) => item.freshness.status !== "stale");
  const minimumAvailable = snapshot.targetKind === "index"
    ? 1
    : Math.max(2, Math.ceil(snapshot.requestedIndexIds.length * 0.6));
  if (observations.length < minimumAvailable) return undefined;
  if (
    snapshot.targetId === "GLOBAL_MAJOR" &&
    new Set(observations.map((item) => item.region)).size < 2
  ) return undefined;
  const observedIds = new Set(observations.map((item) => item.indexId));
  const missingIndexIds = snapshot.requestedIndexIds.filter((id) => !observedIds.has(id));
  const recent = observations.filter((item) => item.freshness.status === "recent").length;
  const previousSession = observations.filter((item) => item.freshness.status === "previous_session").length;
  return {
    ...snapshot,
    observations,
    missingIndexIds,
    coverage: {
      requested: snapshot.requestedIndexIds.length,
      available: observations.length,
      ratio: observations.length / snapshot.requestedIndexIds.length,
      complete: observations.length === snapshot.requestedIndexIds.length,
      recent,
      previousSession,
      stale: 0,
    },
  };
};

const marketSnapshotAdapter: CapabilityAdapter<MarketSnapshotInvocation> = {
  id: "market_snapshot",
  available: (_context, runtime) => Boolean(runtime.marketSnapshotProvider),
  compile: (analysis) => {
    if (
      analysis.evidence.action !== "market_snapshot" ||
      !isMarketTargetId(analysis.evidence.locationLabel)
    ) return undefined;
    const base = baseInvocation("market_snapshot", analysis, marketSourcePolicy, false);
    return base ? {
      ...base,
      capability: "market_snapshot",
      marketTargetId: analysis.evidence.locationLabel,
    } : undefined;
  },
  execute: async (invocation, _requesterId, runtime) => {
    if (!runtime.marketSnapshotProvider) return failed(invocation, "invalid_target");
    const snapshot = await runtime.marketSnapshotProvider.snapshot({
      targetId: invocation.marketTargetId,
      ...(invocation.requestKind === "execute" ? {} : { cachePolicy: "bypass" as const }),
    }).catch((error) => {
      console.warn("Typed market snapshot failed safely:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (!snapshot || !snapshotMatchesTarget(snapshot, invocation.marketTargetId)) return failed(invocation, "empty");
    const usable = usableMarketSnapshot(snapshot);
    if (!usable) return failed(invocation, "empty");
    const packet = marketSnapshotEvidencePacket(usable);
    return packetHasPrimaryContent(packet)
      ? groundingAvailable(invocation, packet)
      : failed(invocation, "empty");
  },
  scene: (invocation, resolution, context) => {
    const success = resolution.state === "grounding_available" && resolution.research;
    const groundingInstruction = "Answer only from the validated structured market rows in freshResearch. Describe every number as the provider's latest reported observation and preserve its previous_close basis, sign, absolute observedAt, tradingDate, exchangeTimeZone and freshness status. Attach the exact server-issued source ID for every index value or move you mention. For a basket, explicitly respect coverage.available/coverage.requested and missingIndexIds; never describe partial coverage as the whole region or world, and keep the concise answer to at most three representative supplied rows. Different exchanges can have different observation times and trading dates: never imply they share one session, that a market is open, or that all rows mean “today”. Report levels and moves only; do not invent news, causal explanations, forecasts, advice or absent instruments.";
    return {
      ...(success ? { research: resolution.research } : {}),
      evidenceOutcome: success ? "succeeded" : "failed",
      ...(success ? { urlPublicationPolicy: "server_card" as const } : {}),
      groundingInstruction,
      premise: success
        ? `${context.actorName} received a provider-neutral validated market snapshot and alone answers the requested index or basket question. ${groundingInstruction}`
        : `${context.actorName} alone reports in the human's classified language that this requested market snapshot returned no validated observation this time. Treat it as temporary, avoid implementation jargon and invent no market values or causes.`,
      externalEvidence: true,
      suppressResponse: false,
      responsePolicy: resolution.responsePolicy,
    };
  },
};

const footballDataAdapter: CapabilityAdapter<FootballDataInvocation> = {
  id: "football_data",
  available: (_context, runtime) => Boolean(runtime.footballCompetitionProvider),
  compile: (analysis) => {
    if (
      analysis.evidence.action !== "football_data" ||
      !isFootballCompetitionId(analysis.evidence.competitionTarget) ||
      !isFootballDataView(analysis.evidence.footballView)
    ) return undefined;
    const base = baseInvocation("football_data", analysis, primarySourcePolicy, false);
    const focus = analysis.evidence.footballFilter?.trim();
    return base ? {
      ...base,
      capability: "football_data",
      competitionId: analysis.evidence.competitionTarget,
      view: analysis.evidence.footballView,
      ...(focus ? { focus } : {}),
    } : undefined;
  },
  execute: async (invocation, requesterId, runtime) => {
    if (!runtime.footballCompetitionProvider) return failed(invocation, "invalid_target");
    const snapshot = await runtime.footballCompetitionProvider.snapshot({
      targetId: invocation.competitionId,
      view: invocation.view,
      ...(invocation.focus ? { focus: invocation.focus } : {}),
      requesterId,
      ...(invocation.requestKind === "execute" ? {} : { cachePolicy: "bypass" as const }),
    }).catch((error) => {
      console.warn("Typed football lookup failed safely:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (!snapshot || snapshot.targetId !== invocation.competitionId || snapshot.view !== invocation.view) {
      return failed(invocation, "empty");
    }
    const packet = footballCompetitionEvidencePacket(snapshot);
    return packetHasPrimaryContent(packet) ? groundingAvailable(invocation, packet) : failed(invocation, "empty");
  },
  scene: (invocation, resolution, context) => {
    const success = resolution.state === "grounding_available" && resolution.research;
    const groundingInstruction = "Answer only from the validated structured football snapshot in freshResearch. Treat every score, status and fixture as the provider's latest reported observation at retrievedAt, preserve kickoffUtc and displayTimeZone, and say plainly when a kicked-off match is still awaiting a reported result. Attach the primary server-issued source ID. Respect coverage and the requested view/filter; provisional group tables do not establish official tie-break order. Do not invent live minute, scorers, lineups, injuries, odds, causes, tactical claims or advancement that the supplied rows do not establish.";
    return {
      ...(success ? { research: resolution.research } : {}),
      evidenceOutcome: success ? "succeeded" : "failed",
      ...(success ? { urlPublicationPolicy: "server_card" as const } : {}),
      groundingInstruction,
      premise: success
        ? `${context.actorName} received one validated provider-neutral football snapshot and alone answers the requested competition question. ${groundingInstruction}`
        : `${context.actorName} alone reports in the human's classified language that this requested football-data attempt returned no validated result this time. Treat it as temporary, avoid implementation jargon and invent no fixtures, scores or causes.`,
      externalEvidence: true,
      suppressResponse: false,
      responsePolicy: resolution.responsePolicy,
    };
  },
};

const localDateTimeAdapter: CapabilityAdapter<LocalDateTimeInvocation> = {
  id: "local_datetime",
  available: () => true,
  compile: (analysis) => {
    if (
      analysis.evidence.action !== "local_datetime" ||
      !analysis.evidence.timeZone ||
      !analysis.evidence.timeKind ||
      !analysis.evidence.locationLabel
    ) return undefined;
    const base = baseInvocation("local_datetime", analysis, noSourcePolicy, false);
    if (!base) return undefined;
    const languageTag = projectTrustedTurnAnalysis(analysis).languageTag;
    return {
      ...base,
      capability: "local_datetime",
      timeZone: analysis.evidence.timeZone,
      timeKind: analysis.evidence.timeKind,
      locationLabel: analysis.evidence.locationLabel,
      ...(languageTag ? { languageTag } : {}),
    };
  },
  execute: async (invocation, _requesterId, runtime) => {
    const clock = resolveLocalDateTime({
      timeZone: invocation.timeZone,
      locationLabel: invocation.locationLabel,
      languageTag: invocation.languageTag,
      now: new Date(runtime.now()),
    });
    return clock ? resolvedClock(invocation, clock) : failed(invocation, "invalid_target");
  },
  scene: (invocation, resolution, context) => {
    const success = resolution.state === "grounding_available" && resolution.requestedClock;
    const groundingInstruction = "Answer the explicit current date/time request only from trustedTemporalContext.requestedClock. Do not browse, estimate or cite a web source.";
    return {
      ...(success ? { requestedClock: resolution.requestedClock, temporalPolicy: "direct_answer" as const } : {}),
      groundingInstruction,
      premise: success
        ? `${context.actorName} alone answers the requested current date/time from trustedTemporalContext.requestedClock. Do not browse, estimate or cite a web source.`
        : `${context.actorName} alone reports that the requested server-clock result could not be resolved for this attempt; do not invent a time or location.`,
      externalEvidence: false,
      suppressResponse: false,
      responsePolicy: resolution.responsePolicy,
    };
  },
};

const weatherForecastAdapter: CapabilityAdapter<WeatherForecastInvocation> = {
  id: "weather_forecast",
  available: (_context, runtime) => Boolean(runtime.weatherForecastProvider),
  compile: (analysis) => {
    if (analysis.evidence.action !== "weather_forecast" || !analysis.evidence.locationLabel) return undefined;
    const base = baseInvocation("weather_forecast", analysis, primarySourcePolicy, false);
    const languageTag = projectTrustedTurnAnalysis(analysis).languageTag;
    const providerQuery = analysis.evidence.query?.trim();
    return base ? {
      ...base,
      capability: "weather_forecast",
      location: analysis.evidence.locationLabel,
      ...(providerQuery ? { providerQuery } : {}),
      ...(languageTag ? { languageTag } : {}),
    } : undefined;
  },
  execute: async (invocation, requesterId, runtime) => {
    if (!runtime.weatherForecastProvider) return failed(invocation, "invalid_target");
    const forecast = await runtime.weatherForecastProvider.forecast({
      location: invocation.location,
      ...(invocation.providerQuery ? { lookupQuery: invocation.providerQuery } : {}),
      ...(invocation.languageTag ? { languageTag: invocation.languageTag } : {}),
      requesterId,
    }).catch((error) => {
      console.warn("Typed forecast failed safely:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (!forecast) return failed(invocation, "empty");
    const packet = weatherForecastEvidencePacket(forecast);
    return packetHasPrimaryContent(packet) ? groundingAvailable(invocation, packet) : retrievedOnly(invocation);
  },
  scene: (invocation, resolution, context) => {
    const success = resolution.state === "grounding_available" && resolution.research;
    const groundingInstruction = "Answer the requested server-resolved place and forecast horizon only from freshResearch, include at least one concrete value or supported trend, and attach the primary server-issued source ID.";
    return {
      ...(success ? { research: resolution.research } : {}),
      evidenceOutcome: success ? "succeeded" : "failed",
      ...(success ? { urlPublicationPolicy: "server_card" as const } : {}),
      groundingInstruction,
      premise: success
        ? `${context.actorName} received validated structured forecast evidence and alone answers the request. ${groundingInstruction}`
        : resolution.state === "retrieved_only"
          ? `${context.actorName} alone reports in the human's classified language that this forecast attempt returned metadata but no answer-bearing forecast. Do not invent weather values or a cause.`
          : `${context.actorName} alone reports in the human's classified language that this forecast attempt returned no validated result. Treat it as temporary; do not invent weather values or a cause.`,
      externalEvidence: true,
      suppressResponse: false,
      responsePolicy: resolution.responsePolicy,
    };
  },
};

const builtInAdapters: readonly CapabilityAdapter[] = [
  readUrlAdapter as CapabilityAdapter,
  webSearchAdapter as CapabilityAdapter,
  marketSnapshotAdapter as CapabilityAdapter,
  footballDataAdapter as CapabilityAdapter,
  localDateTimeAdapter as CapabilityAdapter,
  weatherForecastAdapter as CapabilityAdapter,
];

const assertAdapterCoverage = (adapters: readonly CapabilityAdapter[]): void => {
  const ids = adapters.map((adapter) => adapter.id);
  if (new Set(ids).size !== ids.length) throw new TypeError("Capability registry contains duplicate adapter IDs");
  const missing = TURN_CAPABILITIES.filter((id) => !ids.includes(id));
  const unknown = ids.filter((id) => !TURN_CAPABILITIES.includes(id));
  if (missing.length || unknown.length) {
    throw new TypeError(`Capability registry/catalog mismatch (missing=${missing.join(",")}; unknown=${unknown.join(",")})`);
  }
};

assertAdapterCoverage(builtInAdapters);

/**
 * Static code-owned capability registry. New capabilities must add one catalog
 * entry and one complete adapter; Director consumes only this neutral API.
 */
export class CapabilityRegistry {
  private readonly runtime: CapabilityRuntimeDependencies;
  private readonly adapters = new Map<TurnCapability, CapabilityAdapter>(
    builtInAdapters.map((adapter) => [adapter.id, adapter]),
  );

  constructor(options: CapabilityRegistryOptions) {
    const now = options.now ?? Date.now;
    this.runtime = {
      pageReader: options.pageReader,
      researchBroker: options.researchBroker,
      marketSnapshotProvider: process.env.MARKET_SNAPSHOT_ENABLED === "false" ||
        options.marketSnapshotProvider === null
        ? undefined
        : options.marketSnapshotProvider ?? new MarketSnapshotService({
            providers: [new YahooChartMarketDataProvider()],
            now,
          }),
      footballCompetitionProvider: process.env.FOOTBALL_DATA_ENABLED === "false" ||
        options.footballCompetitionProvider === null
        ? undefined
        : options.footballCompetitionProvider ?? new FootballCompetitionProvider({ now }),
      weatherForecastProvider: options.weatherForecastProvider === null
        ? undefined
        : options.weatherForecastProvider ?? (
            process.env.WEATHER_ENABLED === "false" ? undefined : new WeatherForecastProvider({ now })
          ),
      now,
    };
  }

  available(context: CapabilityAvailabilityContext): TurnCapability[] {
    const inventory = context.inventory ? new Set(context.inventory) : undefined;
    return TURN_CAPABILITIES.filter((id) =>
      (CAPABILITY_CATALOG[id].media as readonly CapabilityMedium[]).includes(context.medium) &&
      (!inventory || inventory.has(id)) &&
      this.adapters.get(id)?.available(context, this.runtime));
  }

  hasExternalEvidence(available: readonly TurnCapability[]): boolean {
    return hasExternalEvidenceCapability(available);
  }

  compile(analysis: TurnAnalysis, context: CapabilityCompileContext): CapabilityInvocation | undefined {
    const trusted = projectTrustedTurnAnalysis(analysis);
    if (!trusted.evidenceTrusted || !trusted.capabilityTrusted) return undefined;
    const action = analysis.evidence.action;
    if (action === "none") return undefined;
    if (!requestKindFor(analysis) || !analysis.capabilities.discussed.includes(action)) return undefined;
    const available = this.available(context);
    if (!available.includes(action)) return undefined;
    if (!analysisArgumentShapeIsValid(action, analysis, context.candidateSet)) return undefined;
    const adapter = this.adapters.get(action);
    return adapter?.compile(analysis, context, this.runtime);
  }

  planAutomaticRead(pageReadRequest: PageReadRequest, goal: string): CapabilityInvocation {
    const boundedGoal = goal.trim().slice(0, 240) || "shared page";
    return {
      capability: readUrlAdapter.id,
      goal: boundedGoal,
      requestKind: "execute",
      externalEvidence: true,
      requiresResearchPersona: false,
      responsePolicy: primarySourcePolicy,
      pageReadRequest: { ...pageReadRequest, initiator: "automatic" },
    };
  }

  async execute(invocation: CapabilityInvocation, requesterId: string): Promise<EvidenceResolution> {
    const adapter = this.adapters.get(invocation.capability);
    if (!adapter) return failed(invocation, "invalid_target");
    try {
      return await adapter.execute(invocation, requesterId, this.runtime);
    } catch (error) {
      console.warn(
        `Capability ${invocation.capability} failed safely:`,
        error instanceof Error ? error.message : error,
      );
      return failed(invocation, "transport");
    }
  }

  sceneContract(
    invocation: CapabilityInvocation,
    resolution: EvidenceResolution,
    context: CapabilityPresentationContext,
  ): CapabilitySceneContract {
    const adapter = this.adapters.get(invocation.capability);
    if (!adapter || resolution.invocation !== invocation) {
      throw new TypeError("Capability resolution does not match its invocation");
    }
    const scene = adapter.scene(invocation, resolution, context);
    const shouldAttachServerCard = resolution.state === "grounding_available" &&
      Boolean(resolution.research) &&
      resolution.responsePolicy.linkCard !== "none";
    if (shouldAttachServerCard) return { ...scene, urlPublicationPolicy: "server_card" };
    const { urlPublicationPolicy: _ignored, ...withoutUrlPublication } = scene;
    return withoutUrlPublication;
  }

  sourceIds(
    resolution: EvidenceResolution | undefined,
    modelSourceIds: readonly string[],
    designatedResponder: boolean,
  ): string[] {
    if (!resolution || resolution.state !== "grounding_available") return [];
    if (this.requiresDesignatedResponder(resolution) && !designatedResponder) return [];
    const available = new Set(resolution.research?.results.map((result) => result.id) ?? []);
    const policy = resolution.responsePolicy;
    if (policy.citations === "none") return [];
    if (policy.citations === "force_primary") {
      const primaryId = resolution.research?.results[0]?.id;
      return primaryId && available.has(primaryId) ? [primaryId] : [];
    }
    return [...new Set(modelSourceIds)]
      .filter((sourceId) => available.has(sourceId))
      .slice(0, policy.maxSources);
  }

  requiresDesignatedResponder(resolution: EvidenceResolution | undefined): boolean {
    return resolution?.responsePolicy.owner === "designated_responder";
  }

  linkCardSourceId(
    resolution: EvidenceResolution | undefined,
    publishedSourceIds: readonly string[],
  ): string | undefined {
    if (resolution?.state !== "grounding_available" || !resolution.research) return undefined;
    const policy = resolution.responsePolicy;
    if (policy.linkCard === "none") return undefined;
    const available = new Set(resolution.research.results.map((result) => result.id));
    if (policy.linkCard === "primary") {
      const primaryId = resolution.research.results[0]?.id;
      return primaryId && publishedSourceIds.includes(primaryId) ? primaryId : undefined;
    }
    return publishedSourceIds.find((sourceId) => available.has(sourceId));
  }

  deterministicFallback(
    resolution: EvidenceResolution | undefined,
    now = new Date(this.runtime.now()),
  ): { content: string; sourceIds: string[] } | undefined {
    if (resolution?.state !== "grounding_available" || !resolution.requestedClock) return undefined;
    return {
      content: refreshLocalDateTime(resolution.requestedClock, now).fallbackText,
      sourceIds: [],
    };
  }
}
