import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelFeedCard, MarketTickerFeedObservation } from "../shared/types.js";
import {
  ChannelFeedStateLoadError,
  ChannelFeedStore,
  JsonFileChannelFeedPersistence,
  MemoryChannelFeedPersistence,
  type ChannelFeedCardDraft,
  type ChannelFeedPersistedState,
  type ChannelFeedPersistence,
} from "./channelFeedStore.js";

const START = Date.parse("2026-07-19T12:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const observation = (
  indexId = "SE_OMXS30",
  options: Partial<MarketTickerFeedObservation> = {},
): MarketTickerFeedObservation => ({
  indexId,
  displayName: indexId === "SE_OMXS30" ? "OMX Stockholm 30" : indexId,
  shortName: indexId === "SE_OMXS30" ? "OMXS30" : indexId,
  currency: "SEK",
  level: 2_020,
  previousClose: 2_000,
  change: 20,
  changePercent: 1,
  changeBasis: "previous_close",
  tradingDate: "2026-07-19",
  observedAt: new Date(START - 60_000).toISOString(),
  freshness: "recent",
  source: {
    id: "test-provider",
    label: "Test Provider",
    url: `https://example.com/markets/${indexId}`,
    retrievedAt: new Date(START).toISOString(),
    experimental: true,
  },
  ...options,
});

const draft = (
  options: Partial<ChannelFeedCardDraft> = {},
): ChannelFeedCardDraft => ({
  id: "market-wire",
  kind: "market_ticker",
  channelId: "stock-market",
  publisher: {
    id: "market-wire",
    name: "MarketWire",
    badge: "BOT",
    avatar: { color: "#152733", accent: "#68d5c0", glyph: "MW" },
  },
  state: "ready",
  title: "Latest reported markets",
  targetId: "COMMUNITY_MAJOR",
  updatedAt: new Date(START).toISOString(),
  retrievedAt: new Date(START).toISOString(),
  requestedIndexIds: ["SE_OMXS30"],
  missingIndexIds: [],
  coverage: { requested: 1, available: 1, ratio: 1, complete: true },
  observations: [observation()],
  ...options,
});

const timing = (attemptedAt = START, delay = 30 * 60_000) => ({
  attemptedAt,
  nextPollAt: attemptedAt + delay,
});

const emptyUnavailableDraft = (at = START): ChannelFeedCardDraft => {
  const source = draft();
  const { retrievedAt: _retrievedAt, ...withoutRetrievedAt } = source;
  return {
    ...withoutRetrievedAt,
    state: "unavailable",
    updatedAt: new Date(at).toISOString(),
    missingIndexIds: [...source.requestedIndexIds],
    coverage: { requested: 1, available: 0, ratio: 0, complete: false },
    observations: [],
  };
};

class TogglePersistence implements ChannelFeedPersistence {
  state?: ChannelFeedPersistedState;
  fail = false;

  async load(): Promise<unknown | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: ChannelFeedPersistedState): Promise<void> {
    if (this.fail) throw new Error("disk unavailable");
    this.state = structuredClone(state);
  }
}

describe("ChannelFeedStore", () => {
  it("treats a missing persistence payload as an empty store", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    expect(store.cards()).toEqual([]);
    expect(store.schedules()).toEqual([]);
  });

  it("loads a valid version-one payload with empty controls and migrates it on the next write", async () => {
    let saved: ChannelFeedPersistedState | undefined;
    const persistence: ChannelFeedPersistence = {
      load: async () => ({
        version: 1,
        cards: [{ ...draft(), revision: 1 }],
        schedules: [{
          feedId: "market-wire",
          lastAttemptAt: START,
          lastSuccessAt: START,
          nextPollAt: START + 30 * 60_000,
          failures: 0,
        }],
      }),
      save: async (state) => { saved = structuredClone(state); },
    };
    const store = new ChannelFeedStore({ persistence });
    await store.load();
    expect(store.getCard("market-wire")?.revision).toBe(1);
    expect(store.configurations()).toEqual([]);

    await store.reschedule("market-wire", START + 5 * 60_000);
    expect(saved).toMatchObject({ version: 2, configurations: [] });
  });

  it("round-trips disabled cadence controls and atomically clears fresh-poll gating", async () => {
    const persistence = new MemoryChannelFeedPersistence();
    const first = new ChannelFeedStore({ persistence });
    await first.load();
    await first.publishSuccess("market-wire", draft(), timing());
    await first.configure("market-wire", {
      feedId: "market-wire",
      enabled: false,
      activeIntervalMs: 5 * 60_000,
      idleIntervalMs: 45 * 60_000,
      freshPollRequired: true,
    }, START + 45 * 60_000);

    const restored = new ChannelFeedStore({ persistence });
    await restored.load();
    expect(restored.configuration("market-wire")).toEqual({
      feedId: "market-wire",
      enabled: false,
      activeIntervalMs: 5 * 60_000,
      idleIntervalMs: 45 * 60_000,
      freshPollRequired: true,
    });
    await restored.configure("market-wire", {
      feedId: "market-wire",
      enabled: true,
      activeIntervalMs: 5 * 60_000,
      idleIntervalMs: 45 * 60_000,
      freshPollRequired: true,
    }, START + 5 * 60_000);
    expect(restored.configuration("market-wire")?.freshPollRequired).toBe(true);

    await restored.publishUnchanged("market-wire", timing(START + 5 * 60_000, 5 * 60_000));
    expect(restored.configuration("market-wire")?.freshPollRequired).toBe(false);
    const final = new ChannelFeedStore({ persistence });
    await final.load();
    expect(final.configuration("market-wire")?.freshPollRequired).toBe(false);
  });

  it("assigns monotonic revisions and restores cards plus scheduler metadata", async () => {
    const persistence = new MemoryChannelFeedPersistence();
    const first = new ChannelFeedStore({ persistence });
    await first.load();

    const published = await first.publishSuccess("market-wire", draft(), timing());
    expect(published.revision).toBe(1);
    expect(first.schedule("market-wire")).toEqual({
      feedId: "market-wire",
      lastAttemptAt: START,
      lastSuccessAt: START,
      nextPollAt: START + 30 * 60_000,
      failures: 0,
    });

    const restored = new ChannelFeedStore({ persistence });
    await restored.load();
    expect(restored.getCard("market-wire")).toEqual(published);
    expect(restored.schedule("market-wire")).toEqual(first.schedule("market-wire"));

    const changed = await restored.publishSuccess(
      "market-wire",
      draft({
        updatedAt: new Date(START + 30 * 60_000).toISOString(),
        retrievedAt: new Date(START + 30 * 60_000).toISOString(),
        observations: [observation("SE_OMXS30", {
          observedAt: new Date(START + 29 * 60_000).toISOString(),
          source: {
            ...observation().source,
            retrievedAt: new Date(START + 30 * 60_000).toISOString(),
          },
        })],
      }),
      timing(START + 30 * 60_000),
    );
    expect(changed.revision).toBe(2);
  });

  it("records a healthy unchanged poll without creating a presentation revision", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    const card = await store.publishSuccess("market-wire", draft(), timing());
    const failedAt = START + 5 * 24 * 60 * 60_000;
    await store.publishFailure("market-wire", timing(failedAt));

    const schedule = await store.publishUnchanged("market-wire", timing(failedAt + 30 * 60_000));
    expect(schedule).toMatchObject({ failures: 0, lastSuccessAt: failedAt + 30 * 60_000 });
    expect(store.getCard("market-wire")?.revision).toBe(card.revision + 1);
    expect(store.getCard("market-wire")?.updatedAt).toBe(card.updatedAt);
  });

  it("publishes a sanitized unavailable card once, but persists later retry backoff without noisy revisions", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    await store.publishSuccess("market-wire", draft(), timing());

    const firstFailure = await store.publishFailure(
      "market-wire",
      timing(START + 30 * 60_000, 60_000),
      emptyUnavailableDraft(START + 30 * 60_000),
    );
    expect(firstFailure.cardChanged).toBe(true);
    expect(firstFailure.card).toMatchObject({ revision: 2, state: "unavailable", observations: [] });

    const repeated = await store.publishFailure(
      "market-wire",
      timing(START + 31 * 60_000, 2 * 60_000),
      emptyUnavailableDraft(START + 31 * 60_000),
    );
    expect(repeated.cardChanged).toBe(false);
    expect(repeated.card).toEqual(firstFailure.card);
    expect(repeated.schedule).toMatchObject({ failures: 2, lastAttemptAt: START + 31 * 60_000 });
  });

  it("can publish an explicit unavailable card before any provider has succeeded", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    const result = await store.publishFailure(
      "market-wire",
      timing(),
      emptyUnavailableDraft(),
    );
    expect(result.cardChanged).toBe(true);
    expect(result.card).toMatchObject({ revision: 1, state: "unavailable" });
  });

  it("rejects stale attempts and rescheduling before the most recent attempt", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    await store.publishSuccess("market-wire", draft(), timing());
    await expect(store.publishUnchanged("market-wire", timing())).rejects.toThrow(/monotonically/i);
    await expect(store.reschedule("market-wire", START - 1)).rejects.toThrow(/before its last attempt/i);
    expect(store.schedule("market-wire")?.lastAttemptAt).toBe(START);
  });

  it("pulls due work forward without fabricating a provider attempt or postponing earlier work", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    await store.publishSuccess("market-wire", draft(), timing());

    const accelerated = await store.reschedule("market-wire", START + 5 * 60_000);
    expect(accelerated).toMatchObject({ lastAttemptAt: START, nextPollAt: START + 5 * 60_000 });
    expect(await store.reschedule("market-wire", START + 10 * 60_000)).toEqual(accelerated);
  });

  it("never exposes an unpersisted mutation when durable save fails", async () => {
    const persistence = new TogglePersistence();
    const store = new ChannelFeedStore({ persistence });
    await store.load();
    const initial = await store.publishSuccess("market-wire", draft(), timing());
    const initialSchedule = store.schedule("market-wire");
    persistence.fail = true;

    await expect(store.publishSuccess(
      "market-wire",
      draft({ updatedAt: new Date(START + 30 * 60_000).toISOString() }),
      timing(START + 30 * 60_000),
    )).rejects.toThrow("disk unavailable");
    expect(store.getCard("market-wire")).toEqual(initial);
    expect(store.schedule("market-wire")).toEqual(initialSchedule);
  });

  it("fails closed on corrupt state, unsafe URLs, non-finite values and inconsistent coverage", async () => {
    const corruptPersistence: ChannelFeedPersistence = {
      load: async () => ({ version: 1, cards: [{ nope: true }], schedules: [] }),
      save: async () => undefined,
    };
    const corrupt = new ChannelFeedStore({ persistence: corruptPersistence });
    await expect(corrupt.load()).rejects.toBeInstanceOf(ChannelFeedStateLoadError);
    expect(corrupt.cards()).toEqual([]);

    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    const unsafe = draft({
      observations: [observation("SE_OMXS30", {
        source: { ...observation().source, url: "https://user:secret@example.com/quote" },
      })],
    });
    await expect(store.publishSuccess("market-wire", unsafe, timing())).rejects.toThrow(/invalid/i);
    await expect(store.publishSuccess(
      "market-wire",
      draft({ observations: [observation("SE_OMXS30", { level: Number.NaN })] }),
      timing(),
    )).rejects.toThrow(/invalid/i);
    await expect(store.publishSuccess(
      "market-wire",
      draft({ coverage: { requested: 1, available: 0, ratio: 0, complete: false } }),
      timing(),
    )).rejects.toThrow(/invalid/i);
    await expect(store.publishSuccess(
      "market-wire",
      draft({
        observations: [observation("SE_OMXS30", {
          observedAt: new Date(START - 5 * 24 * 60 * 60_000).toISOString(),
          freshness: "recent",
        })],
      }),
      timing(),
    )).rejects.toThrow(/invalid/i);
    expect(store.cards()).toEqual([]);
  });

  it("enforces bounded card rows and bounded feed retention", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    const ids = Array.from({ length: 9 }, (_, index) => `INDEX_${index}`);
    await expect(store.publishSuccess("market-wire", draft({
      requestedIndexIds: ids,
      observations: ids.map((id) => observation(id)),
      coverage: { requested: 9, available: 9, ratio: 1, complete: true },
    }), timing())).rejects.toThrow(/invalid/i);

    for (let index = 0; index < 32; index += 1) {
      await store.reschedule(`feed-${String(index).padStart(2, "0")}`, START);
    }
    await expect(store.reschedule("feed-overflow", START)).rejects.toThrow(/retention/i);
  });

  it("atomically round-trips a permission-restricted JSON file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-channel-feeds-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "nested", "state.json");
    const first = new ChannelFeedStore({ filePath });
    await first.load();
    const card = await first.publishSuccess("market-wire", draft(), timing());

    const metadata = await stat(filePath);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 2,
      configurations: [],
    });
    expect((await stat(join(directory, "nested"))).isDirectory()).toBe(true);

    const restored = new ChannelFeedStore({ filePath });
    await restored.load();
    expect(restored.getCard("market-wire")).toEqual(card);

    await writeFile(filePath, "not-json", "utf8");
    await expect(new JsonFileChannelFeedPersistence(filePath).load()).rejects.toThrow();
  });

  it("returns defensive copies and removes a feed's card plus schedule together", async () => {
    const store = new ChannelFeedStore({ persistence: new MemoryChannelFeedPersistence() });
    await store.load();
    await store.publishSuccess("market-wire", draft(), timing());
    const leaked = store.cards()[0] as ChannelFeedCard;
    leaked.title = "mutated outside the store";
    expect(store.getCard("market-wire")?.title).toBe("Latest reported markets");
    expect(await store.remove("market-wire")).toBe(true);
    expect(store.getCard("market-wire")).toBeUndefined();
    expect(store.schedule("market-wire")).toBeUndefined();
    expect(await store.remove("market-wire")).toBe(false);
  });
});
