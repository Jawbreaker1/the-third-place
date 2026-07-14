import type { LinkPreview } from "../shared/types.js";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { parseHtmlWithBudget } from "./boundedHtml.js";
import {
  extractPublicHttpsUrls,
  fetchPublicHttps,
  validatePublicHttpsUrl,
} from "./safeHttpsFetch.js";
import { decodeTextBody } from "./textBodyDecoder.js";

export { isPublicAddress, resolvePublicAddress } from "./safeHttpsFetch.js";
export const validatePreviewUrl = validatePublicHttpsUrl;

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

interface PreviewWalkEntry {
  node: ParsedNode;
  depth: number;
}

const MAX_PREVIEW_NODES = 12_000;
const MAX_PREVIEW_DEPTH = 64;
const BLOCKED_HEAD_TAGS = new Set(["script", "style", "noscript", "template"]);

const childEntries = (node: ParsedNode, depth: number): PreviewWalkEntry[] =>
  (node.childNodes ?? []).map((child) => ({ node: child, depth })).reverse();

const sanitizeText = (value: string | undefined, limit: number): string | undefined => {
  if (!value) return undefined;
  const cleaned = stripDangerousTextControls(value.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return cleaned || undefined;
};

export const extractPreviewUrl = (content: string): URL | undefined => extractPublicHttpsUrls(content, 1)[0];

const textContent = (node: ParsedNode): string => {
  const stack: PreviewWalkEntry[] = [{ node, depth: 0 }];
  const parts: string[] = [];
  let visited = 0;
  let length = 0;
  while (stack.length > 0 && visited < MAX_PREVIEW_NODES && length < 2_000) {
    const current = stack.pop()!;
    if (current.depth > MAX_PREVIEW_DEPTH || (current.node.tagName && BLOCKED_HEAD_TAGS.has(current.node.tagName))) continue;
    visited += 1;
    if (current.node.nodeName === "#text") {
      const value = (current.node.value ?? "").slice(0, 2_000 - length);
      parts.push(value);
      length += value.length;
      continue;
    }
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  return parts.join("");
};

const findHead = (node: ParsedNode): ParsedNode | undefined => {
  const stack: PreviewWalkEntry[] = [{ node, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_PREVIEW_NODES) {
    const current = stack.pop()!;
    if (current.depth > MAX_PREVIEW_DEPTH) continue;
    visited += 1;
    if (current.node.tagName === "head") return current.node;
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  return undefined;
};

export const parseLinkMetadata = (
  body: Buffer | string,
  finalUrl: URL,
  clickUrl: URL = finalUrl,
  contentType = "text/html",
): LinkPreview | undefined => {
  const html = Buffer.isBuffer(body)
    ? decodeTextBody(body, { contentType, allowHtmlMeta: true, maxBytes: 384 * 1024 })
    : body;
  if (html === undefined || Buffer.byteLength(html, "utf8") > 384 * 1024) return undefined;
  const document = parseHtmlWithBudget(html, {
    maxInputBytes: 384 * 1024,
    maxNodes: MAX_PREVIEW_NODES,
    maxDepth: MAX_PREVIEW_DEPTH,
    maxAttributesPerTag: 256,
    maxTotalAttributes: 2_000,
  }) as unknown as ParsedNode | undefined;
  if (!document) return undefined;
  const head = findHead(document);
  if (!head) return undefined;
  const meta = new Map<string, string>();
  let documentTitle: string | undefined;
  const stack: PreviewWalkEntry[] = [{ node: head, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_PREVIEW_NODES) {
    const current = stack.pop()!;
    if (current.depth > MAX_PREVIEW_DEPTH || (current.node.tagName && BLOCKED_HEAD_TAGS.has(current.node.tagName))) continue;
    visited += 1;
    if (current.node.tagName === "title" && !documentTitle) documentTitle = textContent(current.node);
    if (current.node.tagName === "meta") {
      const attrs = Object.fromEntries((current.node.attrs ?? []).map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
      const key = (attrs.property || attrs.name || "").toLowerCase();
      if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
    }
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  const title = sanitizeText(meta.get("og:title") ?? meta.get("twitter:title") ?? documentTitle, 160);
  if (!title) return undefined;
  const displayHost = finalUrl.hostname.toLowerCase();
  const siteName = sanitizeText(meta.get("og:site_name"), 80) ?? displayHost;
  const description = sanitizeText(
    meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"),
    320,
  );
  return {
    // Keep the guest-shared URL as the click target so redirect-minted query
    // tokens are never republished, while labelling metadata with the actual
    // validated destination host that supplied it.
    url: clickUrl.toString(),
    displayHost,
    title,
    ...(description ? { description } : {}),
    siteName,
    fetchedAt: new Date().toISOString(),
  };
};

const previewPolicy = {
  timeoutMs: 7_000,
  maxRedirects: 2,
  maxBodyBytes: 384 * 1024,
  acceptedMediaTypes: ["text/html", "application/xhtml+xml"],
  acceptHeader: "text/html,application/xhtml+xml",
  userAgent: "TheThirdPlace-LinkPreview/1.1",
  stopAfterAsciiSequence: "</head>",
} as const;

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
    const request = fetchPublicHttps(url, previewPolicy)
      .then((result) => (result ? parseLinkMetadata(result.body, result.finalUrl, url, result.contentType) : undefined))
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
