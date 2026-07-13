import { isIP } from "node:net";

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

type SearchMode = "news" | "web";

const NEWS_INTENT = /\b(nyhet(?:er|erna)?|nyhetsläget|rubriker|news|headlines|breaking)\b/i;
const EXPLICIT_LOOKUP =
  /\b(kolla upp|sök(?: efter| på webben)?|slå upp|googla|webbsök|leta upp|check online|search(?: for| the web)?|look up|browse(?: the web)?)\b/i;
const FRESHNESS = /\b(senaste|aktuell(?:t|a)?|just nu|i dag|idag|dagens|nuvarande|live|den här veckan|current|latest|right now|today|this week|recent)\b/i;
const QUESTION = /[?]|\b(vad|vem|vilken|vilket|vilka|hur|var|när|what|who|which|how|where|when)\b/i;
const PERSONAL_CHAT = /\b(du|dig|din|ditt|dina|you|your|yours)\b/i;
const URL_TARGET = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:^|[^@\p{L}\p{N}_])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/giu;
const ROOM_FRESHNESS: Partial<Record<string, RegExp>> = {
  "the-pub": /\b(regering(?:en)?|riksdag(?:en)?|minister|partiledare|president|val(?:et)?|opinionsmätning|polls?|ny(?:a|tt)? (?:film|album|låt|serie)|premiär(?:en)?|topplista|charts?|turné|tour dates?)\b/i,
  "stock-market": /\b(aktie(?:n|r|kurs|kursen|kurser|kurserna)?|börskurs(?:en|er|erna)?|kurs(?:en|er|erna)?|index|handlas|marknadsvärde|market cap|stock price|share price|trading at|quote)\b/i,
  "world-of-warcraft": /\b(patch(?:en)?|hotfix|season|säsong|meta|tier list|current expansion|senaste expansion)\b/i,
  "ai-programming": /\b(sdk-version|api-version|library version|biblioteksversion|modellversion|model version|senaste version)\b/i,
  "ai-lab": /\b(modellversion|model version|benchmark result|benchmarkresultat|release date|releasedatum)\b/i,
  "3d-visualisation": /\b(blender-version|unreal-version|unity-version|rendererversion|renderer version|plugin compatibility|plugin-kompatibilitet|gpu support|gpu-stöd)\b/i,
};

const withoutUrlTargets = (content: string): string => content.replace(URL_TARGET, " ");

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

  shouldResearch(content: string, channelId?: string): boolean {
    if (process.env.RESEARCH_ENABLED !== "true") return false;
    const intent = withoutUrlTargets(content);
    if (NEWS_INTENT.test(intent) || EXPLICIT_LOOKUP.test(intent)) return true;
    if (channelId && ROOM_FRESHNESS[channelId]?.test(intent) && QUESTION.test(intent)) return true;
    return FRESHNESS.test(intent) && QUESTION.test(intent) && !PERSONAL_CHAT.test(intent);
  }

  async research(content: string, requesterId = "anonymous", channelId?: string): Promise<ResearchPacket | undefined> {
    if (!this.shouldResearch(content, channelId)) return undefined;
    const mode = NEWS_INTENT.test(withoutUrlTargets(content)) ? "news" : "web";
    const query = this.toQuery(content);
    return this.researchQuery(query, mode, requesterId);
  }

  async researchUrlFallback(
    content: string,
    url: URL,
    requesterId = "anonymous",
  ): Promise<ResearchPacket | undefined> {
    if (process.env.RESEARCH_ENABLED !== "true" || url.protocol !== "https:" || !url.hostname.includes(".")) return undefined;
    const mode = NEWS_INTENT.test(withoutUrlTargets(content)) || /(?:^|\/)news(?:\/|$)/iu.test(url.pathname)
      ? "news"
      : "web";
    const topic = this.toQuery(content)
      .replace(/\b(?:länk(?:en)?|sida(?:n)?|sajt(?:en)?|artikel(?:n)?|link|page|site|article)\b/giu, " ")
      .replace(/\b(?:har\s+(?:du|ni|någon)\s+läst|have\s+you\s+read|läs|kolla|öppna|försök|prova|read|check|open|try)\b/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const host = url.hostname.toLocaleLowerCase();
    const query = `site:${host}${topic ? ` ${topic}` : ""}`.slice(0, 160);
    const packet = await this.researchQuery(query, mode, requesterId);
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
    if (query.length < 3) return undefined;
    const key = `${mode}:${query.toLocaleLowerCase()}`;
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

  private async search(query: string, mode: SearchMode): Promise<ResearchPacket | undefined> {
    const endpoint =
      mode === "news"
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
        ...(mode === "news" && xmlField(item, "pubDate") ? { publishedAt: xmlField(item, "pubDate") } : {}),
      });
      if (parsedResults.length >= 5) break;
    }
    if (parsedResults.length === 0) return undefined;
    const results = parsedResults.map((result, index) => ({ id: `S${index + 1}`, ...result }));
    return { kind: "search", query, retrievedAt: new Date().toISOString(), results };
  }

  private toQuery(content: string): string {
    return withoutUrlTargets(content)
      .replace(/@[\p{L}\p{N}_.-]+/gu, " ")
      .replace(/^[\s,.:;-]+/, "")
      .replace(/([?！!]).*$/s, " ")
      .replace(EXPLICIT_LOOKUP, " ")
      .replace(/^(?:kan|kunde|skulle|vill)\s+(?:du|ni|någon)\s+(?:kolla|läsa|öppna|söka|leta)(?:\s+upp)?\s+/iu, "")
      .replace(/^(?:kan|skulle)\s+du\s+/i, "")
      .replace(/^(?:vilken|vilket|vilka|vad|vem|hur|var|när|what|who|which|how|where|when)\s+(?:är|har|händer|finns|is|are|has|happens)?\s*(?:de|det|den|the)?\s*/i, "")
      .replace(/\b(senaste|just nu|i dag|idag|dagens|nuvarande|live|den här veckan|latest|right now|today|this week)\b/gi, " ")
      .replace(/\b(?:på|hos|at|on)\s*$/iu, " ")
      .replace(/[?！!]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }
}
