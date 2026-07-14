import { describe, expect, it } from "vitest";
import {
  adminLlmProviderReady,
  CODEX_LUNA_MODEL,
  mergeCodexLoginResult,
  normalizeAdminCodexLoginResult,
  normalizeAdminLlmState,
} from "./adminLlmModel";

describe("admin LLM provider boundary", () => {
  it("normalizes the provider snapshot without accepting credentials", () => {
    const state = normalizeAdminLlmState({
      state: {
        activeProvider: "codex",
        providers: {
          lmstudio: { status: "connected", model: "google/gemma-4-26b-a4b" },
          codex: {
            status: "authenticated",
            model: CODEX_LUNA_MODEL,
            reasoningEffort: "high",
            accountLabel: "Johan's ChatGPT account",
            accessToken: "must-not-cross-the-boundary",
          },
        },
      },
    });

    expect(state).toEqual({
      activeProvider: "codex",
      providers: {
        lmstudio: { status: "connected", model: "google/gemma-4-26b-a4b" },
        codex: {
          status: "authenticated",
          model: CODEX_LUNA_MODEL,
          reasoningEffort: "low",
          accountLabel: "Johan's ChatGPT account",
        },
      },
    });
    expect(JSON.stringify(state)).not.toContain("must-not-cross-the-boundary");
    expect(adminLlmProviderReady(state, "lmstudio")).toBe(true);
    expect(adminLlmProviderReady(state, "codex")).toBe(true);
  });

  it("defaults closed when a provider response is missing or malformed", () => {
    const state = normalizeAdminLlmState({ activeProvider: "unknown", providers: { codex: { status: "ready" } } });

    expect(state.activeProvider).toBe("lmstudio");
    expect(state.providers.lmstudio.status).toBe("disconnected");
    expect(state.providers.codex).toMatchObject({
      status: "unavailable",
      model: CODEX_LUNA_MODEL,
      reasoningEffort: "low",
    });
    expect(adminLlmProviderReady(state, "lmstudio")).toBe(false);
    expect(adminLlmProviderReady(state, "codex")).toBe(false);
  });

  it("accepts only a safe HTTPS device-login URL", () => {
    expect(normalizeAdminCodexLoginResult({
      ok: true,
      instructions: "Open the verification page.",
      verificationUrl: "https://auth.openai.com/device?flow=codex",
      userCode: "ABCD-EFGH",
    })).toEqual({
      status: "pending",
      instructions: "Open the verification page.",
      verificationUrl: "https://auth.openai.com/device?flow=codex",
      userCode: "ABCD-EFGH",
    });

    expect(normalizeAdminCodexLoginResult({
      status: "pending",
      verificationUrl: "javascript:alert(1)",
    }).verificationUrl).toBeUndefined();
    expect(normalizeAdminCodexLoginResult({
      status: "pending",
      verificationUrl: "https://user:secret@example.com/device",
    }).verificationUrl).toBeUndefined();
    expect(normalizeAdminCodexLoginResult({
      status: "pending",
      verificationUrl: "https://openai.com.evil.test/device",
    }).verificationUrl).toBeUndefined();
  });

  it("merges a pending login without changing the active provider prematurely", () => {
    const state = normalizeAdminLlmState({
      activeProvider: "lmstudio",
      providers: {
        lmstudio: { status: "connected" },
        codex: { status: "signed-out" },
      },
    });

    expect(mergeCodexLoginResult(state, {
      status: "pending",
      detail: "Waiting for browser authorization.",
    })).toMatchObject({
      activeProvider: "lmstudio",
      providers: { codex: { status: "pending", detail: "Waiting for browser authorization." } },
    });
  });
});
