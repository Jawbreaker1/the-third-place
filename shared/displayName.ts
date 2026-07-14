import { hasUnsafeControlOrFormat, stripDangerousTextControls } from "./unicodeSafety.js";

const graphemes = (value: string): string[] => {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
      .map((part) => part.segment);
  } catch {
    return Array.from(value);
  }
};

export const normalizeDisplayName = (raw: string): string =>
  stripDangerousTextControls(raw.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim();

/** Mechanical Unicode format validation; it makes no language assumptions. */
export const validDisplayName = (normalized: string): boolean => {
  const units = graphemes(normalized);
  if (units.length < 1 || units.length > 24) return false;
  if (hasUnsafeControlOrFormat(normalized)) return false;
  if (!/[\p{L}\p{N}]/u.test(units[0] ?? "")) return false;
  return /^[\p{L}\p{M}\p{N}\u200c\u200d ._-]+$/u.test(normalized);
};

export const displayNameGlyph = (normalized: string): string => {
  const first = graphemes(normalized)[0] ?? "?";
  // Some case mappings expand one grapheme (for example ß -> SS). The avatar
  // remains a single displayed glyph after uppercasing.
  return graphemes(first.toUpperCase())[0] ?? first;
};
