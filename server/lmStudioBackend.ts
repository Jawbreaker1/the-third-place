import type { ModelBackend, ModelBackendProbe } from "./modelBackend.js";
import { ModelBackendError } from "./modelBackend.js";

export interface LmStudioBackendOptions {
  baseUrl?: string;
  model?: string;
  apiToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class LmStudioBackend implements ModelBackend {
  readonly providerId = "lmstudio" as const;
  readonly configuredModel?: string;
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private resolvedModel?: string;

  constructor(options: LmStudioBackendOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/$/u, "");
    this.configuredModel = options.model ?? (process.env.LM_STUDIO_MODEL?.trim() || undefined);
    this.apiToken = options.apiToken ?? (process.env.LM_STUDIO_API_TOKEN?.trim() || undefined);
    this.timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.LM_STUDIO_TIMEOUT_MS ?? "90000", 10);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(): Record<string, string> {
    return this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {};
  }

  async probe(signal?: AbortSignal): Promise<ModelBackendProbe> {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("LM Studio probe timed out", "TimeoutError")), Math.min(this.timeoutMs, 5_000));
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!response.ok) throw new ModelBackendError(`LM Studio returned ${response.status}`, response.status, "LM_STUDIO_HTTP");
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const available = payload.data?.map((entry) => entry.id).filter((id): id is string => Boolean(id)) ?? [];
      this.resolvedModel = this.configuredModel || available[0];
      return {
        connected: Boolean(this.resolvedModel),
        ...(this.resolvedModel ? { id: this.resolvedModel } : {}),
        label: this.resolvedModel?.split("/").at(-1)?.replaceAll("-", " ") ?? "LM Studio offline",
        latencyMs: Math.round(performance.now() - started),
        ...(!this.resolvedModel ? { detail: "No loaded LM Studio model was reported." } : {}),
      };
    } catch (error) {
      return {
        connected: false,
        label: "LM Studio offline",
        detail: error instanceof Error ? error.message.slice(0, 300) : "LM Studio is unavailable.",
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const model = this.configuredModel ?? this.resolvedModel ?? (await this.probe(signal)).id;
    if (!model) throw new ModelBackendError("No LM Studio model is available", 404, "MODEL_UNAVAILABLE");
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model }),
      signal,
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new ModelBackendError(`LM Studio ${response.status}: ${details}`, response.status, "LM_STUDIO_HTTP");
    }
    return await response.json();
  }
}
