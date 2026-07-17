import type {
  AdminBehaviorPatch,
  AdminChannelWrite,
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
