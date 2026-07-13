import { describe, expect, it } from "vitest";
import {
  extractPublicHttpsUrls,
  fetchPublicHttps,
  isPublicAddress,
  resolvePublicAddress,
  responseCanBeRead,
  scanAsciiSequence,
  validatePublicHttpsUrl,
  type SafeHttpsFetchPolicy,
} from "./safeHttpsFetch.js";

const policy: SafeHttpsFetchPolicy = {
  timeoutMs: 1_000,
  maxRedirects: 2,
  maxBodyBytes: 1_024,
  acceptedMediaTypes: ["text/html", "text/plain"],
  acceptHeader: "text/html,text/plain",
  userAgent: "test",
};

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("safe HTTPS fetch", () => {
  it("accepts only ordinary public HTTPS URLs on port 443", () => {
    expect(validatePublicHttpsUrl("https://Example.com:443/story#part")?.toString()).toBe("https://example.com/story");
    for (const raw of [
      "http://example.com/story",
      "https://user:pass@example.com/story",
      "https://example.com:8443/story",
      "https://127.0.0.1/story",
      "https://[::1]/story",
      "https://service.internal/story",
      "https://foo.local/story",
      "https://lan/story",
      "https://example.com/%0aInjected",
    ]) {
      expect(validatePublicHttpsUrl(raw), raw).toBeUndefined();
    }
  });

  it("normalizes naked www links and trims only surrounding punctuation", () => {
    expect(extractPublicHttpsUrls("kolla WWW.Example.com/story). och https://example.org/a_(b)."))
      .toEqual([new URL("https://www.example.com/story"), new URL("https://example.org/a_(b)")]);
    expect(extractPublicHttpsUrls("notwww.example.com me@www.example.com foo.www.example.com nope")).toEqual([]);
    expect(extractPublicHttpsUrls(
      "data:text/plain,https://example.com/x javascript:https://example.org/y mailto:a@b.test?body=https://example.net/z blob:https://example.edu/id user@https://example.io/x",
    )).toEqual([]);
    expect(extractPublicHttpsUrls(
      "javascript:open(https://example.com/x) mailto:a@b.test?body=(https://example.org/y) blob:(https://example.net/id) data:text/plain,\"https://example.edu/z\"",
    )).toEqual([]);
  });

  it("rejects private, mapped and reserved network destinations", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.1.2", "::1", "::ffff:192.168.1.2", "2001:db8::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects a hostname when any DNS answer is not public", async () => {
    const address = await resolvePublicAddress("mixed.example", Date.now() + 500, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.4", family: 4 },
    ]);
    expect(address).toBeUndefined();
  });

  it("bounds DNS resolution by the shared deadline", async () => {
    const startedAt = Date.now();
    const address = await resolvePublicAddress(
      "slow.example",
      startedAt + 30,
      async () => await new Promise<Array<{ address: string; family: number }>>(() => undefined),
    );
    expect(address).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("matches media types exactly and rejects compressed or oversized bodies", () => {
    expect(responseCanBeRead(200, "text/html; charset=utf-8", "identity", 100, policy)).toBe(true);
    expect(responseCanBeRead(200, "application/not-text/html", "", 100, policy)).toBe(false);
    expect(responseCanBeRead(200, "text/html", "gzip", 100, policy)).toBe(false);
    expect(responseCanBeRead(200, "text/html", "", 1_025, policy)).toBe(false);
    expect(responseCanBeRead(404, "text/html", "", 100, policy)).toBe(false);
  });

  it("finds an early-stop delimiter incrementally across one-byte chunks", () => {
    const input = Buffer.from(`<html><head>${"x".repeat(32_768)}</head><body>private body</body></html>`);
    let tail: Buffer = Buffer.alloc(0);
    let processed = 0;
    let stopAt: number | undefined;
    const startedAt = Date.now();
    for (const byte of input) {
      const scan = scanAsciiSequence(tail, Buffer.from([byte]), "</head>", processed);
      tail = scan.tail;
      processed += 1;
      if (scan.stopAt !== undefined) {
        stopAt = scan.stopAt;
        break;
      }
    }
    expect(input.subarray(0, stopAt).toString()).toMatch(/<\/head>$/u);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("revalidates and resolves every relative or cross-host redirect", async () => {
    const requested: string[] = [];
    const resolved: string[] = [];
    const result = await fetchPublicHttps("https://first.example/start", policy, {
      lookupImpl: async (hostname) => {
        resolved.push(hostname);
        return publicLookup();
      },
      requestHop: async (url) => {
        requested.push(url.toString());
        if (url.hostname === "first.example") return { redirect: "https://second.example/final" };
        return { body: Buffer.from("ok"), mediaType: "text/plain", contentType: "text/plain" };
      },
    });
    expect(resolved).toEqual(["first.example", "second.example"]);
    expect(requested).toEqual(["https://first.example/start", "https://second.example/final"]);
    expect(result?.finalUrl.toString()).toBe("https://second.example/final");
  });

  it("rejects redirect downgrades, credentials and loops before another unsafe request", async () => {
    for (const redirect of ["http://example.com/nope", "https://user:pass@example.com/nope", "https://127.0.0.1/nope"]) {
      let requests = 0;
      const result = await fetchPublicHttps("https://first.example/start", policy, {
        lookupImpl: publicLookup,
        requestHop: async () => {
          requests += 1;
          return { redirect };
        },
      });
      expect(result, redirect).toBeUndefined();
      expect(requests, redirect).toBe(1);
    }

    let loopRequests = 0;
    const loop = await fetchPublicHttps("https://first.example/start", policy, {
      lookupImpl: publicLookup,
      requestHop: async () => {
        loopRequests += 1;
        return { redirect: "/start" };
      },
    });
    expect(loop).toBeUndefined();
    expect(loopRequests).toBe(1);
  });
});
