import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";

/** Parses standardized Accept-Language metadata; it never inspects chat text. */
export const preferredRequestLanguage = (
  raw: string | readonly string[] | undefined,
): string | undefined => {
  const header = typeof raw === "string" ? raw : raw?.join(",");
  if (!header || header.length > 2_000) return undefined;
  const candidates = header.split(",").slice(0, 20).flatMap((part, index) => {
    const [tagPart, ...parameters] = part.trim().split(";");
    const tag = tagPart?.trim();
    if (!tag || tag === "*") return [];
    const qualityParameter = parameters.find((parameter) => /^\s*q\s*=/iu.test(parameter));
    const quality = qualityParameter
      ? Number.parseFloat(qualityParameter.split("=", 2)[1] ?? "")
      : 1;
    if (!Number.isFinite(quality) || quality <= 0 || quality > 1) return [];
    const canonical = canonicalRegisteredLanguageTag(tag);
    return canonical ? [{ tag: canonical, quality, index }] : [];
  });
  candidates.sort((left, right) => right.quality - left.quality || left.index - right.index);
  return candidates[0]?.tag;
};
