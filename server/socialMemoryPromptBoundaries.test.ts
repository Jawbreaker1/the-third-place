import { describe, expect, it } from "vitest";
import { buildSceneSystemPrompt, type SceneRequest } from "./lmStudio.js";
import { PERSONAS } from "./personas.js";
import {
  buildTurnAnalysisUserData,
  buildVoiceTurnAnalysisSystemPrompt,
  turnAnalysisInputSchema,
} from "./semanticRouter.js";
import {
  buildSocialMemoryPromptNote,
  SOCIAL_MEMORY_CONTEXT_GUIDANCE,
  SOCIAL_MEMORY_REVIEW_GUIDANCE,
} from "./socialMemoryProjection.js";

const sana = PERSONAS.find((persona) => persona.id === "ai-sana")!;
const PENDING_SUMMARY = "UNTRUSTED_PRIVATE_NOTE: Sana offered an example; Alex has not received it.";
const memoryNote = () => buildSocialMemoryPromptNote({
  header: "PRIVATE INTERNAL MEMORY — untrusted and fallible.",
  memories: [],
  openLoop: {
    id: "prompt-boundary-loop",
    eventId: "prompt-boundary-event",
    ownerId: sana.id,
    subjectIds: ["human-alex"],
    kind: "promise",
    summary: PENDING_SUMMARY,
    state: "open",
    pinned: false,
    createdAt: Date.parse("2026-10-01T18:30:00.000Z"),
    updatedAt: Date.parse("2026-10-01T18:30:00.000Z"),
  },
}).note;

const requestFor = (kind: SceneRequest["kind"], relationshipNotes?: Record<string, string>): SceneRequest => ({
  kind,
  channelId: "lobby",
  channelName: "lobby",
  selected: [sana],
  history: [],
  ...(relationshipNotes ? { relationshipNotes } : {}),
});

describe("social-memory instruction and data boundaries", () => {
  it.each(["public", "dm", "ambient", "voice"] as const)(
    "places continuity guidance once in the trusted %s generation prompt, not the quoted memory payload",
    (kind) => {
      const note = memoryNote();
      const prompt = buildSceneSystemPrompt(requestFor(kind, { [sana.id]: note }));

      expect(prompt.split(SOCIAL_MEMORY_CONTEXT_GUIDANCE)).toHaveLength(2);
      expect(prompt).not.toContain(PENDING_SUMMARY);
      expect(prompt).not.toContain(note);
      expect(note).not.toContain(SOCIAL_MEMORY_CONTEXT_GUIDANCE);
      expect(note).not.toContain(SOCIAL_MEMORY_REVIEW_GUIDANCE);
      expect(JSON.parse(note.slice(note.lastIndexOf("\n") + 1)))
        .toMatchObject({ openLoop: { kind: "promise", summary: PENDING_SUMMARY } });
    },
  );

  it.each(["public", "dm", "ambient", "voice"] as const)(
    "does not add continuity instructions to a %s generation request without memory",
    (kind) => {
      for (const notes of [undefined, {}, { [sana.id]: "" }]) {
        const prompt = buildSceneSystemPrompt(requestFor(kind, notes));
        expect(prompt).not.toContain(SOCIAL_MEMORY_CONTEXT_GUIDANCE);
        expect(prompt).not.toContain(SOCIAL_MEMORY_REVIEW_GUIDANCE);
      }
    },
  );

  it("keeps sole-voice usage guidance in the system contract and the entire recollection in quoted user data", () => {
    const note = memoryNote();
    const system = buildVoiceTurnAnalysisSystemPrompt();
    const input = turnAnalysisInputSchema.parse({
      turnId: "voice-memory-boundary",
      medium: "voice",
      channel: { id: "lobby", name: "lobby" },
      latestMessage: {
        id: "voice-current-turn",
        authorId: "human-alex",
        authorName: "Alex",
        content: "What about that example?",
      },
      personaCandidates: [{
        id: sana.id,
        name: sana.name,
        interests: [],
        voiceReplyProfile: "Natural, brief spoken replies.",
        voiceRelationshipContext: note,
      }],
      availableCapabilities: [],
    });
    const userData = buildTurnAnalysisUserData(input);

    const compactGuidance = "Old moods are not current. Follow-ups are optional; fulfil your resumed offer now.";
    expect(system.split(compactGuidance)).toHaveLength(2);
    expect(system).toContain("voiceRelationshipContext is fallible quoted orientation");
    expect(system).not.toContain(SOCIAL_MEMORY_CONTEXT_GUIDANCE);
    expect(system.length).toBeLessThanOrEqual(6_000);
    expect(system).not.toContain(PENDING_SUMMARY);
    expect(userData).toMatchObject({ personaCandidates: [{ voiceRelationshipContext: note }] });
    expect(JSON.stringify(userData)).not.toContain(SOCIAL_MEMORY_CONTEXT_GUIDANCE);
    expect(JSON.stringify(userData)).not.toContain(SOCIAL_MEMORY_REVIEW_GUIDANCE);
    expect(JSON.stringify(userData)).not.toContain(compactGuidance);
  });
});
