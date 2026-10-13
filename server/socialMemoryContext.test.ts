import { afterEach, describe, expect, it, vi } from "vitest";
import { SocialMemoryStore, type OpenLoopInput, type SocialMemoryScope } from "./socialMemory.js";
import { SocialMemoryCoordinator } from "./socialMemoryCoordinator.js";
import { MAX_SOCIAL_MEMORY_NOTE_CHARS } from "./socialMemoryProjection.js";

const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const EVENT_AT = Date.parse("2026-10-01T18:30:00.000Z");
const PUBLIC = { kind: "public", channelId: "lobby" } as const;
const PRIVATE = { kind: "dm", threadId: "dm-johan-mira", participantIds: ["human-johan", "resident-mira"] } as const;
const THIRD_PARTY_DM = {
  kind: "dm",
  threadId: "dm-alex-mira",
  participantIds: ["human-alex", "resident-mira"],
} satisfies SocialMemoryScope;
const stores: SocialMemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const setup = () => {
  const store = new SocialMemoryStore({ filePath: ":memory:", now: () => NOW });
  stores.push(store);
  const coordinator = new SocialMemoryCoordinator({
    analyzeSocialEpisode: async () => ({ source: "lm", failureReason: null, events: [] }),
  }, store);
  return { store, coordinator };
};

const record = (
  store: SocialMemoryStore,
  id: string,
  perspective: string,
  scope: SocialMemoryScope = PUBLIC,
  openLoops: OpenLoopInput[] = [],
) => store.recordEvent({
  id: `event-${id}`,
  kind: "personal_disclosure",
  origin: "human",
  scope,
  sourceMessageIds: [`message-${id}`],
  actorIds: ["human-johan"],
  subjectIds: ["human-johan"],
  witnessIds: ["resident-mira"],
  occurredAt: EVENT_AT,
  summary: `RAW SUMMARY ${id}`,
  salience: 0.75,
  confidence: 0.99,
  memoryViews: [{
    id: `memory-${id}`,
    ownerId: "resident-mira",
    subjectIds: ["human-johan"],
    perspective,
    salience: 0.75,
    confidence: 0.98,
  }],
  openLoops,
});

const pending = (id: string, summary: string): OpenLoopInput => ({
  id,
  ownerId: "resident-mira",
  subjectIds: ["human-johan"],
  kind: "follow_up",
  summary,
  dueAt: Date.parse("2026-10-14T17:00:00.000Z"),
});

interface ContextData {
  subjectiveRecollections?: Array<{ perspective: string; occurredAt?: string; timeBasis: string }>;
  subjectivePublicRecollections?: Array<{ perspective: string; occurredAt?: string; timeBasis: string }>;
  openLoop?: Record<string, unknown>;
  publicOpenLoop?: Record<string, unknown>;
  directedRelationship?: Record<string, unknown>;
}

const dataFrom = (note: string): ContextData => JSON.parse(note.slice(note.lastIndexOf("\n") + 1));

const recordThirdParty = (
  store: SocialMemoryStore,
  id: string,
  scope: SocialMemoryScope,
  options: { ownerId?: string; subjectId?: string; sourceActorId?: string; perspective?: string; openLoop?: string } = {},
) => {
  const ownerId = options.ownerId ?? "resident-mira";
  const subjectId = options.subjectId ?? "human-johan";
  return store.recordEvent({
    id: `third-party-event-${id}`,
    kind: "personal_disclosure",
    origin: "human",
    scope,
    sourceMessageIds: [`third-party-message-${id}`],
    actorIds: [options.sourceActorId ?? (scope.kind === "public" ? subjectId : scope.participantIds[0]!)],
    subjectIds: [subjectId],
    witnessIds: [ownerId],
    occurredAt: NOW - 60_000,
    summary: `RAW THIRD-PARTY EVENT ${id}`,
    salience: 0.95,
    confidence: 0.99,
    memoryViews: [{
      id: `third-party-memory-${id}`,
      ownerId,
      subjectIds: [subjectId],
      perspective: options.perspective ?? id,
      salience: 0.95,
      confidence: 0.99,
    }],
    relationshipDeltas: [{ ownerId, subjectId, trust: 0.1, warmth: 0.1 }],
    openLoops: options.openLoop ? [{
      id: `third-party-loop-${id}`,
      ownerId,
      subjectIds: [subjectId],
      kind: "follow_up",
      summary: options.openLoop,
    }] : [],
  });
};

describe("public-only third-party recollections delivered in a DM", () => {
  it("discovers only the owner's public-memory subject IDs without recalling any content", () => {
    const { store, coordinator } = setup();
    recordThirdParty(store, "public-catalog", PUBLIC);
    recordThirdParty(store, "another-public-catalog", { kind: "public", channelId: "another-room" });
    recordThirdParty(store, "private-catalog", THIRD_PARTY_DM, { subjectId: "human-private-only" });
    recordThirdParty(store, "other-owner-catalog", PUBLIC, { ownerId: "resident-sana", subjectId: "human-other-owner" });
    const relationshipRead = vi.spyOn(store, "getRelationship");

    expect(coordinator.publicMemorySubjectIds("resident-mira")).toEqual(["human-johan"]);
    expect(coordinator.publicMemorySubjectIds("resident-unknown")).toEqual([]);
    expect(store.lifecycleStats().recalled).toBe(0);
    expect(relationshipRead).not.toHaveBeenCalled();
  });

  it("recalls the owner's fresh public memory across rooms without requiring the subject in the DM", () => {
    const { store, coordinator } = setup();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    recordThirdParty(store, "fresh", { kind: "public", channelId: "hobbies" }, {
      perspective: "Johan and I just compared our old game collections in the public hobbies room.",
    });

    const note = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)!;
    expect(dataFrom(note).subjectivePublicRecollections).toEqual([expect.objectContaining({
      perspective: "Johan and I just compared our old game collections in the public hobbies room.",
      occurredAt: "2026-10-12T07:59:00.000Z",
      timeBasis: "event",
    })]);
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", PUBLIC)).toBe(note);
  });

  it("excludes even matching-DM memories, other DMs, voice, private open loops and aggregate relationships", () => {
    const { store, coordinator } = setup();
    const privateScopes: SocialMemoryScope[] = [
      THIRD_PARTY_DM,
      { kind: "dm", threadId: "another-dm", participantIds: ["human-johan", "resident-mira"] },
      { kind: "voice", roomId: "old-voice", participantIds: ["human-johan", "resident-mira"] },
    ];
    for (const [index, scope] of privateScopes.entries()) {
      for (let turn = 0; turn < 3; turn += 1) {
        recordThirdParty(store, `SECRET-${index}-${turn}`, scope, { openLoop: `SECRET FOLLOWUP ${index}-${turn}` });
      }
    }
    recordThirdParty(store, "public", PUBLIC, {
      perspective: "We discussed collecting old games in the public room.",
      openLoop: "I offered to compare our public collection lists.",
    });
    expect(store.getRelationship("resident-mira", "human-johan")).toBeDefined();
    const relationshipRead = vi.spyOn(store, "getRelationship");

    const note = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)!;
    const data = dataFrom(note);
    expect(data.subjectivePublicRecollections).toHaveLength(1);
    expect(data.publicOpenLoop?.summary).toBe("I offered to compare our public collection lists.");
    expect(note).not.toContain("SECRET");
    expect(note).not.toContain("RAW THIRD-PARTY");
    expect(data.directedRelationship).toBeUndefined();
    expect(data.openLoop).toBeUndefined();
    expect(relationshipRead).not.toHaveBeenCalled();
  });

  it("does not turn a private-only relationship or private open loop into public evidence", () => {
    const { store, coordinator } = setup();
    recordThirdParty(store, "SECRET-ONLY", THIRD_PARTY_DM, { openLoop: "SECRET PENDING MATTER" });
    expect(store.getRelationship("resident-mira", "human-johan")).toBeDefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
  });

  it("keeps the exact owner's perspective and exact subject rather than borrowing another resident's memories", () => {
    const { store, coordinator } = setup();
    recordThirdParty(store, "Sana-only", PUBLIC, { ownerId: "resident-sana" });
    recordThirdParty(store, "Different-subject", PUBLIC, { subjectId: "human-other" });
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-sana", "human-johan", {
      ...THIRD_PARTY_DM,
      participantIds: ["human-alex", "resident-sana"],
    })).toContain("Sana-only");
    // Knowing the owner ID alone does not authorize inserting their recollections
    // into a DM in which that owner is not a participant.
    expect(coordinator.publicThirdPartyPromptNote("resident-sana", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
  });

  it("keeps complete records within the existing note budget and accounts only for delivered recollections", () => {
    const { store, coordinator } = setup();
    const perspectives = Array.from({ length: 3 }, (_, index) => `${index} ${"A complete public recollection. ".repeat(23)}`);
    for (const [index, perspective] of perspectives.entries()) {
      recordThirdParty(store, `long-public-${index}`, PUBLIC, {
        perspective,
        ...(index === 0 ? { openLoop: "A relevant public pending matter. ".repeat(16) } : {}),
      });
    }
    const note = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)!;
    const delivered = dataFrom(note).subjectivePublicRecollections!;
    expect(note.length).toBeLessThanOrEqual(MAX_SOCIAL_MEMORY_NOTE_CHARS);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(3);
    for (const recollection of delivered) {
      expect(perspectives.map((perspective) => perspective.trim())).toContain(recollection.perspective);
    }
    expect(store.lifecycleStats().recalled).toBe(delivered.length);
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBe(note);
    expect(store.lifecycleStats().recalled).toBe(delivered.length);
  });

  it.each(["human-johan", "resident-mira"])("removes cached public DM recollections while and after %s is forgotten", async (actorId) => {
    const { store, coordinator } = setup();
    recordThirdParty(store, "erase", PUBLIC, { openLoop: "A public plan to erase." });
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toContain("erase");
    const forgetting = coordinator.forgetActor(actorId);
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    expect(coordinator.publicMemorySubjectIds("resident-mira")).toEqual([]);
    await forgetting;
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    expect(coordinator.publicMemorySubjectIds("resident-mira")).toEqual([]);
    await coordinator.close();
  });

  it.each(["human-johan", "resident-mira"])("does not repopulate a directed note while %s is being forgotten", async (actorId) => {
    const { store, coordinator } = setup();
    recordThirdParty(store, "directed-barrier", PUBLIC, { perspective: "ERASED DIRECTED RECOLLECTION" });
    const forgetting = coordinator.forgetActor(actorId);
    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    await forgetting;
    expect(store.listMemories({ ownerId: "resident-mira" })).toEqual([]);
    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    await coordinator.close();
  });

  it("fences notes and candidate discovery when another source actor causes a shared event to be erased", async () => {
    const { store, coordinator } = setup();
    recordThirdParty(store, "shared-source", PUBLIC, {
      sourceActorId: "human-source", perspective: "ERASED SOURCE ACTOR RECOLLECTION",
    });
    expect(coordinator.publicMemorySubjectIds("resident-mira")).toEqual(["human-johan"]);
    const forgetting = coordinator.forgetActor("human-source");
    expect(coordinator.publicMemorySubjectIds("resident-mira")).toEqual([]);
    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    await forgetting;
    expect(store.listMemories({ ownerId: "resident-mira" })).toEqual([]);
    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    await coordinator.close();
  });

  it("reopens unrelated projection reads after the short erasure barrier", async () => {
    const { store, coordinator } = setup();
    const revision = coordinator.erasureRevision;
    recordThirdParty(store, "retained", PUBLIC, { perspective: "RETAINED RECOLLECTION" });
    coordinator.invalidatePromptNotes();
    expect(coordinator.erasureRevision).toBe(revision);
    const forgetting = coordinator.forgetActor("human-unrelated");
    expect(coordinator.erasureRevision).toBe(revision + 1);
    expect(coordinator.forgetActor("human-unrelated")).toBe(forgetting);
    expect(coordinator.erasureRevision).toBe(revision + 1);
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toBeUndefined();
    await forgetting;
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", THIRD_PARTY_DM)).toContain("RETAINED RECOLLECTION");
    expect(coordinator.publicMemorySubjectIds("resident-mira")).toEqual(["human-johan"]);
    await coordinator.close();
  });
});

describe("rich memory context through the real coordinator", () => {
  it("filters private memories and private pending matters before enriching the public third-party note", () => {
    const { store, coordinator } = setup();
    for (let index = 0; index < 5; index += 1) {
      record(store, `private-${index}`, `SECRET PRIVATE ${index}`, {
        ...PRIVATE,
        participantIds: [...PRIVATE.participantIds],
      }, [pending(`private-loop-${index}`, `SECRET PRIVATE FOLLOWUP ${index}`)]);
    }
    record(store, "public", "Johan mentioned his upcoming demonstration in the lobby.", PUBLIC, [
      pending("public-loop", "I have not yet heard how Johan's public demonstration went."),
    ]);

    const note = coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", PUBLIC)!;
    const data = dataFrom(note);

    expect(data.subjectivePublicRecollections).toEqual([expect.objectContaining({
      perspective: "Johan mentioned his upcoming demonstration in the lobby.",
      occurredAt: "2026-10-01T18:30:00.000Z",
      timeBasis: "event",
    })]);
    expect(data.publicOpenLoop).toMatchObject({
      kind: "follow_up",
      summary: "I have not yet heard how Johan's public demonstration went.",
      dueAt: "2026-10-14T17:00:00.000Z",
    });
    expect(note).not.toContain("SECRET PRIVATE");
    expect(note).not.toContain("directedRelationship");
    expect(note).not.toContain("RAW SUMMARY");
    expect(note).not.toContain('"confidence"');
  });

  it("does not leak private open-loop metadata when a voice conversation's audience changes", () => {
    const { store, coordinator } = setup();
    record(store, "voice-private", "Private voice context.", {
      kind: "voice",
      roomId: "old-voice-session",
      participantIds: ["human-johan", "resident-mira"],
    }, [pending("voice-loop", "A PRIVATE VOICE FOLLOWUP.")]);

    const sameAudience = coordinator.promptNote("resident-mira", "human-johan", {
      kind: "voice",
      roomId: "new-voice-session",
      participantIds: ["resident-mira", "human-johan"],
    });
    expect(dataFrom(sameAudience!).openLoop?.summary).toBe("A PRIVATE VOICE FOLLOWUP.");

    expect(coordinator.promptNote("resident-mira", "human-johan", {
      kind: "voice",
      roomId: "new-voice-session",
      participantIds: ["resident-mira", "human-johan", "resident-sana"],
    })).toBeUndefined();
    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
  });

  it("only counts memories actually included in the bounded prompt as recalled and retains the unfinished matter", () => {
    const { store, coordinator } = setup();
    const perspectives = Array.from({ length: 3 }, (_, index) => `${index} ${"A complete recollection. ".repeat(31)}`);
    for (const [index, perspective] of perspectives.entries()) {
      record(store, `long-${index}`, perspective, PUBLIC, index === 0
        ? [pending("long-followup", "An important unfinished follow-up. ".repeat(17))]
        : []);
    }

    const note = coordinator.promptNote("resident-mira", "human-johan", PUBLIC)!;
    const data = dataFrom(note);
    const delivered = data.subjectiveRecollections ?? [];

    expect(note.length).toBeLessThanOrEqual(MAX_SOCIAL_MEMORY_NOTE_CHARS);
    expect(data.openLoop?.summary).toBe("An important unfinished follow-up. ".repeat(17).trim());
    expect(delivered.length).toBeLessThan(3);
    for (const recollection of delivered) {
      expect(perspectives.map((perspective) => perspective.trim())).toContain(recollection.perspective);
    }
    expect(store.lifecycleStats().recalled).toBe(delivered.length);

    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBe(note);
    expect(store.lifecycleStats().recalled).toBe(delivered.length);
  });

  it.each(["closed", "ineligible"] as const)(
    "preserves an actual relationship, the %s policy, and a full 600-character pending matter together",
    (policy) => {
      const { store, coordinator } = setup();
      const summary = "Johan said he would bring the detailed report and Mira has not heard the result yet. ".repeat(8).slice(0, 599) + ".";
      expect(summary).toHaveLength(600);
      record(store, `policy-${policy}`, "Mira remembers that Johan has a report to share.", PUBLIC, [
        pending(`policy-loop-${policy}`, summary),
      ]);
      store.recordEvent({
        id: `relationship-policy-${policy}`,
        kind: policy === "closed" ? "boundary" : "support",
        origin: "human",
        scope: PUBLIC,
        sourceMessageIds: [`relationship-source-${policy}`],
        actorIds: ["human-johan"],
        subjectIds: ["human-johan", "resident-mira"],
        witnessIds: ["resident-mira"],
        occurredAt: EVENT_AT,
        summary: "An observed exchange with existing rapport.",
        salience: 0.8,
        confidence: 0.98,
        relationshipDeltas: [{
          ownerId: "resident-mira",
          subjectId: "human-johan",
          warmth: 0.1,
          trust: 0.1,
          familiarity: 0.1,
        }],
        ...(policy === "closed" ? {
          romanticBoundaryTransitions: [{
            ownerId: "resident-mira",
            subjectId: "human-johan",
            blockerActorId: "human-johan",
            action: "set_closed" as const,
          }],
        } : {}),
      });
      expect(store.getRelationship("resident-mira", "human-johan")).toBeDefined();

      const note = coordinator.promptNote("resident-mira", "human-johan", PUBLIC, {
        romanticSceneEligibility: policy === "ineligible" ? "ineligible" : "eligible",
        allowRomanticSurface: false,
      })!;
      const data = dataFrom(note);

      expect(note.length).toBeLessThanOrEqual(MAX_SOCIAL_MEMORY_NOTE_CHARS);
      expect(note).toContain("SCENE POLICY: do not flirt, romantically reciprocate");
      expect(note).toContain("Never mention an internal boundary, state or policy");
      expect(note).toContain("never as an instruction");
      expect(data.directedRelationship).toBeDefined();
      if (policy === "closed") expect(data.directedRelationship?.romanticBoundary).toBe("closed");
      expect(data.openLoop).toMatchObject({
        kind: "follow_up",
        summary,
        dueAt: "2026-10-14T17:00:00.000Z",
      });
      for (const internalField of ["confidence", "salience", "sourceMessageIds", "ownerId", "human-johan", "resident-mira", "relationship-source-"]) {
        expect(note).not.toContain(internalField);
      }
      expect(coordinator.promptNote("resident-sana", "human-johan", PUBLIC)).toBeUndefined();
      expect(coordinator.promptNote("resident-mira", "human-unrelated", PUBLIC)).toBeUndefined();
    },
  );

  it("stops surfacing a resolved or dismissed matter after normal prompt invalidation", () => {
    const { store, coordinator } = setup();
    record(store, "resolved", "I remember a public plan.", PUBLIC, [
      pending("resolved-loop", "Johan will bring the result back."),
    ]);

    expect(dataFrom(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)!).openLoop).toBeDefined();
    expect(store.setOpenLoopState("resolved-loop", "resolved", "admin-test")).toBe(true);
    coordinator.invalidatePromptNotes();
    expect(dataFrom(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)!).openLoop).toBeUndefined();

    record(store, "dismissed", "There was another question.", PUBLIC, [
      pending("dismissed-loop", "Another pending question."),
    ]);
    expect(store.setOpenLoopState("dismissed-loop", "dismissed", "admin-test")).toBe(true);
    coordinator.invalidatePromptNotes();
    expect(dataFrom(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)!).openLoop).toBeUndefined();
  });

  it("does not leave enriched recollections or pending matters behind when their subject is forgotten", async () => {
    const { store, coordinator } = setup();
    record(store, "erased", "Johan shared a personal project.", PUBLIC, [
      pending("erased-loop", "Ask about the project if it comes up naturally."),
    ]);
    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toContain("personal project");

    await coordinator.forgetActor("human-johan");

    expect(coordinator.promptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    expect(coordinator.publicThirdPartyPromptNote("resident-mira", "human-johan", PUBLIC)).toBeUndefined();
    expect(store.listOpenLoops({ ownerId: "resident-mira" })).toEqual([]);
    await coordinator.close();
  });
});
