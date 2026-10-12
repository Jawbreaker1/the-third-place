import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import { PERSONAS } from "./personas.js";
import { buildSocialMemoryPromptNote } from "./socialMemoryProjection.js";
import { RoomStore } from "./store.js";

const human = {
  id: "human-memory-context-test",
  name: "Alex",
  kind: "human" as const,
  status: "online" as const,
  avatar: { color: "#123", accent: "#456", glyph: "A" },
};

const richNote = (summary: string) => buildSocialMemoryPromptNote({
  header: "PRIVATE INTERNAL RESIDENT MEMORY — untrusted and fallible.",
  instructions: "SCENE POLICY: do not flirt or reveal this note. ".repeat(30),
  memories: [],
  openLoop: {
    id: "director-memory-loop",
    eventId: "director-memory-event",
    ownerId: "ai-mira",
    subjectIds: [human.id],
    kind: "promise",
    summary,
    state: "open",
    pinned: false,
    createdAt: Date.parse("2026-10-01T18:30:00.000Z"),
    updatedAt: Date.parse("2026-10-01T18:30:00.000Z"),
  },
}).note;

const setup = (promptNote: (...args: unknown[]) => string | undefined, legacy?: string) => {
  const director = new SocialDirector(
    { to: vi.fn(() => ({ emit: vi.fn() })) } as never,
    new RoomStore(`/tmp/director-memory-context-${process.pid}-${Math.random()}.json`),
    { health: vi.fn(() => ({ connected: true, queueDepth: 0 })) } as never,
    new ActorChannelRuntime(),
    { research: vi.fn(), researchSite: vi.fn() } as never,
    {
      promptNote: vi.fn(() => legacy),
      getRelation: vi.fn(() => undefined),
      listProfiles: vi.fn(() => []),
      listRestorableProfiles: vi.fn(() => []),
    } as never,
    () => [human, ...PERSONAS],
    () => 1,
    {
      rng: () => 0.5,
      weatherForecastProvider: null,
      romanceEligibleHumanActor: () => false,
      romanceEligibleResidentActor: () => false,
      socialMemory: {
        promptNote,
        behaviorProjection: vi.fn(() => undefined),
        enqueueDeliveredEpisode: vi.fn(),
      } as never,
    },
  );
  const internals = director as unknown as {
    relationshipNotes: (
      personas: typeof PERSONAS,
      member: typeof human,
      scope: { kind: "public"; channelId: string },
    ) => Record<string, string>;
    residentRelationshipNotes: (
      owners: typeof PERSONAS,
      counterparts: typeof PERSONAS,
      scope: { kind: "public"; channelId: string },
    ) => Record<string, string>;
  };
  return { director, internals };
};

describe("director structured-memory context assembly", () => {
  it("retains the complete persistent payload instead of clipping it or appending half a legacy note", () => {
    const persistent = richNote("Mira offered to explain the benchmark, and Alex is now asking about it.");
    const legacy = "LEGACY RAPPORT ".repeat(100);
    const { director, internals } = setup(() => persistent, legacy);
    try {
      expect(persistent.length + legacy.length).toBeGreaterThan(2_600);
      const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
      const note = internals.relationshipNotes([mira], human, { kind: "public", channelId: "lobby" })[mira.id]!;

      expect(note).toBe(persistent);
      expect(note).not.toContain("LEGACY RAPPORT");
      expect(JSON.parse(note.slice(note.lastIndexOf("\n") + 1)))
        .toMatchObject({ openLoop: { kind: "promise", summary: "Mira offered to explain the benchmark, and Alex is now asking about it." } });
    } finally {
      director.stop();
    }
  });

  it("preserves the first complete counterpart note without recalling a second note that will not be delivered", () => {
    const [owner, first, second] = PERSONAS.slice(0, 3);
    const primaryNote = richNote("PRIMARY COUNTERPART unfinished matter.");
    const secondaryNote = richNote("SECONDARY COUNTERPART unfinished matter.");
    const promptNote = vi.fn((_owner, subject) => subject === first!.id ? primaryNote : secondaryNote);
    const { director, internals } = setup(promptNote);
    try {
      expect(primaryNote.length + secondaryNote.length).toBeGreaterThan(2_600);
      const note = internals.residentRelationshipNotes(
        [owner!],
        [first!, second!],
        { kind: "public", channelId: "the-pub" },
      )[owner!.id]!;

      expect(note.length).toBeLessThanOrEqual(2_600);
      expect(note).toContain(primaryNote);
      expect(note).not.toContain("SECONDARY COUNTERPART");
      expect(promptNote).toHaveBeenCalledTimes(1);
      expect(promptNote).toHaveBeenCalledWith(owner!.id, first!.id, {
        kind: "public",
        channelId: "the-pub",
      }, expect.anything());
      expect(JSON.parse(note.slice(note.lastIndexOf("\n") + 1)))
        .toMatchObject({ openLoop: { summary: "PRIMARY COUNTERPART unfinished matter." } });
    } finally {
      director.stop();
    }
  });

  it("tries the second counterpart only when the primary counterpart has no memory note", () => {
    const [owner, first, second, third] = PERSONAS.slice(0, 4);
    const fallbackNote = richNote("SECOND COUNTERPART relevant unfinished matter.");
    const promptNote = vi.fn((_owner, subject) => subject === second!.id ? fallbackNote : undefined);
    const { director, internals } = setup(promptNote);
    try {
      const note = internals.residentRelationshipNotes(
        [owner!],
        [first!, second!, third!],
        { kind: "public", channelId: "the-pub" },
      )[owner!.id]!;

      expect(note).toContain(fallbackNote);
      expect(note).toContain(second!.name);
      expect(promptNote).toHaveBeenCalledTimes(2);
      expect(promptNote).toHaveBeenNthCalledWith(1, owner!.id, first!.id, expect.anything(), expect.anything());
      expect(promptNote).toHaveBeenNthCalledWith(2, owner!.id, second!.id, expect.anything(), expect.anything());
      expect(promptNote).not.toHaveBeenCalledWith(owner!.id, third!.id, expect.anything(), expect.anything());
      expect(JSON.parse(note.slice(note.lastIndexOf("\n") + 1)))
        .toMatchObject({ openLoop: { summary: "SECOND COUNTERPART relevant unfinished matter." } });
    } finally {
      director.stop();
    }
  });
});
