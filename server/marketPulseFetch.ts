import {
  MARKET_PULSE_FEEDS,
  type MarketPulseFeedDefinition,
  type MarketPulseFeedFetcher,
} from "./marketPulse.js";
import {
  fetchPublicHttps,
  validatePublicHttpsUrl,
  type SafeHttpsFetchPolicy,
  type SafeHttpsFetchResult,
} from "./safeHttpsFetch.js";

const MARKET_PULSE_TIMEOUT_LIMIT_MS = 8_000;
const MARKET_PULSE_BODY_LIMIT_BYTES = 384 * 1024;
const MARKET_PULSE_MAX_REDIRECTS = 2;

export const MARKET_PULSE_ACCEPTED_MEDIA_TYPES = Object.freeze([
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
] as const);

const MEDIA_TYPE_SET = new Set<string>(MARKET_PULSE_ACCEPTED_MEDIA_TYPES);
const FEEDS_BY_URL = new Map<string, MarketPulseFeedDefinition>(
  MARKET_PULSE_FEEDS.map((feed) => [new URL(feed.url).toString(), feed]),
);

/** Narrow seam retained solely so the DNS-pinned primitive can be tested. */
export type MarketPulseSafeHttpsFetcher = (
  rawUrl: string | URL,
  policy: SafeHttpsFetchPolicy,
) => Promise<SafeHttpsFetchResult | undefined>;

const positiveIntegerAtMost = (value: number, maximum: number): number | undefined =>
  Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : undefined;

const acceptedMediaTypesFor = (requested: readonly string[]): string[] => {
  const requestedTypes = new Set(
    requested.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean),
  );
  return MARKET_PULSE_ACCEPTED_MEDIA_TYPES.filter((mediaType) => requestedTypes.has(mediaType));
};

const canonicalRequestedFeed = (
  requested: URL,
): { url: URL; feed: MarketPulseFeedDefinition } | undefined => {
  // Fragments are not sent over HTTP, but accepting one would make this a
  // broader destination surface than the fixed registry promises.
  if (requested.hash) return undefined;
  const url = validatePublicHttpsUrl(requested.toString());
  if (!url) return undefined;
  const feed = FEEDS_BY_URL.get(url.toString());
  return feed ? { url, feed } : undefined;
};

const canonicalAllowedFinalUrl = (
  raw: URL,
  feed: MarketPulseFeedDefinition,
): URL | undefined => {
  const url = validatePublicHttpsUrl(raw.toString());
  if (!url) return undefined;
  const hostname = url.hostname.toLocaleLowerCase().replace(/\.$/u, "");
  return feed.allowedHosts.some((allowed) => allowed.toLocaleLowerCase().replace(/\.$/u, "") === hostname)
    ? url
    : undefined;
};

/**
 * Adapts the app's DNS-pinned, public-HTTPS reader to the MarketPulse feed
 * boundary. Both the starting destination and redirect hosts remain fixed by
 * MARKET_PULSE_FEEDS; request headers cannot widen or alter the network policy.
 *
 * SafeHttpsFetch intentionally exposes neither response status nor headers and
 * cannot send conditional request headers. A successful bounded 2xx response
 * is therefore normalized to status 200, without ETag/Last-Modified metadata.
 * The coordinator still performs interval polling and persistent item dedupe;
 * conditional GET support should only be added by extending the pinned
 * primitive itself, never by falling back to an unpinned fetch implementation.
 */
export const createSafeMarketPulseFeedFetcher = (
  safeFetcher: MarketPulseSafeHttpsFetcher = fetchPublicHttps,
): MarketPulseFeedFetcher => async (request) => {
  const destination = canonicalRequestedFeed(request.url);
  const timeoutMs = positiveIntegerAtMost(request.timeoutMs, MARKET_PULSE_TIMEOUT_LIMIT_MS);
  const maxBodyBytes = positiveIntegerAtMost(request.maxBodyBytes, MARKET_PULSE_BODY_LIMIT_BYTES);
  const acceptedMediaTypes = acceptedMediaTypesFor(request.acceptedMediaTypes);
  if (!destination || timeoutMs === undefined || maxBodyBytes === undefined || acceptedMediaTypes.length === 0) {
    return undefined;
  }

  const policy: SafeHttpsFetchPolicy = {
    timeoutMs,
    maxRedirects: MARKET_PULSE_MAX_REDIRECTS,
    maxBodyBytes,
    acceptedMediaTypes,
    acceptHeader: acceptedMediaTypes.join(", "),
    userAgent: "TheThirdPlace-MarketPulse/1.0",
    ...(destination.feed.id === "riksbank-press-releases"
      ? { identityContentEncodingAliases: ["system.text.utf8encoding+utf8encodingsealed"] }
      : {}),
    sameOriginRedirectsOnly: true,
    allowCanonicalWwwRedirect: true,
  };
  const result = await safeFetcher(destination.url, policy).catch(() => undefined);
  if (!result) return undefined;

  const mediaType = result.mediaType.trim().toLocaleLowerCase();
  const finalUrl = canonicalAllowedFinalUrl(result.finalUrl, destination.feed);
  if (
    !finalUrl ||
    !MEDIA_TYPE_SET.has(mediaType) ||
    !acceptedMediaTypes.includes(mediaType) ||
    result.body.byteLength > maxBodyBytes
  ) {
    return undefined;
  }

  return {
    status: 200,
    finalUrl,
    mediaType,
    body: result.body,
  };
};

export const safeMarketPulseFeedFetcher: MarketPulseFeedFetcher =
  createSafeMarketPulseFeedFetcher();
