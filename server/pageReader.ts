import type { ChatMessage } from "../shared/types.js";
import { findUrlTextCandidates, hasRecognizedPublicSuffix } from "../shared/unicodeBoundaries.js";
import { stripDangerousTextControls, unicodeCaselessKey } from "../shared/unicodeSafety.js";
import { parseHtmlWithBudget } from "./boundedHtml.js";
import {
  defaultPageProviderRegistry,
  type PageProviderEvidence,
  type PageProviderFetcher,
  type PageProviderRegistry,
} from "./pageProviders/index.js";
import type { ResearchPacket } from "./researchBroker.js";
import { decodeTextBody } from "./textBodyDecoder.js";
import {
  extractPublicHttpsUrls,
  fetchPublicHttps,
  hasStandaloneUrlBoundary,
  type SafeHttpsFetchPolicy,
} from "./safeHttpsFetch.js";

interface ParsedNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedNode[];
  content?: ParsedNode;
  value?: string;
}

export type PageReadInitiator = "explicit" | "automatic";

export interface PageReadRequest {
  url?: URL;
  rejection?: "unsupported-url";
  requestedAt: string;
  intent: string;
  retry: boolean;
  source: "message" | "reply" | "recent";
  /** Defaults to explicit so existing human-requested reads retain their behavior. */
  initiator?: PageReadInitiator;
}

export type PageReadCandidateId = `U${number}`;

export interface PageReadCandidate {
  id: PageReadCandidateId;
  raw: string;
  url?: URL;
  supported: boolean;
  source: "message" | "reply" | "recent";
  messageId: string;
  authorId: string;
  createdAt: string;
}

export interface PageReadCandidateSet {
  requestedAt: string;
  candidates: readonly PageReadCandidate[];
}

export interface CollectPageReadCandidatesInput {
  messages: readonly ChatMessage[];
  requesterId: string;
  recentMessages?: readonly ChatMessage[];
  replyTargetFor?: (message: ChatMessage) => ChatMessage | undefined;
  now?: number;
}

export interface ResolvePageReadTargetInput {
  candidateSet: PageReadCandidateSet;
  targetRef: PageReadCandidateId | string;
  intent: string;
  retry?: boolean;
}

export interface ExtractedPage {
  title: string;
  text: string;
}

interface CachedRead {
  expiresAt: number;
  evidence?: PageProviderEvidence;
}

const MAX_RECENT_LINK_AGE_MS = 5 * 60_000;
const MAX_ARTICLE_TEXT = 10_000;
const MAX_ARTICLE_BLOCKS = 96;
const MIN_ARTICLE_TEXT = 80;
const MAX_TRAVERSAL_NODES = 25_000;
const MAX_TRAVERSAL_DEPTH = 96;
const MAX_SEMANTIC_CANDIDATES = 64;
const MAX_PAGE_INPUT_BYTES = 1024 * 1024;
const MAX_PARSE_NODES = 20_000;
const MAX_PARSE_DEPTH = 128;
// Unicode labels are valid input to WHATWG URL and are canonicalized to
// Punycode by the shared HTTPS validator. Limiting bare hosts to ASCII would
// silently make link handling language-dependent even though explicit HTTPS
// URLs already support internationalized domains.
const BARE_PUBLIC_DOMAIN = /(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?\.)+(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}]{1,62}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/iu;
const BARE_PUBLIC_DOMAIN_FULL = new RegExp(`^${BARE_PUBLIC_DOMAIN.source}$`, "iu");
const LINK_LIKE_CANDIDATE_GLOBAL = new RegExp(
  `(?:[a-z][a-z0-9+.-]*:\\/\\/|www\\.)[^\\s<>"'\u0060]*|${BARE_PUBLIC_DOMAIN.source}`,
  "giu",
);

const BLOCKED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "dialog",
]);
const CONTENT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre", "figcaption"]);
const attrsOf = (node: ParsedNode): Record<string, string> =>
  Object.fromEntries((node.attrs ?? []).map((attribute) => [attribute.name.toLowerCase(), attribute.value]));

const isHiddenOrNoise = (node: ParsedNode): boolean => {
  const attrs = attrsOf(node);
  if ("hidden" in attrs || "inert" in attrs || attrs["aria-hidden"]?.toLowerCase() === "true") return true;
  if (/\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/iu.test(attrs.style ?? "")) return true;
  return false;
};

const sanitizePageText = (value: string, limit = Number.POSITIVE_INFINITY): string =>
  stripDangerousTextControls(value.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);

interface WalkEntry {
  node: ParsedNode;
  depth: number;
}

const childEntries = (node: ParsedNode, depth: number): WalkEntry[] =>
  (node.childNodes ?? []).map((child) => ({ node: child, depth })).reverse();

const findFirst = (
  root: ParsedNode,
  predicate: (candidate: ParsedNode) => boolean,
  visibleOnly = false,
): ParsedNode | undefined => {
  const stack: WalkEntry[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_TRAVERSAL_NODES) {
    const current = stack.pop()!;
    if (current.depth > MAX_TRAVERSAL_DEPTH) continue;
    visited += 1;
    if (visibleOnly && ((current.node.tagName && BLOCKED_TAGS.has(current.node.tagName)) || isHiddenOrNoise(current.node))) {
      continue;
    }
    if (predicate(current.node)) return current.node;
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  return undefined;
};

const visibleText = (root: ParsedNode, maxLength = 4_000): string => {
  const stack: WalkEntry[] = [{ node: root, depth: 0 }];
  const parts: string[] = [];
  let visited = 0;
  let length = 0;
  while (stack.length > 0 && visited < MAX_TRAVERSAL_NODES && length < maxLength) {
    const current = stack.pop()!;
    if (current.depth > MAX_TRAVERSAL_DEPTH) continue;
    visited += 1;
    if ((current.node.tagName && BLOCKED_TAGS.has(current.node.tagName)) || isHiddenOrNoise(current.node)) continue;
    if (current.node.nodeName === "#text") {
      const value = current.node.value ?? "";
      if (value) {
        const clipped = value.slice(0, maxLength - length);
        parts.push(clipped);
        length += clipped.length;
      }
      continue;
    }
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  return parts.join(" ");
};

const collectBlocks = (root: ParsedNode): string[] => {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string, tagName = ""): void => {
    const cleaned = sanitizePageText(raw, 2_000);
    const minimum = tagName.startsWith("h") ? 2 : tagName === "li" ? 12 : 24;
    const key = unicodeCaselessKey(cleaned).replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
    if (cleaned.length < minimum || !key || seen.has(key)) return;
    seen.add(key);
    blocks.push(cleaned);
  };
  const stack: WalkEntry[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_TRAVERSAL_NODES && blocks.length < MAX_ARTICLE_BLOCKS) {
    const current = stack.pop()!;
    if (current.depth > MAX_TRAVERSAL_DEPTH) continue;
    visited += 1;
    const tagName = current.node.tagName ?? "";
    if ((tagName && BLOCKED_TAGS.has(tagName)) || isHiddenOrNoise(current.node)) continue;
    const attrs = attrsOf(current.node);
    const headlineLike =
      attrs.role?.toLowerCase() === "heading" ||
      /(?:^|\s)(?:headline|name)(?:\s|$)/iu.test((attrs.itemprop ?? "").toLowerCase());
    if (CONTENT_TAGS.has(tagName) || headlineLike) {
      push(visibleText(current.node), headlineLike ? "h4" : tagName);
      continue;
    }
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  return blocks;
};

interface SemanticCandidate {
  node: ParsedNode;
  textLength: number;
  kind: "article" | "main" | "role-main";
  parentCandidate?: number;
}

const bestSemanticRoot = (body: ParsedNode): ParsedNode | undefined => {
  type SemanticWalkEntry = WalkEntry & { exitCandidate?: number };
  const stack: SemanticWalkEntry[] = [{ node: body, depth: 0 }];
  const candidates: SemanticCandidate[] = [];
  const activeCandidates: number[] = [];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_TRAVERSAL_NODES) {
    const current = stack.pop()!;
    if (current.exitCandidate !== undefined) {
      const index = activeCandidates.lastIndexOf(current.exitCandidate);
      if (index >= 0) activeCandidates.splice(index, 1);
      continue;
    }
    if (current.depth > MAX_TRAVERSAL_DEPTH) continue;
    visited += 1;
    if ((current.node.tagName && BLOCKED_TAGS.has(current.node.tagName)) || isHiddenOrNoise(current.node)) continue;
    if (current.node.nodeName === "#text") {
      const length = Math.min((current.node.value ?? "").length, MAX_ARTICLE_TEXT * 2);
      for (const index of activeCandidates) {
        const candidate = candidates[index];
        if (candidate) candidate.textLength = Math.min(MAX_ARTICLE_TEXT * 2, candidate.textLength + length);
      }
      continue;
    }
    const attrs = attrsOf(current.node);
    const tagName = current.node.tagName ?? "";
    const kind = tagName === "article" ? "article" : tagName === "main" ? "main" : attrs.role === "main" ? "role-main" : undefined;
    let candidateIndex: number | undefined;
    if (kind && candidates.length < MAX_SEMANTIC_CANDIDATES) {
      candidateIndex = candidates.push({
        node: current.node,
        textLength: 0,
        kind,
        ...(activeCandidates.at(-1) !== undefined ? { parentCandidate: activeCandidates.at(-1) } : {}),
      }) - 1;
      activeCandidates.push(candidateIndex);
      stack.push({ node: current.node, depth: current.depth, exitCandidate: candidateIndex });
    }
    stack.push(...childEntries(current.node, current.depth + 1));
  }
  const sufficient = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.textLength >= MIN_ARTICLE_TEXT);
  const main = sufficient
    .filter(({ candidate }) => candidate.kind === "main" || candidate.kind === "role-main")
    .sort((a, b) => b.candidate.textLength - a.candidate.textLength)[0];
  if (main) {
    const isInsideMain = (entry: { candidate: SemanticCandidate; index: number }): boolean => {
      let parent = entry.candidate.parentCandidate;
      while (parent !== undefined) {
        if (parent === main.index) return true;
        parent = candidates[parent]?.parentCandidate;
      }
      return false;
    };
    const nestedArticle = sufficient
      .filter((entry) => entry.candidate.kind === "article" && isInsideMain(entry))
      .sort((a, b) => b.candidate.textLength - a.candidate.textLength)[0]?.candidate;
    const articleThreshold = Math.max(MIN_ARTICLE_TEXT, Math.min(1_200, main.candidate.textLength * 0.3));
    return nestedArticle && nestedArticle.textLength >= articleThreshold ? nestedArticle.node : main.candidate.node;
  }
  return sufficient
    .filter(({ candidate }) => candidate.kind === "article")
    .sort((a, b) => b.candidate.textLength - a.candidate.textLength)[0]?.candidate.node;
};

const pageTitle = (document: ParsedNode, root: ParsedNode): string | undefined => {
  const openGraph = findFirst(document, (node) => {
    if (node.tagName !== "meta") return false;
    const attrs = attrsOf(node);
    return (attrs.property ?? attrs.name ?? "").toLowerCase() === "og:title" && Boolean(attrs.content);
  });
  const openGraphTitle = openGraph ? attrsOf(openGraph).content : undefined;
  const heading = findFirst(root, (node) => node.tagName === "h1", true);
  const title = findFirst(document, (node) => node.tagName === "title");
  return sanitizePageText(openGraphTitle ?? (heading ? visibleText(heading) : "") ?? (title ? visibleText(title) : ""), 180) ||
    sanitizePageText(title ? visibleText(title) : "", 180) ||
    undefined;
};

const pageDescription = (document: ParsedNode): string | undefined => {
  const preferred = ["og:description", "description", "twitter:description"];
  for (const key of preferred) {
    const node = findFirst(document, (candidate) => {
      if (candidate.tagName !== "meta") return false;
      const attrs = attrsOf(candidate);
      return (attrs.property ?? attrs.name ?? "").toLowerCase() === key && Boolean(attrs.content);
    });
    const description = node ? sanitizePageText(attrsOf(node).content ?? "", MAX_ARTICLE_TEXT) : "";
    if (description.length >= MIN_ARTICLE_TEXT) return description;
  }
  return undefined;
};

const metadataPageFromHead = (raw: string, finalUrl: URL): ExtractedPage | undefined => {
  // This is an HTML structure boundary, never a natural-language classifier.
  const closingHead = /<\/head\s*>/iu.exec(raw);
  if (!closingHead) return undefined;
  const headDocument = parseWithinBudget(raw.slice(0, closingHead.index + closingHead[0].length));
  if (!headDocument) return undefined;
  const text = pageDescription(headDocument);
  if (!text) return undefined;
  return {
    title: pageTitle(headDocument, headDocument) ?? finalUrl.hostname,
    text,
  };
};

const boundedBlocks = (blocks: readonly string[], maxLength = MAX_ARTICLE_TEXT): string => {
  const accepted: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const separator = accepted.length > 0 ? 2 : 0;
    if (length + separator + block.length <= maxLength) {
      accepted.push(block);
      length += separator + block.length;
      continue;
    }
    const remaining = maxLength - length - separator;
    if (remaining > 0) accepted.push(block.slice(0, remaining).trim());
    break;
  }
  return accepted.filter(Boolean).join("\n\n");
};

const parseWithinBudget = (raw: string): ParsedNode | undefined => {
  return parseHtmlWithBudget(raw, {
    maxInputBytes: MAX_PAGE_INPUT_BYTES,
    maxNodes: MAX_PARSE_NODES,
    maxDepth: MAX_PARSE_DEPTH,
    maxAttributesPerTag: 512,
    maxTotalAttributes: 4_000,
  }) as unknown as ParsedNode | undefined;
};

export const htmlWithinParseBudget = (raw: string): boolean => Boolean(parseWithinBudget(raw));

export const extractReadablePage = (
  body: Buffer | string,
  mediaType: string,
  finalUrl: URL,
  contentType = mediaType,
): ExtractedPage | undefined => {
  if (Buffer.isBuffer(body) && body.length > MAX_PAGE_INPUT_BYTES) return undefined;
  const raw = Buffer.isBuffer(body)
    ? decodeTextBody(body, {
        contentType,
        allowHtmlMeta: mediaType === "text/html" || mediaType === "application/xhtml+xml",
        maxBytes: MAX_PAGE_INPUT_BYTES,
      })
    : body;
  if (raw === undefined) return undefined;
  if (!Buffer.isBuffer(body) && Buffer.byteLength(raw, "utf8") > MAX_PAGE_INPUT_BYTES) return undefined;
  if (mediaType === "text/plain") {
    const text = boundedBlocks(raw.split(/\n{2,}/u).map((block) => sanitizePageText(block)).filter(Boolean));
    if (text.length < MIN_ARTICLE_TEXT) return undefined;
    return { title: finalUrl.hostname, text };
  }
  if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") return undefined;
  const document = parseWithinBudget(raw);
  if (!document) return metadataPageFromHead(raw, finalUrl);
  const bodyNode = findFirst(document, (node) => node.tagName === "body");
  const root = bodyNode ? (bestSemanticRoot(bodyNode) ?? bodyNode) : document;
  let blocks = collectBlocks(root);
  if (blocks.join(" ").length < MIN_ARTICLE_TEXT) {
    const fallback = sanitizePageText(visibleText(root), MAX_ARTICLE_TEXT);
    blocks = fallback ? [fallback] : [];
  }
  const extractedText = boundedBlocks(blocks);
  const text = extractedText.length >= MIN_ARTICLE_TEXT
    ? extractedText
    : pageDescription(document);
  if (!text) return undefined;
  return {
    title: pageTitle(document, root) ?? finalUrl.hostname,
    text,
  };
};

interface LinkCandidate {
  index: number;
  raw: string;
  url?: URL;
}

const linkCandidates = (content: string): LinkCandidate[] =>
  [...content.matchAll(LINK_LIKE_CANDIDATE_GLOBAL)].flatMap((match): LinkCandidate[] => {
    const raw = match[0] ?? "";
    // Never mine a nested HTTPS substring out of a rejected outer scheme such
    // as http://private/https://public. The entire candidate must begin with a
    // supported form before the shared validator may normalize it.
    const standalone = hasStandaloneUrlBoundary(content, match.index ?? 0);
    const explicitForm = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(raw);
    if (!standalone) return explicitForm ? [{ index: match.index ?? 0, raw }] : [];
    const supportedStart = /^(?:https:\/\/|www\.)/iu.test(raw) && standalone;
    const bareDomain = BARE_PUBLIC_DOMAIN_FULL.test(raw);
    const url = supportedStart
      ? extractPublicHttpsUrls(raw, 1)[0]
      : bareDomain
        ? extractPublicHttpsUrls(`https://${raw}`, 1)[0]
        : undefined;
    // A scheme-less dotted token inside prose is otherwise indistinguishable
    // from a sentence boundary. Require a registry-backed suffix; explicit
    // HTTPS remains available for reserved or newly delegated IDNs.
    if (bareDomain) {
      const rawAuthority = raw.split(/[/?#]/u, 1)[0] ?? "";
      const structural = findUrlTextCandidates(`https://${raw}`, { allowHttp: false, allowWww: false, limit: 1 })[0];
      const structuralAuthority = structural?.value.slice("https://".length).split(/[/?#]/u, 1)[0];
      if (
        !url ||
        !hasRecognizedPublicSuffix(url.hostname) ||
        !structuralAuthority ||
        structuralAuthority !== rawAuthority
      ) return [];
    }
    return [{
      index: match.index ?? 0,
      raw,
      url,
    }];
  });

const candidateMessages = (
  input: CollectPageReadCandidatesInput,
  now: number,
): Array<{ message: ChatMessage; source: PageReadCandidate["source"] }> => {
  const selected: Array<{ message: ChatMessage; source: PageReadCandidate["source"] }> = [];
  const currentIds = new Set(input.messages.map((message) => message.id));
  const replyIds = new Set<string>();

  // Newest burst content comes first so U1 is normally the URL the user just
  // supplied. This is ordering only; choosing whether it should be read is the
  // semantic router's job.
  for (const message of [...input.messages].reverse()) selected.push({ message, source: "message" });
  for (const message of [...input.messages].reverse()) {
    const reply = input.replyTargetFor?.(message);
    if (!reply || currentIds.has(reply.id) || replyIds.has(reply.id)) continue;
    replyIds.add(reply.id);
    selected.push({ message: reply, source: "reply" });
  }
  for (const message of [...(input.recentMessages ?? [])].reverse()) {
    if (message.authorId !== input.requesterId || currentIds.has(message.id) || replyIds.has(message.id)) continue;
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt < 0 || now - createdAt > MAX_RECENT_LINK_AGE_MS) continue;
    selected.push({ message, source: "recent" });
  }
  return selected;
};

const messageLinkCandidates = (message: ChatMessage): LinkCandidate[] => {
  const visible = [...linkCandidates(message.content)].reverse();
  const seen = new Set(visible.map((candidate) => candidate.url?.toString() ?? candidate.raw));
  const attachedUrls = [
    ...(message.linkPreview ? [message.linkPreview.url] : []),
    ...(message.sources ?? []).map((source) => source.url),
  ];
  for (const attachedUrl of attachedUrls) {
    // Metadata is server-attached, but it still crosses the persisted-store
    // boundary. Run it through the exact same URL parser and safe reader path.
    const candidate = linkCandidates(attachedUrl).find((item) => item.url?.toString() === attachedUrl);
    if (!candidate) continue;
    const key = candidate.url?.toString() ?? candidate.raw;
    if (seen.has(key)) continue;
    seen.add(key);
    visible.push(candidate);
  }
  return visible;
};

export const collectPageReadCandidates = (input: CollectPageReadCandidatesInput): PageReadCandidateSet => {
  const now = input.now ?? Date.now();
  const candidates = candidateMessages(input, now)
    .flatMap(({ message, source }) => messageLinkCandidates(message).map((candidate) => ({
      raw: candidate.raw.slice(0, 500),
      ...(candidate.url ? { url: candidate.url } : {}),
      supported: Boolean(candidate.url),
      source,
      messageId: message.id,
      authorId: message.authorId,
      createdAt: message.createdAt,
    })))
    .slice(0, 12)
    .map((candidate, index): PageReadCandidate => ({
      id: `U${index + 1}`,
      ...candidate,
    }));
  return { requestedAt: new Date(now).toISOString(), candidates };
};

export const resolvePageReadTarget = (input: ResolvePageReadTargetInput): PageReadRequest | undefined => {
  const candidate = input.candidateSet.candidates.find((item) => item.id === input.targetRef);
  if (!candidate) return undefined;
  const intent = sanitizePageText(input.intent, 500);
  const base = {
    requestedAt: input.candidateSet.requestedAt,
    intent,
    retry: input.retry === true,
    source: candidate.source,
  } as const;
  return candidate.url
    ? { ...base, url: candidate.url }
    : { ...base, rejection: "unsupported-url" };
};

const readerPolicy: SafeHttpsFetchPolicy = {
  timeoutMs: 8_500,
  maxRedirects: 2,
  maxBodyBytes: 1024 * 1024,
  acceptedMediaTypes: ["text/html", "application/xhtml+xml", "text/plain"],
  acceptHeader: "text/html,application/xhtml+xml,text/plain;q=0.8",
  userAgent: "TheThirdPlace-PageReader/1.0",
  oversizedHtmlHeadFallback: true,
};

export class PageReader {
  private readonly cache = new Map<string, CachedRead>();
  private readonly inFlight = new Map<string, Promise<PageProviderEvidence | undefined>>();
  private readonly globalTimestamps: number[] = [];
  private readonly requesterTimestamps = new Map<string, number[]>();
  private readonly originTimestamps = new Map<string, number[]>();
  private activeRequests = 0;

  constructor(
    private readonly fetcher: PageProviderFetcher = fetchPublicHttps,
    private readonly providers: PageProviderRegistry = defaultPageProviderRegistry,
  ) {}

  collectCandidates(input: CollectPageReadCandidatesInput): PageReadCandidateSet {
    if (process.env.LINK_READER_ENABLED === "false") {
      return { requestedAt: new Date(input.now ?? Date.now()).toISOString(), candidates: [] };
    }
    return collectPageReadCandidates(input);
  }

  resolveTarget(input: ResolvePageReadTargetInput): PageReadRequest | undefined {
    if (process.env.LINK_READER_ENABLED === "false") return undefined;
    return resolvePageReadTarget(input);
  }

  async read(request: PageReadRequest, requesterId: string): Promise<ResearchPacket | undefined> {
    if (process.env.LINK_READER_ENABLED === "false" || !request.url) return undefined;
    const requestedUrl = request.url;
    const initiator = request.initiator ?? "explicit";
    const key = `${initiator}\u0000${requesterId}\u0000${requestedUrl.toString()}`;
    this.prune();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.evidence || !request.retry) return this.packetFor(request, cached.evidence);
      this.cache.delete(key);
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing.then((evidence) => this.packetFor(request, evidence));
    if (this.activeRequests >= 2 || !this.reserve(requesterId, requestedUrl.origin)) return undefined;
    this.activeRequests += 1;
    const provider = this.providers.supporting(requestedUrl);
    const fetcher: PageProviderFetcher = initiator === "automatic"
      ? (rawUrl, policy) => this.fetcher(rawUrl, {
          ...policy,
          sameOriginRedirectsOnly: true,
          allowCanonicalWwwRedirect: true,
        })
      : this.fetcher;
    const evidenceRequest: Promise<PageProviderEvidence | undefined> = provider
      ? provider.read({ fetcher, requestedUrl })
      : fetcher(requestedUrl, readerPolicy).then((result) => {
        if (!result) return undefined;
        const extracted = extractReadablePage(result.body, result.mediaType, result.finalUrl, result.contentType);
        if (!extracted) return undefined;
        return {
          retrievedAt: new Date().toISOString(),
          result: {
            id: "S1",
            title: extracted.title,
            url: requestedUrl.toString(),
            snippet: extracted.text,
          },
        };
      });
    const pending = evidenceRequest
      .catch(() => undefined)
      .then((evidence) => {
        this.cache.set(key, { evidence, expiresAt: Date.now() + (evidence?.cacheTtlMs ?? (evidence ? 20 * 60_000 : 90_000)) });
        return evidence;
      })
      .finally(() => {
        this.activeRequests -= 1;
        this.inFlight.delete(key);
        this.prune();
      });
    this.inFlight.set(key, pending);
    return pending.then((evidence) => this.packetFor(request, evidence));
  }

  private packetFor(request: PageReadRequest, evidence?: PageProviderEvidence): ResearchPacket | undefined {
    return evidence
      ? {
          kind: "page",
          query: request.intent.slice(0, 160),
          retrievedAt: evidence.retrievedAt,
          results: [{ ...evidence.result }],
        }
      : undefined;
  }

  private reserve(requesterId: string, origin: string): boolean {
    const now = Date.now();
    const trim = (timestamps: number[]): void => {
      while (timestamps[0] && now - timestamps[0] > 60_000) timestamps.shift();
    };
    trim(this.globalTimestamps);
    const requester = this.requesterTimestamps.get(requesterId) ?? [];
    const originRequests = this.originTimestamps.get(origin) ?? [];
    trim(requester);
    trim(originRequests);
    if (this.globalTimestamps.length >= 8 || requester.length >= 2 || originRequests.length >= 2) return false;
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
    while (this.cache.size > 100) {
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
