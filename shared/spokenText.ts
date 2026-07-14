import { canonicalLanguageTag } from "./languageTags.js";

export interface SpokenWordSegment {
  segment: string;
  index: number;
}

/**
 * Canonicalizes a language hint for speech transport. `und` and malformed
 * values become absence: they must never be presented as a required voice.
 */
export const normalizeSpokenLanguageTag = (value: string | undefined): string | undefined => {
  return canonicalLanguageTag(value);
};

const wordSegments = (value: string, language?: string): SpokenWordSegment[] => {
  const locale = normalizeSpokenLanguageTag(language);
  try {
    const segmented = new Intl.Segmenter(locale, { granularity: "word" }).segment(value);
    return [...segmented]
      .filter((part) => part.isWordLike)
      .map((part) => ({ segment: part.segment, index: part.index }));
  } catch {
    return [...value.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((match) => ({
      segment: match[0],
      index: match.index ?? 0,
    }));
  }
};

const graphemeSegments = (value: string, language?: string): string[] => {
  const locale = normalizeSpokenLanguageTag(language);
  try {
    return [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(value)]
      .map((part) => part.segment);
  } catch {
    // Array.from preserves Unicode code points when Segmenter is unavailable.
    return Array.from(value);
  }
};

/** Language-agnostic timing units for speech estimates and watchdogs. */
export const speechTimingUnits = (value: string, language?: string): number => {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const words = wordSegments(trimmed, language);
  if (words.length > 1 || /\s/u.test(trimmed)) return Math.max(1, words.length);
  // A missing Segmenter must not turn an unspaced CJK/Thai utterance into a
  // single timing unit. Grapheme-based estimation is script-neutral and safe.
  const visibleGraphemes = graphemeSegments(trimmed, language).filter((part) => !/^\s+$/u.test(part)).length;
  return Math.max(1, words.length, Math.ceil(visibleGraphemes / 3));
};

/**
 * Truncates spoken prose at word and grapheme boundaries without inserting
 * spaces into languages that do not use them.
 */
export const truncateSpokenText = (
  value: string,
  options: { language?: string; maxWords: number; maxGraphemes: number },
): string => {
  const words = wordSegments(value, options.language);
  const overflow = words[Math.max(0, options.maxWords)];
  const wordBounded = overflow ? value.slice(0, overflow.index) : value;
  const graphemes = graphemeSegments(wordBounded, options.language);
  return graphemes.slice(0, Math.max(0, options.maxGraphemes)).join("").trim();
};
