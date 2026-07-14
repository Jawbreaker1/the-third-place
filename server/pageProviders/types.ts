import type { ResearchResult } from "../researchBroker.js";
import type { SafeHttpsFetchPolicy, SafeHttpsFetchResult } from "../safeHttpsFetch.js";

/**
 * The only network primitive exposed to a page provider. Production supplies
 * the same public-HTTPS fetcher used by the generic reader, so adapters cannot
 * weaken DNS, redirect, media-type or response-size enforcement.
 */
export type PageProviderFetcher = (
  rawUrl: string | URL,
  policy: SafeHttpsFetchPolicy,
) => Promise<SafeHttpsFetchResult | undefined>;

/** Bounded evidence returned to PageReader; never a pre-written chat answer. */
export interface PageProviderEvidence {
  retrievedAt: string;
  result: ResearchResult;
  cacheTtlMs?: number;
}

export interface PageProviderReadContext {
  /** The validated public URL shared by the human. */
  requestedUrl: URL;
  fetcher: PageProviderFetcher;
}

/**
 * Transport-only extension point for sites whose useful public data cannot be
 * extracted from their HTML. URL support must be structural; natural-language
 * intent and response wording remain outside providers.
 */
export interface PageProviderAdapter {
  readonly id: string;
  supports(url: URL): boolean;
  read(context: PageProviderReadContext): Promise<PageProviderEvidence | undefined>;
}
