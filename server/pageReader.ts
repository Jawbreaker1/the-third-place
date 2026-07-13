import type { ChatMessage } from "../shared/types.js";
import { parseHtmlWithBudget } from "./boundedHtml.js";
import { PERSONAS } from "./personas.js";
import type { ResearchPacket, ResearchResult } from "./researchBroker.js";
import {
  extractPublicHttpsUrls,
  fetchPublicHttps,
  hasStandaloneUrlBoundary,
  type SafeHttpsFetchPolicy,
  type SafeHttpsFetchResult,
} from "./safeHttpsFetch.js";

interface ParsedNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedNode[];
  content?: ParsedNode;
  value?: string;
}

export interface PageReadRequest {
  url?: URL;
  rejection?: "unsupported-url";
  requestedAt: string;
  intent: string;
  source: "message" | "reply" | "recent";
}

export interface ResolvePageReadRequestInput {
  content: string;
  requesterId: string;
  recentMessages?: readonly ChatMessage[];
  replyTarget?: ChatMessage;
  now?: number;
}

export interface ResolvePageReadBurstInput {
  messages: readonly ChatMessage[];
  requesterId: string;
  recentMessages: readonly ChatMessage[];
  replyTargetFor?: (message: ChatMessage) => ChatMessage | undefined;
  now?: number;
}

export interface ExtractedPage {
  title: string;
  text: string;
}

interface CachedRead {
  expiresAt: number;
  evidence?: PageEvidence;
}

interface PageEvidence {
  retrievedAt: string;
  result: ResearchResult;
}

type PageFetcher = (
  rawUrl: string | URL,
  policy: SafeHttpsFetchPolicy,
) => Promise<SafeHttpsFetchResult | undefined>;

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

const NEGATED_READ_REQUEST =
  /^\s*(?:(?:@[^\s,;:]+\s*[,;:]?\s+)|(?:[\p{L}\p{N}_-]{1,32}\s*[,;:]\s*))?(?:(?:snälla|please)\s+)?(?:(?:läs|kolla(?:\s+(?:på|in))?|öppna|sammanfatta|summera|granska)(?:\s+[\p{L}-]{1,20}){0,6}\s+(?:inte|aldrig)|(?:do\s+not|don['’]?t|never)\s+(?:read|check(?:\s+out)?|open|summari[sz]e|review)|(?:(?:kan|kunde|vill)\s+(?:du|ni|någon)|skulle\s+(?:du|ni|någon)\s+(?:kunna\s+)?)\s+(?:inte|aldrig)\s+(?:läsa|kolla|öppna|sammanfatta|summera|granska)|(?:(?:can|could|would|will)\s+(?:you|someone)\s+)(?:not|never)\s+(?:read|check|open|summari[sz]e|review))(?=$|[^\p{L}\p{N}_])/iu;
const START_MODAL_READ_REQUEST =
  /^\s*(?:(?:@[^\s,;:]+\s*[,;:]?\s+)|(?:[\p{L}\p{N}_-]{1,32}\s*[,;:]\s*)|(?:[\p{L}\p{N}_-]{2,32}\s+(?=(?:kan|kunde|vill|skulle|can|could|would|will)\b)))?(?:(?:snälla|please)\s+)?(?:(?:(?:kan|kunde|vill)\s+(?:du|ni|någon)|skulle\s+(?:du|ni|någon)\s+(?:kunna\s+)?|går\s+det\s+att)\s+(?:läsa|kolla(?:\s+(?:på|in))?|öppna|sammanfatta|summera|granska|se)|(?:(?:can|could|would|will)\s+(?:you|someone)\s+)(?:read|check(?:\s+out)?|open|summari[sz]e|review|see))(?=$|[^\p{L}\p{N}_])/iu;
const START_DIRECT_READ_REQUEST =
  /^\s*(?:(?:@[^\s,;:]+\s*[,;:]?\s+)|(?:[\p{L}\p{N}_-]{1,32}\s*[,;:]\s*))?(?:(?:snälla|please)\s+)?(?:(?:(?:läs|kolla(?:\s+(?:på|in))?|öppna|sammanfatta|summera|granska|read|check(?:\s+out)?|open|summari[sz]e|review)\s*[:;\-–—]?\s*(?:(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+|länk(?:en)?|sida(?:n)?|sajt(?:en)?|artikel(?:n)?|den(?:\s+här)?|det(?:\s+här|\s+där)?|följande|vad\s+som\s+står|link|page|site|article|it|this|that|the\s+(?:linked\s+)?(?:link|page|site|article))|(?:kör\s+)?webfetch|visa\s+att\s+(?:ni|du)\s+kan\s+se))(?=$|[^\p{L}\p{N}_])/iu;
const START_PAGE_QUESTION =
  /^\s*(?:(?:@[^\s,;:]+\s*[,;:]?\s+)|(?:[\p{L}\p{N}_-]{1,32}\s*[,;:]\s*))?(?:vad\s+(?:står|handlar)|vad\s+tycker\s+(?:ni|du)|kan\s+(?:ni|du)\s+se\s+vad\s+som\s+står|what\s+does|what\s+do\s+you\s+think)(?=$|[^\p{L}\p{N}_])/iu;
const FOLLOWUP_ACTION_REFERENCE =
  /(?:^|[^\p{L}\p{N}_])(?:läs(?:a|er)?|öppna|sammanfatta|summera|granska|kolla(?:\s+(?:på|in))?|read|open|summari[sz]e|review|check(?:\s+out)?)\s+(?:(?:om|på)\s+)?(?:(?:(?:den(?:\s+här)?|det(?:\s+här|\s+där)?|this|that)\s+)?(?:länk(?:en)?|sida(?:n)?|sajt(?:en)?|artikel(?:n)?|link|page|site|article)(?:\s+igen)?(?=$|[^\p{L}\p{N}_])|(?:den(?:\s+här)?|det(?:\s+här|\s+där)?|it|this|that)(?:\s+igen)?(?=\s*(?:$|[?.!,;:\-–—])))/iu;
const FOLLOWUP_CAPABILITY_REFERENCE =
  /(?:^|[^\p{L}\p{N}_])(?:(?:kan\s+(?:ni|du)\s+(?:läsa|öppna|kolla|se))|(?:visa\s+att\s+(?:ni|du)\s+kan\s+se)|(?:(?:can|could|would|will)\s+(?:you|someone)\s+(?:read|open|check(?:\s+out)?|see)))\s+(?:(?:(?:den(?:\s+här)?|det(?:\s+här|\s+där)?|this|that)\s+)?(?:länk(?:en)?|sida(?:n)?|sajt(?:en)?|artikel(?:n)?|link|page|site|article)(?=$|[^\p{L}\p{N}_])|(?:den(?:\s+här)?|det(?:\s+här|\s+där)?|it|this|that)(?=\s*(?:$|[?.!,;:\-–—])))/iu;
const FOLLOWUP_PAGE_QUESTION =
  /(?:^|[^\p{L}\p{N}_])(?:vad\s+(?:står|handlar)|vad\s+tycker\s+(?:ni|du)|what\s+does|what\s+do\s+you\s+think)[^\n]{0,80}(?:länk(?:en)?|sida(?:n)?|sajt(?:en)?|artikel(?:n)?|link|page|site|article)(?=$|[^\p{L}\p{N}_])/iu;
const EXPLICIT_WEBFETCH = /^\s*(?:kör\s+)?webfetch(?=$|[^\p{L}\p{N}_])/iu;
const LINK_LIKE_CANDIDATE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]*/iu;
const LINK_LIKE_CANDIDATE_GLOBAL = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]*/giu;
const CORRECTION_PREFIX = /^\s*(?:(?:sorry|oops|oj|ursäkta)\b[\s,;:!.\-–—]*)?(?:(?:nej|no)\b[\s,;:!.\-–—]*(?:(?:fel\s+länk(?:en)?|wrong\s+link|jag\s+menade|i\s+meant)\b[\s,;:!.\-–—]*)?|(?:fel\s+länk(?:en)?|wrong\s+link|jag\s+menade|i\s+meant)\b[\s,;:!.\-–—]*)/iu;
const BURST_CANCEL = /^(?:\s*nej\b|\s*no(?:\s*[,;:!.\-–—]|\s*$|\s+(?:wrong|stop|forget|cancel)\b)|\s*(?:glöm\s+det|forget\s+it|avbryt(?:\s+(?:den|det))?|cancel(?:\s+it)?|stopp?)\b)/iu;
const PERSONA_NAMES = [...PERSONAS].map((persona) => persona.name.toLocaleLowerCase()).sort((a, b) => b.length - a.length);

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
const CONTENT_TAGS = new Set(["h1", "h2", "h3", "p", "li", "blockquote", "pre", "figcaption"]);
const NOISE_TOKEN = /(?:^|[-_\s])(?:cookie|consent|newsletter|share|sharing|social|related|sidebar|advert|ads|promo|modal|popup|paywall)(?:$|[-_\s])/iu;

const attrsOf = (node: ParsedNode): Record<string, string> =>
  Object.fromEntries((node.attrs ?? []).map((attribute) => [attribute.name.toLocaleLowerCase(), attribute.value]));

const isHiddenOrNoise = (node: ParsedNode): boolean => {
  const attrs = attrsOf(node);
  if ("hidden" in attrs || "inert" in attrs || attrs["aria-hidden"]?.toLocaleLowerCase() === "true") return true;
  if (/\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/iu.test(attrs.style ?? "")) return true;
  const classTokens = (attrs.class ?? "").toLocaleLowerCase().split(/\s+/u);
  if (classTokens.some((token) => token === "hidden" || token === "sr-only" || token === "visually-hidden")) return true;
  return NOISE_TOKEN.test(`${attrs.id ?? ""} ${attrs.class ?? ""}`);
};

const sanitizePageText = (value: string, limit = Number.POSITIVE_INFINITY): string =>
  value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
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
    const key = cleaned.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
    if (CONTENT_TAGS.has(tagName)) {
      push(visibleText(current.node), tagName);
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
    return (attrs.property ?? attrs.name ?? "").toLocaleLowerCase() === "og:title" && Boolean(attrs.content);
  });
  const openGraphTitle = openGraph ? attrsOf(openGraph).content : undefined;
  const heading = findFirst(root, (node) => node.tagName === "h1", true);
  const title = findFirst(document, (node) => node.tagName === "title");
  return sanitizePageText(openGraphTitle ?? (heading ? visibleText(heading) : "") ?? (title ? visibleText(title) : ""), 180) ||
    sanitizePageText(title ? visibleText(title) : "", 180) ||
    undefined;
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
): ExtractedPage | undefined => {
  if (Buffer.isBuffer(body) && body.length > MAX_PAGE_INPUT_BYTES) return undefined;
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  if (!Buffer.isBuffer(body) && Buffer.byteLength(raw, "utf8") > MAX_PAGE_INPUT_BYTES) return undefined;
  if (mediaType === "text/plain") {
    const text = boundedBlocks(raw.split(/\n{2,}/u).map((block) => sanitizePageText(block)).filter(Boolean));
    if (text.length < MIN_ARTICLE_TEXT) return undefined;
    return { title: finalUrl.hostname, text };
  }
  if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") return undefined;
  const document = parseWithinBudget(raw);
  if (!document) return undefined;
  const bodyNode = findFirst(document, (node) => node.tagName === "body");
  if (!bodyNode) return undefined;
  const root = bestSemanticRoot(bodyNode) ?? bodyNode;
  let blocks = collectBlocks(root);
  if (blocks.join(" ").length < MIN_ARTICLE_TEXT) {
    const fallback = sanitizePageText(visibleText(root), MAX_ARTICLE_TEXT);
    blocks = fallback ? [fallback] : [];
  }
  const text = boundedBlocks(blocks);
  if (text.length < MIN_ARTICLE_TEXT) return undefined;
  return {
    title: pageTitle(document, root) ?? finalUrl.hostname,
    text,
  };
};

const stripKnownPersona = (value: string): string | undefined => {
  const trimmed = value.trimStart();
  const lower = trimmed.toLocaleLowerCase();
  const name = PERSONA_NAMES.find((candidate) => lower.startsWith(candidate) && /\s/u.test(trimmed[candidate.length] ?? ""));
  return name ? trimmed.slice(name.length).trimStart() : undefined;
};

const requestLineVariants = (line: string): string[] => {
  const corrected = line.replace(CORRECTION_PREFIX, "").trimStart();
  const variants = [line, ...(corrected !== line.trimStart() ? [corrected] : [])];
  for (const value of [...variants]) {
    const withoutPersona = stripKnownPersona(value);
    if (withoutPersona) variants.push(withoutPersona);
  }
  return [...new Set(variants.filter(Boolean))];
};

const hasNegatedReadRequest = (content: string): boolean =>
  content.split(/\r?\n/u).some((line) => requestLineVariants(line).some((variant) => NEGATED_READ_REQUEST.test(variant)));

const intentRequestsReading = (content: string): boolean => {
  if (hasNegatedReadRequest(content)) return false;
  return content
    .split(/\r?\n/u)
    .some((line) => requestLineVariants(line).some((variant) =>
      START_MODAL_READ_REQUEST.test(variant) ||
      START_DIRECT_READ_REQUEST.test(variant) ||
      START_PAGE_QUESTION.test(variant) ||
      EXPLICIT_WEBFETCH.test(variant),
    ));
};
const intentReferencesRecentPage = (content: string): boolean =>
  intentRequestsReading(content) &&
  (FOLLOWUP_ACTION_REFERENCE.test(content) ||
    FOLLOWUP_CAPABILITY_REFERENCE.test(content) ||
    FOLLOWUP_PAGE_QUESTION.test(content) ||
    EXPLICIT_WEBFETCH.test(content));

interface LinkCandidate {
  index: number;
  raw: string;
  url?: URL;
}

const linkCandidates = (content: string): LinkCandidate[] =>
  [...content.matchAll(LINK_LIKE_CANDIDATE_GLOBAL)].map((match) => {
    const raw = match[0] ?? "";
    // Never mine a nested HTTPS substring out of a rejected outer scheme such
    // as http://private/https://public. The entire candidate must begin with a
    // supported form before the shared validator may normalize it.
    const supportedStart = /^(?:https:\/\/|www\.)/iu.test(raw) &&
      hasStandaloneUrlBoundary(content, match.index ?? 0);
    return {
      index: match.index ?? 0,
      raw,
      url: supportedStart ? extractPublicHttpsUrls(raw, 1)[0] : undefined,
    };
  });

const candidateFromTrailingReadIntent = (
  content: string,
  candidates: readonly LinkCandidate[],
): LinkCandidate | undefined => {
  if (hasNegatedReadRequest(content)) return undefined;
  for (const candidate of candidates) {
    const trailing = content
      .slice(candidate.index + candidate.raw.length)
      .replace(/^[\s()[\]{},.;:!?\-–—]+/u, "");
    if (!intentRequestsReading(trailing)) continue;
    return linkCandidates(trailing)[0] ?? candidate;
  }
  return undefined;
};

export const declinesPageReadRequest = (content: string): boolean =>
  hasNegatedReadRequest(content) || BURST_CANCEL.test(content);

const requestForCandidate = (
  candidate: LinkCandidate,
  input: ResolvePageReadRequestInput,
  now: number,
): PageReadRequest => candidate.url
  ? {
      url: candidate.url,
      requestedAt: new Date(now).toISOString(),
      intent: input.content.slice(0, 500),
      source: "message",
    }
  : {
      rejection: "unsupported-url",
      requestedAt: new Date(now).toISOString(),
      intent: input.content.slice(0, 500),
      source: "message",
    };

export const resolvePageReadRequest = (input: ResolvePageReadRequestInput): PageReadRequest | undefined => {
  const now = input.now ?? Date.now();
  if (hasNegatedReadRequest(input.content)) return undefined;
  const lines = input.content.split(/\r?\n/u);
  const allCandidates = linkCandidates(input.content);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const candidates = linkCandidates(line);
    const explicit = intentRequestsReading(line);
    const trailing = candidateFromTrailingReadIntent(line, candidates);
    const sameLineCandidate = explicit ? candidates[0] : trailing;
    if (sameLineCandidate) return requestForCandidate(sameLineCandidate, input, now);
    if (!intentReferencesRecentPage(line)) continue;
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
      const priorCandidate = linkCandidates(lines[priorIndex] ?? "").at(-1);
      if (priorCandidate) return requestForCandidate(priorCandidate, input, now);
    }
    break;
  }
  // A link in this same message that was not paired with a request is a plain
  // paste. Never let a different line or the recent-link fallback authorize it.
  if (allCandidates.length > 0) return undefined;
  const replyCandidate = input.replyTarget ? linkCandidates(input.replyTarget.content).at(-1) : undefined;
  if (input.replyTarget && intentRequestsReading(input.content)) {
    if (replyCandidate?.url) {
      return { url: replyCandidate.url, requestedAt: new Date(now).toISOString(), intent: input.content.slice(0, 500), source: "reply" };
    }
    return replyCandidate
      ? {
          rejection: "unsupported-url",
          requestedAt: new Date(now).toISOString(),
          intent: input.content.slice(0, 500),
          source: "reply",
        }
      : undefined;
  }
  if (!intentReferencesRecentPage(input.content)) return undefined;
  let candidate: LinkCandidate | undefined;
  for (const message of [...(input.recentMessages ?? [])].reverse()) {
    if (message.authorId !== input.requesterId) continue;
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt < 0 || now - createdAt > MAX_RECENT_LINK_AGE_MS) continue;
    candidate = linkCandidates(message.content).at(-1);
    if (candidate) break;
  }
  if (!candidate) return undefined;
  return candidate.url
    ? { url: candidate.url, requestedAt: new Date(now).toISOString(), intent: input.content.slice(0, 500), source: "recent" }
    : { rejection: "unsupported-url", requestedAt: new Date(now).toISOString(), intent: input.content.slice(0, 500), source: "recent" };
};

const readerPolicy: SafeHttpsFetchPolicy = {
  timeoutMs: 8_500,
  maxRedirects: 2,
  maxBodyBytes: 1024 * 1024,
  acceptedMediaTypes: ["text/html", "application/xhtml+xml", "text/plain"],
  acceptHeader: "text/html,application/xhtml+xml,text/plain;q=0.8",
  userAgent: "TheThirdPlace-PageReader/1.0",
};

export class PageReader {
  private readonly cache = new Map<string, CachedRead>();
  private readonly inFlight = new Map<string, Promise<PageEvidence | undefined>>();
  private readonly globalTimestamps: number[] = [];
  private readonly requesterTimestamps = new Map<string, number[]>();
  private readonly originTimestamps = new Map<string, number[]>();
  private activeRequests = 0;

  constructor(private readonly fetcher: PageFetcher = fetchPublicHttps) {}

  resolveRequest(input: ResolvePageReadRequestInput): PageReadRequest | undefined {
    if (process.env.LINK_READER_ENABLED === "false") return undefined;
    return resolvePageReadRequest(input);
  }

  resolveBurst(input: ResolvePageReadBurstInput): PageReadRequest | undefined {
    if (process.env.LINK_READER_ENABLED === "false") return undefined;
    const now = input.now ?? Date.now();
    let forwardLink: LinkCandidate | undefined;
    let forwardIsCorrection = false;
    for (const message of [...input.messages].reverse()) {
      const messageIndex = input.recentMessages.findIndex((candidate) => candidate.id === message.id);
      const recentMessages = messageIndex >= 0
        ? input.recentMessages.slice(0, messageIndex + 1)
        : input.recentMessages.filter((candidate) => Date.parse(candidate.createdAt) <= Date.parse(message.createdAt));
      const replyTarget = input.replyTargetFor?.(message);
      // A bare link sent immediately after "read this" belongs to that request.
      // First preserve any explicit URL/reply on the request itself, then bind
      // the forward link before the older-history fallback can select stale data.
      if (forwardLink) {
        const selfContained = resolvePageReadRequest({
          content: message.content,
          requesterId: input.requesterId,
          recentMessages: [],
          replyTarget,
          now,
        });
        if (selfContained && !forwardIsCorrection) return selfContained;
        if (declinesPageReadRequest(message.content)) return undefined;
        if (intentReferencesRecentPage(message.content) || (forwardIsCorrection && intentRequestsReading(message.content))) {
          return requestForCandidate(forwardLink, {
            content: message.content,
            requesterId: input.requesterId,
            now,
          }, now);
        }
        if (selfContained) return selfContained;
      }
      const resolved = resolvePageReadRequest({
        content: message.content,
        requesterId: input.requesterId,
        recentMessages,
        replyTarget,
        now,
      });
      if (resolved) return resolved;
      if (declinesPageReadRequest(message.content)) return undefined;
      if (!forwardLink) {
        const candidates = linkCandidates(message.content);
        const candidate = candidates.length === 1 ? candidates[0] : undefined;
        const correction = CORRECTION_PREFIX.test(message.content);
        if (candidate) {
          const remainder = `${message.content.slice(0, candidate.index)}${message.content.slice(candidate.index + candidate.raw.length)}`
            .replace(/[\s()[\]{},.;:!?\-–—]+/gu, "");
          if (!remainder || correction) {
            forwardLink = candidate;
            forwardIsCorrection = correction;
          }
        }
        if (correction && !candidate) return undefined;
      }
    }
    return undefined;
  }

  async read(request: PageReadRequest, requesterId: string): Promise<ResearchPacket | undefined> {
    if (process.env.LINK_READER_ENABLED === "false" || !request.url) return undefined;
    const requestedUrl = request.url;
    const key = `${requesterId}\u0000${requestedUrl.toString()}`;
    this.prune();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return this.packetFor(request, cached.evidence);
    const existing = this.inFlight.get(key);
    if (existing) return existing.then((evidence) => this.packetFor(request, evidence));
    if (this.activeRequests >= 2 || !this.reserve(requesterId, requestedUrl.origin)) return undefined;
    this.activeRequests += 1;
    const pending = this.fetcher(requestedUrl, readerPolicy)
      .then((result) => {
        if (!result) return undefined;
        const extracted = extractReadablePage(result.body, result.mediaType, result.finalUrl);
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
      })
      .catch(() => undefined)
      .then((evidence) => {
        this.cache.set(key, { evidence, expiresAt: Date.now() + (evidence ? 20 * 60_000 : 90_000) });
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

  private packetFor(request: PageReadRequest, evidence?: PageEvidence): ResearchPacket | undefined {
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
