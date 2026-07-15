import { describe, expect, it, vi } from "vitest";
import type { PageReadRequest } from "./pageReader.js";
import type { ResearchPacket } from "./researchBroker.js";
import {
  resolveSearchEvidence,
  type EvidencePageReader,
} from "./evidenceResolver.js";

const now = Date.parse("2026-07-15T12:00:00.000Z");

const searchPacket = (urls: string[]): ResearchPacket => ({
  kind: "search",
  query: "Göteborg weather temperature trend",
  retrievedAt: "2026-07-15T11:59:00.000Z",
  results: urls.map((url, index) => ({
    id: `S${index + 1}`,
    title: `Search result ${index + 1}`,
    url,
    snippet: `Search snippet ${index + 1}`,
    publishedAt: `2026-07-${String(14 - index).padStart(2, "0")}T08:00:00.000Z`,
  })),
  search: {
    scope: "generic",
    requestedMode: "web",
    providerMode: "web",
  },
});

const pagePacket = (
  url: string,
  index: number,
  overrides: Partial<ResearchPacket["results"][number]> = {},
): ResearchPacket => ({
  kind: "page",
  query: "bounded goal",
  retrievedAt: `2026-07-15T11:59:0${index}.000Z`,
  results: [{
    id: "S1",
    title: `Page title ${index}`,
    url,
    snippet: `Concrete page evidence ${index}`,
    publishedAt: `2026-07-1${index}T09:00:00.000Z`,
    ...overrides,
  }],
});

const resolve = (
  packet: ResearchPacket,
  pageReader: EvidencePageReader,
  semanticGoal = "Will temperatures become colder soon?",
) => resolveSearchEvidence({
  packet,
  semanticGoal,
  requesterId: "guest-1",
  now,
  pageReader,
});

describe("search evidence resolver", () => {
  it("reads and merges the first two safe results into answerable page evidence", async () => {
    const calls: Array<{ request: PageReadRequest; requesterId: string }> = [];
    const reader: EvidencePageReader = {
      read: vi.fn(async (request, requesterId) => {
        calls.push({ request, requesterId });
        const index = calls.length;
        return pagePacket(request.url!.toString(), index);
      }),
    };

    const result = await resolve(
      searchPacket(["https://weather.example.com/one", "https://forecast.example.org/two"]),
      reader,
      `  هل ستنخفض الحرارة قريبًا؟${" x".repeat(200)}  `,
    );

    expect(result).toMatchObject({ readiness: "answerable", attemptedPages: 2, readPages: 2 });
    expect(result.packet.kind).toBe("page");
    expect(result.packet.query.length).toBeLessThanOrEqual(160);
    expect(result.packet.results).toEqual([
      {
        id: "S1",
        title: "Page title 1",
        url: "https://weather.example.com/one",
        snippet: "Concrete page evidence 1",
        publishedAt: "2026-07-11T09:00:00.000Z",
      },
      {
        id: "S2",
        title: "Page title 2",
        url: "https://forecast.example.org/two",
        snippet: "Concrete page evidence 2",
        publishedAt: "2026-07-12T09:00:00.000Z",
      },
    ]);
    expect(calls.map(({ request, requesterId }) => ({
      url: request.url?.toString(),
      requestedAt: request.requestedAt,
      retry: request.retry,
      source: request.source,
      initiator: request.initiator,
      requesterId,
    }))).toEqual([
      {
        url: "https://weather.example.com/one",
        requestedAt: "2026-07-15T12:00:00.000Z",
        retry: false,
        source: "message",
        initiator: "automatic",
        requesterId: "guest-1",
      },
      {
        url: "https://forecast.example.org/two",
        requestedAt: "2026-07-15T12:00:00.000Z",
        retry: false,
        source: "message",
        initiator: "automatic",
        requesterId: "guest-1",
      },
    ]);
  });

  it("keeps one successful read and renumbers it as S1", async () => {
    const reader: EvidencePageReader = {
      read: vi.fn(async (request) => request.url?.pathname === "/two"
        ? pagePacket(request.url.toString(), 2)
        : undefined),
    };

    const result = await resolve(
      searchPacket(["https://weather.example.com/one", "https://weather.example.com/two"]),
      reader,
    );

    expect(result).toMatchObject({ readiness: "answerable", attemptedPages: 2, readPages: 1 });
    expect(result.packet.results).toHaveLength(1);
    expect(result.packet.results[0]).toMatchObject({ id: "S1", url: "https://weather.example.com/two" });
  });

  it("expands a bounded same-site discovery result before treating it as answerable", async () => {
    const packet = searchPacket(["https://example.com/news/item-42"]);
    packet.search = {
      scope: "site",
      requestedMode: "news",
      providerMode: "web",
      site: {
        host: "example.com",
        quality: {
          classification: "fresh_results",
          resultCount: 1,
          rootResultCount: 0,
          deepLinkResultCount: 1,
          datedResultCount: 1,
          freshResultCount: 1,
        },
      },
    };
    const reader: EvidencePageReader = {
      read: vi.fn(async (request) => pagePacket(request.url!.toString(), 1)),
    };

    const result = await resolve(packet, reader, "latest published item");

    expect(result).toMatchObject({ readiness: "answerable", attemptedPages: 1, readPages: 1 });
    expect(result.packet).toMatchObject({
      kind: "page",
      query: "latest published item",
      results: [{ id: "S1", url: "https://example.com/news/item-42" }],
    });
  });

  it("returns bounded search evidence as retrieved when no page succeeds", async () => {
    const reader: EvidencePageReader = { read: vi.fn(async () => undefined) };
    const packet = searchPacket(["https://weather.example.com/one", "https://weather.example.com/two"]);
    packet.query = `${" forecast ".repeat(40)}\u0000ignored`;
    packet.results[0]!.title = `${"T".repeat(220)}\u0000ignored`;
    packet.results[0]!.snippet = "  concise\n  search\tresult  ";

    const result = await resolve(packet, reader);

    expect(result).toMatchObject({ readiness: "retrieved", attemptedPages: 2, readPages: 0 });
    expect(result.packet.kind).toBe("search");
    expect(result.packet.query.length).toBeLessThanOrEqual(240);
    expect(result.packet.query).not.toContain("\u0000");
    expect(result.packet.results[0]?.title.length).toBe(180);
    expect(result.packet.results[0]?.snippet).toBe("concise search result");
    expect(result.packet.search).toEqual(packet.search);
  });

  it("does not send malformed, non-HTTPS or structurally unsafe result URLs to PageReader", async () => {
    const reader: EvidencePageReader = { read: vi.fn(async () => undefined) };
    const packet = searchPacket([
      "not a URL",
      "http://weather.example.com/forecast",
      "https://user:secret@weather.example.com/private",
      "https://weather.example.com:8443/private",
      "https://127.0.0.1/private",
    ]);

    const result = await resolve(packet, reader);

    expect(reader.read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ readiness: "retrieved", attemptedPages: 0, readPages: 0 });
    expect(result.packet.results).toEqual([]);
  });

  it("rejects a returned S1 result whose URL does not exactly match the requested result", async () => {
    const reader: EvidencePageReader = {
      read: vi.fn(async () => pagePacket("https://other.example.net/injected", 1)),
    };

    const result = await resolve(searchPacket(["https://weather.example.com/one"]), reader);

    expect(result).toMatchObject({ readiness: "retrieved", attemptedPages: 1, readPages: 0 });
    expect(result.packet.kind).toBe("search");
  });

  it("never attempts more than two unique valid search results", async () => {
    const requested: string[] = [];
    const reader: EvidencePageReader = {
      read: vi.fn(async (request) => {
        requested.push(request.url!.toString());
        return undefined;
      }),
    };

    const result = await resolve(searchPacket([
      "https://weather.example.com/one",
      "https://weather.example.com/one",
      "https://weather.example.com/two",
      "https://weather.example.com/three",
      "https://weather.example.com/four",
    ]), reader);

    expect(result.attemptedPages).toBe(2);
    expect(requested).toEqual([
      "https://weather.example.com/one",
      "https://weather.example.com/two",
    ]);
  });

  it("contains thrown page reads and retains any independently successful source", async () => {
    const reader: EvidencePageReader = {
      read: vi.fn(async (request) => {
        if (request.url?.pathname === "/one") throw new Error("reader failed safely");
        return pagePacket(request.url!.toString(), 2);
      }),
    };

    const result = await resolve(
      searchPacket(["https://weather.example.com/one", "https://weather.example.com/two"]),
      reader,
    );

    expect(result).toMatchObject({ readiness: "answerable", attemptedPages: 2, readPages: 1 });
    expect(result.packet.results[0]?.url).toBe("https://weather.example.com/two");
  });

  it("treats an existing page packet as answerable without another read", async () => {
    const reader: EvidencePageReader = { read: vi.fn(async () => undefined) };
    const packet = pagePacket("https://weather.example.com/forecast", 1);

    const result = await resolve(packet, reader);

    expect(result).toMatchObject({ readiness: "answerable", attemptedPages: 0, readPages: 0 });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("does not call an empty or unsafe page packet answerable", async () => {
    const reader: EvidencePageReader = { read: vi.fn(async () => undefined) };
    const packet = pagePacket("https://127.0.0.1/private", 1, { snippet: "" });

    const result = await resolve(packet, reader);

    expect(result).toMatchObject({ readiness: "retrieved", attemptedPages: 0, readPages: 0 });
    expect(result.packet.results).toEqual([]);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
