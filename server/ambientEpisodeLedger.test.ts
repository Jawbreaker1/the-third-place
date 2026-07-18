import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AmbientEpisodeLedger,
  JsonFileAmbientEpisodePersistence,
  MemoryAmbientEpisodePersistence,
  type AmbientEpisodePersistedState,
  type OpenAmbientEpisodeInput,
} from "./ambientEpisodeLedger.js";

const NOW = Date.parse("2026-07-16T10:00:00.000Z");

const episodeInput = (
  id: string,
  overrides: Partial<OpenAmbientEpisodeInput> = {},
): OpenAmbientEpisodeInput => ({
  id,
  channelId: "lobby",
  semanticFamily: "community-design",
  semanticKey: `community-design:${id}`,
  sourceKind: "idle_seed",
  causalRootId: `root-${id}`,
  messageIds: [`message-${id}`],
  ...overrides,
});

describe("AmbientEpisodeLedger", () => {
  it("stores compact language-agnostic episode metadata and applies idempotent updates", () => {
    let now = NOW;
    const ledger = new AmbientEpisodeLedger({
      persistence: new MemoryAmbientEpisodePersistence(),
      now: () => now,
      persistDelayMs: 60_000,
    });

    const opened = ledger.openEpisode(episodeInput("episode-1", {
      semanticFamily: "  تصميم المجتمع  ",
      semanticKey: "community:shared-memory",
      sourceKind: "human_prompt",
      causalRootId: "message-root",
      facets: ["memory", "MEMORY", "social continuity"],
      entities: ["Mira", "MIRA", "Bosse.exe"],
      sourceUrls: [
        "https://example.com/story?z=2&a=1#discussion",
        "https://EXAMPLE.com/story?a=1&z=2",
        "http://example.com/not-https",
        "https://localhost/private",
      ],
      participantIds: ["ai-mira", "ai-mira"],
      witnessIds: ["ai-bosse"],
      stances: [{
        actorId: "ai-mira",
        semanticKey: "supports:continuity",
        sourceMessageIds: ["message-root"],
      }],
      hooks: [{
        id: "hook-open-question",
        semanticKey: "question:tradeoff",
        sourceMessageIds: ["message-root"],
      }],
      operationId: "open-operation",
    }));

    expect(opened).toMatchObject({
      id: "episode-1",
      semanticFamily: "تصميم المجتمع",
      semanticKey: "community:shared-memory",
      sourceKind: "human_prompt",
      causalRootId: "message-root",
      facets: ["memory", "social continuity"],
      entities: ["Mira", "Bosse.exe"],
      sourceUrls: ["https://example.com/story?a=1&z=2"],
      participantIds: ["ai-mira"],
      witnessIds: ["ai-bosse"],
      messageIds: ["message-episode-1", "message-root"],
      status: "current",
      openedAt: NOW,
      lastActivityAt: NOW,
    });
    expect(opened.stances).toEqual([expect.objectContaining({
      actorId: "ai-mira",
      semanticKey: "supports:continuity",
      sourceMessageIds: ["message-root"],
    })]);
    expect(opened.hooks).toEqual([expect.objectContaining({
      id: "hook-open-question",
      status: "open",
      sourceMessageIds: ["message-root"],
    })]);

    now += 2_000;
    const updated = ledger.updateEpisode("episode-1", {
      facets: ["counterargument"],
      participantIds: ["ai-bosse"],
      messageIds: ["message-reply"],
      stances: [{
        actorId: "ai-mira",
        semanticKey: "qualified-support",
        sourceMessageIds: ["message-reply"],
      }],
      operationId: "published-message-reply",
    });
    now += 30_000;
    const retried = ledger.updateEpisode("episode-1", {
      facets: ["counterargument"],
      participantIds: ["ai-bosse"],
      messageIds: ["message-reply"],
      stances: [{
        actorId: "ai-mira",
        semanticKey: "qualified-support",
        sourceMessageIds: ["message-reply"],
      }],
      operationId: "published-message-reply",
    });

    expect(updated?.lastActivityAt).toBe(NOW + 2_000);
    expect(retried).toEqual(updated);
    expect(retried?.facets).toEqual(["memory", "social continuity", "counterargument"]);
    expect(retried?.participantIds).toEqual(["ai-mira", "ai-bosse"]);
    expect(retried?.stances).toEqual([expect.objectContaining({
      actorId: "ai-mira",
      semanticKey: "qualified-support",
      sourceMessageIds: ["message-reply"],
      updatedAt: NOW + 2_000,
    })]);
    expect(ledger.semanticLastUsedAt("lobby", { semanticKey: "community:shared-memory" }))
      .toBeUndefined();

    // Returned objects are snapshots and cannot mutate authoritative state.
    retried!.facets.push("outside-mutation");
    expect(ledger.current("lobby")?.facets).not.toContain("outside-mutation");
    expect(() => ledger.openEpisode(episodeInput("episode-1", { sourceKind: "different" })))
      .toThrow(/different immutable metadata/u);
  });

  it("keeps exactly one current episode and bounds per-channel and global history", () => {
    let now = NOW;
    const ledger = new AmbientEpisodeLedger({
      persistence: new MemoryAmbientEpisodePersistence(),
      now: () => now,
      maxRecentEpisodesPerChannel: 2,
      maxChannels: 2,
      persistDelayMs: 60_000,
    });

    ledger.openEpisode(episodeInput("episode-1"));
    now += 1;
    ledger.openEpisode(episodeInput("episode-2"));
    now += 1;
    ledger.openEpisode(episodeInput("episode-3"));
    now += 1;
    ledger.openEpisode(episodeInput("episode-4"));

    expect(ledger.current("lobby")?.id).toBe("episode-4");
    expect(ledger.recent("lobby").map((episode) => [episode.id, episode.closeReason])).toEqual([
      ["episode-3", "superseded"],
      ["episode-2", "superseded"],
    ]);
    expect(ledger.episode("episode-1")).toBeUndefined();

    now += 1;
    ledger.openEpisode(episodeInput("room-two", { channelId: "the-pub" }));
    now += 1;
    ledger.openEpisode(episodeInput("room-three", { channelId: "stock-market" }));
    expect(ledger.current("stock-market")?.id).toBe("room-three");
    expect(ledger.current("the-pub")?.id).toBe("room-two");
    expect(ledger.current("lobby")).toBeUndefined();
  });

  it("persists bounded publication recency beyond the full episode window across restart", async () => {
    let now = NOW;
    const persistence = new MemoryAmbientEpisodePersistence();
    const options = {
      persistence,
      now: () => now,
      maxRecentEpisodesPerChannel: 48,
      maxSemanticRecencyEntriesPerChannel: 96,
      persistDelayMs: 60_000,
    };
    const ledger = new AmbientEpisodeLedger(options);
    ledger.openEpisode(episodeInput("old-published-seed", {
      semanticFamily: "old-family",
      semanticKey: "seed:old-published",
      sourceKind: "room_seed",
    }));

    for (let index = 1; index <= 60; index += 1) {
      now += 1;
      ledger.openEpisode(episodeInput(`later-${index}`, {
        semanticFamily: `family-${index}`,
        semanticKey: `seed:later-${index}`,
        sourceKind: index % 2 === 0 ? "room_seed" : "autonomous_research",
      }));
    }

    expect(ledger.recent("lobby", 96)).toHaveLength(48);
    expect(ledger.episode("old-published-seed")).toBeUndefined();
    expect(ledger.semanticLastUsedAt("lobby", { semanticKey: "SEED:OLD-PUBLISHED" })).toBe(NOW);
    expect(ledger.semanticLastUsedAt("lobby", { semanticFamily: "old-family" })).toBe(NOW);

    const lastPublicationAt = now;

    // Looking up a selected/rejected seed cannot create a publication record.
    expect(ledger.isCoolingDown("lobby", { semanticKey: "seed:failed-generation" })).toBe(false);
    expect(ledger.semanticLastUsedAt("lobby", { semanticKey: "seed:failed-generation" }))
      .toBeUndefined();

    // Published human-led topics remain full episodes but cannot churn the
    // authored-seed LRU that room_seed/autonomous_research selection consumes.
    for (let index = 1; index <= 120; index += 1) {
      now += 1;
      ledger.openEpisode(episodeInput(`human-topic-${index}`, {
        semanticFamily: `human-family-${index}`,
        semanticKey: `human-topic:${index}`,
        sourceKind: "human_topic",
      }));
    }
    expect(ledger.semanticLastUsedAt("lobby", { semanticKey: "human-topic:120" }))
      .toBeUndefined();

    await ledger.flush();
    const persisted = await persistence.load() as AmbientEpisodePersistedState;
    expect(persisted.channels[0]?.semanticRecency).toHaveLength(61);
    expect(persisted.channels[0]?.semanticRecency).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticKey: "seed:failed-generation" }),
    ]));

    const restarted = new AmbientEpisodeLedger(options);
    await restarted.load();
    expect(restarted.semanticLastUsedAt("lobby", { semanticKey: "seed:old-published" })).toBe(NOW);
    expect(restarted.semanticLastUsedAt("lobby", { semanticKey: "seed:later-60" }))
      .toBe(lastPublicationAt);
    expect(restarted.semanticLastUsedAt("lobby", { semanticKey: "seed:failed-generation" }))
      .toBeUndefined();

    // The compact index itself remains bounded even as full publications keep arriving.
    for (let index = 61; index <= 120; index += 1) {
      now += 1;
      restarted.openEpisode(episodeInput(`later-${index}`, {
        semanticFamily: `family-${index}`,
        semanticKey: `seed:later-${index}`,
        sourceKind: "room_seed",
      }));
    }
    await restarted.flush();
    const bounded = await persistence.load() as AmbientEpisodePersistedState;
    expect(bounded.channels[0]?.semanticRecency).toHaveLength(96);
  });

  it("anchors stale closure, cooldown and relevance decay to the injected clock", () => {
    let now = NOW;
    const ledger = new AmbientEpisodeLedger({
      persistence: new MemoryAmbientEpisodePersistence(),
      now: () => now,
      activeTtlMs: 1_000,
      semanticCooldownMs: 2_000,
      relevanceHalfLifeMs: 2_000,
      retentionMs: 10_000,
      persistDelayMs: 60_000,
    });
    ledger.openEpisode(episodeInput("episode-stale", {
      semanticFamily: "same family",
      semanticKey: "same:key",
    }));

    now = NOW + 1_001;
    expect(ledger.updateEpisode("episode-stale", {
      facets: ["must-not-revive"],
      operationId: "late-update",
    })).toBeUndefined();
    expect(ledger.current("lobby")).toBeUndefined();
    const stale = ledger.recent("lobby")[0]!;
    expect(stale).toMatchObject({
      id: "episode-stale",
      closeReason: "stale",
      closedAt: NOW + 1_000,
      cooldownUntil: NOW + 3_000,
    });
    expect(ledger.isCoolingDown("lobby", { semanticKey: "SAME:KEY" })).toBe(true);
    expect(ledger.semanticLastUsedAt("lobby", { semanticKey: "SAME:KEY" })).toBe(NOW);
    expect(ledger.semanticLastUsedAt("lobby", { semanticFamily: "same family" })).toBe(NOW);
    expect(ledger.semanticLastUsedAt("lobby", { semanticFamily: "different" })).toBeUndefined();

    now = NOW + 3_001;
    expect(ledger.isCoolingDown("lobby", { semanticFamily: "same family" })).toBe(false);
    expect(ledger.semanticLastUsedAt("lobby", { semanticFamily: "same family" })).toBe(NOW);
    expect(ledger.relevance("episode-stale")).toBeCloseTo(0.5, 3);
    expect(ledger.recallCandidates("lobby")[0]).toMatchObject({
      episode: { id: "episode-stale" },
      ageMs: 2_001,
    });

    now = NOW + 11_001;
    expect(ledger.prune()).toEqual({ episodesClosed: 0, episodesRemoved: 1, channelsRemoved: 1 });
    expect(ledger.recent("lobby")).toEqual([]);
  });

  it("persists source-bound unresolved hooks and consumes callbacks once across restart", async () => {
    let now = NOW;
    const persistence = new MemoryAmbientEpisodePersistence();
    const options = { persistence, now: () => now, persistDelayMs: 60_000 };
    const ledger = new AmbientEpisodeLedger(options);
    ledger.openEpisode(episodeInput("source", {
      hooks: [{
        id: "question-from-source",
        semanticKey: "question:unresolved",
        sourceMessageIds: ["source-message-1", "source-message-2"],
      }],
    }));
    now += 1_000;
    ledger.closeEpisode("source", "topic_shift", { operationId: "close-source" });
    now += 1_000;
    ledger.openEpisode(episodeInput("target", { causalRootId: "source" }));

    expect(ledger.eligibleCallbacks("lobby")).toEqual([expect.objectContaining({
      sourceEpisodeId: "source",
      causalRootId: "root-source",
      hook: expect.objectContaining({
        id: "question-from-source",
        status: "open",
        sourceMessageIds: ["source-message-1", "source-message-2"],
      }),
    })]);

    now += 1_000;
    const used = ledger.markCallbackUsed(
      "target",
      "source",
      "question-from-source",
      { operationId: "callback-publication" },
    );
    expect(used?.usedCallbacks).toEqual([{
      callbackId: "question-from-source",
      sourceEpisodeId: "source",
      sourceMessageIds: ["source-message-1", "source-message-2"],
      usedAt: now,
    }]);
    expect(ledger.eligibleCallbacks("lobby")).toEqual([]);
    expect(ledger.markCallbackUsed(
      "target",
      "source",
      "question-from-source",
      { operationId: "callback-publication" },
    )?.usedCallbacks).toHaveLength(1);

    await ledger.flush();
    const restarted = new AmbientEpisodeLedger(options);
    await restarted.load();
    expect(restarted.current("lobby")?.usedCallbacks).toEqual(used?.usedCallbacks);
    expect(restarted.eligibleCallbacks("lobby")).toEqual([]);

    // A hook that was explicitly resolved is never exposed as a callback.
    now += 1_000;
    restarted.updateEpisode("target", {
      hooks: [{ id: "resolved-hook", sourceMessageIds: ["target-message"] }],
      resolveHookIds: ["resolved-hook"],
      operationId: "resolve-hook",
    });
    restarted.closeEpisode("target", "resolved");
    now += 1_000;
    restarted.openEpisode(episodeInput("third"));
    expect(restarted.eligibleCallbacks("lobby").map((candidate) => candidate.hook.id))
      .not.toContain("resolved-hook");
  });

  it("persists atomically without creating a second copy of room messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ambient-episode-ledger-"));
    const path = join(directory, "ambient-episodes.json");
    try {
      const persistence = new JsonFileAmbientEpisodePersistence(path);
      const ledger = new AmbientEpisodeLedger({
        persistence,
        now: () => NOW,
        persistDelayMs: 60_000,
      });

      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      ledger.openEpisode(episodeInput("json-episode", {
        messageIds: ["authoritative-room-message"],
        hooks: [{ id: "json-hook", sourceMessageIds: ["authoritative-room-message"] }],
      }));
      await ledger.flush();

      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as AmbientEpisodePersistedState;
      expect(parsed).toMatchObject({ version: 1 });
      expect(raw).toContain("authoritative-room-message");
      expect(raw).not.toContain('"content"');
      expect(raw).not.toContain('"reactions"');
      expect(raw).not.toContain('"authorSnapshot"');

      // A legacy version-1 file has no compact semantic index. Loading it
      // reconstructs the best available publication recency from retained
      // episodes and writes the migrated shape without a version bump.
      delete parsed.channels[0]?.semanticRecency;
      await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

      const restarted = new AmbientEpisodeLedger({ persistence, now: () => NOW, persistDelayMs: 60_000 });
      await restarted.load();
      expect(restarted.current("lobby")?.id).toBe("json-episode");
      expect(restarted.semanticLastUsedAt("lobby", { semanticKey: "community-design:json-episode" }))
        .toBe(NOW);
      await restarted.flush();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        version: 1,
        channels: [{
          semanticRecency: [{
            semanticFamily: "community-design",
            semanticKey: "community-design:json-episode",
            lastPublishedAt: NOW,
          }],
        }],
      });

      const lagged = JSON.parse(await readFile(path, "utf8")) as AmbientEpisodePersistedState;
      lagged.channels[0]!.semanticRecency = [];
      await writeFile(path, `${JSON.stringify(lagged, null, 2)}\n`, "utf8");
      const repaired = new AmbientEpisodeLedger({ persistence, now: () => NOW, persistDelayMs: 60_000 });
      await repaired.load();
      expect(repaired.semanticLastUsedAt("lobby", { semanticKey: "community-design:json-episode" }))
        .toBe(NOW);
      await repaired.flush();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        channels: [{ semanticRecency: [expect.objectContaining({
          semanticKey: "community-design:json-episode",
        })] }],
      });

      await writeFile(path, "{not-json", "utf8");
      const recovered = new AmbientEpisodeLedger({ persistence, now: () => NOW, persistDelayMs: 60_000 });
      await recovered.load();
      expect(recovered.current("lobby")).toBeUndefined();
      recovered.openEpisode(episodeInput("after-corruption"));
      await recovered.flush();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
