import { describe, expect, it, vi } from "vitest";
import { MARKET_PULSE_FEEDS, type MarketPulseFeedFetchRequest } from "./marketPulse.js";
import {
  MARKET_PULSE_ACCEPTED_MEDIA_TYPES,
  createSafeMarketPulseFeedFetcher,
  type MarketPulseSafeHttpsFetcher,
} from "./marketPulseFetch.js";
import type { SafeHttpsFetchResult } from "./safeHttpsFetch.js";

const FED_URL = MARKET_PULSE_FEEDS[0].url;
const RIKSBANK_URL = MARKET_PULSE_FEEDS.find((feed) => feed.id === "riksbank-press-releases")!.url;

const request = (
  overrides: Partial<MarketPulseFeedFetchRequest> = {},
): MarketPulseFeedFetchRequest => ({
  url: new URL(FED_URL),
  headers: {
    Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
    "If-None-Match": '"feed-v1"',
    "User-Agent": "untrusted caller value",
  },
  timeoutMs: 8_000,
  maxBodyBytes: 384 * 1024,
  acceptedMediaTypes: [...MARKET_PULSE_ACCEPTED_MEDIA_TYPES],
  ...overrides,
});

const result = (
  overrides: Partial<SafeHttpsFetchResult> = {},
): SafeHttpsFetchResult => ({
  finalUrl: new URL(FED_URL),
  body: Buffer.from("<rss><channel /></rss>"),
  mediaType: "application/rss+xml",
  contentType: "application/rss+xml; charset=utf-8",
  ...overrides,
});

describe("safe MarketPulse feed fetch adapter", () => {
  it("uses only the fixed DNS-pinned policy and normalizes a successful response", async () => {
    const safeFetcher = vi.fn<MarketPulseSafeHttpsFetcher>(async () => result());
    const fetcher = createSafeMarketPulseFeedFetcher(safeFetcher);

    await expect(fetcher(request())).resolves.toEqual({
      status: 200,
      finalUrl: new URL(FED_URL),
      mediaType: "application/rss+xml",
      body: Buffer.from("<rss><channel /></rss>"),
    });
    expect(safeFetcher).toHaveBeenCalledTimes(1);
    expect(safeFetcher.mock.calls[0]?.[0].toString()).toBe(FED_URL);
    expect(safeFetcher.mock.calls[0]?.[1]).toEqual({
      timeoutMs: 8_000,
      maxRedirects: 2,
      maxBodyBytes: 384 * 1024,
      acceptedMediaTypes: [...MARKET_PULSE_ACCEPTED_MEDIA_TYPES],
      acceptHeader: MARKET_PULSE_ACCEPTED_MEDIA_TYPES.join(", "),
      userAgent: "TheThirdPlace-MarketPulse/1.0",
      sameOriginRedirectsOnly: true,
      allowCanonicalWwwRedirect: true,
    });
    expect(safeFetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });

  it("honours stricter caller bounds but cannot be widened beyond the feed policy", async () => {
    const safeFetcher = vi.fn<MarketPulseSafeHttpsFetcher>(async () => result({ mediaType: "text/xml" }));
    const fetcher = createSafeMarketPulseFeedFetcher(safeFetcher);

    await expect(fetcher(request({
      timeoutMs: 60_000,
      maxBodyBytes: 8 * 1024 * 1024,
      acceptedMediaTypes: ["text/xml", "text/html"],
    }))).resolves.toMatchObject({ status: 200, mediaType: "text/xml" });
    expect(safeFetcher.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 8_000,
      maxBodyBytes: 384 * 1024,
      acceptedMediaTypes: ["text/xml"],
      acceptHeader: "text/xml",
    });

    safeFetcher.mockClear();
    await expect(fetcher(request({ timeoutMs: 500, maxBodyBytes: 1_024 })))
      .resolves.toMatchObject({ status: 200 });
    expect(safeFetcher.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 500, maxBodyBytes: 1_024 });
  });

  it("permits only Riksbank's fixed nonstandard identity-encoding label", async () => {
    const safeFetcher = vi.fn<MarketPulseSafeHttpsFetcher>(async (url) => result({
      finalUrl: new URL(url),
      mediaType: "text/xml",
      contentType: "text/xml",
    }));
    const fetcher = createSafeMarketPulseFeedFetcher(safeFetcher);
    await expect(fetcher(request({ url: new URL(RIKSBANK_URL) }))).resolves.toMatchObject({
      status: 200,
      finalUrl: new URL(RIKSBANK_URL),
    });
    expect(safeFetcher.mock.calls[0]?.[1]).toMatchObject({
      identityContentEncodingAliases: ["system.text.utf8encoding+utf8encodingsealed"],
    });
  });

  it("rejects every destination not exactly present in the fixed feed registry before networking", async () => {
    const safeFetcher = vi.fn<MarketPulseSafeHttpsFetcher>(async () => result());
    const fetcher = createSafeMarketPulseFeedFetcher(safeFetcher);

    await expect(fetcher(request({ url: new URL("https://www.federalreserve.gov/feeds/other.xml") })))
      .resolves.toBeUndefined();
    await expect(fetcher(request({ url: new URL(`${FED_URL}?target=https://internal.example`) })))
      .resolves.toBeUndefined();
    await expect(fetcher(request({ url: new URL(`${FED_URL}#fragment`) })))
      .resolves.toBeUndefined();
    expect(safeFetcher).not.toHaveBeenCalled();
  });

  it("revalidates final redirect hosts, media types and body bounds after the pinned fetch", async () => {
    const safeFetcher = vi.fn<MarketPulseSafeHttpsFetcher>();
    const fetcher = createSafeMarketPulseFeedFetcher(safeFetcher);

    safeFetcher.mockResolvedValueOnce(result({ finalUrl: new URL("https://example.com/feed.xml") }));
    await expect(fetcher(request())).resolves.toBeUndefined();

    safeFetcher.mockResolvedValueOnce(result({ mediaType: "text/html", contentType: "text/html" }));
    await expect(fetcher(request())).resolves.toBeUndefined();

    safeFetcher.mockResolvedValueOnce(result({ body: Buffer.alloc(2_049) }));
    await expect(fetcher(request({ maxBodyBytes: 2_048 }))).resolves.toBeUndefined();
  });

  it("fails closed for invalid bounds, disjoint media policy and network errors", async () => {
    const safeFetcher = vi.fn<MarketPulseSafeHttpsFetcher>(async () => {
      throw new Error("network failed");
    });
    const fetcher = createSafeMarketPulseFeedFetcher(safeFetcher);

    await expect(fetcher(request({ timeoutMs: 0 }))).resolves.toBeUndefined();
    await expect(fetcher(request({ maxBodyBytes: Number.NaN }))).resolves.toBeUndefined();
    await expect(fetcher(request({ acceptedMediaTypes: ["text/html"] }))).resolves.toBeUndefined();
    expect(safeFetcher).not.toHaveBeenCalled();

    await expect(fetcher(request())).resolves.toBeUndefined();
    expect(safeFetcher).toHaveBeenCalledTimes(1);
  });
});
