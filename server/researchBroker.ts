import { isIP } from "node:net";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { parse as parseDomain } from "tldts";
import { stripDangerousTextControls, unicodeCaselessKey } from "../shared/unicodeSafety.js";

export interface ResearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  /**
   * Trusted transport metadata added only by the broker when a server-authored
   * source preference was active. It ranks discovery; it is not proof that a
   * source supports a particular factual claim.
   */
  sourceAuthority?: ResearchSourceAuthority;
}

export interface ResearchPacket {
  /** Trusted server evidence transport; structured kinds come only from typed fixed-provider services. */
  kind?: "search" | "page" | "weather" | "market" | "football";
  query: string;
  retrievedAt: string;
  results: ResearchResult[];
  search?: ResearchSearchMetadata;
}

interface CachedResearch {
  expiresAt: number;
  packet: ResearchPacket;
}

export type SearchMode = "news" | "web";
export type SearchScope = "generic" | "site";
export type ResearchCachePolicy = "default" | "bypass";

export interface PreferPrimaryResearchSourcePolicy {
  strategy: "prefer_primary";
  /** Trusted server configuration, never copied from a participant message. */
  canonicalHosts: readonly string[];
}

export type ResearchSourcePolicy = PreferPrimaryResearchSourcePolicy;

export interface ResearchSourceAuthority {
  preference: "prefer_primary";
  tier: "preferred" | "fallback";
  meaning: "discovery_preference_not_claim_support";
  /** Present only for a structurally matched preferred host. */
  matchedCanonicalHost?: string;
}

export interface AppliedResearchSourcePreference {
  strategy: "prefer_primary";
  canonicalHosts: string[];
  fingerprint: string;
}

export type SiteResearchQualityClass = "empty" | "root_only" | "deep_links" | "fresh_results";

export interface SiteResearchQuality {
  classification: SiteResearchQualityClass;
  resultCount: number;
  rootResultCount: number;
  deepLinkResultCount: number;
  datedResultCount: number;
  freshResultCount: number;
}

export interface ResearchSearchMetadata {
  scope: SearchScope;
  /** The semantic mode requested by the caller, retained across provider fallback. */
  requestedMode: SearchMode;
  /** The fixed provider endpoint that actually supplied the returned results. */
  providerMode: SearchMode;
  site?: {
    host: string;
    quality: SiteResearchQuality;
  };
  sourcePreference?: AppliedResearchSourcePreference;
}

export interface SiteResearchPacket extends ResearchPacket {
  kind: "search";
  search: ResearchSearchMetadata & {
    scope: "site";
    site: {
      host: string;
      quality: SiteResearchQuality;
    };
  };
}

export interface ResearchRequest {
  query: string;
  mode: SearchMode;
  requesterId?: string;
  /** Explicit retries may bypass a completed cache entry while retaining normal rate limits. */
  cachePolicy?: ResearchCachePolicy;
  /** Optional trusted room policy. The broker validates and fingerprints it. */
  sourcePolicy?: ResearchSourcePolicy;
}

export interface SiteResearchRequest extends ResearchRequest {
  url: URL;
}

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;

const DEFAULT_SITE_FRESHNESS_WINDOW_MS = 45 * 24 * 60 * 60_000;
const MAX_PREFERRED_SOURCE_HOSTS = 8;
const MAX_PREFERRED_SITE_EXPRESSION_LENGTH = 1_024;
const MAX_RESEARCH_RESULTS = 5;
const MIN_GENERIC_FALLBACK_RESULTS = 2;

const canonicalWwwHost = (host: string): string => host.startsWith("www.") ? host.slice(4) : host;

const isSameCanonicalSiteHost = (candidate: string, requested: string): boolean =>
  candidate === requested || canonicalWwwHost(candidate) === canonicalWwwHost(requested);

/**
 * Validates a host as a bare canonical DNS name. Using URL structure plus
 * label constraints prevents suffix tricks, userinfo, ports, paths and search
 * operators from entering server-authored site queries.
 */
export const canonicalResearchSourceHost = (raw: string): string | undefined => {
  if (!raw || raw !== raw.trim() || raw.length > 253 || raw.endsWith(".")) return undefined;
  const lower = raw.toLocaleLowerCase();
  if (!/^[a-z0-9.-]+$/u.test(lower)) return undefined;
  const labels = lower.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) =>
      !label ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
  ) return undefined;
  try {
    const parsed = new URL(`https://${lower}/`);
    if (
      parsed.hostname !== lower ||
      parsed.host !== lower ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      isIP(parsed.hostname) !== 0
    ) return undefined;
    const domain = parseDomain(lower, { allowPrivateDomains: true });
    // A policy may name an organization host or one of its subdomains, never
    // an entire public/private registry suffix such as co.uk or github.io.
    if (!domain.domain || domain.publicSuffix === lower) return undefined;
  } catch {
    return undefined;
  }
  return lower;
};

export const normalizeResearchSourcePolicy = (
  policy: ResearchSourcePolicy | undefined,
): AppliedResearchSourcePreference | undefined => {
  if (!policy || policy.strategy !== "prefer_primary") return undefined;
  const canonicalHosts = [...new Set(
    policy.canonicalHosts
      .slice(0, MAX_PREFERRED_SOURCE_HOSTS)
      .flatMap((host) => {
        const canonical = canonicalResearchSourceHost(host);
        return canonical ? [canonical] : [];
      }),
  )].sort();
  if (canonicalHosts.length === 0) return undefined;
  return {
    strategy: "prefer_primary",
    canonicalHosts,
    fingerprint: `prefer_primary:${canonicalHosts.join(",")}`,
  };
};

const preferredCanonicalHostFor = (
  rawUrl: string,
  preference: AppliedResearchSourcePreference,
): string | undefined => {
  try {
    const candidate = new URL(rawUrl).hostname.toLocaleLowerCase().replace(/\.$/u, "");
    return preference.canonicalHosts.find((canonical) =>
      candidate === canonical || candidate.endsWith(`.${canonical}`),
    );
  } catch {
    return undefined;
  }
};

const sourceAuthorityFor = (
  rawUrl: string,
  preference: AppliedResearchSourcePreference,
): ResearchSourceAuthority => {
  const matchedCanonicalHost = preferredCanonicalHostFor(rawUrl, preference);
  return matchedCanonicalHost
    ? {
        preference: "prefer_primary",
        tier: "preferred",
        meaning: "discovery_preference_not_claim_support",
        matchedCanonicalHost,
      }
    : {
        preference: "prefer_primary",
        tier: "fallback",
        meaning: "discovery_preference_not_claim_support",
      };
};

/**
 * Structural site-result assessment only. It deliberately does not inspect
 * words, brands or domain-specific URL fragments. A caller can distinguish a
 * generic root hit from navigable deep links and provider-dated fresh results
 * without turning the transport broker into another intent classifier.
 */
export const assessSiteResearchQuality = (
  requestedUrl: URL,
  results: readonly Pick<ResearchResult, "url" | "publishedAt">[],
  options: { now?: number; freshnessWindowMs?: number } = {},
): SiteResearchQuality => {
  const requestedHost = requestedUrl.hostname.toLocaleLowerCase().replace(/\.$/u, "");
  const now = options.now ?? Date.now();
  const freshnessWindowMs = Math.max(0, options.freshnessWindowMs ?? DEFAULT_SITE_FRESHNESS_WINDOW_MS);
  let rootResultCount = 0;
  let deepLinkResultCount = 0;
  let datedResultCount = 0;
  let freshResultCount = 0;

  for (const result of results) {
    try {
      const parsed = new URL(result.url);
      const resultHost = parsed.hostname.toLocaleLowerCase().replace(/\.$/u, "");
      if (!isSameCanonicalSiteHost(resultHost, requestedHost)) continue;
      if (parsed.pathname === "/" && parsed.search === "") rootResultCount += 1;
      else deepLinkResultCount += 1;
    } catch {
      continue;
    }
    if (!result.publishedAt) continue;
    const publishedAt = Date.parse(result.publishedAt);
    if (!Number.isFinite(publishedAt)) continue;
    datedResultCount += 1;
    const age = now - publishedAt;
    // A small clock-skew allowance avoids rejecting provider timestamps that
    // are only a few minutes ahead, while far-future dates never count as fresh.
    if (age >= -5 * 60_000 && age <= freshnessWindowMs) freshResultCount += 1;
  }

  const resultCount = rootResultCount + deepLinkResultCount;
  const classification: SiteResearchQualityClass = resultCount === 0
    ? "empty"
    : freshResultCount > 0
      ? "fresh_results"
      : deepLinkResultCount > 0
        ? "deep_links"
        : "root_only";
  return {
    classification,
    resultCount,
    rootResultCount,
    deepLinkResultCount,
    datedResultCount,
    freshResultCount,
  };
};

export const hasSpecificSiteResearchResults = (quality: SiteResearchQuality): boolean =>
  quality.deepLinkResultCount > 0 || quality.freshResultCount > 0;

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
  if (raw.length === 0 || raw.length > 4_096) return undefined;
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

const duckDuckGoSourceUrl = (raw: string): string | undefined => {
  try {
    const parsed = new URL(raw, "https://html.duckduckgo.com");
    const host = parsed.hostname.toLocaleLowerCase().replace(/\.$/u, "");
    if (
      (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) &&
      parsed.pathname === "/l/"
    ) {
      const target = parsed.searchParams.get("uddg");
      return target ? safeSourceUrl(target) : undefined;
    }
  } catch {
    return undefined;
  }
  return safeSourceUrl(raw);
};

const htmlChildren = (node: HtmlNode): readonly DefaultTreeAdapterTypes.ChildNode[] =>
  "childNodes" in node ? node.childNodes : [];

const isHtmlElement = (node: HtmlNode): node is HtmlElement => "attrs" in node;

const htmlAttribute = (node: HtmlElement, name: string): string | undefined =>
  node.attrs.find((attribute) => attribute.name === name)?.value;

const htmlClasses = (node: HtmlElement): Set<string> =>
  new Set((htmlAttribute(node, "class") ?? "").split(/\s+/u).filter(Boolean));

const htmlElements = (
  root: HtmlNode,
  predicate: (element: HtmlElement) => boolean,
  limit: number,
): HtmlElement[] => {
  const matches: HtmlElement[] = [];
  const pending: HtmlNode[] = [...htmlChildren(root)].reverse();
  let visited = 0;
  while (pending.length > 0 && visited < 30_000 && matches.length < limit) {
    const node = pending.pop()!;
    visited += 1;
    if (isHtmlElement(node) && predicate(node)) matches.push(node);
    const children = htmlChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return matches;
};

const htmlText = (root: HtmlNode): string => {
  const parts: string[] = [];
  const pending: HtmlNode[] = [root];
  let visited = 0;
  while (pending.length > 0 && visited < 4_000) {
    const node = pending.pop()!;
    visited += 1;
    if (node.nodeName === "#text" && "value" in node) {
      parts.push(node.value);
      continue;
    }
    if (node.nodeName === "script" || node.nodeName === "style" || node.nodeName === "template") continue;
    const children = htmlChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return stripDangerousTextControls(parts.join(""))
    .replace(/\s+/gu, " ")
    .trim();
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
    const sourcePreference = normalizeResearchSourcePolicy(request.sourcePolicy);
    return this.researchQuery(
      query,
      request.mode,
      request.requesterId ?? "anonymous",
      "generic",
      request.cachePolicy ?? "default",
      sourcePreference,
    );
  }

  async researchSite(request: SiteResearchRequest): Promise<SiteResearchPacket | undefined> {
    if (process.env.RESEARCH_ENABLED !== "true") return undefined;
    const { url } = request;
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return undefined;
    const topic = boundedQuery(request.query);
    const host = url.hostname.toLocaleLowerCase().replace(/\.$/u, "");
    const query = `site:${host}${topic ? ` ${topic}` : ""}`.slice(0, 160);
    const matchesRequestedSite = (result: Pick<ResearchResult, "url">): boolean => {
      try {
        const resultHost = new URL(result.url).hostname.toLocaleLowerCase().replace(/\.$/u, "");
        return isSameCanonicalSiteHost(resultHost, host);
      } catch {
        return false;
      }
    };
    const packet = await this.researchQuery(
      query,
      request.mode,
      request.requesterId ?? "anonymous",
      "site",
      request.cachePolicy ?? "default",
      undefined,
      matchesRequestedSite,
    );
    if (!packet) return undefined;
    const results = packet.results
      .filter(matchesRequestedSite)
      .map((result, index) => ({ ...result, id: `S${index + 1}` }));
    if (results.length === 0) return undefined;
    return {
      ...packet,
      kind: "search",
      results,
      search: {
        scope: "site",
        requestedMode: request.mode,
        providerMode: packet.search?.providerMode ?? request.mode,
        site: {
          host,
          quality: assessSiteResearchQuality(url, results),
        },
      },
    };
  }

  private async researchQuery(
    query: string,
    mode: SearchMode,
    requesterId: string,
    scope: SearchScope,
    cachePolicy: ResearchCachePolicy,
    sourcePreference: AppliedResearchSourcePreference | undefined,
    siteResultMatches?: (result: Pick<ResearchResult, "url">) => boolean,
  ): Promise<ResearchPacket | undefined> {
    const sourceFingerprint = sourcePreference?.fingerprint ?? "unranked";
    const key = `${scope}:${mode}:${sourceFingerprint}:${unicodeCaselessKey(query)}`;
    this.pruneCache();
    if (cachePolicy === "bypass") {
      // A retry must not resurrect the result it was explicitly retrying.
      this.cache.delete(key);
    } else {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.packet;
      }
    }
    const inFlightKey = `${cachePolicy}:${key}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;
    if (!this.reserveRequest(requesterId)) return undefined;

    const request = this.search(query, mode, scope, sourcePreference, siteResultMatches)
      .finally(() => this.inFlight.delete(inFlightKey));
    this.inFlight.set(inFlightKey, request);
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

  private async searchBingRss(
    query: string,
    endpointMode: SearchMode,
    requestedMode: SearchMode,
    resultLimit = 5,
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
      if (parsedResults.length >= resultLimit) break;
    }
    return parsedResults;
  }

  private async searchDuckDuckGoHtml(
    query: string,
    resultLimit = MAX_RESEARCH_RESULTS,
  ): Promise<Array<Omit<ResearchResult, "id">>> {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(endpoint, {
      headers: { Accept: "text/html", "User-Agent": "TheThirdPlace/0.2" },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Research provider returned ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error("Research provider returned an unexpected content type");
    }
    const html = await readLimitedText(response, 350_000);
    const document = parse(html);
    const rawResults = htmlElements(document, (element) => {
      const classes = htmlClasses(element);
      return classes.has("result") && classes.has("web-result") && !classes.has("result--ad");
    }, 10);
    const seenUrls = new Set<string>();
    const parsedResults: Array<Omit<ResearchResult, "id">> = [];
    for (const result of rawResults) {
      const titleLink = htmlElements(result, (element) => htmlClasses(element).has("result__a"), 1)[0];
      const snippetElement = htmlElements(result, (element) => htmlClasses(element).has("result__snippet"), 1)[0];
      const title = titleLink ? htmlText(titleLink).slice(0, 180) : "";
      const url = titleLink ? duckDuckGoSourceUrl(htmlAttribute(titleLink, "href") ?? "") : undefined;
      const snippet = snippetElement ? htmlText(snippetElement).slice(0, 650) : "";
      if (!title || !url || !snippet || seenUrls.has(url)) continue;
      seenUrls.add(url);
      parsedResults.push({ title, url, snippet });
      if (parsedResults.length >= Math.max(1, Math.min(resultLimit, 10))) break;
    }
    return parsedResults;
  }

  private async providerSearch(
    query: string,
    mode: SearchMode,
    scope: SearchScope,
    resultLimit = MAX_RESEARCH_RESULTS,
    siteResultMatches?: (result: Pick<ResearchResult, "url">) => boolean,
  ): Promise<{
    providerMode: SearchMode;
    results: Array<Omit<ResearchResult, "id">>;
  }> {
    let providerMode = mode;
    let parsedResults = mode === "web"
      ? scope === "generic"
        ? await this.searchDuckDuckGoHtml(query)
        : await this.searchBingRss(query, "web", mode, resultLimit)
      : await this.searchBingRss(query, "news", mode, resultLimit);
    // Bing News can return a successful, well-formed but empty RSS feed for
    // otherwise useful multilingual queries. Retry only that semantic-empty
    // case against the scope's fixed Web provider, preserving the exact
    // bounded query. Transport, media-type and body-bound errors throw above
    // and therefore never trigger this fallback.
    if (mode === "news" && parsedResults.length === 0) {
      providerMode = "web";
      parsedResults = scope === "generic"
        ? await this.searchDuckDuckGoHtml(query)
        : await this.searchBingRss(query, "web", mode, resultLimit);
    }
    if (scope === "site" && siteResultMatches) {
      parsedResults = parsedResults.filter(siteResultMatches);
      // Bing's Web RSS endpoint can return a non-empty but entirely off-site
      // result set for a valid site-scoped query. That is semantically empty
      // for this trusted scope. Retry the same bounded query once through the
      // fixed HTML provider; never fan out by host and never reinterpret it.
      if (providerMode === "web" && parsedResults.length === 0) {
        parsedResults = (await this.searchDuckDuckGoHtml(query, resultLimit))
          .filter(siteResultMatches);
      }
    }
    return { providerMode, results: parsedResults.slice(0, resultLimit) };
  }

  private async preferredSearch(
    query: string,
    mode: SearchMode,
    preference: AppliedResearchSourcePreference,
  ): Promise<ResearchPacket | undefined> {
    // Two bounded provider arms are allowed: one combined site-scoped
    // discovery and one ordinary lookup. An arm may use only its bounded
    // semantic-empty provider fallback (news→Web and site-Web RSS→HTML);
    // there is never per-host fan-out.
    const preferredTerms: string[] = [];
    for (const host of preference.canonicalHosts) {
      const candidate = [...preferredTerms, `site:${host}`].join(" OR ");
      if (`(${candidate}) `.length > MAX_PREFERRED_SITE_EXPRESSION_LENGTH) break;
      preferredTerms.push(`site:${host}`);
    }
    // At least the first validated 253-byte DNS host fits this bound. The
    // participant's already-bounded semantic query is appended intact rather
    // than silently losing its requested answer dimension.
    const preferredQuery = `(${preferredTerms.join(" OR ")}) ${query}`;
    const genericPromise = this.providerSearch(query, mode, "generic", MAX_RESEARCH_RESULTS);
    const sitePromise = this.providerSearch(
      preferredQuery,
      mode,
      "site",
      10,
      (result) => preferredCanonicalHostFor(result.url, preference) !== undefined,
    );
    const [genericSettled, siteSettled] = await Promise.allSettled([
      genericPromise,
      sitePromise,
    ]);
    const generic = genericSettled.status === "fulfilled"
      ? genericSettled.value
      : { providerMode: mode, results: [] };
    const siteResults = siteSettled.status === "fulfilled"
      ? siteSettled.value.results.filter((result) =>
          preferredCanonicalHostFor(result.url, preference) !== undefined)
      : [];
    if (generic.results.length === 0 && siteResults.length === 0) {
      const transportFailure = [
        genericSettled,
        siteSettled,
      ].find((settled): settled is PromiseRejectedResult => settled.status === "rejected");
      if (transportFailure) throw transportFailure.reason;
      return undefined;
    }

    const seen = new Set<string>();
    const unique = (results: readonly Omit<ResearchResult, "id">[]) => results.flatMap((result) => {
      if (seen.has(result.url)) return [];
      seen.add(result.url);
      return [result];
    });
    const preferred = unique([
      ...siteResults,
      ...generic.results.filter((result) => preferredCanonicalHostFor(result.url, preference)),
    ]);
    const fallback = unique(
      generic.results.filter((result) => !preferredCanonicalHostFor(result.url, preference)),
    );
    const fallbackReserve = Math.min(MIN_GENERIC_FALLBACK_RESULTS, fallback.length);
    const selected = [
      ...preferred.slice(0, MAX_RESEARCH_RESULTS - fallbackReserve),
      ...fallback.slice(0, fallbackReserve),
    ];
    if (selected.length < MAX_RESEARCH_RESULTS) {
      selected.push(
        ...preferred.slice(MAX_RESEARCH_RESULTS - fallbackReserve),
        ...fallback.slice(fallbackReserve),
      );
    }
    const results = selected
      .slice(0, MAX_RESEARCH_RESULTS)
      .map((result, index) => ({
        id: `S${index + 1}`,
        ...result,
        sourceAuthority: sourceAuthorityFor(result.url, preference),
      }));
    return {
      kind: "search",
      query,
      retrievedAt: new Date().toISOString(),
      results,
      search: {
        scope: "generic",
        requestedMode: mode,
        providerMode: generic.results.length > 0
          ? generic.providerMode
          : siteSettled.status === "fulfilled" ? siteSettled.value.providerMode : mode,
        sourcePreference: preference,
      },
    };
  }

  private async search(
    query: string,
    mode: SearchMode,
    scope: SearchScope,
    sourcePreference?: AppliedResearchSourcePreference,
    siteResultMatches?: (result: Pick<ResearchResult, "url">) => boolean,
  ): Promise<ResearchPacket | undefined> {
    if (scope === "generic" && sourcePreference) {
      return this.preferredSearch(query, mode, sourcePreference);
    }
    const { providerMode, results: parsedResults } = await this.providerSearch(
      query,
      mode,
      scope,
      scope === "site" ? 10 : MAX_RESEARCH_RESULTS,
      siteResultMatches,
    );
    if (parsedResults.length === 0) return undefined;
    const results = parsedResults.map((result, index) => ({ id: `S${index + 1}`, ...result }));
    return {
      kind: "search",
      query,
      retrievedAt: new Date().toISOString(),
      results,
      search: { scope, requestedMode: mode, providerMode },
    };
  }

}
