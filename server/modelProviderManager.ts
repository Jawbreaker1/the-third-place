import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { CodexBackend } from "./codexBackend.js";
import type { ModelProviderId } from "./modelBackend.js";
import { ModelBackendError } from "./modelBackend.js";
import type { SwitchableSocialModel } from "./switchableModel.js";

const persistedSchema = z.object({
  version: z.literal(1),
  activeProvider: z.enum(["lmstudio", "codex"]),
}).strict();

export type AdminLlmSnapshot = {
  activeProvider: ModelProviderId;
  providers: {
    lmstudio: { status: "connected" | "disconnected" | "error"; model?: string; detail?: string };
    codex: {
      status: "authenticated" | "signed-out" | "pending" | "unavailable" | "error";
      model: string;
      reasoningEffort: "low";
      accountLabel?: string;
      detail?: string;
    };
  };
};

export interface AdminLlmProviderControl {
  snapshot(): Promise<AdminLlmSnapshot>;
  setActiveProvider(provider: ModelProviderId): Promise<void>;
  startCodexLogin(): Promise<{
    status: "pending" | "authenticated";
    detail?: string;
    instructions?: string;
    verificationUrl?: string;
    userCode?: string;
  }>;
  logoutCodex(): Promise<void>;
}

export class ModelProviderManagerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderManagerError";
  }
}

export interface ModelProviderManagerOptions {
  path?: string;
  persist?: (state: unknown) => Promise<void>;
}

export class ModelProviderManager implements AdminLlmProviderControl {
  readonly path: string;
  private readonly customPersist?: (state: unknown) => Promise<void>;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly model: SwitchableSocialModel,
    private readonly codex: CodexBackend,
    options: ModelProviderManagerOptions = {},
  ) {
    this.path = resolve(options.path ?? process.env.LLM_PROVIDER_STATE_PATH ?? "data/llm-provider.json");
    this.customPersist = options.persist;
  }

  async load(): Promise<void> {
    const configured = process.env.LLM_PROVIDER === "codex" || process.env.LLM_PROVIDER === "lmstudio"
      ? process.env.LLM_PROVIDER
      : "lmstudio";
    let activeProvider: ModelProviderId = configured;
    try {
      const parsed = persistedSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      activeProvider = parsed.activeProvider;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.model.select(activeProvider, "Restoring configured AI provider");
  }

  activeProvider(): ModelProviderId {
    return this.model.activeProvider();
  }

  async snapshot(): Promise<AdminLlmSnapshot> {
    const [lmProbe, codexState] = await Promise.all([
      this.model.client("lmstudio").probe(),
      this.codexAdminState(),
    ]);
    return {
      activeProvider: this.model.activeProvider(),
      providers: {
        lmstudio: {
          status: lmProbe.connected ? "connected" : "disconnected",
          ...(lmProbe.id ? { model: lmProbe.id } : {}),
          ...(!lmProbe.connected ? { detail: "Start LM Studio and load the configured local model." } : {}),
        },
        codex: codexState,
      },
    };
  }

  private async codexAdminState(): Promise<AdminLlmSnapshot["providers"]["codex"]> {
    const login = this.codex.loginStatus();
    try {
      const account = await this.codex.account();
      if (login.pending && (!account.authenticated || account.method !== "chatgpt")) {
        return {
          status: "pending",
          model: this.codex.configuredModel,
          reasoningEffort: "low",
          detail: "Complete the device-code login, then refresh status.",
        };
      }
      if (!account.authenticated) {
        return {
          status: login.error ? "error" : "signed-out",
          model: this.codex.configuredModel,
          reasoningEffort: "low",
          ...(login.error ? { detail: login.error } : {}),
        };
      }
      if (account.method !== "chatgpt") {
        return {
          status: "error",
          model: this.codex.configuredModel,
          reasoningEffort: "low",
          detail: "This isolated Codex session must use ChatGPT subscription login, not an API key.",
        };
      }
      const probe = await this.codex.probe();
      return {
        status: probe.connected ? "authenticated" : "error",
        model: this.codex.configuredModel,
        reasoningEffort: "low",
        ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
        ...(probe.detail ? { detail: probe.detail } : {}),
      };
    } catch (error) {
      return {
        status: "unavailable",
        model: this.codex.configuredModel,
        reasoningEffort: "low",
        detail: error instanceof Error ? error.message.slice(0, 300) : "Codex CLI is unavailable.",
      };
    }
  }

  async setActiveProvider(provider: ModelProviderId): Promise<void> {
    const run = this.writeQueue.then(async () => {
      if (provider === this.model.activeProvider()) return;
      if (provider === "codex") {
        const state = await this.codexAdminState();
        if (state.status !== "authenticated") {
          throw new ModelProviderManagerError(409, "CODEX_NOT_READY", "Connect a compatible ChatGPT subscription before selecting GPT-5.6 Luna.");
        }
      }
      await this.persist({ version: 1, activeProvider: provider });
      this.model.select(provider, `AI provider switched to ${provider}`);
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  async startCodexLogin() {
    try {
      const account = await this.codex.account().catch(() => ({ authenticated: false as const }));
      if (account.authenticated && account.method === "chatgpt") {
        return { status: "authenticated" as const, detail: "ChatGPT is already connected." };
      }
      const login = await this.codex.startDeviceLogin();
      return {
        status: "pending" as const,
        instructions: "Open the official verification page, sign in to ChatGPT and enter the one-time code.",
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
      };
    } catch (error) {
      if (error instanceof ModelBackendError) {
        throw new ModelProviderManagerError(error.status, error.code, error.message);
      }
      throw error;
    }
  }

  async logoutCodex(): Promise<void> {
    const run = this.writeQueue.then(async () => {
      if (this.model.activeProvider() === "codex") {
        throw new ModelProviderManagerError(409, "CODEX_ACTIVE", "Switch to local Gemma before disconnecting ChatGPT.");
      }
      try {
        await this.codex.logout();
      } catch (error) {
        if (error instanceof ModelBackendError) {
          throw new ModelProviderManagerError(error.status, error.code, error.message);
        }
        throw error;
      }
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.codex.close();
  }

  private async persist(state: z.infer<typeof persistedSchema>): Promise<void> {
    const parsed = persistedSchema.parse(state);
    if (this.customPersist) {
      await this.customPersist(structuredClone(parsed));
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
