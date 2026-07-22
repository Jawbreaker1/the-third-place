import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdminExternalAgentInvitationWrite,
  AdminExternalAgentPolicyWrite,
} from "../shared/adminTypes";
import {
  createAdminAgentInvitation,
  createAdminAgentReconnectInvitation,
  deleteAdminCodexSession,
  deleteAdminMemoryActor,
  deleteAdminMemoryItem,
  deleteAdminMemoryRelationship,
  deleteAdminSession,
  getAdminLlmState,
  getAdminAgents,
  getAdminMemory,
  getAdminMemoryActor,
  issueAdminHumanRecoveryKey,
  patchAdminBehavior,
  patchAdminAgentPolicy,
  patchAdminChannelFeed,
  patchAdminLlmProvider,
  patchAdminMemoryItem,
  patchAdminPersona,
  revokeAdminAgent,
  revokeAdminAgentInvitation,
  startAdminCodexLogin,
} from "./adminApi";

const adminAgent = {
  id: "agent-cato",
  displayName: "Cato",
  publicBio: "A curious owner-operated agent.",
  channelIds: ["lobby", "ai-lab"],
  scopes: ["rooms:read", "messages:write", "reactions:write"],
  state: "enabled",
  presence: "offline",
  createdAt: "2026-07-22T12:00:00.000Z",
} as const;

const adminInvitation = {
  id: "agent-invite-cato",
  label: "Cato's owner",
  channelIds: ["lobby", "ai-lab"],
  scopes: ["rooms:read", "messages:write", "reactions:write"],
  state: "pending",
  createdAt: "2026-07-22T11:00:00.000Z",
  expiresAt: "2026-07-23T11:00:00.000Z",
} as const;

describe("admin external-agent API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists owner-submitted agents and token-free invitations through the authenticated admin boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [{ ...adminAgent, personalityPrompt: "must-not-enter-admin-state", tokenDigest: "private-digest" }],
      invitations: [{ ...adminInvitation, tokenDigest: "private-invitation-digest" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAdminAgents();
    expect(result).toEqual({ agents: [adminAgent], invitations: [adminInvitation] });
    expect(JSON.stringify(result)).not.toContain("must-not-enter-admin-state");
    expect(JSON.stringify(result)).not.toContain("private-digest");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/agents", expect.objectContaining({
      credentials: "same-origin",
      headers: expect.objectContaining({ Accept: "application/json" }),
    }));
  });

  it("creates a scoped invitation and returns only its one-time enrollment secret", async () => {
    const token = "ttp_invite_one-time-secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      invitation: adminInvitation,
      token,
      enrollmentUrl: "/api/agents/v1/enroll",
      handoffPrompt: "Submit your owner-defined public identity during enrollment.",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const write: AdminExternalAgentInvitationWrite = {
      label: adminInvitation.label,
      expiresInSeconds: 86_400,
      channelIds: [...adminInvitation.channelIds],
      scopes: [...adminInvitation.scopes],
    };
    await expect(createAdminAgentInvitation(write)).resolves.toMatchObject({ token, invitation: adminInvitation });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/agent-invitations", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify(write),
    }));
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(token);
  });

  it("rejects a one-time secret response that has no valid invitation projection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: "ttp_invite_orphan-secret",
      enrollmentUrl: "/api/agents/v1/enroll",
    }), { status: 201 })));

    await expect(createAdminAgentInvitation({
      label: "Cato's owner",
      expiresInSeconds: 3_600,
      channelIds: ["lobby"],
      scopes: ["rooms:read"],
    })).rejects.toMatchObject({ name: "AdminApiError", status: 502 });
  });

  it("updates policy without letting administration rewrite the owner-submitted profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agent: adminAgent }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const write: AdminExternalAgentPolicyWrite = {
      channelIds: ["lobby"],
      scopes: ["rooms:read", "messages:write"],
    };

    await expect(patchAdminAgentPolicy("agent/cato", write)).resolves.toEqual(adminAgent);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/agents/agent%2Fcato", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify(write),
    }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual(write);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("revokes access and issues a reconnect invitation through explicit POST actions", async () => {
    const revoked = { ...adminAgent, state: "revoked", revokedAt: "2026-07-22T13:00:00.000Z" } as const;
    const revokedInvitation = { ...adminInvitation, state: "revoked", revokedAt: "2026-07-22T13:00:00.000Z" } as const;
    const token = "ttp_invite_reconnect-secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agent: revoked }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invitation: revokedInvitation }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        invitation: { ...adminInvitation, id: "agent-invite-reconnect" },
        token,
        enrollmentUrl: "https://example.test/api/agents/v1/enroll",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeAdminAgent("agent/cato")).resolves.toEqual(revoked);
    await expect(revokeAdminAgentInvitation("agent-invite-cato")).resolves.toEqual(revokedInvitation);
    await expect(createAdminAgentReconnectInvitation("agent/cato", {
      label: "Reconnect Cato",
      expiresInSeconds: 21_600,
    })).resolves.toMatchObject({ token });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/admin/agents/agent%2Fcato/revoke",
      expect.objectContaining({ method: "POST", body: "{}" }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/admin/agent-invitations/agent-invite-cato/revoke",
      expect.objectContaining({ method: "POST", body: "{}" }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/admin/agents/agent%2Fcato/reconnect-invitations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ label: "Reconnect Cato", expiresInSeconds: 21_600 }),
      }),
    ]);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).join(" ")).not.toContain(token);
  });
});

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
      fictionalAdult: false,
      roomAffinities: { lobby: 0 },
      voices: {},
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/personas/ai-mira", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"roomAffinities":{"lobby":0}'),
    }));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).not.toContain("the-pub");
  });

  it("updates one server-owned room integration through its room-scoped route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchAdminChannelFeed("stock/market", "market wire", {
      enabled: true,
      discussionFrequency: 70,
      activeIntervalMinutes: 5,
      idleIntervalMinutes: 45,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/channels/stock%2Fmarket/feeds/market%20wire",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({ enabled: true, discussionFrequency: 70, activeIntervalMinutes: 5, idleIntervalMinutes: 45 }),
      }),
    );
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

describe("admin human identity recovery API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests and returns a one-time key without putting it in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      name: "Telefon-Johan",
      recoveryKey: "ttp_one-time-admin-key",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(issueAdminHumanRecoveryKey("human/phone")).resolves.toEqual({
      name: "Telefon-Johan",
      recoveryKey: "ttp_one-time-admin-key",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/humans/human%2Fphone/recovery-key",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: "{}",
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("ttp_one-time-admin-key");
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

describe("admin social-memory API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the overview and an encoded actor detail through separate contracts", async () => {
    const overview = {
      stats: {
        actors: 1,
        memories: 2,
        activeEpisodicMemories: 1,
        consolidatedMemories: 1,
        supersededMemories: 0,
        expiredMemories: 1,
        relationships: 3,
        openLoops: 1,
        auditEntries: 4,
      },
      actors: [{
        id: "ai/mira",
        name: "Mira",
        kind: "resident",
        memoryCount: 2,
        memoryRowsTruncated: false,
        activeEpisodicMemoryCount: 1,
        consolidatedMemoryCount: 1,
        supersededMemoryCount: 0,
        expiredMemoryCount: 1,
        outgoingRelationshipCount: 2,
        incomingRelationshipCount: 1,
        openLoopCount: 1,
      }],
    };
    const detail = {
      actor: overview.actors[0],
      ownedMemories: [],
      outgoingRelationships: [],
      incomingRelationships: [],
      openLoops: [],
      audit: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(overview), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminMemory()).resolves.toEqual(overview);
    await expect(getAdminMemoryActor("ai/mira")).resolves.toEqual(detail);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/memory");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/memory/actors/ai%2Fmira");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ credentials: "same-origin" }));
  });

  it("pins and forgets only the addressed memory item", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchAdminMemoryItem("memory/one", { pinned: false });
    await deleteAdminMemoryItem("memory/one");

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/admin/memory/items/memory%2Fone",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({ pinned: false }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/admin/memory/items/memory%2Fone",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    ]);
  });

  it("requests full actor erasure only through the encoded human actor route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteAdminMemoryActor("human/test visitor");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/memory/actors/human%2Ftest%20visitor",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });

  it("resets one directed edge without conflating its reverse", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteAdminMemoryRelationship("ai/mira", "human johan");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/memory/relationships/ai%2Fmira/human%20johan",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });
});
