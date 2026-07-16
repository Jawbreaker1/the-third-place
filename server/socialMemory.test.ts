import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SocialMemoryStore,
  type RecordSocialEventInput,
  type SocialMemoryScope,
} from "./socialMemory.js";

const stores: SocialMemoryStore[] = [];
const directories: string[] = [];

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
  it("migrates a new database, enables WAL/foreign keys, and survives restart", async () => {
    const { store, filePath } = await createStore();
    expect(store.status()).toEqual({ schemaVersion: 2, journalMode: "wal", foreignKeys: true });
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

    expect(() =>
      store.recordEvent(
        baseEvent("wrong-scope-loop-update", {
          scope: { kind: "public", channelId: "the-pub" },
          memoryViews: [],
          relationshipDeltas: [],
          openLoops: [],
          openLoopUpdates: [{ id: "loop-loop-created", state: "open" }],
        }),
      ),
    ).toThrow(/different scope/iu);
    expect(store.getEvent("wrong-scope-loop-update")).toBeUndefined();
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
});
