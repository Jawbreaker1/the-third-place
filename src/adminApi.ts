import type {
  AdminBehaviorPatch,
  AdminChannelWrite,
  AdminPersonaWrite,
  AdminSessionState,
  AdminStateSnapshot,
} from "../shared/adminTypes";
import { normalizeAdminState } from "./adminModel";

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

export async function deleteAdminBan(memberId: string): Promise<void> {
  await request(`/api/admin/bans/${encodeURIComponent(memberId)}`, { method: "DELETE" });
}
