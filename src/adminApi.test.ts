import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteAdminCodexSession,
  deleteAdminSession,
  getAdminLlmState,
  patchAdminBehavior,
  patchAdminLlmProvider,
  patchAdminPersona,
  startAdminCodexLogin,
} from "./adminApi";

describe("admin behavior API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears a room override with an explicit null tuning", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchAdminBehavior({ scope: "channel", channelId: "the-pub", tuning: null });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/behavior", expect.objectContaining({
      method: "PATCH",
      credentials: "same-origin",
      body: JSON.stringify({ scope: "channel", channelId: "the-pub", tuning: null }),
    }));
  });

  it("serializes an explicit autonomous-link zero without dropping it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchAdminBehavior({
      scope: "channel",
      channelId: "the-pub",
      tuning: {
        activity: 50,
        autonomousLinkFrequency: 0,
        competence: 50,
        aggression: 25,
        explicitness: 50,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/behavior", expect.objectContaining({
      body: expect.stringContaining('"autonomousLinkFrequency":0'),
    }));
  });

  it("serializes explicit zero affinity without inventing missing room overrides", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchAdminPersona("ai-mira", {
      id: "ai-mira",
      name: "Mira",
      role: "Resident",
      bio: "Still Mira.",
      prompt: "Stay specific and conversational.",
      core: {
        talkativeness: 50,
        warmth: 50,
        curiosity: 50,
        mischief: 30,
        conscientiousness: 50,
        disagreement: 35,
      },
      canResearch: true,
      roomAffinities: { lobby: 0 },
      voices: {},
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/personas/ai-mira", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"roomAffinities":{"lobby":0}'),
    }));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).not.toContain("the-pub");
  });
});

describe("admin session API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a 401 delete response as an already completed logout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(deleteAdminSession()).resolves.toBeUndefined();
  });

  it("does not treat origin or authorization rejection as a completed logout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

    await expect(deleteAdminSession()).rejects.toMatchObject({
      name: "AdminApiError",
      status: 403,
    });
  });

  it("does not treat a network failure as a completed logout", async () => {
    const networkError = new TypeError("network unavailable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    await expect(deleteAdminSession()).rejects.toBe(networkError);
  });
});

describe("admin LLM provider API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads and normalizes provider status through the authenticated admin boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      activeProvider: "codex",
      providers: {
        lmstudio: { status: "connected", model: "gemma" },
        codex: { status: "authenticated", model: "gpt-5.6-luna", reasoningEffort: "low" },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminLlmState()).resolves.toMatchObject({
      activeProvider: "codex",
      providers: { codex: { status: "authenticated", reasoningEffort: "low" } },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/llm", expect.objectContaining({
      credentials: "same-origin",
      headers: expect.objectContaining({ Accept: "application/json" }),
    }));
  });

  it("switches providers with only the allowlisted provider ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchAdminLlmProvider("codex");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/llm", expect.objectContaining({
      method: "PATCH",
      credentials: "same-origin",
      body: JSON.stringify({ activeProvider: "codex" }),
    }));
  });

  it("starts and disconnects Codex auth without sending browser credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "pending",
        verificationUrl: "https://auth.openai.com/device",
        userCode: "ABCD-EFGH",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startAdminCodexLogin()).resolves.toMatchObject({ status: "pending", userCode: "ABCD-EFGH" });
    await deleteAdminCodexSession();

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/admin/llm/codex/login",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    ]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/admin/llm/codex/session",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    ]);
  });
});
