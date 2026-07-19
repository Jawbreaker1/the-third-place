import { describe, expect, it, vi } from "vitest";
import type { MarketTickerFeedCard } from "../shared/types.js";
import {
  ChannelFeedConversationLedger,
  channelFeedConversationPolicy,
  MemoryChannelFeedConversationPersistence,
  channelFeedConversationChance,
  channelFeedConversationCue,
  type ChannelFeedConversationPolicy,
} from "./channelFeedConversation.js";

const NOW = Date.parse("2026-07-19T14:00:00.000Z");
const MINUTE = 60_000;

const card = (input: Partial<MarketTickerFeedCard> & {
  revision?: number;
  freshness?: "recent" | "previous_session" | "stale";
} = {}): MarketTickerFeedCard => {
  const freshness = input.freshness ?? "recent";
  return {
    id: "market-wire",
    kind: "market_ticker",
    channelId: "stock-market",
    publisher: {
      id: "bot-market-wire",
      name: "MarketWire",
      badge: "BOT",
      avatar: { color: "#111111", accent: "#eeeeee", glyph: "MW" },
    },
    revision: input.revision ?? 7,
    state: "ready",
    title: "Latest reported markets",
    targetId: "COMMUNITY_MAJOR",
    updatedAt: new Date(NOW).toISOString(),
    retrievedAt: new Date(NOW).toISOString(),
    requestedIndexIds: ["SE_OMXS30", "US_SP500"],
    missingIndexIds: [],
    coverage: { requested: 2, available: 2, ratio: 1, complete: true },
    observations: [
      {
        indexId: "SE_OMXS30",
        displayName: "OMX Stockholm 30",
        shortName: "OMXS30",
        currency: "SEK",
        level: 2_681.4,
        previousClose: 2_664.8,
        change: 16.6,
        changePercent: 16.6 / 2_664.8 * 100,
        changeBasis: "previous_close",
        tradingDate: "2026-07-19",
        observedAt: new Date(NOW - (freshness === "recent" ? 5 : 180) * MINUTE).toISOString(),
        freshness,
        source: {
          id: "yahoo-chart",
          label: "Yahoo Finance",
          url: "https://finance.yahoo.com/quote/%5EOMX/",
          retrievedAt: new Date(NOW).toISOString(),
          experimental: true,
        },
      },
      {
        indexId: "US_SP500",
        displayName: "S&P 500",
        shortName: "S&P 500",
        currency: "USD",
        level: 7_457.69,
        previousClose: 7_533.77,
        change: -76.08,
        changePercent: -76.08 / 7_533.77 * 100,
        changeBasis: "previous_close",
        tradingDate: "2026-07-19",
        observedAt: new Date(NOW - (freshness === "recent" ? 8 : 190) * MINUTE).toISOString(),
        freshness,
        source: {
          id: "yahoo-chart",
          label: "Yahoo Finance",
          url: "https://finance.yahoo.com/quote/%5EGSPC/",
          retrievedAt: new Date(NOW).toISOString(),
          experimental: true,
        },
      },
    ],
    ...input,
  };
};

const policy: ChannelFeedConversationPolicy = {
  frequency: 100,
  hardCooldownMs: 30 * MINUTE,
  failedAttemptCooldownMs: 2 * MINUTE,
};

describe("channel feed conversation cue projection", () => {
  it("creates a fact-bound market cue without claiming that an exchange is open", () => {
    const cue = channelFeedConversationCue(card());
    expect(cue).toMatchObject({
      feedId: "market-wire",
      channelId: "stock-market",
      feedKind: "market_ticker",
      revision: 7,
      revisionKey: "market_ticker:market-wire:7",
      semanticKey: "channel-feed:stock-market:market-wire",
      relevance: "high",
    });
    expect(cue?.fact.content).toContain("2681.40 index points");
    expect(cue?.discussionPremise).toContain("latest reported observations versus previous close");
    expect(cue?.discussionPremise).toContain("Do not infer");
    expect(cue?.discussionPremise).toContain("whether any exchange is open");
  });

  it("keeps stale observations below previous-session relevance", () => {
    const cue = channelFeedConversationCue(card({ freshness: "previous_session" }));
    const stale = channelFeedConversationCue(card({ freshness: "stale" }));
    expect(cue?.relevance).toBe("normal");
    expect(stale?.relevance).toBe("low");
    expect(channelFeedConversationChance(80, "normal")).toBeCloseTo(0.56);
    expect(channelFeedConversationChance(80, "low")).toBeCloseTo(0.28);
    expect(channelFeedConversationChance(80, "high")).toBeCloseTo(0.8);
  });

  it("does not create a conversational cue for unavailable or empty market data", () => {
    expect(channelFeedConversationCue(card({ state: "unavailable" }))).toBeUndefined();
    expect(channelFeedConversationCue(card({
      state: "partial",
      observations: [],
      missingIndexIds: ["SE_OMXS30", "US_SP500"],
      coverage: { requested: 2, available: 0, ratio: 0, complete: false },
      retrievedAt: undefined,
    }))).toBeUndefined();
  });
});

describe("channel feed conversation policy", () => {
  it("keeps discussion independent from polling and bounded even at maximum", () => {
    expect(channelFeedConversationPolicy(0)).toMatchObject({
      frequency: 0,
      hardCooldownMs: 180 * MINUTE,
      failedAttemptCooldownMs: 3 * MINUTE,
    });
    expect(channelFeedConversationPolicy(50).hardCooldownMs).toBe(105 * MINUTE);
    expect(channelFeedConversationPolicy(100)).toMatchObject({
      frequency: 100,
      hardCooldownMs: 30 * MINUTE,
    });
    expect(channelFeedConversationPolicy(200).frequency).toBe(100);
  });
});

describe("ChannelFeedConversationLedger", () => {
  it("samples once per configured frequency and reconsiders a skip only after an explicit increase", async () => {
    const persistence = new MemoryChannelFeedConversationPersistence();
    const cue = channelFeedConversationCue(card({ freshness: "previous_session" }))!;
    const first = new ChannelFeedConversationLedger(persistence);
    await first.start();
    const rng = vi.fn(() => 0.5);
    const decision = await first.reserve(cue, { ...policy, frequency: 20 }, NOW, rng);
    expect(decision).toMatchObject({ eligible: false, reason: "chance" });
    expect(decision.chance).toBeCloseTo(0.14);
    expect(rng).toHaveBeenCalledTimes(1);

    const restarted = new ChannelFeedConversationLedger(persistence);
    await restarted.start();
    await expect(restarted.reserve(cue, { ...policy, frequency: 20 }, NOW + MINUTE, rng))
      .resolves.toMatchObject({ eligible: false, reason: "chance" });
    expect(rng).toHaveBeenCalledTimes(1);
    await expect(restarted.reserve(cue, { ...policy, frequency: 100 }, NOW + 2 * MINUTE, rng))
      .resolves.toMatchObject({ eligible: true, reason: "eligible" });
    expect(rng).toHaveBeenCalledTimes(1);
    await expect(restarted.reserve(cue, { ...policy, frequency: 100 }, NOW + 3 * MINUTE, rng))
      .resolves.toMatchObject({ eligible: false, reason: "retry_backoff" });
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it("retries an admitted failed revision only after backoff and never rerolls it", async () => {
    const ledger = new ChannelFeedConversationLedger(new MemoryChannelFeedConversationPersistence());
    await ledger.start();
    const cue = channelFeedConversationCue(card())!;
    const rng = vi.fn(() => 0.2);

    await expect(ledger.reserve(cue, policy, NOW, rng))
      .resolves.toMatchObject({ eligible: true, reason: "eligible" });
    await expect(ledger.reserve(cue, policy, NOW + MINUTE, rng))
      .resolves.toMatchObject({ eligible: false, reason: "retry_backoff" });
    await expect(ledger.reserve(cue, policy, NOW + 2 * MINUTE, rng))
      .resolves.toMatchObject({ eligible: true, reason: "eligible" });
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it("persists publication idempotency and applies a hard cooldown to newer revisions", async () => {
    const persistence = new MemoryChannelFeedConversationPersistence();
    const ledger = new ChannelFeedConversationLedger(persistence);
    await ledger.start();
    const revisionSeven = channelFeedConversationCue(card({ revision: 7 }))!;
    const revisionEight = channelFeedConversationCue(card({ revision: 8 }))!;
    expect((await ledger.reserve(revisionSeven, policy, NOW, () => 0)).eligible).toBe(true);
    await ledger.acknowledgePublished(revisionSeven, NOW + MINUTE);

    const restarted = new ChannelFeedConversationLedger(persistence);
    await restarted.start();
    await expect(restarted.reserve(revisionSeven, policy, NOW + 40 * MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: false, reason: "already_published" });
    await expect(restarted.reserve(revisionEight, policy, NOW + 20 * MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: false, reason: "hard_cooldown" });
    await expect(restarted.reserve(revisionEight, policy, NOW + 31 * MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: true, reason: "eligible" });
  });

  it("shares the hard publication cooldown across two feeds in the same room", async () => {
    const ledger = new ChannelFeedConversationLedger(new MemoryChannelFeedConversationPersistence());
    await ledger.start();
    const first = channelFeedConversationCue(card({ revision: 7 }))!;
    const second: ChannelFeedConversationCue = {
      ...channelFeedConversationCue(card({ revision: 1 }))!,
      feedId: "macro-wire",
      revisionKey: "market_ticker:macro-wire:1",
      semanticKey: "channel-feed:stock-market:macro-wire",
    };
    expect((await ledger.reserve(first, policy, NOW, () => 0)).eligible).toBe(true);
    await ledger.acknowledgePublished(first, NOW + MINUTE);
    await expect(ledger.reserve(second, policy, NOW + 20 * MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: false, reason: "hard_cooldown" });
    await expect(ledger.reserve(second, policy, NOW + 31 * MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: true, reason: "eligible" });
  });

  it("keeps in-memory admission and acknowledgement state atomic when persistence fails", async () => {
    let durable: unknown;
    let failSave = true;
    const persistence = {
      load: async () => durable,
      save: async (state: unknown) => {
        if (failSave) throw new Error("disk unavailable");
        durable = structuredClone(state);
      },
    };
    const ledger = new ChannelFeedConversationLedger(persistence);
    await ledger.start();
    const cue = channelFeedConversationCue(card())!;
    await expect(ledger.reserve(cue, policy, NOW, () => 0)).rejects.toThrow("disk unavailable");
    expect(ledger.snapshot().feeds).toEqual([]);

    failSave = false;
    await expect(ledger.reserve(cue, policy, NOW, () => 0))
      .resolves.toMatchObject({ eligible: true });
    const reserved = ledger.snapshot();
    failSave = true;
    await expect(ledger.acknowledgePublished(cue, NOW + MINUTE)).rejects.toThrow("disk unavailable");
    expect(ledger.snapshot()).toEqual(reserved);
  });

  it("repairs a durable room-first publication receipt after restart", async () => {
    const persistence = new MemoryChannelFeedConversationPersistence();
    const first = new ChannelFeedConversationLedger(persistence);
    await first.start();
    const cue = channelFeedConversationCue(card())!;
    await first.reserve(cue, policy, NOW, () => 0);

    const restarted = new ChannelFeedConversationLedger(persistence);
    await restarted.start();
    await expect(restarted.reconcilePublished([{
      feedId: cue.feedId,
      channelId: cue.channelId,
      revisionKey: cue.revisionKey,
      revision: cue.revision,
      publishedAt: NOW + MINUTE,
    }])).resolves.toBe(1);
    expect(restarted.snapshot().feeds[0]).toMatchObject({
      lastPublishedRevisionKey: cue.revisionKey,
      lastPublishedAt: NOW + MINUTE,
    });
    await expect(restarted.reserve(cue, policy, NOW + 40 * MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: false, reason: "already_published" });
  });

  it("rejects an older revision after a newer revision has been considered", async () => {
    const ledger = new ChannelFeedConversationLedger(new MemoryChannelFeedConversationPersistence());
    await ledger.start();
    const newer = channelFeedConversationCue(card({ revision: 9 }))!;
    const older = channelFeedConversationCue(card({ revision: 8 }))!;
    await ledger.reserve(newer, policy, NOW, () => 0.99);
    await expect(ledger.reserve(older, policy, NOW + MINUTE, () => 0))
      .resolves.toMatchObject({ eligible: false, reason: "superseded" });
  });

  it("requires a successful reservation before publication acknowledgement", async () => {
    const ledger = new ChannelFeedConversationLedger(new MemoryChannelFeedConversationPersistence());
    await ledger.start();
    await expect(ledger.acknowledgePublished(channelFeedConversationCue(card())!, NOW))
      .rejects.toThrow("unreserved");
  });

  it("fails closed on malformed persisted decision state", async () => {
    const persistence = {
      load: async () => ({
        version: 1,
        feeds: [{ feedId: "market-wire", consideredRevisionKey: "bad key", admitted: true }],
      }),
      save: async () => undefined,
    };
    await expect(new ChannelFeedConversationLedger(persistence).start())
      .rejects.toThrow("Invalid feed discussion state");
  });
});
