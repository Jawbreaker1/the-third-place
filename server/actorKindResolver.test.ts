import { describe, expect, it } from "vitest";
import { createLiveActorKindResolver } from "./actorKindResolver.js";
import { SocialMemoryStore, type RecordSocialEventInput } from "./socialMemory.js";

const relationshipEvent = (
  ownerId: string,
  subjectId: string,
): RecordSocialEventInput => ({
  id: "late-resident-pair",
  kind: "shared_moment",
  origin: "human",
  scope: { kind: "public", channelId: "lobby" },
  sourceMessageIds: ["message-late-resident-pair"],
  actorIds: ["human-johan"],
  subjectIds: [ownerId, subjectId],
  witnessIds: [ownerId],
  occurredAt: 1_800_000_000_000,
  summary: "Two residents continued a human-started conversation.",
  salience: 0.6,
  confidence: 0.9,
  memoryViews: [],
  relationshipDeltas: [{ ownerId, subjectId, warmth: 1, romanticInterest: 1 }],
  openLoops: [],
});

describe("live trusted actor-kind resolver", () => {
  it("observes resident and human registry changes made after resolver creation", () => {
    const residents = new Set(["ai-existing"]);
    const humans = new Set(["human-existing"]);
    const resolveActorKind = createLiveActorKindResolver({
      isResident: (actorId) => residents.has(actorId),
      isHuman: (actorId) => humans.has(actorId),
    });

    expect(resolveActorKind("ai-custom")).toBeUndefined();
    expect(resolveActorKind("human-late")).toBeUndefined();

    residents.add("ai-custom");
    humans.add("human-late");
    expect(resolveActorKind("ai-custom")).toBe("resident");
    expect(resolveActorKind("human-late")).toBe("human");

    residents.delete("ai-custom");
    expect(resolveActorKind("ai-custom")).toBeUndefined();
  });

  it("gives residents added after store construction the autonomous pair budget", () => {
    const residents = new Set<string>();
    const resolveActorKind = createLiveActorKindResolver({
      isResident: (actorId) => residents.has(actorId),
      isHuman: (actorId) => actorId === "human-johan",
    });
    const store = new SocialMemoryStore({ filePath: ":memory:", resolveActorKind });

    try {
      // This is the production ordering: SocialMemoryStore exists before the
      // persisted admin catalog is loaded and materialized into PERSONAS.
      residents.add("ai-persisted-one");
      residents.add("ai-persisted-two");

      const result = store.recordEvent(relationshipEvent("ai-persisted-one", "ai-persisted-two"));
      expect(result.appliedRelationshipDeltas[0]).toMatchObject({
        origin: "autonomous",
        warmth: 0.008,
        romanticInterest: 0.01,
      });
    } finally {
      store.close();
    }
  });
});
