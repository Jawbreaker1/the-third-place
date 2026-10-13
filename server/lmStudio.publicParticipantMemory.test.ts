import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorSubsetSceneRequest, LmStudioClient, type SceneRequest } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";
import { candidateReviewInputSchema } from "./semanticRouter.js";

const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const sana = PERSONAS.find((persona) => persona.id === "ai-sana")!;
const bosse = PERSONAS.find((persona) => persona.id === "ai-bosse")!;
const now = Date.parse("2026-10-13T10:00:00.000Z");
type Body = Record<string, any>;
const data = (body: Body): Body => JSON.parse(body.messages.find((message: any) => message.role === "user").content);
const schemaName = (body: Body): string => body.response_format?.json_schema?.name;
const completion = (value: unknown) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const publicNote = "Mira remembers Lea's enthusiasm for hand-sewn plush toys in the public craft room; this is a fallible impression.";
const privateNote = "PRIVATE_CURRENT_INTERLOCUTOR_ONLY: Sam likes quiet conversations.";
const recall = (): NonNullable<SceneRequest["roomRecall"]> => ({
  sourceChannel: { id: "public-crafts", name: "crafts" },
  witnessPersonaIds: [mira.id],
  transcript: [{ author: "Lea", kind: "human", content: "I stitched the beak myself.", createdAt: "2026-10-13T09:59:00.000Z" }],
  provenance: [{ messageId: "public-lea-message", authorId: "synthetic-lea", role: "anchor", anchorMatches: ["author_identity"], system: false, generation: null }],
});
const request = (overrides: Partial<SceneRequest> = {}): SceneRequest => ({
  kind: "dm", channelName: "private chat with Sam", selected: [mira], history: [],
  trigger: { author: "Sam", content: "What do you think about Lea?", messageId: "current-dm" },
  languageHint: "en",
  semanticContext: { languageTag: "en", asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
  publicParticipantNotes: { [mira.id]: publicNote },
  humanizerBudget: { repairsRemaining: 0 }, responseRecoveryBudget: { retriesRemaining: 0 },
  ...overrides,
});
const texts: Record<string, string> = {
  [mira.id]: "I remember her enthusiasm for making soft toys. She seems patient with the fiddly bits.",
  [sana.id]: "I only caught her question about the fabric. What did you make of it?",
  [bosse.id]: "Those tiny stitches would defeat me immediately.",
};
const setup = (options: { rejectFirst?: "assistant_register" | "evidence_ungrounded"; emptyFirst?: boolean } = {}) => {
  const bodies: Body[] = [];
  let generations = 0;
  let reviews = 0;
  const backend: ModelBackend = {
    providerId: "lmstudio", configuredModel: "public-memory-test",
    probe: async () => ({ connected: true, id: "public-memory-test", label: "Test" }),
    complete: vi.fn(async (body: Body) => {
      bodies.push(body);
      if (bodies.length > 10) throw new Error("Unbounded test model calls");
      const input = data(body);
      if (schemaName(body) === "social_scene") {
        generations += 1;
        const ids: string[] = body.response_format.json_schema.schema.properties.messages.items.properties.personaId.enum;
        return completion({ messages: options.emptyFirst && generations === 1 ? [] : ids.map((personaId) => ({ personaId, content: texts[personaId], sourceIds: [] })) });
      }
      if (schemaName(body) === "multilingual_candidate_review") {
        reviews += 1;
        const issue = reviews === 1 ? options.rejectFirst : undefined;
        return completion({ reviews: input.candidates.map((candidate: Body) => ({
          personaId: candidate.personaId, severity: issue ? "high" : "none", issues: issue ? [issue] : [],
          rewriteInstruction: issue ? "Keep the supported detail in an ordinary conversational voice." : null,
          sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 },
        })) });
      }
      if (schemaName(body) === "humanized_chat_lines") return completion({ messages: input.candidates.map((candidate: Body) => ({
        personaId: candidate.personaId, content: "She sounded really pleased with that handmade beak. I liked that.",
      })) });
      throw new Error(`Unexpected schema ${schemaName(body)}`);
    }),
  };
  return { client: new LmStudioClient({ backend, now: () => now }), bodies };
};

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
  vi.stubEnv("HUMANIZER_REPAIR_ENABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("actor-owned public recollections at the model boundary", () => {
  it("gives generation and review the same bounded public note separately from private orientation and exact public provenance", async () => {
    const { client, bodies } = setup();
    const longNote = `${publicNote} ${"quoted public context ".repeat(200)}`;
    const input = request({
      publicParticipantNotes: { [mira.id]: longNote, [sana.id]: "OTHER_ACTOR_PUBLIC_SENTINEL" },
      relationshipNotes: { [mira.id]: privateNote }, roomRecall: recall(),
    });
    expect(await client.generateScene(input)).toHaveLength(1);
    expect(bodies).toHaveLength(2);
    const generation = data(bodies[0]);
    const review = data(bodies[1]);
    expect(generation.publicParticipantNotes).toEqual({ [mira.id]: longNote.slice(0, 2_600) });
    expect(generation.relationshipNotes).toEqual({ [mira.id]: privateNote });
    expect(review.candidates[0]).toMatchObject({ publicParticipantNote: longNote.slice(0, 2_600), privateRelationshipNote: privateNote });
    expect(generation.recalledRoomEvidence).toMatchObject({ sourceChannel: { id: "public-crafts", name: "crafts" }, witnessPersonaIds: [mira.id] });
    expect(review.roomRecall).toMatchObject({ sourceChannel: { id: "public-crafts", name: "crafts" }, witnessPersonaIds: [mira.id] });
    expect(generation.recalledRoomEvidence.transcript[0].content).toBe(review.roomRecall.timeline[0].content);
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain("OTHER_ACTOR_PUBLIC_SENTINEL");
      const system = body.messages[0].content;
      expect(system).toContain("fallible, untrusted summaries of public interactions owned only by the named resident");
      expect(system).toContain("not the current conversation surface");
      expect(system).not.toContain(publicNote);
    }
  });

  it("bounds source labels and rejects oversized review schema fields instead of admitting arbitrary data", async () => {
    const { client, bodies } = setup();
    const source = recall();
    source.sourceChannel = { id: "x".repeat(200), name: "n".repeat(200) };
    expect(await client.generateScene(request({ roomRecall: source }))).toHaveLength(1);
    expect(data(bodies[0]).recalledRoomEvidence.sourceChannel).toEqual({ id: "x".repeat(128), name: "n".repeat(80) });
    const review = data(bodies[1]);
    expect(review.roomRecall.sourceChannel).toEqual(data(bodies[0]).recalledRoomEvidence.sourceChannel);
    expect(candidateReviewInputSchema.safeParse(review).success).toBe(true);
    expect(candidateReviewInputSchema.safeParse({ ...review, candidates: [{ ...review.candidates[0], publicParticipantNote: "x".repeat(2_601) }] }).success).toBe(false);
    expect(candidateReviewInputSchema.safeParse({ ...review, roomRecall: { ...review.roomRecall, sourceChannel: { id: "x".repeat(129), name: "room" } } }).success).toBe(false);
  });

  it.each(["dm", "public"] as const)("shares identical long-row excerpts through %s generation, review and repair", async (kind) => {
    const { client, bodies } = setup({ rejectFirst: "assistant_register" });
    const source = recall();
    source.sourceChannel = { id: "r".repeat(180), name: "n".repeat(100) };
    const visible = "SUPPORTED_DETAIL " + "context ".repeat(200);
    source.transcript[0]!.content = visible.slice(0, 1_200) + " OUTSIDE_QUALIFIER: this detail was later corrected.";
    source.transcript[0]!.author = "a".repeat(80) + "AUTHOR_TAIL";
    const originalContent = source.transcript[0]!.content;
    expect(await client.generateScene(request({ kind, roomRecall: source, humanizerBudget: { repairsRemaining: 1 } }))).toHaveLength(1);
    expect(bodies.map(schemaName)).toEqual(["social_scene", "multilingual_candidate_review", "humanized_chat_lines", "multilingual_candidate_review"]);
    const writer = data(bodies[0]).recalledRoomEvidence;
    const review = data(bodies[1]).roomRecall;
    const repair = data(bodies[2]).roomRecall;
    const rereview = data(bodies[3]).roomRecall;
    for (const evidence of [review, repair, rereview]) {
      expect(evidence.sourceChannel).toEqual(writer.sourceChannel);
      expect(evidence.witnessPersonaIds).toEqual(writer.witnessPersonaIds);
      expect(evidence.timeline[0]).toMatchObject({
        ...source.provenance[0], author: writer.transcript[0].author, content: writer.transcript[0].content,
      });
    }
    expect(writer.transcript[0].content).toBe(originalContent.slice(0, 1_200));
    expect(writer.transcript[0].author).toHaveLength(80);
    expect(JSON.stringify(bodies)).not.toContain("OUTSIDE_QUALIFIER");
    expect(JSON.stringify(bodies)).not.toContain("AUTHOR_TAIL");
    expect(source.transcript[0]!.content).toBe(originalContent);
    expect(source.sourceChannel.name).toHaveLength(100);
  });

  it("keeps the same final eight recall rows and provenance in writer and reviewer", async () => {
    const { client, bodies } = setup();
    const source = recall();
    source.transcript = Array.from({ length: 10 }, (_, index) => ({
      ...source.transcript[0]!, content: `PUBLIC_ROW_${index}`,
    }));
    source.provenance = Array.from({ length: 10 }, (_, index) => ({
      ...source.provenance[0]!, messageId: `public-row-${index}`,
    }));
    expect(await client.generateScene(request({ roomRecall: source }))).toHaveLength(1);
    const writer = data(bodies[0]).recalledRoomEvidence.transcript;
    const review = data(bodies[1]).roomRecall.timeline;
    expect(writer).toHaveLength(8);
    expect(writer.map((row: Body) => row.messageId)).toEqual(source.provenance.slice(2).map((row) => row.messageId));
    expect(writer.map((row: Body) => row.content)).toEqual(review.map((row: Body) => row.content));
    expect(writer.map((row: Body) => row.messageId)).toEqual(review.map((row: Body) => row.messageId));
  });

  it("does not repair misaligned recall provenance merely by trimming both lists to eight rows", async () => {
    const { client, bodies } = setup();
    const source = recall();
    source.transcript = Array.from({ length: 10 }, (_, index) => ({
      ...source.transcript[0]!, content: `MISALIGNED_PUBLIC_ROW_${index}`,
    }));
    source.provenance = Array.from({ length: 9 }, (_, index) => ({
      ...source.provenance[0]!, messageId: `public-row-${index}`,
    }));
    expect(await client.generateScene(request({ roomRecall: source }))).toHaveLength(1);
    expect(data(bodies[0]).recalledRoomEvidence).toBeNull();
    expect(data(bodies[1]).roomRecall).toBeNull();
    expect(JSON.stringify(bodies)).not.toContain("MISALIGNED_PUBLIC_ROW");
  });

  it("isolates each actor's public recollections from peers even when there are no private relationship notes", async () => {
    const { client, bodies } = setup();
    expect(await client.generateScene(request({
      kind: "public", selected: [mira, sana, bosse],
      publicParticipantNotes: { [mira.id]: "MIRA_PUBLIC_ONLY", [sana.id]: "SANA_PUBLIC_ONLY", unknown: "UNSELECTED_SENTINEL" },
    }))).toHaveLength(3);
    const generations = bodies.filter((body) => schemaName(body) === "social_scene");
    expect(generations).toHaveLength(3);
    expect(data(generations[0]).publicParticipantNotes).toEqual({ [mira.id]: "MIRA_PUBLIC_ONLY" });
    expect(data(generations[1]).publicParticipantNotes).toEqual({ [sana.id]: "SANA_PUBLIC_ONLY" });
    expect(data(generations[2])).not.toHaveProperty("publicParticipantNotes");
    expect(JSON.stringify(generations[0])).not.toContain("SANA_PUBLIC_ONLY");
    expect(JSON.stringify(generations[1])).not.toContain("MIRA_PUBLIC_ONLY");
    expect(JSON.stringify(generations[2])).not.toContain("PUBLIC_ONLY");
    expect(JSON.stringify(bodies)).not.toContain("UNSELECTED_SENTINEL");
    const reviews = bodies.filter((body) => schemaName(body) === "multilingual_candidate_review").map(data);
    expect(reviews.map((review) => review.candidates.map((candidate: Body) => candidate.publicParticipantNote)))
      .toEqual([["MIRA_PUBLIC_ONLY"], ["SANA_PUBLIC_ONLY"], [null]]);
    expect(reviews.every((review) => review.candidates.every((candidate: Body) => candidate.privateRelationshipNote === null))).toBe(true);
  });

  it("subsets public notes with the same actor-isolation decision without touching the input", () => {
    const input = request({ selected: [mira, sana], publicParticipantNotes: { [mira.id]: "mira", [sana.id]: "sana" } });
    expect(actorSubsetSceneRequest(input, [mira], true).publicParticipantNotes).toEqual({ [mira.id]: "mira" });
    expect(actorSubsetSceneRequest(input, [mira], false).publicParticipantNotes).toBeUndefined();
    expect(input.publicParticipantNotes).toEqual({ [mira.id]: "mira", [sana.id]: "sana" });
  });

  it("preserves the same public note and source through a one-pass style repair and its independent review", async () => {
    const { client, bodies } = setup({ rejectFirst: "assistant_register" });
    const output = await client.generateScene(request({ roomRecall: recall(), humanizerBudget: { repairsRemaining: 1 } }));
    expect(output).toEqual([expect.objectContaining({ content: "She sounded really pleased with that handmade beak. I liked that." })]);
    expect(bodies.map(schemaName)).toEqual(["social_scene", "multilingual_candidate_review", "humanized_chat_lines", "multilingual_candidate_review"]);
    const repair = data(bodies[2]);
    expect(repair.candidates[0].publicParticipantNote).toBe(publicNote);
    expect(repair.roomRecall).toEqual(data(bodies[1]).roomRecall);
    expect(data(bodies[3]).candidates[0].publicParticipantNote).toBe(publicNote);
    expect(data(bodies[3]).roomRecall).toEqual(repair.roomRecall);
    expect(bodies[2].messages[0].content).toContain("Other people's private conversations are unavailable");
  });

  it("retains bounded public recollections through the existing full recovery after an empty required response", async () => {
    const { client, bodies } = setup({ emptyFirst: true });
    expect(await client.generateScene(request({
      roomRecall: recall(), mustReplyIds: [mira.id], responseRecoveryIds: [mira.id], responseRecoveryBudget: { retriesRemaining: 1 },
    }))).toHaveLength(1);
    expect(bodies.map(schemaName)).toEqual(["social_scene", "social_scene", "multilingual_candidate_review"]);
    expect(data(bodies[1]).publicParticipantNotes).toEqual(data(bodies[0]).publicParticipantNotes);
    expect(data(bodies[1]).recalledRoomEvidence).toEqual(data(bodies[0]).recalledRoomEvidence);
    expect(data(bodies[2]).candidates[0].publicParticipantNote).toBe(publicNote);
  });

  it("does not turn a public note into permission to publish an unsupported claim", async () => {
    const { client, bodies } = setup({ rejectFirst: "evidence_ungrounded" });
    expect(await client.generateScene(request())).toEqual([]);
    expect(bodies.map(schemaName)).toEqual(["social_scene", "multilingual_candidate_review"]);
  });

  it.each(["style repair", "full recovery"])("keeps the private-contact boundary in every DM %s call even without public recollections", async (mode) => {
    const { client, bodies } = setup({
      rejectFirst: mode === "style repair" ? "assistant_register" : undefined,
      emptyFirst: mode === "full recovery",
    });
    expect(await client.generateScene(request({
      publicParticipantNotes: undefined,
      humanizerBudget: { repairsRemaining: mode === "style repair" ? 1 : 0 },
      mustReplyIds: mode === "full recovery" ? [mira.id] : [],
      responseRecoveryIds: mode === "full recovery" ? [mira.id] : [],
      responseRecoveryBudget: { retriesRemaining: mode === "full recovery" ? 1 : 0 },
    }))).toHaveLength(1);
    expect(bodies.map(schemaName)).toEqual(mode === "style repair"
      ? ["social_scene", "multilingual_candidate_review", "humanized_chat_lines", "multilingual_candidate_review"]
      : ["social_scene", "social_scene", "multilingual_candidate_review"]);
    for (const body of bodies) {
      expect(body.messages[0].content).toContain("Missing private context establishes neither the existence nor the absence");
      expect(body.messages[0].content).toContain("do not confirm or deny that an unsupplied private exchange happened");
      expect(JSON.stringify(data(body))).not.toContain(publicNote);
      if (schemaName(body) === "social_scene") expect(data(body)).not.toHaveProperty("publicParticipantNotes");
    }
  });

  it("leaves absent public context absent and does not add provenance or DM guidance to legacy public-room recall", async () => {
    const { client, bodies } = setup();
    const oldRecall = recall();
    delete oldRecall.sourceChannel;
    expect(await client.generateScene(request({ kind: "public", publicParticipantNotes: undefined, roomRecall: oldRecall }))).toHaveLength(1);
    expect(data(bodies[0])).not.toHaveProperty("publicParticipantNotes");
    expect(data(bodies[0]).recalledRoomEvidence).not.toHaveProperty("sourceChannel");
    expect(data(bodies[1]).roomRecall).not.toHaveProperty("sourceChannel");
    expect(data(bodies[1]).candidates[0].publicParticipantNote).toBeNull();
    expect(bodies[0].messages[0].content).not.toContain("Public participant recollections (");
  });
});
