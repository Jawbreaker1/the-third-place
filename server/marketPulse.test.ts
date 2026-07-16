import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JsonFileMarketPulseStateStore,
  MARKET_PULSE_FEEDS,
  MarketPulseCoordinator,
  MemoryMarketPulseStateStore,
  canonicalMarketPulseUrl,
  parseOfficialMarketPulseFeed,
  type MarketPulseFeedFetchResponse,
  type MarketPulsePersistedState,
  type MarketPulseStateStore,
  type ValidatedMarketObservation,
} from "./marketPulse.js";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");
const FED_FEED = "federal-reserve-monetary-policy" as const;

const rss = ({
  guid = "fed-item-1",
  link = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260715a.htm",
  publishedAt = NOW - 10 * 60_000,
  title = "Federal Reserve issues policy decision",
} = {}): string => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Federal Reserve</title>
    <item>
      <guid>${guid}</guid>
      <title>${title}</title>
      <link>${link.replaceAll("&", "&amp;")}</link>
      <pubDate>${new Date(publishedAt).toUTCString()}</pubDate>
      <description><![CDATA[<p>A bounded <strong>policy</strong> summary.</p>]]></description>
    </item>
  </channel>
</rss>`;

const atom = ({ publishedAt = NOW - 20 * 60_000 } = {}): string => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ECB press releases</title>
  <entry>
    <id>tag:ecb.europa.eu,2026:decision-1</id>
    <title>ECB &amp; policy update</title>
    <updated>${new Date(publishedAt).toISOString()}</updated>
    <link rel="alternate" href="https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.test.en.html?b=2&amp;a=1#top" />
    <summary type="html">&lt;p&gt;Rates remain under review.&lt;/p&gt;</summary>
  </entry>
</feed>`;

const feedResponse = (
  body: string,
  headers?: Record<string, string>,
): MarketPulseFeedFetchResponse => ({
  status: 200,
  finalUrl: new URL("https://www.federalreserve.gov/feeds/press_monetary.xml"),
  mediaType: "application/rss+xml",
  body: Buffer.from(body),
  ...(headers ? { headers } : {}),
});

const observation = (
  overrides: Partial<ValidatedMarketObservation> = {},
): ValidatedMarketObservation => ({
  validated: true,
  providerId: "market-provider",
  instrumentId: "OMXS30",
  displayName: "OMX Stockholm 30",
  region: "SE",
  sessionId: "2026-07-15",
  sessionChangePercent: -1.7,
  observedAt: new Date(NOW - 60_000).toISOString(),
  sourceUrl: "https://markets.example.com/index/omxs30",
  sourceTitle: "Validated market overview",
  breadthEligible: true,
  ...overrides,
});

describe("official market pulse feeds", () => {
  it("ships only fixed HTTPS definitions for the four official institutions", () => {
    expect(MARKET_PULSE_FEEDS.map((feed) => feed.id)).toEqual([
      "federal-reserve-monetary-policy",
      "ecb-press",
      "sec-press-releases",
      "riksbank-press-releases",
    ]);
    for (const feed of MARKET_PULSE_FEEDS) {
      expect(new URL(feed.url).protocol).toBe("https:");
      expect(feed.allowedHosts).toContain(new URL(feed.url).hostname);
      expect(feed.pollIntervalMs).toBeGreaterThanOrEqual(5 * 60_000);
    }
  });

  it("parses bounded RSS and Atom structurally, including namespaces, CDATA and entities", () => {
    const parsedRss = parseOfficialMarketPulseFeed(FED_FEED, rss(), NOW);
    expect(parsedRss).toEqual([expect.objectContaining({
      itemId: "fed-item-1",
      title: "Federal Reserve issues policy decision",
      summary: "A bounded policy summary.",
      publishedAt: "2026-07-15T11:50:00.000Z",
    })]);

    const parsedAtom = parseOfficialMarketPulseFeed("ecb-press", atom(), NOW);
    expect(parsedAtom).toEqual([expect.objectContaining({
      itemId: "tag:ecb.europa.eu,2026:decision-1",
      title: "ECB & policy update",
      url: "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.test.en.html?a=1&b=2",
      summary: "Rates remain under review.",
    })]);
  });

  it("rejects DTDs, malformed XML, oversized input, stale/future items and off-provider links", () => {
    expect(parseOfficialMarketPulseFeed(
      FED_FEED,
      '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel /></rss>',
      NOW,
    )).toBeUndefined();
    expect(parseOfficialMarketPulseFeed(FED_FEED, "<rss><channel><item></rss>", NOW)).toBeUndefined();
    expect(parseOfficialMarketPulseFeed(FED_FEED, "x".repeat(400_000), NOW)).toBeUndefined();
    expect(parseOfficialMarketPulseFeed(FED_FEED, rss({ publishedAt: NOW - 4 * 24 * 60 * 60_000 }), NOW)).toEqual([]);
    expect(parseOfficialMarketPulseFeed(FED_FEED, rss({ publishedAt: NOW + 6 * 60_000 }), NOW)).toEqual([]);
    expect(parseOfficialMarketPulseFeed(FED_FEED, rss({ link: "https://evil.example/story" }), NOW)).toEqual([]);
  });

  it("canonicalizes only public HTTPS URLs and removes fragments while sorting queries", () => {
    expect(canonicalMarketPulseUrl("https://EXAMPLE.com/story?z=2&a=1#part"))
      .toBe("https://example.com/story?a=1&z=2");
    expect(canonicalMarketPulseUrl("http://example.com/story")).toBeUndefined();
    expect(canonicalMarketPulseUrl("https://127.0.0.1/story")).toBeUndefined();
  });
});

describe("MarketPulseCoordinator feed polling", () => {
  it("uses ETag and Last-Modified validators, treats 304 as success and does not repeat an item", async () => {
    let now = NOW;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(feedResponse(rss(), {
        ETag: '"version-1"',
        "Last-Modified": new Date(NOW - 30_000).toUTCString(),
      }))
      .mockResolvedValueOnce({
        status: 304,
        finalUrl: new URL("https://www.federalreserve.gov/feeds/press_monetary.xml"),
        mediaType: "application/rss+xml",
      } satisfies MarketPulseFeedFetchResponse);
    const coordinator = new MarketPulseCoordinator(fetcher, new MemoryMarketPulseStateStore(), {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });

    const [candidate] = await coordinator.pollOfficialFeeds();
    expect(candidate).toEqual(expect.objectContaining({
      origin: "official_feed",
      priority: "routine",
      providerId: FED_FEED,
    }));
    await coordinator.acknowledgeFeedPublication(candidate!);
    expect(await coordinator.pollOfficialFeeds()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 10 * 60_000;
    expect(await coordinator.pollOfficialFeeds()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0].headers).toMatchObject({
      "If-None-Match": '"version-1"',
      "If-Modified-Since": new Date(NOW - 30_000).toUTCString(),
    });
    expect((await coordinator.diagnostics())[0]).toMatchObject({
      consecutiveFailures: 0,
      hasValidator: true,
      lastSuccessAt: now,
    });
  });

  it("retries an unacknowledged discovery across restart even when the next feed response is 304", async () => {
    let now = NOW;
    const store = new MemoryMarketPulseStateStore();
    const first = new MarketPulseCoordinator(
      vi.fn(async () => feedResponse(rss(), { ETag: '"outbox-version"' })),
      store,
      { now: () => now, enabledFeedIds: [FED_FEED] },
    );
    const [discovered] = await first.pollOfficialFeeds();
    expect(discovered).toBeDefined();
    expect(await store.load()).toMatchObject({
      version: 2,
      pendingFeedCandidates: [expect.objectContaining({ id: discovered!.id })],
      seen: [],
    });

    now += 10 * 60_000;
    const afterRestartFetcher = vi.fn(async () => ({
      status: 304,
      finalUrl: new URL("https://www.federalreserve.gov/feeds/press_monetary.xml"),
      mediaType: "application/rss+xml",
    } satisfies MarketPulseFeedFetchResponse));
    const afterRestart = new MarketPulseCoordinator(afterRestartFetcher, store, {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    expect(await afterRestart.pollOfficialFeeds()).toEqual([discovered]);
    expect(afterRestartFetcher.mock.calls[0]?.[0].headers).toMatchObject({
      "If-None-Match": '"outbox-version"',
    });

    await afterRestart.acknowledgeFeedPublication(discovered!);
    await expect(afterRestart.acknowledgeFeedPublication(discovered!)).resolves.toBeUndefined();
    expect(await store.load()).toMatchObject({
      pendingFeedCandidates: [],
      seen: [expect.any(Object), expect.any(Object)],
    });

    now += 10 * 60_000;
    const finalRestart = new MarketPulseCoordinator(afterRestartFetcher, store, {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    expect(await finalRestart.pollOfficialFeeds()).toEqual([]);
  });

  it("keeps the outbox retryable in memory and on disk when acknowledgement persistence fails", async () => {
    let now = NOW;
    let rejectAcknowledgement = false;
    const durableStore = new MemoryMarketPulseStateStore();
    const store: MarketPulseStateStore = {
      load: () => durableStore.load(),
      save: async (state: MarketPulsePersistedState) => {
        if (rejectAcknowledgement && state.pendingFeedCandidates.length === 0) {
          rejectAcknowledgement = false;
          throw new Error("simulated acknowledgement write failure");
        }
        await durableStore.save(state);
      },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(feedResponse(rss(), { ETag: '"retry-version"' }))
      .mockResolvedValueOnce({
        status: 304,
        finalUrl: new URL("https://www.federalreserve.gov/feeds/press_monetary.xml"),
        mediaType: "application/rss+xml",
      } satisfies MarketPulseFeedFetchResponse);
    const coordinator = new MarketPulseCoordinator(fetcher, store, {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    const [candidate] = await coordinator.pollOfficialFeeds();
    rejectAcknowledgement = true;
    await expect(coordinator.acknowledgeFeedPublication(candidate!))
      .rejects.toThrow("simulated acknowledgement write failure");
    expect(await durableStore.load()).toMatchObject({
      pendingFeedCandidates: [expect.objectContaining({ id: candidate!.id })],
      seen: [],
    });

    now += 10 * 60_000;
    expect(await coordinator.pollOfficialFeeds()).toEqual([candidate]);
  });

  it("deduplicates both provider IDs and canonical URLs across coordinator restarts for 30 days", async () => {
    let now = NOW;
    const store = new MemoryMarketPulseStateStore();
    const firstFetcher = vi.fn(async () => feedResponse(rss({
      guid: "first-guid",
      link: "https://www.federalreserve.gov/story?b=2&a=1#first",
    })));
    const first = new MarketPulseCoordinator(firstFetcher, store, {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    const [published] = await first.pollOfficialFeeds();
    expect(published).toBeDefined();
    await first.acknowledgeFeedPublication(published!);

    now += 10 * 60_000;
    const secondFetcher = vi.fn(async () => feedResponse(rss({
      guid: "changed-guid",
      link: "https://www.federalreserve.gov/story?a=1&b=2#second",
      publishedAt: now - 60_000,
    })));
    const restarted = new MarketPulseCoordinator(secondFetcher, store, {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    expect(await restarted.pollOfficialFeeds()).toEqual([]);

    now += 31 * 24 * 60 * 60_000;
    const afterRetention = new MarketPulseCoordinator(
      vi.fn(async () => feedResponse(rss({
        guid: "changed-guid",
        link: "https://www.federalreserve.gov/story?a=1&b=2",
        publishedAt: now - 60_000,
      }))),
      store,
      { now: () => now, enabledFeedIds: [FED_FEED] },
    );
    expect(await afterRetention.pollOfficialFeeds()).toHaveLength(1);
  });

  it("applies an independent bounded exponential backoff to a failing feed", async () => {
    let now = NOW;
    const fetcher = vi.fn(async () => undefined);
    const coordinator = new MarketPulseCoordinator(fetcher, new MemoryMarketPulseStateStore(), {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    expect(await coordinator.pollOfficialFeeds()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await coordinator.diagnostics())[0]).toMatchObject({
      consecutiveFailures: 1,
      nextPollAt: NOW + 60_000,
    });

    now += 30_000;
    await coordinator.pollOfficialFeeds();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 30_000;
    await coordinator.pollOfficialFeeds();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await coordinator.diagnostics())[0]).toMatchObject({
      consecutiveFailures: 2,
      nextPollAt: now + 2 * 60_000,
    });
  });

  it("polls the most overdue fixed feeds first so a small per-tick budget cannot starve later feeds", async () => {
    let now = NOW;
    const fetcher = vi.fn(async (request: { url: URL }) => ({
      status: 304,
      finalUrl: request.url,
      mediaType: "application/rss+xml",
    } satisfies MarketPulseFeedFetchResponse));
    const coordinator = new MarketPulseCoordinator(fetcher, new MemoryMarketPulseStateStore(), {
      now: () => now,
      maxFeedsPerPoll: 2,
    });
    await coordinator.pollOfficialFeeds();
    expect(fetcher.mock.calls.slice(0, 2).map((call) => call[0].url.toString())).toEqual([
      MARKET_PULSE_FEEDS[0].url,
      MARKET_PULSE_FEEDS[1].url,
    ]);

    now += 20 * 60_000;
    await coordinator.pollOfficialFeeds();
    expect(fetcher.mock.calls.slice(2, 4).map((call) => call[0].url.toString())).toEqual([
      MARKET_PULSE_FEEDS[2].url,
      MARKET_PULSE_FEEDS[3].url,
    ]);
  });

  it("rejects unsafe redirects, media types and response bodies even if an injected fetcher misbehaves", async () => {
    const responses: MarketPulseFeedFetchResponse[] = [
      {
        ...feedResponse(rss()),
        finalUrl: new URL("https://evil.example/feed.xml"),
      },
      {
        ...feedResponse(rss()),
        mediaType: "text/html",
      },
      {
        ...feedResponse(rss()),
        body: Buffer.alloc(400_000),
      },
    ];
    let now = NOW;
    const fetcher = vi.fn(async () => responses.shift());
    const coordinator = new MarketPulseCoordinator(fetcher, new MemoryMarketPulseStateStore(), {
      now: () => now,
      enabledFeedIds: [FED_FEED],
    });
    for (let failure = 1; failure <= 3; failure += 1) {
      expect(await coordinator.pollOfficialFeeds()).toEqual([]);
      const diagnostic = (await coordinator.diagnostics())[0]!;
      expect(diagnostic.consecutiveFailures).toBe(failure);
      now = diagnostic.nextPollAt;
    }
  });

  it("persists bounded state atomically through the JSON state-store implementation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "market-pulse-"));
    const path = join(directory, "state.json");
    try {
      const store = new JsonFileMarketPulseStateStore(path);
      const coordinator = new MarketPulseCoordinator(
        vi.fn(async () => feedResponse(rss())),
        store,
        { now: () => NOW, enabledFeedIds: [FED_FEED] },
      );
      const [published] = await coordinator.pollOfficialFeeds();
      expect(published).toBeDefined();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        version: 2,
        pendingFeedCandidates: [expect.objectContaining({ id: published!.id })],
        seen: [],
      });
      await coordinator.acknowledgeFeedPublication(published!);
      const restarted = new MarketPulseCoordinator(
        vi.fn(async () => feedResponse(rss())),
        new JsonFileMarketPulseStateStore(path),
        { now: () => NOW + 10 * 60_000, enabledFeedIds: [FED_FEED] },
      );
      expect(await restarted.pollOfficialFeeds()).toEqual([]);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        version: 2,
        pendingFeedCandidates: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates version-1 state without treating a newly discovered item as published", async () => {
    const directory = await mkdtemp(join(tmpdir(), "market-pulse-v1-"));
    const path = join(directory, "state.json");
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        feeds: {},
        seen: [],
        movementHighWater: [],
      }), "utf8");
      const coordinator = new MarketPulseCoordinator(
        vi.fn(async () => feedResponse(rss())),
        new JsonFileMarketPulseStateStore(path),
        { now: () => NOW, enabledFeedIds: [FED_FEED] },
      );
      const [candidate] = await coordinator.pollOfficialFeeds();
      expect(candidate).toBeDefined();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        version: 2,
        pendingFeedCandidates: [expect.objectContaining({ id: candidate!.id })],
        seen: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers from malformed persisted JSON without accepting any unvalidated state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "market-pulse-corrupt-"));
    const path = join(directory, "state.json");
    try {
      await writeFile(path, "{not-json", "utf8");
      const coordinator = new MarketPulseCoordinator(
        vi.fn(async () => feedResponse(rss())),
        new JsonFileMarketPulseStateStore(path),
        { now: () => NOW, enabledFeedIds: [FED_FEED] },
      );
      expect(await coordinator.pollOfficialFeeds()).toHaveLength(1);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("MarketPulseCoordinator numeric movement evaluation", () => {
  it("emits threshold crossings only, preserving high-water state across restarts", async () => {
    const store = new MemoryMarketPulseStateStore();
    const coordinator = new MarketPulseCoordinator(vi.fn(), store, {
      now: () => NOW,
      enabledFeedIds: [],
    });
    expect(await coordinator.evaluateMarketObservations([observation()])).toEqual([
      expect.objectContaining({ priority: "notable", severityBand: 1, scope: "single_index" }),
    ]);
    expect(await coordinator.evaluateMarketObservations([
      observation({ sessionChangePercent: -2.9 }),
    ])).toEqual([]);

    const restarted = new MarketPulseCoordinator(vi.fn(), store, {
      now: () => NOW,
      enabledFeedIds: [],
    });
    expect(await restarted.evaluateMarketObservations([
      observation({ sessionChangePercent: -3.1 }),
    ])).toEqual([
      expect.objectContaining({ priority: "exceptional", severityBand: 2 }),
    ]);
    expect(await restarted.evaluateMarketObservations([
      observation({ sessionChangePercent: -4.9 }),
    ])).toEqual([]);
    expect(await restarted.evaluateMarketObservations([
      observation({ sessionChangePercent: -5.1 }),
    ])).toEqual([
      expect.objectContaining({ priority: "exceptional", severityBand: 3 }),
    ]);
  });

  it("rejects stale, future, unvalidated and malformed numeric observations", async () => {
    const coordinator = new MarketPulseCoordinator(vi.fn(), new MemoryMarketPulseStateStore(), {
      now: () => NOW,
      enabledFeedIds: [],
    });
    const invalid = [
      observation({ validated: false as true }),
      observation({ observedAt: new Date(NOW - 31 * 60_000).toISOString() }),
      observation({ observedAt: new Date(NOW + 6 * 60_000).toISOString() }),
      observation({ sessionChangePercent: Number.NaN }),
      observation({ sourceUrl: "http://markets.example.com/index/omxs30" }),
    ];
    expect(await coordinator.evaluateMarketObservations(invalid)).toEqual([]);
  });

  it("raises one exceptional broad-market candidate for same-direction breadth across regions", async () => {
    const coordinator = new MarketPulseCoordinator(vi.fn(), new MemoryMarketPulseStateStore(), {
      now: () => NOW,
      enabledFeedIds: [],
    });
    const observations = [
      observation(),
      observation({
        instrumentId: "DAX",
        displayName: "DAX",
        region: "DE",
        sessionChangePercent: -1.8,
        sourceUrl: "https://markets.example.com/index/dax",
      }),
      observation({
        instrumentId: "SPX",
        displayName: "S&P 500",
        region: "US",
        sessionChangePercent: -2.1,
        sourceUrl: "https://markets.example.com/index/spx",
      }),
    ];
    const first = await coordinator.evaluateMarketObservations(observations);
    expect(first).toEqual([expect.objectContaining({
      origin: "validated_market_observation",
      priority: "exceptional",
      scope: "broad_market",
      direction: "down",
      severityBand: 2,
      observations: expect.arrayContaining([
        expect.objectContaining({ instrumentId: "OMXS30" }),
        expect.objectContaining({ instrumentId: "DAX" }),
        expect.objectContaining({ instrumentId: "SPX" }),
      ]),
    })]);
    expect(first[0]?.observations.every((entry) => !("breadthEligible" in entry))).toBe(true);
    expect(await coordinator.evaluateMarketObservations(observations)).toEqual([]);

    const escalated = observations.map((entry, index) =>
      index === 0 ? { ...entry, sessionChangePercent: -5.2 } : entry);
    expect(await coordinator.evaluateMarketObservations(escalated)).toEqual([
      expect.objectContaining({ priority: "exceptional", scope: "broad_market", severityBand: 3 }),
    ]);
  });

  it("never derives exceptional priority from ordinary feed metadata or insufficient breadth", async () => {
    const coordinator = new MarketPulseCoordinator(
      vi.fn(async () => feedResponse(rss())),
      new MemoryMarketPulseStateStore(),
      { now: () => NOW, enabledFeedIds: [FED_FEED] },
    );
    const candidates = await coordinator.collect([
      observation({ breadthEligible: false }),
      observation({
        instrumentId: "SECOND",
        displayName: "Second index",
        sessionChangePercent: -1.8,
        breadthEligible: false,
        sourceUrl: "https://markets.example.com/index/second",
      }),
    ]);
    expect(candidates.some((candidate) => candidate.origin === "official_feed" && candidate.priority !== "routine"))
      .toBe(false);
    expect(candidates.filter((candidate) => candidate.origin === "validated_market_observation"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ priority: "notable" })]));
    expect(candidates.some((candidate) => candidate.priority === "exceptional")).toBe(false);
  });
});
