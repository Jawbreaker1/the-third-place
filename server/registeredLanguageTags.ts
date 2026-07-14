import {
  IANA_LANGUAGE_SUBTAGS,
  IANA_PREFERRED_EXTLANGS,
  IANA_PREFERRED_SUBTAGS,
  IANA_PREFERRED_TAGS,
  IANA_REGION_SUBTAGS,
  IANA_REGISTERED_TAGS,
  IANA_SCRIPT_SUBTAGS,
  IANA_VARIANT_SUBTAGS,
} from "./ianaLanguageSubtags.generated.js";

export interface RegisteredLanguageTagOptions {
  allowUndetermined?: boolean;
}

const ALPHA = /^[a-z]+$/u;
const ALPHANUMERIC = /^[a-z\d]+$/u;
const REGION_SHAPE = /^(?:[a-z]{2}|\d{3})$/u;
const VARIANT_SHAPE = /^(?:[a-z\d]{5,8}|\d[a-z\d]{3})$/u;
const SINGLETON_SHAPE = /^[a-wy-z\d]$/u;

const preferredSubtag = (type: string, value: string): string =>
  IANA_PREFERRED_SUBTAGS[`${type}|${value}`]?.toLowerCase() ?? value;

const legacyPrimaryAlias = (candidate: string): string | undefined => {
  // ECMA-402 also knows standardized ISO aliases such as `swe` -> `sv`
  // which are useful at provider boundaries but are not separate IANA
  // language subtags. It is consulted only when the current registry has no
  // record, so stale host ICU aliases can never override current IANA data.
  try {
    const alias = new Intl.Locale(candidate).language?.toLowerCase();
    if (!alias || alias === candidate || !IANA_LANGUAGE_SUBTAGS.has(alias)) return undefined;
    return preferredSubtag("language", alias);
  } catch {
    return undefined;
  }
};

const canonicalPrimary = (candidate: string): string | undefined => {
  if (IANA_LANGUAGE_SUBTAGS.has(candidate)) return preferredSubtag("language", candidate);
  return legacyPrimaryAlias(candidate);
};

const canonicalRegisteredAlias = (
  candidate: string,
  options: RegisteredLanguageTagOptions,
): string | undefined => {
  const key = candidate.toLowerCase();
  const preferredTag = IANA_PREFERRED_TAGS[key];
  if (preferredTag) return canonicalRegisteredLanguageTag(preferredTag, options);
  // A handful of grandfathered tags intentionally have no replacement. They
  // remain valid BCP-47 values exactly because the current registry says so.
  return IANA_REGISTERED_TAGS[key];
};

const validDiscardedExtensions = (parts: string[], start: number): boolean => {
  const seen = new Set<string>();
  let index = start;
  while (index < parts.length) {
    const singleton = parts[index];
    if (singleton === "x") {
      const privateUse = parts.slice(index + 1);
      return privateUse.length > 0 && privateUse.every(
        (part) => part.length >= 1 && part.length <= 8 && ALPHANUMERIC.test(part),
      );
    }
    if (!SINGLETON_SHAPE.test(singleton) || seen.has(singleton)) return false;
    seen.add(singleton);
    index += 1;
    const firstExtensionPart = index;
    while (
      index < parts.length &&
      parts[index].length >= 2 &&
      parts[index].length <= 8 &&
      ALPHANUMERIC.test(parts[index])
    ) index += 1;
    if (index === firstExtensionPart) return false;
  }
  return true;
};

/** Canonical BCP-47 base-tag validation against the vendored current IANA registry. */
export const canonicalRegisteredLanguageTag = (
  raw: string | undefined,
  options: RegisteredLanguageTagOptions = {},
): string | undefined => {
  const candidate = raw?.trim();
  if (!candidate || candidate.length > 35) return undefined;

  const registeredAlias = canonicalRegisteredAlias(candidate, options);
  if (registeredAlias) return registeredAlias;

  const parts = candidate.toLowerCase().split("-");
  if (parts.some((part) => !part || part.length > 8 || !ALPHANUMERIC.test(part))) return undefined;
  const rawPrimary = parts[0];
  if (!ALPHA.test(rawPrimary) || rawPrimary.length < 2 || rawPrimary.length > 8) return undefined;
  if (rawPrimary === "und") {
    return options.allowUndetermined && parts.length === 1 ? "und" : undefined;
  }

  let primary = canonicalPrimary(rawPrimary);
  if (!primary) return undefined;
  let index = 1;

  const extlang = parts[index];
  const preferredExtlang = extlang ? IANA_PREFERRED_EXTLANGS[`${rawPrimary}|${extlang}`] : undefined;
  if (preferredExtlang) {
    primary = preferredExtlang.toLowerCase();
    index += 1;
  }

  let script: string | undefined;
  const rawScript = parts[index];
  if (rawScript?.length === 4 && ALPHA.test(rawScript)) {
    if (!IANA_SCRIPT_SUBTAGS.has(rawScript)) return undefined;
    const canonical = preferredSubtag("script", rawScript);
    script = `${canonical[0].toUpperCase()}${canonical.slice(1)}`;
    index += 1;
  }

  let region: string | undefined;
  const rawRegion = parts[index];
  if (rawRegion && REGION_SHAPE.test(rawRegion)) {
    if (!IANA_REGION_SUBTAGS.has(rawRegion)) return undefined;
    const canonical = preferredSubtag("region", rawRegion);
    region = /^\d+$/u.test(canonical) ? canonical : canonical.toUpperCase();
    index += 1;
  }

  const variants: string[] = [];
  const seenVariants = new Set<string>();
  while (index < parts.length && VARIANT_SHAPE.test(parts[index])) {
    const rawVariant = parts[index];
    if (!IANA_VARIANT_SUBTAGS.has(rawVariant)) return undefined;
    const variant = preferredSubtag("variant", rawVariant);
    if (seenVariants.has(variant)) return undefined;
    seenVariants.add(variant);
    variants.push(variant);
    index += 1;
  }

  if (index < parts.length && !validDiscardedExtensions(parts, index)) return undefined;
  return [primary, script, region, ...variants].filter(Boolean).join("-");
};
