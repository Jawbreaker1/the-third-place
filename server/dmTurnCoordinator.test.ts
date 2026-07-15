import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DmTurnCancellationError,
  DmTurnCoordinator,
  TypingLeaseCounter,
  type DmTurn,
} from "./dmTurnCoordinator.js";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("TypingLeaseCounter", () => {
  it("keeps typing active until every idempotent lease is released", () => {
    const changes: Array<[string, boolean]> = [];
    const counter = new TypingLeaseCounter<string>((key, active) => changes.push([key, active]));
    const first = counter.acquire("dm-1");
    const second = counter.acquire("dm-1");

    expect(counter.count("dm-1")).toBe(2);
    expect(changes).toEqual([["dm-1", true]]);

    first.release();
    first.release();
    expect(first.released).toBe(true);
    expect(counter.count("dm-1")).toBe(1);
    expect(changes).toEqual([["dm-1", true]]);

    second.release();
    second.release();
    expect(counter.isActive("dm-1")).toBe(false);
    expect(changes).toEqual([["dm-1", true], ["dm-1", false]]);
  });

  it("invalidates outstanding leases safely when a key is cleared", () => {
    const changes: boolean[] = [];
    const counter = new TypingLeaseCounter<string>((_, active) => changes.push(active));
    const stale = counter.acquire("dm-1");

    counter.clear("dm-1");
    const current = counter.acquire("dm-1");
    stale.release();

    expect(counter.count("dm-1")).toBe(1);
    current.release();
    expect(changes).toEqual([true, false, true, false]);
  });
});

describe("DmTurnCoordinator", () => {
  it("debounces a per-thread burst for 700 ms and preserves enqueue order", async () => {
    vi.useFakeTimers();
    const generated: Array<readonly string[]> = [];
    const published: string[] = [];
    const typing: boolean[] = [];
    const coordinator = new DmTurnCoordinator<string, string>({
      generate: async (turn) => {
        generated.push(turn.messages);
        return turn.messages.join(" | ");
      },
      publish: (result) => published.push(result),
      onTypingChange: (_, active) => typing.push(active),
    });

    coordinator.enqueue("dm-1", "first");
    await vi.advanceTimersByTimeAsync(400);
    coordinator.enqueue("dm-1", "second");
    await vi.advanceTimersByTimeAsync(699);

    expect(generated).toEqual([]);
    expect(coordinator.snapshot("dm-1")).toMatchObject({
      epoch: 2,
      pendingCount: 2,
      unansweredCount: 0,
      debounceScheduled: true,
      typing: true,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(generated).toEqual([["first", "second"]]);
    expect(published).toEqual(["first | second"]);
    expect(typing).toEqual([true, false]);
  });

  it("keeps independent debounce clocks for different DM threads", async () => {
    vi.useFakeTimers();
    const starts: Array<[string, readonly string[]]> = [];
    const coordinator = new DmTurnCoordinator<string, string>({
      debounceMs: 500,
      generate: async (turn) => {
        starts.push([turn.token.threadId, turn.messages]);
        return turn.token.threadId;
      },
      publish: () => undefined,
    });

    coordinator.enqueue("dm-a", "a1");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.enqueue("dm-b", "b1");
    await vi.advanceTimersByTimeAsync(200);
    expect(starts).toEqual([["dm-a", ["a1"]]]);

    await vi.advanceTimersByTimeAsync(300);
    expect(starts).toEqual([
      ["dm-a", ["a1"]],
      ["dm-b", ["b1"]],
    ]);
  });

  it("supersedes slow work, requeues its messages, and gates stale publication", async () => {
    const turns: Array<DmTurn<string>> = [];
    const results: Array<ReturnType<typeof deferred<string>>> = [];
    const published: Array<{ result: string; epoch: number }> = [];
    const coordinator = new DmTurnCoordinator<string, string>({
      generate: (turn) => {
        turns.push(turn);
        const result = deferred<string>();
        results.push(result);
        return result.promise;
      },
      publish: (result, turn) => published.push({ result, epoch: turn.token.epoch }),
    });

    coordinator.enqueue("dm-1", "first");
    const firstCompletion = coordinator.flush("dm-1");
    expect(turns[0]?.messages).toEqual(["first"]);
    expect(turns[0]?.isCurrent()).toBe(true);

    coordinator.enqueue("dm-1", "second");
    expect(turns[0]?.signal.aborted).toBe(true);
    expect(turns[0]?.signal.reason).toBeInstanceOf(DmTurnCancellationError);
    expect((turns[0]?.signal.reason as DmTurnCancellationError).kind).toBe("superseded");
    expect(coordinator.snapshot("dm-1").pendingCount).toBe(2);

    const secondCompletion = coordinator.flush("dm-1");
    expect(turns[1]?.messages).toEqual(["first", "second"]);
    expect(turns[1]!.token.epoch).toBeGreaterThan(turns[0]!.token.epoch);
    expect(turns[1]!.token.generationId).toBeGreaterThan(turns[0]!.token.generationId);

    // The first generator deliberately ignores AbortSignal and resolves late.
    results[0]!.resolve("stale");
    await firstCompletion;
    expect(published).toEqual([]);

    results[1]!.resolve("current");
    await secondCompletion;
    expect(published).toEqual([{ result: "current", epoch: turns[1]!.token.epoch }]);
  });

  it("explicit supersede retries the unpublished batch without duplicating it", async () => {
    const turns: Array<DmTurn<{ id: number }>> = [];
    const gates: Array<ReturnType<typeof deferred<string>>> = [];
    const published: string[] = [];
    const coordinator = new DmTurnCoordinator<{ id: number }, string>({
      generate: (turn) => {
        turns.push(turn);
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
      publish: (result) => published.push(result),
    });

    const message = { id: 1 };
    coordinator.enqueue("dm-1", message);
    const first = coordinator.flush("dm-1");
    expect(coordinator.supersede("dm-1")).toBe(true);
    const second = coordinator.flush("dm-1");

    expect(turns.map((turn) => turn.messages)).toEqual([[message], [message]]);
    gates[1]!.resolve("replacement");
    await second;
    gates[0]!.resolve("old");
    await first;
    expect(published).toEqual(["replacement"]);
  });

  it("cancel aborts active work, discards the burst, and clears typing", async () => {
    const gate = deferred<string>();
    let activeTurn: DmTurn<string> | undefined;
    const published = vi.fn();
    const typing: boolean[] = [];
    const coordinator = new DmTurnCoordinator<string, string>({
      generate: (turn) => {
        activeTurn = turn;
        return gate.promise;
      },
      publish: published,
      onTypingChange: (_, active) => typing.push(active),
    });

    coordinator.enqueue("dm-1", "discard me");
    const completion = coordinator.flush("dm-1");
    expect(coordinator.cancel("dm-1")).toBe(true);
    expect(activeTurn?.signal.aborted).toBe(true);
    expect((activeTurn?.signal.reason as DmTurnCancellationError).kind).toBe("cancelled");
    expect(coordinator.snapshot("dm-1")).toMatchObject({
      pendingCount: 0,
      unansweredCount: 0,
      debounceScheduled: false,
      typing: false,
    });

    gate.resolve("too late");
    await completion;
    expect(published).not.toHaveBeenCalled();
    expect(typing).toEqual([true, false]);
  });

  it("holds one typing lease continuously across debounce and superseded work", async () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const gates: Array<ReturnType<typeof deferred<string>>> = [];
    const coordinator = new DmTurnCoordinator<string, string>({
      debounceMs: 100,
      generate: () => {
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
      publish: () => undefined,
      onTypingChange: (_, active) => changes.push(active),
    });

    coordinator.enqueue("dm-1", "one");
    expect(changes).toEqual([true]);
    await vi.advanceTimersByTimeAsync(100);
    coordinator.enqueue("dm-1", "two");
    gates[0]!.resolve("stale");
    await Promise.resolve();
    expect(changes).toEqual([true]);

    await vi.advanceTimersByTimeAsync(100);
    gates[1]!.resolve("fresh");
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([true, false]);
  });

  it("retains current errors and undefined results until the next enqueue, exactly once", async () => {
    const failure = new Error("generation failed");
    const errors: unknown[] = [];
    const generatedBatches: Array<readonly string[]> = [];
    const published: Array<{ result: string; messages: readonly string[] }> = [];
    let calls = 0;
    const coordinator = new DmTurnCoordinator<string, string>({
      generate: async (turn) => {
        generatedBatches.push(turn.messages);
        calls += 1;
        if (calls === 1) throw failure;
        if (calls === 2) return undefined;
        return "answered";
      },
      publish: (result, turn) => published.push({ result, messages: turn.messages }),
      onError: (error) => errors.push(error),
    });

    coordinator.enqueue("dm-1", "first");
    await coordinator.flush("dm-1");
    expect(coordinator.snapshot("dm-1")).toMatchObject({
      pendingCount: 0,
      unansweredCount: 1,
      debounceScheduled: false,
      typing: false,
    });

    const revived = coordinator.enqueue("dm-1", "second");
    coordinator.enqueue("dm-1", "third");
    expect(revived.pendingCount).toBe(2);
    expect(coordinator.snapshot("dm-1")).toMatchObject({ pendingCount: 3, unansweredCount: 0 });
    await coordinator.flush("dm-1");
    expect(coordinator.snapshot("dm-1")).toMatchObject({
      pendingCount: 0,
      unansweredCount: 3,
      debounceScheduled: false,
      typing: false,
    });

    coordinator.enqueue("dm-1", "fourth");
    await coordinator.flush("dm-1");

    expect(errors).toEqual([failure]);
    expect(generatedBatches).toEqual([
      ["first"],
      ["first", "second", "third"],
      ["first", "second", "third", "fourth"],
    ]);
    expect(published).toEqual([{
      result: "answered",
      messages: ["first", "second", "third", "fourth"],
    }]);
    expect(coordinator.snapshot("dm-1").unansweredCount).toBe(0);
    expect(coordinator.snapshot("dm-1").typing).toBe(false);
  });

  it("cancel and dispose discard dormant unanswered bursts", async () => {
    const cancelled = new DmTurnCoordinator<string, string>({
      generate: async () => undefined,
      publish: () => undefined,
    });
    cancelled.enqueue("dm-cancel", "unanswered");
    await cancelled.flush("dm-cancel");
    expect(cancelled.snapshot("dm-cancel").unansweredCount).toBe(1);
    expect(cancelled.cancel("dm-cancel")).toBe(true);
    expect(cancelled.snapshot("dm-cancel").unansweredCount).toBe(0);

    const disposed = new DmTurnCoordinator<string, string>({
      generate: async () => undefined,
      publish: () => undefined,
    });
    disposed.enqueue("dm-dispose", "unanswered");
    await disposed.flush("dm-dispose");
    expect(disposed.snapshot("dm-dispose").unansweredCount).toBe(1);
    disposed.dispose();
    expect(disposed.snapshot("dm-dispose").unansweredCount).toBe(0);
  });

  it("does not duplicate a failed burst when onError enqueues re-entrantly", async () => {
    const batches: Array<readonly string[]> = [];
    const published: string[] = [];
    let calls = 0;
    let coordinator!: DmTurnCoordinator<string, string>;
    coordinator = new DmTurnCoordinator<string, string>({
      generate: async (turn) => {
        batches.push(turn.messages);
        calls += 1;
        if (calls === 1) throw new Error("failed");
        return "recovered";
      },
      publish: (result) => published.push(result),
      onError: () => {
        coordinator.enqueue("dm-1", "follow-up");
      },
    });

    coordinator.enqueue("dm-1", "original");
    await coordinator.flush("dm-1");
    expect(coordinator.snapshot("dm-1")).toMatchObject({
      pendingCount: 2,
      unansweredCount: 0,
    });
    await coordinator.flush("dm-1");

    expect(batches).toEqual([
      ["original"],
      ["original", "follow-up"],
    ]);
    expect(published).toEqual(["recovered"]);
  });

  it("dispose suppresses late publication and rejects new input", async () => {
    const gate = deferred<string>();
    const published = vi.fn();
    const coordinator = new DmTurnCoordinator<string, string>({
      generate: () => gate.promise,
      publish: published,
    });

    coordinator.enqueue("dm-1", "one");
    const completion = coordinator.flush("dm-1");
    coordinator.dispose();
    gate.resolve("late");
    await completion;

    expect(published).not.toHaveBeenCalled();
    expect(() => coordinator.enqueue("dm-1", "two")).toThrow(/disposed/u);
  });

  it("validates configuration and thread identity without inspecting message text", () => {
    expect(() => new DmTurnCoordinator<string, string>({
      debounceMs: -1,
      generate: async () => "unused",
      publish: () => undefined,
    })).toThrow(RangeError);

    const coordinator = new DmTurnCoordinator<string, string>({
      generate: async () => "unused",
      publish: () => undefined,
    });
    expect(() => coordinator.enqueue("   ", "any language: こんにちは مرحبا hej")).toThrow(TypeError);
  });
});
