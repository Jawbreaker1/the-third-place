import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexBackend } from "./codexBackend.js";
import { ModelProviderManager } from "./modelProviderManager.js";
import type { ModelProviderId } from "./modelBackend.js";
import type { SwitchableSocialModel } from "./switchableModel.js";

const fakeModel = (initial: ModelProviderId = "lmstudio") => {
  let active = initial;
  const lmstudio = {
    probe: vi.fn(async () => ({ connected: true, id: "gemma-4-26b", label: "Gemma" })),
  };
  return {
    activeProvider: vi.fn(() => active),
    select: vi.fn((provider: ModelProviderId) => { active = provider; }),
    client: vi.fn((provider: ModelProviderId) => {
      if (provider !== "lmstudio") throw new Error("unexpected client");
      return lmstudio;
    }),
    lmstudio,
  };
};

const fakeCodex = (overrides: Record<string, unknown> = {}) => ({
  configuredModel: "gpt-5.6-luna",
  account: vi.fn(async () => ({ authenticated: true, method: "chatgpt", accountLabel: "owner@example.test" })),
  probe: vi.fn(async () => ({ connected: true, id: "gpt-5.6-luna", label: "GPT-5.6 Luna" })),
  loginStatus: vi.fn(() => ({ pending: false })),
  startDeviceLogin: vi.fn(async () => ({ status: "pending", loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD" })),
  logout: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  ...overrides,
}) as unknown as CodexBackend;

const previousProvider = process.env.LLM_PROVIDER;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
});

describe("ModelProviderManager", () => {
  it("persists an authenticated Codex selection before exposing it as active", async () => {
    const model = fakeModel();
    const codex = fakeCodex();
    const events: string[] = [];
    model.select.mockImplementation((provider: ModelProviderId) => events.push(`select:${provider}`));
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, codex, {
      persist: async (state) => { events.push(`persist:${JSON.stringify(state)}`); },
    });

    await manager.setActiveProvider("codex");
    expect(events).toEqual([
      'persist:{"version":1,"activeProvider":"codex"}',
      "select:codex",
    ]);
    expect(codex.account).toHaveBeenCalled();
    expect(codex.probe).toHaveBeenCalled();
  });

  it("leaves the current provider untouched when persistence fails", async () => {
    const model = fakeModel();
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, fakeCodex(), {
      persist: async () => { throw new Error("disk full"); },
    });

    await expect(manager.setActiveProvider("codex")).rejects.toThrow("disk full");
    expect(model.select).not.toHaveBeenCalled();
    expect(manager.activeProvider()).toBe("lmstudio");
  });

  it("serializes concurrent switches so the last admin choice wins", async () => {
    const model = fakeModel();
    const states: ModelProviderId[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, fakeCodex(), {
      persist: async (state) => {
        const provider = (state as { activeProvider: ModelProviderId }).activeProvider;
        states.push(provider);
        if (states.length === 1) await firstWrite;
      },
    });

    const selectCodex = manager.setActiveProvider("codex");
    await vi.waitFor(() => expect(states).toEqual(["codex"]));
    const selectLocal = manager.setActiveProvider("lmstudio");
    releaseFirst();
    await Promise.all([selectCodex, selectLocal]);

    expect(states).toEqual(["codex", "lmstudio"]);
    expect(manager.activeProvider()).toBe("lmstudio");
  });

  it("refuses Codex selection until a compatible ChatGPT subscription is ready", async () => {
    const model = fakeModel();
    const signedOut = fakeCodex({ account: vi.fn(async () => ({ authenticated: false })) });
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, signedOut, { persist: vi.fn() });
    await expect(manager.setActiveProvider("codex")).rejects.toMatchObject({
      status: 409,
      code: "CODEX_NOT_READY",
    });
    expect(model.select).not.toHaveBeenCalled();
  });

  it("restores a valid persisted provider in preference to the environment default", async () => {
    process.env.LLM_PROVIDER = "lmstudio";
    const directory = await mkdtemp(join(tmpdir(), "third-place-provider-test-"));
    const path = join(directory, "provider.json");
    await writeFile(path, JSON.stringify({ version: 1, activeProvider: "codex" }), "utf8");
    const model = fakeModel();
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, fakeCodex(), { path });

    await manager.load();
    expect(model.select).toHaveBeenCalledWith("codex", "Restoring configured AI provider");
  });

  it("uses the configured environment fallback only when no state file exists", async () => {
    process.env.LLM_PROVIDER = "codex";
    const directory = await mkdtemp(join(tmpdir(), "third-place-provider-missing-test-"));
    const model = fakeModel();
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, fakeCodex(), {
      path: join(directory, "does-not-exist.json"),
    });

    await manager.load();
    expect(model.select).toHaveBeenCalledWith("codex", "Restoring configured AI provider");
  });

  it("reports local and subscription state without exposing credentials", async () => {
    const model = fakeModel("codex");
    const codex = fakeCodex();
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, codex);
    await expect(manager.snapshot()).resolves.toEqual({
      activeProvider: "codex",
      providers: {
        lmstudio: { status: "connected", model: "gemma-4-26b" },
        codex: {
          status: "authenticated",
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          accountLabel: "owner@example.test",
        },
      },
    });
  });

  it("supports device login but prevents disconnecting the active Codex provider", async () => {
    const signedOutCodex = fakeCodex({ account: vi.fn(async () => ({ authenticated: false })) });
    const localModel = fakeModel();
    const manager = new ModelProviderManager(localModel as unknown as SwitchableSocialModel, signedOutCodex);
    await expect(manager.startCodexLogin()).resolves.toMatchObject({
      status: "pending",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD",
    });

    const activeModel = fakeModel("codex");
    const activeManager = new ModelProviderManager(activeModel as unknown as SwitchableSocialModel, signedOutCodex);
    await expect(activeManager.logoutCodex()).rejects.toMatchObject({ status: 409, code: "CODEX_ACTIVE" });
    expect(signedOutCodex.logout).not.toHaveBeenCalled();

    await manager.logoutCodex();
    expect(signedOutCodex.logout).toHaveBeenCalledOnce();
  });

  it("serializes logout behind a pending switch and refuses to sign out the provider that became active", async () => {
    const model = fakeModel();
    const codex = fakeCodex();
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, codex, {
      persist: async () => await persistGate,
    });

    const switching = manager.setActiveProvider("codex");
    await vi.waitFor(() => expect(codex.probe).toHaveBeenCalled());
    const loggingOut = manager.logoutCodex();
    releasePersist();

    await switching;
    await expect(loggingOut).rejects.toMatchObject({ status: 409, code: "CODEX_ACTIVE" });
    expect(manager.activeProvider()).toBe("codex");
    expect(codex.logout).not.toHaveBeenCalled();
  });

  it("flushes queued writes before closing the isolated Codex process", async () => {
    const gate: { resolve?: () => void } = {};
    const persistence = new Promise<void>((resolve) => { gate.resolve = resolve; });
    const model = fakeModel();
    const codex = fakeCodex();
    const manager = new ModelProviderManager(model as unknown as SwitchableSocialModel, codex, {
      persist: async () => await persistence,
    });
    const switching = manager.setActiveProvider("codex");
    const closing = manager.close();
    expect(codex.close).not.toHaveBeenCalled();
    gate.resolve?.();
    await switching;
    await closing;
    expect(codex.close).toHaveBeenCalledOnce();
  });
});
