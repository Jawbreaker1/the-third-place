import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteImage } from "./imageStore.js";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("node:https", () => ({ request: requestMock }));

const publicDns = { lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }] };

describe("remote image wall-clock deadline", () => {
  let request: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  let respond: (response: IncomingMessage) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    request = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn((error?: Error) => { request.emit("error", error ?? new Error("closed")); }),
    });
    requestMock.mockReset();
    requestMock.mockImplementation((_options: RequestOptions, callback: typeof respond) => {
      respond = callback;
      return request;
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("terminates when TLS or response headers never arrive", async () => {
    const pending = fetchRemoteImage("https://example.com/image.png", publicDns);
    const rejected = expect(pending).rejects.toMatchObject({ status: 422 });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(request.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a slowly arriving body extend the absolute deadline", async () => {
    const pending = fetchRemoteImage("https://example.com/image.png", publicDns);
    const rejected = expect(pending).rejects.toMatchObject({ status: 422 });
    await vi.advanceTimersByTimeAsync(0);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "image/png" },
      destroy: vi.fn(),
    });
    respond(response as unknown as IncomingMessage);
    for (let second = 0; second < 7; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      response.emit("data", Buffer.from([0]));
    }
    expect(request.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one total time budget across redirects", async () => {
    const pending = fetchRemoteImage("https://example.com/image.png", publicDns);
    const rejected = expect(pending).rejects.toMatchObject({ status: 422 });
    await vi.advanceTimersByTimeAsync(6_000);
    const redirect = Object.assign(new EventEmitter(), {
      statusCode: 302,
      headers: { location: "https://images.example.com/final.png" },
      destroy: vi.fn(),
    });
    respond(redirect as unknown as IncomingMessage);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up deadline and body timers after a completed image", async () => {
    const pending = fetchRemoteImage("https://example.com/image.png", publicDns);
    await vi.advanceTimersByTimeAsync(0);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "image/png" },
      destroy: vi.fn(),
    });
    respond(response as unknown as IncomingMessage);
    response.emit("data", Buffer.from([1, 2, 3]));
    response.emit("end");
    expect(await pending).toEqual({ body: Buffer.from([1, 2, 3]), contentType: "image/png" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.destroy).not.toHaveBeenCalled();
  });
});
