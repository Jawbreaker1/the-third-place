import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LmStudioClient, type SceneRequest } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";

const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const ownerNote = "CURRENT_DM_OWNER_NOTE: Sam likes quiet conversations.";
const foreignNote = "OTHER_RESIDENT_PRIVATE_THREAD_SENTINEL";
const answer = "Good to see you again. How has your day been?";
type Body = Record<string, any>;
const data = (body: Body): Body => JSON.parse(body.messages.find((message: Body) => message.role === "user").content);
const schemaName = (body: Body): string => body.response_format?.json_schema?.name;
const completion = (value: unknown) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const clients: LmStudioClient[] = [];

const request = (): SceneRequest => ({
  kind: "dm", channelId: "dm-owner-test", channelName: "private chat with Sam", selected: [mira], history: [],
  trigger: { author: "Sam", content: "Hi again!", messageId: "owner-turn" },
  mustReplyIds: [mira.id], requestOwnerIds: [mira.id], responseRecoveryIds: [mira.id],
  relationshipNotes: { [mira.id]: ownerNote, "ai-sana": foreignNote },
  languageHint: "en", semanticContext: {
    languageTag: "en", intentTrusted: true, replyExpected: "expected",
    asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false,
  },
  humanizerBudget: { repairsRemaining: 0 }, responseRecoveryBudget: { retriesRemaining: 1 },
});

const setup = (emptyFirst = false) => {
  const bodies: Body[] = [];
  let generations = 0;
  const backend: ModelBackend = {
    providerId: "lmstudio", configuredModel: "dm-owner-test",
    probe: async () => ({ connected: true, id: "dm-owner-test", label: "Test" }),
    complete: vi.fn(async (body: Body) => {
      bodies.push(body);
      if (bodies.length > 4) throw new Error("Unexpected extra model call in owner-isolation test");
      if (schemaName(body) === "social_scene") {
        generations += 1;
        return completion({ messages: emptyFirst && generations === 1 ? [] : [{ personaId: mira.id, content: answer, sourceIds: [] }] });
      }
      if (schemaName(body) === "multilingual_candidate_review") {
        return completion({ reviews: data(body).candidates.map((candidate: Body) => ({
          personaId: candidate.personaId, severity: "none", issues: [], rewriteInstruction: null,
          sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 },
          requestDelivery: { status: "delivered", resolvedOutcome: "Respond to the current greeting.", deliveredExcerpt: "Good to see you again." },
        })) });
      }
      throw new Error("Unexpected schema " + schemaName(body));
    }),
  };
  const client = new LmStudioClient({ backend, now: () => Date.parse("2026-10-13T10:00:00.000Z") });
  clients.push(client);
  return { client, bodies };
};

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true"); vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.cancelPending("DM owner-isolation test complete");
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("single-resident DM private-context isolation", () => {
  it("serializes only the selected resident's private note without mutating the caller's context", async () => {
    const { client, bodies } = setup();
    const input = request();
    expect(await client.generateScene(input)).toEqual([expect.objectContaining({ content: answer })]);
    expect(bodies.map(schemaName)).toEqual(["social_scene", "multilingual_candidate_review"]);
    expect(data(bodies[0]!).relationshipNotes).toEqual({ [mira.id]: ownerNote });
    expect(data(bodies[1]!).candidates[0].privateRelationshipNote).toBe(ownerNote);
    expect(bodies.map((body) => JSON.stringify(body).includes(foreignNote))).toEqual([false, false]);
    expect(input.relationshipNotes).toEqual({ [mira.id]: ownerNote, "ai-sana": foreignNote });
  });

  it("retains the same owner-only private context through ordinary full-scene recovery", async () => {
    const { client, bodies } = setup(true);
    expect(await client.generateScene(request())).toEqual([expect.objectContaining({ content: answer })]);
    expect(bodies.map(schemaName)).toEqual(["social_scene", "social_scene", "multilingual_candidate_review"]);
    for (const body of bodies.filter((entry) => schemaName(entry) === "social_scene")) {
      expect(data(body).relationshipNotes).toEqual({ [mira.id]: ownerNote });
    }
    expect(data(bodies[2]!).candidates[0].privateRelationshipNote).toBe(ownerNote);
    expect(bodies.map((body) => JSON.stringify(body).includes(foreignNote))).toEqual([false, false, false]);
  });
});
