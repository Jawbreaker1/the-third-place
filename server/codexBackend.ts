import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CodexAppServer, type CodexAppServerOptions, type CodexDeviceLogin } from "./codexAppServer.js";
import type { ModelBackend, ModelBackendProbe } from "./modelBackend.js";
import { ModelBackendError } from "./modelBackend.js";

const MAX_IMAGE_DATA_URL_CHARS = 10 * 1024 * 1024;
const DEFAULT_MAX_TURNS_PER_MINUTE = 24;
const DEFAULT_MAX_TURNS_PER_DAY = 1_200;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;

const positiveTurnBudget = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && value! > 0 ? value! : fallback;

export interface CodexBackendOptions extends CodexAppServerOptions {
  appServer?: CodexAppServer;
  maxTurnsPerMinute?: number;
  maxTurnsPerDay?: number;
  budgetStatePath?: string | false;
  now?: () => number;
}

const extractCompletionInput = (body: Record<string, unknown>) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const developer: string[] = [];
  const inputs: Array<
    | { type: "text"; text: string; text_elements: [] }
    | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" }
  > = [];
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    if (!message) continue;
    const role = message.role;
    const content = message.content;
    if (role === "system" && typeof content === "string") {
      developer.push(content);
      continue;
    }
    if (typeof content === "string") {
      inputs.push({ type: "text", text: content, text_elements: [] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      const part = record(rawPart);
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") {
        inputs.push({ type: "text", text: part.text, text_elements: [] });
        continue;
      }
      if (part.type !== "image_url") continue;
      const imageUrl = record(part.image_url);
      const url = typeof imageUrl?.url === "string" ? imageUrl.url : undefined;
      if (!url || url.length > MAX_IMAGE_DATA_URL_CHARS || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/u.test(url)) {
        throw new ModelBackendError("Codex image input must be one bounded inline JPEG, PNG or WebP image.", 400, "CODEX_IMAGE_REJECTED");
      }
      inputs.push({ type: "image", url, detail: "auto" });
    }
  }
  if (developer.length === 0 || inputs.length === 0) {
    throw new ModelBackendError("Codex completion input is missing trusted instructions or user data.", 400, "CODEX_INPUT_INVALID");
  }
  const responseFormat = record(body.response_format);
  const jsonSchema = record(responseFormat?.json_schema);
  return {
    developerInstructions: developer.join("\n\n"),
    inputs,
    ...(jsonSchema?.schema ? { outputSchema: jsonSchema.schema } : {}),
  };
};

export class CodexBackend implements ModelBackend {
  readonly providerId = "codex" as const;
  readonly configuredModel: string;
  readonly appServer: CodexAppServer;
  private readonly maxTurnsPerMinute: number;
  private readonly maxTurnsPerDay: number;
  private readonly budgetStatePath?: string;
  private readonly now: () => number;
  private recentTurns: number[] = [];
  private dayKey = "";
  private dayTurns = 0;
  private budgetLoaded = false;
  private budgetQueue = Promise.resolve();

  constructor(options: CodexBackendOptions = {}) {
    this.appServer = options.appServer ?? new CodexAppServer(options);
    this.configuredModel = this.appServer.model;
    this.maxTurnsPerMinute = positiveTurnBudget(
      options.maxTurnsPerMinute ?? Number.parseInt(process.env.CODEX_MAX_TURNS_PER_MINUTE ?? "", 10),
      DEFAULT_MAX_TURNS_PER_MINUTE,
    );
    this.maxTurnsPerDay = positiveTurnBudget(
      options.maxTurnsPerDay ?? Number.parseInt(process.env.CODEX_MAX_TURNS_PER_DAY ?? "", 10),
      DEFAULT_MAX_TURNS_PER_DAY,
    );
    this.budgetStatePath = options.budgetStatePath === false
      ? undefined
      : resolve(options.budgetStatePath ?? (process.env.CODEX_BUDGET_STATE_PATH?.trim() || "data/codex-budget.json"));
    this.now = options.now ?? Date.now;
  }

  private async consumeBudget(): Promise<void> {
    const run = this.budgetQueue.then(async () => await this.consumeBudgetLocked());
    this.budgetQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  private async consumeBudgetLocked(): Promise<void> {
    const now = this.now();
    this.recentTurns = this.recentTurns.filter((timestamp) => now - timestamp < 60_000);
    const dayKey = new Date(now).toISOString().slice(0, 10);
    await this.loadBudgetState();
    if (dayKey !== this.dayKey) {
      this.dayKey = dayKey;
      this.dayTurns = 0;
    }
    if (this.recentTurns.length >= this.maxTurnsPerMinute) {
      throw new ModelBackendError("Codex subscription turn budget reached; wait a minute before trying again.", 429, "CODEX_RATE_LIMIT");
    }
    if (this.dayTurns >= this.maxTurnsPerDay) {
      throw new ModelBackendError("Codex subscription daily safety budget reached.", 429, "CODEX_DAILY_LIMIT");
    }
    const nextDayTurns = this.dayTurns + 1;
    await this.persistBudgetState(dayKey, nextDayTurns);
    this.recentTurns.push(now);
    this.dayTurns = nextDayTurns;
  }

  private async loadBudgetState(): Promise<void> {
    if (this.budgetLoaded) return;
    if (!this.budgetStatePath) {
      this.budgetLoaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.budgetStatePath, "utf8")) as unknown;
      const state = record(parsed);
      if (
        state?.version !== 1
        || typeof state.dayKey !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/u.test(state.dayKey)
        || !Number.isSafeInteger(state.dayTurns)
        || (state.dayTurns as number) < 0
      ) {
        throw new Error("invalid budget state");
      }
      this.dayKey = state.dayKey;
      this.dayTurns = state.dayTurns as number;
      this.budgetLoaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.budgetLoaded = true;
        return;
      }
      throw new ModelBackendError(
        "Codex budget state is unreadable; refusing subscription turns until it is repaired.",
        503,
        "CODEX_BUDGET_STATE",
      );
    }
  }

  private async persistBudgetState(dayKey: string, dayTurns: number): Promise<void> {
    if (!this.budgetStatePath) return;
    await mkdir(dirname(this.budgetStatePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.budgetStatePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, dayKey, dayTurns }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.budgetStatePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ModelBackendError(
        "Codex budget state could not be committed; the subscription turn was not started.",
        503,
        "CODEX_BUDGET_STATE",
      );
    }
  }

  async probe(): Promise<ModelBackendProbe> {
    const started = performance.now();
    try {
      const account = await this.appServer.account();
      if (!account.authenticated) {
        return { connected: false, id: this.configuredModel, label: "GPT-5.6 Luna", detail: "ChatGPT is not connected." };
      }
      if (account.method !== "chatgpt") {
        return { connected: false, id: this.configuredModel, label: "GPT-5.6 Luna", detail: "Codex must use ChatGPT subscription login, not API-key login." };
      }
      if (!(await this.appServer.hasModel())) {
        return { connected: false, id: this.configuredModel, label: "GPT-5.6 Luna", detail: `${this.configuredModel} requires a newer Codex CLI or is unavailable to this account.` };
      }
      return {
        connected: true,
        id: this.configuredModel,
        label: "GPT-5.6 Luna",
        latencyMs: Math.round(performance.now() - started),
        ...(account.accountLabel ? { detail: `ChatGPT connected as ${account.accountLabel}.` } : {}),
      };
    } catch (error) {
      return {
        connected: false,
        id: this.configuredModel,
        label: "GPT-5.6 Luna",
        detail: error instanceof Error ? error.message.slice(0, 300) : "Codex CLI is unavailable.",
      };
    }
  }

  async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    await this.consumeBudget();
    const text = await this.appServer.complete(extractCompletionInput(body), signal);
    return { choices: [{ message: { content: text } }] };
  }

  async startDeviceLogin(): Promise<CodexDeviceLogin> {
    return await this.appServer.startDeviceLogin();
  }

  async account() {
    return await this.appServer.account();
  }

  loginStatus() {
    return this.appServer.loginStatus();
  }

  async logout(): Promise<void> {
    await this.appServer.logout();
  }

  async close(): Promise<void> {
    await this.budgetQueue;
    await this.appServer.close();
  }
}
