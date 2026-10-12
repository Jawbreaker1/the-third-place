import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LmStudioClient, type SceneRequest } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";
import { boundedSceneTranscript } from "./sceneTranscript.js";

const persona = PERSONAS.find((entry) => entry.id === "ai-mira")!;
const content = "A copied array has its own outer container, so adding an item leaves the original alone.";
const completion = (body: unknown) => ({ choices: [{ message: { content: JSON.stringify(body) } }] });
const review = (reject: boolean) => completion({ reviews: [{
  personaId: persona.id, severity: reject ? "high" : "none", issues: reject ? ["evidence_ungrounded"] : [],
  rewriteInstruction: reject ? "Remove unsupported details." : null,
  sameSceneOverlap: "none", outputLanguage: { tag: "und", confidence: 0 },
}] });
const scene = (): SceneRequest => ({
  kind: "public", channelId: "ai-programming", channelName: "ai-programming", selected: [persona], history: [],
  trigger: { author: "Private user", authorKind: "human", content: "Private trigger", messageId: "diagnostic-trigger" },
  semanticContext: { languageTag: "en", intentTrusted: true, replyExpected: "optional", asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
  humanizerBudget: { repairsRemaining: 0 }, responseRecoveryBudget: { retriesRemaining: 0 },
});
const fixture = (responses: unknown[]) => {
  const calls: unknown[] = [];
  const backend: ModelBackend = {
    providerId: "lmstudio", configuredModel: "diagnostic-fixture",
    probe: async () => ({ connected: true, id: "diagnostic-fixture" }),
    complete: async (body) => {
      calls.push(body);
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected model request");
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { client: new LmStudioClient({ backend }), calls };
};
const blockedFixture = () => {
  const complete = vi.fn(async (_body: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const backend: ModelBackend = {
    providerId: "lmstudio", configuredModel: "blocked-diagnostic-fixture",
    probe: async () => ({ connected: true, id: "blocked-diagnostic-fixture" }), complete,
  };
  return { client: new LmStudioClient({ backend, maxConcurrentPredictions: 1 }), complete };
};
const identifiedScene = (messageId: string): SceneRequest => {
  const request = scene();
  return { ...request, trigger: { ...request.trigger!, authorId: "diagnostic-human", messageId } };
};
const queueTerminalOutcomes = (triggerMessageId: string) => logged.filter((entry) =>
  entry.triggerMessageId === triggerMessageId && entry.stage === "queue" && entry.outcome !== "started",
).map((entry) => entry.outcome);
let logged: Record<string, unknown>[];
beforeEach(() => {
  logged = [];
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
  vi.stubEnv("HUMANIZER_REPAIR_ENABLED", "false");
  vi.spyOn(console, "info").mockImplementation((line) => {
    const entry = JSON.parse(String(line));
    if (entry.event === "interactive_turn") logged.push(entry);
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("model pipeline diagnostic outcomes", () => {
  it("distinguishes deliberate empty output and preserves optional silence without recovery", async () => {
    const { client, calls } = fixture([completion({ messages: [] })]);
    expect(await client.generateScene(scene())).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(logged).toContainEqual(expect.objectContaining({ stage: "draft", outcome: "abstained", candidateCount: 0 }));
    expect(logged.some((entry) => entry.stage === "recovery")).toBe(false);
  });

  it("distinguishes reviewer rejection from voluntary silence without relaxing the gate", async () => {
    const { client, calls } = fixture([completion({ messages: [{ personaId: persona.id, content, sourceIds: [] }] }), review(true)]);
    expect(await client.generateScene(scene())).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(logged).toContainEqual(expect.objectContaining({ stage: "review", reviewIssues: ["evidence_ungrounded"] }));
    expect(logged).toContainEqual(expect.objectContaining({ stage: "filter", outcome: "rejected", acceptedCount: 0 }));
    expect(logged.every((entry) => entry.triggerMessageId === "diagnostic-trigger" && entry.channelId === "ai-programming")).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(content);
    expect(JSON.stringify(logged)).not.toContain("Private");
  });

  it("records queue and stage durations while preserving an approved reply byte-for-byte", async () => {
    const { client } = fixture([completion({ messages: [{ personaId: persona.id, content, sourceIds: [] }] }), review(false)]);
    expect(await client.generateScene(scene())).toEqual([expect.objectContaining({ content })]);
    expect(logged).toContainEqual(expect.objectContaining({ stage: "queue", outcome: "started", queueWaitMs: expect.any(Number) }));
    expect(logged).toContainEqual(expect.objectContaining({ stage: "generation", outcome: "completed", durationMs: expect.any(Number) }));
    expect(logged).toContainEqual(expect.objectContaining({ stage: "filter", outcome: "completed", acceptedCount: 1 }));
  });

  it("reports transport failure without storing raw error text", async () => {
    const { client } = fixture([new Error("transport token=secret")]);
    await expect(client.generateScene(scene())).rejects.toThrow("transport token=secret");
    expect(logged).toContainEqual(expect.objectContaining({ stage: "queue", outcome: "failed" }));
    expect(JSON.stringify(logged)).not.toContain("secret");
  });

  it("counts only the bounded transcript actually supplied rather than all input history", async () => {
    const request = scene();
    request.history = Array.from({ length: 40 }, (_, index) => ({
      messageId: `history-${index}`, author: "Guest", kind: "human" as const,
      content: "Quoted history ".repeat(200), createdAt: new Date(1_000 * index).toISOString(),
    }));
    const { client } = fixture([completion({ messages: [] })]);
    await client.generateScene(request);
    expect(logged).toContainEqual(expect.objectContaining({
      stage: "generation", historyTurns: boundedSceneTranscript(request.history).length,
    }));
    expect(logged.find((entry) => entry.stage === "generation")?.historyTurns).toBeLessThan(28);
  });

  it("does not label malformed output as intentional abstention", async () => {
    const { client } = fixture([{ choices: [{ message: { content: "{malformed private output" } }] }]);
    await expect(client.generateScene(scene())).rejects.toThrow();
    expect(logged).toContainEqual(expect.objectContaining({ stage: "draft", outcome: "invalid_output" }));
    expect(logged.some((entry) => entry.outcome === "abstained")).toBe(false);
    expect(JSON.stringify(logged)).not.toContain("private output");
  });

  it("distinguishes external cancellation before admission from model refusal", async () => {
    const { client, calls } = fixture([]);
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    await expect(client.generateScene(scene(), 2, controller.signal)).rejects.toThrow("private cancellation reason");
    expect(calls).toHaveLength(0);
    expect(logged).toContainEqual(expect.objectContaining({ stage: "queue", outcome: "cancelled" }));
    expect(JSON.stringify(logged)).not.toContain("private cancellation reason");
  });

  it("records queued supersession once without relabeling its original Error as transport failure", async () => {
    const { client, complete } = blockedFixture();
    const active = client.generateScene(identifiedScene("active")).catch((error: unknown) => error);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const queued = client.generateScene(identifiedScene("queued")).catch((error: unknown) => error);
    (client as unknown as { dropQueuedStaleScenes(channel: string, kind: string, actor: string, reason: string): void })
      .dropQueuedStaleScenes("ai-programming", "public", "diagnostic-human", "unchanged supersession reason");
    expect(await queued).toEqual(new Error("unchanged supersession reason"));
    expect(queueTerminalOutcomes("queued")).toEqual(["superseded"]);
    client.cancelPending();
    await active;
  });

  it("records a public lane yielding to voice as deferred without a second failed outcome", async () => {
    const { client, complete } = blockedFixture();
    const active = client.generateScene(identifiedScene("voice-preempted")).catch((error: unknown) => error);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect((client as unknown as { preemptOneActivePublicTextForVoice(reason: string): boolean })
      .preemptOneActivePublicTextForVoice("unchanged voice preemption reason")).toBe(true);
    expect(await active).toEqual(new Error("unchanged voice preemption reason"));
    expect(queueTerminalOutcomes("voice-preempted")).toEqual(["deferred"]);
    client.cancelPending();
  });

  it("records queue admission capacity separately and preserves the admission error", async () => {
    const { client, complete } = blockedFixture();
    const work = [client.generateScene(identifiedScene("active-capacity")).catch((error: unknown) => error)];
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    for (let index = 0; index < 8; index += 1) {
      work.push(client.generateScene(identifiedScene(`queued-${index}`)).catch((error: unknown) => error));
    }
    await expect(client.generateScene(identifiedScene("over-capacity"))).rejects.toThrow("The local inference queue is full");
    expect(queueTerminalOutcomes("over-capacity")).toEqual(["capacity_limited"]);
    client.cancelPending();
    await Promise.all(work);
  });
});
