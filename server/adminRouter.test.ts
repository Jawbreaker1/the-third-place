import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import type {
  AdminChannelFeedControl,
  AdminExternalAgent,
  AdminExternalAgentCredential,
  AdminExternalAgentWrite,
} from "../shared/adminTypes.js";
import { AdminAuthManager } from "./adminAuth.js";
import { createAdminRouter } from "./adminRouter.js";
import { AdminStateStore } from "./adminState.js";

interface DispatchOptions {
  method: string;
  path: string;
  host?: string;
  origin?: string;
  referer?: string;
  cookie?: string;
  body?: unknown;
  sourceAddress?: string;
  xForwardedFor?: string;
}

interface DispatchResult {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: unknown;
}

let stateSequence = 0;
const isolatedAdminState = (): AdminStateStore => new AdminStateStore({
  path: `/tmp/the-third-place-admin-router-${process.pid}-${stateSequence++}.json`,
  persist: async () => undefined,
});

/** Exercises Express' real router/middleware stack without binding a TCP port. */
const dispatch = async (app: Express, options: DispatchOptions): Promise<DispatchResult> =>
  await new Promise((resolve, reject) => {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", {
      configurable: true,
      value: options.sourceAddress ?? "127.0.0.1",
    });
    const request = new IncomingMessage(socket);
    request.method = options.method;
    request.url = options.path;
    request.headers = {
      host: options.host ?? "admin.example",
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.referer ? { referer: options.referer } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.xForwardedFor ? { "x-forwarded-for": options.xForwardedFor } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    (request as IncomingMessage & { body?: unknown }).body = options.body;

    const response = new ServerResponse(request);
    const chunks: Buffer[] = [];
    response.write = ((chunk: string | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }) as typeof response.write;
    response.end = ((chunk?: string | Uint8Array) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : undefined; } catch { /* retain text */ }
      resolve({
        status: response.statusCode,
        headers: response.getHeaders(),
        body,
      });
      socket.destroy();
      return response;
    }) as typeof response.end;

    app.handle(request, response, reject);
  });

describe("admin HTTP API", () => {
  it("enforces origin, cookie authentication, CRUD and moderation through the router", async () => {
    const state = isolatedAdminState();
    await state.load();
    const auth = new AdminAuthManager({
      password: "correct horse battery staple",
      randomToken: () => "r".repeat(43),
    });
    const human = { id: "human-1", name: "Alex", status: "online" as const };
    const kicked: Array<{ memberId: string; reason?: string }> = [];
    const banned: Array<{ memberId: string; reason?: string }> = [];
    const forgotten: string[] = [];
    const recoveryKeysIssued: string[] = [];
    const memoryMutations: string[] = [];
    const memoryOverview = {
      stats: { actors: 1, memories: 1, relationships: 1, openLoops: 0, auditEntries: 0 },
      actors: [{
        id: "ai-mira",
        name: "Mira",
        kind: "resident" as const,
        memoryCount: 1,
        outgoingRelationshipCount: 1,
        incomingRelationshipCount: 0,
        openLoopCount: 0,
      }],
    };
    const memoryDetail = {
      actor: memoryOverview.actors[0]!,
      ownedMemories: [],
      outgoingRelationships: [],
      incomingRelationships: [],
      openLoops: [],
      audit: [],
    };
    const humanMemoryDetail = {
      ...memoryDetail,
      actor: { ...memoryDetail.actor, id: human.id, name: human.name, kind: "human" as const },
    };
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth,
      state,
      configuredOrigins: ["https://admin.example"],
      isSecure: () => true,
      getHumans: () => [human],
      getAutonomousResearchDiagnostics: () => ({
        attempts: 5,
        published: 2,
        failed: 3,
        lastFailure: {
          channelId: "lobby",
          seedId: "lobby-news",
          reason: "source_read_failed",
          failedAt: Date.UTC(2026, 6, 14, 11, 55),
          retryAfterAt: Date.UTC(2026, 6, 14, 12, 1),
          consecutiveFailures: 2,
        },
      }),
      kickHuman: (memberId, reason) => {
        if (memberId !== human.id) return undefined;
        kicked.push({ memberId, ...(reason ? { reason } : {}) });
        return human;
      },
      banHuman: (memberId, reason) => {
        if (memberId !== human.id) return undefined;
        banned.push({ memberId, ...(reason ? { reason } : {}) });
        return human;
      },
      issueHumanRecoveryKey: async (memberId) => {
        if (memberId !== human.id) return undefined;
        recoveryKeysIssued.push(memberId);
        return { name: human.name, recoveryKey: "ttp_admin-once-only-return-key" };
      },
      socialMemory: {
        getOverview: () => memoryOverview,
        getActorDetail: (id) => id === "ai-mira"
          ? memoryDetail
          : id === human.id
            ? humanMemoryDetail
            : undefined,
        setMemoryPinned: (id, pinned) => {
          memoryMutations.push(`pin:${id}:${pinned}`);
          return id === "memory-1";
        },
        deleteMemory: (id) => {
          memoryMutations.push(`delete:${id}`);
          return id === "memory-1";
        },
        resetRelationship: (ownerId, subjectId) => {
          memoryMutations.push(`reset:${ownerId}:${subjectId}`);
          return ownerId === "ai-mira" && subjectId === "human-1";
        },
      },
      forgetHumanActor: async (actorId) => {
        if (actorId !== human.id) return false;
        forgotten.push(actorId);
        return true;
      },
      now: () => Date.UTC(2026, 6, 14, 12),
    }));

    const originless = await dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      body: { password: "correct horse battery staple" },
    });
    expect(originless.status).toBe(403);

    const login = await dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "correct horse battery staple" },
    });
    expect(login.status).toBe(201);
    expect(login.body).toEqual({ ok: true, authenticated: true });
    expect(JSON.stringify(login.body)).not.toContain("correct horse battery staple");
    expect(JSON.stringify(login.body)).not.toContain("r".repeat(43));
    const setCookie = String(login.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("atrium_admin=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";", 1)[0]!;

    const session = await dispatch(app, { method: "GET", path: "/api/admin/session", cookie });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ ok: true, authenticated: true });

    expect((await dispatch(app, { method: "GET", path: "/api/admin/state" })).status).toBe(401);
    const initial = await dispatch(app, { method: "GET", path: "/api/admin/state", cookie });
    expect(initial.status).toBe(200);
    expect(initial.headers["cache-control"]).toContain("no-store");
    expect(initial.body).toMatchObject({
      ok: true,
      state: {
        behavior: { channels: {} },
        automation: {
          autonomousResearch: {
            attempts: 5,
            published: 2,
            failed: 3,
            lastFailure: { channelId: "lobby", reason: "source_read_failed" },
          },
        },
      },
    });

    const issuedRecoveryKey = await dispatch(app, {
      method: "POST",
      path: `/api/admin/humans/${human.id}/recovery-key`,
      cookie,
      origin: "https://admin.example",
      body: {},
    });
    expect(issuedRecoveryKey.status).toBe(201);
    expect(issuedRecoveryKey.headers["cache-control"]).toContain("no-store");
    expect(issuedRecoveryKey.body).toEqual({
      ok: true,
      name: human.name,
      recoveryKey: "ttp_admin-once-only-return-key",
    });
    expect(recoveryKeysIssued).toEqual([human.id]);
    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/humans/missing/recovery-key",
      cookie,
      origin: "https://admin.example",
      body: {},
    })).status).toBe(404);

    const memory = await dispatch(app, { method: "GET", path: "/api/admin/memory", cookie });
    expect(memory.status).toBe(200);
    expect(memory.body).toEqual(memoryOverview);
    expect((await dispatch(app, {
      method: "GET",
      path: "/api/admin/memory/actors/ai-mira",
      cookie,
    })).body).toEqual(memoryDetail);
    expect((await dispatch(app, {
      method: "GET",
      path: "/api/admin/memory/actors/missing",
      cookie,
    })).status).toBe(404);
    expect((await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/memory/actors/ai-mira",
      cookie,
      origin: "https://admin.example",
    })).status).toBe(409);
    expect((await dispatch(app, {
      method: "DELETE",
      path: `/api/admin/memory/actors/${human.id}`,
      cookie,
      origin: "https://evil.example",
    })).status).toBe(403);
    expect((await dispatch(app, {
      method: "DELETE",
      path: `/api/admin/memory/actors/${human.id}`,
      cookie,
      origin: "https://admin.example",
    })).status).toBe(204);
    expect(forgotten).toEqual([human.id]);
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/memory/items/memory-1",
      cookie,
      origin: "https://evil.example",
      body: { pinned: true },
    })).status).toBe(403);
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/memory/items/memory-1",
      cookie,
      origin: "https://admin.example",
      body: { pinned: true },
    })).status).toBe(204);
    expect((await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/memory/items/memory-1",
      cookie,
      origin: "https://admin.example",
    })).status).toBe(204);
    expect((await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/memory/relationships/ai-mira/human-1",
      cookie,
      origin: "https://admin.example",
    })).status).toBe(204);
    expect(memoryMutations).toEqual([
      "pin:memory-1:true",
      "delete:memory-1",
      "reset:ai-mira:human-1",
    ]);

    const crossOrigin = await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/behavior",
      cookie,
      origin: "https://evil.example",
      body: { scope: "channel", channelId: "lobby", tuning: null },
    });
    expect(crossOrigin.status).toBe(403);
    const patched = await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/behavior",
      cookie,
      origin: "https://admin.example",
      body: {
        scope: "channel",
        channelId: "lobby",
        tuning: { activity: 61, competence: 52, aggression: 28, explicitness: 45 },
      },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { state: { behavior: { channels: Record<string, { autonomousLinkFrequency: number }> } } })
      .state.behavior.channels.lobby?.autonomousLinkFrequency).toBe(60);

    const channel = {
      id: "admin-test-room",
      name: "admin-test-room",
      description: "A live room created through the authenticated admin boundary.",
      icon: "T",
      topic: "bounded integration testing",
      guidance: "Discuss one concrete observable at a time.",
      register: "technical",
      mode: "discussion",
      seeds: ["Name one state transition that this route must preserve across a live update."],
    };
    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/channels",
      cookie,
      origin: "https://admin.example",
      body: channel,
    })).status).toBe(201);
    expect((await dispatch(app, {
      method: "PUT",
      path: `/api/admin/channels/${channel.id}`,
      cookie,
      origin: "https://admin.example",
      body: { ...channel, name: "admin-test-room-live" },
    })).status).toBe(200);

    const persona = {
      id: "ai-admin-test",
      name: "Admin Test",
      role: "Resident · test",
      bio: "A bounded resident created only by the router integration test.",
      prompt: "Reply as a concise peer and make one concrete, relevant point.",
      core: {
        talkativeness: 55,
        warmth: 65,
        curiosity: 75,
        mischief: 20,
        conscientiousness: 80,
        disagreement: 40,
      },
      canResearch: false,
      fictionalAdult: false,
      roomAffinities: { "admin-test-room": 70 },
      voices: {},
    };
    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/personas",
      cookie,
      origin: "https://admin.example",
      body: persona,
    })).status).toBe(201);
    expect((await dispatch(app, {
      method: "PATCH",
      path: `/api/admin/personas/${persona.id}`,
      cookie,
      origin: "https://admin.example",
      body: { ...persona, name: "Admin Test Live" },
    })).status).toBe(200);
    expect((await dispatch(app, {
      method: "DELETE",
      path: `/api/admin/personas/${persona.id}`,
      cookie,
      origin: "https://admin.example",
    })).status).toBe(200);
    expect((await dispatch(app, {
      method: "DELETE",
      path: `/api/admin/channels/${channel.id}`,
      cookie,
      origin: "https://admin.example",
    })).status).toBe(200);

    const kickedResponse = await dispatch(app, {
      method: "POST",
      path: "/api/admin/humans/human-1/kick",
      cookie,
      origin: "https://admin.example",
      body: { reason: "cool down" },
    });
    expect(kickedResponse.status).toBe(200);
    expect(kicked).toEqual([{ memberId: "human-1", reason: "cool down" }]);
    const bannedResponse = await dispatch(app, {
      method: "POST",
      path: "/api/admin/humans/human-1/ban",
      cookie,
      origin: "https://admin.example",
      body: { reason: "repeated harassment" },
    });
    expect(bannedResponse.status).toBe(200);
    expect(banned).toEqual([{ memberId: "human-1", reason: "repeated harassment" }]);
    expect(state.isBanned("human-1", "Alex")).toBe(true);

    const unbannedResponse = await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/bans/human-1",
      cookie,
      referer: "https://admin.example/admin?section=people",
    });
    expect(unbannedResponse.status).toBe(200);
    expect(unbannedResponse.body).toMatchObject({ ok: true, state: { bans: [] } });
    expect(state.isBanned("human-1", "Alex")).toBe(false);

    expect((await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/session",
      cookie,
    })).status).toBe(403);
    const logout = await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/session",
      cookie,
      origin: "https://admin.example",
    });
    expect(logout.status).toBe(200);
    expect(auth.validate("r".repeat(43))).toBeUndefined();
  });

  it("fails closed when admin authentication is disabled or credentials are wrong", async () => {
    const state = isolatedAdminState();
    await state.load();
    const disabled = express();
    disabled.use("/api/admin", createAdminRouter({
      auth: new AdminAuthManager(),
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
    }));

    const unavailable = await dispatch(disabled, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "admin" },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers["set-cookie"]).toBeUndefined();
    expect(unavailable.body).toMatchObject({ ok: false, authenticated: false });
    expect((await dispatch(disabled, { method: "GET", path: "/api/admin/state" })).status).toBe(401);

    const enabled = express();
    enabled.use("/api/admin", createAdminRouter({
      auth: new AdminAuthManager({ password: "private password" }),
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
    }));
    const wrong = await dispatch(enabled, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "wrong password" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect(wrong.body).toMatchObject({ ok: false, authenticated: false });
  });

  it("exposes only device-code provider controls behind the admin boundary", async () => {
    const state = isolatedAdminState();
    await state.load();
    const selected: string[] = [];
    let loggedOut = false;
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth: new AdminAuthManager({
        password: "correct horse battery staple",
        randomToken: () => "p".repeat(43),
      }),
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
      llmProviders: {
        snapshot: async () => ({
          activeProvider: selected.at(-1) === "codex" ? "codex" : "lmstudio",
          providers: {
            lmstudio: { status: "connected", model: "gemma" },
            codex: { status: "authenticated", model: "gpt-5.6-luna", reasoningEffort: "low", accountLabel: "owner@example.test" },
          },
        }),
        setActiveProvider: async (provider) => { selected.push(provider); },
        startCodexLogin: async () => ({
          status: "pending",
          instructions: "Use the official device page.",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "ABCD-EFGH",
        }),
        logoutCodex: async () => { loggedOut = true; },
      },
    }));

    expect((await dispatch(app, { method: "GET", path: "/api/admin/llm" })).status).toBe(401);
    const login = await dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "correct horse battery staple" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const snapshot = await dispatch(app, { method: "GET", path: "/api/admin/llm", cookie });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ activeProvider: "lmstudio", providers: { codex: { model: "gpt-5.6-luna" } } });
    expect(JSON.stringify(snapshot.body)).not.toContain("token");

    const credentialInjection = await dispatch(app, {
      method: "POST",
      path: "/api/admin/llm/codex/login",
      cookie,
      origin: "https://admin.example",
      body: { email: "owner@example.test", password: "do-not-accept" },
    });
    expect(credentialInjection.status).toBe(400);
    const deviceLogin = await dispatch(app, {
      method: "POST",
      path: "/api/admin/llm/codex/login",
      cookie,
      origin: "https://admin.example",
      body: {},
    });
    expect(deviceLogin.body).toMatchObject({ status: "pending", userCode: "ABCD-EFGH" });

    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/llm",
      cookie,
      origin: "https://admin.example",
      body: { activeProvider: "codex" },
    })).status).toBe(200);
    expect(selected).toEqual(["codex"]);
    expect((await dispatch(app, {
      method: "DELETE",
      path: "/api/admin/llm/codex/session",
      cookie,
      origin: "https://admin.example",
    })).status).toBe(204);
    expect(loggedOut).toBe(true);
  });

  it("does not let one login source lock out a different source", async () => {
    const state = isolatedAdminState();
    await state.load();
    const auth = new AdminAuthManager({
      password: "correct horse battery staple",
      loginMaxAttempts: 2,
      loginWindowMs: 60_000,
      randomToken: () => "s".repeat(43),
    });
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth,
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
    }));
    const login = (password: string, sourceAddress: string, xForwardedFor?: string) => dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      sourceAddress,
      ...(xForwardedFor ? { xForwardedFor } : {}),
      body: { password },
    });

    expect((await login("wrong-one", "203.0.113.20", "198.51.100.1")).status).toBe(401);
    expect((await login("wrong-two", "203.0.113.20", "198.51.100.2")).status).toBe(401);
    // Without an explicitly trusted Express proxy, a caller cannot rotate an
    // untrusted forwarding header to escape the socket source's own budget.
    expect((await login("correct horse battery staple", "203.0.113.20", "198.51.100.3")).status).toBe(429);
    expect((await login("correct horse battery staple", "203.0.113.21")).status).toBe(201);
  });

  it("exposes and live-updates only the feed registered to the addressed room", async () => {
    const state = isolatedAdminState();
    await state.load();
    const auth = new AdminAuthManager({
      password: "correct horse battery staple",
      randomToken: () => "f".repeat(43),
    });
    let control: AdminChannelFeedControl = {
      id: "market-wire",
      channelId: "stock-market",
      kind: "market_ticker",
      label: "MarketWire",
      description: "Bounded market snapshots.",
      publisher: { id: "market-wire", name: "MarketWire", badge: "BOT" as const },
      available: true,
      enabled: true,
      discussionFrequency: 50,
      activeIntervalMinutes: 5,
      idleIntervalMinutes: 30,
      defaultEnabled: true,
      defaultDiscussionFrequency: 50,
      defaultActiveIntervalMinutes: 5,
      defaultIdleIntervalMinutes: 30,
      minimumIntervalMinutes: 5,
      maximumIntervalMinutes: 1_440,
      status: "ready",
      cardAvailable: true,
      failures: 0,
      nextPollAt: Date.UTC(2026, 6, 19, 17, 30),
    };
    const configured: unknown[] = [];
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth,
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
      getChannelFeedControls: () => [control],
      configureChannelFeed: async (_feedId, patch) => {
        configured.push(patch);
        control = { ...control, ...patch, status: patch.enabled ? "waiting" : "disabled" };
        return control;
      },
    }));

    const login = await dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "correct horse battery staple" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const initial = await dispatch(app, { method: "GET", path: "/api/admin/state", cookie });
    expect(initial.body).toMatchObject({ state: { automation: { channelFeeds: [{ id: "market-wire", enabled: true }] } } });

    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/channels/stock-market/feeds/market-wire",
      cookie,
      origin: "https://evil.example",
      body: { enabled: false, discussionFrequency: 35, activeIntervalMinutes: 5, idleIntervalMinutes: 45 },
    })).status).toBe(403);
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/channels/lobby/feeds/market-wire",
      cookie,
      origin: "https://admin.example",
      body: { enabled: true, discussionFrequency: 35, activeIntervalMinutes: 5, idleIntervalMinutes: 45 },
    })).status).toBe(404);
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/channels/stock-market/feeds/market-wire",
      cookie,
      origin: "https://admin.example",
      body: { enabled: true, discussionFrequency: 35, activeIntervalMinutes: 4, idleIntervalMinutes: 45 },
    })).status).toBe(400);
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/channels/stock-market/feeds/market-wire",
      cookie,
      origin: "https://admin.example",
      body: { enabled: true, discussionFrequency: 101, activeIntervalMinutes: 5, idleIntervalMinutes: 45 },
    })).status).toBe(400);
    expect(configured).toEqual([]);

    const updated = await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/channels/stock-market/feeds/market-wire",
      cookie,
      origin: "https://admin.example",
      body: { enabled: false, discussionFrequency: 35, activeIntervalMinutes: 5, idleIntervalMinutes: 45 },
    });
    expect(updated.status).toBe(200);
    expect(configured).toEqual([{
      enabled: false,
      discussionFrequency: 35,
      activeIntervalMinutes: 5,
      idleIntervalMinutes: 45,
    }]);
    expect(updated.body).toMatchObject({
      state: { automation: { channelFeeds: [{ id: "market-wire", enabled: false, idleIntervalMinutes: 45 }] } },
    });
  });

  it("protects the complete external-agent credential lifecycle behind authenticated same-origin administration", async () => {
    const state = isolatedAdminState();
    await state.load();
    const auth = new AdminAuthManager({
      password: "correct horse battery staple",
      randomToken: () => "a".repeat(43),
    });
    const createdAt = new Date(Date.UTC(2026, 6, 22, 10)).toISOString();
    const revokedAt = new Date(Date.UTC(2026, 6, 22, 11)).toISOString();
    const createToken = `ttp_agent_${"c".repeat(43)}`;
    const rotatedToken = `ttp_agent_${"d".repeat(43)}`;
    const calls = { create: 0, update: 0, revoke: 0, rotate: 0 };
    let agents: AdminExternalAgent[] = [];

    const issue = (
      agent: AdminExternalAgent,
      token: string,
    ): AdminExternalAgentCredential => ({
      agent,
      token,
      bootstrapUrl: "https://admin.example/api/agents/v1/bootstrap",
      handoffPrompt: "Keep the owner's personality, then follow The Third Place community contract.",
    });
    const externalAgents = {
      list: () => agents.map((agent) => ({ ...agent, channelIds: [...agent.channelIds], scopes: [...agent.scopes] })),
      create: async (input: AdminExternalAgentWrite) => {
        calls.create += 1;
        const agent: AdminExternalAgent = {
          id: "agent-owner-friend",
          ...input,
          channelIds: [...input.channelIds],
          scopes: [...input.scopes],
          state: "enabled",
          presence: "offline",
          createdAt,
        };
        agents = [agent];
        return issue(agent, createToken);
      },
      update: async (agentId: string, input: AdminExternalAgentWrite) => {
        calls.update += 1;
        const current = agents.find((agent) => agent.id === agentId);
        if (!current) return undefined;
        const updated: AdminExternalAgent = {
          ...current,
          ...input,
          channelIds: [...input.channelIds],
          scopes: [...input.scopes],
        };
        agents = agents.map((agent) => agent.id === agentId ? updated : agent);
        return updated;
      },
      revoke: async (agentId: string) => {
        calls.revoke += 1;
        const current = agents.find((agent) => agent.id === agentId);
        if (!current) return undefined;
        const revoked: AdminExternalAgent = {
          ...current,
          state: "revoked",
          presence: "offline",
          revokedAt,
        };
        agents = agents.map((agent) => agent.id === agentId ? revoked : agent);
        return revoked;
      },
      rotate: async (agentId: string) => {
        calls.rotate += 1;
        const current = agents.find((agent) => agent.id === agentId);
        if (!current) return undefined;
        const { revokedAt: _removed, ...retained } = current;
        const enabled: AdminExternalAgent = { ...retained, state: "enabled" };
        agents = agents.map((agent) => agent.id === agentId ? enabled : agent);
        return issue(enabled, rotatedToken);
      },
    };
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth,
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
      externalAgents,
    }));

    expect((await dispatch(app, { method: "GET", path: "/api/admin/agents" })).status).toBe(401);
    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents",
      origin: "https://admin.example",
      body: {},
    })).status).toBe(401);

    const login = await dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "correct horse battery staple" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const initial = await dispatch(app, { method: "GET", path: "/api/admin/agents", cookie });
    expect(initial.status).toBe(200);
    expect(initial.headers["cache-control"]).toContain("no-store");
    expect(initial.body).toEqual({ agents: [] });

    const write: AdminExternalAgentWrite = {
      displayName: "Owner's Scout",
      publicBio: "A curious visitor operated by a community member.",
      personalityPrompt: "Be candid, curious, a little dry, and preserve the owner's defined voice.",
      channelIds: ["lobby", "ai-programming"],
      scopes: ["rooms:read", "messages:write", "reactions:write"],
    };
    const rejectedCreate = await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents",
      cookie,
      origin: "https://evil.example",
      body: write,
    });
    expect(rejectedCreate.status).toBe(403);
    expect(calls.create).toBe(0);

    const created = await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents",
      cookie,
      origin: "https://admin.example",
      body: write,
    });
    expect(created.status).toBe(201);
    expect(created.headers["cache-control"]).toContain("no-store");
    expect(created.body).toMatchObject({
      agent: { id: "agent-owner-friend", personalityPrompt: write.personalityPrompt, state: "enabled" },
      token: createToken,
      bootstrapUrl: "https://admin.example/api/agents/v1/bootstrap",
    });
    expect(calls.create).toBe(1);

    const listed = await dispatch(app, { method: "GET", path: "/api/admin/agents", cookie });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ agents: [{ id: "agent-owner-friend", personalityPrompt: write.personalityPrompt }] });
    expect(JSON.stringify(listed.body)).not.toContain(createToken);
    expect(JSON.stringify(listed.body)).not.toContain("handoffPrompt");

    const updateWrite: AdminExternalAgentWrite = {
      ...write,
      publicBio: "A candid and curious visitor.",
      personalityPrompt: "Keep the owner's dry humor and answer concretely.",
      channelIds: ["lobby"],
    };
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/agents/agent-owner-friend",
      cookie,
      origin: "https://evil.example",
      body: updateWrite,
    })).status).toBe(403);
    expect(calls.update).toBe(0);
    const updated = await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/agents/agent-owner-friend",
      cookie,
      origin: "https://admin.example",
      body: updateWrite,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ agent: { publicBio: updateWrite.publicBio, channelIds: ["lobby"] } });
    expect(JSON.stringify(updated.body)).not.toContain(createToken);
    expect((await dispatch(app, {
      method: "PATCH",
      path: "/api/admin/agents/missing",
      cookie,
      origin: "https://admin.example",
      body: updateWrite,
    })).status).toBe(404);

    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents/agent-owner-friend/revoke",
      cookie,
      origin: "https://evil.example",
      body: {},
    })).status).toBe(403);
    expect(calls.revoke).toBe(0);
    const revoked = await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents/agent-owner-friend/revoke",
      cookie,
      origin: "https://admin.example",
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ agent: { state: "revoked", revokedAt } });
    expect(JSON.stringify(revoked.body)).not.toContain(createToken);
    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents/missing/revoke",
      cookie,
      origin: "https://admin.example",
      body: {},
    })).status).toBe(404);

    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents/agent-owner-friend/rotate-token",
      cookie,
      origin: "https://evil.example",
      body: {},
    })).status).toBe(403);
    expect(calls.rotate).toBe(0);
    const rotated = await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents/agent-owner-friend/rotate-token",
      cookie,
      origin: "https://admin.example",
      body: {},
    });
    expect(rotated.status).toBe(201);
    expect(rotated.headers["cache-control"]).toContain("no-store");
    expect(rotated.body).toMatchObject({ agent: { state: "enabled" }, token: rotatedToken });
    expect(JSON.stringify(rotated.body)).not.toContain(createToken);
    const listedAfterRotation = await dispatch(app, { method: "GET", path: "/api/admin/agents", cookie });
    expect(JSON.stringify(listedAfterRotation.body)).not.toContain(createToken);
    expect(JSON.stringify(listedAfterRotation.body)).not.toContain(rotatedToken);
    expect(JSON.stringify(listedAfterRotation.body)).not.toContain("handoffPrompt");
    expect((await dispatch(app, {
      method: "POST",
      path: "/api/admin/agents/missing/rotate-token",
      cookie,
      origin: "https://admin.example",
      body: {},
    })).status).toBe(404);
  });

  it("fails closed with 503 when external-agent administration is not wired", async () => {
    const state = isolatedAdminState();
    await state.load();
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth: new AdminAuthManager({
        password: "correct horse battery staple",
        randomToken: () => "u".repeat(43),
      }),
      state,
      configuredOrigins: ["https://admin.example"],
      getHumans: () => [],
      kickHuman: () => undefined,
      banHuman: () => undefined,
    }));
    const login = await dispatch(app, {
      method: "POST",
      path: "/api/admin/session",
      origin: "https://admin.example",
      body: { password: "correct horse battery staple" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;

    const unavailable = await Promise.all([
      dispatch(app, { method: "GET", path: "/api/admin/agents", cookie }),
      dispatch(app, {
        method: "POST",
        path: "/api/admin/agents",
        cookie,
        origin: "https://admin.example",
        body: {},
      }),
      dispatch(app, {
        method: "PATCH",
        path: "/api/admin/agents/missing",
        cookie,
        origin: "https://admin.example",
        body: {},
      }),
      dispatch(app, {
        method: "POST",
        path: "/api/admin/agents/missing/revoke",
        cookie,
        origin: "https://admin.example",
        body: {},
      }),
      dispatch(app, {
        method: "POST",
        path: "/api/admin/agents/missing/rotate-token",
        cookie,
        origin: "https://admin.example",
        body: {},
      }),
    ]);
    expect(unavailable.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
    unavailable.forEach((response) => {
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(response.body).toMatchObject({ ok: false });
    });
  });
});
