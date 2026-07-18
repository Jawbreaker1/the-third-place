import {
  MARKET_INDEX_CATALOG,
  isMarketIndexId,
  isMarketTargetId,
  marketIndexIdsForTarget,
  type MarketIndexId,
} from "./catalog.js";
import {
  classifyMarketFreshness,
  isStructurallyAcceptableMarketInstant,
  marketObservationAgeMs,
} from "./freshness.js";
import type {
  MarketCoverage,
  MarketDataProvider,
  MarketObservation,
  MarketProviderAttempt,
  MarketProviderBatch,
  MarketSnapshot,
  MarketSnapshotRequest,
} from "./types.js";

interface CachedSnapshot {
  expiresAt: number;
  snapshot: MarketSnapshot;
}

interface ProviderCircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

export interface MarketSnapshotServiceOptions {
  readonly providers: readonly MarketDataProvider[];
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly partialCacheTtlMs?: number;
  readonly failureCacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly providerCallTimeoutMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitCooldownMs?: number;
}

const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number =>
  Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value!)))
    : fallback;

const safeIsoInstant = (value: string): number | undefined => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const safePublicSourceUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && url.search.length === 0;
  } catch {
    return false;
  }
};

const finite = (value: number): boolean => Number.isFinite(value);

const observationIsTrusted = (
  observation: MarketObservation,
  provider: MarketDataProvider,
  eligible: ReadonlySet<MarketIndexId>,
  batchRetrievedAt: string,
  now: number,
): boolean => {
  if (!isMarketIndexId(observation.indexId) || !eligible.has(observation.indexId)) return false;
  const definition = MARKET_INDEX_CATALOG[observation.indexId];
  if (
    observation.displayName !== definition.displayName ||
    observation.shortName !== definition.shortName ||
    observation.region !== definition.region ||
    observation.countryCode !== definition.countryCode ||
    observation.exchangeTimeZone !== definition.exchangeTimeZone ||
    observation.currency !== definition.currency ||
    observation.changeBasis !== "previous_close" ||
    observation.provider.id !== provider.id ||
    observation.provider.experimental !== provider.experimental ||
    observation.provider.retrievedAt !== batchRetrievedAt ||
    !safePublicSourceUrl(observation.provider.sourceUrl) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(observation.tradingDate)
  ) return false;
  if (
    !finite(observation.level) || observation.level <= 0 || observation.level > 1_000_000_000 ||
    !finite(observation.previousClose) || observation.previousClose <= 0 || observation.previousClose > 1_000_000_000 ||
    !finite(observation.change) ||
    !finite(observation.changePercent) || Math.abs(observation.changePercent) > 100
  ) return false;
  const observedAt = safeIsoInstant(observation.freshness.observedAt);
  const retrievedAt = safeIsoInstant(observation.provider.retrievedAt);
  if (
    observedAt === undefined ||
    retrievedAt === undefined ||
    !isStructurallyAcceptableMarketInstant(observedAt, now) ||
    retrievedAt > now + 5 * 60_000 ||
    retrievedAt < now - 5 * 60_000
  ) return false;
  const expectedChange = observation.level - observation.previousClose;
  const expectedPercent = expectedChange / observation.previousClose * 100;
  const numericTolerance = Math.max(1e-8, Math.abs(expectedChange) * 1e-8);
  const percentTolerance = Math.max(1e-8, Math.abs(expectedPercent) * 1e-8);
  if (
    Math.abs(observation.change - expectedChange) > numericTolerance ||
    Math.abs(observation.changePercent - expectedPercent) > percentTolerance
  ) return false;
  const expectedAge = marketObservationAgeMs(observedAt, now);
  return observation.freshness.ageMs === expectedAge &&
    observation.freshness.status === classifyMarketFreshness(observedAt, now);
};

const providerBatchIsStructurallyTrusted = (
  batch: MarketProviderBatch,
  provider: MarketDataProvider,
  now: number,
): boolean => {
  const retrievedAt = safeIsoInstant(batch.retrievedAt);
  return batch.providerId === provider.id &&
    retrievedAt !== undefined &&
    retrievedAt <= now + 5 * 60_000 &&
    retrievedAt >= now - 5 * 60_000 &&
    batch.observations.length <= 8 &&
    batch.failures.length <= 8;
};

const coverageFor = (
  requested: readonly MarketIndexId[],
  observations: readonly MarketObservation[],
): MarketCoverage => ({
  requested: requested.length,
  available: observations.length,
  ratio: requested.length > 0 ? observations.length / requested.length : 0,
  complete: requested.length > 0 && observations.length === requested.length,
  recent: observations.filter((item) => item.freshness.status === "recent").length,
  previousSession: observations.filter((item) => item.freshness.status === "previous_session").length,
  stale: observations.filter((item) => item.freshness.status === "stale").length,
});

const refreshObservation = (observation: MarketObservation, now: number): MarketObservation => {
  const observedAt = Date.parse(observation.freshness.observedAt);
  return {
    ...observation,
    freshness: {
      ...observation.freshness,
      ageMs: marketObservationAgeMs(observedAt, now),
      status: classifyMarketFreshness(observedAt, now),
    },
  };
};

const refreshSnapshot = (snapshot: MarketSnapshot, now: number): MarketSnapshot => {
  const observations = snapshot.observations.map((observation) => refreshObservation(observation, now));
  return { ...snapshot, observations, coverage: coverageFor(snapshot.requestedIndexIds, observations) };
};

const timedProviderRead = async (
  provider: MarketDataProvider,
  indexIds: readonly MarketIndexId[],
  now: number,
  timeoutMs: number,
): Promise<{ state: "completed"; batch: MarketProviderBatch } | { state: "failed" | "timed_out" }> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ state: "timed_out" }>((resolve) => {
    timeout = setTimeout(() => resolve({ state: "timed_out" }), timeoutMs);
  });
  try {
    return await Promise.race([
      provider.read({ indexIds, now })
        .then((batch) => ({ state: "completed" as const, batch }))
        .catch(() => ({ state: "failed" as const })),
      timedOut,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export class MarketSnapshotService {
  private readonly providers: readonly MarketDataProvider[];
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly partialCacheTtlMs: number;
  private readonly failureCacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly providerCallTimeoutMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly cache = new Map<string, CachedSnapshot>();
  private readonly inFlight = new Map<string, Promise<MarketSnapshot>>();
  private readonly circuits = new Map<string, ProviderCircuitState>();

  constructor(options: MarketSnapshotServiceOptions) {
    if (options.providers.length === 0 || options.providers.length > 4) {
      throw new TypeError("MarketSnapshotService requires between one and four providers");
    }
    const providerIds = options.providers.map((provider) => provider.id);
    if (providerIds.some((id) => !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id)) || new Set(providerIds).size !== providerIds.length) {
      throw new TypeError("MarketSnapshotService provider IDs must be unique bounded identifiers");
    }
    for (const provider of options.providers) {
      if (
        provider.supportedIndexIds.length === 0 ||
        provider.supportedIndexIds.length > 16 ||
        new Set(provider.supportedIndexIds).size !== provider.supportedIndexIds.length ||
        provider.supportedIndexIds.some((id) => !isMarketIndexId(id))
      ) throw new TypeError(`Invalid supported market index inventory for provider ${provider.id}`);
    }
    this.providers = [...options.providers];
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = boundedInteger(options.cacheTtlMs, 45_000, 1_000, 10 * 60_000);
    this.partialCacheTtlMs = boundedInteger(options.partialCacheTtlMs, 15_000, 500, this.cacheTtlMs);
    this.failureCacheTtlMs = boundedInteger(options.failureCacheTtlMs, 5_000, 250, this.partialCacheTtlMs);
    this.maxCacheEntries = boundedInteger(options.maxCacheEntries, 32, 4, 64);
    this.providerCallTimeoutMs = boundedInteger(options.providerCallTimeoutMs, 15_000, 10, 30_000);
    this.circuitFailureThreshold = boundedInteger(options.circuitFailureThreshold, 2, 1, 5);
    this.circuitCooldownMs = boundedInteger(options.circuitCooldownMs, 60_000, 1_000, 5 * 60_000);
  }

  async snapshot(request: MarketSnapshotRequest): Promise<MarketSnapshot> {
    if (!isMarketTargetId(request.targetId)) throw new TypeError("Unknown market snapshot target");
    const key = request.targetId;
    const now = this.now();
    this.prune(now);
    if (request.cachePolicy !== "bypass") {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > now) return refreshSnapshot(cached.snapshot, now);
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing.then((snapshot) => refreshSnapshot(snapshot, this.now()));
    const pending = this.load(request.targetId, now)
      .then((snapshot) => {
        const ttl = snapshot.coverage.complete
          ? this.cacheTtlMs
          : snapshot.coverage.available > 0
            ? this.partialCacheTtlMs
            : this.failureCacheTtlMs;
        this.cache.set(key, { snapshot, expiresAt: this.now() + ttl });
        this.prune(this.now());
        return snapshot;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async load(targetId: MarketSnapshotRequest["targetId"], now: number): Promise<MarketSnapshot> {
    const requestedIndexIds = marketIndexIdsForTarget(targetId);
    if (requestedIndexIds.length === 0 || requestedIndexIds.length > 8) {
      throw new TypeError("Market snapshot targets must resolve to between one and eight indexes");
    }
    const remaining = new Set<MarketIndexId>(requestedIndexIds);
    const selected = new Map<MarketIndexId, MarketObservation>();
    const providerAttempts: MarketProviderAttempt[] = [];

    for (const provider of this.providers) {
      if (remaining.size === 0) break;
      const supported = new Set(provider.supportedIndexIds);
      const eligible = requestedIndexIds.filter((id) => remaining.has(id) && supported.has(id));
      if (eligible.length === 0) continue;
      const circuit = this.circuits.get(provider.id) ?? { consecutiveFailures: 0, openUntil: 0 };
      if (circuit.openUntil > now) {
        providerAttempts.push({ providerId: provider.id, status: "circuit_open", requested: eligible.length, accepted: 0 });
        continue;
      }

      const result = await timedProviderRead(provider, eligible, now, this.providerCallTimeoutMs);
      if (result.state !== "completed" || !providerBatchIsStructurallyTrusted(result.batch, provider, now)) {
        this.recordFailure(provider.id, circuit, now);
        providerAttempts.push({
          providerId: provider.id,
          status: result.state === "timed_out" ? "timed_out" : "failed",
          requested: eligible.length,
          accepted: 0,
        });
        continue;
      }

      const eligibleSet = new Set(eligible);
      const seen = new Set<MarketIndexId>();
      let accepted = 0;
      for (const observation of result.batch.observations) {
        if (seen.has(observation.indexId)) continue;
        seen.add(observation.indexId);
        if (!observationIsTrusted(observation, provider, eligibleSet, result.batch.retrievedAt, now)) continue;
        selected.set(observation.indexId, observation);
        remaining.delete(observation.indexId);
        accepted += 1;
      }
      if (accepted === 0) this.recordFailure(provider.id, circuit, now);
      else this.circuits.set(provider.id, { consecutiveFailures: 0, openUntil: 0 });
      providerAttempts.push({
        providerId: provider.id,
        status: accepted === eligible.length ? "complete" : accepted > 0 ? "partial" : "failed",
        requested: eligible.length,
        accepted,
      });
    }

    const observations = requestedIndexIds.flatMap((id) => selected.get(id) ?? []);
    const missingIndexIds = requestedIndexIds.filter((id) => !selected.has(id));
    return {
      targetId,
      targetKind: isMarketIndexId(targetId) ? "index" : "basket",
      retrievedAt: new Date(now).toISOString(),
      requestedIndexIds: [...requestedIndexIds],
      observations,
      missingIndexIds,
      coverage: coverageFor(requestedIndexIds, observations),
      providerAttempts,
    };
  }

  private recordFailure(providerId: string, previous: ProviderCircuitState, now: number): void {
    const consecutiveFailures = previous.consecutiveFailures + 1;
    this.circuits.set(providerId, {
      consecutiveFailures,
      openUntil: consecutiveFailures >= this.circuitFailureThreshold ? now + this.circuitCooldownMs : 0,
    });
  }

  private prune(now: number): void {
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    for (const [providerId, circuit] of this.circuits) {
      if (circuit.openUntil > 0 && circuit.openUntil <= now) {
        this.circuits.set(providerId, { consecutiveFailures: 0, openUntil: 0 });
      }
    }
  }
}
