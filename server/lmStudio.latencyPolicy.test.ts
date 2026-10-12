import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LmStudioClient, type SceneRequest } from "./lmStudio.js";
import { ModelBackendError, type ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";

const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const reply = "A copy has a separate outer array; adding an item leaves the original alone.";
type ModelBody = { messages: Array<{ role: string; content: string }>; [key: string]: unknown };
const completion = (content: string) => ({ choices: [{ message: { content } }] });
const candidate = () => completion(JSON.stringify({
  messages: [{ personaId: mira.id, content: reply, sourceIds: [] }],
}));
const review = (reject = false, deliveryRequired = true) => completion(JSON.stringify({
  reviews: [{
    personaId: mira.id,
    severity: reject ? "high" : "none",
    issues: reject ? ["evidence_ungrounded"] : [],
    rewriteInstruction: reject ? "Remove the unsupported factual assertion." : null,
    sameSceneOverlap: "none",
    outputLanguage: { tag: "und", confidence: 0 },
    ...(deliveryRequired ? { requestDelivery: {
      status: "delivered",
      resolvedOutcome: "Briefly explain how copying an array affects the original.",
      deliveredExcerpt: reply,
    } } : {}),
  }],
}));
const scriptedClient = (responses: unknown[]) => {
  const bodies: ModelBody[] = [];
  const backend: ModelBackend = {
    providerId: "lmstudio",
    configuredModel: "latency-policy-test-model",
    probe: async () => ({ connected: true, id: "latency-policy-test-model", label: "Synthetic backend" }),
    complete: async (body) => {
      bodies.push(body as ModelBody);
      if (bodies.length > responses.length) throw new Error("Unexpected extra model call");
      const response = responses[bodies.length - 1];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { client: new LmStudioClient({ backend }), bodies };
};
const request = (overrides: Partial<SceneRequest> = {}): SceneRequest => ({
  kind: "dm",
  channelId: "dm-latency-policy",
  channelName: "Private conversation",
  selected: [mira],
  history: [],
  trigger: { author: "Test visitor", content: "Briefly explain how copying an array affects the original.", messageId: "copy-request" },
  mustReplyIds: [mira.id],
  requestOwnerIds: [mira.id],
  semanticContext: {
    languageTag: "en", intentTrusted: true, replyExpected: "expected", answerDepth: "normal",
    asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false,
  },
  humanizerBudget: { repairsRemaining: 0 },
  responseRecoveryBudget: { retriesRemaining: 0 },
  ...overrides,
});
const expectReviewed = (body: ModelBody) => {
  expect(body.response_format).toMatchObject({ json_schema: { name: "multilingual_candidate_review" } });
  expect(JSON.parse(body.messages[1].content).candidates).toEqual([
    expect.objectContaining({ personaId: mira.id, content: reply }),
  ]);
};

beforeEach(() => {
  vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
  vi.stubEnv("LM_STUDIO_MAX_TOKENS", "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("interactive completion latency policy", () => {
  it.each(["public", "dm"] as const)("disables hidden reasoning for ordinary %s turns without a conversation context", async (kind) => {
    for (const answerDepth of [undefined, "brief", "normal"] as const) {
      const base = request({ kind });
      const { client, bodies } = scriptedClient([candidate(), review()]);
      const result = await client.generateScene({
        ...base, semanticContext: { ...base.semanticContext!, answerDepth },
      });
      expect(result).toEqual([expect.objectContaining({ content: reply })]);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("reasoning_effort", "none");
      expectReviewed(bodies[1]);
    }
  });

  it.each(["public", "dm"] as const)("preserves detailed and considered %s reasoning policy", async (kind) => {
    for (const mode of ["detailed", "considered"] as const) {
      const base = request({ kind });
      const { client, bodies } = scriptedClient([candidate(), review()]);
      await client.generateScene({
        ...base,
        ...(mode === "detailed" ? { semanticContext: { ...base.semanticContext!, answerDepth: "detailed" } } : {}),
        ...(mode === "considered" ? { conversationMode: "considered" } : {}),
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).not.toHaveProperty("reasoning_effort");
      expectReviewed(bodies[1]);
    }
  });

  it("leaves an autonomous opening's existing reasoning policy unchanged", async () => {
    const { client, bodies } = scriptedClient([candidate(), review(false, false)]);
    await client.generateScene(request({ kind: "ambient", mustReplyIds: [], requestOwnerIds: [] }));
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expectReviewed(bodies[1]);
  });

  it("preserves voice's direct completion even for detailed turns", async () => {
    const base = request({ kind: "voice" });
    const { client, bodies } = scriptedClient([candidate(), review()]);
    await client.generateScene({ ...base, semanticContext: { ...base.semanticContext!, answerDepth: "detailed" } });
    expect(bodies[0]).toHaveProperty("reasoning_effort", "none");
    expectReviewed(bodies[1]);
  });

  it.each(["public", "dm"] as const)("keeps direct completion on empty and malformed %s output retries", async (kind) => {
    for (const content of ["", '{"messages":[']) {
      const { client, bodies } = scriptedClient([completion(content), candidate(), review()]);
      expect(await client.generateScene(request({ kind }))).toEqual([expect.objectContaining({ content: reply })]);
      expect(bodies).toHaveLength(3);
      for (const body of bodies.slice(0, 2)) expect(body).toHaveProperty("reasoning_effort", "none");
      expect(bodies[1].max_tokens).toBe(Math.round(Number(bodies[0].max_tokens) * 1.35));
      expectReviewed(bodies[2]);
    }
  });

  it.each([400, 422])("accepts an endpoint's %s compatibility fallback but still requires review", async (status) => {
    const { client, bodies } = scriptedClient([
      new ModelBackendError("Optional controls unsupported", status), candidate(), review(),
    ]);
    expect(await client.generateScene(request())).toEqual([expect.objectContaining({ content: reply })]);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ reasoning_effort: "none", response_format: expect.any(Object) });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expectReviewed(bodies[2]);
  });

  it("keeps a subsequent malformed retry in compatibility mode and respects reviewer rejection", async () => {
    const { client, bodies } = scriptedClient([
      new ModelBackendError("Optional controls unsupported", 400),
      completion('{"messages":['), candidate(), review(true),
    ]);
    expect(await client.generateScene(request())).toEqual([]);
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toHaveProperty("reasoning_effort", "none");
    for (const body of bodies.slice(1, 3)) {
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("response_format");
    }
    expect(bodies[2].max_tokens).toBe(Math.round(Number(bodies[1].max_tokens) * 1.35));
    expectReviewed(bodies[3]);
  });

  it("does not retry forever or publish when required output remains empty", async () => {
    const { client, bodies } = scriptedClient([completion(""), completion("")]);
    await expect(client.generateScene(request())).rejects.toThrow("returned no message content");
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toHaveProperty("reasoning_effort", "none");
  });
});
