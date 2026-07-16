import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type NormalizedSocialMemoryConsolidationInput,
  type SocialMemoryConsolidation,
} from "./socialMemoryConsolidation.js";
import { SocialMemoryLifecycleManager } from "./socialMemoryLifecycle.js";
import { SocialMemoryStore, type RecordSocialEventInput } from "./socialMemory.js";

const stores: SocialMemoryStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createStore = (now = 1_800_000_100_000, filePath = ":memory:"): SocialMemoryStore => {
  const store = new SocialMemoryStore({ filePath, now: () => now });
  stores.push(store);
  return store;
};

const recordMemory = (
  store: SocialMemoryStore,
  id: string,
  perspective: string,
  occurredAt: number,
  salience: number,
  confidence: number,
  bucket: { ownerId?: string; channelId?: string } = {},
): void => {
  const ownerId = bucket.ownerId ?? "resident-mira";
  const input: RecordSocialEventInput = {
    id: `event-${id}`,
    kind: "shared_moment",
    origin: "human",
    scope: { kind: "public", channelId: bucket.channelId ?? "lobby" },
    sourceMessageIds: [`message-${id}`],
    actorIds: ["human-johan"],
    subjectIds: ["human-johan"],
    witnessIds: [ownerId],
    occurredAt,
    summary: `Source-bound event ${id}`,
    salience,
    confidence,
    memoryViews: [{
      id: `memory-${id}`,
      ownerId,
      subjectIds: ["human-johan"],
      perspective,
      salience,
      confidence,
    }],
  };
  store.recordEvent(input);
};

class FakeConsolidator {
  readonly calls: NormalizedSocialMemoryConsolidationInput[] = [];

  constructor(
    private readonly response: (
      input: NormalizedSocialMemoryConsolidationInput,
    ) => SocialMemoryConsolidation | Promise<SocialMemoryConsolidation>,
  ) {}

  async consolidateSocialMemories(
    input: NormalizedSocialMemoryConsolidationInput,
  ): Promise<SocialMemoryConsolidation> {
    this.calls.push(input);
    return await this.response(input);
  }
}

describe("social-memory lifecycle manager", () => {
  it("does not call the model when there is no exact bucket to consolidate", async () => {
    const store = createStore();
    recordMemory(store, "only", "Johan was kind after a difficult morning.", 1_800_000_000_000, 0.7, 0.9);
    const model = new FakeConsolidator(() => {
      throw new Error("one memory is not a consolidation batch");
    });
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    await expect(lifecycle.runNow()).resolves.toMatchObject({
      consideredMemories: 0,
      proposedActions: 0,
      appliedConsolidations: 0,
    });
    expect(model.calls).toHaveLength(0);
    await lifecycle.close();
  });

  it("applies a validated decision-only merge and retains all source-event provenance", async () => {
    const store = createStore();
    recordMemory(store, "one", "Johan checked in when I was having a rough day.", 1_800_000_000_000, 0.7, 0.94);
    recordMemory(store, "two", "Johan checked in when I was having a rough day.", 1_800_000_010_000, 0.82, 0.88);
    const model = new FakeConsolidator((input) => ({
      source: "lm",
      failureReason: null,
      actions: [{
        slot: "merge_1",
        kind: "duplicate",
        sourceMemoryIds: input.candidates.map((candidate) => candidate.id),
        canonicalMemoryId: "memory-two",
        perspective: "Johan checked in when I was having a rough day.",
        salience: 0.82,
        confidence: 0.88,
      }],
    }));
    const onStateChanged = vi.fn();
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
      onStateChanged,
    });

    await expect(lifecycle.runNow()).resolves.toMatchObject({
      consideredMemories: 2,
      proposedActions: 1,
      appliedConsolidations: 1,
    });
    const active = store.listMemories({ ownerId: "resident-mira", subjectId: "human-johan", limit: 50 });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      tier: "consolidated",
      perspective: "Johan checked in when I was having a rough day.",
      sourceEventIds: ["event-one", "event-two"],
    });
    expect(store.lifecycleStats()).toMatchObject({ activeConsolidated: 1, superseded: 2 });
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    await lifecycle.close();
  });

  it("still performs deterministic maintenance when semantic consolidation fails closed", async () => {
    const store = createStore();
    recordMemory(store, "one", "A first distinct memory.", 1_800_000_000_000, 0.6, 0.9);
    recordMemory(store, "two", "A completely different second memory.", 1_800_000_010_000, 0.6, 0.9);
    const model = new FakeConsolidator(() => ({
      source: "fallback",
      failureReason: "provider_error",
      actions: [],
    }));
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    await expect(lifecycle.runNow()).resolves.toMatchObject({
      consideredMemories: 2,
      appliedConsolidations: 0,
      failureReason: "provider_error",
    });
    expect(store.listMemories({ ownerId: "resident-mira", limit: 50 })).toHaveLength(2);
    await lifecycle.close();
  });

  it("contains a thrown provider failure and still returns maintenance results", async () => {
    const store = createStore();
    recordMemory(store, "one", "A first retained memory.", 1_800_000_000_000, 0.6, 0.9);
    recordMemory(store, "two", "A second retained memory.", 1_800_000_010_000, 0.6, 0.9);
    const model = new FakeConsolidator(() => {
      throw new Error("provider switched");
    });
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    await expect(lifecycle.runNow()).resolves.toMatchObject({
      consideredMemories: 2,
      proposedActions: 0,
      appliedConsolidations: 0,
      failureReason: "provider switched",
      maintenance: { now: 1_800_000_100_000 },
    });
    await lifecycle.close();
  });

  it("skips a cooling no-action bucket so another resident scope is not starved", async () => {
    const store = createStore();
    recordMemory(store, "mira-one", "Mira's first distinct recollection.", 1_800_000_000_000, 0.6, 0.9);
    recordMemory(store, "mira-two", "Mira's second distinct recollection.", 1_800_000_001_000, 0.6, 0.9);
    recordMemory(
      store,
      "sana-one",
      "Sana's first distinct recollection.",
      1_800_000_010_000,
      0.6,
      0.9,
      { ownerId: "resident-sana", channelId: "the-pub" },
    );
    recordMemory(
      store,
      "sana-two",
      "Sana's second distinct recollection.",
      1_800_000_011_000,
      0.6,
      0.9,
      { ownerId: "resident-sana", channelId: "the-pub" },
    );
    const model = new FakeConsolidator(() => ({
      source: "lm",
      failureReason: null,
      actions: [],
    }));
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    await lifecycle.runNow();
    await lifecycle.runNow();

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]!.candidates.every((candidate) => candidate.ownerId === "resident-mira")).toBe(true);
    expect(model.calls[1]!.candidates.every((candidate) => candidate.ownerId === "resident-sana")).toBe(true);
    await lifecycle.close();
  });

  it("visits more than fifty failing buckets fairly instead of recycling the head", async () => {
    const store = createStore();
    for (let index = 0; index < 60; index += 1) {
      const ownerId = `resident-fair-${String(index).padStart(2, "0")}`;
      const channelId = `room-fair-${String(index).padStart(2, "0")}`;
      recordMemory(store, `fair-${index}-one`, `Fair recollection ${index} one.`, 1_800_000_000_000 + index, 0.6, 0.9, {
        ownerId,
        channelId,
      });
      recordMemory(store, `fair-${index}-two`, `Fair recollection ${index} two.`, 1_800_000_010_000 + index, 0.6, 0.9, {
        ownerId,
        channelId,
      });
    }
    const model = new FakeConsolidator(() => ({
      source: "fallback",
      failureReason: "provider_error",
      actions: [],
    }));
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    for (let index = 0; index < 60; index += 1) await lifecycle.runNow();

    expect(new Set(model.calls.map((call) => call.candidates[0]!.ownerId)).size).toBe(60);
    await lifecycle.close();
  });

  it("persists the fair bucket cursor across a store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-lifecycle-cursor-"));
    directories.push(directory);
    const filePath = join(directory, "social-memory.sqlite");
    const firstStore = createStore(1_800_000_100_000, filePath);
    recordMemory(firstStore, "restart-mira-one", "Mira restart one.", 1_800_000_000_000, 0.6, 0.9);
    recordMemory(firstStore, "restart-mira-two", "Mira restart two.", 1_800_000_001_000, 0.6, 0.9);
    recordMemory(firstStore, "restart-sana-one", "Sana restart one.", 1_800_000_010_000, 0.6, 0.9, {
      ownerId: "resident-sana",
      channelId: "the-pub",
    });
    recordMemory(firstStore, "restart-sana-two", "Sana restart two.", 1_800_000_011_000, 0.6, 0.9, {
      ownerId: "resident-sana",
      channelId: "the-pub",
    });
    const firstModel = new FakeConsolidator(() => ({ source: "fallback", failureReason: "provider_error", actions: [] }));
    const firstLifecycle = new SocialMemoryLifecycleManager(firstModel, firstStore, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });
    await firstLifecycle.runNow();
    await firstLifecycle.close();
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const restartedStore = createStore(1_800_000_100_000, filePath);
    const restartedModel = new FakeConsolidator(() => ({ source: "fallback", failureReason: "provider_error", actions: [] }));
    const restartedLifecycle = new SocialMemoryLifecycleManager(restartedModel, restartedStore, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });
    await restartedLifecycle.runNow();

    expect(firstModel.calls[0]!.candidates[0]!.ownerId).toBe("resident-mira");
    expect(restartedModel.calls[0]!.candidates[0]!.ownerId).toBe("resident-sana");
    await restartedLifecycle.close();
  });

  it("rotates a large bucket window so candidates beyond the first twelve are examined", async () => {
    const store = createStore();
    for (let index = 0; index < 14; index += 1) {
      recordMemory(
        store,
        `window-${index}`,
        `Window recollection ${index}.`,
        1_800_000_000_000 + index,
        0.6,
        0.9,
      );
    }
    const model = new FakeConsolidator(() => ({ source: "lm", failureReason: null, actions: [] }));
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    await lifecycle.runNow();
    await lifecycle.runNow();

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]!.candidates.map((candidate) => candidate.id))
      .not.toEqual(model.calls[1]!.candidates.map((candidate) => candidate.id));
    expect(model.calls[1]!.candidates.some((candidate) => candidate.id === "memory-window-13")).toBe(true);
    await lifecycle.close();
  });

  it("serializes explicit runs and waits for them during close", async () => {
    const store = createStore();
    recordMemory(store, "one", "Repeated source wording.", 1_800_000_000_000, 0.7, 0.9);
    recordMemory(store, "two", "Repeated source wording.", 1_800_000_010_000, 0.7, 0.9);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new FakeConsolidator(async () => {
      await gate;
      return { source: "lm", failureReason: null, actions: [] };
    });
    const lifecycle = new SocialMemoryLifecycleManager(model, store, {
      now: () => 1_800_000_100_000,
      minimumConsolidationCandidates: 2,
    });

    const first = lifecycle.runNow();
    const second = lifecycle.runNow();
    while (model.calls.length === 0) await Promise.resolve();
    const closing = lifecycle.close();
    expect(model.calls).toHaveLength(1);
    release();
    await Promise.all([first, second, closing]);
    expect(model.calls).toHaveLength(1);
    await expect(lifecycle.runNow()).rejects.toThrow(/closed/iu);
  });
});
