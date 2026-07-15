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

  it("keeps Unicode sentence punctuation and wrappers out of URL hosts", () => {
    const cases = [
      ["شاهد https://example.com،", "https://example.com/"],
      ["شاهد https://example.com؛", "https://example.com/"],
      ["شاهد https://example.com؟", "https://example.com/"],
      ["見てhttps://example.com。", "https://example.com/"],
      ["見て「https://example.com」", "https://example.com/"],
      ["見て【https://example.com】", "https://example.com/"],
      ["見て（https://example.com）", "https://example.com/"],
      ["見てhttps://example.com！", "https://example.com/"],
      ["見てhttps://example.com・", "https://example.com/"],
      ["見てhttps://example.com—", "https://example.com/"],
      ["شاهد https://example.com٪", "https://example.com/"],
      ["شاهد https://example.com؍", "https://example.com/"],
    ] as const;
    for (const [content, expected] of cases) {
      expect(extractPublicHttpsUrls(content)[0]?.toString(), content).toBe(expected);
    }
  });

  it("accepts no-space-script prefixes and IDNs without accepting embedded ASCII tokens", () => {
    expect(extractPublicHttpsUrls("見てhttps://例え.テスト。")?.[0]?.toString()).toBe("https://xn--r8jz45g.xn--zckzah/");
    expect(extractPublicHttpsUrls("انظرhttps://مثال.إختبار؟")?.[0]?.hostname).toBe("xn--mgbh0fb.xn--kgbechtv");
    expect(extractPublicHttpsUrls("見てhttps://example.comニュース")?.[0]?.toString()).toBe("https://example.com/");
    expect(extractPublicHttpsUrls("https://example.com、次")?.[0]?.toString()).toBe("https://example.com/");
    expect(extractPublicHttpsUrls("看https://例子.中国新闻")?.[0]?.toString()).toBe("https://xn--fsqu00a.xn--fiqs8s/");
    expect(extractPublicHttpsUrls("看https://例子.中国/新闻/今天")?.[0]?.pathname).toBe("/%E6%96%B0%E9%97%BB/%E4%BB%8A%E5%A4%A9");
    expect(extractPublicHttpsUrls("abchttps://example.com foohttps://example.org xwww.example.net")).toEqual([]);
  });

  it("rejects private, mapped and reserved network destinations", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.2",
      "224.0.0.1",
      "::1",
      "::ffff:192.168.1.2",
      "2001:db8::1",
      "fc00::1",
      "fe80::1",
    ]) {
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

  it("matches media types exactly and permits oversized HTML only behind a bounded head stop", () => {
    expect(responseCanBeRead(200, "text/html; charset=utf-8", "identity", 100, policy)).toBe(true);
    expect(responseCanBeRead(200, "application/not-text/html", "", 100, policy)).toBe(false);
    expect(responseCanBeRead(200, "text/html", "gzip", 100, policy)).toBe(false);
    expect(responseCanBeRead(200, "text/html", "Provider.UTF8", 100, {
      ...policy,
      identityContentEncodingAliases: ["provider.utf8"],
    })).toBe(true);
    expect(responseCanBeRead(200, "text/html", "gzip", 100, {
      ...policy,
      identityContentEncodingAliases: ["gzip"],
    })).toBe(false);
    expect(responseCanBeRead(200, "text/html", "", 1_025, policy)).toBe(false);
    expect(responseCanBeRead(200, "text/html", "", 4_000_000, {
      ...policy,
      oversizedHtmlHeadFallback: true,
    })).toBe(true);
    expect(responseCanBeRead(200, "text/plain", "", 4_000_000, {
      ...policy,
      oversizedHtmlHeadFallback: true,
    })).toBe(false);
    expect(responseCanBeRead(200, "text/html", "", 4_000_000, {
      ...policy,
      stopAfterAsciiSequence: "</head>",
    })).toBe(true);
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

  it("optionally confines redirects to the originally requested origin", async () => {
    const crossOriginRequests: string[] = [];
    const crossOriginResult = await fetchPublicHttps(
      "https://first.example/start",
      { ...policy, sameOriginRedirectsOnly: true },
      {
        lookupImpl: publicLookup,
        requestHop: async (url) => {
          crossOriginRequests.push(url.toString());
          return { redirect: "https://second.example/final" };
        },
      },
    );
    expect(crossOriginResult).toBeUndefined();
    expect(crossOriginRequests).toEqual(["https://first.example/start"]);

    const sameOriginRequests: string[] = [];
    const sameOriginResult = await fetchPublicHttps(
      "https://first.example/start",
      { ...policy, sameOriginRedirectsOnly: true },
      {
        lookupImpl: publicLookup,
        requestHop: async (url) => {
          sameOriginRequests.push(url.toString());
          return url.pathname === "/start"
            ? { redirect: "/final" }
            : { body: Buffer.from("ok"), mediaType: "text/plain", contentType: "text/plain" };
        },
      },
    );
    expect(sameOriginRequests).toEqual(["https://first.example/start", "https://first.example/final"]);
    expect(sameOriginResult?.finalUrl.toString()).toBe("https://first.example/final");
  });

  it("can narrowly permit a canonical www redirect without allowing other subdomains", async () => {
    const canonicalRequests: string[] = [];
    const canonical = await fetchPublicHttps(
      "https://example.com/start",
      { ...policy, sameOriginRedirectsOnly: true, allowCanonicalWwwRedirect: true },
      {
        lookupImpl: publicLookup,
        requestHop: async (url) => {
          canonicalRequests.push(url.toString());
          return url.hostname === "example.com"
            ? { redirect: "https://www.example.com/final" }
            : { body: Buffer.from("ok"), mediaType: "text/plain", contentType: "text/plain" };
        },
      },
    );
    expect(canonical?.finalUrl.toString()).toBe("https://www.example.com/final");
    expect(canonicalRequests).toEqual(["https://example.com/start", "https://www.example.com/final"]);

    const arbitraryRequests: string[] = [];
    const arbitrary = await fetchPublicHttps(
      "https://example.com/start",
      { ...policy, sameOriginRedirectsOnly: true, allowCanonicalWwwRedirect: true },
      {
        lookupImpl: publicLookup,
        requestHop: async (url) => {
          arbitraryRequests.push(url.toString());
          return { redirect: "https://news.example.com/final" };
        },
      },
    );
    expect(arbitrary).toBeUndefined();
    expect(arbitraryRequests).toEqual(["https://example.com/start"]);
  });

  it("re-resolves the same hostname after a redirect and blocks a DNS rebinding answer", async () => {
    let lookups = 0;
    let requests = 0;
    const result = await fetchPublicHttps("https://first.example/start", policy, {
      lookupImpl: async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      requestHop: async () => {
        requests += 1;
        return { redirect: "/after-rebind" };
      },
    });
    expect(result).toBeUndefined();
    expect(lookups).toBe(2);
    expect(requests).toBe(1);
  });

  it("blocks a redirected host when any of its fresh DNS answers is private", async () => {
    const resolved: string[] = [];
    const requested: string[] = [];
    const result = await fetchPublicHttps("https://public.example/start", policy, {
      lookupImpl: async (hostname) => {
        resolved.push(hostname);
        return hostname === "public.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [
              { address: "93.184.216.35", family: 4 },
              { address: "10.0.0.7", family: 4 },
            ];
      },
      requestHop: async (url) => {
        requested.push(url.toString());
        return { redirect: "https://mixed.example/private" };
      },
    });
    expect(result).toBeUndefined();
    expect(resolved).toEqual(["public.example", "mixed.example"]);
    expect(requested).toEqual(["https://public.example/start"]);
  });

  it("honours the redirect limit without issuing an extra hop", async () => {
    const requested: string[] = [];
    const oneRedirectPolicy = { ...policy, maxRedirects: 1 };
    const result = await fetchPublicHttps("https://first.example/start", oneRedirectPolicy, {
      lookupImpl: publicLookup,
      requestHop: async (url) => {
        requested.push(url.toString());
        return { redirect: `/hop-${requested.length}` };
      },
    });
    expect(result).toBeUndefined();
    expect(requested).toEqual(["https://first.example/start", "https://first.example/hop-1"]);
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
