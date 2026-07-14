import { parse as parseDomain } from "tldts";
import { unicodeCaselessKey } from "./unicodeSafety.js";

export interface UrlTextCandidate {
  /** Candidate text after removing surrounding sentence punctuation. */
  value: string;
  /** UTF-16 offsets into the original string. */
  start: number;
  end: number;
  /** End of the broad match, including punctuation left for display. */
  rawEnd: number;
}

export interface FindUrlTextCandidatesOptions {
  allowHttp?: boolean;
  allowWww?: boolean;
  limit?: number;
}

export interface ExactMentionRange {
  value: string;
  name: string;
  start: number;
  end: number;
}

// Unicode defines this property independently of any particular language. It
// covers sentence punctuation such as ASCII/fullwidth stops, Arabic comma and
// question marks, Armenian/Indic stops, and their peers without a phrase list.
const TERMINAL_PUNCTUATION = /\p{Terminal_Punctuation}/u;
const FINAL_QUOTE = /\p{Pf}/u;
const UNICODE_PUNCTUATION = /\p{P}/u;
const MAX_URL_TEXT_CANDIDATE = 4_096;
// A DNS label is at most 63 octets after IDNA conversion. A valid endpoint for
// the contaminated final label therefore cannot require thousands of PSL
// probes even when an attacker appends a very long no-space token.
const MAX_DNS_LABEL_CODE_POINTS = 63;

// Paired closers need a little more care: a balanced ')' may legitimately be
// part of a URL path, while a wrapper around the URL must remain ordinary text.
// This is structural Unicode punctuation data, not natural-language intent.
const OPENING_FOR_CLOSER = new Map<string, string>([
  [")", "("], ["]", "["], ["}", "{"],
  ["\u0f3b", "\u0f3a"], ["\u0f3d", "\u0f3c"],
  ["\u169c", "\u169b"], ["\u2046", "\u2045"],
  ["\u207e", "\u207d"], ["\u208e", "\u208d"],
  ["\u2309", "\u2308"], ["\u230b", "\u230a"],
  ["\u232a", "\u2329"], ["\u2769", "\u2768"],
  ["\u276b", "\u276a"], ["\u276d", "\u276c"],
  ["\u276f", "\u276e"], ["\u2771", "\u2770"],
  ["\u2773", "\u2772"], ["\u2775", "\u2774"],
  ["\u27c6", "\u27c5"], ["\u27e7", "\u27e6"],
  ["\u27e9", "\u27e8"], ["\u27eb", "\u27ea"],
  ["\u27ed", "\u27ec"], ["\u27ef", "\u27ee"],
  ["\u2984", "\u2983"], ["\u2986", "\u2985"],
  ["\u2988", "\u2987"], ["\u298a", "\u2989"],
  ["\u298c", "\u298b"], ["\u298e", "\u298d"],
  ["\u2990", "\u298f"], ["\u2992", "\u2991"],
  ["\u2994", "\u2993"], ["\u2996", "\u2995"],
  ["\u2998", "\u2997"], ["\u29d9", "\u29d8"],
  ["\u29db", "\u29da"], ["\u29fd", "\u29fc"],
  ["\u2e23", "\u2e22"], ["\u2e25", "\u2e24"],
  ["\u2e27", "\u2e26"], ["\u2e29", "\u2e28"],
  ["\u3009", "\u3008"], ["\u300b", "\u300a"],
  ["\u300d", "\u300c"], ["\u300f", "\u300e"],
  ["\u3011", "\u3010"], ["\u3015", "\u3014"],
  ["\u3017", "\u3016"], ["\u3019", "\u3018"],
  ["\u301b", "\u301a"], ["\ufe5a", "\ufe59"],
  ["\ufe5c", "\ufe5b"], ["\ufe5e", "\ufe5d"],
  ["\uff09", "\uff08"], ["\uff3d", "\uff3b"],
  ["\uff5d", "\uff5b"], ["\uff60", "\uff5f"],
  ["\uff63", "\uff62"],
]);

const countCodePoint = (value: string, target: string): number => {
  let count = 0;
  for (const codePoint of value) if (codePoint === target) count += 1;
  return count;
};

export const trimTrailingUrlPunctuation = (raw: string): string => {
  let value = raw;
  while (value) {
    const codePoints = [...value];
    const trailing = codePoints.at(-1);
    if (!trailing) break;
    // Non-ASCII punctuation cannot be a public DNS label delimiter. Leaving
    // it attached lets WHATWG/UTS-46 reinterpret some marks as part of a
    // different Punycode host, so keep it outside the clickable/fetchable URL.
    if (
      TERMINAL_PUNCTUATION.test(trailing) ||
      FINAL_QUOTE.test(trailing) ||
      (trailing.codePointAt(0)! > 0x7f && UNICODE_PUNCTUATION.test(trailing))
    ) {
      value = value.slice(0, -trailing.length);
      continue;
    }
    const opening = OPENING_FOR_CLOSER.get(trailing);
    if (opening && countCodePoint(value, trailing) > countCodePoint(value, opening)) {
      value = value.slice(0, -trailing.length);
      continue;
    }
    break;
  }
  return value;
};

const urlAuthorityRange = (value: string): { start: number; end: number; parsePrefix: string } | undefined => {
  const lower = value.toLocaleLowerCase();
  const schemeSeparator = lower.indexOf("://");
  const start = schemeSeparator >= 0
    ? schemeSeparator + 3
    : lower.startsWith("www.")
      ? 0
      : -1;
  if (start < 0) return undefined;
  let end = value.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = value.indexOf(delimiter, start);
    if (index >= 0) end = Math.min(end, index);
  }
  return { start, end, parsePrefix: schemeSeparator >= 0 ? "" : "https://" };
};

export const hasRecognizedPublicSuffix = (rawHostname: string): boolean => {
  const hostname = rawHostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (!hostname || !hostname.includes(".")) return false;
  const parsed = parseDomain(hostname, {
    allowIcannDomains: true,
    allowPrivateDomains: true,
    extractHostname: false,
    validateHostname: true,
  });
  return Boolean((parsed.isIcann || parsed.isPrivate) && parsed.domain);
};

const DOTTED_HOST_TOKEN = /(?:[\p{L}\p{M}\p{N}-]+\.)+[\p{L}\p{M}\p{N}-]+/gu;

/** Structural URL-output guard shared by model contracts and persistence. */
export const containsVisibleUrlText = (value: string): boolean => {
  if (/(?:[a-z][a-z\d+.-]*:\/\/|www\.)/iu.test(value)) return true;
  for (const match of value.matchAll(DOTTED_HOST_TOKEN)) {
    const hostname = match[0];
    const next = value[(match.index ?? 0) + hostname.length];
    if (next && "/?#:".includes(next)) return true;
    if (hasRecognizedPublicSuffix(hostname)) return true;
  }
  return false;
};

const hasKnownPublicSuffix = (rawUrl: string, parsePrefix: string): boolean => {
  try {
    return hasRecognizedPublicSuffix(new URL(`${parsePrefix}${rawUrl}`).hostname);
  } catch {
    return false;
  }
};

/**
 * A no-space suffix can otherwise be folded into the final IDN label by
 * WHATWG/UTS-46 (for example `example.com` + `ニュース`). The public suffix
 * list gives us a language-neutral structural endpoint. Paths, queries and
 * fragments are deliberately outside this authority-only scan.
 */
const trimNoSpaceAuthoritySuffix = (value: string): string => {
  const range = urlAuthorityRange(value);
  if (!range) return value;
  const authority = value.slice(range.start, range.end);
  if (!/[^\x00-\x7f]/u.test(authority) || !authority.includes(".")) return value;
  if (hasKnownPublicSuffix(value.slice(0, range.end), range.parsePrefix)) return value;

  const finalLabelOffset = authority.lastIndexOf(".") + 1;
  const finalLabel = authority.slice(finalLabelOffset);
  const boundaries: number[] = [];
  let offset = range.start + finalLabelOffset;
  for (const codePoint of [...finalLabel].slice(0, MAX_DNS_LABEL_CODE_POINTS)) {
    offset += codePoint.length;
    boundaries.push(offset);
  }
  // The full authority was already checked. Scan only possible endpoints in
  // its final DNS label and keep the longest PSL-recognized prefix.
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const endpoint = boundaries[index]!;
    if (!hasKnownPublicSuffix(value.slice(0, endpoint), range.parsePrefix)) continue;
    return `${value.slice(0, endpoint)}${value.slice(range.end)}`;
  }

  // Reserved/new ASCII suffixes are intentionally not all in the PSL. A
  // transition after a complete ASCII DNS-shaped host is still unambiguous;
  // a transition inside an IDN is left untouched unless PSL data resolved it.
  const firstNonAscii = [...authority].findIndex((codePoint) => codePoint.codePointAt(0)! > 0x7f);
  if (firstNonAscii > 0) {
    const asciiPrefixLength = [...authority].slice(0, firstNonAscii).join("").length;
    const endpoint = range.start + asciiPrefixLength;
    try {
      const parsed = new URL(`${range.parsePrefix}${value.slice(0, endpoint)}`);
      const labels = parsed.hostname.split(".");
      if (
        parsed.hostname.includes(".") &&
        labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)) &&
        (labels.at(-1)?.length ?? 0) >= 2
      ) {
        return `${value.slice(0, endpoint)}${value.slice(range.end)}`;
      }
    } catch {
      // Leave an ambiguous or structurally invalid authority inert.
    }
  }
  return value;
};

const isAsciiEmbeddingCharacter = (value: string | undefined): boolean =>
  Boolean(value && /[A-Za-z0-9_@./\\-]/u.test(value));

export const hasStandaloneUrlStartBoundary = (content: string, index: number): boolean => {
  if (index < 0 || index > content.length) return false;
  // No-space writing systems may naturally touch an ASCII URL. Only ASCII
  // token characters can turn the match into part of another ASCII token.
  if (isAsciiEmbeddingCharacter(content[index - 1])) return false;

  let containerStart = index;
  while (containerStart > 0 && !/\s/u.test(content[containerStart - 1] ?? "")) containerStart -= 1;
  const prefix = content.slice(containerStart, index);
  // Do not extract an HTTPS-looking substring from another URI scheme.
  return !/[a-z][a-z0-9+.-]*:[^\s]*$/iu.test(prefix);
};

export const findUrlTextCandidates = (
  content: string,
  options: FindUrlTextCandidatesOptions = {},
): UrlTextCandidate[] => {
  const allowHttp = options.allowHttp ?? false;
  const allowWww = options.allowWww ?? true;
  const starts = ["https:\\/\\/"];
  if (allowHttp) starts.push("http:\\/\\/");
  if (allowWww) starts.push("www\\.");
  const pattern = new RegExp(`(?:${starts.join("|")})[^\\s<>\"'\\x60]+`, "giu");
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  const results: UrlTextCandidate[] = [];

  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (!hasStandaloneUrlStartBoundary(content, start)) continue;
    const raw = match[0] ?? "";
    if (raw.length > MAX_URL_TEXT_CANDIDATE) continue;
    const value = trimNoSpaceAuthoritySuffix(trimTrailingUrlPunctuation(raw));
    if (!value) continue;
    results.push({ value, start, end: start + value.length, rawEnd: start + raw.length });
    if (results.length >= limit) break;
  }
  return results;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const maskUrlRanges = (content: string): string => {
  const ranges = findUrlTextCandidates(content, { allowHttp: true, allowWww: true, limit: 100 });
  if (ranges.length === 0) return content;
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += content.slice(cursor, range.start);
    result += " ".repeat(range.end - range.start);
    cursor = range.end;
  }
  return result + content.slice(cursor);
};

interface NormalizedTextWithOffsets {
  text: string;
  /** Original UTF-16 start for each normalized UTF-16 code unit. */
  rawStarts: number[];
  /** Original UTF-16 end for each normalized UTF-16 code unit. */
  rawEnds: number[];
}

/**
 * Compatibility normalization and Unicode full case folding are required for
 * stable identity matching, but both can change UTF-16 length (for example a
 * ligature or sharp s). Fold by grapheme and retain a mapping back to the
 * exact original slice used for rendering.
 */
const normalizeWithOriginalOffsets = (raw: string): NormalizedTextWithOffsets => {
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw)]
        .map((part) => ({ segment: part.segment, index: part.index }))
    : (() => {
        const parts: Array<{ segment: string; index: number }> = [];
        let index = 0;
        for (const codePoint of raw) {
          parts.push({ segment: codePoint, index });
          index += codePoint.length;
        }
        return parts;
      })();
  let text = "";
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  for (const part of segments) {
    const normalized = unicodeCaselessKey(part.segment);
    const rawEnd = part.index + part.segment.length;
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      rawStarts.push(part.index);
      rawEnds.push(rawEnd);
    }
  }
  return { text, rawStarts, rawEnds };
};

const isAsciiMentionName = (name: string): boolean => /^[A-Za-z0-9._%+\-]+$/u.test(name);
const isAsciiMentionContinuation = (value: string | undefined): boolean =>
  Boolean(value && /[A-Za-z0-9._%+\-]/u.test(value));
const isUnicodeMentionContinuation = (value: string | undefined): boolean =>
  Boolean(value && /[\p{L}\p{M}\p{N}_]/u.test(value));
const codePointAtOffset = (value: string, offset: number): string | undefined => {
  const codePoint = value.codePointAt(offset);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
};
const codePointBeforeOffset = (value: string, offset: number): string | undefined =>
  [...value.slice(0, offset)].at(-1);
const isContextualJoinContinuation = (content: string, offset: number): boolean => {
  const joiner = codePointAtOffset(content, offset);
  if (joiner !== "\u200c" && joiner !== "\u200d") return false;
  return /[\p{L}\p{M}]/u.test(codePointBeforeOffset(content, offset) ?? "") &&
    /[\p{L}\p{M}]/u.test(codePointAtOffset(content, offset + joiner.length) ?? "");
};

const hasUnicodeWordBoundaryAt = (content: string, offset: number): boolean | undefined => {
  if (typeof Intl.Segmenter !== "function") return undefined;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const prior = Math.max(0, offset - 1);
  for (const part of segmenter.segment(content)) {
    const end = part.index + part.segment.length;
    if (part.index <= prior && prior < end) return end === offset;
    if (part.index > prior) break;
  }
  return undefined;
};

const isExactMentionMatch = (content: string, start: number, end: number, asciiName: boolean): boolean => {
  // ASCII token characters before @ indicate an email/URL/identifier. CJK
  // and RTL prose may touch @ naturally in no-space writing contexts.
  if (isAsciiMentionContinuation(content[start - 1])) return false;
  const next = codePointAtOffset(content, end);
  if (isAsciiMentionContinuation(next)) return false;
  if (isContextualJoinContinuation(content, end)) return false;
  if (!isUnicodeMentionContinuation(next)) return true;

  // A canonical ASCII display name followed by a non-Latin letter is a clear
  // script transition in no-space prose. Latin letters, every numeric script
  // and combining marks remain possible username continuations and stay out.
  if (
    asciiName &&
    /\p{L}/u.test(next ?? "") &&
    !/\p{Script_Extensions=Latin}/u.test(next ?? "")
  ) return true;

  // Unicode word segmentation distinguishes a longer Latin/Arabic identifier
  // from a genuine script boundary without maintaining a language list. This
  // also lets non-Latin display names participate in no-space prose.
  const segmentedBoundary = hasUnicodeWordBoundaryAt(content, end);
  if (segmentedBoundary !== undefined) return segmentedBoundary;
  // Old runtimes without Segmenter fail conservatively for non-ASCII names;
  // preserve the historical no-space transition for canonical ASCII names.
  return asciiName && !/\p{M}/u.test(next ?? "");
};

/**
 * Returns exact, non-URL display-name mentions at original UTF-16 offsets.
 * Display names are expected to have passed the shared join-time normalizer.
 */
export const findExactMentionRanges = (
  rawContent: string,
  rawNames: readonly string[],
  limit = 100,
): ExactMentionRange[] => {
  if (!rawContent || rawNames.length === 0) return [];
  const normalizedContent = normalizeWithOriginalOffsets(rawContent);
  const content = maskUrlRanges(normalizedContent.text);
  const seenNames = new Set<string>();
  const names = rawNames.flatMap((value) => {
    const rawName = value.trim();
    const normalizedName = unicodeCaselessKey(rawName);
    const key = normalizedName;
    if (!normalizedName || seenNames.has(key)) return [];
    seenNames.add(key);
    return [{ rawName, normalizedName }];
  }).sort((a, b) => b.normalizedName.length - a.normalizedName.length);
  const matches: ExactMentionRange[] = [];
  const boundedLimit = Math.max(1, Math.min(limit, 100));

  for (const name of names) {
    const mention = new RegExp(`@${escapeRegExp(name.normalizedName)}`, "gu");
    const asciiName = isAsciiMentionName(name.normalizedName);
    for (const match of content.matchAll(mention)) {
      const normalizedStart = match.index ?? 0;
      const value = match[0] ?? "";
      const normalizedEnd = normalizedStart + value.length;
      if (!value || !isExactMentionMatch(content, normalizedStart, normalizedEnd, asciiName)) continue;
      const start = normalizedContent.rawStarts[normalizedStart];
      const end = normalizedContent.rawEnds[normalizedEnd - 1];
      if (start === undefined || end === undefined || end <= start) continue;
      matches.push({
        value: rawContent.slice(start, end),
        name: name.rawName,
        start,
        end,
      });
    }
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end || a.name.localeCompare(b.name));
  const accepted: ExactMentionRange[] = [];
  for (const match of matches) {
    if (accepted.some((existing) => match.start < existing.end && match.end > existing.start)) continue;
    accepted.push(match);
    if (accepted.length >= boundedLimit) break;
  }
  return accepted.sort((a, b) => a.start - b.start);
};

/**
 * Match an exact display-name mention without assuming whitespace-delimited
 * prose. It remains strict inside ASCII identifiers and URLs, while allowing
 * a Latin display name to touch a no-space CJK/RTL script transition.
 */
export const containsExactMention = (rawContent: string, rawName: string): boolean => {
  return findExactMentionRanges(rawContent, [rawName], 1).length > 0;
};
