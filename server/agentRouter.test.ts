import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedExternalAgent } from "../shared/agentTypes.js";
import type { Channel, ChannelFeedCard, ChatMessage, Member } from "../shared/types.js";
import {
  EXTERNAL_AGENT_API_BASE_PATH,
  EXTERNAL_AGENT_CHANNEL_FEED_SCHEMA_VERSION,
  EXTERNAL_AGENT_API_VERSION,
  createExternalAgentRouter,
  externalAgentMessageId,
  type ExternalAgentActivityPage,
  type ExternalAgentApiResult,
  type ExternalAgentBootstrapState,
  type ExternalAgentMessageInput,
  type ExternalAgentRouterDependencies,
} from "./agentRouter.js";

interface DispatchOptions {
  method: string;
  path: string;
  authorization?: string;
  cookie?: string;
  host?: string;
  origin?: string;
  body?: unknown;
  remoteAddress?: string;
  encrypted?: boolean;
  xForwardedProto?: string;
}

interface DispatchResult {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: unknown;
}

const dispatch = async (app: Express, options: DispatchOptions): Promise<DispatchResult> =>
  await new Promise((resolve, reject) => {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", {
      configurable: true,
      value: options.remoteAddress ?? "127.0.0.1",
    });
    if (options.encrypted) {
      Object.defineProperty(socket, "encrypted", { configurable: true, value: true });
    }
    const request = new IncomingMessage(socket);
    request.method = options.method;
    request.url = options.path;
    request.headers = {
      host: options.host ?? "third-place.example",
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.xForwardedProto ? { "x-forwarded-proto": options.xForwardedProto } : {}),
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
      resolve({ status: response.statusCode, headers: response.getHeaders(), body });
      socket.destroy();
      return response;
    }) as typeof response.end;

    app.handle(request, response, reject);
  });

const TOKEN = `ttp_agent_${"A".repeat(43)}`;
const INVITATION_TOKEN = `ttp_invite_${"B".repeat(43)}`;
const PRIVATE_PERSONALITY_CANARY = "owner-private-personality-must-never-cross-the-api";
const AGENT: AuthenticatedExternalAgent = {
  id: "agent-owner-defined",
  displayName: "Patchwork Finch",
  publicBio: "A dry-witted field researcher from outside the server.",
  channelIds: ["lobby"],
  scopes: ["rooms:read", "messages:write"],
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
};

const CHANNELS: Channel[] = [
  { id: "lobby", name: "lobby", description: "The common room." },
  { id: "secret-room", name: "secret-room", description: "Not granted." },
];

const MEMBERS: Member[] = [
  {
    id: "ai-mira",
    name: "Mira",
    kind: "ai",
    status: "online",
    avatar: { color: "#111", accent: "#eee", glyph: "M" },
    bio: "Resident.",
  },
  {
    id: AGENT.id,
    name: AGENT.displayName,
    kind: "agent",
    status: "online",
    avatar: { color: "#123", accent: "#fff", glyph: "P" },
    bio: AGENT.publicBio,
  },
];

const marketFeed = (channelId: string, id = `market-wire-${channelId}`): ChannelFeedCard => ({
  id,
  kind: "market_ticker",
  channelId,
  publisher: {
    id: "market-wire",
    name: "MarketWire",
    badge: "BOT",
    avatar: { color: "#173f3a", accent: "#56d5ad", glyph: "MW" },
  },
  revision: 3,
  state: "ready",
  title: "World markets",
  targetId: "global-indices",
  updatedAt: "2026-07-22T08:00:00.000Z",
  retrievedAt: "2026-07-22T08:00:00.000Z",
  requestedIndexIds: ["omx30"],
  missingIndexIds: [],
  coverage: { requested: 1, available: 1, ratio: 1, complete: true },
  observations: [{
    indexId: "omx30",
    displayName: "OMX Stockholm 30",
    shortName: "OMXS30",
    currency: "SEK",
    level: 2_742.15,
    previousClose: 2_730,
    change: 12.15,
    changePercent: 0.45,
    changeBasis: "previous_close",
    tradingDate: "2026-07-22",
    observedAt: "2026-07-22T08:00:00.000Z",
    freshness: "recent",
    source: {
      id: "market-source",
      label: "Market source",
      url: "https://example.com/markets",
      retrievedAt: "2026-07-22T08:00:00.000Z",
      experimental: false,
    },
  }],
});

const message = (
  channelId: string,
  id = "a4db19c2-68bb-4c5d-a82b-a08d11905274",
  content = "hello from context",
): ChatMessage => ({
  id,
  channelId,
  authorId: "ai-mira",
  content,
  createdAt: "2026-07-22T08:01:00.000Z",
  reactions: [],
});

const successfulActivity = (): ExternalAgentApiResult<ExternalAgentActivityPage> => ({
  ok: true,
  value: { cursor: "cursor-next", events: [] },
});

const dependencies = (
  overrides: Partial<ExternalAgentRouterDependencies> = {},
): ExternalAgentRouterDependencies => ({
  access: {
    authenticate: (token) => token === TOKEN ? { ...AGENT, channelIds: [...AGENT.channelIds], scopes: [...AGENT.scopes] } : undefined,
    touch: async (agentId) => agentId === AGENT.id ? { ...AGENT, channelIds: [...AGENT.channelIds], scopes: [...AGENT.scopes] } : undefined,
  },
  enroll: async (invitationToken, profile) => invitationToken === INVITATION_TOKEN
    ? {
      ok: true,
      value: {
        agent: { ...AGENT, ...profile, channelIds: [...AGENT.channelIds], scopes: [...AGENT.scopes] },
        token: TOKEN,
      },
    }
    : {
      ok: false,
      status: 401,
      code: "INVALID_INVITATION",
      error: "A valid, unexpired and unused external-agent invitation is required.",
    },
  updateProfile: async (agent, profile) => ({
    ok: true,
    value: { ...agent, ...profile, updatedAt: "2026-07-22T08:04:00.000Z" },
  }),
  getBootstrapState: () => ({
    ok: true,
    value: {
      cursor: "cursor-bootstrap",
      channels: CHANNELS,
      members: MEMBERS,
      channelFeeds: [marketFeed("lobby"), marketFeed("secret-room")],
      recentMessagesByChannel: {
        lobby: [message("lobby")],
        "secret-room": [message("secret-room")],
      },
    },
  }),
  getActivity: async () => successfulActivity(),
  createMessage: async (input) => ({
    ok: true,
    value: {
      duplicate: false,
      message: {
        id: input.clientMessageId,
        channelId: input.channelId,
        authorId: input.agent.id,
        content: input.content,
        createdAt: "2026-07-22T08:02:00.000Z",
        reactions: [],
      },
    },
  }),
  setReaction: async (input) => ({
    ok: true,
    value: {
      channelId: input.channelId,
      messageId: input.messageId,
      emoji: input.emoji,
      active: input.active,
    },
  }),
  now: () => Date.parse("2026-07-22T08:03:00.000Z"),
  ...overrides,
});

const application = (overrides: Partial<ExternalAgentRouterDependencies> = {}): Express => {
  const app = express();
  app.use(EXTERNAL_AGENT_API_BASE_PATH, createExternalAgentRouter(dependencies(overrides)));
  return app;
};

const authorization = { authorization: `Bearer ${TOKEN}` };

describe("external-agent HTTP API", () => {
  it("derives a stable UUID-shaped server message ID from actor and client idempotency key", () => {
    const clientId = "677dc39a-649f-4e48-9930-de377b88bccd";
    const first = externalAgentMessageId(AGENT.id, clientId);
    expect(first).toBe(externalAgentMessageId(AGENT.id, clientId));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(externalAgentMessageId("agent-someone-else", clientId)).not.toBe(first);
    expect(externalAgentMessageId(AGENT.id, "75ff26ea-c40e-4848-8ea5-44ff5be1da91")).not.toBe(first);
  });

  it("accepts only header bearer credentials, rejects browser origins and never reflects secrets", async () => {
    const getBootstrapState = vi.fn(dependencies().getBootstrapState);
    const app = application({ getBootstrapState });

    const anonymous = await dispatch(app, { method: "GET", path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap` });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toContain("Bearer");
    expect(anonymous.headers["cache-control"]).toContain("no-store");

    const cookieOnly = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      cookie: `atrium_session=${TOKEN}`,
    });
    expect(cookieOnly.status).toBe(401);

    const invitationAsBearer = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      authorization: `Bearer ${INVITATION_TOKEN}`,
    });
    const agentTokenAsInvitation = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      authorization: `Invite ${TOKEN}`,
    });
    expect(invitationAsBearer.status).toBe(401);
    expect(agentTokenAsInvitation.status).toBe(401);

    const queryCredential = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap?access_token=${encodeURIComponent(TOKEN)}`,
    });
    expect(queryCredential.status).toBe(400);
    expect(queryCredential.body).toMatchObject({ code: "CREDENTIAL_IN_QUERY" });
    expect(JSON.stringify(queryCredential.body)).not.toContain(TOKEN);

    const browser = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      origin: "https://third-place.example",
      ...authorization,
    });
    expect(browser.status).toBe(403);
    expect(browser.body).toMatchObject({ code: "BROWSER_ORIGIN_REJECTED" });
    expect(getBootstrapState).not.toHaveBeenCalled();
  });

  it("redeems a header-only invitation into a public profile and one-time bearer", async () => {
    const enroll = vi.fn(dependencies().enroll);
    const app = application({ enroll });
    const result = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
      authorization: `Invite ${INVITATION_TOKEN}`,
      body: {
        displayName: "  Patchwork Finch  ",
        publicBio: "  A curious visitor.\u0000  ",
      },
    });

    expect(result.status).toBe(201);
    expect(result.headers["cache-control"]).toContain("no-store");
    expect(result.body).toMatchObject({
      ok: true,
      protocolVersion: EXTERNAL_AGENT_API_VERSION,
      agent: {
        id: AGENT.id,
        displayName: "Patchwork Finch",
        publicBio: "A curious visitor.",
        channelIds: ["lobby"],
      },
      token: TOKEN,
      bootstrapPath: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
    });
    expect(enroll).toHaveBeenCalledWith(INVITATION_TOKEN, {
      displayName: "Patchwork Finch",
      publicBio: "A curious visitor.",
    });
    expect(JSON.stringify(result.body)).not.toContain("personalityPrompt");
  });

  it("makes missing, replayed and wrong-class invitation credentials indistinguishable", async () => {
    const enroll = vi.fn(async () => ({
      ok: false,
      status: 401,
      code: "INVALID_INVITATION",
      error: "A valid, unexpired and unused external-agent invitation is required.",
    } as const));
    const app = application({ enroll });
    const profile = { displayName: "New Visitor", publicBio: "Public profile." };
    const requests: DispatchOptions[] = [
      { method: "POST", path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`, body: profile },
      {
        method: "POST",
        path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
        authorization: `Bearer ${INVITATION_TOKEN}`,
        body: profile,
      },
      {
        method: "POST",
        path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
        authorization: `Invite ${TOKEN}`,
        body: profile,
      },
      {
        method: "POST",
        path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
        authorization: `Invite ${INVITATION_TOKEN}`,
        body: profile,
      },
    ];
    const results = [];
    for (const request of requests) results.push(await dispatch(app, request));

    expect(results.map((result) => result.status)).toEqual([401, 401, 401, 401]);
    expect(results.map((result) => result.body)).toEqual([
      results[0]!.body,
      results[0]!.body,
      results[0]!.body,
      results[0]!.body,
    ]);
    results.forEach((result) => {
      expect(result.headers["www-authenticate"]).toContain("Invite");
      expect(JSON.stringify(result.body)).not.toContain(INVITATION_TOKEN);
      expect(JSON.stringify(result.body)).not.toContain(TOKEN);
    });
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it("maps a consumed-invitation replay to the generic invitation failure without creating a second identity", async () => {
    let available = true;
    const enroll = vi.fn(async (invitationToken: string) => {
      if (invitationToken === INVITATION_TOKEN && available) {
        available = false;
        return { ok: true, value: { agent: { ...AGENT }, token: TOKEN } } as const;
      }
      return {
        ok: false,
        status: 401,
        code: "INVALID_INVITATION",
        error: "A valid, unexpired and unused external-agent invitation is required.",
      } as const;
    });
    const app = application({ enroll });
    const request: DispatchOptions = {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
      authorization: `Invite ${INVITATION_TOKEN}`,
      body: { displayName: "Patchwork Finch", publicBio: "Public profile." },
    };

    expect((await dispatch(app, request)).status).toBe(201);
    const replay = await dispatch(app, request);
    expect(replay.status).toBe(401);
    expect(replay.headers["www-authenticate"]).toContain("Invite");
    expect(replay.body).toEqual({
      ok: false,
      code: "INVALID_INVITATION",
      error: "A valid, unexpired and unused external-agent invitation is required.",
    });
    expect(JSON.stringify(replay.body)).not.toContain(INVITATION_TOKEN);
    expect(enroll).toHaveBeenCalledTimes(2);
  });

  it("rejects enrollment authority smuggling and applies transport, Origin and query guards", async () => {
    const enroll = vi.fn(dependencies().enroll);
    const app = application({ enroll });
    const smuggled = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
      authorization: `Invite ${INVITATION_TOKEN}`,
      body: {
        displayName: "New Visitor",
        publicBio: "Public profile.",
        channelIds: ["secret-room"],
        scopes: ["messages:write"],
        personalityPrompt: PRIVATE_PERSONALITY_CANARY,
        invitationToken: INVITATION_TOKEN,
      },
    });
    expect(smuggled.status).toBe(400);
    expect(JSON.stringify(smuggled.body)).not.toContain(INVITATION_TOKEN);

    const query = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll?token=${encodeURIComponent(INVITATION_TOKEN)}`,
      body: { displayName: "New Visitor", publicBio: "Public profile." },
    });
    expect(query.status).toBe(400);
    expect(query.body).toMatchObject({ code: "CREDENTIAL_IN_QUERY" });

    const pathCredential = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll/${INVITATION_TOKEN}`,
      body: { displayName: "New Visitor", publicBio: "Public profile." },
    });
    expect(pathCredential.status).toBe(404);
    expect(JSON.stringify(pathCredential.body)).not.toContain(INVITATION_TOKEN);

    const browser = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
      origin: "https://third-place.example",
      authorization: `Invite ${INVITATION_TOKEN}`,
      body: { displayName: "New Visitor", publicBio: "Public profile." },
    });
    expect(browser.status).toBe(403);

    const plaintext = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
      remoteAddress: "192.168.1.42",
      authorization: `Invite ${INVITATION_TOKEN}`,
      body: { displayName: "New Visitor", publicBio: "Public profile." },
    });
    expect(plaintext.status).toBe(426);
    expect(enroll).not.toHaveBeenCalled();
  });

  it("lets the authenticated owner update only its public profile", async () => {
    const updateProfile = vi.fn(dependencies().updateProfile);
    const app = application({ updateProfile });
    const updated = await dispatch(app, {
      method: "PATCH",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/profile`,
      ...authorization,
      body: { publicBio: "  Updated by the owner.  " },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      ok: true,
      agent: {
        id: AGENT.id,
        publicBio: "Updated by the owner.",
        configurationVersion: "2026-07-22T08:04:00.000Z",
        channelIds: ["lobby"],
        scopes: AGENT.scopes,
      },
    });
    expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGENT.id }),
      { publicBio: "Updated by the owner." },
    );

    for (const body of [
      {},
      { scopes: ["reactions:write"] },
      { channelIds: ["secret-room"] },
      { personalityPrompt: PRIVATE_PERSONALITY_CANARY },
      { id: "agent-someone-else", publicBio: "Hijack." },
    ]) {
      const rejected = await dispatch(app, {
        method: "PATCH",
        path: `${EXTERNAL_AGENT_API_BASE_PATH}/profile`,
        ...authorization,
        body,
      });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.body)).not.toContain(PRIVATE_PERSONALITY_CANARY);
    }
    expect(updateProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps owner-runtime identity primary without receiving or returning a private personality", async () => {
    const authenticatedIds: string[] = [];
    const app = application({
      onAuthenticated: (agent) => { authenticatedIds.push(agent.id); },
    });
    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      host: "attacker.invalid",
      ...authorization,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      protocolVersion: EXTERNAL_AGENT_API_VERSION,
      self: {
        id: AGENT.id,
        configurationVersion: AGENT.updatedAt,
        channelIds: ["lobby"],
      },
      channels: [{ id: "lobby" }],
      activityCursor: "cursor-bootstrap",
      prompt: {
        layering: "owner_runtime_primary_then_community_appendix",
        ownerRuntime: {
          priority: "primary",
          managedBy: "owner",
          transmittedToServer: false,
        },
        communityAppendix: { priority: "additive" },
      },
      actions: {
        enroll: {
          method: "POST",
          path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll`,
          authorization: "Invite ttp_invite_…",
          body: {
            contentType: "application/json",
            schema: {
              additionalProperties: false,
              required: ["displayName", "publicBio"],
            },
          },
        },
        bootstrap: { path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap` },
        updateProfile: {
          method: "PATCH",
          path: `${EXTERNAL_AGENT_API_BASE_PATH}/profile`,
          body: {
            contentType: "application/json",
            schema: {
              additionalProperties: false,
              minProperties: 1,
              properties: {
                displayName: { maxLength: 24 },
                publicBio: { maxLength: 240 },
              },
            },
          },
        },
        heartbeat: {
          method: "POST",
          body: {
            contentType: "application/json",
            schema: {
              additionalProperties: false,
              required: ["status"],
              properties: { status: { enum: ["online", "idle"] } },
            },
          },
        },
        createMessage: {
          method: "POST",
          body: {
            contentType: "application/json",
            schema: {
              additionalProperties: false,
              required: ["clientMessageId", "content"],
              properties: {
                clientMessageId: { format: "uuid" },
                content: { minLength: 1, maxLength: 500 },
                replyToId: { maxLength: 100 },
              },
            },
          },
        },
        setReaction: {
          method: "PUT",
          body: {
            contentType: "application/json",
            schema: {
              additionalProperties: false,
              required: ["emoji", "active"],
              properties: {
                emoji: { type: "string" },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
      unsupported: ["dm", "voice", "image_upload", "moderation", "administration"],
    });
    const payload = result.body as {
      prompt: { ownerRuntime: { instruction: string }; communityAppendix: { text: string } };
      recentContext: Record<string, ChatMessage[]>;
      channelFeeds: { schemaVersion: number; cards: ChannelFeedCard[] };
      members: Member[];
    };
    expect(payload.prompt.ownerRuntime.instruction).toContain("owner-defined identity");
    expect(payload.prompt.communityAppendix.text).toContain("do not replace or flatten that personality");
    expect(payload.prompt.communityAppendix.text).toContain("silence is a valid action");
    expect(payload.prompt.communityAppendix.text).toContain("untrusted content");
    expect(payload.prompt.communityAppendix.text).toContain("Do not claim to be a human");
    expect(payload.recentContext).toEqual({ lobby: [message("lobby")] });
    expect(payload.recentContext["secret-room"]).toBeUndefined();
    expect(payload.channelFeeds).toEqual({
      schemaVersion: EXTERNAL_AGENT_CHANNEL_FEED_SCHEMA_VERSION,
      cards: [marketFeed("lobby")],
    });
    expect(JSON.stringify(result.body)).not.toContain("personalityPrompt");
    expect(JSON.stringify(result.body)).not.toContain("ownerPersonality");
    expect(JSON.stringify(result.body)).not.toContain("suggestedSystemPrompt");
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
    expect(authenticatedIds).toEqual([AGENT.id]);
  });

  it("publishes the newest public profile and configuration version after a live edit", async () => {
    let currentAgent: AuthenticatedExternalAgent = {
      ...AGENT,
      channelIds: [...AGENT.channelIds],
      scopes: [...AGENT.scopes],
    };
    let release: ((value: ExternalAgentApiResult<ExternalAgentBootstrapState>) => void) | undefined;
    const app = application({
      access: {
        authenticate: (token) => token === TOKEN
          ? { ...currentAgent, channelIds: [...currentAgent.channelIds], scopes: [...currentAgent.scopes] }
          : undefined,
        touch: async () => ({ ...currentAgent }),
      },
      getBootstrapState: async () => await new Promise((resolve) => { release = resolve; }),
    });

    const pending = dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      ...authorization,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    currentAgent = {
      ...currentAgent,
      publicBio: "The owner's newly saved public introduction.",
      updatedAt: "2026-07-22T09:00:00.000Z",
    };
    release?.({
      ok: true,
      value: {
        cursor: "current-config",
        channels: CHANNELS,
        members: MEMBERS,
        channelFeeds: [],
        recentMessagesByChannel: { lobby: [message("lobby")] },
      },
    });

    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      self: {
        publicBio: "The owner's newly saved public introduction.",
        configurationVersion: "2026-07-22T09:00:00.000Z",
      },
    });
  });

  it("keeps credentialed action paths relative even when a public ngrok-style origin is configured", async () => {
    const app = application({ publicOrigin: "https://friends.example" });
    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      host: "attacker.invalid",
      ...authorization,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      actions: {
        enroll: { path: `${EXTERNAL_AGENT_API_BASE_PATH}/enroll` },
        bootstrap: { path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap` },
        updateProfile: { path: `${EXTERNAL_AGENT_API_BASE_PATH}/profile` },
        activity: { path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity` },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("attacker.invalid");
    expect(JSON.stringify(result.body)).not.toContain("friends.example");
  });

  it.each([
    ["http://localhost:4000", "http://localhost:4000"],
    ["http://127.0.0.1:4000", "http://127.0.0.1:4000"],
    ["http://[::1]:4000", "http://[::1]:4000"],
    ["https://friends.example", "https://friends.example"],
  ])("accepts a secure or exact loopback public origin without advertising it (%s)", async (configured, _expectedOrigin) => {
    const app = application({ publicOrigin: configured });
    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      ...authorization,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      actions: {
        bootstrap: { path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap` },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(configured);
  });

  it.each([
    "http://friends.example",
    "http://192.168.1.10:4000",
    "http://0.0.0.0:4000",
    "http://127.0.0.2:4000",
  ])("rejects an insecure non-loopback public origin (%s)", (configured) => {
    expect(() => application({ publicOrigin: configured })).toThrow(
      "External-agent publicOrigin must use HTTPS unless it is localhost, 127.0.0.1, or [::1].",
    );
  });

  it("rejects an actual non-loopback plaintext transport before authenticating", async () => {
    const authenticate = vi.fn(dependencies().access.authenticate);
    const app = application({ access: { ...dependencies().access, authenticate } });
    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      remoteAddress: "192.168.1.42",
      ...authorization,
    });

    expect(result.status).toBe(426);
    expect(result.body).toMatchObject({ code: "HTTPS_REQUIRED" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("does not let Express trust-proxy configuration turn a forwarded header into TLS", async () => {
    const authenticate = vi.fn(dependencies().access.authenticate);
    const app = express();
    app.set("trust proxy", 1);
    app.use(EXTERNAL_AGENT_API_BASE_PATH, createExternalAgentRouter(dependencies({
      access: { ...dependencies().access, authenticate },
    })));
    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      remoteAddress: "192.168.1.42",
      xForwardedProto: "https",
      ...authorization,
    });

    expect(result.status).toBe(426);
    expect(result.body).toMatchObject({ code: "HTTPS_REQUIRED" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("accepts an encrypted non-loopback transport without trusting forwarding headers", async () => {
    const app = application();
    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      remoteAddress: "203.0.113.20",
      encrypted: true,
      ...authorization,
    });

    expect(result.status).toBe(200);
  });

  it("does not return a bootstrap assembled under authority that was removed in flight", async () => {
    let currentAgent: AuthenticatedExternalAgent = {
      ...AGENT,
      channelIds: [...AGENT.channelIds],
      scopes: [...AGENT.scopes],
    };
    let release: ((value: ExternalAgentApiResult<ExternalAgentBootstrapState>) => void) | undefined;
    const app = application({
      access: {
        authenticate: (token) => token === TOKEN
          ? { ...currentAgent, channelIds: [...currentAgent.channelIds], scopes: [...currentAgent.scopes] }
          : undefined,
        touch: async (agentId) => agentId === currentAgent.id
          ? { ...currentAgent, channelIds: [...currentAgent.channelIds], scopes: [...currentAgent.scopes] }
          : undefined,
      },
      getBootstrapState: async () => await new Promise((resolve) => {
        release = resolve;
      }),
    });

    const pending = dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      ...authorization,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    currentAgent = { ...currentAgent, scopes: currentAgent.scopes.filter((scope) => scope !== "rooms:read") };
    release?.({
      ok: true,
      value: {
        cursor: "stale-bootstrap",
        channels: CHANNELS,
        members: MEMBERS,
        channelFeeds: [],
        recentMessagesByChannel: { lobby: [message("lobby")] },
      },
    });

    const result = await pending;
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(JSON.stringify(result.body)).not.toContain(PRIVATE_PERSONALITY_CANARY);
  });

  it("re-authenticates the presented bearer after touch instead of inheriting a rotated credential", async () => {
    let oldTokenValid = true;
    const getBootstrapState = vi.fn(dependencies().getBootstrapState);
    const onAuthenticated = vi.fn();
    const app = application({
      access: {
        authenticate: (token) => token === TOKEN && oldTokenValid ? { ...AGENT } : undefined,
        touch: async () => {
          oldTokenValid = false;
          return { ...AGENT, displayName: "Identity after token rotation" };
        },
      },
      getBootstrapState,
      onAuthenticated,
    });

    const result = await dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/bootstrap`,
      ...authorization,
    });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(getBootstrapState).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("rechecks authority immediately before messages, reactions and heartbeat presence", async () => {
    const authorizedAgent = {
      ...AGENT,
      scopes: [...AGENT.scopes, "reactions:write" as const],
    };
    const requestAfterAuthenticationRevocation = async (
      request: DispatchOptions,
      callbacks: {
        createMessage?: ExternalAgentRouterDependencies["createMessage"];
        setReaction?: ExternalAgentRouterDependencies["setReaction"];
        updateProfile?: ExternalAgentRouterDependencies["updateProfile"];
        onPresence?: ExternalAgentRouterDependencies["onPresence"];
      },
    ) => {
      let valid = true;
      const app = application({
        access: {
          authenticate: (token) => token === TOKEN && valid ? authorizedAgent : undefined,
          touch: async () => authorizedAgent,
        },
        onAuthenticated: () => { valid = false; },
        ...callbacks,
      });
      return await dispatch(app, { ...request, ...authorization });
    };
    const createMessage = vi.fn(dependencies().createMessage);
    const setReaction = vi.fn(dependencies().setReaction);
    const updateProfile = vi.fn(dependencies().updateProfile);
    const onPresence = vi.fn();

    const messageResult = await requestAfterAuthenticationRevocation({
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages`,
      body: {
        clientMessageId: "75ff26ea-c40e-4848-8ea5-44ff5be1da91",
        content: "Must not be published.",
      },
    }, { createMessage });
    const reactionResult = await requestAfterAuthenticationRevocation({
      method: "PUT",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages/b452fc7a-7c62-4dc7-86a0-8deab0f39090/reactions`,
      body: { emoji: "👍", active: true },
    }, { setReaction });
    const heartbeatResult = await requestAfterAuthenticationRevocation({
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/heartbeat`,
      body: { status: "online" },
    }, { onPresence });
    const profileResult = await requestAfterAuthenticationRevocation({
      method: "PATCH",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/profile`,
      body: { publicBio: "Must not be updated." },
    }, { updateProfile });

    expect(messageResult.status).toBe(401);
    expect(reactionResult.status).toBe(401);
    expect(heartbeatResult.status).toBe(401);
    expect(profileResult.status).toBe(401);
    expect(createMessage).not.toHaveBeenCalled();
    expect(setReaction).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(onPresence).not.toHaveBeenCalled();
  });

  it("enforces scopes and exact room grants before invoking mutation callbacks", async () => {
    const createMessage = vi.fn(dependencies().createMessage);
    const setReaction = vi.fn(dependencies().setReaction);
    const app = application({ createMessage, setReaction });
    const clientMessageId = "b7c3cbf6-fcd1-40cb-961c-7fe5a80130bd";
    const messageId = "b452fc7a-7c62-4dc7-86a0-8deab0f39090";

    const hiddenRoom = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/secret-room/messages`,
      body: { clientMessageId, content: "should never publish" },
      ...authorization,
    });
    expect(hiddenRoom.status).toBe(404);
    expect(hiddenRoom.body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(createMessage).not.toHaveBeenCalled();

    const noReactionScope = await dispatch(app, {
      method: "PUT",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages/${messageId}/reactions`,
      body: { emoji: "👍", active: true },
      ...authorization,
    });
    expect(noReactionScope.status).toBe(403);
    expect(noReactionScope.body).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(setReaction).not.toHaveBeenCalled();
  });

  it("passes canonical message input through an idempotent callback and exposes duplicate state", async () => {
    const accepted = new Map<string, ChatMessage>();
    const inputs: ExternalAgentMessageInput[] = [];
    const createMessage = vi.fn(async (input: ExternalAgentMessageInput) => {
      inputs.push(input);
      const previous = accepted.get(input.clientMessageId);
      if (previous) return { ok: true, value: { message: previous, duplicate: true } } as const;
      const created: ChatMessage = {
        id: input.clientMessageId,
        channelId: input.channelId,
        authorId: input.agent.id,
        content: input.content,
        createdAt: "2026-07-22T08:04:00.000Z",
        reactions: [],
      };
      accepted.set(input.clientMessageId, created);
      return { ok: true, value: { message: created, duplicate: false } } as const;
    });
    const app = application({ createMessage });
    const clientMessageId = "677dc39a-649f-4e48-9930-de377b88bccd";
    const body = { clientMessageId, content: "  hey\u0000 there  " };

    const first = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages`,
      body,
      ...authorization,
    });
    const duplicate = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages`,
      body,
      ...authorization,
    });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ok: true, duplicate: false, message: { content: "hey there" } });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true, message: { id: clientMessageId } });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ agent: { id: AGENT.id }, channelId: "lobby", clientMessageId, content: "hey there" });
  });

  it("returns typed callback failures and applies a separate per-agent message bucket", async () => {
    const createMessage = vi.fn(async () => ({
      ok: false,
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      error: "That clientMessageId was already used for a different payload.",
    } as const));
    const onInteractive = vi.fn();
    const app = application({
      createMessage,
      onInteractive,
      rateLimits: {
        messages: { capacity: 1, refillPerSecond: 0 },
        global: { capacity: 100, refillPerSecond: 100 },
        perAgent: { capacity: 100, refillPerSecond: 100 },
      },
    });

    const conflict = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages`,
      body: {
        clientMessageId: "75ff26ea-c40e-4848-8ea5-44ff5be1da91",
        content: "one",
      },
      ...authorization,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const limited = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages`,
      body: {
        clientMessageId: "e5830005-aee7-4c20-b490-1005836970fe",
        content: "two",
      },
      ...authorization,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(onInteractive).not.toHaveBeenCalled();
  });

  it("keeps authentication, interactive activity and explicit heartbeat presence distinct", async () => {
    const reactionAgent = { ...AGENT, scopes: [...AGENT.scopes, "reactions:write" as const] };
    const authenticated: string[] = [];
    const interactive: string[] = [];
    const presence: string[] = [];
    const setReaction = vi.fn(dependencies().setReaction);
    const app = application({
      access: {
        authenticate: (token) => token === TOKEN ? reactionAgent : undefined,
        touch: async () => reactionAgent,
      },
      setReaction,
      onAuthenticated: (agent) => { authenticated.push(agent.id); },
      onInteractive: (agent) => { interactive.push(agent.id); },
      onPresence: (_agent, status) => { presence.push(status); },
    });
    const messageId = "feed-marketwire:revision-42";

    const reaction = await dispatch(app, {
      method: "PUT",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/channels/lobby/messages/${messageId}/reactions`,
      body: { emoji: "🔥", active: false },
      ...authorization,
    });
    expect(reaction.status).toBe(200);
    expect(reaction.body).toMatchObject({ ok: true, messageId, emoji: "🔥", active: false });
    expect(setReaction).toHaveBeenCalledWith(expect.objectContaining({ messageId, emoji: "🔥", active: false }));
    expect(authenticated).toEqual([AGENT.id]);
    expect(interactive).toEqual([AGENT.id]);
    expect(presence).toEqual([]);

    const heartbeat = await dispatch(app, {
      method: "POST",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/heartbeat`,
      body: { status: "idle" },
      ...authorization,
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toMatchObject({ ok: true, status: "idle" });
    expect(authenticated).toEqual([AGENT.id, AGENT.id]);
    expect(interactive).toEqual([AGENT.id]);
    expect(presence).toEqual(["idle"]);
  });

  it("bounds activity parameters, filters ungranted events and permits at most two long polls per agent", async () => {
    const invalidApp = application();
    expect((await dispatch(invalidApp, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?limit=101`,
      ...authorization,
    })).status).toBe(400);
    expect((await dispatch(invalidApp, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?waitMs=25001`,
      ...authorization,
    })).status).toBe(400);

    const pollutedAuthorSnapshot = {
      ...MEMBERS.find((member) => member.id === AGENT.id)!,
      personalityPrompt: PRIVATE_PERSONALITY_CANARY,
    } as Member;
    const filteringApp = application({
      getActivity: async () => ({
        ok: true,
        value: {
          cursor: "after-both",
          events: [
            { type: "message.created", channelId: "secret-room", occurredAt: "2026-07-22T08:05:00.000Z", message: message("secret-room") },
            {
              type: "message.created",
              channelId: "lobby",
              occurredAt: "2026-07-22T08:05:01.000Z",
              message: { ...message("lobby"), authorSnapshot: pollutedAuthorSnapshot },
            },
            {
              type: "channel_feed.sync",
              schemaVersion: EXTERNAL_AGENT_CHANNEL_FEED_SCHEMA_VERSION,
              channelId: "secret-room",
              occurredAt: "2026-07-22T08:05:02.000Z",
              cards: [marketFeed("secret-room")],
            },
            {
              type: "channel_feed.sync",
              schemaVersion: EXTERNAL_AGENT_CHANNEL_FEED_SCHEMA_VERSION,
              channelId: "lobby",
              occurredAt: "2026-07-22T08:05:03.000Z",
              cards: [],
            },
          ],
        },
      }),
    });
    const filtered = await dispatch(filteringApp, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?cursor=opaque&limit=10`,
      ...authorization,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject({
      configurationVersion: AGENT.updatedAt,
      cursor: "after-both",
      events: [
        { type: "message.created", channelId: "lobby" },
        {
          type: "channel_feed.sync",
          schemaVersion: EXTERNAL_AGENT_CHANNEL_FEED_SCHEMA_VERSION,
          channelId: "lobby",
          cards: [],
        },
      ],
    });
    expect(JSON.stringify(filtered.body)).not.toContain(PRIVATE_PERSONALITY_CANARY);

    const releases: Array<(value: ExternalAgentApiResult<ExternalAgentActivityPage>) => void> = [];
    const getActivity = vi.fn(async () => await new Promise<ExternalAgentApiResult<ExternalAgentActivityPage>>((resolve) => {
      releases.push(resolve);
    }));
    const pollingApp = application({
      getActivity,
      rateLimits: {
        global: { capacity: 100, refillPerSecond: 100 },
        perAgent: { capacity: 100, refillPerSecond: 100 },
      },
    });
    const first = dispatch(pollingApp, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?waitMs=25000`,
      ...authorization,
    });
    const second = dispatch(pollingApp, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?waitMs=25000`,
      ...authorization,
    });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const third = await dispatch(pollingApp, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?waitMs=25000`,
      ...authorization,
    });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ code: "TOO_MANY_LONG_POLLS" });
    releases.forEach((release) => release(successfulActivity()));
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("revalidates current room authority after a long poll before returning events", async () => {
    let currentAgent: AuthenticatedExternalAgent = {
      ...AGENT,
      channelIds: [...AGENT.channelIds],
      scopes: [...AGENT.scopes],
    };
    let release: ((value: ExternalAgentApiResult<ExternalAgentActivityPage>) => void) | undefined;
    const app = application({
      access: {
        authenticate: (token) => token === TOKEN
          ? { ...currentAgent, channelIds: [...currentAgent.channelIds], scopes: [...currentAgent.scopes] }
          : undefined,
        touch: async (agentId) => agentId === currentAgent.id
          ? { ...currentAgent, channelIds: [...currentAgent.channelIds], scopes: [...currentAgent.scopes] }
          : undefined,
      },
      getActivity: async () => await new Promise<ExternalAgentApiResult<ExternalAgentActivityPage>>((resolve) => {
        release = resolve;
      }),
    });

    const pending = dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?waitMs=25000`,
      ...authorization,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    currentAgent = { ...currentAgent, channelIds: [] };
    release?.({
      ok: true,
      value: {
        cursor: "after-revoked-room",
        events: [{
          type: "message.created",
          channelId: "lobby",
          occurredAt: "2026-07-22T08:06:00.000Z",
          message: message("lobby"),
        }],
      },
    });

    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ cursor: "after-revoked-room", events: [] });
  });

  it("invalidates an in-flight long poll when its bearer credential is revoked or rotated", async () => {
    let credentialValid = true;
    let release: ((value: ExternalAgentApiResult<ExternalAgentActivityPage>) => void) | undefined;
    const app = application({
      access: {
        authenticate: (token) => credentialValid && token === TOKEN
          ? { ...AGENT, channelIds: [...AGENT.channelIds], scopes: [...AGENT.scopes] }
          : undefined,
        touch: async (agentId) => credentialValid && agentId === AGENT.id
          ? { ...AGENT, channelIds: [...AGENT.channelIds], scopes: [...AGENT.scopes] }
          : undefined,
      },
      getActivity: async () => await new Promise<ExternalAgentApiResult<ExternalAgentActivityPage>>((resolve) => {
        release = resolve;
      }),
    });

    const pending = dispatch(app, {
      method: "GET",
      path: `${EXTERNAL_AGENT_API_BASE_PATH}/activity?waitMs=25000`,
      ...authorization,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    credentialValid = false;
    release?.(successfulActivity());

    const result = await pending;
    expect(result.status).toBe(401);
    expect(result.headers["www-authenticate"]).toContain("Bearer");
    expect(result.body).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});
