import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorSubsetSceneRequest, LmStudioClient, type SceneRequest } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";
import type { RequestDeliveryAssessment } from "./requestDeliveryReview.js";
import { MAX_PERSISTED_CHAT_MESSAGE_CHARACTERS } from "../shared/messageLimits.js";

const sana = PERSONAS.find((persona) => persona.id === "ai-sana")!;
const mira = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const completion = (value: unknown) => ({
  choices: [{ message: { content: JSON.stringify(value) } }],
});
const candidate = (content: string, personaId = sana.id) => completion({
  messages: [{ personaId, content, sourceIds: [] }],
});
const review = (requestDelivery?: RequestDeliveryAssessment, personaId = sana.id) => completion({
  reviews: [{
    personaId,
    severity: "none",
    issues: [],
    rewriteInstruction: null,
    sameSceneOverlap: "none",
    outputLanguage: { tag: "und", confidence: 0 },
    ...(requestDelivery ? { requestDelivery } : {}),
  }],
});
const delivered = (resolvedOutcome: string, content: string): RequestDeliveryAssessment => ({
  status: "delivered", resolvedOutcome, deliveredExcerpt: content.slice(0, 300),
});
const missing = (resolvedOutcome: string): RequestDeliveryAssessment => ({
  status: "missing", resolvedOutcome, deliveredExcerpt: null,
});

type ModelBody = { messages: Array<{ role: string; content: string }>; [key: string]: unknown };
const scriptedClient = (responses: unknown[]) => {
  const bodies: ModelBody[] = [];
  const backend: ModelBackend = {
    providerId: "lmstudio",
    configuredModel: "delivery-test-model",
    probe: async () => ({ connected: true, id: "delivery-test-model", label: "Synthetic reviewer" }),
    complete: async (body) => {
      bodies.push(body as ModelBody);
      if (bodies.length > responses.length) throw new Error("Unexpected extra model call");
      return responses[bodies.length - 1];
    },
  };
  return { client: new LmStudioClient({ backend }), bodies };
};
const sceneData = (body: ModelBody): Record<string, any> => JSON.parse(body.messages[1].content);
const contentLimit = (body: ModelBody): number => (body.response_format as {
  json_schema: { schema: { properties: { messages: { items: { properties: { content: { maxLength: number } } } } } } };
}).json_schema.schema.properties.messages.items.properties.content.maxLength;
const completeExplanation = "A copied array gives you a separate outer container. Adding an item to that copy leaves the original array alone, which is useful when another part of your program still needs the old list. But objects inside the two arrays can still be shared. Change a property on one of those objects and both arrays show that change, because they point at the same object. For a list of numbers, copying the array is enough. For nested records, copy only the objects you intend to change as well. That keeps unrelated records shared without accidentally changing the previous version of your data.";
const ownerRequest = (overrides: Partial<SceneRequest> = {}): SceneRequest => ({
  kind: "public",
  channelId: "lobby",
  channelName: "lobby",
  selected: [sana],
  history: [{
    author: sana.name, kind: "ai", content: "I can give you a short example if you want.",
    createdAt: "2026-10-12T10:00:00.000Z",
  }],
  trigger: { author: "Synthetic visitor", content: "Yes, let's pick up where we left off.", messageId: "resume-offer" },
  mustReplyIds: [sana.id],
  requestOwnerIds: [sana.id],
  semanticContext: {
    languageTag: "en",
    intentTrusted: true,
    replyExpected: "expected",
    answerDepth: "normal",
    asksForList: false,
    asksAboutAiIdentity: false,
    asksAboutAcoustics: false,
  },
  humanizerBudget: { repairsRemaining: 0 },
  ...overrides,
});

beforeEach(() => {
  vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("request-delivery review and bounded scene recovery", () => {
  it.each([
    {
      label: "code example",
      outcome: "Show how mutation differs from copying an array.",
      text: "Here's the difference:\n```js\nconst original = [1];\nconst copy = [...original];\ncopy.push(2);\nconsole.log(original); // [1]\nconsole.log(copy); // [1, 2]\n```",
    },
    {
      label: "riddle",
      outcome: "Give the visitor a self-contained riddle to solve.",
      text: "I get wetter as I dry you. What am I?",
    },
  ])("a clean-looking but missing $label receives one reviewed recovery with the actual outcome", async ({ outcome, text }) => {
    const promise = "I can drop that here if you're ready to look at it.";
    const { client, bodies } = scriptedClient([
      candidate(promise), review(missing(outcome)), candidate(text), review(delivered(outcome, text)),
    ]);
    const request = ownerRequest();
    const result = await client.generateScene(request);

    expect(result).toEqual([expect.objectContaining({ personaId: sana.id, content: text })]);
    expect(result.some((line) => line.content === promise)).toBe(false);
    expect(bodies).toHaveLength(4);
    expect(contentLimit(bodies[0])).toBe(360);
    expect(contentLimit(bodies[2])).toBe(2_000);
    expect(sceneData(bodies[1]).candidates[0].mustFulfillRequest).toBe(true);
    expect(sceneData(bodies[2]).requestDeliveryRecovery).toEqual({ [sana.id]: { resolvedOutcome: outcome } });
    expect(sceneData(bodies[2]).premise).toContain("unfulfilled_explicit_request");
    expect(bodies[2].messages[1].content).not.toContain(promise);
    expect(request.requestDeliveryRecovery).toBeUndefined();
    expect(result[0]).not.toHaveProperty("requestDeliveryRecovery");
    expect(result[0]).not.toHaveProperty("resolvedOutcome");
  });

  it("never publishes an owner candidate when the reviewer omits its required assessment", async () => {
    const first = "I can send it now.";
    const second = "I'm ready whenever you are.";
    const { client, bodies } = scriptedClient([candidate(first), review(), candidate(second), review()]);
    expect(await client.generateScene(ownerRequest())).toEqual([]);
    expect(bodies).toHaveLength(4);
    expect(sceneData(bodies[2]).requestDeliveryRecovery).toEqual({});
  });

  it("stops after one full-scene retry when the second draft also only promises", async () => {
    const outcome = "Give the promised explanation now.";
    const budget = { retriesRemaining: 1 };
    const { client, bodies } = scriptedClient([
      candidate("I can explain that next."), review(missing(outcome)),
      candidate("I'll put the explanation together for you."), review(missing(outcome)),
    ]);
    expect(await client.generateScene(ownerRequest({ responseRecoveryBudget: budget }))).toEqual([]);
    expect(bodies).toHaveLength(4);
    expect(budget.retriesRemaining).toBe(0);
  });

  it("uses the existing two model calls when the first draft already delivers", async () => {
    const text = "A copy has a separate outer array; pushing into it doesn't change the original.";
    const { client, bodies } = scriptedClient([
      candidate(text), review(delivered("Explain the effect of pushing into an array copy.", text)),
    ]);
    expect(await client.generateScene(ownerRequest())).toEqual([expect.objectContaining({ content: text })]);
    expect(bodies).toHaveLength(2);
    expect(sceneData(bodies[0]).requestDeliveryRecovery).toEqual({});
  });

  it("accepts a real missing-input constraint without forcing invented delivery", async () => {
    const text = "I don't have your paragraph yet. Paste it here and I can shorten that exact text.";
    const { client, bodies } = scriptedClient([
      candidate(text), review({
        status: "constrained", resolvedOutcome: "Shorten the visitor's paragraph.", deliveredExcerpt: text,
      }),
    ]);
    expect(await client.generateScene(ownerRequest({
      history: [], trigger: { author: "Synthetic visitor", content: "Shorten my paragraph, please." },
    }))).toEqual([expect.objectContaining({ content: text })]);
    expect(bodies).toHaveLength(2);
  });

  it("does not turn an unrelated greeting and an old private commitment into a current delivery duty", async () => {
    const text = "Hey, good to see you back!";
    const { client, bodies } = scriptedClient([candidate(text), review({
      status: "not_due", resolvedOutcome: null, deliveredExcerpt: null,
    })]);
    expect(await client.generateScene(ownerRequest({
      requestOwnerIds: [],
      trigger: { author: "Synthetic visitor", content: "Hi again!" },
      relationshipNotes: { [sana.id]: "Earlier I offered to explain copying arrays. That conversation may be settled." },
      requestDeliveryRecovery: { [sana.id]: { resolvedOutcome: "A stale recovery that must not create ownership." } },
    }))).toEqual([expect.objectContaining({ content: text })]);
    expect(bodies).toHaveLength(2);
    expect(sceneData(bodies[0]).requestDeliveryRecovery).toEqual({});
    expect(sceneData(bodies[1]).candidates[0].mustFulfillRequest).toBe(false);
    expect(contentLimit(bodies[0])).toBe(360);
  });

  it("gives verified missing text delivery room for the whole result, then restores ordinary limits", async () => {
    const outcome = "Explain when an array copy protects the original and when nested values remain shared.";
    const later = "Exactly, that distinction is the useful bit.";
    const { client, bodies } = scriptedClient([
      candidate("I can explain that distinction in a moment."), review(missing(outcome)),
      candidate(completeExplanation), review(delivered(outcome, completeExplanation)),
      candidate(later), review(),
    ]);
    expect(completeExplanation.length).toBeGreaterThan(360);
    expect(completeExplanation.split(" ").length).toBeGreaterThan(sana.style.hardMaxWords);
    expect(completeExplanation.split(" ").length).toBeLessThanOrEqual(120);
    const result = await client.generateScene(ownerRequest());
    expect(result).toEqual([expect.objectContaining({ content: completeExplanation })]);
    expect(contentLimit(bodies[0])).toBe(360);
    expect(contentLimit(bodies[2])).toBe(2_000);
    expect(bodies[2].messages[0].content).toContain("hard maximum 120 words");
    expect(await client.generateScene(ownerRequest({
      requestOwnerIds: [], history: [], trigger: { author: "Synthetic visitor", content: "That makes sense." },
    }))).toEqual([expect.objectContaining({ content: later })]);
    expect(contentLimit(bodies[4])).toBe(360);
    expect(bodies[4].messages[0].content).toContain(`hard maximum ${sana.style.hardMaxWords} words`);
    expect(bodies[4].messages[0].content).not.toContain("hard maximum 120 words");
    expect(bodies).toHaveLength(6);
  });

  it("keeps the widened recovery bounded to 120 prose words", async () => {
    const outcome = "Explain copying an array.";
    const excessiveExplanation = `${completeExplanation} You can check this with a tiny test before changing any application code. Print the original values, make your proposed update, and print them again. The original should remain unchanged if you copied everything that the update touches.`;
    expect(excessiveExplanation.length).toBeLessThan(2_000);
    expect(excessiveExplanation.split(" ").length).toBeGreaterThan(120);
    const { client, bodies } = scriptedClient([
      candidate("I can explain that shortly."), review(missing(outcome)),
      candidate(excessiveExplanation), review(delivered(outcome, excessiveExplanation)),
    ]);
    expect(await client.generateScene(ownerRequest())).toEqual([]);
    expect(bodies).toHaveLength(4);
    expect(contentLimit(bodies[2])).toBe(2_000);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("style_contract");
  });

  it.each(["detailed", "considered"] as const)("preserves an existing larger %s word budget instead of replacing it with recovery's 120 words", async (mode) => {
    const outcome = "Explain array copies and show how to validate that the previous state was preserved.";
    const text = `${completeExplanation} You can check this with a tiny test before changing any application code. Print the original values, make your proposed update, and print them again. The original should remain unchanged if you copied everything that the update touches.`;
    expect(text.split(" ").length).toBeGreaterThan(120);
    expect(text.split(" ").length).toBeLessThan(180);
    const { client, bodies } = scriptedClient([candidate(text), review(delivered(outcome, text))]);
    const request = ownerRequest({
      requestDeliveryRecovery: { [sana.id]: { resolvedOutcome: outcome } },
      responseRecoveryBudget: { retriesRemaining: 0 },
      wordLimits: { [sana.id]: { minimum: 125, maximum: 180 } },
      ...(mode === "detailed"
        ? { semanticContext: { ...ownerRequest().semanticContext, answerDepth: "detailed" } }
        : { conversationMode: "considered", consideredRole: "lead" }),
    });
    expect(await client.generateScene(request)).toEqual([expect.objectContaining({ content: text })]);
    expect(bodies).toHaveLength(2);
    expect(contentLimit(bodies[0])).toBe(MAX_PERSISTED_CHAT_MESSAGE_CHARACTERS);
    expect(sceneData(bodies[0]).wordLimits).toEqual({ [sana.id]: { minimum: 125, maximum: 180 } });
    expect(bodies[0].messages[0].content).not.toContain("hard maximum 120 words");
  });

  it("does not widen voice character or spoken word limits during the same recovery", async () => {
    const outcome = "Explain the difference between copying and mutating an array aloud.";
    const tooLongForVoice = "Copying an array creates a separate outer container, so adding numbers to the copy leaves the original unchanged, while changing a shared nested object still appears through both arrays.";
    expect(tooLongForVoice.length).toBeLessThan(360);
    expect(tooLongForVoice.split(" ").length).toBeGreaterThan(25);
    const { client, bodies } = scriptedClient([
      candidate("I can explain that."), review(missing(outcome)),
      candidate(tooLongForVoice), review(delivered(outcome, tooLongForVoice)),
    ]);
    expect(await client.generateScene(ownerRequest({ kind: "voice" }))).toEqual([]);
    expect(bodies).toHaveLength(4);
    expect(contentLimit(bodies[0])).toBe(360);
    expect(contentLimit(bodies[2])).toBe(360);
    expect(sceneData(bodies[2]).requestDeliveryRecovery).toEqual({ [sana.id]: { resolvedOutcome: outcome } });
    expect(bodies[2].messages[0].content).not.toContain("hard maximum 120 words");
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("style_contract");
  });

  it("scopes retry descriptions and private memory to their own resident", () => {
    const request = ownerRequest({
      selected: [sana, mira],
      mustReplyIds: [sana.id, mira.id],
      requestOwnerIds: [sana.id, mira.id],
      requestDeliveryRecovery: {
        [sana.id]: { resolvedOutcome: "Sana's requested explanation." },
        [mira.id]: { resolvedOutcome: "Mira's private requested poem." },
      },
      relationshipNotes: { [sana.id]: "Sana's memory", [mira.id]: "Mira's memory" },
    });
    const scoped = actorSubsetSceneRequest(request, [sana], true);
    expect(scoped.requestDeliveryRecovery).toEqual({ [sana.id]: { resolvedOutcome: "Sana's requested explanation." } });
    expect(scoped.relationshipNotes).toEqual({ [sana.id]: "Sana's memory" });
    expect(scoped.requestOwnerIds).toEqual([sana.id]);
  });

  it("does not carry recovery feedback into a later independent scene on the same client", async () => {
    const outcome = "Give a short riddle.";
    const riddle = "What has keys but no locks? A piano.";
    const later = "Glad that one landed.";
    const { client, bodies } = scriptedClient([
      candidate("I can think of a riddle for you."), review(missing(outcome)),
      candidate(riddle), review(delivered(outcome, riddle)),
      candidate(later), review(),
    ]);
    expect(await client.generateScene(ownerRequest())).toHaveLength(1);
    expect(await client.generateScene(ownerRequest({
      requestOwnerIds: [], history: [], trigger: { author: "Synthetic visitor", content: "Nice one!" },
    }))).toEqual([expect.objectContaining({ content: later })]);
    expect(bodies).toHaveLength(6);
    expect(sceneData(bodies[4]).requestDeliveryRecovery).toEqual({});
    expect(bodies[4].messages[1].content).not.toContain(outcome);
  });
});
