import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexBackend } from "./codexBackend.js";
import type { CodexAppServer } from "./codexAppServer.js";

const validBody = (text = "hello") => ({
  messages: [
    { role: "system", content: "Trusted contract" },
    { role: "user", content: text },
  ],
});

const fakeAppServer = (overrides: Record<string, unknown> = {}) => ({
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  account: vi.fn(async () => ({ authenticated: true, method: "chatgpt", accountLabel: "owner@example.test" })),
  hasModel: vi.fn(async () => true),
  complete: vi.fn(async () => "model output"),
  startDeviceLogin: vi.fn(async () => ({ status: "pending", loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD" })),
  loginStatus: vi.fn(() => ({ pending: false })),
  logout: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  ...overrides,
}) as unknown as CodexAppServer;

describe("CodexBackend OpenAI-compatible boundary", () => {
  it("separates trusted system instructions, bounded multimodal input and strict output schema", async () => {
    const appServer = fakeAppServer();
    const backend = new CodexBackend({ appServer, budgetStatePath: false });
    const controller = new AbortController();
    const schema = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const image = "data:image/png;base64,aGVsbG8=";

    await expect(backend.complete({
      messages: [
        { role: "system", content: "Instruction one" },
        { role: "system", content: "Instruction two" },
        { role: "user", content: "Hello" },
        { role: "user", content: [
          { type: "text", text: "What is shown?" },
          { type: "image_url", image_url: { url: image } },
        ] },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
    }, controller.signal)).resolves.toEqual({ choices: [{ message: { content: "model output" } }] });

    expect(appServer.complete).toHaveBeenCalledWith({
      developerInstructions: "Instruction one\n\nInstruction two",
      inputs: [
        { type: "text", text: "Hello", text_elements: [] },
        { type: "text", text: "What is shown?", text_elements: [] },
        { type: "image", url: image, detail: "auto" },
      ],
      outputSchema: schema,
    }, controller.signal);
  });

  it("rejects missing trusted instructions, missing user data and external or malformed images", async () => {
    const backend = new CodexBackend({ appServer: fakeAppServer(), budgetStatePath: false });
    const signal = new AbortController().signal;
    await expect(backend.complete({ messages: [{ role: "user", content: "hello" }] }, signal))
      .rejects.toMatchObject({ code: "CODEX_INPUT_INVALID", status: 400 });
    await expect(backend.complete({ messages: [{ role: "system", content: "contract" }] }, signal))
      .rejects.toMatchObject({ code: "CODEX_INPUT_INVALID", status: 400 });
    await expect(backend.complete({ messages: [
      { role: "system", content: "contract" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] },
    ] }, signal)).rejects.toMatchObject({ code: "CODEX_IMAGE_REJECTED", status: 400 });
    await expect(backend.complete({ messages: [
      { role: "system", content: "contract" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } }] },
    ] }, signal)).rejects.toMatchObject({ code: "CODEX_IMAGE_REJECTED", status: 400 });
  });

  it("enforces rolling minute and UTC-day subscription safety budgets", async () => {
    let now = Date.UTC(2026, 6, 14, 10, 0, 0);
    const appServer = fakeAppServer();
    const backend = new CodexBackend({ appServer, maxTurnsPerMinute: 2, maxTurnsPerDay: 3, budgetStatePath: false, now: () => now });
    const signal = new AbortController().signal;

    await backend.complete(validBody("one"), signal);
    await backend.complete(validBody("two"), signal);
    await expect(backend.complete(validBody("minute overflow"), signal))
      .rejects.toMatchObject({ code: "CODEX_RATE_LIMIT", status: 429 });

    now += 60_000;
    await backend.complete(validBody("three"), signal);
    await expect(backend.complete(validBody("daily overflow"), signal))
      .rejects.toMatchObject({ code: "CODEX_DAILY_LIMIT", status: 429 });
    expect(appServer.complete).toHaveBeenCalledTimes(3);

    now = Date.UTC(2026, 6, 15, 0, 0, 0);
    await expect(backend.complete(validBody("new UTC day"), signal)).resolves.toBeDefined();
  });

  it("persists the UTC-day safety budget across backend restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-codex-budget-test-"));
    const budgetStatePath = join(directory, "budget.json");
    const now = Date.UTC(2026, 6, 14, 10, 0, 0);
    const signal = new AbortController().signal;
    const first = new CodexBackend({
      appServer: fakeAppServer(),
      maxTurnsPerMinute: 24,
      maxTurnsPerDay: 2,
      budgetStatePath,
      now: () => now,
    });
    await first.complete(validBody("first process"), signal);
    await first.close();

    const second = new CodexBackend({
      appServer: fakeAppServer(),
      maxTurnsPerMinute: 24,
      maxTurnsPerDay: 2,
      budgetStatePath,
      now: () => now,
    });
    await second.complete(validBody("second process"), signal);
    await expect(second.complete(validBody("restart bypass"), signal))
      .rejects.toMatchObject({ code: "CODEX_DAILY_LIMIT", status: 429 });
    await second.close();
  });

  it("falls back to finite defaults for invalid budget values and fails closed on corrupt persisted state", async () => {
    const appServer = fakeAppServer();
    const backend = new CodexBackend({
      appServer,
      maxTurnsPerMinute: Number.NaN,
      maxTurnsPerDay: Number.NaN,
      budgetStatePath: false,
    });
    const signal = new AbortController().signal;
    for (let index = 0; index < 24; index += 1) await backend.complete(validBody(String(index)), signal);
    await expect(backend.complete(validBody("invalid config bypass"), signal))
      .rejects.toMatchObject({ code: "CODEX_RATE_LIMIT", status: 429 });

    const directory = await mkdtemp(join(tmpdir(), "third-place-codex-corrupt-budget-test-"));
    const budgetStatePath = join(directory, "budget.json");
    await writeFile(budgetStatePath, "{not-json", "utf8");
    const corrupt = new CodexBackend({ appServer: fakeAppServer(), budgetStatePath });
    await expect(corrupt.complete(validBody("must not start"), signal))
      .rejects.toMatchObject({ code: "CODEX_BUDGET_STATE", status: 503 });
  });

  it("probes subscription auth and exact model availability without throwing admin-facing errors", async () => {
    const appServer = fakeAppServer();
    const backend = new CodexBackend({ appServer, budgetStatePath: false });
    await expect(backend.probe()).resolves.toMatchObject({
      connected: true,
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      detail: "ChatGPT connected as owner@example.test.",
    });

    vi.mocked(appServer.account).mockResolvedValueOnce({ authenticated: true, method: "apiKey" });
    await expect(backend.probe()).resolves.toMatchObject({ connected: false, detail: expect.stringContaining("subscription login") });
    vi.mocked(appServer.account).mockResolvedValueOnce({ authenticated: true, method: "chatgpt" });
    vi.mocked(appServer.hasModel).mockResolvedValueOnce(false);
    await expect(backend.probe()).resolves.toMatchObject({ connected: false, detail: expect.stringContaining("unavailable") });
    vi.mocked(appServer.account).mockRejectedValueOnce(new Error("CLI missing"));
    await expect(backend.probe()).resolves.toMatchObject({ connected: false, detail: "CLI missing" });
  });

  it("exposes only the narrow device-login/account/logout lifecycle", async () => {
    const appServer = fakeAppServer();
    const backend = new CodexBackend({ appServer, budgetStatePath: false });
    await expect(backend.startDeviceLogin()).resolves.toMatchObject({ loginId: "login-1" });
    await expect(backend.account()).resolves.toMatchObject({ method: "chatgpt" });
    expect(backend.loginStatus()).toEqual({ pending: false });
    await backend.logout();
    await backend.close();
    expect(appServer.logout).toHaveBeenCalledOnce();
    expect(appServer.close).toHaveBeenCalledOnce();
  });
});
