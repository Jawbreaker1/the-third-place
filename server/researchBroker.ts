import { isIP } from "node:net";
import { stripDangerousTextControls, unicodeCaselessKey } from "../shared/unicodeSafety.js";

export interface ResearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface ResearchPacket {
  kind?: "search" | "page";
  query: string;
  retrievedAt: string;
  results: ResearchResult[];
}

interface CachedResearch {
  expiresAt: number;
  packet: ResearchPacket;
}

export type SearchMode = "news" | "web";

export interface ResearchRequest {
  query: string;
  mode: SearchMode;
  requesterId?: string;
}

export interface SiteResearchRequest extends ResearchRequest {
  url: URL;
}

// This is a transport boundary, not an intent parser. The semantic router owns
// the wording and mode; the broker only keeps the provider request bounded and
// free of control characters.
const boundedQuery = (raw: string): string | undefined => {
  const query = stripDangerousTextControls(raw.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  return /[\p{L}\p{N}]/u.test(query) ? query : undefined;
};

const decodeXml = (value: string): string =>
  value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

const stripMarkup = (value: string): string =>
  decodeXml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const xmlField = (item: string, field: string): string => {
  const match = item.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, "i"));
  return match?.[1] ? stripMarkup(match[1]) : "";
};

// Result links are rendered by the browser but never fetched by this server.
// Be conservative anyway so this helper cannot accidentally become an SSRF primitive later.
const safeSourceUrl = (raw: string): string | undefined => {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
      return undefined;
    }
    if (
      !host ||
      isIP(host) !== 0 ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return undefined;
    }
    parsed.hostname = host;
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const sourceUrl = (raw: string): string | undefined => {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLocaleLowerCase().replace(/\.$/, "");
    if ((host === "bing.com" || host.endsWith(".bing.com")) && parsed.pathname === "/news/apiclick.aspx") {
      const target = parsed.searchParams.get("url");
      return target ? safeSourceUrl(target) : undefined;
    }
  } catch {
    return undefined;
  }
  return safeSourceUrl(raw);
};

const readLimitedText = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Research provider response exceeded the byte limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

export class ResearchBroker {
  private readonly cache = new Map<string, CachedResearch>();
  private readonly globalRequestTimestamps: number[] = [];
  private readonly requesterTimestamps = new Map<string, number[]>();
  private readonly inFlight = new Map<string, Promise<ResearchPacket | undefined>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async research(request: ResearchRequest): Promise<ResearchPacket | undefined> {
    if (process.env.RESEARCH_ENABLED !== "true") return undefined;
    const query = boundedQuery(request.query);
    if (!query) return undefined;
    return this.researchQuery(query, request.mode, request.requesterId ?? "anonymous");
  }

  async researchSite(request: SiteResearchRequest): Promise<ResearchPacket | undefined> {
    if (process.env.RESEARCH_ENABLED !== "true") return undefined;
    const { url } = request;
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return undefined;
    const topic = boundedQuery(request.query);
    const host = url.hostname.toLocaleLowerCase().replace(/\.$/u, "");
    const query = `site:${host}${topic ? ` ${topic}` : ""}`.slice(0, 160);
    const packet = await this.researchQuery(query, request.mode, request.requesterId ?? "anonymous");
    if (!packet) return undefined;
    const results = packet.results
      .filter((result) => {
        try {
          return new URL(result.url).hostname.toLocaleLowerCase() === host;
        } catch {
          return false;
        }
      })
      .map((result, index) => ({ ...result, id: `S${index + 1}` }));
    return results.length > 0 ? { ...packet, results } : undefined;
  }

  private async researchQuery(query: string, mode: SearchMode, requesterId: string): Promise<ResearchPacket | undefined> {
    const key = `${mode}:${unicodeCaselessKey(query)}`;
    this.pruneCache();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.packet;
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (!this.reserveRequest(requesterId)) return undefined;

    const request = this.search(query, mode).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    const packet = await request;
    if (packet) {
      this.cache.set(key, { packet, expiresAt: Date.now() + 10 * 60_000 });
      this.pruneCache();
    }
    return packet;
  }

  private reserveRequest(requesterId: string): boolean {
    const now = Date.now();
    while (this.globalRequestTimestamps[0] && now - this.globalRequestTimestamps[0] > 60_000) {
      this.globalRequestTimestamps.shift();
    }
    const requester = this.requesterTimestamps.get(requesterId) ?? [];
    while (requester[0] && now - requester[0] > 60_000) requester.shift();
    if (this.globalRequestTimestamps.length >= 12 || requester.length >= 3) return false;
    this.globalRequestTimestamps.push(now);
    requester.push(now);
    this.requesterTimestamps.set(requesterId, requester);
    return true;
  }

  private pruneCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > 120) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
    for (const [requesterId, timestamps] of this.requesterTimestamps) {
      if (timestamps.every((timestamp) => now - timestamp > 60_000)) this.requesterTimestamps.delete(requesterId);
    }
  }

  private async searchEndpoint(
    query: string,
    endpointMode: SearchMode,
    requestedMode: SearchMode,
  ): Promise<Array<Omit<ResearchResult, "id">>> {
    const endpoint =
      endpointMode === "news"
        ? `https://www.bing.com/news/search?format=rss&q=${encodeURIComponent(query)}`
        : `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(endpoint, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": "TheThirdPlace/0.2" },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Research provider returned ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
    if (!contentType.includes("xml") && !contentType.includes("rss")) {
      throw new Error("Research provider returned an unexpected content type");
    }
    const xml = await readLimitedText(response, 350_000);
    const rawResults = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 10);
    const seenUrls = new Set<string>();
    const parsedResults: Omit<ResearchResult, "id">[] = [];
    for (const match of rawResults) {
      const item = match[1] ?? "";
      const title = xmlField(item, "title").slice(0, 180);
      const url = sourceUrl(xmlField(item, "link"));
      const snippet = xmlField(item, "description").slice(0, 650);
      if (!title || !url || !snippet || seenUrls.has(url)) continue;
      seenUrls.add(url);
      parsedResults.push({
        title,
        url,
        snippet,
        ...(requestedMode === "news" && xmlField(item, "pubDate") ? { publishedAt: xmlField(item, "pubDate") } : {}),
      });
      if (parsedResults.length >= 5) break;
    }
    return parsedResults;
  }

  private async search(query: string, mode: SearchMode): Promise<ResearchPacket | undefined> {
    let parsedResults = await this.searchEndpoint(query, mode, mode);
    // Bing News can return a successful, well-formed but empty RSS feed for
    // otherwise useful multilingual queries. Retry only that semantic-empty
    // case against the fixed Web RSS endpoint, preserving the exact bounded
    // query and requested news result shape. Transport, media-type and body
    // bound errors throw above and therefore never trigger this fallback.
    if (mode === "news" && parsedResults.length === 0) {
      parsedResults = await this.searchEndpoint(query, "web", mode);
    }
    if (parsedResults.length === 0) return undefined;
    const results = parsedResults.map((result, index) => ({ id: `S${index + 1}`, ...result }));
    return { kind: "search", query, retrievedAt: new Date().toISOString(), results };
  }

}
