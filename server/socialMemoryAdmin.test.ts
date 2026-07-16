import { afterEach, describe, expect, it } from "vitest";
import { SocialMemoryStore, type RecordSocialEventInput } from "./socialMemory.js";
import { SocialMemoryAdmin, type SocialMemoryAdminActor } from "./socialMemoryAdmin.js";

const stores: SocialMemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const createStore = (now = Date.UTC(2026, 6, 16, 12)): SocialMemoryStore => {
  const store = new SocialMemoryStore({ filePath: ":memory:", now: () => now });
  stores.push(store);
  return store;
};

const actors: SocialMemoryAdminActor[] = [
  { id: "ai-mira", name: "Mira", kind: "resident" },
  { id: "human-johan", name: "Johan", kind: "human" },
];

const firstEvent = (): RecordSocialEventInput => ({
  id: "event-kindness",
  kind: "support",
  origin: "human",
  scope: { kind: "public", channelId: "lobby" },
  sourceMessageIds: ["message-2", "message-1"],
  actorIds: ["human-johan"],
  subjectIds: ["ai-mira"],
  witnessIds: ["ai-mira"],
  occurredAt: Date.UTC(2026, 6, 16, 10),
  summary: "Johan stayed to help Mira finish a difficult task.",
  salience: 0.8,
  confidence: 0.95,
  memoryViews: [
    {
      id: "memory-mira-help",
      ownerId: "ai-mira",
      subjectIds: ["human-johan"],
      perspective: "Johan was patient when I needed help.",
      salience: 0.82,
      confidence: 0.94,
    },
  ],
  relationshipDeltas: [
    {
      ownerId: "ai-mira",
      subjectId: "human-johan",
      familiarity: 0.08,
      warmth: 0.12,
      trust: 0.09,
      respect: 0.06,
    },
  ],
  openLoops: [
    {
      id: "loop-mira-follow-up",
      ownerId: "ai-mira",
      subjectIds: ["human-johan"],
      kind: "follow_up",
      summary: "Ask Johan whether the task worked out.",
    },
  ],
});

const reciprocalEvent = (): RecordSocialEventInput => ({
  id: "event-friction",
  kind: "conflict",
  origin: "human",
  scope: { kind: "public", channelId: "lobby" },
  sourceMessageIds: ["message-3"],
  actorIds: ["ai-mira"],
  subjectIds: ["human-johan"],
  witnessIds: ["human-johan"],
  occurredAt: Date.UTC(2026, 6, 16, 11),
  summary: "Mira and Johan disagreed about how to proceed.",
  salience: 0.5,
  confidence: 0.9,
  relationshipDeltas: [
    {
      ownerId: "human-johan",
      subjectId: "ai-mira",
      familiarity: 0.02,
      warmth: -0.04,
      trust: -0.03,
      friction: 0.1,
    },
  ],
});

describe("social-memory admin projection", () => {
  it("keeps directed relationships asymmetric and flattens source provenance", () => {
    const store = createStore();
    store.recordEvent(firstEvent());
    store.recordEvent(reciprocalEvent());
    const admin = new SocialMemoryAdmin({ store, getActors: () => actors });

    const overview = admin.getOverview();
    expect(overview.stats).toEqual({
      actors: 2,
      memories: 1,
      relationships: 2,
      openLoops: 1,
      auditEntries: 0,
    });
    expect(overview.actors.find((actor) => actor.id === "ai-mira")).toMatchObject({
      memoryCount: 1,
      outgoingRelationshipCount: 1,
      incomingRelationshipCount: 1,
      openLoopCount: 1,
      lastActivityAt: new Date(Date.UTC(2026, 6, 16, 11)).toISOString(),
    });

    const detail = admin.getActorDetail("ai-mira");
    expect(detail).toBeDefined();
    expect(detail?.ownedMemories).toEqual([
      expect.objectContaining({
        id: "memory-mira-help",
        kind: "support",
        scope: "public:lobby",
        summary: "Johan stayed to help Mira finish a difficult task.",
        sourceEventIds: ["event-kindness"],
        sourceMessageIds: ["message-1", "message-2"],
      }),
    ]);
    expect(detail?.outgoingRelationships[0]).toMatchObject({
      ownerId: "ai-mira",
      subjectId: "human-johan",
      ownerName: "Mira",
      subjectName: "Johan",
      warmth: 0.12,
      friction: 0,
    });
    expect(detail?.incomingRelationships[0]).toMatchObject({
      ownerId: "human-johan",
      subjectId: "ai-mira",
      ownerName: "Johan",
      subjectName: "Mira",
      warmth: -0.04,
      friction: 0.1,
    });
    expect(detail?.openLoops[0]).toMatchObject({
      id: "loop-mira-follow-up",
      status: "open",
      sourceEventIds: ["event-kindness"],
      sourceMessageIds: ["message-1", "message-2"],
    });
  });

  it("records mutations as local-admin audit without exposing store metadata", () => {
    const store = createStore();
    store.recordEvent(firstEvent());
    const admin = new SocialMemoryAdmin({ store, getActors: () => actors });

    expect(admin.setMemoryPinned("missing-memory", true)).toBe(false);
    expect(admin.deleteMemory("missing-memory")).toBe(false);
    expect(admin.resetRelationship("ai-mira", "missing-human")).toBe(false);
    expect(admin.setMemoryPinned("memory-mira-help", true)).toBe(true);

    const detail = admin.getActorDetail("ai-mira");
    expect(detail?.ownedMemories[0]?.pinned).toBe(true);
    expect(detail?.audit[0]).toEqual({
      id: "1",
      actorId: "ai-mira",
      action: "memory.pin",
      entityType: "memory",
      entityId: "memory-mira-help",
      summary: "memory pin",
      sourceEventIds: ["event-kindness"],
      sourceMessageIds: ["message-1", "message-2"],
      createdAt: new Date(Date.UTC(2026, 6, 16, 12)).toISOString(),
    });
    expect(Object.keys(detail?.audit[0] ?? {})).not.toContain("metadata");

    expect(admin.deleteMemory("memory-mira-help")).toBe(true);
    const afterDelete = admin.getActorDetail("ai-mira");
    expect(afterDelete?.ownedMemories).toEqual([]);
    expect(afterDelete?.audit[0]).toMatchObject({
      actorId: "ai-mira",
      action: "memory.delete",
      sourceEventIds: ["event-kindness"],
      sourceMessageIds: ["message-1", "message-2"],
    });
  });

  it("returns an empty overview and a 404-friendly result for an unknown actor", () => {
    const store = createStore();
    const admin = new SocialMemoryAdmin({ store, getActors: () => [] });

    expect(admin.getOverview()).toEqual({
      stats: { actors: 0, memories: 0, relationships: 0, openLoops: 0, auditEntries: 0 },
      actors: [],
    });
    expect(admin.getActorDetail("unknown-actor")).toBeUndefined();
    expect(admin.getActorDetail("\u0000unsafe")).toBeUndefined();
  });

  it("keeps historical relationship actors visible after they leave the live catalog", () => {
    const store = createStore();
    store.recordEvent(firstEvent());
    const admin = new SocialMemoryAdmin({
      store,
      getActors: () => [{ id: "ai-mira", name: "Mira", kind: "resident" }],
    });

    const overview = admin.getOverview();
    expect(overview.actors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "human-johan", name: "human-johan", kind: "human" }),
      ]),
    );
    expect(admin.getActorDetail("human-johan")?.incomingRelationships[0]).toMatchObject({
      ownerId: "ai-mira",
      subjectId: "human-johan",
    });
  });
});
