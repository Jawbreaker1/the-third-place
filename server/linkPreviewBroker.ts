import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { parse } from "parse5";
import type { LinkPreview } from "../shared/types.js";

interface CachedPreview {
  expiresAt: number;
  preview?: LinkPreview;
}

interface ParsedNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedNode[];
  value?: string;
}

interface FetchResult {
  finalUrl: URL;
  html: string;
}

type LookupAll = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

const MAX_URL_LENGTH = 2_048;
const MAX_HTML_BYTES = 384 * 1024;
const MAX_REDIRECTS = 2;
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".onion",
  ".invalid",
  ".test",
];

const stripTrailingPunctuation = (value: string): string => value.replace(/[),.!?;:\]]+$/g, "");

const sanitizeText = (value: string | undefined, limit: number): string | undefined => {
  if (!value) return undefined;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return cleaned || undefined;
};

const normalizedAddress = (raw: string): string => {
  const parsed = ipaddr.parse(raw);
  const ipv6 = parsed.kind() === "ipv6" ? (parsed as ipaddr.IPv6) : undefined;
  return ipv6?.isIPv4MappedAddress()
    ? ipv6.toIPv4Address().toString()
    : parsed.toNormalizedString();
};

export const isPublicAddress = (raw: string): boolean => {
  try {
    const parsed = ipaddr.parse(raw);
    const ipv6 = parsed.kind() === "ipv6" ? (parsed as ipaddr.IPv6) : undefined;
    const normalized = ipv6?.isIPv4MappedAddress() ? ipv6.toIPv4Address() : parsed;
    return normalized.range() === "unicast";
  } catch {
    return false;
  }
};

export const validatePreviewUrl = (raw: string): URL | undefined => {
  if (!raw || raw.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !host ||
      host.length > 253 ||
      host.split(".").some((label) => !label || label.length > 63) ||
      ipaddr.isValid(host) ||
      host === "localhost" ||
      BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
      /%(?:0[0-9a-f]|7f)/i.test(`${url.pathname}${url.search}`)
    ) {
      return undefined;
    }
    url.hostname = host;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
};

export const extractPreviewUrl = (content: string): URL | undefined => {
  const match = content.match(/https:\/\/[^\s<>"']+/iu)?.[0];
  return match ? validatePreviewUrl(stripTrailingPunctuation(match)) : undefined;
};

const textContent = (node: ParsedNode): string => {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
};

const findHead = (node: ParsedNode): ParsedNode | undefined => {
  if (node.tagName === "head") return node;
  for (const child of node.childNodes ?? []) {
    const found = findHead(child);
    if (found) return found;
  }
  return undefined;
};

export const parseLinkMetadata = (html: string, finalUrl: URL): LinkPreview | undefined => {
  const document = parse(html) as unknown as ParsedNode;
  const head = findHead(document);
  if (!head) return undefined;
  const meta = new Map<string, string>();
  let documentTitle: string | undefined;
  const visit = (node: ParsedNode): void => {
    if (node.tagName === "title" && !documentTitle) documentTitle = textContent(node);
    if (node.tagName === "meta") {
      const attrs = Object.fromEntries((node.attrs ?? []).map((attribute) => [attribute.name.toLocaleLowerCase(), attribute.value]));
      const key = (attrs.property || attrs.name || "").toLocaleLowerCase();
      if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(head);
  const title = sanitizeText(meta.get("og:title") ?? meta.get("twitter:title") ?? documentTitle, 160);
  if (!title) return undefined;
  const displayHost = finalUrl.hostname.toLocaleLowerCase();
  const siteName = sanitizeText(meta.get("og:site_name"), 80) ?? displayHost;
  const description = sanitizeText(
    meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"),
    320,
  );
  return {
    url: finalUrl.toString(),
    displayHost,
    title,
    ...(description ? { description } : {}),
    siteName,
    fetchedAt: new Date().toISOString(),
  };
};

export const resolvePublicAddress = async (
  hostname: string,
  deadline: number,
  lookupImpl: LookupAll = lookup as LookupAll,
): Promise<{ address: string; family: 4 | 6 } | undefined> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    const results = await Promise.race([
      lookupImpl(hostname, { all: true, verbatim: true }),
      new Promise<undefined>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
    if (!results || results.length === 0 || results.some((result) => !isPublicAddress(result.address))) {
      return undefined;
    }
    const chosen = results[0];
    return chosen ? { address: chosen.address, family: chosen.family === 6 ? 6 : 4 } : undefined;
  } catch {
    return undefined;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
};

const requestHeadHtml = async (url: URL, deadline: number): Promise<{ html?: string; redirect?: string }> => {
  const address = await resolvePublicAddress(url.hostname, deadline);
  if (!address || Date.now() >= deadline) return {};
  return await new Promise((resolve) => {
    let settled = false;
    let bodyTimer: NodeJS.Timeout | undefined;
    const finish = (value: { html?: string; redirect?: string }): void => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      resolve(value);
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        timeout: Math.max(100, deadline - Date.now()),
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address: address.address, family: address.family }]);
          } else {
            callback(null, address.address, address.family);
          }
        },
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          "User-Agent": "TheThirdPlace-LinkPreview/1.0",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.destroy();
          finish({ redirect: response.headers.location });
          return;
        }
        const contentType = response.headers["content-type"]?.toLocaleLowerCase() ?? "";
        const encoding = response.headers["content-encoding"]?.toLocaleLowerCase() ?? "identity";
        const announcedLength = Number.parseInt(response.headers["content-length"] ?? "0", 10);
        if (
          status < 200 ||
          status >= 300 ||
          (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) ||
          (encoding !== "identity" && encoding !== "") ||
          (Number.isFinite(announcedLength) && announcedLength > MAX_HTML_BYTES)
        ) {
          response.destroy();
          finish({});
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const resetBodyTimer = (): void => {
          if (bodyTimer) clearTimeout(bodyTimer);
          bodyTimer = setTimeout(() => {
            response.destroy();
            finish({});
          }, Math.min(2_000, Math.max(100, deadline - Date.now())));
        };
        resetBodyTimer();
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HTML_BYTES || Date.now() >= deadline) {
            response.destroy();
            finish({});
            return;
          }
          chunks.push(chunk);
          const html = Buffer.concat(chunks).toString("utf8");
          const headEnd = html.toLocaleLowerCase().indexOf("</head>");
          if (headEnd >= 0) {
            response.destroy();
            finish({ html: html.slice(0, headEnd + 7) });
            return;
          }
          resetBodyTimer();
        });
        response.on("end", () => finish({ html: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () => finish({}));
      },
    );
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        const remote = socket.remoteAddress;
        if (!remote || normalizedAddress(remote) !== normalizedAddress(address.address)) request.destroy();
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish({}));
    request.end();
  });
};

const fetchPinnedHtml = async (startUrl: URL): Promise<FetchResult | undefined> => {
  const deadline = Date.now() + 7_000;
  const visited = new Set<string>();
  let current = startUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (visited.has(current.toString())) return undefined;
    visited.add(current.toString());
    const result = await requestHeadHtml(current, deadline);
    if (result.html) return { finalUrl: current, html: result.html };
    if (!result.redirect || redirects === MAX_REDIRECTS) return undefined;
    const next = validatePreviewUrl(new URL(result.redirect, current).toString());
    if (!next) return undefined;
    current = next;
  }
  return undefined;
};

export class LinkPreviewBroker {
  private readonly cache = new Map<string, CachedPreview>();
  private readonly inFlight = new Map<string, Promise<LinkPreview | undefined>>();
  private readonly globalTimestamps: number[] = [];
  private readonly requesterTimestamps = new Map<string, number[]>();
  private readonly originTimestamps = new Map<string, number[]>();
  private activeRequests = 0;

  async previewMessage(content: string, requesterId: string): Promise<LinkPreview | undefined> {
    if (process.env.LINK_PREVIEWS_ENABLED === "false") return undefined;
    const url = extractPreviewUrl(content);
    if (!url) return undefined;
    const key = url.toString();
    this.prune();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.preview;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.activeRequests >= 3 || !this.reserve(requesterId, url.origin)) return undefined;
    this.activeRequests += 1;
    const request = fetchPinnedHtml(url)
      .then((result) => (result ? parseLinkMetadata(result.html, result.finalUrl) : undefined))
      .catch(() => undefined)
      .then((preview) => {
        this.cache.set(key, {
          preview,
          expiresAt: Date.now() + (preview ? 30 * 60_000 : 90_000),
        });
        return preview;
      })
      .finally(() => {
        this.activeRequests -= 1;
        this.inFlight.delete(key);
        this.prune();
      });
    this.inFlight.set(key, request);
    return request;
  }

  private reserve(requesterId: string, origin: string): boolean {
    const now = Date.now();
    const trim = (timestamps: number[]) => {
      while (timestamps[0] && now - timestamps[0] > 60_000) timestamps.shift();
    };
    trim(this.globalTimestamps);
    const requester = this.requesterTimestamps.get(requesterId) ?? [];
    const originRequests = this.originTimestamps.get(origin) ?? [];
    trim(requester);
    trim(originRequests);
    if (this.globalTimestamps.length >= 20 || requester.length >= 3 || originRequests.length >= 2) return false;
    this.globalTimestamps.push(now);
    requester.push(now);
    originRequests.push(now);
    this.requesterTimestamps.set(requesterId, requester);
    this.originTimestamps.set(origin, originRequests);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    for (const [key, timestamps] of this.requesterTimestamps) {
      if (timestamps.every((timestamp) => now - timestamp > 60_000)) this.requesterTimestamps.delete(key);
    }
    for (const [key, timestamps] of this.originTimestamps) {
      if (timestamps.every((timestamp) => now - timestamp > 60_000)) this.originTimestamps.delete(key);
    }
  }
}
