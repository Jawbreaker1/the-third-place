export interface CanonicalLanguageTagOptions {
  allowUndetermined?: boolean;
}

/**
 * Lightweight transport canonicalizer used in the browser. The structural
 * 2–3-letter primary-language rule rejects provider language names without a
 * language allowlist or a megabyte-scale registry in the client bundle.
 * Server model boundaries additionally validate against the IANA registry.
 */
export const canonicalLanguageTag = (
  raw: string | undefined,
  options: CanonicalLanguageTagOptions = {},
): string | undefined => {
  const candidate = raw?.trim();
  if (!candidate || candidate.length > 35) return undefined;
  try {
    const locale = new Intl.Locale(candidate);
    const baseName = locale.baseName;
    const language = locale.language;
    if (!language || language === "und") {
      return options.allowUndetermined && baseName === "und" ? "und" : undefined;
    }
    return /^[a-z]{2,3}$/u.test(language) ? baseName : undefined;
  } catch {
    return undefined;
  }
};

export const isCanonicalLanguageTag = (
  value: string,
  options: CanonicalLanguageTagOptions = {},
): boolean => canonicalLanguageTag(value, options) === value;
