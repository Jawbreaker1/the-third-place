export const configuredWebOrigin = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export interface WebOriginConfiguration {
  configuredOrigins: string[];
  publicOrigin?: string;
}

export const exactHttpOrigin = (value: string, variable: string): string => {
  const schemeSeparator = value.indexOf("://");
  const authorityAndSuffix = schemeSeparator >= 0 ? value.slice(schemeSeparator + 3) : "";
  const suffixStart = authorityAndSuffix.search(/[\\/?#]/u);
  const authority = suffixStart >= 0 ? authorityAndSuffix.slice(0, suffixStart) : authorityAndSuffix;
  const suffix = suffixStart >= 0 ? authorityAndSuffix.slice(suffixStart) : "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      `${variable} must contain only exact absolute http(s) origins without credentials, paths, queries or fragments.`,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || schemeSeparator <= 0
    || /[\u0000-\u0020\u007f]/u.test(value)
    || authority.includes("@")
    || (suffix !== "" && suffix !== "/")
    || url.username
    || url.password
    || (url.pathname !== "" && url.pathname !== "/")
    || url.search
    || url.hash
    || url.origin === "null"
  ) {
    throw new TypeError(
      `${variable} must contain only exact absolute http(s) origins without credentials, paths, queries or fragments.`,
    );
  }
  return url.origin;
};

/**
 * Parses trusted deployment configuration without conflating a typo with the
 * deliberately open local-development mode. Empty entries are ignored, but
 * every non-empty configured value must be one exact HTTP(S) origin.
 */
export const parseWebOriginConfiguration = (
  allowedOriginsRaw: string | undefined,
  publicOriginRaw: string | undefined,
): WebOriginConfiguration => {
  const configuredOrigins = [...new Set(
    (allowedOriginsRaw ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => exactHttpOrigin(origin, "ALLOWED_ORIGINS")),
  )];
  const publicValue = publicOriginRaw?.trim();
  const publicOrigin = publicValue ? exactHttpOrigin(publicValue, "PUBLIC_ORIGIN") : undefined;
  return {
    configuredOrigins,
    ...(publicOrigin ? { publicOrigin } : {}),
  };
};

/** Socket.IO admits non-browser clients without Origin, then exact normalized browser origins. */
export const socketOriginAllowed = (
  origin: string | undefined,
  configuredOrigins: readonly string[],
  publicOrigin: string | undefined,
): boolean => {
  if (!origin) return true;
  if (configuredOrigins.length === 0 && publicOrigin === undefined) return true;
  const normalized = configuredWebOrigin(origin);
  if (!normalized) return false;
  return configuredOrigins.includes(normalized) || (publicOrigin !== undefined && publicOrigin === normalized);
};
