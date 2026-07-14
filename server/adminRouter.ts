import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AdminHumanMember } from "../shared/adminTypes.js";
import {
  AdminAuthManager,
  adminCookie,
  adminTokenFromCookie,
  clearAdminCookie,
  hasStrictAdminOrigin,
} from "./adminAuth.js";
import { AdminStateError, AdminStateStore } from "./adminState.js";
import { ModelProviderManagerError, type AdminLlmProviderControl } from "./modelProviderManager.js";

const loginSchema = z.object({ password: z.string().min(1).max(1_024) }).strict();
const moderationSchema = z.object({ reason: z.string().min(1).max(240).optional() }).strict();
const idParam = z.string().min(1).max(100);
const providerPatchSchema = z.object({ activeProvider: z.enum(["lmstudio", "codex"]) }).strict();
const emptyBodySchema = z.object({}).strict();

export interface AdminRouterDependencies {
  auth: AdminAuthManager;
  state: AdminStateStore;
  configuredOrigins: readonly string[];
  getHumans: () => AdminHumanMember[];
  kickHuman: (memberId: string, reason?: string) => AdminHumanMember | undefined;
  banHuman: (memberId: string, reason?: string) => AdminHumanMember | undefined;
  isSecure?: (request: Request) => boolean;
  now?: () => number;
  llmProviders?: AdminLlmProviderControl;
  onLlmProviderChanged?: () => Promise<void> | void;
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

  const stateResponse = () => dependencies.state.snapshot(dependencies.getHumans());
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

  router.delete("/bans/:memberId", async (request, response, next) => {
    try {
      await dependencies.state.removeBan(idParam.parse(request.params.memberId));
      response.json({ ok: true, state: stateResponse() });
    } catch (error) {
      try { sendError(response, error); } catch (unhandled) { next(unhandled); }
    }
  });

  return router;
};
