import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConversationContext } from "./conversationFlow.js";
import { normalizeConversationResearchInput, type ConversationResearchInput } from "./conversationResearch.js";
import { BackgroundWorkPreemptedError, LmStudioClient } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";

const clients: LmStudioClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.cancelPending("research test complete");
  await Promise.resolve();
  vi.restoreAllMocks();
});

const publicInput = (channelId = "stock-market"): ConversationResearchInput => ({
  channelId, channelName: channelId, roomTopic: "Public businesses and current reports",
  resident: { id: "ai-linnea", name: "Linnea", interests: ["sources", "business"] },
  conversation: buildConversationContext({
    phase: "continuation", rootMessageId: "known-public-message",
    messages: [{ messageId: "known-public-message", authorId: "ai-vale", author: "Vale", kind: "ai", content: "Do we have Nintendo's annual report to check licensing revenue?", createdAt: "2026-10-12T10:00:00.000Z" }],
  }),
});
const lookup = { sourceMessageId: "known-public-message", query: "Nintendo latest annual report licensing revenue", question: "What does the annual report say about licensing revenue?", mode: "web" };
const response = (value: unknown) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const makeClient = (complete: ModelBackend["complete"], options: { maxConcurrentPredictions?: number; maxBackgroundPredictions?: number } = {}) => {
  const probe = vi.fn(async () => ({ connected: true, id: "test-model", label: "test model" }));
  const backend: ModelBackend = { providerId: "lmstudio", configuredModel: "test-model", probe, complete };
  const client = new LmStudioClient({ backend, maxConcurrentPredictions: 1, maxBackgroundPredictions: 1, ...options });
  clients.push(client);
  return { client, probe };
};
const handled = <T>(promise: Promise<T>): Promise<T> => {
  void promise.catch(() => undefined);
  return promise;
};
const blockingBackend = () => {
  const pending: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  const complete = vi.fn((_body: Record<string, unknown>, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const settle = (value: unknown) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    pending.push({ signal, resolve: settle });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }));
  return { complete, pending };
};

describe("LM Studio public conversation lookup decisions", () => {
  it("sends only allowlisted public fields, asks for a decision and emits no scene/review calls", async () => {
    const complete = vi.fn(async () => response({ lookup }));
    const { client, probe } = makeClient(complete);
    const clean = publicInput();
    const dirty = {
      ...clean, actorSocialMemory: "PRIVATE_MEMORY", actorRelationshipNotes: "PRIVATE_RELATIONSHIP", research: "PRIVATE_SOURCE",
      resident: { ...clean.resident, prompt: "PRIVATE_PERSONA_PROMPT" },
      conversation: {
        ...clean.conversation, privateNotes: "PRIVATE_NOTES",
        publishedTurns: clean.conversation.publishedTurns.map((row) => ({ ...row, privateMemory: "PRIVATE_ROW" })),
      },
    };
    await expect(client.planConversationResearch(dirty)).resolves.toEqual(lookup);
    expect(probe).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    const body = complete.mock.calls[0]![0] as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(JSON.parse(messages[1]!.content)).toEqual(normalizeConversationResearchInput(clean));
    expect(JSON.stringify(body)).not.toContain("PRIVATE_");
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(body).toMatchObject({ max_tokens: 300, reasoning_effort: "none", response_format: { json_schema: { name: "conversation_research_choice" } } });
    await vi.waitFor(() => expect(client.health()).toMatchObject({ activePredictions: 0, activeBackgroundPredictions: 0, queueDepth: 0 }));
  });

  it("does not probe or generate when normalization leaves no public rows", async () => {
    const complete = vi.fn(async () => response({ lookup }));
    const { client, probe } = makeClient(complete);
    const input = publicInput();
    input.conversation = { phase: "continuation", publishedTurns: [] };
    await expect(client.planConversationResearch(input)).resolves.toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(client.health().queueDepth).toBe(0);
  });

  it.each([
    { lookup: null },
    { lookup: { ...lookup, sourceMessageId: "unknown" } },
    { lookup, messages: [{ content: "Do not publish this" }] },
    { lookup: { ...lookup, mode: "anything" } },
  ])("fails closed or accepts abstention without generating a fallback scene (%#)", async (value) => {
    const complete = vi.fn(async () => response(value));
    const { client } = makeClient(complete);
    await expect(client.planConversationResearch(publicInput())).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("accounts decisions as bounded background work and releases the next queued decision", async () => {
    const { complete, pending } = blockingBackend();
    const { client } = makeClient(complete, { maxConcurrentPredictions: 2, maxBackgroundPredictions: 1 });
    const first = handled(client.planConversationResearch(publicInput("stock-market")));
    const second = handled(client.planConversationResearch(publicInput("football-talk")));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(client.health()).toMatchObject({ activePredictions: 1, activeBackgroundPredictions: 1, queueDepth: 2 });
    pending[0]!.resolve(response({ lookup: null }));
    await expect(first).resolves.toBeNull();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(client.health()).toMatchObject({ activePredictions: 1, activeBackgroundPredictions: 1, queueDepth: 1 });
    pending[1]!.resolve(response({ lookup }));
    await expect(second).resolves.toEqual(lookup);
    await vi.waitFor(() => expect(client.health()).toMatchObject({ activePredictions: 0, activeBackgroundPredictions: 0, queueDepth: 0 }));
  });

  it("cancels a queued decision without starting its backend call", async () => {
    const { complete, pending } = blockingBackend();
    const { client } = makeClient(complete);
    const first = handled(client.planConversationResearch(publicInput()));
    const abort = new AbortController();
    const queued = handled(client.planConversationResearch(publicInput("lobby"), abort.signal));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    abort.abort(new Error("conversation moved on"));
    await expect(queued).rejects.toThrow("conversation moved on");
    expect(complete).toHaveBeenCalledTimes(1);
    pending[0]!.resolve(response({ lookup: null }));
    await expect(first).resolves.toBeNull();
    await vi.waitFor(() => expect(client.health().queueDepth).toBe(0));
  });

  it("propagates active cancellation and releases background capacity", async () => {
    const { complete, pending } = blockingBackend();
    const { client } = makeClient(complete);
    const abort = new AbortController();
    const result = handled(client.planConversationResearch(publicInput(), abort.signal));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    abort.abort(new Error("room closed"));
    await expect(result).rejects.toThrow("room closed");
    expect(pending[0]!.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(client.health()).toMatchObject({ activePredictions: 0, activeBackgroundPredictions: 0, queueDepth: 0 }));
  });

  it("rejects already-cancelled work before making a backend request", async () => {
    const complete = vi.fn(async () => response({ lookup: null }));
    const { client } = makeClient(complete);
    const abort = new AbortController();
    abort.abort(new Error("stale before admission"));
    await expect(client.planConversationResearch(publicInput(), abort.signal)).rejects.toThrow("stale before admission");
    expect(complete).not.toHaveBeenCalled();
    expect(client.health().queueDepth).toBe(0);
  });

  it("yields active lookup planning to a live public scene through the shared queue", async () => {
    const blocker = blockingBackend();
    const complete = vi.fn((body: Record<string, unknown>, signal: AbortSignal) => {
      const name = (body.response_format as { json_schema?: { name?: string } })?.json_schema?.name;
      return name === "conversation_research_choice" ? blocker.complete(body, signal) : Promise.resolve(response({ messages: [] }));
    });
    const { client } = makeClient(complete);
    const background = handled(client.planConversationResearch(publicInput()));
    await vi.waitFor(() => expect(blocker.pending).toHaveLength(1));
    const foreground = client.generateScene({ kind: "public", channelId: "lobby", channelName: "lobby", selected: [PERSONAS[0]!], history: [] }, 1);
    await expect(background).rejects.toBeInstanceOf(BackgroundWorkPreemptedError);
    await expect(foreground).resolves.toEqual([]);
    expect(blocker.pending[0]!.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(client.health()).toMatchObject({ activePredictions: 0, activeBackgroundPredictions: 0, queueDepth: 0 }));
  });

  it("uses a bounded decision timeout, propagates expiry and releases the queue", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const { complete, pending } = blockingBackend();
    const { client } = makeClient(complete);
    const result = handled(client.planConversationResearch(publicInput()));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(timeoutSpy).toHaveBeenCalledWith(12_000);
    timeout.abort(new DOMException("lookup timed out", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(client.health()).toMatchObject({ activePredictions: 0, activeBackgroundPredictions: 0, queueDepth: 0 }));
  });

  it("includes model discovery in the same decision deadline", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const complete = vi.fn(async () => response({ lookup: null }));
    let probeSignal: AbortSignal | undefined;
    const probe = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      probeSignal = signal;
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }));
    const backend: ModelBackend = { providerId: "lmstudio", probe, complete };
    const client = new LmStudioClient({ backend, maxConcurrentPredictions: 1 });
    clients.push(client);
    const result = handled(client.planConversationResearch(publicInput()));
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(12_000);
    timeout.abort(new DOMException("model discovery timed out", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    expect(probeSignal?.aborted).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(client.health()).toMatchObject({ activePredictions: 0, activeBackgroundPredictions: 0, queueDepth: 0 }));
  });

  it("a provider failure does not strand a following research decision", async () => {
    const complete = vi.fn<ModelBackend["complete"]>()
      .mockRejectedValueOnce(new Error("provider offline"))
      .mockResolvedValueOnce(response({ lookup: null }));
    const { client } = makeClient(complete);
    const failed = handled(client.planConversationResearch(publicInput()));
    const next = handled(client.planConversationResearch(publicInput("lobby")));
    await expect(failed).rejects.toThrow("provider offline");
    await expect(next).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(client.health().queueDepth).toBe(0));
  });
});
