import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type {
  AdminAutonomousResearchDiagnostics,
  AdminChannelFeedControl,
  AdminChannelFeedPatch,
  AdminHumanMember,
} from "../shared/adminTypes.js";
import {
  AdminAuthManager,
  adminCookie,
  adminTokenFromCookie,
  clearAdminCookie,
  hasStrictAdminOrigin,
} from "./adminAuth.js";
import { AdminStateError, AdminStateStore } from "./adminState.js";
import { ModelProviderManagerError, type AdminLlmProviderControl } from "./modelProviderManager.js";
import type { SocialMemoryAdmin } from "./socialMemoryAdmin.js";

const loginSchema = z.object({ password: z.string().min(1).max(1_024) }).strict();
const moderationSchema = z.object({ reason: z.string().min(1).max(240).optional() }).strict();
const idParam = z.string().min(1).max(100);
const providerPatchSchema = z.object({ activeProvider: z.enum(["lmstudio", "codex"]) }).strict();
const emptyBodySchema = z.object({}).strict();
const memoryPatchSchema = z.object({ pinned: z.boolean() }).strict();
const channelFeedPatchSchema = z.object({
  enabled: z.boolean(),
  discussionFrequency: z.number().int().min(0).max(100),
  activeIntervalMinutes: z.number().int().min(1).max(1_440),
  idleIntervalMinutes: z.number().int().min(1).max(1_440),
}).strict().refine(
  (value) => value.idleIntervalMinutes >= value.activeIntervalMinutes,
  { message: "The quiet-room interval cannot be shorter than the active-room interval." },
);

export interface AdminRouterDependencies {
  auth: AdminAuthManager;
  state: AdminStateStore;
  configuredOrigins: readonly string[];
  getHumans: () => AdminHumanMember[];
  getAutonomousResearchDiagnostics?: () => AdminAutonomousResearchDiagnostics;
  getChannelFeedControls?: () => AdminChannelFeedControl[];
  configureChannelFeed?: (
    feedId: string,
    patch: AdminChannelFeedPatch,
  ) => Promise<AdminChannelFeedControl | void>;
  kickHuman: (memberId: string, reason?: string) => AdminHumanMember | undefined;
  banHuman: (memberId: string, reason?: string) => AdminHumanMember | undefined;
  /** Issues a new one-time-disclosed portable return key for a retained human identity. */
  issueHumanRecoveryKey?: (memberId: string) => Promise<{ name: string; recoveryKey: string } | undefined>;
  isSecure?: (request: Request) => boolean;
  now?: () => number;
  llmProviders?: AdminLlmProviderControl;
  onLlmProviderChanged?: () => Promise<void> | void;
  socialMemory?: Pick<
    SocialMemoryAdmin,
    "getOverview" | "getActorDetail" | "setMemoryPinned" | "deleteMemory" | "resetRelationship"
  >;
  /** Durable cross-store erasure for a trusted human identity. */
  forgetHumanActor?: (actorId: string) => Promise<boolean>;
}

const sendError = (response: Response, error: unknown): void => {
  if (error instanceof AdminStateError) {
    response.status(error.status).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  if (error instanceof ModelProviderManagerError) {
    response.status(error.status).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({ ok: false, code: "INVALID_INPUT", error: "The admin update contains invalid or out-of-range fields." });
    return;
  }
  throw error;
};

export const createAdminRouter = (dependencies: AdminRouterDependencies): Router => {
  const router = Router();
  const now = dependencies.now ?? Date.now;
  const secure = (request: Request) =>
    dependencies.isSecure?.(request) ?? (request.secure || process.env.PUBLIC_ORIGIN?.startsWith("https://") === true);

  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Pragma", "no-cache");
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (!mutating) {
      next();
      return;
    }
    if (!hasStrictAdminOrigin({
      headers: request.headers,
      protocol: request.protocol,
      host: request.get("host"),
    }, dependencies.configuredOrigins)) {
      response.status(403).json({ ok: false, code: "ORIGIN_REQUIRED", error: "Admin changes require a same-origin browser request." });
      return;
    }
    next();
  });

  router.post("/session", (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, authenticated: false, error: "Enter the configured admin password." });
      return;
    }
    // Express derives request.ip from the socket unless the operator has
    // explicitly configured a trusted proxy. The raw value crosses this route
    // boundary once and is immediately HMACed by AdminAuthManager.
    const sourceIdentity = request.ip || request.socket.remoteAddress || "unknown";
    const result = dependencies.auth.login(parsed.data.password, sourceIdentity);
    if (!result.ok) {
      const status = result.code === "NOT_CONFIGURED" ? 503 : result.code === "RATE_LIMITED" ? 429 : 401;
      const error = result.code === "NOT_CONFIGURED"
        ? "Administration is disabled until ADMIN_PASSWORD is configured."
        : result.code === "RATE_LIMITED"
          ? "Too many admin login attempts. Wait before trying again."
          : "Invalid admin credentials.";
      response.status(status).json({ ok: false, authenticated: false, error });
      return;
    }
    response.setHeader("Set-Cookie", adminCookie(
      result.token,
      Math.max(0, Math.floor((result.expiresAt - now()) / 1_000)),
      secure(request),
    ));
    response.status(201).json({ ok: true, authenticated: true });
  });

  router.get("/session", (request, response) => {
    const token = adminTokenFromCookie(request.headers.cookie);
    const session = dependencies.auth.validate(token);
    if (!session) {
      response.status(401).json({ ok: false, authenticated: false });
      return;
    }
    response.json({ ok: true, authenticated: true, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  router.delete("/session", (request, response) => {
    dependencies.auth.revoke(adminTokenFromCookie(request.headers.cookie));
    response.setHeader("Set-Cookie", clearAdminCookie(secure(request)));
    response.json({ ok: true, authenticated: false });
  });

  router.use((request, response, next) => {
    const token = adminTokenFromCookie(request.headers.cookie);
    if (!dependencies.auth.validate(token)) {
      response.status(401).json({ ok: false, authenticated: false, error: "Admin authentication is required." });
      return;
    }
    next();
  });

  const stateResponse = () => {
    const state = dependencies.state.snapshot(dependencies.getHumans());
    const autonomousResearch = dependencies.getAutonomousResearchDiagnostics?.();
    return {
      ...state,
      automation: {
        ...state.automation,
        ...(autonomousResearch ? { autonomousResearch } : {}),
        channelFeeds: dependencies.getChannelFeedControls?.() ?? [],
      },
    };
  };
  router.get("/state", (_request, response) => response.json({ ok: true, state: stateResponse() }));

  router.get("/llm", async (_request, response, next) => {
    if (!dependencies.llmProviders) {
      response.status(503).json({ ok: false, error: "AI provider administration is unavailable." });
      return;
    }
    try {
      response.json(await dependencies.llmProviders.snapshot());
    } catch (error) {
      next(error);
    }
  });

  router.patch("/llm", async (request, response, next) => {
    if (!dependencies.llmProviders) {
      response.status(503).json({ ok: false, error: "AI provider administration is unavailable." });
      return;
    }
    try {
      const patch = providerPatchSchema.parse(request.body);
      await dependencies.llmProviders.setActiveProvider(patch.activeProvider);
      await dependencies.onLlmProviderChanged?.();
      response.json(await dependencies.llmProviders.snapshot());
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.post("/llm/codex/login", async (request, response, next) => {
    if (!dependencies.llmProviders) {
      response.status(503).json({ ok: false, error: "Codex CLI is unavailable." });
      return;
    }
    try {
      emptyBodySchema.parse(request.body ?? {});
      response.json(await dependencies.llmProviders.startCodexLogin());
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.delete("/llm/codex/session", async (request, response, next) => {
    if (!dependencies.llmProviders) {
      response.status(503).json({ ok: false, error: "Codex CLI is unavailable." });
      return;
    }
    try {
      emptyBodySchema.parse(request.body ?? {});
      await dependencies.llmProviders.logoutCodex();
      response.status(204).end();
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.patch("/behavior", async (request, response, next) => {
    try {
      await dependencies.state.updateBehavior(request.body);
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.post("/personas", async (request, response, next) => {
    try {
      await dependencies.state.createPersona(request.body);
      response.status(201).json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });
  const updatePersona = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const id = idParam.parse(request.params.id);
      await dependencies.state.updatePersona(id, request.body);
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  };
  router.patch("/personas/:id", updatePersona);
  router.put("/personas/:id", updatePersona);
  router.delete("/personas/:id", async (request, response, next) => {
    try {
      await dependencies.state.deletePersona(idParam.parse(request.params.id));
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.post("/channels", async (request, response, next) => {
    try {
      await dependencies.state.createChannel(request.body);
      response.status(201).json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });
  const updateChannel = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const id = idParam.parse(request.params.id);
      await dependencies.state.updateChannel(id, request.body);
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  };
  router.patch("/channels/:id", updateChannel);
  router.put("/channels/:id", updateChannel);
  router.delete("/channels/:id", async (request, response, next) => {
    try {
      await dependencies.state.deleteChannel(idParam.parse(request.params.id));
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.patch("/channels/:channelId/feeds/:feedId", async (request, response, next) => {
    if (!dependencies.configureChannelFeed || !dependencies.getChannelFeedControls) {
      response.status(503).json({ ok: false, code: "CHANNEL_FEEDS_UNAVAILABLE", error: "Room integration controls are unavailable." });
      return;
    }
    try {
      const channelId = idParam.parse(request.params.channelId);
      const feedId = idParam.parse(request.params.feedId);
      const patch = channelFeedPatchSchema.parse(request.body);
      const control = dependencies.getChannelFeedControls().find((candidate) => candidate.id === feedId);
      if (!control || control.channelId !== channelId) {
        response.status(404).json({ ok: false, code: "CHANNEL_FEED_NOT_FOUND", error: "That integration is not registered for this room." });
        return;
      }
      if (!dependencies.state.snapshot().channels.some((channel) => channel.id === channelId)) {
        response.status(404).json({ ok: false, code: "CHANNEL_NOT_FOUND", error: "That channel is not active." });
        return;
      }
      if (!control.available && patch.enabled) {
        response.status(409).json({ ok: false, code: "CHANNEL_FEED_UNAVAILABLE", error: "That integration is unavailable in this server process." });
        return;
      }
      if (
        patch.activeIntervalMinutes < control.minimumIntervalMinutes
        || patch.idleIntervalMinutes < control.minimumIntervalMinutes
        || patch.activeIntervalMinutes > control.maximumIntervalMinutes
        || patch.idleIntervalMinutes > control.maximumIntervalMinutes
      ) {
        response.status(400).json({ ok: false, code: "CHANNEL_FEED_INTERVAL", error: `Intervals must be between ${control.minimumIntervalMinutes} and ${control.maximumIntervalMinutes} minutes.` });
        return;
      }
      await dependencies.configureChannelFeed(feedId, patch);
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.post("/humans/:id/kick", (request, response) => {
    const parsedBody = moderationSchema.safeParse(request.body ?? {});
    const parsedId = idParam.safeParse(request.params.id);
    if (!parsedBody.success || !parsedId.success) {
      response.status(400).json({ ok: false, error: "That moderation request is invalid." });
      return;
    }
    const human = dependencies.kickHuman(parsedId.data, parsedBody.data.reason);
    if (!human) {
      response.status(404).json({ ok: false, error: "That human session was not found." });
      return;
    }
    response.json({ ok: true, state: stateResponse() });
  });

  router.post("/humans/:id/ban", async (request, response, next) => {
    const parsedBody = moderationSchema.safeParse(request.body ?? {});
    const parsedId = idParam.safeParse(request.params.id);
    if (!parsedBody.success || !parsedId.success) {
      response.status(400).json({ ok: false, error: "That moderation request is invalid." });
      return;
    }
    const human = dependencies.getHumans().find((candidate) => candidate.id === parsedId.data);
    if (!human) {
      response.status(404).json({ ok: false, error: "That human session was not found." });
      return;
    }
    try {
      await dependencies.state.addBan({
        memberId: human.id,
        name: human.name,
        ...(parsedBody.data.reason ? { reason: parsedBody.data.reason } : {}),
        bannedAt: new Date(now()).toISOString(),
      });
      dependencies.banHuman(human.id, parsedBody.data.reason);
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.post("/humans/:id/recovery-key", async (request, response, next) => {
    const parsedBody = emptyBodySchema.safeParse(request.body ?? {});
    const parsedId = idParam.safeParse(request.params.id);
    if (!parsedBody.success || !parsedId.success) {
      response.status(400).json({ ok: false, error: "That return-key request is invalid." });
      return;
    }
    if (!dependencies.issueHumanRecoveryKey) {
      response.status(503).json({ ok: false, error: "Identity recovery is unavailable." });
      return;
    }
    try {
      const issued = await dependencies.issueHumanRecoveryKey(parsedId.data);
      if (!issued) {
        response.status(404).json({ ok: false, error: "That saved human identity was not found." });
        return;
      }
      // The raw key is deliberately returned once and is never included in a
      // later state snapshot. The router-wide private/no-store headers apply.
      response.status(201).json({ ok: true, ...issued });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/bans/:memberId", async (request, response, next) => {
    try {
      await dependencies.state.removeBan(idParam.parse(request.params.memberId));
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.get("/memory", (_request, response) => {
    if (!dependencies.socialMemory) {
      response.status(503).json({ ok: false, error: "Social memory administration is unavailable." });
      return;
    }
    response.json(dependencies.socialMemory.getOverview());
  });

  router.get("/memory/actors/:id", (request, response) => {
    if (!dependencies.socialMemory) {
      response.status(503).json({ ok: false, error: "Social memory administration is unavailable." });
      return;
    }
    const parsedId = idParam.safeParse(request.params.id);
    const detail = parsedId.success ? dependencies.socialMemory.getActorDetail(parsedId.data) : undefined;
    if (!detail) {
      response.status(404).json({ ok: false, error: "That memory actor was not found." });
      return;
    }
    response.json(detail);
  });

  router.delete("/memory/actors/:id", async (request, response, next) => {
    if (!dependencies.socialMemory || !dependencies.forgetHumanActor) {
      response.status(503).json({ ok: false, error: "Human memory erasure is unavailable." });
      return;
    }
    try {
      const actorId = idParam.parse(request.params.id);
      const detail = dependencies.socialMemory.getActorDetail(actorId);
      if (!detail) {
        response.status(404).json({ ok: false, error: "That memory actor was not found." });
        return;
      }
      if (detail.actor.kind !== "human") {
        response.status(409).json({
          ok: false,
          code: "ACTOR_NOT_HUMAN",
          error: "Only human identities can be erased from the memory inspector.",
        });
        return;
      }
      if (!await dependencies.forgetHumanActor(actorId)) {
        response.status(404).json({ ok: false, error: "That human identity is no longer retained." });
        return;
      }
      response.status(204).end();
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.patch("/memory/items/:id", (request, response, next) => {
    if (!dependencies.socialMemory) {
      response.status(503).json({ ok: false, error: "Social memory administration is unavailable." });
      return;
    }
    try {
      const id = idParam.parse(request.params.id);
      const patch = memoryPatchSchema.parse(request.body);
      if (!dependencies.socialMemory.setMemoryPinned(id, patch.pinned)) {
        response.status(404).json({ ok: false, error: "That memory item was not found or already had that state." });
        return;
      }
      response.status(204).end();
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.delete("/memory/items/:id", (request, response, next) => {
    if (!dependencies.socialMemory) {
      response.status(503).json({ ok: false, error: "Social memory administration is unavailable." });
      return;
    }
    try {
      if (!dependencies.socialMemory.deleteMemory(idParam.parse(request.params.id))) {
        response.status(404).json({ ok: false, error: "That memory item was not found." });
        return;
      }
      response.status(204).end();
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  router.delete("/memory/relationships/:ownerId/:subjectId", (request, response, next) => {
    if (!dependencies.socialMemory) {
      response.status(503).json({ ok: false, error: "Social memory administration is unavailable." });
      return;
    }
    try {
      const ownerId = idParam.parse(request.params.ownerId);
      const subjectId = idParam.parse(request.params.subjectId);
      if (!dependencies.socialMemory.resetRelationship(ownerId, subjectId)) {
        response.status(404).json({ ok: false, error: "That directed relationship was not found." });
        return;
      }
      response.status(204).end();
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  return router;
};
