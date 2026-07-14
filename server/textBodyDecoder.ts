const MAX_CONTENT_TYPE_LENGTH = 512;
const MAX_META_SCAN_BYTES = 4 * 1024;
const MAX_META_TAG_LENGTH = 1_024;
const MAX_CHARSET_LABEL_LENGTH = 64;

export interface DecodeTextBodyOptions {
  /** The complete response Content-Type header, including an optional charset. */
  contentType?: string;
  /** Only HTML and XHTML bodies may declare their encoding through a meta tag. */
  allowHtmlMeta?: boolean;
  /** A caller-owned transport bound. Bodies beyond it are rejected before decoding. */
  maxBytes: number;
}

const boundedCharsetFromMime = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const value = raw.slice(0, MAX_CONTENT_TYPE_LENGTH);
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]{1,64})"|'([^']{1,64})'|([^\s;"']{1,64}))/iu.exec(value);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
};

const supportedEncoding = (raw: string | undefined): string | undefined => {
  if (!raw || raw.length > MAX_CHARSET_LABEL_LENGTH || !/^[a-z0-9._:+-]+$/iu.test(raw)) return undefined;
  try {
    // WHATWG TextDecoder owns the finite encoding-label registry. Constructing
    // it is both the support check and alias canonicalization; no locale or
    // language name table is maintained by this application.
    return new TextDecoder(raw).encoding;
  } catch {
    return undefined;
  }
};

const bomEncoding = (body: Uint8Array): string | undefined => {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  return undefined;
};

const attributesFromMetaTag = (tag: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  const start = tag.search(/\s/u);
  if (start < 0) return attributes;
  const source = tag.slice(start, -1);
  const pattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of source.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!name || attributes.has(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
};

const charsetFromEarlyHtmlMeta = (body: Uint8Array): string | undefined => {
  // HTML encoding declarations are ASCII syntax even when the surrounding
  // document uses a legacy ASCII-compatible encoding. Latin-1 preserves those
  // bytes one-to-one and the scan is deliberately limited to the early body.
  const prefix = Buffer.from(body.subarray(0, MAX_META_SCAN_BYTES)).toString("latin1");
  const metaPattern = /<meta(?=\s|\/?>)[^>]{0,1024}>/giu;
  for (const match of prefix.matchAll(metaPattern)) {
    const tag = (match[0] ?? "").slice(0, MAX_META_TAG_LENGTH);
    const attrs = attributesFromMetaTag(tag);
    const direct = supportedEncoding(attrs.get("charset"));
    if (direct) return direct;
    if ((attrs.get("http-equiv") ?? "").trim().toLowerCase() !== "content-type") continue;
    const fromContent = supportedEncoding(boundedCharsetFromMime(attrs.get("content")));
    if (fromContent) return fromContent;
  }
  return undefined;
};

/**
 * Decode a transport-bounded text body without assuming UTF-8 or maintaining
 * a language-specific encoding map. A byte-order mark wins per the encoding
 * standard, followed by HTTP charset and an early HTML meta declaration. Unknown labels fail safely
 * to UTF-8 with replacement characters instead of throwing.
 */
export const decodeTextBody = (
  body: Buffer | Uint8Array,
  options: DecodeTextBodyOptions,
): string | undefined => {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || body.byteLength > options.maxBytes) {
    return undefined;
  }
  const headerEncoding = supportedEncoding(boundedCharsetFromMime(options.contentType));
  const encoding = bomEncoding(body) ?? headerEncoding ?? (options.allowHtmlMeta ? charsetFromEarlyHtmlMeta(body) : undefined) ?? "utf-8";
  try {
    return new TextDecoder(encoding).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
};
