import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { validatePublicHttpsUrl } from "./safeHttpsFetch.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const FEED_BODY_LIMIT_BYTES = 384 * 1024;
const FEED_POLL_INTERVAL_MS = 10 * MINUTE_MS;
const FEED_ITEM_MAX_AGE_MS = 3 * DAY_MS;
const FEED_FAILURE_BACKOFF_BASE_MS = MINUTE_MS;
const FEED_FAILURE_BACKOFF_MAX_MS = 30 * MINUTE_MS;
const SEEN_RETENTION_MS = 30 * DAY_MS;
const MARKET_OBSERVATION_MAX_AGE_MS = 30 * MINUTE_MS;
const FUTURE_SKEW_MS = 5 * MINUTE_MS;
const MAX_FEED_ITEMS = 64;
const MAX_FEED_CANDIDATES_PER_POLL = 4;
const MAX_SEEN_KEYS = 4_000;
const MAX_MOVEMENT_HIGH_WATER = 1_000;
const MAX_STATE_BYTES = 512 * 1024;

export interface MarketPulseFeedDefinition {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly allowedHosts: readonly string[];
  readonly regions: readonly string[];
  readonly pollIntervalMs: number;
  readonly maxItemAgeMs: number;
}

/**
 * Fixed, server-owned discovery endpoints. Feed URLs never come from chat,
 * model output, Admin text or fetched documents.
 */
export const MARKET_PULSE_FEEDS = Object.freeze([
  Object.freeze({
    id: "federal-reserve-monetary-policy",
    label: "Federal Reserve monetary policy",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    allowedHosts: Object.freeze(["federalreserve.gov", "www.federalreserve.gov"]),
    regions: Object.freeze(["US"]),
    pollIntervalMs: FEED_POLL_INTERVAL_MS,
    maxItemAgeMs: FEED_ITEM_MAX_AGE_MS,
  }),
  Object.freeze({
    id: "ecb-press",
    label: "European Central Bank press",
    url: "https://www.ecb.europa.eu/rss/press.html",
    allowedHosts: Object.freeze(["ecb.europa.eu", "www.ecb.europa.eu"]),
    regions: Object.freeze(["EU"]),
    pollIntervalMs: FEED_POLL_INTERVAL_MS,
    maxItemAgeMs: FEED_ITEM_MAX_AGE_MS,
  }),
  Object.freeze({
    id: "sec-press-releases",
    label: "U.S. Securities and Exchange Commission press releases",
    url: "https://www.sec.gov/news/pressreleases.rss",
    allowedHosts: Object.freeze(["sec.gov", "www.sec.gov"]),
    regions: Object.freeze(["US"]),
    pollIntervalMs: FEED_POLL_INTERVAL_MS,
    maxItemAgeMs: FEED_ITEM_MAX_AGE_MS,
  }),
  Object.freeze({
    id: "riksbank-press-releases",
    label: "Sveriges Riksbank press releases",
    url: "https://www.riksbank.se/sv/rss/pressmeddelanden/",
    allowedHosts: Object.freeze(["riksbank.se", "www.riksbank.se"]),
    regions: Object.freeze(["SE"]),
    pollIntervalMs: FEED_POLL_INTERVAL_MS,
    maxItemAgeMs: FEED_ITEM_MAX_AGE_MS,
  }),
] as const satisfies readonly MarketPulseFeedDefinition[]);

export type MarketPulseFeedId = (typeof MARKET_PULSE_FEEDS)[number]["id"];

export interface MarketPulseFeedFetchRequest {
  /** Always one of MARKET_PULSE_FEEDS; callers cannot supply a destination. */
  url: URL;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBodyBytes: number;
  acceptedMediaTypes: readonly string[];
}

export interface MarketPulseFeedFetchResponse {
  status: number;
  finalUrl: URL;
  mediaType: string;
  body?: Buffer;
  /** Header names are treated case-insensitively. */
  headers?: Readonly<Record<string, string | undefined>>;
}

/**
 * Injected network boundary. Production should implement this with the same
 * DNS-pinned public-HTTPS primitive used by PageReader.
 */
export type MarketPulseFeedFetcher = (
  request: MarketPulseFeedFetchRequest,
) => Promise<MarketPulseFeedFetchResponse | undefined>;

export interface MarketPulseFeedCandidate {
  origin: "official_feed";
  priority: "routine";
  id: string;
  providerId: MarketPulseFeedId;
  providerLabel: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt: string;
  detectedAt: string;
  regions: string[];
}

export interface ValidatedMarketObservation {
  /** Runtime proof that the upstream typed provider validated this record. */
  validated: true;
  providerId: string;
  instrumentId: string;
  displayName: string;
  region: string;
  sessionId: string;
  sessionChangePercent: number;
  observedAt: string;
  sourceUrl: string;
  sourceTitle: string;
  /** Only representative headline indexes may contribute to breadth. */
  breadthEligible: boolean;
}

export interface MarketPulseMovementSource {
  providerId: string;
  instrumentId: string;
  displayName: string;
  region: string;
  sessionId: string;
  sessionChangePercent: number;
  observedAt: string;
  sourceUrl: string;
  sourceTitle: string;
}

interface ValidatedMovementObservation extends MarketPulseMovementSource {
  breadthEligible: boolean;
}

export interface MarketPulseMovementCandidate {
  origin: "validated_market_observation";
  priority: "notable" | "exceptional";
  id: string;
  detectedAt: string;
  direction: "up" | "down";
  scope: "single_index" | "broad_market";
  severityBand: number;
  observations: MarketPulseMovementSource[];
}

export type MarketPulseCandidate = MarketPulseFeedCandidate | MarketPulseMovementCandidate;

interface FeedPollState {
  etag?: string;
  lastModified?: string;
  nextPollAt: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

interface SeenKeyState {
  key: string;
  expiresAt: number;
}

interface MovementHighWaterState {
  key: string;
  severityBand: number;
  expiresAt: number;
}

export interface MarketPulsePersistedState {
  version: 1;
  feeds: Record<string, FeedPollState>;
  seen: SeenKeyState[];
  movementHighWater: MovementHighWaterState[];
}

export interface MarketPulseStateStore {
  load(): Promise<unknown | undefined>;
  save(state: MarketPulsePersistedState): Promise<void>;
}

export class MemoryMarketPulseStateStore implements MarketPulseStateStore {
  private value?: MarketPulsePersistedState;

  async load(): Promise<unknown | undefined> {
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: MarketPulsePersistedState): Promise<void> {
    this.value = structuredClone(state);
  }
}

/** Small atomic JSON implementation for a process-local deployment. */
export class JsonFileMarketPulseStateStore implements MarketPulseStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<unknown | undefined> {
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) return undefined;
      return JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(state: MarketPulsePersistedState): Promise<void> {
    const payload = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error("Market pulse state exceeded its bound");
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

interface XmlElement {
  qualifiedName: string;
  localName: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string[];
}

interface ParsedFeedItem {
  itemId?: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt: string;
}

const hashKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

const boundedCleanText = (value: string, limit: number): string =>
  stripDangerousTextControls(value.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);

const plainDecodedMarkup = (value: string): string => {
  let output = "";
  let insideTag = false;
  for (const character of value) {
    if (character === "<") {
      insideTag = true;
      output += " ";
    } else if (character === ">" && insideTag) {
      insideTag = false;
      output += " ";
    } else if (!insideTag) {
      output += character;
    }
    if (output.length >= 2_000) break;
  }
  return output;
};

const decodeXmlEntities = (value: string): string | undefined => {
  let output = "";
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    if (character !== "&") {
      output += character;
      index += 1;
      continue;
    }
    const end = value.indexOf(";", index + 1);
    if (end < 0 || end - index > 16) return undefined;
    const entity = value.slice(index + 1, end);
    const named: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: '"',
    };
    let decoded = named[entity];
    if (decoded === undefined && entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff && ![0xfffe, 0xffff].includes(code)) {
        decoded = String.fromCodePoint(code);
      }
    } else if (decoded === undefined && entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff && ![0xfffe, 0xffff].includes(code)) {
        decoded = String.fromCodePoint(code);
      }
    }
    if (decoded === undefined) return undefined;
    output += decoded;
    index = end + 1;
    if (output.length > FEED_BODY_LIMIT_BYTES) return undefined;
  }
  return output;
};

const xmlLocalName = (qualifiedName: string): string =>
  (qualifiedName.split(":").at(-1) ?? qualifiedName).toLocaleLowerCase("und");

const xmlNameCharacter = (character: string, first: boolean): boolean => {
  const code = character.codePointAt(0) ?? 0;
  if (character === ":" || character === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
    return true;
  }
  return !first && (character === "-" || character === "." || (code >= 48 && code <= 57));
};

const parseTag = (
  raw: string,
): { name: string; attributes: Record<string, string>; selfClosing: boolean } | undefined => {
  let cursor = 0;
  const whitespace = () => {
    while (cursor < raw.length && /\s/u.test(raw[cursor]!)) cursor += 1;
  };
  whitespace();
  const nameStart = cursor;
  while (cursor < raw.length && xmlNameCharacter(raw[cursor]!, cursor === nameStart)) cursor += 1;
  const name = raw.slice(nameStart, cursor);
  if (!name || name.length > 128) return undefined;
  const attributes: Record<string, string> = {};
  let attributeCount = 0;
  while (cursor < raw.length) {
    whitespace();
    if (cursor >= raw.length) return { name, attributes, selfClosing: false };
    if (raw[cursor] === "/") {
      cursor += 1;
      whitespace();
      return cursor === raw.length ? { name, attributes, selfClosing: true } : undefined;
    }
    const attributeStart = cursor;
    while (cursor < raw.length && xmlNameCharacter(raw[cursor]!, cursor === attributeStart)) cursor += 1;
    const attributeName = raw.slice(attributeStart, cursor);
    if (!attributeName || attributeName.length > 128 || attributeCount >= 24) return undefined;
    whitespace();
    if (raw[cursor] !== "=") return undefined;
    cursor += 1;
    whitespace();
    const quote = raw[cursor];
    if (quote !== '"' && quote !== "'") return undefined;
    cursor += 1;
    const valueStart = cursor;
    while (cursor < raw.length && raw[cursor] !== quote) cursor += 1;
    if (cursor >= raw.length || cursor - valueStart > 4_096) return undefined;
    const decoded = decodeXmlEntities(raw.slice(valueStart, cursor));
    if (decoded === undefined) return undefined;
    attributes[xmlLocalName(attributeName)] = decoded;
    attributeCount += 1;
    cursor += 1;
  }
  return { name, attributes, selfClosing: false };
};

const findTagEnd = (xml: string, from: number): number => {
  let quote: string | undefined;
  const limit = Math.min(xml.length, from + 8_192);
  for (let index = from; index < limit; index += 1) {
    const character = xml[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
};

/**
 * A deliberately small, bounded XML tree builder for RSS/Atom metadata. It
 * rejects DTD/entity declarations and does not expand external resources.
 */
const parseBoundedXml = (xml: string): XmlElement | undefined => {
  if (
    Buffer.byteLength(xml) > FEED_BODY_LIMIT_BYTES ||
    xml.toLocaleLowerCase("und").includes("<!doctype") ||
    xml.toLocaleLowerCase("und").includes("<!entity")
  ) return undefined;

  const document: XmlElement = {
    qualifiedName: "#document",
    localName: "#document",
    attributes: {},
    children: [],
    text: [],
  };
  const stack: XmlElement[] = [document];
  let cursor = 0;
  let nodes = 0;
  let tokens = 0;
  let textCharacters = 0;

  const appendText = (raw: string, cdata = false): boolean => {
    if (!raw) return true;
    const decoded = cdata ? raw : decodeXmlEntities(raw);
    if (decoded === undefined) return false;
    textCharacters += decoded.length;
    if (textCharacters > FEED_BODY_LIMIT_BYTES) return false;
    stack.at(-1)!.text.push(decoded);
    return true;
  };

  while (cursor < xml.length) {
    if (++tokens > 20_000) return undefined;
    const open = xml.indexOf("<", cursor);
    if (open < 0) {
      if (!appendText(xml.slice(cursor))) return undefined;
      cursor = xml.length;
      break;
    }
    if (!appendText(xml.slice(cursor, open))) return undefined;

    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0 || !appendText(xml.slice(open + 9, end), true)) return undefined;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) return undefined;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", open)) return undefined;

    const end = findTagEnd(xml, open + 1);
    if (end < 0) return undefined;
    const raw = xml.slice(open + 1, end);
    if (raw.startsWith("/")) {
      const closingName = raw.slice(1).trim();
      if (
        !closingName ||
        closingName.length > 128 ||
        stack.length <= 1 ||
        stack.at(-1)!.qualifiedName !== closingName
      ) return undefined;
      stack.pop();
      cursor = end + 1;
      continue;
    }

    const parsed = parseTag(raw);
    if (!parsed || ++nodes > 4_096 || stack.length > 32) return undefined;
    const node: XmlElement = {
      qualifiedName: parsed.name,
      localName: xmlLocalName(parsed.name),
      attributes: parsed.attributes,
      children: [],
      text: [],
    };
    stack.at(-1)!.children.push(node);
    if (!parsed.selfClosing) stack.push(node);
    cursor = end + 1;
  }

  if (stack.length !== 1 || document.children.length !== 1) return undefined;
  const root = document.children[0]!;
  return ["feed", "rdf", "rss"].includes(root.localName) ? root : undefined;
};

const elementText = (element: XmlElement, limit = 4_096): string => {
  let value = "";
  const pending: XmlElement[] = [element];
  let visited = 0;
  while (pending.length > 0 && visited++ < 512 && value.length < limit) {
    const current = pending.shift()!;
    value += ` ${current.text.join(" ")}`;
    pending.unshift(...current.children);
  }
  return boundedCleanText(plainDecodedMarkup(value), limit);
};

const descendants = (root: XmlElement, names: ReadonlySet<string>, limit: number): XmlElement[] => {
  const result: XmlElement[] = [];
  const pending = [...root.children];
  let visited = 0;
  while (pending.length > 0 && visited++ < 4_096 && result.length < limit) {
    const current = pending.shift()!;
    if (names.has(current.localName)) result.push(current);
    pending.unshift(...current.children);
  }
  return result;
};

const firstDescendant = (root: XmlElement, names: readonly string[]): XmlElement | undefined =>
  descendants(root, new Set(names), 1)[0];

const allowedHost = (url: URL, hosts: readonly string[]): boolean =>
  hosts.includes(url.hostname.toLocaleLowerCase("und").replace(/\.$/u, ""));

export const canonicalMarketPulseUrl = (raw: string): string | undefined => {
  const parsed = validatePublicHttpsUrl(raw);
  if (!parsed) return undefined;
  parsed.hostname = parsed.hostname.toLocaleLowerCase("und").replace(/\.$/u, "");
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
};

const itemLink = (entry: XmlElement): string | undefined => {
  const links = descendants(entry, new Set(["link"]), 12);
  const atom = links.find((link) => {
    const rel = boundedCleanText(link.attributes.rel ?? "alternate", 24).toLocaleLowerCase("und");
    return Boolean(link.attributes.href) && (rel === "alternate" || rel === "");
  });
  if (atom?.attributes.href) return atom.attributes.href;
  const rss = links.map((link) => elementText(link, 2_048)).find(Boolean);
  if (rss) return rss;
  const guid = firstDescendant(entry, ["guid", "id"]);
  const guidText = guid ? elementText(guid, 2_048) : "";
  return guidText.startsWith("https://") ? guidText : undefined;
};

const parseFeedItems = (
  feed: MarketPulseFeedDefinition,
  xml: string,
  now: number,
): ParsedFeedItem[] | undefined => {
  const root = parseBoundedXml(xml);
  if (!root) return undefined;
  const entries = descendants(root, new Set(["entry", "item"]), MAX_FEED_ITEMS);
  const results: ParsedFeedItem[] = [];
  const seenUrls = new Set<string>();
  for (const entry of entries) {
    const titleNode = firstDescendant(entry, ["title"]);
    const publishedNode = firstDescendant(entry, ["published", "pubdate", "updated", "date"]);
    const title = titleNode ? boundedCleanText(plainDecodedMarkup(elementText(titleNode)), 180) : "";
    const publishedRaw = publishedNode ? elementText(publishedNode, 100) : "";
    const publishedAtMs = Date.parse(publishedRaw);
    const rawUrl = itemLink(entry);
    const url = rawUrl ? canonicalMarketPulseUrl(rawUrl) : undefined;
    if (
      !title ||
      !url ||
      !Number.isFinite(publishedAtMs) ||
      publishedAtMs > now + FUTURE_SKEW_MS ||
      now - publishedAtMs > feed.maxItemAgeMs
    ) continue;
    const parsedUrl = new URL(url);
    if (!allowedHost(parsedUrl, feed.allowedHosts) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const idNode = firstDescendant(entry, ["guid", "id"]);
    const itemId = idNode ? boundedCleanText(elementText(idNode, 512), 512) : undefined;
    const summaryNode = firstDescendant(entry, ["description", "summary", "content", "encoded"]);
    const summary = summaryNode
      ? boundedCleanText(plainDecodedMarkup(elementText(summaryNode, 2_000)), 600)
      : "";
    results.push({
      ...(itemId ? { itemId } : {}),
      title,
      url,
      ...(summary ? { summary } : {}),
      publishedAt: new Date(publishedAtMs).toISOString(),
    });
  }
  return results.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
};

export const parseOfficialMarketPulseFeed = (
  feedId: MarketPulseFeedId,
  body: Buffer | string,
  now = Date.now(),
): ParsedFeedItem[] | undefined => {
  const feed = MARKET_PULSE_FEEDS.find((candidate) => candidate.id === feedId);
  if (!feed) return undefined;
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  if (buffer.byteLength > FEED_BODY_LIMIT_BYTES) return undefined;
  return parseFeedItems(feed, buffer.toString("utf8"), now);
};

const emptyState = (): MarketPulsePersistedState => ({
  version: 1,
  feeds: {},
  seen: [],
  movementHighWater: [],
});

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const safeTimestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const safeConditionalHeader = (value: unknown, limit = 512): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit && /^[\x20-\x7e]+$/u.test(value)
    ? value
    : undefined;

const normalizePersistedState = (raw: unknown, now: number): MarketPulsePersistedState => {
  const source = recordValue(raw);
  if (!source || source.version !== 1) return emptyState();
  const allowedFeedIds = new Set<string>(MARKET_PULSE_FEEDS.map((feed) => feed.id));
  const feedDefinitions = new Map<string, MarketPulseFeedDefinition>(
    MARKET_PULSE_FEEDS.map((feed) => [feed.id, feed]),
  );
  const feeds: Record<string, FeedPollState> = {};
  const rawFeeds = recordValue(source.feeds) ?? {};
  for (const [feedId, rawFeed] of Object.entries(rawFeeds).slice(0, MARKET_PULSE_FEEDS.length)) {
    if (!allowedFeedIds.has(feedId)) continue;
    const feed = recordValue(rawFeed);
    const nextPollAt = safeTimestamp(feed?.nextPollAt);
    const failures = safeTimestamp(feed?.consecutiveFailures);
    if (!feed || nextPollAt === undefined || failures === undefined) continue;
    const etag = safeConditionalHeader(feed.etag);
    const lastModified = safeConditionalHeader(feed.lastModified);
    const lastSuccessAt = safeTimestamp(feed.lastSuccessAt);
    const lastFailureAt = safeTimestamp(feed.lastFailureAt);
    const definition = feedDefinitions.get(feedId)!;
    feeds[feedId] = {
      nextPollAt: Math.min(nextPollAt, now + Math.max(definition.pollIntervalMs, FEED_FAILURE_BACKOFF_MAX_MS)),
      consecutiveFailures: Math.min(failures, 32),
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
      ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
    };
  }
  const seen = Array.isArray(source.seen)
    ? source.seen.flatMap((rawEntry): SeenKeyState[] => {
      const entry = recordValue(rawEntry);
      const key = typeof entry?.key === "string" && /^[a-z]+:[a-f0-9]{32}$/u.test(entry.key)
        ? entry.key
        : undefined;
      const expiresAt = safeTimestamp(entry?.expiresAt);
      return key && expiresAt !== undefined && expiresAt > now
        ? [{ key, expiresAt: Math.min(expiresAt, now + SEEN_RETENTION_MS) }]
        : [];
    }).slice(0, MAX_SEEN_KEYS)
    : [];
  const movementHighWater = Array.isArray(source.movementHighWater)
    ? source.movementHighWater.flatMap((rawEntry): MovementHighWaterState[] => {
      const entry = recordValue(rawEntry);
      const key = typeof entry?.key === "string" && /^[a-z]+:[a-f0-9]{32}$/u.test(entry.key)
        ? entry.key
        : undefined;
      const severityBand = safeTimestamp(entry?.severityBand);
      const expiresAt = safeTimestamp(entry?.expiresAt);
      return key && severityBand !== undefined && severityBand <= 12 && expiresAt !== undefined && expiresAt > now
        ? [{ key, severityBand, expiresAt: Math.min(expiresAt, now + SEEN_RETENTION_MS) }]
        : [];
    }).slice(0, MAX_MOVEMENT_HIGH_WATER)
    : [];
  return { version: 1, feeds, seen, movementHighWater };
};

const pruneState = (state: MarketPulsePersistedState, now: number): void => {
  state.seen = state.seen
    .filter((entry) => entry.expiresAt > now)
    .sort((left, right) => right.expiresAt - left.expiresAt)
    .slice(0, MAX_SEEN_KEYS);
  state.movementHighWater = state.movementHighWater
    .filter((entry) => entry.expiresAt > now)
    .sort((left, right) => right.expiresAt - left.expiresAt)
    .slice(0, MAX_MOVEMENT_HIGH_WATER);
};

const responseHeader = (
  headers: MarketPulseFeedFetchResponse["headers"],
  target: string,
): string | undefined => {
  if (!headers) return undefined;
  const normalizedTarget = target.toLocaleLowerCase("und");
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLocaleLowerCase("und") === normalizedTarget) return safeConditionalHeader(value);
  }
  return undefined;
};

const acceptedFeedMediaType = (raw: string): boolean => {
  const mediaType = raw.split(";", 1)[0]?.trim().toLocaleLowerCase("und") ?? "";
  return [
    "application/atom+xml",
    "application/rss+xml",
    "application/xml",
    "text/xml",
  ].includes(mediaType);
};

const feedBackoffMs = (consecutiveFailures: number): number =>
  Math.min(
    FEED_FAILURE_BACKOFF_MAX_MS,
    FEED_FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(5, Math.max(0, consecutiveFailures - 1)),
  );

export interface MarketPulseOptions {
  now?: () => number;
  enabledFeedIds?: readonly MarketPulseFeedId[];
  maxFeedsPerPoll?: number;
  maxFeedCandidatesPerPoll?: number;
  notableThresholdPercent?: number;
  exceptionalThresholdPercent?: number;
  breadthThresholdPercent?: number;
  breadthMinimumIndexes?: number;
  breadthMinimumRegions?: number;
  observationMaxAgeMs?: number;
}

export interface MarketPulseFeedDiagnostics {
  feedId: MarketPulseFeedId;
  nextPollAt: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  hasValidator: boolean;
}

export class MarketPulseCoordinator {
  private state?: MarketPulsePersistedState;
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly enabledFeedIds: readonly MarketPulseFeedId[];
  private readonly maxFeedsPerPoll: number;
  private readonly maxFeedCandidatesPerPoll: number;
  private readonly notableThresholdPercent: number;
  private readonly exceptionalThresholdPercent: number;
  private readonly breadthThresholdPercent: number;
  private readonly breadthMinimumIndexes: number;
  private readonly breadthMinimumRegions: number;
  private readonly observationMaxAgeMs: number;

  constructor(
    private readonly fetcher: MarketPulseFeedFetcher,
    private readonly store: MarketPulseStateStore,
    options: MarketPulseOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const knownFeedIds = new Set<MarketPulseFeedId>(MARKET_PULSE_FEEDS.map((feed) => feed.id));
    this.enabledFeedIds = Object.freeze([
      ...new Set(options.enabledFeedIds ?? MARKET_PULSE_FEEDS.map((feed) => feed.id)),
    ].filter((feedId): feedId is MarketPulseFeedId => knownFeedIds.has(feedId)));
    this.maxFeedsPerPoll = Math.max(1, Math.min(4, Math.floor(options.maxFeedsPerPoll ?? 2)));
    this.maxFeedCandidatesPerPoll = Math.max(
      1,
      Math.min(12, Math.floor(options.maxFeedCandidatesPerPoll ?? MAX_FEED_CANDIDATES_PER_POLL)),
    );
    this.notableThresholdPercent = Math.max(0.5, Math.min(10, options.notableThresholdPercent ?? 1.5));
    this.exceptionalThresholdPercent = Math.max(
      this.notableThresholdPercent + 0.5,
      Math.min(20, options.exceptionalThresholdPercent ?? 3),
    );
    this.breadthThresholdPercent = Math.max(
      this.notableThresholdPercent,
      Math.min(this.exceptionalThresholdPercent, options.breadthThresholdPercent ?? 1.5),
    );
    this.breadthMinimumIndexes = Math.max(3, Math.min(8, Math.floor(options.breadthMinimumIndexes ?? 3)));
    this.breadthMinimumRegions = Math.max(2, Math.min(6, Math.floor(options.breadthMinimumRegions ?? 2)));
    this.observationMaxAgeMs = Math.max(
      5 * MINUTE_MS,
      Math.min(2 * 60 * MINUTE_MS, options.observationMaxAgeMs ?? MARKET_OBSERVATION_MAX_AGE_MS),
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadedState(now: number): Promise<MarketPulsePersistedState> {
    this.state ??= normalizePersistedState(await this.store.load(), now);
    pruneState(this.state, now);
    return this.state;
  }

  private recordFeedFailure(state: MarketPulsePersistedState, feedId: MarketPulseFeedId, now: number): void {
    const previous = state.feeds[feedId];
    const consecutiveFailures = Math.min(32, (previous?.consecutiveFailures ?? 0) + 1);
    state.feeds[feedId] = {
      ...(previous?.etag ? { etag: previous.etag } : {}),
      ...(previous?.lastModified ? { lastModified: previous.lastModified } : {}),
      ...(previous?.lastSuccessAt !== undefined ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      consecutiveFailures,
      lastFailureAt: now,
      nextPollAt: now + feedBackoffMs(consecutiveFailures),
    };
  }

  async pollOfficialFeeds(): Promise<MarketPulseFeedCandidate[]> {
    return this.exclusive(async () => {
      const now = this.now();
      const state = await this.loadedState(now);
      const feedDefinitions = MARKET_PULSE_FEEDS
        .filter((feed) => this.enabledFeedIds.includes(feed.id))
        .filter((feed) => (state.feeds[feed.id]?.nextPollAt ?? 0) <= now)
        .sort((left, right) =>
          (state.feeds[left.id]?.nextPollAt ?? 0) - (state.feeds[right.id]?.nextPollAt ?? 0),
        )
        .slice(0, this.maxFeedsPerPoll);
      if (feedDefinitions.length === 0) return [];

      const seenKeys = new Set(state.seen.map((entry) => entry.key));
      const candidates: MarketPulseFeedCandidate[] = [];
      for (const feed of feedDefinitions) {
        const previous = state.feeds[feed.id];
        const headers: Record<string, string> = {
          Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
          "User-Agent": "TheThirdPlace-MarketPulse/1.0",
        };
        if (previous?.etag) headers["If-None-Match"] = previous.etag;
        if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;

        let response: MarketPulseFeedFetchResponse | undefined;
        try {
          response = await this.fetcher({
            url: new URL(feed.url),
            headers,
            timeoutMs: 8_000,
            maxBodyBytes: FEED_BODY_LIMIT_BYTES,
            acceptedMediaTypes: [
              "application/atom+xml",
              "application/rss+xml",
              "application/xml",
              "text/xml",
            ],
          });
        } catch {
          response = undefined;
        }
        if (!response || response.finalUrl.protocol !== "https:" || !allowedHost(response.finalUrl, feed.allowedHosts)) {
          this.recordFeedFailure(state, feed.id, now);
          continue;
        }
        if (response.status === 304) {
          state.feeds[feed.id] = {
            ...(previous?.etag ? { etag: previous.etag } : {}),
            ...(previous?.lastModified ? { lastModified: previous.lastModified } : {}),
            consecutiveFailures: 0,
            lastSuccessAt: now,
            nextPollAt: now + feed.pollIntervalMs,
          };
          continue;
        }
        if (
          response.status !== 200 ||
          !acceptedFeedMediaType(response.mediaType) ||
          !response.body ||
          response.body.byteLength > FEED_BODY_LIMIT_BYTES
        ) {
          this.recordFeedFailure(state, feed.id, now);
          continue;
        }
        const parsed = parseFeedItems(feed, response.body.toString("utf8"), now);
        if (!parsed) {
          this.recordFeedFailure(state, feed.id, now);
          continue;
        }
        const etag = responseHeader(response.headers, "etag") ?? previous?.etag;
        const lastModified = responseHeader(response.headers, "last-modified") ?? previous?.lastModified;
        state.feeds[feed.id] = {
          ...(etag ? { etag } : {}),
          ...(lastModified ? { lastModified } : {}),
          consecutiveFailures: 0,
          lastSuccessAt: now,
          nextPollAt: now + feed.pollIntervalMs,
        };
        for (const item of parsed) {
          const identityKey = `id:${hashKey(`${feed.id}:${item.itemId ?? item.url}`)}`;
          const urlKey = `url:${hashKey(item.url)}`;
          if (seenKeys.has(identityKey) || seenKeys.has(urlKey)) continue;
          const expiresAt = now + SEEN_RETENTION_MS;
          state.seen.push({ key: identityKey, expiresAt }, { key: urlKey, expiresAt });
          seenKeys.add(identityKey);
          seenKeys.add(urlKey);
          candidates.push({
            origin: "official_feed",
            priority: "routine",
            id: `${feed.id}:${hashKey(item.itemId ?? item.url)}`,
            providerId: feed.id,
            providerLabel: feed.label,
            title: item.title,
            url: item.url,
            ...(item.summary ? { summary: item.summary } : {}),
            publishedAt: item.publishedAt,
            detectedAt: new Date(now).toISOString(),
            regions: [...feed.regions],
          });
        }
      }
      pruneState(state, now);
      await this.store.save(structuredClone(state));
      return candidates
        .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
        .slice(0, this.maxFeedCandidatesPerPoll);
    });
  }

  private validatedObservations(
    observations: readonly ValidatedMarketObservation[],
    now: number,
  ): ValidatedMovementObservation[] {
    const newestByInstrumentSession = new Map<string, ValidatedMovementObservation>();
    for (const raw of observations.slice(0, 64)) {
      const providerId = boundedCleanText(raw.providerId, 64);
      const instrumentId = boundedCleanText(raw.instrumentId, 64);
      const displayName = boundedCleanText(raw.displayName, 120);
      const region = boundedCleanText(raw.region, 48);
      const sessionId = boundedCleanText(raw.sessionId, 96);
      const sourceTitle = boundedCleanText(raw.sourceTitle, 180);
      const sourceUrl = canonicalMarketPulseUrl(raw.sourceUrl);
      const observedAtMs = Date.parse(raw.observedAt);
      if (
        raw.validated !== true ||
        !providerId ||
        !instrumentId ||
        !displayName ||
        !region ||
        !sessionId ||
        !sourceTitle ||
        !sourceUrl ||
        !Number.isFinite(observedAtMs) ||
        observedAtMs > now + FUTURE_SKEW_MS ||
        now - observedAtMs > this.observationMaxAgeMs ||
        typeof raw.sessionChangePercent !== "number" ||
        !Number.isFinite(raw.sessionChangePercent) ||
        Math.abs(raw.sessionChangePercent) > 100 ||
        raw.sessionChangePercent === 0
      ) continue;
      const candidate: ValidatedMovementObservation = {
        providerId,
        instrumentId,
        displayName,
        region,
        sessionId,
        sessionChangePercent: raw.sessionChangePercent,
        observedAt: new Date(observedAtMs).toISOString(),
        sourceUrl,
        sourceTitle,
        breadthEligible: raw.breadthEligible === true,
      };
      const key = `${instrumentId}\u0000${sessionId}`;
      const current = newestByInstrumentSession.get(key);
      if (!current || Date.parse(current.observedAt) < observedAtMs) newestByInstrumentSession.set(key, candidate);
    }
    return [...newestByInstrumentSession.values()];
  }

  private movementBand(magnitude: number): { priority: "notable" | "exceptional"; band: number } | undefined {
    if (magnitude < this.notableThresholdPercent) return undefined;
    if (magnitude < this.exceptionalThresholdPercent) return { priority: "notable", band: 1 };
    if (magnitude >= 8) return { priority: "exceptional", band: 4 };
    if (magnitude >= 5) return { priority: "exceptional", band: 3 };
    return { priority: "exceptional", band: 2 };
  }

  async evaluateMarketObservations(
    observations: readonly ValidatedMarketObservation[],
  ): Promise<MarketPulseMovementCandidate[]> {
    return this.exclusive(async () => {
      const now = this.now();
      const state = await this.loadedState(now);
      const validated = this.validatedObservations(observations, now);
      const highWater = new Map(state.movementHighWater.map((entry) => [entry.key, entry]));
      const detectedAt = new Date(now).toISOString();
      const candidates: MarketPulseMovementCandidate[] = [];

      const breadthGroups = (["up", "down"] as const).map((direction) => {
        const members = validated.filter((observation) => {
          return observation.breadthEligible &&
            Math.abs(observation.sessionChangePercent) >= this.breadthThresholdPercent &&
            (direction === "up" ? observation.sessionChangePercent > 0 : observation.sessionChangePercent < 0);
        });
        return {
          direction,
          members,
          regions: new Set(members.map((member) => member.region)).size,
          magnitude: members.reduce((maximum, member) =>
            Math.max(maximum, Math.abs(member.sessionChangePercent)), 0),
        };
      }).filter((group) =>
        group.members.length >= this.breadthMinimumIndexes && group.regions >= this.breadthMinimumRegions,
      ).sort((left, right) =>
        right.members.length - left.members.length || right.magnitude - left.magnitude,
      );

      const broad = breadthGroups[0];
      let broadDirection: "up" | "down" | undefined;
      if (broad) {
        broadDirection = broad.direction;
        const latestObservationAt = broad.members.reduce(
          (latest, member) => Math.max(latest, Date.parse(member.observedAt)),
          0,
        );
        const episodeDate = new Date(latestObservationAt).toISOString().slice(0, 10);
        const episodeKey = `breadth:${hashKey(`${broad.direction}:${episodeDate}`)}`;
        const severityBand = Math.max(2, this.movementBand(broad.magnitude)?.band ?? 2);
        const previousBand = highWater.get(episodeKey)?.severityBand ?? 0;
        const expiresAt = now + SEEN_RETENTION_MS;
        if (severityBand > previousBand) {
          const stateEntry = { key: episodeKey, severityBand, expiresAt };
          highWater.set(episodeKey, stateEntry);
          candidates.push({
            origin: "validated_market_observation",
            priority: "exceptional",
            id: `market-breadth:${hashKey(`${episodeKey}:${severityBand}`)}`,
            detectedAt,
            direction: broad.direction,
            scope: "broad_market",
            severityBand,
            observations: broad.members
              .sort((left, right) => Math.abs(right.sessionChangePercent) - Math.abs(left.sessionChangePercent))
              .slice(0, 8)
              .map(({ breadthEligible: _breadthEligible, ...member }) => member),
          });
        }
        // Once breadth has explained a same-direction move, newly arriving
        // members must not reopen the same episode as separate index alerts.
        for (const member of broad.members) {
          const memberKey = `movement:${hashKey(`${member.instrumentId}:${member.sessionId}`)}`;
          const memberBand = Math.max(2, this.movementBand(Math.abs(member.sessionChangePercent))?.band ?? 2);
          const prior = highWater.get(memberKey);
          if (!prior || prior.severityBand < memberBand) {
            highWater.set(memberKey, { key: memberKey, severityBand: memberBand, expiresAt });
          }
        }
      }

      for (const observation of validated
        .sort((left, right) => Math.abs(right.sessionChangePercent) - Math.abs(left.sessionChangePercent))) {
        const direction = observation.sessionChangePercent > 0 ? "up" : "down";
        if (broadDirection === direction) continue;
        const severity = this.movementBand(Math.abs(observation.sessionChangePercent));
        if (!severity) continue;
        const episodeKey = `movement:${hashKey(`${observation.instrumentId}:${observation.sessionId}`)}`;
        const previousBand = highWater.get(episodeKey)?.severityBand ?? 0;
        if (severity.band <= previousBand) continue;
        highWater.set(episodeKey, {
          key: episodeKey,
          severityBand: severity.band,
          expiresAt: now + SEEN_RETENTION_MS,
        });
        candidates.push({
          origin: "validated_market_observation",
          priority: severity.priority,
          id: `market-move:${hashKey(`${episodeKey}:${severity.band}`)}`,
          detectedAt,
          direction,
          scope: "single_index",
          severityBand: severity.band,
          observations: [(({ breadthEligible: _breadthEligible, ...member }) => member)(observation)],
        });
        if (candidates.length >= 3) break;
      }

      state.movementHighWater = [...highWater.values()];
      pruneState(state, now);
      await this.store.save(structuredClone(state));
      return candidates.slice(0, 3);
    });
  }

  async collect(
    observations: readonly ValidatedMarketObservation[] = [],
  ): Promise<MarketPulseCandidate[]> {
    const [feeds, movements] = await Promise.all([
      this.pollOfficialFeeds(),
      this.evaluateMarketObservations(observations),
    ]);
    return [...movements, ...feeds];
  }

  async diagnostics(): Promise<MarketPulseFeedDiagnostics[]> {
    return this.exclusive(async () => {
      const now = this.now();
      const state = await this.loadedState(now);
      return MARKET_PULSE_FEEDS
        .filter((feed) => this.enabledFeedIds.includes(feed.id))
        .map((feed) => {
          const current = state.feeds[feed.id];
          return {
            feedId: feed.id,
            nextPollAt: current?.nextPollAt ?? 0,
            consecutiveFailures: current?.consecutiveFailures ?? 0,
            ...(current?.lastSuccessAt !== undefined ? { lastSuccessAt: current.lastSuccessAt } : {}),
            ...(current?.lastFailureAt !== undefined ? { lastFailureAt: current.lastFailureAt } : {}),
            hasValidator: Boolean(current?.etag || current?.lastModified),
          };
        });
    });
  }
}
