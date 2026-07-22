import type {
  AdminBehaviorPatch,
  AdminChannelFeedPatch,
  AdminChannelWrite,
  AdminExternalAgent,
  AdminExternalAgentCredential,
  AdminExternalAgentList,
  AdminExternalAgentWrite,
  AdminMemoryActorDetail,
  AdminMemoryItemPatch,
  AdminMemoryOverview,
  AdminPersonaWrite,
  AdminSessionState,
  AdminStateSnapshot,
} from "../shared/adminTypes";
import { normalizeAdminState } from "./adminModel";
import {
  normalizeAdminCodexLoginResult,
  normalizeAdminLlmState,
  type AdminCodexLoginResult,
  type AdminLlmProviderId,
  type AdminLlmState,
} from "./adminLlmModel";

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AdminApiError";
  }
}

const parseResponseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
};

const errorMessage = (body: unknown, fallback: string): string => {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  return typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : fallback;
};

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await parseResponseBody(response);
  if (!response.ok) throw new AdminApiError(errorMessage(body, `Admin request failed (${response.status})`), response.status);
  return body;
}

const jsonBody = (value: unknown): string => JSON.stringify(value);

const isAdminExternalAgent = (value: unknown): value is AdminExternalAgent => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const scopes = record.scopes;
  return typeof record.id === "string"
    && typeof record.displayName === "string"
    && typeof record.publicBio === "string"
    && typeof record.personalityPrompt === "string"
    && Array.isArray(record.channelIds)
    && record.channelIds.every((channelId) => typeof channelId === "string")
    && Array.isArray(scopes)
    && scopes.every((scope) => scope === "rooms:read" || scope === "messages:write" || scope === "reactions:write")
    && (record.state === "enabled" || record.state === "revoked")
    && (record.presence === "online" || record.presence === "idle" || record.presence === "offline")
    && typeof record.createdAt === "string"
    && (record.lastSeenAt === undefined || typeof record.lastSeenAt === "string")
    && (record.revokedAt === undefined || typeof record.revokedAt === "string");
};

const agentFromResponse = (body: unknown, error = "The external-agent response was invalid."): AdminExternalAgent => {
  if (!body || typeof body !== "object") throw new AdminApiError(error, 502);
  const record = body as Record<string, unknown>;
  const candidate = record.agent && typeof record.agent === "object"
    ? record.agent
    : record;
  if (!isAdminExternalAgent(candidate)) throw new AdminApiError(error, 502);
  return candidate;
};

const credentialFromResponse = (body: unknown): AdminExternalAgentCredential => {
  if (!body || typeof body !== "object") {
    throw new AdminApiError("The one-time external-agent credential response was invalid.", 502);
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.token !== "string"
    || !record.token
    || typeof record.bootstrapUrl !== "string"
    || !record.bootstrapUrl
  ) {
    throw new AdminApiError("The one-time external-agent credential response was invalid.", 502);
  }
  return {
    agent: agentFromResponse(record),
    token: record.token,
    bootstrapUrl: record.bootstrapUrl,
    ...(typeof record.handoffPrompt === "string" ? { handoffPrompt: record.handoffPrompt } : {}),
  };
};

export async function getAdminSession(): Promise<AdminSessionState> {
  try {
    const body = await request("/api/admin/session");
    if (!body || typeof body !== "object") return { authenticated: true };
    const record = body as Record<string, unknown>;
    return { authenticated: record.authenticated === true || record.ok === true };
  } catch (error) {
    if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
      return { authenticated: false };
    }
    throw error;
  }
}

export async function createAdminSession(password: string): Promise<void> {
  await request("/api/admin/session", { method: "POST", body: jsonBody({ password }) });
}

export async function deleteAdminSession(): Promise<void> {
  try {
    await request("/api/admin/session", { method: "DELETE" });
  } catch (error) {
    // An expired/missing server session is already a confirmed signed-out state.
    // Every other failure may leave the HttpOnly cookie valid and must surface.
    if (error instanceof AdminApiError && error.status === 401) return;
    throw error;
  }
}

export async function getAdminState(): Promise<AdminStateSnapshot> {
  return normalizeAdminState(await request("/api/admin/state"));
}

export async function getAdminLlmState(): Promise<AdminLlmState> {
  return normalizeAdminLlmState(await request("/api/admin/llm"));
}

export async function patchAdminLlmProvider(activeProvider: AdminLlmProviderId): Promise<void> {
  await request("/api/admin/llm", { method: "PATCH", body: jsonBody({ activeProvider }) });
}

export async function startAdminCodexLogin(): Promise<AdminCodexLoginResult> {
  return normalizeAdminCodexLoginResult(await request("/api/admin/llm/codex/login", { method: "POST" }));
}

export async function deleteAdminCodexSession(): Promise<void> {
  await request("/api/admin/llm/codex/session", { method: "DELETE" });
}

export async function patchAdminBehavior(patch: AdminBehaviorPatch): Promise<void> {
  await request("/api/admin/behavior", { method: "PATCH", body: jsonBody(patch) });
}

export async function createAdminPersona(persona: AdminPersonaWrite): Promise<void> {
  await request("/api/admin/personas", { method: "POST", body: jsonBody(persona) });
}

export async function patchAdminPersona(id: string, persona: AdminPersonaWrite): Promise<void> {
  await request(`/api/admin/personas/${encodeURIComponent(id)}`, { method: "PATCH", body: jsonBody(persona) });
}

export async function deleteAdminPersona(id: string): Promise<void> {
  await request(`/api/admin/personas/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function createAdminChannel(channel: AdminChannelWrite): Promise<void> {
  await request("/api/admin/channels", { method: "POST", body: jsonBody(channel) });
}

export async function patchAdminChannel(id: string, channel: AdminChannelWrite): Promise<void> {
  await request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: "PATCH", body: jsonBody(channel) });
}

export async function deleteAdminChannel(id: string): Promise<void> {
  await request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function patchAdminChannelFeed(
  channelId: string,
  feedId: string,
  patch: AdminChannelFeedPatch,
): Promise<void> {
  await request(
    `/api/admin/channels/${encodeURIComponent(channelId)}/feeds/${encodeURIComponent(feedId)}`,
    { method: "PATCH", body: jsonBody(patch) },
  );
}

export async function moderateAdminHuman(id: string, action: "kick" | "ban"): Promise<void> {
  await request(`/api/admin/humans/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

export async function issueAdminHumanRecoveryKey(id: string): Promise<{ name: string; recoveryKey: string }> {
  const body = await request(`/api/admin/humans/${encodeURIComponent(id)}/recovery-key`, {
    method: "POST",
    body: jsonBody({}),
  });
  if (!body || typeof body !== "object") throw new AdminApiError("The return-key response was invalid.", 502);
  const record = body as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.recoveryKey !== "string") {
    throw new AdminApiError("The return-key response was invalid.", 502);
  }
  return { name: record.name, recoveryKey: record.recoveryKey };
}

export async function deleteAdminBan(memberId: string): Promise<void> {
  await request(`/api/admin/bans/${encodeURIComponent(memberId)}`, { method: "DELETE" });
}

export async function getAdminAgents(): Promise<AdminExternalAgentList> {
  const body = await request("/api/admin/agents");
  const agents = Array.isArray(body)
    ? body
    : body && typeof body === "object" ? (body as Record<string, unknown>).agents : undefined;
  if (!Array.isArray(agents) || !agents.every(isAdminExternalAgent)) {
    throw new AdminApiError("The external-agent list response was invalid.", 502);
  }
  return { agents };
}

export async function createAdminAgent(agent: AdminExternalAgentWrite): Promise<AdminExternalAgentCredential> {
  return credentialFromResponse(await request("/api/admin/agents", {
    method: "POST",
    body: jsonBody(agent),
  }));
}

export async function patchAdminAgent(id: string, agent: AdminExternalAgentWrite): Promise<AdminExternalAgent> {
  return agentFromResponse(await request(`/api/admin/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: jsonBody(agent),
  }));
}

export async function revokeAdminAgent(id: string): Promise<AdminExternalAgent> {
  return agentFromResponse(await request(`/api/admin/agents/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    body: jsonBody({}),
  }));
}

export async function rotateAdminAgentToken(id: string): Promise<AdminExternalAgentCredential> {
  return credentialFromResponse(await request(`/api/admin/agents/${encodeURIComponent(id)}/rotate-token`, {
    method: "POST",
    body: jsonBody({}),
  }));
}

export async function getAdminMemory(): Promise<AdminMemoryOverview> {
  return await request("/api/admin/memory") as AdminMemoryOverview;
}

export async function getAdminMemoryActor(id: string): Promise<AdminMemoryActorDetail> {
  return await request(`/api/admin/memory/actors/${encodeURIComponent(id)}`) as AdminMemoryActorDetail;
}

export async function deleteAdminMemoryActor(id: string): Promise<void> {
  await request(`/api/admin/memory/actors/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function patchAdminMemoryItem(id: string, patch: AdminMemoryItemPatch): Promise<void> {
  await request(`/api/admin/memory/items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: jsonBody(patch),
  });
}

export async function deleteAdminMemoryItem(id: string): Promise<void> {
  await request(`/api/admin/memory/items/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteAdminMemoryRelationship(ownerId: string, subjectId: string): Promise<void> {
  await request(
    `/api/admin/memory/relationships/${encodeURIComponent(ownerId)}/${encodeURIComponent(subjectId)}`,
    { method: "DELETE" },
  );
}
