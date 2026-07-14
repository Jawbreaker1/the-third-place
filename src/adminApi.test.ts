import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteAdminSession, patchAdminBehavior, patchAdminPersona } from "./adminApi";

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
