// Unicode direction overrides and isolates can visually reorder trusted UI
// fragments around untrusted text. Natural RTL letters and orthographic join
// controls are deliberately not part of this set.
const DANGEROUS_DIRECTIONAL_OR_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu;
const ANY_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const ORTHOGRAPHIC_JOIN_CONTROL = /^[\u200c\u200d]$/u;
const ORTHOGRAPHIC_NEIGHBOR = /^[\p{L}\p{M}]$/u;

export const stripDangerousTextControls = (value: string): string =>
  value.replace(DANGEROUS_DIRECTIONAL_OR_CONTROL, "");

/**
 * Produces a locale-independent compatibility-caseless comparison key using
 * Unicode's full default (C/F) case-fold mappings. The Turkic-only mappings
 * are deliberately excluded, so dotless i remains distinct without guessing
 * the text's language. Final normalization restores canonical equivalence.
 */
export const unicodeCaselessKey = (value: string): string => {
  let folded = "";
  for (const point of value.normalize("NFKC")) folded += UNICODE_FULL_CASE_FOLD[point] ?? point;
  return folded.normalize("NFKC");
};

const codePoints = (value: string): string[] => [...value];

/**
 * Rejects control/format characters except ZWNJ/ZWJ when they occur between
 * letters or combining marks, as required by Persian and several Indic
 * orthographies. This is a Unicode-shape rule, not a language allowlist.
 */
export const hasUnsafeControlOrFormat = (value: string): boolean => {
  const points = codePoints(value);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (!ANY_CONTROL_OR_FORMAT.test(point)) continue;
    if (
      ORTHOGRAPHIC_JOIN_CONTROL.test(point) &&
      ORTHOGRAPHIC_NEIGHBOR.test(points[index - 1] ?? "") &&
      ORTHOGRAPHIC_NEIGHBOR.test(points[index + 1] ?? "")
    ) continue;
    return true;
  }
  return false;
};
import { UNICODE_FULL_CASE_FOLD } from "./unicodeCaseFold.generated.js";
