const MAX_COOKIE_HEADER_CHARACTERS = 16_384;
const MAX_COOKIE_PAIRS = 64;
const MAX_COOKIE_PART_CHARACTERS = 4_096;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * Parse the small subset of Cookie syntax needed by the app without ever
 * throwing on attacker-controlled percent encoding. The first occurrence
 * wins so an appended duplicate cannot shadow the browser's real cookie.
 */
export const parseCookieHeader = (header?: string): Record<string, string> => {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header || header.length > MAX_COOKIE_HEADER_CHARACTERS) return cookies;

  const parts = header.split(";", MAX_COOKIE_PAIRS + 1);
  if (parts.length > MAX_COOKIE_PAIRS) return cookies;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part || part.length > MAX_COOKIE_PART_CHARACTERS) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    try {
      const name = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      if (!COOKIE_NAME.test(name) || Object.hasOwn(cookies, name)) continue;
      cookies[name] = value;
    } catch {
      // Ignore only the malformed pair; valid cookies in the same header stay usable.
    }
  }
  return cookies;
};
