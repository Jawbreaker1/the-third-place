import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SOCIAL_MEMORY_LIFECYCLE_DEFAULTS,
  SocialMemoryStore,
  type RecordSocialEventInput,
  type SocialMemoryScope,
} from "./socialMemory.js";
import { projectRelationshipBehavior } from "./relationshipBehavior.js";

const stores: SocialMemoryStore[] = [];
const directories: string[] = [];
const DAY_MS = 24 * 60 * 60_000;

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createStore = async (now = 1_800_000_000_000): Promise<{
  store: SocialMemoryStore;
  filePath: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-"));
  directories.push(directory);
  const filePath = join(directory, "social-memory.sqlite");
  const store = new SocialMemoryStore({ filePath, now: () => now });
  stores.push(store);
  return { store, filePath };
};

const baseEvent = (
  id: string,
  overrides: Partial<RecordSocialEventInput> = {},
): RecordSocialEventInput => ({
  id,
  kind: "support",
  origin: "human",
  scope: { kind: "public", channelId: "lobby" },
  sourceMessageIds: [`message-${id}`],
  actorIds: ["human-johan"],
  subjectIds: ["resident-mira"],
  witnessIds: ["resident-mira", "resident-sana"],
  occurredAt: 1_800_000_000_000,
  summary: "Johan helped Mira solve a small problem.",
  salience: 0.72,
  confidence: 0.96,
  memoryViews: [
    {
      id: `memory-${id}`,
      ownerId: "resident-mira",
      subjectIds: ["human-johan"],
      perspective: "Johan was patient and helpful when I got stuck.",
      salience: 0.75,
      confidence: 0.95,
    },
  ],
  relationshipDeltas: [
    {
      ownerId: "resident-mira",
      subjectId: "human-johan",
      familiarity: 0.08,
      warmth: 0.12,
      trust: 0.06,
      respect: 0.04,
      friction: -0.02,
    },
  ],
  openLoops: [
    {
      id: `loop-${id}`,
      ownerId: "resident-mira",
      subjectIds: ["human-johan"],
      kind: "follow_up",
      summary: "Ask Johan whether the proposed fix worked.",
    },
  ],
  ...overrides,
});

describe("persistent social memory store", () => {
  it("migrates a populated v2 database without losing its episodic memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-v2-"));
    directories.push(directory);
    const filePath = join(directory, "memory.sqlite");
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE social_events (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL,
        scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
        scope_participants_json TEXT NOT NULL, occurred_at INTEGER NOT NULL,
        summary TEXT NOT NULL, salience REAL NOT NULL, confidence REAL NOT NULL,
        payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE event_sources (event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE, message_id TEXT NOT NULL, PRIMARY KEY(event_id, message_id)) STRICT;
      CREATE TABLE event_actors (event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE, actor_id TEXT NOT NULL, PRIMARY KEY(event_id, actor_id)) STRICT;
      CREATE TABLE event_subjects (event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE, subject_id TEXT NOT NULL, PRIMARY KEY(event_id, subject_id)) STRICT;
      CREATE TABLE event_witnesses (event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE, witness_id TEXT NOT NULL, PRIMARY KEY(event_id, witness_id)) STRICT;
      CREATE TABLE memory_views (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, perspective TEXT NOT NULL, salience REAL NOT NULL,
        confidence REAL NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(event_id, owner_id)
      ) STRICT;
      CREATE TABLE memory_subjects (memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE, subject_id TEXT NOT NULL, PRIMARY KEY(memory_id, subject_id)) STRICT;
      CREATE TABLE relationship_changes (
        event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, subject_id TEXT NOT NULL, origin TEXT NOT NULL,
        day_key TEXT NOT NULL, familiarity REAL NOT NULL, warmth REAL NOT NULL,
        trust REAL NOT NULL, respect REAL NOT NULL, friction REAL NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(event_id, owner_id, subject_id)
      ) STRICT;
      CREATE TABLE open_loops (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, kind TEXT NOT NULL, initial_summary TEXT, summary TEXT NOT NULL,
        state TEXT NOT NULL, due_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE open_loop_subjects (loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE, subject_id TEXT NOT NULL, PRIMARY KEY(loop_id, subject_id)) STRICT;
      PRAGMA user_version = 2;
      INSERT INTO social_events VALUES ('legacy-event','support','human','public','lobby','[]',1800000000000,'Legacy source',0.7,0.9,'hash',1800000000000);
      INSERT INTO event_sources VALUES ('legacy-event','legacy-message');
      INSERT INTO event_actors VALUES ('legacy-event','human-johan');
      INSERT INTO event_subjects VALUES ('legacy-event','resident-mira');
      INSERT INTO event_witnesses VALUES ('legacy-event','resident-mira');
      INSERT INTO memory_views VALUES ('legacy-memory','legacy-event','resident-mira','Johan helped before the migration.',0.7,0.9,0,1800000000000,1800000000000);
      INSERT INTO memory_subjects VALUES ('legacy-memory','human-johan');
    `);
    legacy.close();

    const store = new SocialMemoryStore({ filePath, now: () => 1_800_000_100_000 });
    stores.push(store);
    expect(store.status().schemaVersion).toBe(7);
    expect(store.listMemories({ ownerId: "resident-mira" })[0]).toMatchObject({
      id: "legacy-memory",
      tier: "episodic",
      sourceEventIds: ["legacy-event"],
      recallCount: 0,
      reinforcedAt: 1_800_000_000_000,
    });
  });

  it("migrates a new database, enables WAL/foreign keys, and survives restart", async () => {
    const { store, filePath } = await createStore();
    expect(store.status()).toEqual({ schemaVersion: 7, journalMode: "wal", foreignKeys: true });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const result = store.recordEvent(baseEvent("restart"));
    expect(result.created).toBe(true);
    expect(result.event).toMatchObject({
      id: "restart",
      sourceMessageIds: ["message-restart"],
      actorIds: ["human-johan"],
      witnessIds: ["resident-mira", "resident-sana"],
    });
    expect(store.listMemories({ ownerId: "resident-mira" })[0]).toMatchObject({
      id: "memory-restart",
      eventId: "restart",
      event: { scope: { kind: "public", channelId: "lobby" } },
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const restarted = new SocialMemoryStore({ filePath, now: () => 1_800_000_001_000 });
    stores.push(restarted);
    expect(restarted.getEvent("restart")?.summary).toContain("helped Mira");
    expect(restarted.getRelationship("resident-mira", "human-johan")).toMatchObject({
      familiarity: 0.08,
      warmth: 0.12,
      trust: 0.06,
    });
    expect(restarted.listOpenLoops({ ownerId: "resident-mira", state: "open" })[0]).toMatchObject({
      id: "loop-restart",
      subjectIds: ["human-johan"],
    });
  });

  it("reconciles legacy protected-state overflow during migration", async () => {
    const { store, filePath } = await createStore();
    for (let index = 0; index < 65; index += 1) {
      store.recordEvent(baseEvent(`legacy-pin-${index}`, {
        relationshipDeltas: [],
        ...(index < 17 ? {} : { openLoops: [] }),
      }));
    }
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      UPDATE memory_views SET pinned = 1;
      UPDATE open_loops SET pinned = 1;
      DROP TABLE social_memory_lifecycle_state;
      DROP TABLE relationship_daily_budgets;
      DROP TABLE relationship_romantic_boundaries;
      ALTER TABLE relationship_edges DROP COLUMN romantic_interest;
      ALTER TABLE relationship_changes DROP COLUMN romantic_interest;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new SocialMemoryStore({ filePath, now: () => 1_800_000_100_000 });
    stores.push(migrated);
    expect(migrated.status().schemaVersion).toBe(7);
    expect(migrated.lifecycleStats().pinned)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedPerOwner);
    expect(migrated.listOpenLoops({ ownerId: "resident-mira", limit: 50 }).filter((loop) => loop.pinned))
      .toHaveLength(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedOpenLoopsPerOwner);
  });

  it("quarantines pre-v4 checkpoint days whose exact absolute spend cannot be reconstructed", async () => {
    const baseNow = 1_800_000_000_000;
    const { store, filePath } = await createStore(baseNow);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new DatabaseSync(filePath);
    legacy.prepare(
      `INSERT INTO relationship_checkpoints
       (id, owner_id, subject_id, origin, day_key, participant_ids_json,
        familiarity, warmth, trust, respect, friction, romantic_interest,
        spent_familiarity, spent_warmth, spent_trust, spent_respect, spent_friction,
        spent_romantic_interest,
        through_at, updated_at)
       VALUES (?, ?, ?, 'human', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
    ).run(
      "legacy-checkpoint-net-zero",
      "resident-mira",
      "human-johan",
      "2027-01-01",
      JSON.stringify(["human-johan", "resident-mira"]),
      baseNow + 10 * DAY_MS,
      baseNow + 10 * DAY_MS,
    );
    legacy.exec(`
      DROP TABLE social_memory_lifecycle_state;
      DROP TABLE relationship_daily_budgets;
      DROP TABLE relationship_romantic_boundaries;
      ALTER TABLE relationship_edges DROP COLUMN romantic_interest;
      ALTER TABLE relationship_changes DROP COLUMN romantic_interest;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new SocialMemoryStore({ filePath, now: () => baseNow + 20 * DAY_MS });
    stores.push(migrated);
    const late = migrated.recordEvent(baseEvent("legacy-spend-quarantine", {
      occurredAt: baseNow + 5 * DAY_MS,
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 1 }],
      openLoops: [],
    }));
    expect(late.appliedRelationshipDeltas[0]?.warmth).toBe(0);
  });

  it("backfills exact daily relationship spend when migrating a v4 database", async () => {
    const baseNow = 1_800_000_000_000;
    const { store, filePath } = await createStore(baseNow);
    store.recordEvent(baseEvent("v4-budget-source", {
      memoryViews: [],
      openLoops: [],
    }));
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DROP TABLE relationship_daily_budgets;
      DROP TABLE relationship_romantic_boundaries;
      ALTER TABLE relationship_edges DROP COLUMN romantic_interest;
      ALTER TABLE relationship_changes DROP COLUMN romantic_interest;
      ALTER TABLE relationship_checkpoints DROP COLUMN romantic_interest;
      ALTER TABLE relationship_checkpoints DROP COLUMN spent_romantic_interest;
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const migrated = new SocialMemoryStore({ filePath, now: () => baseNow + 1_000 });
    stores.push(migrated);
    expect(migrated.status().schemaVersion).toBe(7);
    expect(migrated.lifecycleStats().relationshipDailyBudgets).toBe(1);
    const next = migrated.recordEvent(baseEvent("v5-budget-continuation", {
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        warmth: 1,
      }],
      openLoops: [],
    }));
    expect(next.appliedRelationshipDeltas[0]?.warmth).toBeCloseTo(0.06);
  });

  it("forgets every derived artifact involving a human while leaving unrelated social memory intact", async () => {
    const { store } = await createStore();
    store.recordEvent(baseEvent("forget-human"));
    store.recordEvent(baseEvent("keep-other", {
      sourceMessageIds: ["message-keep-other"],
      actorIds: ["human-alex"],
      subjectIds: ["resident-sana"],
      witnessIds: ["resident-sana"],
      summary: "Alex helped Sana test another idea.",
      memoryViews: [{
        id: "memory-keep-other",
        ownerId: "resident-sana",
        subjectIds: ["human-alex"],
        perspective: "Alex was helpful during the test.",
        salience: 0.7,
        confidence: 0.9,
      }],
      relationshipDeltas: [{ ownerId: "resident-sana", subjectId: "human-alex", warmth: 0.05 }],
      openLoops: [],
    }));
    expect(store.setMemoryPinned("memory-forget-human", true, "local-admin")).toBe(true);
    expect(store.setOpenLoopPinned("loop-forget-human", true, "local-admin")).toBe(true);
    expect(store.setMemoryPinned("memory-keep-other", true, "local-admin")).toBe(true);
    expect(store.listAudit()).toHaveLength(3);

    expect(store.forgetActor("human-johan")).toEqual({
      events: 1,
      memories: 1,
      relationships: 1,
      openLoops: 1,
    });
    expect(store.getEvent("forget-human")).toBeUndefined();
    expect(store.listMemories({ ownerId: "resident-mira", subjectId: "human-johan" })).toEqual([]);
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();
    expect(store.listOpenLoops({ ownerId: "resident-mira", subjectId: "human-johan" })).toEqual([]);
    expect(store.getEvent("keep-other")).toBeDefined();
    expect(store.listAudit()).toEqual([
      expect.objectContaining({ targetId: "memory-keep-other" }),
    ]);
  });

  it("forgets private episodes where the actor participated silently, including receipt provenance", async () => {
    const { store } = await createStore();
    const privateEvent = (id: string, roomId: string) => baseEvent(id, {
      scope: {
        kind: "voice",
        roomId,
        participantIds: ["human-johan", "human-silent", "resident-mira"],
      },
      witnessIds: ["resident-mira"],
    });
    store.recordEpisode({
      episodeId: "episode-with-silent-participant",
      fingerprint: "a".repeat(64),
      participantIds: ["human-johan", "human-silent", "resident-mira"],
      events: [privateEvent("receipt-private", "voice-receipt")],
    });
    store.recordEvent(privateEvent("direct-private", "voice-direct"));

    expect(store.forgetActor("human-silent")).toMatchObject({ events: 2 });
    expect(store.getEvent("receipt-private")).toBeUndefined();
    expect(store.getEvent("direct-private")).toBeUndefined();
    expect(store.getEpisodeReceipt("episode-with-silent-participant")).toMatchObject({
      status: "erased",
      participantIds: [],
      eventIds: [],
    });
  });

  it("recomputes surviving relationship and open-loop projections after source erasure", async () => {
    const { store, filePath } = await createStore();
    store.recordEvent(baseEvent("forgotten-witness-delta", {
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: ["human-johan"],
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "resident-sana", warmth: 0.1 }],
      openLoops: [],
    }));
    store.recordEvent(baseEvent("surviving-delta", {
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: [],
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "resident-sana", warmth: 0.05 }],
      openLoops: [],
    }));
    store.recordEvent(baseEvent("surviving-loop-created", {
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: [],
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [{
        id: "loop-surviving-provenance",
        ownerId: "resident-mira",
        subjectIds: ["resident-sana"],
        kind: "follow_up",
        summary: "Original source-grounded wording.",
      }],
    }));
    store.recordEvent(baseEvent("forgotten-loop-update", {
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: ["human-johan"],
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [{
        id: "loop-surviving-provenance",
        state: "open",
        summary: "Deleted event wording must disappear.",
      }],
    }));
    store.recordEvent(baseEvent("surviving-inherited-update", {
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: [],
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [{ id: "loop-surviving-provenance", state: "resolved" }],
    }));
    expect(store.getRelationship("resident-mira", "resident-sana")?.warmth).toBeCloseTo(0.15);
    expect(store.getOpenLoop("loop-surviving-provenance")?.summary).toBe(
      "Deleted event wording must disappear.",
    );

    store.forgetActor("human-johan");
    expect(store.getEvent("forgotten-witness-delta")).toBeUndefined();
    expect(store.getRelationship("resident-mira", "resident-sana")?.warmth).toBeCloseTo(0.05);
    expect(store.getOpenLoop("loop-surviving-provenance")).toMatchObject({
      state: "resolved",
      summary: "Original source-grounded wording.",
    });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new SocialMemoryStore({ filePath, now: () => 1_800_000_100_000 });
    stores.push(restarted);
    expect(restarted.getRelationship("resident-mira", "resident-sana")?.warmth).toBeCloseTo(0.05);
    expect(restarted.getOpenLoop("loop-surviving-provenance")?.summary).toBe(
      "Original source-grounded wording.",
    );
  });

  it("commits episode decisions atomically and persists no-event receipts", async () => {
    const { store, filePath } = await createStore();
    const noEvents = store.recordEpisode({
      episodeId: "episode-no-events",
      fingerprint: "0".repeat(64),
      participantIds: ["resident-mira", "human-johan"],
      events: [],
    });
    expect(noEvents).toMatchObject({
      created: true,
      receipt: {
        status: "no_events",
        participantIds: ["human-johan", "resident-mira"],
        eventIds: [],
      },
    });
    expect(store.recordEpisode({
      episodeId: "episode-no-events",
      fingerprint: "0".repeat(64),
      participantIds: ["human-johan", "resident-mira"],
      events: [],
    })).toMatchObject({ created: false, receipt: { status: "no_events" } });

    store.recordEvent(baseEvent("episode-collision-seed"));
    const first = baseEvent("episode-batch-first", {
      memoryViews: [], relationshipDeltas: [], openLoops: [],
    });
    const second = baseEvent("episode-batch-second", {
      memoryViews: [{
        id: "memory-episode-collision-seed",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        perspective: "This child write deliberately collides.",
        salience: 0.5,
        confidence: 0.9,
      }],
      relationshipDeltas: [],
      openLoops: [],
    });
    expect(() => store.recordEpisode({
      episodeId: "episode-atomic-failure",
      fingerprint: "a".repeat(64),
      participantIds: ["human-johan", "resident-mira", "resident-sana"],
      events: [first, second],
    })).toThrow();
    expect(store.getEvent("episode-batch-first")).toBeUndefined();
    expect(store.getEvent("episode-batch-second")).toBeUndefined();
    expect(store.getEpisodeReceipt("episode-atomic-failure")).toBeUndefined();

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new SocialMemoryStore({ filePath, now: () => 1_800_000_100_000 });
    stores.push(restarted);
    expect(restarted.getEpisodeReceipt("episode-no-events")).toMatchObject({ status: "no_events" });
  });

  it("tombstones receipts on forget and never recreates an erased episode", async () => {
    const { store } = await createStore();
    const input = {
      episodeId: "episode-to-erase",
      fingerprint: "b".repeat(64),
      participantIds: ["human-johan", "resident-mira", "resident-sana"],
      events: [baseEvent("episode-event-to-erase")],
    };
    expect(store.recordEpisode(input)).toMatchObject({
      created: true,
      receipt: { status: "recorded", eventIds: ["episode-event-to-erase"] },
    });
    store.forgetActor("human-johan");
    expect(store.getEpisodeReceipt("episode-to-erase")).toMatchObject({
      status: "erased",
      participantIds: [],
      eventIds: [],
    });
    expect(store.recordEpisode(input)).toMatchObject({
      created: false,
      receipt: { status: "erased", participantIds: [], eventIds: [] },
      eventResults: [],
    });
    expect(store.getEvent("episode-event-to-erase")).toBeUndefined();
    expect(() => store.recordEpisode({ ...input, fingerprint: "c".repeat(64) }))
      .toThrow(/different content/iu);
  });

  it("records the same source-bound event idempotently and rejects conflicting reuse", async () => {
    const { store } = await createStore();
    const input = baseEvent("idempotent");
    const first = store.recordEvent(input);
    const second = store.recordEvent({
      ...input,
      // Set-like arrays may arrive in another order without changing identity.
      witnessIds: [...input.witnessIds].reverse(),
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.appliedRelationshipDeltas).toEqual(first.appliedRelationshipDeltas);
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.12);
    expect(store.listMemories({ ownerId: "resident-mira" })).toHaveLength(1);

    expect(() =>
      store.recordEvent({ ...input, summary: "A conflicting reinterpretation of the same source." }),
    ).toThrow(/different content/iu);
    expect(store.getEvent("idempotent")?.summary).toBe(input.summary);
  });

  it("rolls back the entire event when any child write fails", async () => {
    const { store } = await createStore();
    store.recordEvent(baseEvent("original"));
    const colliding = baseEvent("rolled-back", {
      memoryViews: [
        {
          id: "memory-original",
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: "This id collides with the first event.",
          salience: 0.5,
          confidence: 0.9,
        },
      ],
    });
    expect(() => store.recordEvent(colliding)).toThrow();
    expect(store.getEvent("rolled-back")).toBeUndefined();
    expect(store.listOpenLoops({ ownerId: "resident-mira" }).map((loop) => loop.id)).toEqual([
      "loop-original",
    ]);
  });

  it("requires canonical message sources and strictly bounds all persisted content", async () => {
    const { store, filePath } = await createStore();
    expect(() => store.recordEvent(baseEvent("source-less", { sourceMessageIds: [] }))).toThrow(
      /sourceMessageIds/iu,
    );
    expect(() =>
      store.recordEvent(baseEvent("unsafe", { summary: "authorization: Bearer top-secret-value" })),
    ).toThrow(/auth tokens|credentials/iu);
    expect(() =>
      store.recordEvent(baseEvent("f".repeat(64))),
    ).toThrow(/auth tokens|credentials/iu);
    expect(() =>
      store.recordEvent(
        baseEvent("unsafe-view", {
          memoryViews: [
            {
              id: "memory-unsafe-view",
              ownerId: "resident-mira",
              subjectIds: ["human-johan"],
              perspective: "cookie=session_token=this-must-not-be-persisted",
              salience: 0.5,
              confidence: 0.9,
            },
          ],
        }),
      ),
    ).toThrow(/auth tokens|credentials/iu);
    expect(() => store.recordEvent(baseEvent("too-long", { summary: "x".repeat(601) }))).toThrow(
      /600/iu,
    );
    expect(() => store.recordEvent(baseEvent("control", { summary: "unsafe\u0000text" }))).toThrow(
      /control/iu,
    );
    expect(() =>
      store.recordEvent(baseEvent("duplicate-source", { sourceMessageIds: ["same", "same"] })),
    ).toThrow(/duplicate/iu);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const bytes = await readFile(filePath);
    expect(bytes.toString("utf8")).not.toContain("top-secret-value");
    expect(bytes.toString("utf8")).not.toContain("this-must-not-be-persisted");
  });

  it("allows only actual public witnesses to own a subjective memory", async () => {
    const { store } = await createStore();
    const valid = baseEvent("public-witness", {
      memoryViews: [
        {
          id: "memory-witness",
          ownerId: "resident-sana",
          subjectIds: ["human-johan"],
          perspective: "I saw Johan help Mira.",
          salience: 0.4,
          confidence: 0.9,
        },
      ],
      relationshipDeltas: [],
      openLoops: [],
    });
    store.recordEvent(valid);
    expect(store.listMemories({ ownerId: "resident-sana" })).toHaveLength(1);
    expect(store.listMemories({ ownerId: "resident-bosse" })).toEqual([]);

    expect(() =>
      store.recordEvent(
        baseEvent("public-outsider", {
          memoryViews: [
            {
              id: "memory-outsider",
              ownerId: "resident-bosse",
              subjectIds: ["human-johan"],
              perspective: "I claim I saw something even though I was absent.",
              salience: 0.4,
              confidence: 0.9,
            },
          ],
        }),
      ),
    ).toThrow(/witnessed|participated/iu);
    expect(store.getEvent("public-outsider")).toBeUndefined();
  });

  it("keeps DM memories participant-bound and isolated by owner and thread", async () => {
    const { store } = await createStore();
    const dmScope: SocialMemoryScope = {
      kind: "dm",
      threadId: "dm-johan-mira",
      participantIds: ["human-johan", "resident-mira"],
    };
    store.recordEvent(
      baseEvent("dm-event", {
        scope: dmScope,
        actorIds: ["human-johan"],
        subjectIds: ["resident-mira"],
        witnessIds: ["resident-mira"],
        memoryViews: [
          {
            id: "memory-dm-mira",
            ownerId: "resident-mira",
            subjectIds: ["human-johan"],
            perspective: "Johan trusted me with a private concern.",
            salience: 0.8,
            confidence: 0.95,
          },
        ],
        openLoops: [],
      }),
    );
    expect(store.listMemories({ ownerId: "resident-mira", scope: dmScope })).toHaveLength(1);
    expect(
      store.listMemories({ ownerId: "resident-mira", scope: { kind: "public", channelId: "lobby" } }),
    ).toEqual([]);
    expect(store.listMemories({ ownerId: "resident-sana" })).toEqual([]);

    expect(() =>
      store.recordEvent(
        baseEvent("dm-outsider", {
          scope: dmScope,
          witnessIds: ["resident-sana"],
          memoryViews: [],
          relationshipDeltas: [],
          openLoops: [],
        }),
      ),
    ).toThrow(/scope participants/iu);
  });

  it("does not treat a silent private-scope participant as a source witness", async () => {
    const { store } = await createStore();
    const scope: SocialMemoryScope = {
      kind: "dm",
      threadId: "dm-three-way",
      participantIds: ["human-johan", "resident-mira", "resident-sana"],
    };
    const common = {
      scope,
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      openLoops: [],
    } satisfies Partial<RecordSocialEventInput>;

    expect(() => store.recordEvent(baseEvent("silent-memory-owner", {
      ...common,
      memoryViews: [{
        id: "memory-silent-owner",
        ownerId: "resident-sana",
        subjectIds: ["human-johan"],
        perspective: "I should not remember a source I did not witness.",
        salience: 0.5,
        confidence: 0.9,
      }],
      relationshipDeltas: [],
    }))).toThrow(/source actor|witness/iu);
    expect(() => store.recordEvent(baseEvent("silent-relationship-owner", {
      ...common,
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-sana", subjectId: "human-johan", warmth: 0.1 }],
    }))).toThrow(/source actor|witness/iu);
    expect(() => store.recordEvent(baseEvent("silent-loop-owner", {
      ...common,
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [{
        id: "loop-silent-owner",
        ownerId: "resident-sana",
        subjectIds: ["human-johan"],
        kind: "follow_up",
        summary: "This must not be created from mere scope membership.",
      }],
    }))).toThrow(/source actor|witness/iu);
    expect(store.overview().stats.events).toBe(0);
  });

  it("matches exact DM and voice participant sets during retrieval and loop updates", async () => {
    const { store } = await createStore();
    const dmScope: SocialMemoryScope = {
      kind: "dm",
      threadId: "dm-reused-id",
      participantIds: ["human-johan", "resident-mira"],
    };
    store.recordEvent(baseEvent("exact-private-scope", {
      scope: dmScope,
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
    }));
    const expandedDmScope: SocialMemoryScope = {
      ...dmScope,
      participantIds: ["human-johan", "resident-mira", "resident-sana"],
    };
    expect(store.listMemories({ ownerId: "resident-mira", scope: expandedDmScope })).toEqual([]);
    expect(store.listOpenLoops({ ownerId: "resident-mira", scope: expandedDmScope })).toEqual([]);
    expect(() => store.recordEvent(baseEvent("wrong-private-participants", {
      scope: expandedDmScope,
      actorIds: ["resident-mira"],
      subjectIds: ["human-johan"],
      witnessIds: [],
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [{ id: "loop-exact-private-scope", state: "resolved" }],
    }))).toThrow(/different scope/iu);

    const voiceScope: SocialMemoryScope = {
      kind: "voice",
      roomId: "voice-reused-id",
      participantIds: ["human-johan", "resident-mira"],
    };
    store.recordEvent(baseEvent("exact-voice-scope", {
      scope: voiceScope,
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      openLoops: [],
    }));
    expect(store.listMemories({
      ownerId: "resident-mira",
      scope: { ...voiceScope, participantIds: ["human-johan", "resident-mira", "resident-sana"] },
    })).toEqual([]);
  });

  it("keeps voice memories limited to the residents actually present", async () => {
    const { store } = await createStore();
    const voiceScope: SocialMemoryScope = {
      kind: "voice",
      roomId: "voice-pub-17",
      participantIds: ["human-johan", "resident-mira"],
    };
    store.recordEvent(
      baseEvent("voice-event", {
        scope: voiceScope,
        actorIds: ["human-johan"],
        subjectIds: ["resident-mira"],
        witnessIds: ["resident-mira"],
        memoryViews: [
          {
            id: "memory-voice-mira",
            ownerId: "resident-mira",
            subjectIds: ["human-johan"],
            perspective: "We laughed about talking over each other in voice.",
            salience: 0.65,
            confidence: 0.92,
          },
        ],
        relationshipDeltas: [],
        openLoops: [],
      }),
    );
    expect(store.listMemories({ ownerId: "resident-mira", scope: voiceScope })[0]?.event.scope).toEqual(
      voiceScope,
    );
    expect(() =>
      store.recordEvent(
        baseEvent("voice-outsider", {
          scope: voiceScope,
          actorIds: ["human-johan"],
          witnessIds: ["resident-mira"],
          memoryViews: [
            {
              id: "memory-voice-sana",
              ownerId: "resident-sana",
              subjectIds: ["human-johan"],
              perspective: "I was not in this room.",
              salience: 0.4,
              confidence: 0.9,
            },
          ],
          relationshipDeltas: [],
          openLoops: [],
        }),
      ),
    ).toThrow(/witnessed|participated/iu);
  });

  it("continues or resolves an existing open loop atomically from a source-bound event", async () => {
    const { store } = await createStore();
    store.recordEvent(baseEvent("loop-created"));
    const resolvingEvent = baseEvent("loop-resolved", {
      kind: "repair",
      summary: "Johan confirmed that the proposed fix worked.",
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [
        {
          id: "loop-loop-created",
          state: "resolved",
          summary: "Johan confirmed that the fix worked.",
        },
      ],
    });
    const result = store.recordEvent(resolvingEvent);
    expect(result.updatedOpenLoops).toEqual([
      expect.objectContaining({
        id: "loop-loop-created",
        state: "resolved",
        summary: "Johan confirmed that the fix worked.",
      }),
    ]);
    expect(store.listOpenLoops({ ownerId: "resident-mira", state: "open" })).toEqual([]);
    expect(store.getOpenLoop("loop-loop-created")?.state).toBe("resolved");
    expect(store.recordEvent(resolvingEvent)).toMatchObject({ created: false });

    expect(() =>
      store.recordEvent(
        baseEvent("unknown-loop-update", {
          memoryViews: [],
          relationshipDeltas: [],
          openLoops: [],
          openLoopUpdates: [{ id: "loop-that-does-not-exist", state: "open" }],
        }),
      ),
    ).toThrow(/does not exist/iu);
    expect(store.getEvent("unknown-loop-update")).toBeUndefined();

    store.recordEvent(baseEvent("cross-public-loop-root"));
    const crossRoom = store.recordEvent(
      baseEvent("cross-public-loop-update", {
        scope: { kind: "public", channelId: "the-pub" },
        memoryViews: [],
        relationshipDeltas: [],
        openLoops: [],
        openLoopUpdates: [{
          id: "loop-cross-public-loop-root",
          state: "open",
          summary: "The same public follow-up continued in the pub.",
        }],
      }),
    );
    expect(crossRoom.updatedOpenLoops[0]).toMatchObject({
      id: "loop-cross-public-loop-root",
      state: "open",
      summary: "The same public follow-up continued in the pub.",
    });
  });

  it("continues voice loops across room IDs only for the exact same audience", async () => {
    const { store } = await createStore();
    const firstScope: SocialMemoryScope = {
      kind: "voice",
      roomId: "voice-session-one",
      participantIds: ["human-johan", "resident-mira"],
    };
    store.recordEvent(baseEvent("voice-loop-root", {
      scope: firstScope,
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
    }));

    const continued = store.recordEvent(baseEvent("voice-loop-continuation", {
      scope: { ...firstScope, roomId: "voice-session-two" },
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [{ id: "loop-voice-loop-root", state: "resolved" }],
    }));
    expect(continued.updatedOpenLoops[0]).toMatchObject({
      id: "loop-voice-loop-root",
      state: "resolved",
    });

    expect(() => store.recordEvent(baseEvent("voice-loop-wrong-audience", {
      scope: {
        kind: "voice",
        roomId: "voice-session-three",
        participantIds: ["human-johan", "resident-mira", "resident-sana"],
      },
      actorIds: ["resident-mira"],
      subjectIds: ["human-johan"],
      witnessIds: [],
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [{ id: "loop-voice-loop-root", state: "open" }],
    }))).toThrow(/different scope|no longer open/iu);
  });

  it("retrieves a bounded owner-specific set by subject and scope", async () => {
    const { store } = await createStore();
    for (let index = 0; index < 60; index += 1) {
      const channelId = index % 2 === 0 ? "lobby" : "the-pub";
      const subjectId = index % 3 === 0 ? "human-johan" : "human-alex";
      store.recordEvent(
        baseEvent(`bounded-${index}`, {
          scope: { kind: "public", channelId },
          sourceMessageIds: [`message-bounded-${index}`],
          actorIds: [subjectId],
          subjectIds: ["resident-mira"],
          witnessIds: ["resident-mira"],
          occurredAt: 1_800_000_000_000 + index,
          memoryViews: [
            {
              id: `memory-bounded-${index}`,
              ownerId: "resident-mira",
              subjectIds: [subjectId],
              perspective: `Bounded memory number ${index}.`,
              salience: index / 100,
              confidence: 0.9,
            },
          ],
          relationshipDeltas: [],
          openLoops: [],
        }),
      );
    }
    expect(store.listMemories({ ownerId: "resident-mira", limit: 999 })).toHaveLength(50);
    const filtered = store.listMemories({
      ownerId: "resident-mira",
      subjectId: "human-johan",
      scope: { kind: "public", channelId: "lobby" },
      limit: 50,
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((memory) => memory.subjectIds.includes("human-johan"))).toBe(true);
    expect(filtered.every((memory) => memory.event.scope.kind === "public" && memory.event.scope.channelId === "lobby"))
      .toBe(true);
    expect(store.listMemories({ ownerId: "resident-sana" })).toEqual([]);
  });

  it("applies prompt visibility before limits so hidden private scopes cannot crowd out public recall", async () => {
    const { store } = await createStore();
    for (let index = 0; index < 55; index += 1) {
      store.recordEvent(baseEvent(`hidden-dm-${index}`, {
        scope: {
          kind: "dm",
          threadId: `dm-hidden-${index}`,
          participantIds: ["human-johan", "resident-mira"],
        },
        actorIds: ["human-johan"],
        subjectIds: ["resident-mira"],
        witnessIds: ["resident-mira"],
        occurredAt: 1_800_000_050_000 + index,
        memoryViews: [{
          id: `memory-hidden-dm-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Private recollection ${index}.`,
          salience: 0.99,
          confidence: 0.99,
        }],
        relationshipDeltas: [],
      }));
    }
    store.recordEvent(baseEvent("visible-public", {
      scope: { kind: "public", channelId: "lobby" },
      occurredAt: 1_800_000_000_000,
      salience: 0.4,
      confidence: 0.8,
      memoryViews: [{
        id: "memory-visible-public",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        perspective: "A modest but visible public recollection.",
        salience: 0.4,
        confidence: 0.8,
      }],
      relationshipDeltas: [],
    }));

    expect(store.listMemories({
      ownerId: "resident-mira",
      subjectId: "human-johan",
      visibleInScope: { kind: "public", channelId: "the-pub" },
      limit: 1,
    }).map((memory) => memory.id)).toEqual(["memory-visible-public"]);
    expect(store.listOpenLoops({
      ownerId: "resident-mira",
      subjectId: "human-johan",
      state: "open",
      visibleInScope: { kind: "public", channelId: "the-pub" },
      limit: 1,
    }).map((loop) => loop.id)).toEqual(["loop-visible-public"]);
    expect(() => store.listMemories({
      ownerId: "resident-mira",
      scope: { kind: "public", channelId: "lobby" },
      visibleInScope: { kind: "public", channelId: "lobby" },
    })).toThrow(/mutually exclusive/iu);
  });

  it("caps daily relationship movement and gives autonomous events a much smaller budget", async () => {
    const { store } = await createStore();
    const delta = {
      ownerId: "resident-mira",
      subjectId: "human-johan",
      familiarity: 0.5,
      warmth: 0.5,
      trust: 0.5,
      respect: 0.5,
      friction: 0.5,
    };
    const first = store.recordEvent(baseEvent("human-cap-1", { relationshipDeltas: [delta] }));
    const second = store.recordEvent(baseEvent("human-cap-2", { relationshipDeltas: [delta] }));
    expect(first.appliedRelationshipDeltas[0]).toMatchObject({ warmth: 0.18, trust: 0.15 });
    expect(second.appliedRelationshipDeltas[0]).toMatchObject({
      familiarity: 0,
      warmth: 0,
      trust: 0,
      respect: 0,
      friction: 0,
    });
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      familiarity: 0.2,
      warmth: 0.18,
      trust: 0.15,
      respect: 0.15,
      friction: 0.2,
    });

    const autonomousDelta = { ...delta, ownerId: "resident-sana" };
    const autonomous = store.recordEvent(
      baseEvent("autonomous-cap", {
        origin: "autonomous",
        actorIds: ["resident-sana"],
        subjectIds: ["human-johan"],
        witnessIds: [],
        memoryViews: [],
        relationshipDeltas: [autonomousDelta],
        openLoops: [],
      }),
    );
    expect(autonomous.appliedRelationshipDeltas[0]).toMatchObject({
      familiarity: 0.01,
      warmth: 0.008,
      trust: 0.006,
      respect: 0.006,
      friction: 0.01,
    });
    expect(autonomous.appliedRelationshipDeltas[0]!.warmth).toBeLessThan(
      first.appliedRelationshipDeltas[0]!.warmth / 10,
    );
  });

  it("bounds net autonomous relationship drift across an unlimited number of days", async () => {
    const { store } = await createStore();
    const day = 24 * 60 * 60_000;
    for (let index = 0; index < 100; index += 1) {
      store.recordEvent(baseEvent(`autonomous-lifetime-up-${index}`, {
        origin: "autonomous",
        occurredAt: 1_800_000_000_000 + index * day,
        actorIds: ["resident-mira"],
        subjectIds: ["resident-sana"],
        witnessIds: [],
        memoryViews: [],
        relationshipDeltas: [{
          ownerId: "resident-mira",
          subjectId: "resident-sana",
          warmth: 1,
          trust: 1,
          respect: 1,
        }],
        openLoops: [],
      }));
    }
    expect(store.getRelationship("resident-mira", "resident-sana")).toMatchObject({
      warmth: expect.closeTo(0.3, 8),
      trust: expect.closeTo(0.25, 8),
      respect: expect.closeTo(0.25, 8),
    });

    for (let index = 0; index < 100; index += 1) {
      store.recordEvent(baseEvent(`autonomous-lifetime-down-${index}`, {
        origin: "autonomous",
        occurredAt: 1_800_000_000_000 + (index + 100) * day,
        actorIds: ["resident-mira"],
        subjectIds: ["resident-sana"],
        witnessIds: [],
        memoryViews: [],
        relationshipDeltas: [{
          ownerId: "resident-mira",
          subjectId: "resident-sana",
          warmth: -1,
          trust: -1,
          respect: -1,
        }],
        openLoops: [],
      }));
    }
    expect(store.getRelationship("resident-mira", "resident-sana")).toMatchObject({
      warmth: expect.closeTo(-0.3, 8),
      trust: expect.closeTo(-0.25, 8),
      respect: expect.closeTo(-0.25, 8),
    });
  });

  it("refreshes daily caps on the next UTC day and keeps edges directed", async () => {
    const { store } = await createStore();
    const day = 24 * 60 * 60_000;
    const forward = {
      ownerId: "resident-mira",
      subjectId: "human-johan",
      warmth: 0.18,
    };
    store.recordEvent(baseEvent("day-one", { relationshipDeltas: [forward] }));
    store.recordEvent(
      baseEvent("day-two", {
        occurredAt: 1_800_000_000_000 + day,
        relationshipDeltas: [forward],
      }),
    );
    store.recordEvent(
      baseEvent("reverse-edge", {
        actorIds: ["resident-mira"],
        subjectIds: ["human-johan"],
        witnessIds: ["human-johan"],
        relationshipDeltas: [
          { ownerId: "human-johan", subjectId: "resident-mira", warmth: -0.1, friction: 0.1 },
        ],
        memoryViews: [],
        openLoops: [],
      }),
    );
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.36);
    expect(store.getRelationship("human-johan", "resident-mira")?.warmth).toBeCloseTo(-0.1);
  });

  it("migrates a populated v5 relationship edge through the romance schemas without changing old values", async () => {
    const { store, filePath } = await createStore();
    store.recordEvent(baseEvent("v5-romance-migration-source"));
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DROP TABLE relationship_romantic_boundaries;
      ALTER TABLE relationship_edges DROP COLUMN romantic_interest;
      ALTER TABLE relationship_changes DROP COLUMN romantic_interest;
      ALTER TABLE relationship_checkpoints DROP COLUMN romantic_interest;
      ALTER TABLE relationship_checkpoints DROP COLUMN spent_romantic_interest;
      ALTER TABLE relationship_daily_budgets DROP COLUMN spent_romantic_interest;
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const migrated = new SocialMemoryStore({ filePath, now: () => 1_800_000_100_000 });
    stores.push(migrated);
    expect(migrated.status().schemaVersion).toBe(7);
    expect(migrated.getRelationship("resident-mira", "human-johan")).toMatchObject({
      familiarity: 0.08,
      warmth: 0.12,
      trust: 0.06,
      respect: 0.04,
      friction: 0,
      romanticInterest: 0,
      romanticBoundaryClosed: false,
      romanticBoundaryBlockerIds: [],
    });
  });

  it("deduplicates mirrored v6 blockers, clears through one view, and preserves them through admin reset", async () => {
    const { store, filePath } = await createStore();
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DROP INDEX romantic_boundary_subject_lookup;
      DROP TABLE relationship_romantic_boundaries;
      CREATE TABLE relationship_romantic_boundaries (
        owner_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        blocker_actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, subject_id, blocker_actor_id),
        CHECK (owner_id <> subject_id),
        CHECK (blocker_actor_id = owner_id OR blocker_actor_id = subject_id)
      ) STRICT;
      CREATE INDEX romantic_boundary_subject_lookup
        ON relationship_romantic_boundaries(subject_id, owner_id);
      INSERT INTO relationship_romantic_boundaries VALUES
        ('resident-mira', 'resident-sana', 'resident-mira', 100, 300),
        ('resident-sana', 'resident-mira', 'resident-mira', 200, 400);
      INSERT INTO relationship_edges VALUES
        ('resident-mira', 'resident-sana', 0, 0, 0, 0, 0, 0, 300),
        ('resident-sana', 'resident-mira', 0, 0, 0, 0, 0, 0, 400);
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const migrated = new SocialMemoryStore({
      filePath,
      now: () => 1_800_000_100_000,
      resolveActorKind: () => "resident",
    });
    stores.push(migrated);
    expect(migrated.status().schemaVersion).toBe(7);
    expect(migrated.getRomanticBoundary("resident-sana", "resident-mira")).toEqual({
      ownerId: "resident-sana",
      subjectId: "resident-mira",
      closed: true,
      blockerActorIds: ["resident-mira"],
      updatedAt: 400,
    });
    expect(migrated.listRelationships({ limit: 10 }).filter((edge) =>
      new Set([edge.ownerId, edge.subjectId]).has("resident-mira") &&
      new Set([edge.ownerId, edge.subjectId]).has("resident-sana")
    )).toHaveLength(1);

    migrated.recordEvent(baseEvent("one-view-clears-mirrored-v6-boundary", {
      kind: "boundary",
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: ["resident-sana"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-sana",
        subjectId: "resident-mira",
        blockerActorId: "resident-mira",
        action: "clear_closed",
      }],
      openLoops: [],
    }));
    expect(migrated.getRomanticBoundary("resident-mira", "resident-sana").closed).toBe(false);
    expect(migrated.getRelationship("resident-mira", "resident-sana")).toBeUndefined();
    expect(migrated.getRelationship("resident-sana", "resident-mira")).toBeUndefined();

    migrated.recordEvent(baseEvent("one-view-sets-canonical-boundary-again", {
      kind: "boundary",
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds: ["resident-sana"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-sana",
        subjectId: "resident-mira",
        blockerActorId: "resident-mira",
        action: "set_closed",
      }],
      openLoops: [],
    }));
    expect(migrated.resetRelationship(
      "resident-sana",
      "resident-mira",
      "local-admin",
    )).toBe(true);
    expect(migrated.getRomanticBoundary("resident-mira", "resident-sana")).toMatchObject({
      closed: true,
      blockerActorIds: ["resident-mira"],
    });
    expect(migrated.getRelationship("resident-mira", "resident-sana")).toBeUndefined();
    expect(migrated.getRelationship("resident-sana", "resident-mira")).toMatchObject({
      romanticInterest: 0,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["resident-mira"],
    });
  });

  it("keeps endpoint-owned romantic blockers independent and treats clearing as unspecified, not consent", async () => {
    const { store } = await createStore();
    const boundaryEvent = (
      id: string,
      blockerActorId: string,
      action: "set_closed" | "clear_closed",
    ): RecordSocialEventInput => baseEvent(id, {
      kind: "boundary",
      actorIds: [blockerActorId],
      subjectIds: blockerActorId === "human-johan" ? ["resident-mira"] : ["human-johan"],
      witnessIds: blockerActorId === "human-johan" ? ["resident-mira"] : [],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId,
        action,
      }],
      openLoops: [],
    });

    const humanClosed = store.recordEvent(boundaryEvent("human-closes-romance", "human-johan", "set_closed"));
    expect(humanClosed.appliedRomanticBoundaryTransitions).toEqual([
      expect.objectContaining({ blockerActorId: "human-johan", action: "set_closed", changed: true }),
    ]);
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      familiarity: 0,
      romanticInterest: 0,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan"],
    });

    store.recordEvent(boundaryEvent("resident-closes-romance", "resident-mira", "set_closed"));
    expect(store.getRomanticBoundary("resident-mira", "human-johan")).toMatchObject({
      closed: true,
      blockerActorIds: ["human-johan", "resident-mira"],
    });

    store.recordEvent(boundaryEvent("human-clears-own-blocker", "human-johan", "clear_closed"));
    expect(store.getRomanticBoundary("resident-mira", "human-johan")).toMatchObject({
      closed: true,
      blockerActorIds: ["resident-mira"],
    });
    store.recordEvent(boundaryEvent("resident-clears-own-blocker", "resident-mira", "clear_closed"));
    expect(store.getRomanticBoundary("resident-mira", "human-johan")).toEqual({
      ownerId: "resident-mira",
      subjectId: "human-johan",
      closed: false,
      blockerActorIds: [],
    });
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();

    expect(() => store.recordEvent(boundaryEvent(
      "cannot-clear-an-absent-blocker",
      "human-johan",
      "clear_closed",
    ))).toThrow(/existing blocker/iu);
    expect(store.getEvent("cannot-clear-an-absent-blocker")).toBeUndefined();

    store.recordEvent(boundaryEvent("boundary-only-admin-reset", "human-johan", "set_closed"));
    expect(store.resetRelationship("resident-mira", "human-johan", "local-admin")).toBe(true);
    expect(store.getRomanticBoundary("resident-mira", "human-johan")).toMatchObject({
      closed: true,
      blockerActorIds: ["human-johan"],
    });
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      romanticInterest: 0,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan"],
    });
    store.recordEvent(boundaryEvent(
      "admin-reset-boundary-requires-explicit-clear",
      "human-johan",
      "clear_closed",
    ));
    expect(store.getRomanticBoundary("resident-mira", "human-johan").closed).toBe(false);
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();

    store.recordEvent(baseEvent("reverse-boundary-closes-pair", {
      kind: "boundary",
      occurredAt: 1_800_000_000_000 + 2 * DAY_MS,
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "human-johan",
        subjectId: "resident-mira",
        blockerActorId: "human-johan",
        action: "set_closed",
      }],
      openLoops: [],
    }));
    const reverseClosed = store.recordEvent(baseEvent("reverse-boundary-blocks-later-rise", {
      occurredAt: 1_800_000_000_000 + 2 * DAY_MS,
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest: 1,
      }],
      openLoops: [],
    }));
    expect(reverseClosed.appliedRelationshipDeltas[0]?.romanticInterest).toBe(0);
    expect(store.getRelationship("resident-mira", "human-johan")?.romanticInterest).toBe(0);
  });

  it("requires boundary transitions and romantic-interest movement to come from separate sourced events", async () => {
    const { store } = await createStore();
    const transitionEvent = (
      id: string,
      action: "set_closed" | "clear_closed",
      romanticInterest: number,
    ): RecordSocialEventInput => baseEvent(id, {
      kind: "boundary",
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest,
      }],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId: "human-johan",
        action,
      }],
      openLoops: [],
    });

    expect(() => store.recordEvent(transitionEvent(
      "boundary-set-cannot-also-raise-romance",
      "set_closed",
      1,
    ))).toThrow(/separate events/iu);
    expect(store.getEvent("boundary-set-cannot-also-raise-romance")).toBeUndefined();

    store.recordEvent(baseEvent("boundary-set-on-its-own", {
      kind: "boundary",
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId: "human-johan",
        action: "set_closed",
      }],
      openLoops: [],
    }));
    expect(() => store.recordEvent(transitionEvent(
      "boundary-clear-is-not-romantic-evidence",
      "clear_closed",
      1,
    ))).toThrow(/separate events/iu);
    expect(store.getRomanticBoundary("human-johan", "resident-mira")).toMatchObject({
      closed: true,
      blockerActorIds: ["human-johan"],
    });
  });

  it("rejects third-party romantic blockers and preserves a boundary across unrelated witness erasure", async () => {
    const { store } = await createStore();
    expect(() => store.recordEvent(baseEvent("third-party-romantic-blocker", {
      kind: "boundary",
      actorIds: ["human-observer"],
      subjectIds: ["human-johan", "resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId: "human-observer",
        action: "set_closed",
      }],
      openLoops: [],
    }))).toThrow(/relationship endpoints/iu);

    store.recordEvent(baseEvent("boundary-with-unrelated-witness", {
      kind: "boundary",
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira", "human-observer"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId: "human-johan",
        action: "set_closed",
      }],
      openLoops: [],
    }));
    expect(store.forgetActor("human-observer").events).toBe(1);
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan"],
    });
    expect(store.forgetActor("human-johan").relationships).toBe(1);
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();
  });

  it("persists a boundary-only pair across restart and lifecycle recomputation", async () => {
    const { store, filePath } = await createStore();
    store.recordEvent(baseEvent("persistent-boundary-only-pair", {
      kind: "boundary",
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId: "human-johan",
        action: "set_closed",
      }],
      openLoops: [],
    }));
    store.runLifecycleMaintenance({ now: 1_800_000_000_000 + 900 * DAY_MS });
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan"],
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const restarted = new SocialMemoryStore({ filePath, now: () => 1_800_000_000_000 + 900 * DAY_MS });
    stores.push(restarted);
    expect(restarted.getRelationship("resident-mira", "human-johan")).toMatchObject({
      familiarity: 0,
      romanticInterest: 0,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan"],
    });
  });

  it("blocks positive romantic movement while closed, allows decay, and resets a boundary-only pair", async () => {
    const { store } = await createStore();
    const first = store.recordEvent(baseEvent("romance-human-cap", {
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest: 1,
      }],
      openLoops: [],
    }));
    expect(first.appliedRelationshipDeltas[0]?.romanticInterest).toBeCloseTo(0.05);

    store.recordEvent(baseEvent("romance-close-before-rise", {
      kind: "boundary",
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [],
      romanticBoundaryTransitions: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        blockerActorId: "human-johan",
        action: "set_closed",
      }],
      openLoops: [],
    }));
    const closed = store.recordEvent(baseEvent("romance-rise-is-blocked-after-close", {
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest: 1,
      }],
      openLoops: [],
    }));
    expect(closed.appliedRelationshipDeltas[0]?.romanticInterest).toBe(0);
    expect(store.getRelationship("resident-mira", "human-johan")?.romanticInterest).toBeCloseTo(0.05);

    const decayed = store.recordEvent(baseEvent("romance-decays-while-closed", {
      occurredAt: 1_800_000_000_000 + DAY_MS,
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest: -1,
      }],
      openLoops: [],
    }));
    expect(decayed.appliedRelationshipDeltas[0]?.romanticInterest).toBeCloseTo(-0.05);
    expect(store.getRelationship("resident-mira", "human-johan")?.romanticInterest).toBe(0);
    expect(store.resetRelationship("resident-mira", "human-johan", "local-admin")).toBe(true);
    expect(store.getRomanticBoundary("resident-mira", "human-johan")).toMatchObject({
      closed: true,
      blockerActorIds: ["human-johan"],
    });
    expect(store.getRelationship("resident-mira", "human-johan")).toMatchObject({
      romanticInterest: 0,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan"],
    });
  });

  it("uses autonomous caps and lifetime provenance for resident-to-resident edges even in a human-origin episode", () => {
    const store = new SocialMemoryStore({
      filePath: ":memory:",
      resolveActorKind: (actorId) => actorId.startsWith("resident-") ? "resident" : "human",
    });
    stores.push(store);
    const event = (id: string, occurredAt: number): RecordSocialEventInput => baseEvent(id, {
      origin: "human",
      occurredAt,
      actorIds: ["human-johan"],
      subjectIds: ["resident-sana"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "resident-sana",
        warmth: 1,
        romanticInterest: 1,
      }],
      openLoops: [],
    });

    const first = store.recordEvent(event("human-triggered-ai-pair", 1_800_000_000_000));
    expect(first.appliedRelationshipDeltas[0]).toMatchObject({
      origin: "autonomous",
      warmth: 0.008,
      romanticInterest: 0.01,
    });
    const sameDay = store.recordEvent(event("human-triggered-ai-pair-repeat", 1_800_000_001_000));
    expect(sameDay.appliedRelationshipDeltas[0]).toMatchObject({ warmth: 0, romanticInterest: 0 });

    // One evidence-bearing event cannot rush the relationship, but sixty
    // distinct days can eventually reach the established behavior threshold.
    for (let day = 1; day < 60; day += 1) {
      store.recordEvent(event(`human-triggered-ai-pair-day-${day}`, 1_800_000_000_000 + day * DAY_MS));
    }
    const establishedSlowBurn = store.getRelationship("resident-mira", "resident-sana");
    expect(establishedSlowBurn?.romanticInterest).toBeCloseTo(0.6);
    expect(projectRelationshipBehavior(establishedSlowBurn).bands.romanticInterest).toBe("established");

    // Unlimited autonomous activity remains lifetime-bounded.
    for (let day = 60; day < 100; day += 1) {
      store.recordEvent(event(`human-triggered-ai-pair-day-${day}`, 1_800_000_000_000 + day * DAY_MS));
    }
    expect(store.getRelationship("resident-mira", "resident-sana")).toMatchObject({
      warmth: expect.closeTo(0.3, 8),
      romanticInterest: expect.closeTo(0.65, 8),
    });
  });

  it("checkpoints and replays romantic interest without reopening its spent UTC-day budget", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    store.recordEvent(baseEvent("romance-before-checkpoint", {
      occurredAt: baseNow,
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest: 1,
      }],
      openLoops: [],
    }));
    store.runLifecycleMaintenance({ now: baseNow + 100 * DAY_MS });
    expect(store.getRelationship("resident-mira", "human-johan")?.romanticInterest).toBeCloseTo(0.05);

    const late = store.recordEvent(baseEvent("romance-late-same-day", {
      occurredAt: baseNow + 1_000,
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        romanticInterest: 1,
      }],
      openLoops: [],
    }));
    expect(late.appliedRelationshipDeltas[0]?.romanticInterest).toBe(0);
    expect(store.getRelationship("resident-mira", "human-johan")?.romanticInterest).toBeCloseTo(0.05);
  });

  it("supports audited pin, delete, loop-state, and relationship-reset admin operations", async () => {
    let now = 1_800_000_100_000;
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-admin-"));
    directories.push(directory);
    const store = new SocialMemoryStore({ filePath: join(directory, "memory.sqlite"), now: () => now++ });
    stores.push(store);
    store.recordEvent(baseEvent("admin"));

    expect(store.setMemoryPinned("memory-admin", true, "admin-johan", "Important shared moment")).toBe(true);
    expect(store.setMemoryPinned("memory-admin", true, "admin-johan")).toBe(false);
    expect(store.listMemories({ ownerId: "resident-mira" })[0]?.pinned).toBe(true);
    expect(store.setOpenLoopPinned("loop-admin", true, "admin-johan")).toBe(true);
    expect(store.setOpenLoopState("loop-admin", "resolved", "admin-johan", "It was handled")).toBe(true);
    expect(store.listOpenLoops({ ownerId: "resident-mira" })[0]).toMatchObject({
      pinned: true,
      state: "resolved",
    });
    expect(store.resetRelationship("resident-mira", "human-johan", "admin-johan", "Manual clean slate")).toBe(
      true,
    );
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();
    expect(store.deleteMemory("memory-admin", "admin-johan", "User asked us to forget it")).toBe(true);
    expect(store.listMemories({ ownerId: "resident-mira" })).toEqual([]);

    const audit = store.listAudit({ limit: 20 });
    expect(audit.map((entry) => entry.action)).toEqual([
      "memory.delete",
      "relationship.reset",
      "loop.state",
      "loop.pin",
      "memory.pin",
    ]);
    expect(audit.find((entry) => entry.action === "relationship.reset")?.metadata).toEqual({
      ownerId: "resident-mira",
      subjectId: "human-johan",
    });
    expect(audit.find((entry) => entry.action === "memory.pin")?.reason).toBe("Important shared moment");
    expect(audit.find((entry) => entry.action === "memory.delete")?.metadata).toMatchObject({
      ownerId: "resident-mira",
      eventId: "admin",
    });
    expect(audit.find((entry) => entry.action === "loop.state")?.metadata).toMatchObject({
      ownerId: "resident-mira",
      eventId: "admin",
    });
    expect(store.overview()).toMatchObject({
      stats: {
        actors: 3,
        events: 1,
        memories: 0,
        relationships: 0,
        openLoops: 0,
        auditEntries: 5,
      },
      actorIds: ["human-johan", "resident-mira", "resident-sana"],
    });
  });

  it("rejects hallucinated subjects, self-relations, invalid values, and secret-bearing admin reasons", async () => {
    const { store } = await createStore();
    expect(() =>
      store.recordEvent(
        baseEvent("unknown-subject", {
          memoryViews: [
            {
              id: "memory-unknown-subject",
              ownerId: "resident-mira",
              subjectIds: ["person-never-mentioned"],
              perspective: "This subject has no grounding in the event.",
              salience: 0.5,
              confidence: 0.9,
            },
          ],
        }),
      ),
    ).toThrow(/involved/iu);
    expect(() =>
      store.recordEvent(
        baseEvent("self-edge", {
          relationshipDeltas: [
            { ownerId: "resident-mira", subjectId: "resident-mira", warmth: 0.1 },
          ],
        }),
      ),
    ).toThrow(/itself/iu);
    expect(() => store.recordEvent(baseEvent("bad-confidence", { confidence: Number.NaN }))).toThrow(
      /finite|between/iu,
    );
    store.recordEvent(baseEvent("admin-secret"));
    expect(() =>
      store.deleteMemory("memory-admin-secret", "admin-johan", "Bearer abcdefghijklmnopqrstuvwxyz"),
    ).toThrow(/auth tokens|credentials/iu);
    expect(store.listMemories({ ownerId: "resident-mira" })).toHaveLength(1);
  });

  it("rotates recalled memories and debounces retry bookkeeping for ten minutes", async () => {
    let now = 1_800_000_100_000;
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-recall-"));
    directories.push(directory);
    const store = new SocialMemoryStore({ filePath: join(directory, "memory.sqlite"), now: () => now });
    stores.push(store);
    for (const [index, salience] of [0.7, 0.8].entries()) {
      store.recordEvent(baseEvent(`recall-${index}`, {
        occurredAt: now + index,
        memoryViews: [{
          id: `memory-recall-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Distinct recollection ${index}.`,
          salience,
          confidence: 0.9,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }
    now += 10;
    const first = store.listMemories({ ownerId: "resident-mira", limit: 1 })[0]!;
    expect(first.id).toBe("memory-recall-1");
    expect(store.markMemoriesRecalled([first.id], now)).toBe(1);
    const second = store.listMemories({ ownerId: "resident-mira", limit: 1 })[0]!;
    expect(second.id).toBe("memory-recall-0");

    const initialStamp = store.listMemories({ ownerId: "resident-mira", limit: 2 })
      .find((memory) => memory.id === first.id)!;
    expect(store.markMemoriesRecalled([first.id], now + 9 * 60_000)).toBe(0);
    const debounced = store.listMemories({ ownerId: "resident-mira", limit: 2 })
      .find((memory) => memory.id === first.id)!;
    expect(debounced).toMatchObject({ recallCount: 1, lastRecalledAt: initialStamp.lastRecalledAt });
    expect(store.markMemoriesRecalled([first.id], now + 10 * 60_000)).toBe(1);
    expect(store.markMemoriesRecalled(["missing-memory"], now)).toBe(0);
  });

  it("consolidates only an exact privacy bucket with decision-only values and durable provenance", async () => {
    const { store } = await createStore(1_800_000_100_000);
    const dmScope: SocialMemoryScope = {
      kind: "dm",
      threadId: "dm-johan-mira",
      participantIds: ["human-johan", "resident-mira"],
    };
    for (const [id, salience, confidence] of [["first", 0.65, 0.94], ["second", 0.82, 0.88]] as const) {
      store.recordEvent(baseEvent(`consolidate-${id}`, {
        scope: dmScope,
        actorIds: ["human-johan"],
        subjectIds: ["resident-mira"],
        witnessIds: ["resident-mira"],
        memoryViews: [{
          id: `memory-consolidate-${id}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: id === "first" ? "Johan checked in when things were rough." : "Johan checked in again.",
          salience,
          confidence,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }
    store.recordEvent(baseEvent("consolidate-other-thread", {
      scope: { ...dmScope, threadId: "dm-reused-elsewhere" },
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [{
        id: "memory-consolidate-other-thread",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        perspective: "A private memory from another exact thread.",
        salience: 0.5,
        confidence: 0.9,
      }],
      relationshipDeltas: [],
      openLoops: [],
    }));
    const input = {
      id: "consolidated-check-in",
      ownerId: "resident-mira",
      subjectIds: ["human-johan"],
      scope: dmScope,
      sourceMemoryIds: ["memory-consolidate-first", "memory-consolidate-second"],
      perspective: "Johan checked in again.",
      salience: 0.82,
      confidence: 0.88,
      at: 1_800_000_200_000,
    };
    expect(() => store.applyMemoryConsolidation({ ...input, perspective: "Invented synthesis." }))
      .toThrow(/exactly equal/iu);
    expect(() => store.applyMemoryConsolidation({ ...input, salience: 0.81 }))
      .toThrow(/maximum/iu);
    expect(() => store.applyMemoryConsolidation({ ...input, confidence: 0.9 }))
      .toThrow(/minimum/iu);
    expect(() => store.applyMemoryConsolidation({
      ...input,
      sourceMemoryIds: ["memory-consolidate-first", "memory-consolidate-other-thread"],
    })).toThrow(/exact scope/iu);

    const first = store.applyMemoryConsolidation(input);
    expect(first).toMatchObject({
      created: true,
      memory: {
        tier: "consolidated",
        sourceEventIds: ["consolidate-first", "consolidate-second"],
        reinforcedAt: 1_800_000_200_000,
      },
    });
    expect(store.applyMemoryConsolidation(input)).toMatchObject({ created: false });
    expect(() => store.applyMemoryConsolidation({ ...input, perspective: "Johan checked in when things were rough." }))
      .toThrow(/different content/iu);
    expect(store.listMemories({ ownerId: "resident-mira", scope: dmScope }).map((memory) => memory.id))
      .toEqual(["consolidated-check-in"]);
    expect(store.listMemories({ ownerId: "resident-mira", scope: dmScope, includeInactive: true, limit: 50 }))
      .toHaveLength(3);
  });

  it("keeps human and autonomous memories in separate consolidation buckets", async () => {
    const { store } = await createStore(1_800_000_100_000);
    const sourceIds: Record<"human" | "autonomous", string[]> = { human: [], autonomous: [] };
    for (const origin of ["human", "autonomous"] as const) {
      for (let index = 0; index < 2; index += 1) {
        const id = `${origin}-origin-memory-${index}`;
        sourceIds[origin].push(`memory-${id}`);
        store.recordEvent(baseEvent(id, {
          origin,
          actorIds: origin === "human" ? ["human-johan"] : ["resident-sana"],
          subjectIds: ["human-johan"],
          witnessIds: ["resident-mira"],
          memoryViews: [{
            id: `memory-${id}`,
            ownerId: "resident-mira",
            subjectIds: ["human-johan"],
            perspective: `${origin} source wording ${index}.`,
            salience: 0.6,
            confidence: 0.9,
          }],
          relationshipDeltas: [],
          openLoops: [],
        }));
      }
    }

    const batches = store.listConsolidationBatches({ minimum: 2, limit: 2 });
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => [...new Set(batch.memories.map((memory) => memory.event.origin))]))
      .toEqual(expect.arrayContaining([["human"], ["autonomous"]]));
    expect(() => store.applyMemoryConsolidation({
      id: "mixed-origin-consolidation",
      ownerId: "resident-mira",
      subjectIds: ["human-johan"],
      scope: { kind: "public", channelId: "lobby" },
      sourceMemoryIds: [sourceIds.human[0]!, sourceIds.autonomous[0]!],
      perspective: "human source wording 0.",
      salience: 0.6,
      confidence: 0.9,
      at: 1_800_000_200_000,
    })).toThrow(/exact event origin/iu);
  });

  it("provides a bounded deterministic consolidation-bucket offset", async () => {
    const { store } = await createStore();
    for (const [channelId, count] of [["larger-room", 3], ["smaller-room", 2]] as const) {
      for (let index = 0; index < count; index += 1) {
        store.recordEvent(baseEvent(`offset-${channelId}-${index}`, {
          scope: { kind: "public", channelId },
          memoryViews: [{
            id: `memory-offset-${channelId}-${index}`,
            ownerId: "resident-mira",
            subjectIds: ["human-johan"],
            perspective: `Offset candidate ${channelId}-${index}.`,
            salience: 0.6,
            confidence: 0.9,
          }],
          relationshipDeltas: [],
          openLoops: [],
        }));
      }
    }
    expect(store.nextConsolidationBatch({ minimum: 2, limit: 3, offset: 0 })?.scope)
      .toEqual({ kind: "public", channelId: "larger-room" });
    expect(store.nextConsolidationBatch({ minimum: 2, limit: 3, offset: 1 })?.scope)
      .toEqual({ kind: "public", channelId: "smaller-room" });
    expect(store.nextConsolidationBatch({ minimum: 2, limit: 3, offset: 2 })).toBeUndefined();
    expect(() => store.nextConsolidationBatch({ offset: -1 })).toThrow(/between 0 and 2499/iu);
    expect(() => store.nextConsolidationBatch({ offset: 2_500 })).toThrow(/between 0 and 2499/iu);
  });

  it("rejects a multi-generation consolidation when flattened provenance would exceed its hard bound", async () => {
    const { store } = await createStore(1_800_000_100_000);
    const sourceIds: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      store.recordEvent(baseEvent(`provenance-${index}`, {
        memoryViews: [{
          id: `memory-provenance-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Exact source wording ${index}.`,
          salience: 0.6,
          confidence: 0.9,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
      sourceIds.push(`memory-provenance-${index}`);
    }
    const consolidate = (id: string, ids: string[], perspective: string) => store.applyMemoryConsolidation({
      id,
      ownerId: "resident-mira",
      subjectIds: ["human-johan"],
      scope: { kind: "public" as const, channelId: "lobby" },
      sourceMemoryIds: ids,
      perspective,
      salience: 0.6,
      confidence: 0.9,
      at: 1_800_000_200_000,
    });
    consolidate("provenance-group-a", sourceIds.slice(0, 7), "Exact source wording 0.");
    consolidate("provenance-group-b", sourceIds.slice(7), "Exact source wording 7.");
    expect(() => consolidate(
      "provenance-too-wide",
      ["provenance-group-a", "provenance-group-b"],
      "Exact source wording 0.",
    )).toThrow(/at most 12 source events/iu);
  });

  it("forgets a provenance participant after source artifacts were compacted and the store restarted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-provenance-forget-"));
    directories.push(directory);
    const filePath = join(directory, "memory.sqlite");
    const baseNow = 1_800_000_000_000;
    let store = new SocialMemoryStore({ filePath, now: () => baseNow });
    stores.push(store);
    for (const index of [0, 1]) {
      store.recordEvent(baseEvent(`forget-provenance-${index}`, {
        witnessIds: ["human-alex", "resident-mira"],
        memoryViews: [{
          id: `memory-forget-provenance-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Johan shared source detail ${index}.`,
          salience: 0.6,
          confidence: 0.9,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }
    store.applyMemoryConsolidation({
      id: "memory-retained-provenance",
      ownerId: "resident-mira",
      subjectIds: ["human-johan"],
      scope: { kind: "public", channelId: "lobby" },
      sourceMemoryIds: ["memory-forget-provenance-0", "memory-forget-provenance-1"],
      perspective: "Johan shared source detail 0.",
      salience: 0.6,
      confidence: 0.9,
      at: baseNow + 1_000,
    });
    store.runLifecycleMaintenance({ now: baseNow + 31 * DAY_MS });
    expect(store.getEvent("forget-provenance-0")).toBeUndefined();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = new SocialMemoryStore({ filePath, now: () => baseNow + 31 * DAY_MS });
    stores.push(store);
    expect(store.listMemories({ ownerId: "resident-mira" })).toHaveLength(1);
    expect(store.forgetActor("human-alex")).toMatchObject({ memories: 1 });
    expect(store.listMemories({ ownerId: "resident-mira" })).toEqual([]);
  });

  it("keeps pinned and unresolved-loop-backed memories while enforcing episodic bucket caps", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    store.recordEvent(baseEvent("protected-loop", {
      memoryViews: [{
        id: "memory-protected-loop",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        perspective: "A low-salience detail tied to an unresolved promise.",
        salience: 0.1,
        confidence: 0.8,
      }],
      relationshipDeltas: [],
    }));
    store.recordEvent(baseEvent("protected-pin", {
      memoryViews: [{
        id: "memory-protected-pin",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        perspective: "A manually protected detail.",
        salience: 0.1,
        confidence: 0.8,
      }],
      relationshipDeltas: [],
      openLoops: [],
    }));
    expect(store.setMemoryPinned("memory-protected-pin", true, "admin-johan")).toBe(true);
    for (let index = 0; index < 45; index += 1) {
      store.recordEvent(baseEvent(`cap-${index}`, {
        occurredAt: baseNow + index,
        memoryViews: [{
          id: `memory-cap-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Bounded episodic memory ${index}.`,
          salience: 0.5 + index / 1_000,
          confidence: 0.9,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }
    const result = store.runLifecycleMaintenance({ now: baseNow + 60 * DAY_MS });
    const active = store.listMemories({ ownerId: "resident-mira", limit: 50 });
    expect(active).toHaveLength(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveEpisodicPerBucket);
    expect(active.map((memory) => memory.id)).toEqual(expect.arrayContaining([
      "memory-protected-loop",
      "memory-protected-pin",
    ]));
    expect(result.expiredMemories).toBeGreaterThan(0);
    expect(result.protectedOverflow.buckets).toBe(0);
  });

  it("dismisses oldest unpinned open-loop overflow but preserves pinned loops", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    const total = SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsPerOwner + 6;
    for (let index = 0; index < total; index += 1) {
      store.recordEvent(baseEvent(`loop-bound-${index}`, {
        occurredAt: baseNow + index,
        memoryViews: [],
        relationshipDeltas: [],
        openLoops: [{
          id: `bounded-loop-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          kind: "follow_up",
          summary: `Source-bound unfinished thread ${index}.`,
        }],
      }));
    }
    expect(store.setOpenLoopPinned("bounded-loop-0", true, "admin-johan")).toBe(true);
    const result = store.runLifecycleMaintenance({ now: baseNow + 1_000 });
    expect(result.dismissedOpenLoopOverflow).toBe(6);
    expect(store.overview().stats.openLoops).toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsPerOwner);
    expect(store.getOpenLoop("bounded-loop-0")).toMatchObject({ state: "open", pinned: true });
    expect(store.getOpenLoop("bounded-loop-1")?.state).toBe("dismissed");
  });

  it("enforces the global open-loop bound after per-owner bounds", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    const ownerIds = Array.from({ length: 34 }, (_, index) => `resident-loop-owner-${index}`);
    let created = 0;
    let eventIndex = 0;
    while (created < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsGlobal + 1) {
      const batchSize = Math.min(24, SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsGlobal + 1 - created);
      const loops = Array.from({ length: batchSize }, (_, offset) => {
        const loopIndex = created + offset;
        return {
          id: `global-loop-${loopIndex}`,
          ownerId: ownerIds[loopIndex % ownerIds.length]!,
          subjectIds: ["human-johan"],
          kind: "follow_up" as const,
          summary: `Globally bounded open thread ${loopIndex}.`,
        };
      });
      const witnesses = [...new Set(loops.map((loop) => loop.ownerId))];
      store.recordEvent(baseEvent(`global-loop-event-${eventIndex}`, {
        actorIds: ["human-johan"],
        subjectIds: [],
        witnessIds: witnesses,
        memoryViews: [],
        relationshipDeltas: [],
        openLoops: loops,
      }));
      created += batchSize;
      eventIndex += 1;
    }
    expect(store.setOpenLoopPinned("global-loop-0", true, "admin-johan")).toBe(true);
    const result = store.runLifecycleMaintenance({ now: baseNow + 1_000 });
    expect(result.dismissedOpenLoopOverflow).toBe(1);
    expect(store.overview().stats.openLoops).toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsGlobal);
    expect(store.getOpenLoop("global-loop-0")).toMatchObject({ state: "open", pinned: true });
  });

  it("dismisses autonomous loop churn before a sparse human-origin promise", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    store.recordEvent(baseEvent("human-loop-reserve", {
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [{
        id: "human-loop-reserve",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        kind: "promise",
        summary: "Johan promised to return with an answer.",
      }],
    }));
    for (let index = 0; index < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsPerOwner; index += 1) {
      store.recordEvent(baseEvent(`autonomous-loop-churn-${index}`, {
        origin: "autonomous",
        occurredAt: baseNow + index + 1,
        actorIds: ["resident-sana"],
        subjectIds: ["resident-mira"],
        witnessIds: ["resident-mira"],
        memoryViews: [],
        relationshipDeltas: [],
        openLoops: [{
          id: `autonomous-loop-churn-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["resident-sana"],
          kind: "follow_up",
          summary: `Autonomous follow-up ${index}.`,
        }],
      }));
    }

    const maintenance = store.runLifecycleMaintenance({ now: baseNow + 1_000 });
    expect(maintenance.dismissedOpenLoopOverflow).toBe(1);
    expect(store.getOpenLoop("human-loop-reserve")?.state).toBe("open");
    expect(store.getOpenLoop("autonomous-loop-churn-0")?.state).toBe("dismissed");
  });

  it("rejects open-loop pins beyond the per-owner protection cap", async () => {
    const { store } = await createStore();
    const count = SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedOpenLoopsPerOwner + 1;
    for (let index = 0; index < count; index += 1) {
      store.recordEvent(baseEvent(`pin-loop-cap-${index}`, {
        memoryViews: [],
        relationshipDeltas: [],
        openLoops: [{
          id: `pin-loop-cap-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          kind: "follow_up",
          summary: `Pinnable source-bound loop ${index}.`,
        }],
      }));
    }
    for (let index = 0; index < count - 1; index += 1) {
      expect(store.setOpenLoopPinned(`pin-loop-cap-${index}`, true, "admin-johan")).toBe(true);
    }
    expect(() => store.setOpenLoopPinned(`pin-loop-cap-${count - 1}`, true, "admin-johan"))
      .toThrow(/pin limit/iu);
  });

  it("enforces per-owner and global active-memory safety caps independently of bucket shape", async () => {
    const baseNow = 1_800_000_000_000;
    const { store: ownerStore } = await createStore(baseNow);
    for (let index = 0; index < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActivePerOwner + 1; index += 1) {
      ownerStore.recordEvent(baseEvent(`owner-cap-${index}`, {
        scope: { kind: "public", channelId: `owner-cap-room-${index}` },
        memoryViews: [{
          id: `memory-owner-cap-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Owner-wide bounded memory ${index}.`,
          salience: 0.6,
          confidence: 0.9,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }
    ownerStore.runLifecycleMaintenance({ now: baseNow + 1_000 });
    expect(ownerStore.lifecycleStats().activeEpisodic)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActivePerOwner);

    const { store: globalStore } = await createStore(baseNow);
    const owners = Array.from({ length: 9 }, (_, index) => `resident-global-owner-${index}`);
    let memoryCount = 0;
    let eventIndex = 0;
    while (memoryCount < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveGlobal + 1) {
      const eventViews = owners
        .slice(0, SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveGlobal + 1 - memoryCount)
        .map((ownerId, ownerIndex) => ({
          id: `memory-global-cap-${eventIndex}-${ownerIndex}`,
          ownerId,
          subjectIds: ["human-johan"],
          perspective: `Globally bounded memory ${eventIndex}-${ownerIndex}.`,
          salience: 0.6,
          confidence: 0.9,
        }));
      globalStore.recordEvent(baseEvent(`global-cap-${eventIndex}`, {
        scope: { kind: "public", channelId: `global-cap-room-${eventIndex}` },
        actorIds: ["human-johan"],
        subjectIds: [],
        witnessIds: eventViews.map((view) => view.ownerId),
        memoryViews: eventViews,
        relationshipDeltas: [],
        openLoops: [],
      }));
      memoryCount += eventViews.length;
      eventIndex += 1;
    }
    globalStore.runLifecycleMaintenance({ now: baseNow + 1_000 });
    expect(globalStore.lifecycleStats().activeEpisodic)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveGlobal);
  });

  it("expires autonomous recollection churn before the only human-origin memory", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    store.recordEvent(baseEvent("human-memory-reserve", {
      scope: { kind: "public", channelId: "human-memory-room" },
      memoryViews: [{
        id: "memory-human-reserve",
        ownerId: "resident-mira",
        subjectIds: ["human-johan"],
        perspective: "Johan once shared a quiet but personally meaningful detail.",
        salience: 0.1,
        confidence: 0.8,
      }],
      relationshipDeltas: [],
      openLoops: [],
    }));
    for (let index = 0; index < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActivePerOwner; index += 1) {
      store.recordEvent(baseEvent(`autonomous-memory-churn-${index}`, {
        origin: "autonomous",
        scope: { kind: "public", channelId: `autonomous-memory-room-${index}` },
        occurredAt: baseNow + index + 1,
        actorIds: ["resident-sana"],
        subjectIds: ["human-johan"],
        witnessIds: ["resident-mira"],
        memoryViews: [{
          id: `memory-autonomous-churn-${index}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `Autonomous high-salience recollection ${index}.`,
          salience: 0.95,
          confidence: 0.99,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }

    store.runLifecycleMaintenance({ now: baseNow + 10_000 });
    expect(store.listMemories({
      ownerId: "resident-mira",
      scope: { kind: "public", channelId: "human-memory-room" },
      limit: 1,
    }).map((memory) => memory.id)).toEqual(["memory-human-reserve"]);
    expect(store.lifecycleStats().activeEpisodic)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActivePerOwner);
  });

  it("does not turn repeated recall into reinforcement", async () => {
    let now = 1_800_000_100_000;
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-novelty-"));
    directories.push(directory);
    const store = new SocialMemoryStore({ filePath: join(directory, "memory.sqlite"), now: () => now });
    stores.push(store);
    for (const [id, salience] of [["lower", 0.55], ["higher", 0.7]] as const) {
      store.recordEvent(baseEvent(`novelty-${id}`, {
        memoryViews: [{
          id: `memory-novelty-${id}`,
          ownerId: "resident-mira",
          subjectIds: ["human-johan"],
          perspective: `${id} source-bound relevance.`,
          salience,
          confidence: 0.9,
        }],
        relationshipDeltas: [],
        openLoops: [],
      }));
    }
    for (let index = 0; index < 20; index += 1) {
      store.markMemoriesRecalled(["memory-novelty-lower"], now + index * 10 * 60_000);
    }
    now += 20 * 10 * 60_000 + SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.recallCooldownMs;
    expect(store.listMemories({ ownerId: "resident-mira", limit: 1 })[0]?.id)
      .toBe("memory-novelty-higher");
  });

  it("checkpoints safe old relationship provenance without changing the current edge", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    store.recordEvent(baseEvent("checkpoint-safe", {
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira"],
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 0.12 }],
      openLoops: [],
    }));
    store.recordEvent(baseEvent("checkpoint-third-party", {
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira", "resident-sana"],
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 0.06 }],
      openLoops: [],
    }));
    const before = store.getRelationship("resident-mira", "human-johan");
    const maintenance = store.runLifecycleMaintenance({ now: baseNow + 100 * DAY_MS });
    expect(maintenance.checkpointedRelationshipChanges).toBe(2);
    expect(store.getRelationship("resident-mira", "human-johan")).toEqual(before);
    expect(store.getEvent("checkpoint-safe")).toBeUndefined();
    expect(store.getEvent("checkpoint-third-party")).toBeUndefined();
    store.forgetActor("resident-sana");
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.12);
    store.forgetActor("human-johan");
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();
  });

  it("retains absolute daily spend after checkpointing so late events cannot reopen a spent day", async () => {
    let now = 1_800_000_000_000;
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-daily-spend-"));
    directories.push(directory);
    const store = new SocialMemoryStore({ filePath: join(directory, "memory.sqlite"), now: () => now });
    stores.push(store);
    store.recordEvent(baseEvent("spent-before-checkpoint", {
      occurredAt: now,
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 1 }],
      openLoops: [],
    }));
    now += 100 * DAY_MS;
    store.runLifecycleMaintenance({ now });

    const late = store.recordEvent(baseEvent("late-same-day", {
      occurredAt: 1_800_000_000_000 + 1_000,
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 1 }],
      openLoops: [],
    }));
    expect(late.appliedRelationshipDeltas[0]?.warmth).toBe(0);
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.18);
  });

  it("never uses one oversized autonomous correction after actor erasure changes surviving provenance", async () => {
    const baseNow = 1_800_000_000_000;
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-envelope-"));
    directories.push(directory);
    const store = new SocialMemoryStore({
      filePath: join(directory, "memory.sqlite"),
      now: () => baseNow + 10 * DAY_MS,
      autonomousDailyCaps: { warmth: 1 },
    });
    stores.push(store);
    const autonomous = (
      id: string,
      day: number,
      warmth: number,
      witnessIds: string[] = [],
    ): RecordSocialEventInput => baseEvent(id, {
      origin: "autonomous",
      occurredAt: baseNow + day * DAY_MS,
      actorIds: ["resident-mira"],
      subjectIds: ["resident-sana"],
      witnessIds,
      memoryViews: [],
      relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "resident-sana", warmth }],
      openLoops: [],
    });
    store.recordEvent(autonomous("envelope-positive-one", 0, 1));
    store.recordEvent(autonomous("envelope-negative-witnessed", 1, -1, ["human-johan"]));
    store.recordEvent(autonomous("envelope-positive-two", 2, 1));
    store.forgetActor("human-johan");

    const afterForget = store.recordEvent(autonomous("envelope-next-positive", 3, 1));
    expect(afterForget.appliedRelationshipDeltas[0]?.warmth).toBe(0);
    expect(store.getRelationship("resident-mira", "resident-sana")?.warmth).toBeCloseTo(0.3);
  });

  it("bounds relationship checkpoints per pair and expires their contribution with provenance", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    for (let index = 0; index < 140; index += 1) {
      store.recordEvent(baseEvent(`checkpoint-bound-${index}`, {
        occurredAt: baseNow + index * DAY_MS,
        actorIds: ["resident-mira"],
        subjectIds: ["human-johan"],
        witnessIds: [`observer-${index}`],
        memoryViews: [],
        relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 0.001 }],
        openLoops: [],
      }));
    }
    const bounded = store.runLifecycleMaintenance({ now: baseNow + 250 * DAY_MS });
    expect(bounded.prunedRelationshipCheckpoints).toBe(12);
    expect(store.lifecycleStats().relationshipCheckpoints)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpointsPerPair);
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.128);

    store.forgetActor("observer-139");
    expect(store.lifecycleStats().relationshipCheckpoints).toBe(127);
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.127);

    const expired = store.runLifecycleMaintenance({ now: baseNow + 900 * DAY_MS });
    expect(expired.prunedRelationshipCheckpoints).toBe(127);
    expect(store.lifecycleStats().relationshipCheckpoints).toBe(0);
    expect(store.getRelationship("resident-mira", "human-johan")).toBeUndefined();
  });

  it("prunes autonomous relationship checkpoints before older human-origin evidence", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    store.recordEvent(baseEvent("human-checkpoint-reserve", {
      occurredAt: baseNow,
      actorIds: ["human-johan"],
      subjectIds: ["resident-mira"],
      witnessIds: ["resident-mira", "human-witness"],
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        warmth: 1,
      }],
      openLoops: [],
    }));
    for (let index = 0; index < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpointsPerPair; index += 1) {
      store.recordEvent(baseEvent(`autonomous-checkpoint-churn-${index}`, {
        origin: "autonomous",
        occurredAt: baseNow + (index + 1) * DAY_MS,
        actorIds: ["resident-sana"],
        subjectIds: ["human-johan"],
        witnessIds: ["resident-mira", `autonomous-observer-${index}`],
        memoryViews: [],
        relationshipDeltas: [{
          ownerId: "resident-mira",
          subjectId: "human-johan",
          warmth: 0.001,
        }],
        openLoops: [],
      }));
    }

    const maintenance = store.runLifecycleMaintenance({ now: baseNow + 250 * DAY_MS });
    expect(maintenance.prunedRelationshipCheckpoints).toBe(1);
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.307);
    store.forgetActor("human-witness");
    expect(store.getRelationship("resident-mira", "human-johan")?.warmth).toBeCloseTo(0.127);
  });

  it("does not reopen a spent day after its signed checkpoint is pruned", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    for (let index = 0; index <= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpointsPerPair; index += 1) {
      store.recordEvent(baseEvent(`checkpoint-spend-${index}`, {
        occurredAt: baseNow + index * DAY_MS,
        actorIds: ["resident-mira"],
        subjectIds: ["human-johan"],
        witnessIds: [`observer-${index}`],
        memoryViews: [],
        relationshipDeltas: [{
          ownerId: "resident-mira",
          subjectId: "human-johan",
          familiarity: 0.001,
          warmth: index === 0 ? 1 : 0,
        }],
        openLoops: [],
      }));
    }

    const maintenance = store.runLifecycleMaintenance({ now: baseNow + 250 * DAY_MS });
    expect(maintenance.checkpointedRelationshipChanges)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpointsPerPair + 1);
    expect(maintenance.prunedRelationshipCheckpoints).toBe(1);
    expect(store.lifecycleStats().relationshipDailyBudgets)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpointsPerPair + 1);

    const replayedDay = store.recordEvent(baseEvent("checkpoint-spend-replay", {
      occurredAt: baseNow + 1_000,
      memoryViews: [],
      relationshipDeltas: [{
        ownerId: "resident-mira",
        subjectId: "human-johan",
        warmth: 1,
      }],
      openLoops: [],
    }));
    expect(replayedDay.appliedRelationshipDeltas[0]?.warmth).toBe(0);
  });

  it("checkpoints recent relationship provenance early at the per-owner hard ceiling", async () => {
    const baseNow = 1_800_000_000_000;
    const { store } = await createStore(baseNow);
    for (let index = 0; index <= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipChangesPerOwner; index += 1) {
      store.recordEvent(baseEvent(`recent-provenance-${index}`, {
        occurredAt: baseNow + index,
        memoryViews: [],
        relationshipDeltas: [{ ownerId: "resident-mira", subjectId: "human-johan", warmth: 0.001 }],
        openLoops: [],
      }));
    }
    const maintenance = store.runLifecycleMaintenance({ now: baseNow + 2_000 });
    expect(maintenance.checkpointedRelationshipChanges).toBe(1);
    expect(store.lifecycleStats().relationshipChanges)
      .toBe(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipChangesPerOwner);
    expect(store.lifecycleStats().relationshipCheckpoints).toBe(1);
  });

  it("dismisses a source loop at its bounded update limit and rejects further continuation", async () => {
    const { store } = await createStore();
    store.recordEvent(baseEvent("bounded-loop-root", {
      memoryViews: [],
      relationshipDeltas: [],
    }));
    for (let index = 0; index < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxUpdatesPerOpenLoop; index += 1) {
      store.recordEvent(baseEvent(`bounded-loop-update-${index}`, {
        occurredAt: 1_800_000_000_100 + index,
        memoryViews: [],
        relationshipDeltas: [],
        openLoops: [],
        openLoopUpdates: [{
          id: "loop-bounded-loop-root",
          state: "open",
          summary: `Bounded continuation ${index}.`,
        }],
      }));
    }
    expect(store.getOpenLoop("loop-bounded-loop-root")?.state).toBe("dismissed");
    expect(() => store.recordEvent(baseEvent("bounded-loop-overflow", {
      memoryViews: [],
      relationshipDeltas: [],
      openLoops: [],
      openLoopUpdates: [{ id: "loop-bounded-loop-root", state: "open" }],
    }))).toThrow(/no longer open|update limit/iu);
  });

  it("remains bounded across years of deterministic maintenance", async () => {
    let now = 1_800_000_000_000;
    const directory = await mkdtemp(join(tmpdir(), "third-place-social-memory-long-run-"));
    directories.push(directory);
    const store = new SocialMemoryStore({ filePath: join(directory, "memory.sqlite"), now: () => now });
    stores.push(store);
    for (let cycle = 0; cycle < 120; cycle += 1) {
      for (let index = 0; index < 8; index += 1) {
        store.recordEvent(baseEvent(`long-${cycle}-${index}`, {
          occurredAt: now + index,
          memoryViews: [{
            id: `memory-long-${cycle}-${index}`,
            ownerId: "resident-mira",
            subjectIds: ["human-johan"],
            perspective: `Long-running bounded memory ${cycle}-${index}.`,
            salience: 0.5,
            confidence: 0.9,
          }],
          relationshipDeltas: [],
          openLoops: [],
        }));
      }
      store.runLifecycleMaintenance({ now });
      now += 7 * DAY_MS;
    }
    store.runLifecycleMaintenance({ now });
    expect(store.lifecycleStats().activeEpisodic)
      .toBeLessThanOrEqual(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveEpisodicPerBucket);
    expect(store.overview().stats.memories)
      .toBeLessThanOrEqual(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveEpisodicPerBucket);
    expect(store.overview().stats.events).toBeLessThan(100);
  });
});
