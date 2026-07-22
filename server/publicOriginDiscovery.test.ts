import { describe, expect, it, vi } from "vitest";
import {
  createNgrokPublicOriginProvider,
  resolvePublicHandoffOrigin,
  type PublicOriginProvider,
} from "./publicOriginDiscovery.js";

const ngrokResponse = (tunnels: unknown[], status = 200): Response => new Response(
  JSON.stringify({ tunnels }),
  { status, headers: { "Content-Type": "application/json" } },
);

describe("external-agent public handoff origin discovery", () => {
  it("keeps trusted PUBLIC_ORIGIN authoritative without consulting providers", async () => {
    const provider: PublicOriginProvider = { id: "unused", discover: vi.fn() };

    await expect(resolvePublicHandoffOrigin("https://configured.example", [provider])).resolves.toEqual({
      origin: "https://configured.example",
      source: "configured",
    });
    expect(provider.discover).not.toHaveBeenCalled();
  });

  it("detects the HTTPS ngrok tunnel targeting this exact local server port", async () => {
    const fetchImpl = vi.fn(async () => ngrokResponse([
      {
        public_url: "https://friends.ngrok-free.app",
        proto: "https",
        config: { addr: "http://localhost:4000" },
      },
      {
        public_url: "https://different.ngrok-free.app",
        proto: "https",
        config: { addr: "http://localhost:4010" },
      },
    ]));
    const provider = createNgrokPublicOriginProvider({ localPort: 4000, fetchImpl });

    await expect(resolvePublicHandoffOrigin(undefined, [provider])).resolves.toEqual({
      origin: "https://friends.ngrok-free.app",
      source: "local-tunnel",
      providerId: "ngrok",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4040/api/tunnels",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it.each([
    [{ public_url: "http://plain.ngrok.test", proto: "http", config: { addr: "http://localhost:4000" } }],
    [{ public_url: "https://wrong.ngrok.test", proto: "https", config: { addr: "http://localhost:4999" } }],
    [{ public_url: "https://user:pass@evil.test", proto: "https", config: { addr: "http://localhost:4000" } }],
    [{ public_url: "https://evil.test/path", proto: "https", config: { addr: "http://localhost:4000" } }],
    [{ public_url: "https://evil.test", proto: "https", config: { addr: "http://192.168.1.4:4000" } }],
  ])("rejects an unusable or mismatched tunnel without authorizing it", async (tunnels) => {
    const provider = createNgrokPublicOriginProvider({
      localPort: 4000,
      fetchImpl: vi.fn(async () => ngrokResponse(tunnels)),
    });
    await expect(resolvePublicHandoffOrigin(undefined, [provider])).resolves.toEqual({ source: "same-origin" });
  });

  it("fails softly when the optional local tunnel service is absent or malformed", async () => {
    const unavailable = createNgrokPublicOriginProvider({
      localPort: 4000,
      fetchImpl: vi.fn(async () => { throw new Error("connection refused"); }),
    });
    const malformed = createNgrokPublicOriginProvider({
      localPort: 4000,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ tunnels: "nope" }))),
    });

    await expect(resolvePublicHandoffOrigin(undefined, [unavailable, malformed])).resolves.toEqual({
      source: "same-origin",
    });
  });

  it("rejects oversized inspection responses before parsing them", async () => {
    const provider = createNgrokPublicOriginProvider({
      localPort: 4000,
      fetchImpl: vi.fn(async () => new Response("x".repeat(64 * 1024 + 1))),
    });
    await expect(resolvePublicHandoffOrigin(undefined, [provider])).resolves.toEqual({ source: "same-origin" });
  });

  it.each([
    "https://127.0.0.1",
    "https://[::1]",
    "https://printer.local",
    "https://public.example/path",
    " https://public.example",
  ])("rejects a provider result that is not an exact external HTTPS origin: %s", async (candidate) => {
    const provider: PublicOriginProvider = { id: "unsafe", discover: async () => candidate };
    await expect(resolvePublicHandoffOrigin(undefined, [provider])).resolves.toEqual({ source: "same-origin" });
  });

  it("does not guess when several distinct tunnels target the same local app", async () => {
    const provider = createNgrokPublicOriginProvider({
      localPort: 4000,
      fetchImpl: vi.fn(async () => ngrokResponse([
        { public_url: "https://first.ngrok.test", proto: "https", config: { addr: "http://localhost:4000" } },
        { public_url: "https://second.ngrok.test", proto: "https", config: { addr: "http://127.0.0.1:4000" } },
      ])),
    });

    await expect(resolvePublicHandoffOrigin(undefined, [provider])).resolves.toEqual({ source: "same-origin" });
  });

  it("continues to a later provider and revalidates its result as exact HTTPS", async () => {
    const throwing: PublicOriginProvider = {
      id: "throwing",
      discover: async () => { throw new Error("optional provider failed"); },
    };
    const unsafe: PublicOriginProvider = { id: "unsafe", discover: async () => "http://public.example" };
    const safe: PublicOriginProvider = { id: "safe", discover: async () => "https://public.example/" };

    await expect(resolvePublicHandoffOrigin(undefined, [throwing, unsafe, safe])).resolves.toEqual({
      origin: "https://public.example",
      source: "local-tunnel",
      providerId: "safe",
    });
  });
});
