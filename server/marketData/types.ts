import type { MarketIndexId, MarketTargetId } from "./catalog.js";
import type { MarketFreshnessStatus } from "./freshness.js";

export type MarketChangeBasis = "previous_close";

export interface MarketProviderAttribution {
  readonly id: string;
  readonly experimental: boolean;
  /** A stable public human-viewable source. It must never contain credentials. */
  readonly sourceUrl: string;
  readonly retrievedAt: string;
}

export interface MarketFreshness {
  readonly status: MarketFreshnessStatus;
  readonly observedAt: string;
  readonly ageMs: number;
}

export interface MarketObservation {
  readonly indexId: MarketIndexId;
  readonly displayName: string;
  readonly shortName: string;
  readonly region: "americas" | "europe" | "asia_pacific";
  readonly countryCode: string;
  readonly exchangeTimeZone: string;
  readonly tradingDate: string;
  readonly currency: string;
  readonly level: number;
  readonly previousClose: number;
  readonly change: number;
  readonly changePercent: number;
  readonly changeBasis: MarketChangeBasis;
  readonly freshness: MarketFreshness;
  readonly provider: MarketProviderAttribution;
}

export type MarketProviderFailureReason =
  | "unsupported"
  | "transport"
  | "invalid_response"
  | "missing_observation";

export interface MarketProviderFailure {
  readonly indexId: MarketIndexId;
  readonly reason: MarketProviderFailureReason;
}

export interface MarketProviderRequest {
  readonly indexIds: readonly MarketIndexId[];
  readonly now: number;
}

export interface MarketProviderBatch {
  readonly providerId: string;
  readonly retrievedAt: string;
  readonly observations: readonly MarketObservation[];
  readonly failures: readonly MarketProviderFailure[];
}

export interface MarketDataProvider {
  readonly id: string;
  readonly experimental: boolean;
  readonly supportedIndexIds: readonly MarketIndexId[];
  read(request: MarketProviderRequest): Promise<MarketProviderBatch>;
}

export type MarketProviderAttemptStatus =
  | "complete"
  | "partial"
  | "failed"
  | "timed_out"
  | "circuit_open";

export interface MarketProviderAttempt {
  readonly providerId: string;
  readonly status: MarketProviderAttemptStatus;
  readonly requested: number;
  readonly accepted: number;
}

export interface MarketCoverage {
  readonly requested: number;
  readonly available: number;
  readonly ratio: number;
  readonly complete: boolean;
  readonly recent: number;
  readonly previousSession: number;
  readonly stale: number;
}

export interface MarketSnapshot {
  readonly targetId: MarketTargetId;
  readonly targetKind: "index" | "basket";
  readonly retrievedAt: string;
  readonly requestedIndexIds: readonly MarketIndexId[];
  readonly observations: readonly MarketObservation[];
  readonly missingIndexIds: readonly MarketIndexId[];
  readonly coverage: MarketCoverage;
  readonly providerAttempts: readonly MarketProviderAttempt[];
}

export interface MarketSnapshotRequest {
  readonly targetId: MarketTargetId;
  readonly cachePolicy?: "default" | "bypass";
}
