import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "./codexAppServer.js";
import { ModelBackendError } from "./modelBackend.js";

type RpcRequest = { id?: number; method: string; params?: Record<string, unknown> };
type RpcResolver = (request: RpcRequest, child: FakeCodexChild) => unknown | Promise<unknown>;

const NO_RESPONSE = Symbol("NO_RESPONSE");
let testDirectorySequence = 0;

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcRequest[] = [];
  killed = false;
  private inputBuffer = "";

  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return true;
  });

  constructor(private readonly resolveRequest: RpcResolver) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.inputBuffer += chunk.toString();
      while (true) {
        const newline = this.inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as RpcRequest;
        this.requests.push(request);
        if (typeof request.id !== "number") continue;
        void Promise.resolve(this.resolveRequest(request, this)).then(
          (result) => {
            if (result !== NO_RESPONSE) this.respond(request.id!, result);
          },
          (error: unknown) => this.respondError(request.id!, error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }

  respond(id: number, result: unknown): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  respondError(id: number, message: string): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`));
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  serverRequest(id: number, method: string, params: Record<string, unknown> = {}): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }
}

const baseResolver: RpcResolver = (request) => {
  switch (request.method) {
    case "initialize": return { codexHome: "/isolated/codex-home" };
    case "account/read": return { account: { type: "chatgpt", email: "owner@example.test", planType: "plus" } };
    case "model/list": return { data: [{ model: "gpt-5.6-luna" }] };
    case "thread/start": return { thread: { id: "thread-1" } };
    case "turn/start": return { turn: { id: "turn-1" } };
    case "turn/interrupt": return {};
    case "account/logout": return {};
    default: return {};
  }
};

const serverHarness = (resolver: RpcResolver = baseResolver) => {
  const child = new FakeCodexChild(resolver);
  const spawnImpl = vi.fn(() => child as never);
  const root = join(tmpdir(), `third-place-codex-test-${process.pid}-${testDirectorySequence++}`);
  const server = new CodexAppServer({
    binaryPath: "/trusted/codex",
    codexHome: join(root, "home"),
    runtimeRoot: join(root, "runtime"),
    spawnImpl: spawnImpl as never,
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 2_000,
  });
  return { child, server, spawnImpl };
};

const waitForRequest = async (child: FakeCodexChild, method: string): Promise<RpcRequest> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const request = child.requests.find((candidate) => candidate.method === method);
    if (request) return request;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}`);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodexAppServer isolated transport", () => {
  it("starts device-code login only at a trusted OpenAI destination and tracks completion", async () => {
    const { child, server } = serverHarness((request) => {
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "ABCD-EFGH",
        };
      }
      return baseResolver(request, child);
    });

    await expect(server.startDeviceLogin()).resolves.toMatchObject({
      status: "pending",
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
    });
    expect(server.loginStatus()).toEqual({ pending: true });
    await expect(server.startDeviceLogin()).rejects.toMatchObject({ code: "CODEX_LOGIN_PENDING", status: 409 });

    child.notify("account/login/completed", { loginId: "login-1", success: true });
    expect(server.loginStatus()).toEqual({ pending: false });
    await server.close();
  });

  it("rejects a device-login URL outside OpenAI and ChatGPT domains", async () => {
    const { child, server } = serverHarness((request) => request.method === "account/login/start"
      ? {
          type: "chatgptDeviceCode",
          loginId: "login-evil",
          verificationUrl: "https://openai.com.evil.test/device",
          userCode: "STEAL-ME",
        }
      : baseResolver(request, child));

    await expect(server.startDeviceLogin()).rejects.toMatchObject({ code: "CODEX_LOGIN_FAILED", status: 502 });
    expect(server.loginStatus()).toEqual({ pending: false });
    await server.close();
  });

  it("reports subscription account and exact configured model availability", async () => {
    const { server } = serverHarness();
    await expect(server.account()).resolves.toEqual({
      authenticated: true,
      method: "chatgpt",
      accountLabel: "owner@example.test",
      planType: "plus",
    });
    await expect(server.hasModel()).resolves.toBe(true);
    await server.close();
  });

  it("spawns a strict tool-disabled app-server without forwarding ambient secrets", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousAdminPassword = process.env.ADMIN_PASSWORD;
    process.env.OPENAI_API_KEY = "must-not-reach-child";
    process.env.ADMIN_PASSWORD = "also-secret";
    try {
      const { server, spawnImpl } = serverHarness();
      await server.account();
      expect(spawnImpl).toHaveBeenCalledOnce();
      const [binary, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { shell: boolean; cwd: string; env: NodeJS.ProcessEnv }];
      expect(binary).toBe("/trusted/codex");
      expect(args).toEqual(expect.arrayContaining([
        "app-server", "stdio://", "--strict-config", "shell_tool", "unified_exec",
        "multi_agent", "plugins", "apps", "approval_policy=\"never\"", "sandbox_mode=\"read-only\"",
      ]));
      expect(options).toMatchObject({ shell: false, cwd: server.runtimeRoot });
      expect(options.env).toMatchObject({ HOME: server.codexHome, CODEX_HOME: server.codexHome, TMPDIR: server.runtimeRoot, NO_COLOR: "1" });
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(options.env.ADMIN_PASSWORD).toBeUndefined();
      expect(Object.keys(options.env)).toEqual(expect.arrayContaining(["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "NO_COLOR"]));
      await server.close();
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
      else process.env.ADMIN_PASSWORD = previousAdminPassword;
    }
  });

  it("sends the exact output schema under read-only, networkless turn policy and accepts only the final answer", async () => {
    const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
    let child!: FakeCodexChild;
    const harness = serverHarness((request, activeChild) => {
      child = activeChild;
      if (request.method === "turn/start") {
        queueMicrotask(() => queueMicrotask(() => activeChild.notify("turn/completed", {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [
              { type: "agentMessage", phase: "commentary", text: "hidden progress" },
              { type: "agentMessage", phase: "final_answer", text: "  {\"answer\":\"hej\"}  " },
            ],
          },
        })));
      }
      return baseResolver(request, activeChild);
    });
    child = harness.child;

    await expect(harness.server.complete({
      developerInstructions: "Return the required JSON object.",
      inputs: [{ type: "text", text: "Say hello", text_elements: [] }],
      outputSchema: schema,
    }, new AbortController().signal)).resolves.toBe('{"answer":"hej"}');

    const threadStart = child.requests.find((request) => request.method === "thread/start")!;
    expect(threadStart.params).toMatchObject({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      dynamicTools: [],
      selectedCapabilityRoots: [],
    });
    expect(String(threadStart.params?.baseInstructions)).toContain("Do not use tools");
    const turnStart = child.requests.find((request) => request.method === "turn/start")!;
    expect(turnStart.params).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "low",
      outputSchema: schema,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      environments: [],
    });
    await harness.server.close();
  });

  it("fails closed as soon as Codex starts any disabled tool item", async () => {
    const { child, server } = serverHarness();
    const completion = server.complete({
      developerInstructions: "Return text only.",
      inputs: [{ type: "text", text: "Hello", text_elements: [] }],
    }, new AbortController().signal);
    await waitForRequest(child, "turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));

    child.notify("item/started", {
      threadId: "thread-1",
      item: { type: "imageView", path: "/private/image.png" },
    });
    await expect(completion).rejects.toMatchObject({ code: "CODEX_TOOL_BLOCKED", status: 502 });
    await waitForRequest(child, "turn/interrupt");
    await server.close();
  });

  it("does not start a thread after an abort that arrives during account lookup", async () => {
    let releaseAccount!: (value: unknown) => void;
    const accountResult = new Promise<unknown>((resolve) => { releaseAccount = resolve; });
    const { child, server } = serverHarness((request, activeChild) => {
      if (request.method === "account/read") return accountResult;
      return baseResolver(request, activeChild);
    });
    const controller = new AbortController();
    const completion = server.complete({
      developerInstructions: "Return text only.",
      inputs: [{ type: "text", text: "Hello", text_elements: [] }],
    }, controller.signal);
    await waitForRequest(child, "account/read");

    const reason = new Error("provider switched during account lookup");
    controller.abort(reason);
    releaseAccount({ account: { type: "chatgpt" } });

    await expect(completion).rejects.toBe(reason);
    expect(child.requests.some((request) => request.method === "thread/start")).toBe(false);
    expect(child.requests.some((request) => request.method === "turn/start")).toBe(false);
    await server.close();
  });

  it("denies unexpected server capability requests and fails every active turn", async () => {
    const { child, server } = serverHarness();
    const completion = server.complete({
      developerInstructions: "Return text only.",
      inputs: [{ type: "text", text: "Hello", text_elements: [] }],
    }, new AbortController().signal);
    await waitForRequest(child, "turn/start");

    child.serverRequest(900, "item/commandExecution/requestApproval", { command: "id" });
    await expect(completion).rejects.toMatchObject({ code: "CODEX_TOOL_BLOCKED", status: 502 });
    expect(child.requests).toContainEqual({
      id: 900,
      method: undefined,
      params: undefined,
      error: { code: -32601, message: "Client capabilities are disabled." },
    });
    await server.close();
  });

  it("interrupts an active Codex turn when the caller aborts", async () => {
    const { child, server } = serverHarness();
    const controller = new AbortController();
    const completion = server.complete({
      developerInstructions: "Return text only.",
      inputs: [{ type: "text", text: "Hello", text_elements: [] }],
    }, controller.signal);
    await waitForRequest(child, "turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reason = new Error("provider switched");
    controller.abort(reason);
    await expect(completion).rejects.toBe(reason);
    const interrupt = await waitForRequest(child, "turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await server.close();
  });

  it("ignores late stdout and exit events from a replaced child process", async () => {
    const first = new FakeCodexChild(baseResolver);
    const second = new FakeCodexChild(baseResolver);
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const root = join(tmpdir(), `third-place-codex-restart-test-${process.pid}-${testDirectorySequence++}`);
    const server = new CodexAppServer({
      binaryPath: "/trusted/codex",
      codexHome: join(root, "home"),
      runtimeRoot: join(root, "runtime"),
      spawnImpl: spawnImpl as never,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 2_000,
    });

    await expect(server.account()).resolves.toMatchObject({ authenticated: true });
    first.stdout.write("{malformed\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(server.account()).resolves.toMatchObject({ authenticated: true });
    expect(spawnImpl).toHaveBeenCalledTimes(2);

    first.stdout.write("{still-malformed\n");
    first.emit("exit", 1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(server.account()).resolves.toMatchObject({ authenticated: true });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await server.close();
  });
});
