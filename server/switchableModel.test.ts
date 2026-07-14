import { describe, expect, it, vi } from "vitest";
import type { LmStudioClient } from "./lmStudio.js";
import { SwitchableSocialModel } from "./switchableModel.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const fakeClient = (name: string) => ({
  probe: vi.fn(async () => ({ connected: true, id: name, label: name })),
  health: vi.fn((label?: string) => ({ connected: true, id: name, label: label ?? name })),
  analyzeTurn: vi.fn(async () => ({ provider: name })),
  analyzeMemoryTurn: vi.fn(async () => ({ provider: name })),
  generateScene: vi.fn(async () => [{ personaId: name, content: "hello", sourceIds: [] }]),
  analyzeImage: vi.fn(async () => ({ summary: name, details: [], safety: "safe" })),
  rememberDeliveredLine: vi.fn(),
  cancelPending: vi.fn(),
}) as unknown as LmStudioClient;

describe("SwitchableSocialModel", () => {
  it("routes every operation to the active provider and annotates health consistently", async () => {
    const lmstudio = fakeClient("local-gemma");
    const codex = fakeClient("gpt-5.6-luna");
    const model = new SwitchableSocialModel({ lmstudio, codex });

    expect(model.activeProvider()).toBe("lmstudio");
    await expect(model.probe()).resolves.toMatchObject({ provider: "lmstudio", id: "local-gemma" });
    expect(model.health("Local model")).toMatchObject({ provider: "lmstudio", label: "Local model" });
    await model.analyzeTurn({ turnId: "turn" } as never);
    await model.analyzeMemoryTurn({ turnId: "memory" } as never);
    await model.generateScene({ kind: "ambient" } as never, 7);
    await model.analyzeImage(Buffer.from("image"), "caption", 3);

    expect(lmstudio.analyzeTurn).toHaveBeenCalledOnce();
    expect(lmstudio.analyzeMemoryTurn).toHaveBeenCalledOnce();
    expect(lmstudio.generateScene).toHaveBeenCalledWith({ kind: "ambient" }, 7, undefined);
    expect(lmstudio.analyzeImage).toHaveBeenCalledWith(Buffer.from("image"), "caption", 3);
    expect(codex.analyzeTurn).not.toHaveBeenCalled();
  });

  it("cancels the previous provider and rejects an old in-flight result after switching", async () => {
    const lmstudio = fakeClient("local-gemma");
    const codex = fakeClient("gpt-5.6-luna");
    const pending = deferred<unknown>();
    vi.mocked(lmstudio.analyzeTurn).mockReturnValueOnce(pending.promise as never);
    const model = new SwitchableSocialModel({ lmstudio, codex });

    const oldResult = model.analyzeTurn({ turnId: "old-turn" } as never);
    model.select("codex", "admin switched provider");
    expect(model.activeProvider()).toBe("codex");
    expect(lmstudio.cancelPending).toHaveBeenCalledWith("admin switched provider");

    pending.resolve({ source: "stale local result" });
    await expect(oldResult).rejects.toThrow("AI provider changed before the result could be published");
    await model.analyzeTurn({ turnId: "new-turn" } as never);
    expect(codex.analyzeTurn).toHaveBeenCalledOnce();
  });

  it("does not cancel or invalidate work when selecting the already-active provider", async () => {
    const lmstudio = fakeClient("local-gemma");
    const codex = fakeClient("gpt-5.6-luna");
    const pending = deferred<unknown>();
    vi.mocked(lmstudio.analyzeTurn).mockReturnValueOnce(pending.promise as never);
    const model = new SwitchableSocialModel({ lmstudio, codex });

    const result = model.analyzeTurn({ turnId: "same-provider" } as never);
    model.select("lmstudio");
    pending.resolve({ source: "valid" });
    await expect(result).resolves.toEqual({ source: "valid" });
    expect(lmstudio.cancelPending).not.toHaveBeenCalled();
  });

  it("broadcasts delivered memory and global cancellation to both provider clients", () => {
    const lmstudio = fakeClient("local-gemma");
    const codex = fakeClient("gpt-5.6-luna");
    const model = new SwitchableSocialModel({ lmstudio, codex });
    const context = { kind: "public" as const, channelId: "lobby", channelName: "Lobby" };

    model.rememberDeliveredLine("ai-mira", "hej", context);
    expect(lmstudio.rememberDeliveredLine).toHaveBeenCalledWith("ai-mira", "hej", context);
    expect(codex.rememberDeliveredLine).toHaveBeenCalledWith("ai-mira", "hej", context);

    model.cancelPending("shutdown");
    expect(lmstudio.cancelPending).toHaveBeenCalledWith("shutdown");
    expect(codex.cancelPending).toHaveBeenCalledWith("shutdown");
  });
});
