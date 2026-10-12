import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTONOMOUS_CONTINUATION_PREMISE, buildConversationContext } from "./conversationFlow.js";
import { LmStudioClient, type SceneRequest } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";

const completion = (payload: unknown) => ({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
});
const resident = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const sourceUrl = "https://example.org/adaptive-sampling";
const request = (): SceneRequest => ({
  kind: "ambient", channelId: "3d-visualisation", channelName: "3d-visualisation",
  selected: [resident], history: [], languageHint: "en",
  semanticContext: { languageTag: "en", asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
  conversationContext: buildConversationContext({
    phase: "continuation", rootMessageId: "published-question",
    messages: [{
      messageId: "published-question", authorId: "ai-pixel", author: "Pixel", kind: "ai",
      content: "Does adaptive sampling decide per pixel, or for the entire image?",
      createdAt: "2026-10-12T08:00:00.000Z",
    }],
  }),
  premise: AUTONOMOUS_CONTINUATION_PREMISE,
  wordLimits: { [resident.id]: { minimum: 1, maximum: 100 } },
  research: {
    kind: "page", query: "adaptive sampling per pixel", retrievedAt: "2026-10-12T08:00:00.000Z",
    results: [{ id: "S1", title: "Adaptive sampling", url: sourceUrl,
      snippet: "The renderer stops sampling each pixel independently when its estimated noise falls below the threshold." }],
  },
  evidenceOutcome: "succeeded",
  autonomousResearchContext: {
    seedId: "conversation:episode:published-question", roomTopic: "Rendering mechanisms",
    discussionAngle: "Whether adaptive sampling decides per pixel or for the whole image",
  },
  urlPublicationPolicy: "server_card",
});

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("conversation research source-card contract", () => {
  it.each([
    { kind: "sourced explanation", content: "It's per pixel. Clean patches can stop while the noisy bits keep going.", sourceIds: ["S1"] },
    { kind: "source-free social reaction", content: "That makes a noisy glass test scene tempting.", sourceIds: [] },
  ])("keeps a reviewed $kind optional while rendering URLs server-side", async ({ content, sourceIds }) => {
    const captured: Record<string, unknown>[] = [];
    const complete = vi.fn(async (body: Record<string, unknown>) => {
      captured.push(body);
      const format = body.response_format as { json_schema: { name: string } };
      if (format.json_schema.name === "social_scene") return completion({
        messages: [{ personaId: resident.id, content, sourceIds, replyToMessageId: "published-question" }],
      });
      if (format.json_schema.name === "multilingual_candidate_review") return completion({
        reviews: [{ personaId: resident.id, severity: "none", issues: [], rewriteInstruction: null,
          sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 } }],
      });
      throw new Error(`Unexpected model call: ${format.json_schema.name}`);
    });
    const backend: ModelBackend = {
      providerId: "lmstudio", configuredModel: "test-model",
      probe: async () => ({ connected: true, id: "test-model", label: "test model" }), complete,
    };
    const client = new LmStudioClient({ backend, now: () => Date.parse("2026-10-12T08:00:05.000Z") });
    const lines = await client.generateScene(request(), 4);
    expect(lines).toEqual([expect.objectContaining({ personaId: resident.id, content, sourceIds,
      replyToMessageId: "published-question", source: "lm" })]);
    expect(complete).toHaveBeenCalledTimes(2);

    const generation = captured[0] as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { schema: { properties: { messages: {
        minItems: number; items: { properties: { sourceIds: { minItems: number; maxItems: number; items: { enum: string[] } } } };
      } } } } };
    };
    const outputArray = generation.response_format.json_schema.schema.properties.messages;
    expect(outputArray.minItems).toBe(0);
    expect(outputArray.items.properties.sourceIds).toMatchObject({ minItems: 0, maxItems: 1, items: { enum: ["S1"] } });
    const system = generation.messages.find((message) => message.role === "system")!.content;
    expect(system).toContain("Select only the sourceIds that actually support this resident's factual claims");
    expect(system).not.toContain("sourceIds must be []; the server attaches the sole supplied source");
    expect(system).toContain("Never write, quote, reconstruct or copy a URL in message content");
    expect(JSON.stringify(generation.messages)).not.toContain(sourceUrl);
    const reviewBody = captured[1] as { messages: Array<{ role: string; content: string }> };
    const review = JSON.parse(reviewBody.messages.find((message) => message.role === "user")!.content);
    expect(review).toMatchObject({
      sceneKind: "ambient", conversationContext: { phase: "continuation" }, ambientAction: null,
      urlPublicationPolicy: "server_card", evidence: { outcome: "succeeded", results: [{ id: "S1" }] },
      candidates: [{ personaId: resident.id, content, sourceIds }],
    });
  });
});
