export type ModelProviderId = "lmstudio" | "codex";

export interface ModelBackendProbe {
  connected: boolean;
  id?: string;
  label: string;
  latencyMs?: number;
  detail?: string;
}

export interface ModelBackend {
  readonly providerId: ModelProviderId;
  readonly configuredModel?: string;
  probe(signal?: AbortSignal): Promise<ModelBackendProbe>;
  complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close?(): Promise<void>;
}

export class ModelBackendError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = "MODEL_BACKEND_ERROR",
  ) {
    super(message);
    this.name = "ModelBackendError";
  }
}
