export type AdminLlmProviderId = "lmstudio" | "codex";

export type AdminLmStudioStatus = "connected" | "disconnected" | "error";
export type AdminCodexStatus = "authenticated" | "signed-out" | "pending" | "unavailable" | "error";

export interface AdminLmStudioProviderState {
  status: AdminLmStudioStatus;
  model?: string;
  detail?: string;
}

export interface AdminCodexProviderState {
  status: AdminCodexStatus;
  model: string;
  reasoningEffort: "low";
  accountLabel?: string;
  detail?: string;
}

export interface AdminLlmState {
  activeProvider: AdminLlmProviderId;
  providers: {
    lmstudio: AdminLmStudioProviderState;
    codex: AdminCodexProviderState;
  };
}

export interface AdminCodexLoginResult {
  status: AdminCodexStatus;
  detail?: string;
  instructions?: string;
  verificationUrl?: string;
  userCode?: string;
}

export const CODEX_LUNA_MODEL = "gpt-5.6-luna";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

const boundedString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
};

const asProviderId = (value: unknown): AdminLlmProviderId =>
  value === "codex" ? "codex" : "lmstudio";

const asLmStudioStatus = (value: unknown): AdminLmStudioStatus =>
  value === "connected" || value === "error" ? value : "disconnected";

const asCodexStatus = (value: unknown, fallback: AdminCodexStatus = "unavailable"): AdminCodexStatus =>
  value === "authenticated"
  || value === "signed-out"
  || value === "pending"
  || value === "unavailable"
  || value === "error"
    ? value
    : fallback;

const safeVerificationUrl = (value: unknown): string | undefined => {
  const text = boundedString(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const trustedHost = url.hostname === "openai.com"
      || url.hostname.endsWith(".openai.com")
      || url.hostname === "chatgpt.com"
      || url.hostname.endsWith(".chatgpt.com");
    if (!trustedHost) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
};

/**
 * Treat the admin response as an untrusted transport boundary. Provider
 * credentials are deliberately absent from this public view model.
 */
export function normalizeAdminLlmState(value: unknown): AdminLlmState {
  const envelope = asRecord(value);
  const root = isRecord(envelope.state) ? envelope.state : envelope;
  const providers = asRecord(root.providers);
  const lmstudio = asRecord(providers.lmstudio);
  const codex = asRecord(providers.codex);

  return {
    activeProvider: asProviderId(root.activeProvider),
    providers: {
      lmstudio: {
        status: asLmStudioStatus(lmstudio.status),
        ...(boundedString(lmstudio.model, 160) ? { model: boundedString(lmstudio.model, 160) } : {}),
        ...(boundedString(lmstudio.detail, 500) ? { detail: boundedString(lmstudio.detail, 500) } : {}),
      },
      codex: {
        status: asCodexStatus(codex.status),
        model: boundedString(codex.model, 160) ?? CODEX_LUNA_MODEL,
        reasoningEffort: "low",
        ...(boundedString(codex.accountLabel, 200) ? { accountLabel: boundedString(codex.accountLabel, 200) } : {}),
        ...(boundedString(codex.detail, 500) ? { detail: boundedString(codex.detail, 500) } : {}),
      },
    },
  };
}

export function normalizeAdminCodexLoginResult(value: unknown): AdminCodexLoginResult {
  const envelope = asRecord(value);
  const root = isRecord(envelope.codex) ? envelope.codex : envelope;
  return {
    status: asCodexStatus(root.status, root.ok === true ? "pending" : "error"),
    ...(boundedString(root.detail, 500) ? { detail: boundedString(root.detail, 500) } : {}),
    ...(boundedString(root.instructions, 1_500) ? { instructions: boundedString(root.instructions, 1_500) } : {}),
    ...(safeVerificationUrl(root.verificationUrl) ? { verificationUrl: safeVerificationUrl(root.verificationUrl) } : {}),
    ...(boundedString(root.userCode, 100) ? { userCode: boundedString(root.userCode, 100) } : {}),
  };
}

export function mergeCodexLoginResult(
  state: AdminLlmState,
  result: AdminCodexLoginResult,
): AdminLlmState {
  return {
    ...state,
    providers: {
      ...state.providers,
      codex: {
        ...state.providers.codex,
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      },
    },
  };
}

export const adminLlmProviderReady = (state: AdminLlmState, provider: AdminLlmProviderId): boolean =>
  provider === "lmstudio"
    ? state.providers.lmstudio.status === "connected"
    : state.providers.codex.status === "authenticated";

export const codexStatusLabel = (status: AdminCodexStatus): string => ({
  authenticated: "Connected",
  "signed-out": "Not signed in",
  pending: "Login pending",
  unavailable: "Codex CLI unavailable",
  error: "Connection error",
})[status];

export const lmStudioStatusLabel = (status: AdminLmStudioStatus): string => ({
  connected: "Connected",
  disconnected: "Not connected",
  error: "Connection error",
})[status];
