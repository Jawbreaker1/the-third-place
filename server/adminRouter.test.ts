import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
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
    const state = new AdminStateStore({ persist: async () => undefined });
    await state.load();
    const auth = new AdminAuthManager({
      password: "correct horse battery staple",
      randomToken: () => "r".repeat(43),
    });
    const human = { id: "human-1", name: "Alex", status: "online" as const };
    const kicked: Array<{ memberId: string; reason?: string }> = [];
    const banned: Array<{ memberId: string; reason?: string }> = [];
    const app = express();
    app.use("/api/admin", createAdminRouter({
      auth,
      state,
      configuredOrigins: ["https://admin.example"],
      isSecure: () => true,
      getHumans: () => [human],
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
    expect(initial.body).toMatchObject({ ok: true, state: { behavior: { channels: {} } } });

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
    const state = new AdminStateStore({ persist: async () => undefined });
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
    const state = new AdminStateStore({ persist: async () => undefined });
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
    const state = new AdminStateStore({ persist: async () => undefined });
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
});
