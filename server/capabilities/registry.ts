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
}

export type CapabilityInvocation =
  | ReadUrlInvocation
  | WebSearchInvocation
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
  /** Automatic passive-link failures never become spoken capability errors. */
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
  weatherForecastProvider?: WeatherForecastCapabilityProvider;
  now: () => number;
}

export interface CapabilityRegistryOptions {
  pageReader: PageReader;
  researchBroker: Pick<ResearchBroker, "research" | "researchSite">;
  weatherForecastProvider?: WeatherForecastCapabilityProvider | null;
  now?: () => number;
}

interface CapabilityPresentationContext {
  actorName: string;
  automatic?: boolean;
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
      : "Answer the human's actual request with at least one concrete detail supported by freshResearch. Attach the supporting server-issued source ID and do not substitute a title-only reaction, capability statement or unsupported guess.";
    const premise = success
      ? automatic
        ? `${context.actorName} opened the exact server-bound page that the human just shared and is solely responsible for one grounded response. ${groundingInstruction}`
        : `${context.actorName} opened the server-bound linked source and is solely responsible for answering from the supplied page evidence. ${groundingInstruction}`
      : `${context.actorName} alone reports in the human's classified language that this specific server-bound linked-page attempt ${resolution.state === "retrieved_only" ? "returned metadata but no safely readable answer-bearing page" : "returned no readable evidence"}. It is a temporary result; do not invent a cause or page contents.`;
    return {
      ...(success ? { research: resolution.research } : {}),
      evidenceOutcome: success ? "succeeded" : "failed",
      ...(success ? { urlPublicationPolicy: "server_card" as const } : {}),
      groundingInstruction,
      premise,
      externalEvidence: true,
      suppressResponse: Boolean(automatic && !success),
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
    const groundingInstruction = "Answer the classified external-information request only from freshResearch and attach only source IDs that support each claim. Search rank, title or snippet alone is never evidence.";
    const premise = success
      ? `${context.actorName} ran the classified fresh lookup and is responsible for the sourced answer. ${groundingInstruction}`
      : resolution.state === "retrieved_only"
        ? `${context.actorName} alone reports in the human's classified language that the lookup returned result metadata but no safely readable answer-bearing page. Treat this as a temporary bounded outcome and invent no current facts.`
        : `${context.actorName} alone reports in the human's classified language that this specific fresh lookup returned no usable source. Treat it as temporary and invent no current facts.`;
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
    return base ? {
      ...base,
      capability: "weather_forecast",
      location: analysis.evidence.locationLabel,
    } : undefined;
  },
  execute: async (invocation, requesterId, runtime) => {
    if (!runtime.weatherForecastProvider) return failed(invocation, "invalid_target");
    const forecast = await runtime.weatherForecastProvider.forecast({
      location: invocation.location,
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
