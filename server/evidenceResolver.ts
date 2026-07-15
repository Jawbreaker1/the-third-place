import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import type { PageReadRequest } from "./pageReader.js";
import type {
  ResearchPacket,
  ResearchResult,
  ResearchSearchMetadata,
} from "./researchBroker.js";
import { validatePublicHttpsUrl } from "./safeHttpsFetch.js";

const MAX_QUERY_LENGTH = 240;
const MAX_PAGE_INTENT_LENGTH = 160;
const MAX_RESULT_ID_LENGTH = 40;
const MAX_RESULT_TITLE_LENGTH = 180;
const MAX_RESULT_SNIPPET_LENGTH = 4_500;
const MAX_SEARCH_RESULTS = 5;
const MAX_EXPANDED_PAGES = 2;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

export type EvidenceReadiness = "retrieved" | "answerable";

/** The deliberately small surface needed from PageReader. */
export interface EvidencePageReader {
  read(request: PageReadRequest, requesterId: string): Promise<ResearchPacket | undefined>;
}

export interface ResolveSearchEvidenceInput {
  packet: ResearchPacket;
  semanticGoal: string;
  requesterId: string;
  now: number;
  pageReader: EvidencePageReader;
}

export interface ResolvedSearchEvidence {
  packet: ResearchPacket;
  readiness: EvidenceReadiness;
  attemptedPages: number;
  readPages: number;
}

interface ReadCandidate {
  url: URL;
  publishedAt?: string;
}

interface AcceptedPage {
  packet: ResearchPacket;
  result: ResearchResult;
}

const boundedText = (value: string, maxLength: number): string =>
  stripDangerousTextControls(value.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);

const safeInstant = (value: string | undefined, now: number): string | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now + FUTURE_TIMESTAMP_TOLERANCE_MS) return undefined;
  return new Date(parsed).toISOString();
};

const requestedAtFor = (now: number): string => {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  return new Date(safeNow).toISOString();
};

const boundedSearchMetadata = (
  search: ResearchSearchMetadata | undefined,
): ResearchSearchMetadata | undefined => {
  if (!search) return undefined;
  if (search.scope === "generic") {
    return {
      scope: "generic",
      requestedMode: search.requestedMode,
      providerMode: search.providerMode,
    };
  }
  const host = boundedText(search.site?.host ?? "", 253);
  if (!host || !search.site) return undefined;
  return {
    scope: "site",
    requestedMode: search.requestedMode,
    providerMode: search.providerMode,
    site: {
      host,
      quality: { ...search.site.quality },
    },
  };
};

const boundedPacket = (packet: ResearchPacket, now: number): ResearchPacket => {
  const results = packet.results.flatMap((result) => {
    const url = validatePublicHttpsUrl(result.url);
    if (!url) return [];
    const id = boundedText(result.id, MAX_RESULT_ID_LENGTH);
    if (!id) return [];
    const publishedAt = safeInstant(result.publishedAt, now);
    return [{
      id,
      title: boundedText(result.title, MAX_RESULT_TITLE_LENGTH),
      url: url.toString(),
      snippet: boundedText(result.snippet, MAX_RESULT_SNIPPET_LENGTH),
      ...(publishedAt ? { publishedAt } : {}),
    }];
  }).slice(0, MAX_SEARCH_RESULTS);
  const retrievedAt = safeInstant(packet.retrievedAt, now) ?? requestedAtFor(now);
  const search = boundedSearchMetadata(packet.search);
  return {
    ...(packet.kind ? { kind: packet.kind } : {}),
    query: boundedText(packet.query, MAX_QUERY_LENGTH),
    retrievedAt,
    results,
    ...(search ? { search } : {}),
  };
};

const genericReadCandidates = (packet: ResearchPacket): ReadCandidate[] => {
  const seen = new Set<string>();
  const candidates: ReadCandidate[] = [];
  for (const result of packet.results) {
    const url = validatePublicHttpsUrl(result.url);
    if (!url || seen.has(url.toString())) continue;
    seen.add(url.toString());
    candidates.push({
      url,
      ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    });
    if (candidates.length >= MAX_EXPANDED_PAGES) break;
  }
  return candidates;
};

const readCandidate = async (
  candidate: ReadCandidate,
  request: PageReadRequest,
  requesterId: string,
  pageReader: EvidencePageReader,
  now: number,
): Promise<AcceptedPage | undefined> => {
  try {
    const page = await pageReader.read({ ...request, url: candidate.url }, requesterId);
    if (page?.kind !== "page") return undefined;
    const source = page.results.find((result) => result.id === "S1");
    // PageReader binds evidence to the originally requested URL. Never accept
    // an injected or redirected result under the selected search source ID.
    if (!source || source.url !== candidate.url.toString()) return undefined;
    const snippet = boundedText(source.snippet, MAX_RESULT_SNIPPET_LENGTH);
    if (!snippet) return undefined;
    const publishedAt = safeInstant(source.publishedAt ?? candidate.publishedAt, now);
    return {
      packet: page,
      result: {
        id: "S1",
        title: boundedText(source.title, MAX_RESULT_TITLE_LENGTH),
        url: candidate.url.toString(),
        snippet,
        ...(publishedAt ? { publishedAt } : {}),
      },
    };
  } catch {
    return undefined;
  }
};

/**
 * Expands a generic search result into bounded, safely-read page evidence.
 * Intent classification remains upstream; this function contains no wording,
 * language, site or provider heuristics.
 */
export const resolveSearchEvidence = async (
  input: ResolveSearchEvidenceInput,
): Promise<ResolvedSearchEvidence> => {
  const bounded = boundedPacket(input.packet, input.now);
  const packetKind = input.packet.kind ?? "search";
  if (packetKind === "page") {
    return {
      packet: bounded,
      readiness: bounded.results.length > 0 ? "answerable" : "retrieved",
      attemptedPages: 0,
      readPages: 0,
    };
  }
  if (packetKind !== "search") {
    return { packet: bounded, readiness: "retrieved", attemptedPages: 0, readPages: 0 };
  }

  const candidates = genericReadCandidates(input.packet);
  if (candidates.length === 0) {
    return { packet: bounded, readiness: "retrieved", attemptedPages: 0, readPages: 0 };
  }

  const requestedAt = requestedAtFor(input.now);
  const intent = boundedText(input.semanticGoal, MAX_PAGE_INTENT_LENGTH)
    || bounded.query.slice(0, MAX_PAGE_INTENT_LENGTH);
  const request: PageReadRequest = {
    requestedAt,
    intent,
    retry: false,
    source: "message",
    initiator: "automatic",
  };
  const attemptedPages = candidates.length;
  const reads = await Promise.all(candidates.map((candidate) =>
    readCandidate(candidate, request, input.requesterId, input.pageReader, input.now)));
  const accepted = reads.filter((value): value is AcceptedPage => value !== undefined);
  if (accepted.length === 0) {
    return { packet: bounded, readiness: "retrieved", attemptedPages, readPages: 0 };
  }

  const results = accepted.map(({ result }, index) => ({ ...result, id: `S${index + 1}` }));
  const retrievedAt = safeInstant(accepted[0]?.packet.retrievedAt, input.now) ?? requestedAt;
  return {
    packet: {
      kind: "page",
      query: intent,
      retrievedAt,
      results,
    },
    readiness: "answerable",
    attemptedPages,
    readPages: results.length,
  };
};
