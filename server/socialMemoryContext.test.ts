import { afterEach, describe, expect, it } from "vitest";
import { SocialMemoryStore, type OpenLoopInput, type SocialMemoryScope } from "./socialMemory.js";
import { SocialMemoryCoordinator } from "./socialMemoryCoordinator.js";
import { MAX_SOCIAL_MEMORY_NOTE_CHARS } from "./socialMemoryProjection.js";

const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const EVENT_AT = Date.parse("2026-10-01T18:30:00.000Z");
const PUBLIC = { kind: "public", channelId: "lobby" } as const;
const PRIVATE = { kind: "dm", threadId: "dm-johan-mira", participantIds: ["human-johan", "resident-mira"] } as const;
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
