import { z } from "zod";
import {
  hasUnsafeControlOrFormat,
  stripDangerousTextControls,
  unicodeCaselessKey,
} from "../shared/unicodeSafety.js";
import {
  isFootballCompetitionId,
  isFootballDataView,
  type FootballCompetitionId,
  type FootballDataView,
} from "./footballData/catalog.js";

const RAW_DATA_URL =
  "https://raw.githubusercontent.com/upbound-web/worldcup-live.json/master/2026/worldcup.json";
const SOURCE_PAGE_URL =
  "https://github.com/upbound-web/worldcup-live.json/blob/master/2026/worldcup.json";
const TOURNAMENT_START = "2026-06-11";
const TOURNAMENT_END = "2026-07-19";
const EXPECTED_MATCH_COUNT = 104;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 2 * 60_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_PER_REQUESTER_LIMIT = 8;
const DEFAULT_GLOBAL_LIMIT = 80;
const DEFAULT_MAX_REQUESTER_BUCKETS = 256;
const MAX_RESPONSE_BYTES = 256_000;

const providerText = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !hasUnsafeControlOrFormat(value));

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

const providerTimeSchema = z.string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d UTC(?:\+|-)(?:\d|1[0-4])$/u);
const scorePairSchema = z.tuple([
  z.number().int().min(0).max(99),
  z.number().int().min(0).max(99),
]);
const scoreSchema = z.object({
  ht: scorePairSchema.optional(),
  ft: scorePairSchema.optional(),
  et: scorePairSchema.optional(),
  p: scorePairSchema.optional(),
});
const providerMatchSchema = z.object({
  round: providerText(80),
  date: isoDateSchema,
  time: providerTimeSchema,
  team1: providerText(120),
  team2: providerText(120),
  score: scoreSchema.nullish(),
  group: providerText(40).nullish(),
  ground: providerText(160),
});
const providerTournamentSchema = z.object({
  name: z.literal("World Cup 2026"),
  matches: z.array(providerMatchSchema).length(EXPECTED_MATCH_COUNT),
});

type ProviderMatch = z.infer<typeof providerMatchSchema>;

export type FootballMatchStatus = "finished" | "awaiting_result" | "scheduled";

export interface FootballScore {
  halftime?: readonly [number, number];
  fulltime?: readonly [number, number];
  extraTime?: readonly [number, number];
  penalties?: readonly [number, number];
}

export interface FootballMatch {
  fixtureKey: string;
  kickoffUtc: string;
  providerLocalDate: string;
  providerLocalTime: string;
  status: FootballMatchStatus;
  round: string;
  group?: string;
  homeTeam: string;
  awayTeam: string;
  score?: FootballScore;
  venue: string;
}

export interface FootballGroupStanding {
  group: string;
  rankingBasis: "provisional_points_goal_difference_goals_for";
  rows: Array<{
    position: number;
    team: string;
    played: number;
    won: number;
    drawn: number;
    lost: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDifference: number;
    points: number;
  }>;
}

export interface FootballCompetitionSnapshot {
  provider: "openfootball-live";
  targetId: FootballCompetitionId;
  competition: {
    name: "FIFA World Cup 2026";
    startDate: typeof TOURNAMENT_START;
    endDate: typeof TOURNAMENT_END;
    hosts: readonly ["Canada", "Mexico", "United States"];
    teams: 48;
    scheduledMatches: 104;
    lifecycle: "upcoming" | "ongoing" | "completed";
  };
  retrievedAt: string;
  sourceUrl: string;
  latency: "community-updated-within-hours-not-live";
  view: FootballDataView;
  displayTimeZone: string;
  focus?: string;
  coverage: {
    totalMatches: number;
    matchingMatches: number;
    finished: number;
    awaitingResult: number;
    scheduled: number;
  };
  recentResults: FootballMatch[];
  awaitingResults: FootballMatch[];
  upcomingMatches: FootballMatch[];
  groupStandings: FootballGroupStanding[];
}

export interface FootballCompetitionRequest {
  targetId: FootballCompetitionId;
  view: FootballDataView;
  /** Optional provider-facing exact team or group alias used only to narrow the fixed competition. */
  focus?: string;
  requesterId?: string;
  cachePolicy?: "default" | "bypass";
}

export interface FootballCompetitionProviderOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  rateWindowMs?: number;
  perRequesterLimit?: number;
  globalLimit?: number;
  maxRequesterBuckets?: number;
  now?: () => number;
  fetcher?: typeof fetch;
  displayTimeZone?: string;
}

interface CachedTournament {
  expiresAt: number;
  retrievedAt: string;
  matches: FootballMatch[];
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
  touchedAt: number;
}

const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number =>
  Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;

const boundedFocus = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const value = stripDangerousTextControls(raw.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return value.length >= 2 && /[\p{L}\p{N}]/u.test(value) && !hasUnsafeControlOrFormat(value)
    ? value
    : undefined;
};

const boundedRequester = (raw: string | undefined): string => {
  const requester = stripDangerousTextControls((raw ?? "anonymous").normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 128);
  return unicodeCaselessKey(requester || "anonymous");
};

const hasJsonLikeContentType = (response: Response): boolean => {
  const value = response.headers.get("content-type")?.toLocaleLowerCase().trim() ?? "";
  return /^(?:application\/(?:[a-z0-9!#$&^_.+-]+\+)?json|text\/plain)(?:\s*;|$)/u.test(value);
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (response.status !== 200 || !hasJsonLikeContentType(response) || !response.body) {
    throw new Error("Football provider response failed transport validation");
  }
  const announced = response.headers.get("content-length");
  if (announced !== null) {
    if (!/^\d+$/u.test(announced)) throw new Error("Football provider returned an invalid content length");
    if (Number(announced) > MAX_RESPONSE_BYTES) {
      throw new Error("Football provider response exceeded the byte limit");
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Football provider response exceeded the byte limit");
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body) as unknown;
};

const kickoffUtc = (date: string, time: string): string | undefined => {
  const match = /^(\d{2}):(\d{2}) UTC(\+|-)(\d{1,2})$/u.exec(time);
  if (!match) return undefined;
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const offsetHours = Number(match[4]) * (match[3] === "+" ? 1 : -1);
  const value = Date.UTC(year!, month! - 1, day!, hour - offsetHours, minute);
  if (!Number.isFinite(value)) return undefined;
  const iso = new Date(value).toISOString();
  return iso.slice(0, 10) >= TOURNAMENT_START && iso.slice(0, 10) <= "2026-07-20"
    ? iso
    : undefined;
};

const normalizedScore = (score: ProviderMatch["score"]): FootballScore | undefined => {
  if (!score) return undefined;
  const normalized: FootballScore = {
    ...(score.ht ? { halftime: score.ht } : {}),
    ...(score.ft ? { fulltime: score.ft } : {}),
    ...(score.et ? { extraTime: score.et } : {}),
    ...(score.p ? { penalties: score.p } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const fixtureKey = (match: ProviderMatch): string =>
  unicodeCaselessKey(`${match.date}|${match.time}|${match.team1}|${match.team2}`).slice(0, 320);

const normalizeMatch = (match: ProviderMatch, now: number): FootballMatch | undefined => {
  const kickoff = kickoffUtc(match.date, match.time);
  if (!kickoff) return undefined;
  const score = normalizedScore(match.score);
  const finished = Boolean(score?.fulltime || score?.extraTime || score?.penalties);
  const status: FootballMatchStatus = finished
    ? "finished"
    : Date.parse(kickoff) <= now
      ? "awaiting_result"
      : "scheduled";
  return {
    fixtureKey: fixtureKey(match),
    kickoffUtc: kickoff,
    providerLocalDate: match.date,
    providerLocalTime: match.time,
    status,
    round: match.round,
    ...(match.group ? { group: match.group } : {}),
    homeTeam: match.team1,
    awayTeam: match.team2,
    ...(score ? { score } : {}),
    venue: match.ground,
  };
};

const compareKickoff = (left: FootballMatch, right: FootballMatch): number =>
  left.kickoffUtc.localeCompare(right.kickoffUtc) || left.fixtureKey.localeCompare(right.fixtureKey);

const lifecycleAt = (now: number): FootballCompetitionSnapshot["competition"]["lifecycle"] => {
  const day = new Date(now).toISOString().slice(0, 10);
  return day < TOURNAMENT_START ? "upcoming" : day > TOURNAMENT_END ? "completed" : "ongoing";
};

const localDateInZone = (now: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const standingTables = (matches: readonly FootballMatch[]): FootballGroupStanding[] => {
  const groups = new Map<string, Map<string, FootballGroupStanding["rows"][number]>>();
  for (const match of matches) {
    if (!match.group || match.status !== "finished" || !match.score?.fulltime) continue;
    const [homeGoals, awayGoals] = match.score.fulltime;
    const table = groups.get(match.group) ?? new Map();
    const home = table.get(match.homeTeam) ?? {
      position: 0, team: match.homeTeam, played: 0, won: 0, drawn: 0, lost: 0,
      goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0,
    };
    const away = table.get(match.awayTeam) ?? {
      position: 0, team: match.awayTeam, played: 0, won: 0, drawn: 0, lost: 0,
      goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0,
    };
    home.played += 1;
    away.played += 1;
    home.goalsFor += homeGoals;
    home.goalsAgainst += awayGoals;
    away.goalsFor += awayGoals;
    away.goalsAgainst += homeGoals;
    if (homeGoals > awayGoals) {
      home.won += 1;
      away.lost += 1;
      home.points += 3;
    } else if (homeGoals < awayGoals) {
      away.won += 1;
      home.lost += 1;
      away.points += 3;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
    home.goalDifference = home.goalsFor - home.goalsAgainst;
    away.goalDifference = away.goalsFor - away.goalsAgainst;
    table.set(home.team, home);
    table.set(away.team, away);
    groups.set(match.group, table);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([group, table]) => ({
      group,
      rankingBasis: "provisional_points_goal_difference_goals_for" as const,
      rows: [...table.values()]
        .sort((left, right) =>
          right.points - left.points ||
          right.goalDifference - left.goalDifference ||
          right.goalsFor - left.goalsFor ||
          left.team.localeCompare(right.team, "en"))
        .map((row, index) => ({ ...row, position: index + 1 })),
    }));
};

const exactFocusSelection = (
  matches: readonly FootballMatch[],
  focus: string | undefined,
): { matches: FootballMatch[]; groups?: Set<string> } | undefined => {
  if (!focus) return { matches: [...matches] };
  const key = unicodeCaselessKey(focus);
  const exactTeams = new Set(matches.flatMap((match) => [match.homeTeam, match.awayTeam])
    .filter((team) => unicodeCaselessKey(team) === key));
  const exactGroups = new Set(matches.flatMap((match) => match.group ? [match.group] : [])
    .filter((group) => unicodeCaselessKey(group) === key));
  if (exactTeams.size === 0 && exactGroups.size === 0) return undefined;
  const selected = matches.filter((match) =>
    exactTeams.has(match.homeTeam) ||
    exactTeams.has(match.awayTeam) ||
    Boolean(match.group && exactGroups.has(match.group)));
  const groups = new Set(selected.flatMap((match) => match.group ? [match.group] : []));
  return { matches: selected, groups };
};

export class FootballCompetitionProvider {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly rateWindowMs: number;
  private readonly perRequesterLimit: number;
  private readonly globalLimit: number;
  private readonly maxRequesterBuckets: number;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly displayTimeZone: string;
  private cache?: CachedTournament;
  private inFlight?: Promise<CachedTournament | undefined>;
  private globalBucket: RateBucket = { windowStartedAt: 0, count: 0, touchedAt: 0 };
  private readonly requesterBuckets = new Map<string, RateBucket>();

  constructor(options: FootballCompetitionProviderOptions = {}) {
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 30_000);
    this.cacheTtlMs = boundedInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1_000, 60 * 60_000);
    this.rateWindowMs = boundedInteger(options.rateWindowMs, DEFAULT_RATE_WINDOW_MS, 1_000, 10 * 60_000);
    this.perRequesterLimit = boundedInteger(
      options.perRequesterLimit,
      DEFAULT_PER_REQUESTER_LIMIT,
      1,
      100,
    );
    this.globalLimit = boundedInteger(options.globalLimit, DEFAULT_GLOBAL_LIMIT, 1, 1_000);
    this.maxRequesterBuckets = boundedInteger(
      options.maxRequesterBuckets,
      DEFAULT_MAX_REQUESTER_BUCKETS,
      16,
      4_096,
    );
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    const displayTimeZone = options.displayTimeZone ?? "Europe/Stockholm";
    try {
      new Intl.DateTimeFormat("en", { timeZone: displayTimeZone }).format(new Date(0));
      this.displayTimeZone = displayTimeZone;
    } catch {
      throw new TypeError("Football displayTimeZone must be a valid IANA time zone");
    }
  }

  async snapshot(request: FootballCompetitionRequest): Promise<FootballCompetitionSnapshot | undefined> {
    if (!isFootballCompetitionId(request.targetId) || !isFootballDataView(request.view)) return undefined;
    const suppliedFocus = request.focus;
    const focus = boundedFocus(suppliedFocus);
    if (suppliedFocus !== undefined && !focus) return undefined;
    const now = this.now();
    if (!this.allow(boundedRequester(request.requesterId), now)) return undefined;
    const dataset = await this.load(request.cachePolicy === "bypass", now);
    if (!dataset) return undefined;
    const selected = exactFocusSelection(dataset.matches, focus);
    if (!selected || selected.matches.length === 0) return undefined;
    const relevant = [...selected.matches].sort(compareKickoff);
    let recentResults = relevant.filter((match) => match.status === "finished").slice(-8);
    let awaitingResults = relevant
      .filter((match) => match.status === "awaiting_result")
      .sort(compareKickoff)
      .slice(-4);
    let upcomingMatches = relevant
      .filter((match) => match.status === "scheduled")
      .sort(compareKickoff)
      .slice(0, 10);
    let tables = standingTables(dataset.matches).filter((table) =>
      !focus || selected.groups?.has(table.group));
    if (request.view === "today") {
      const localDay = localDateInZone(now, this.displayTimeZone);
      const todaysMatches = relevant.filter((match) =>
        localDateInZone(Date.parse(match.kickoffUtc), this.displayTimeZone) === localDay);
      recentResults = todaysMatches.filter((match) => match.status === "finished");
      awaitingResults = todaysMatches.filter((match) => match.status === "awaiting_result");
      upcomingMatches = todaysMatches.filter((match) => match.status === "scheduled");
      tables = [];
    } else if (request.view === "recent_results") {
      recentResults = relevant.filter((match) => match.status === "finished").slice(-12);
      awaitingResults = [];
      upcomingMatches = [];
      tables = [];
    } else if (request.view === "upcoming") {
      recentResults = [];
      awaitingResults = [];
      upcomingMatches = relevant.filter((match) => match.status === "scheduled").slice(0, 12);
      tables = [];
    } else if (request.view === "standings") {
      recentResults = [];
      awaitingResults = [];
      upcomingMatches = [];
    }
    return {
      provider: "openfootball-live",
      targetId: request.targetId,
      competition: {
        name: "FIFA World Cup 2026",
        startDate: TOURNAMENT_START,
        endDate: TOURNAMENT_END,
        hosts: ["Canada", "Mexico", "United States"],
        teams: 48,
        scheduledMatches: EXPECTED_MATCH_COUNT,
        lifecycle: lifecycleAt(now),
      },
      retrievedAt: dataset.retrievedAt,
      sourceUrl: SOURCE_PAGE_URL,
      latency: "community-updated-within-hours-not-live",
      view: request.view,
      displayTimeZone: this.displayTimeZone,
      ...(focus ? { focus } : {}),
      coverage: {
        totalMatches: dataset.matches.length,
        matchingMatches: relevant.length,
        finished: relevant.filter((match) => match.status === "finished").length,
        awaitingResult: relevant.filter((match) => match.status === "awaiting_result").length,
        scheduled: relevant.filter((match) => match.status === "scheduled").length,
      },
      recentResults,
      awaitingResults,
      upcomingMatches,
      groupStandings: tables,
    };
  }

  private allow(requesterId: string, now: number): boolean {
    const increment = (bucket: RateBucket, limit: number): boolean => {
      if (now - bucket.windowStartedAt >= this.rateWindowMs || bucket.windowStartedAt > now) {
        bucket.windowStartedAt = now;
        bucket.count = 0;
      }
      bucket.touchedAt = now;
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    };
    if (!increment(this.globalBucket, this.globalLimit)) return false;
    let requester = this.requesterBuckets.get(requesterId);
    if (!requester) {
      if (this.requesterBuckets.size >= this.maxRequesterBuckets) {
        const oldest = [...this.requesterBuckets.entries()]
          .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]?.[0];
        if (oldest) this.requesterBuckets.delete(oldest);
      }
      requester = { windowStartedAt: now, count: 0, touchedAt: now };
      this.requesterBuckets.set(requesterId, requester);
    }
    return increment(requester, this.perRequesterLimit);
  }

  private async load(bypass: boolean, now: number): Promise<CachedTournament | undefined> {
    if (!bypass && this.cache && this.cache.expiresAt > now) return this.cache;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchTournament(now).finally(() => {
      this.inFlight = undefined;
    });
    const loaded = await this.inFlight;
    if (loaded) this.cache = loaded;
    return loaded;
  }

  private async fetchTournament(now: number): Promise<CachedTournament | undefined> {
    const response = await this.fetcher(RAW_DATA_URL, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json, text/plain;q=0.9" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const parsed = providerTournamentSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) throw new Error("Football provider payload failed schema validation");
    const matches = parsed.data.matches.map((match) => normalizeMatch(match, now));
    if (matches.some((match) => !match)) {
      throw new Error("Football provider contained an invalid kickoff");
    }
    const normalized = matches as FootballMatch[];
    if (new Set(normalized.map((match) => match.fixtureKey)).size !== normalized.length) {
      throw new Error("Football provider contained duplicate fixtures");
    }
    const retrievedAt = new Date(now).toISOString();
    return {
      expiresAt: now + this.cacheTtlMs,
      retrievedAt,
      matches: normalized.sort(compareKickoff),
    };
  }
}
