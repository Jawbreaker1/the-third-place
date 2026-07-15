import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOOTBALL_COMPETITION_CATALOG,
  FOOTBALL_COMPETITION_IDS,
  FOOTBALL_DATA_VIEWS,
  isFootballCompetitionId,
  isFootballDataView,
} from "./footballData/catalog.js";
import {
  FootballCompetitionProvider,
  type FootballCompetitionSnapshot,
} from "./footballCompetition.js";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");
const RAW_DATA_URL =
  "https://raw.githubusercontent.com/upbound-web/worldcup-live.json/master/2026/worldcup.json";
const SOURCE_PAGE_URL =
  "https://github.com/upbound-web/worldcup-live.json/blob/master/2026/worldcup.json";

interface ProviderScore {
  ht?: [number, number];
  ft?: [number, number];
  et?: [number, number];
  p?: [number, number];
}

interface ProviderFixture {
  round: string;
  date: string;
  time: string;
  team1: string;
  team2: string;
  score?: ProviderScore | null;
  group?: string | null;
  ground: string;
}

interface ProviderTournament {
  name: "World Cup 2026";
  matches: ProviderFixture[];
  [key: string]: unknown;
}

const groupPairs = [
  [0, 1],
  [2, 3],
  [0, 2],
  [1, 3],
  [0, 3],
  [1, 2],
] as const;

const groupAScores: ProviderScore[] = [
  { ht: [1, 0], ft: [2, 0] },
  { ht: [0, 0], ft: [1, 1] },
  { ht: [0, 1], ft: [0, 1] },
  { ht: [1, 0], ft: [3, 0] },
  { ht: [1, 0], ft: [1, 0] },
  { ht: [1, 1], ft: [2, 2] },
];

const isoDay = (start: string, dayOffset: number): string => {
  const value = new Date(`${start}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + dayOffset);
  return value.toISOString().slice(0, 10);
};

/**
 * Generates the provider's complete 48-team/104-fixture shape. The first
 * 72 rows are twelve four-team round robins; the remaining 32 are bounded
 * knockout fixtures. A few late rows deliberately straddle Stockholm's
 * midnight so `today` cannot accidentally use the provider-local date.
 */
const completeTournament = (): ProviderTournament => {
  const matches: ProviderFixture[] = [];
  for (let groupIndex = 0; groupIndex < 12; groupIndex += 1) {
    const letter = String.fromCharCode("A".charCodeAt(0) + groupIndex);
    const names = groupIndex === 0
      ? ["Team Alpha", "Team Bravo", "Team Charlie", "Team Delta"]
      : Array.from({ length: 4 }, (_, index) => `Group ${letter} Team ${index + 1}`);
    for (const [pairIndex, [home, away]] of groupPairs.entries()) {
      const fixtureIndex = matches.length;
      matches.push({
        round: "Group stage",
        date: isoDay("2026-06-11", Math.floor(fixtureIndex / 3)),
        time: `${String(12 + fixtureIndex % 8).padStart(2, "0")}:00 UTC-4`,
        team1: names[home]!,
        team2: names[away]!,
        score: groupIndex === 0
          ? groupAScores[pairIndex]
          : { ht: [fixtureIndex % 2, 0], ft: [fixtureIndex % 3, (fixtureIndex + 1) % 2] },
        group: `Group ${letter}`,
        ground: `Group venue ${letter}`,
      });
    }
  }

  for (let knockoutIndex = 0; knockoutIndex < 32; knockoutIndex += 1) {
    const fixtureIndex = matches.length;
    matches.push({
      round: knockoutIndex < 16 ? "Round of 32" : knockoutIndex < 24 ? "Round of 16" : "Knockout",
      date: isoDay("2026-07-05", Math.floor(knockoutIndex / 4)),
      time: `${String(12 + knockoutIndex % 8).padStart(2, "0")}:00 UTC-4`,
      team1: `Knockout Home ${knockoutIndex + 1}`,
      team2: `Knockout Away ${knockoutIndex + 1}`,
      score: { ht: [0, 0], ft: [1 + knockoutIndex % 2, knockoutIndex % 2] },
      group: null,
      ground: `Knockout venue ${knockoutIndex + 1}`,
    });
    expect(fixtureIndex).toBe(72 + knockoutIndex);
  }

  matches[72] = {
    ...matches[72]!,
    score: { ht: [0, 0], ft: [1, 1], et: [2, 2], p: [5, 4] },
  };
  matches[96] = {
    ...matches[96]!,
    date: "2026-07-14",
    time: "23:30 UTC-4",
    score: { ht: [1, 0], ft: [2, 0] },
  };
  matches[97] = {
    ...matches[97]!,
    date: "2026-07-15",
    time: "00:30 UTC+9",
    score: { ht: [0, 0], ft: [1, 0] },
  };
  matches[98] = {
    ...matches[98]!,
    date: "2026-07-15",
    time: "08:00 UTC-4",
    score: null,
  };
  matches[99] = {
    ...matches[99]!,
    date: "2026-07-15",
    time: "16:00 UTC-4",
    score: null,
  };
  for (let index = 100; index < 104; index += 1) {
    matches[index] = {
      ...matches[index]!,
      date: `2026-07-${String(index - 84).padStart(2, "0")}`,
      time: "16:00 UTC-4",
      score: null,
    };
  }

  expect(matches).toHaveLength(104);
  return {
    name: "World Cup 2026",
    matches,
    providerRevision: "additive fields are intentionally ignored",
  };
};

const jsonResponse = (
  payload: unknown,
  options: {
    status?: number;
    contentType?: string;
    contentLength?: string;
  } = {},
): Response => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json; charset=utf-8",
  });
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return new Response(body, { status: options.status ?? 200, headers });
};

const successfulFetcher = (
  requested: Array<{ url: string; init?: RequestInit }> = [],
  tournament: ProviderTournament = completeTournament(),
): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  requested.push({ url: String(input), init });
  return jsonResponse(tournament);
}) as typeof fetch;

const provider = (
  overrides: ConstructorParameters<typeof FootballCompetitionProvider>[0] = {},
): FootballCompetitionProvider => new FootballCompetitionProvider({
  now: () => NOW,
  fetcher: successfulFetcher(),
  ...overrides,
});

const expectSnapshot = (
  value: FootballCompetitionSnapshot | undefined,
): FootballCompetitionSnapshot => {
  expect(value).toBeDefined();
  return value!;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("football competition catalog", () => {
  it("exposes one canonical competition and a closed typed view inventory", () => {
    expect(FOOTBALL_COMPETITION_IDS).toEqual(["FIFA_WC_2026"]);
    expect(FOOTBALL_DATA_VIEWS).toEqual([
      "overview",
      "today",
      "recent_results",
      "upcoming",
      "standings",
    ]);
    expect(FOOTBALL_COMPETITION_CATALOG.FIFA_WC_2026).toEqual({
      displayName: "FIFA World Cup 2026",
      semanticDescription: "the 2026 men's World Cup hosted by Canada, Mexico and the United States",
    });
    expect(isFootballCompetitionId("FIFA_WC_2026")).toBe(true);
    expect(isFootballCompetitionId("WORLD_CUP")).toBe(false);
    expect(isFootballCompetitionId(2026)).toBe(false);
    for (const view of FOOTBALL_DATA_VIEWS) expect(isFootballDataView(view)).toBe(true);
    expect(isFootballDataView("fixtures")).toBe(false);
    expect(isFootballDataView(null)).toBe(false);
  });
});

describe("strict 104-fixture football provider contract", () => {
  it("normalizes the complete provider payload, source attribution, offsets and tournament metadata", async () => {
    const requested: Array<{ url: string; init?: RequestInit }> = [];
    const result = expectSnapshot(await new FootballCompetitionProvider({
      now: () => NOW,
      fetcher: successfulFetcher(requested),
    }).snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: "guest-1" }));

    expect(result).toMatchObject({
      provider: "openfootball-live",
      targetId: "FIFA_WC_2026",
      competition: {
        name: "FIFA World Cup 2026",
        startDate: "2026-06-11",
        endDate: "2026-07-19",
        hosts: ["Canada", "Mexico", "United States"],
        teams: 48,
        scheduledMatches: 104,
        lifecycle: "ongoing",
      },
      retrievedAt: "2026-07-15T12:00:00.000Z",
      sourceUrl: SOURCE_PAGE_URL,
      latency: "community-updated-within-hours-not-live",
      displayTimeZone: "Europe/Stockholm",
      coverage: {
        totalMatches: 104,
        matchingMatches: 104,
        finished: 98,
        awaitingResult: 1,
        scheduled: 5,
      },
    });
    expect(result.recentResults).toHaveLength(8);
    expect(result.awaitingResults).toHaveLength(1);
    expect(result.upcomingMatches).toHaveLength(5);
    expect(result.groupStandings).toHaveLength(12);
    expect(result.recentResults.every((match) => match.status === "finished")).toBe(true);
    expect(result.awaitingResults.every((match) => match.status === "awaiting_result")).toBe(true);
    expect(result.upcomingMatches.every((match) => match.status === "scheduled")).toBe(true);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.url).toBe(RAW_DATA_URL);
    expect(requested[0]?.init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json, text/plain;q=0.9" },
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves halftime, fulltime, extra-time and penalty score layers", async () => {
    const result = expectSnapshot(await provider().snapshot({
      targetId: "FIFA_WC_2026",
      view: "recent_results",
      focus: "Knockout Home 1",
      requesterId: "scores",
    }));

    expect(result.recentResults).toEqual([expect.objectContaining({
      status: "finished",
      homeTeam: "Knockout Home 1",
      awayTeam: "Knockout Away 1",
      score: {
        halftime: [0, 0],
        fulltime: [1, 1],
        extraTime: [2, 2],
        penalties: [5, 4],
      },
    })]);
  });

  it.each([103, 105])("rejects a provider payload with %i rather than exactly 104 fixtures", async (count) => {
    const tournament = completeTournament();
    if (count < tournament.matches.length) tournament.matches.length = count;
    while (tournament.matches.length < count) {
      const index = tournament.matches.length;
      tournament.matches.push({
        round: "Synthetic overflow",
        date: "2026-07-19",
        time: `${String(index % 24).padStart(2, "0")}:30 UTC+0`,
        team1: `Overflow Home ${index}`,
        team2: `Overflow Away ${index}`,
        ground: "Overflow venue",
      });
    }
    await expect(provider({ fetcher: successfulFetcher([], tournament) }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: `count-${count}`,
    })).rejects.toThrow("payload failed schema validation");
  });

  it("accepts additive unused provider fields while rejecting malformed consumed fields", async () => {
    const additive = completeTournament();
    additive.matches[0] = { ...additive.matches[0]!, unusedProviderFact: "ignored" } as ProviderFixture;
    await expect(provider({ fetcher: successfulFetcher([], additive) }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: "additive",
    })).resolves.toBeDefined();

    const malformedCases: Array<[string, (fixture: ProviderFixture) => void]> = [
      ["date", (fixture) => { fixture.date = "2026-02-30"; }],
      ["time", (fixture) => { fixture.time = "12:00Z"; }],
      ["blank team", (fixture) => { fixture.team1 = "   "; }],
      ["unsafe team", (fixture) => { fixture.team2 = "Team\u202eName"; }],
      ["score tuple", (fixture) => { fixture.score = { ft: [1, 100] }; }],
      ["score integer", (fixture) => { fixture.score = { ft: [1, 1.5] }; }],
      ["venue", (fixture) => { fixture.ground = ""; }],
    ];
    for (const [label, mutate] of malformedCases) {
      const tournament = completeTournament();
      mutate(tournament.matches[0]!);
      await expect(provider({ fetcher: successfulFetcher([], tournament) }).snapshot({
        targetId: "FIFA_WC_2026",
        view: "overview",
        requesterId: `malformed-${label}`,
      }), label).rejects.toThrow("payload failed schema validation");
    }
  });

  it("fails closed for duplicate fixture identity even when other fields differ", async () => {
    const tournament = completeTournament();
    tournament.matches[1] = {
      ...tournament.matches[1]!,
      date: tournament.matches[0]!.date,
      time: tournament.matches[0]!.time,
      team1: tournament.matches[0]!.team1,
      team2: tournament.matches[0]!.team2,
      ground: "A different venue must not make the fixture unique",
    };
    await expect(provider({ fetcher: successfulFetcher([], tournament) }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: "duplicates",
    })).rejects.toThrow("duplicate fixtures");
  });

  it("fails the complete payload when any normalized kickoff escapes the tournament boundary", async () => {
    const tournament = completeTournament();
    tournament.matches[0] = {
      ...tournament.matches[0]!,
      date: "2026-06-11",
      time: "00:00 UTC+14",
    };
    await expect(provider({ fetcher: successfulFetcher([], tournament) }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: "bad-kickoff",
    })).rejects.toThrow("invalid kickoff");
  });
});

describe("football snapshot views, focus and time-zone behavior", () => {
  it("projects overview, recent-results, upcoming and standings without changing truthful coverage", async () => {
    const service = provider();
    const overview = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "views",
    }));
    const recent = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "recent_results", requesterId: "views",
    }));
    const upcoming = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "upcoming", requesterId: "views",
    }));
    const standings = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "standings", requesterId: "views",
    }));

    expect(overview.coverage).toEqual(recent.coverage);
    expect(overview.coverage).toEqual(upcoming.coverage);
    expect(overview.coverage).toEqual(standings.coverage);
    expect(recent).toMatchObject({
      recentResults: expect.any(Array),
      awaitingResults: [],
      upcomingMatches: [],
      groupStandings: [],
    });
    expect(recent.recentResults).toHaveLength(12);
    expect(upcoming).toMatchObject({
      recentResults: [],
      awaitingResults: [],
      groupStandings: [],
    });
    expect(upcoming.upcomingMatches).toHaveLength(5);
    expect(standings).toMatchObject({
      recentResults: [],
      awaitingResults: [],
      upcomingMatches: [],
    });
    expect(standings.groupStandings).toHaveLength(12);
  });

  it("computes provisional group standings from fulltime group scores only", async () => {
    const result = expectSnapshot(await provider().snapshot({
      targetId: "FIFA_WC_2026",
      view: "standings",
      focus: "Group A",
      requesterId: "table",
    }));

    expect(result.coverage.matchingMatches).toBe(6);
    expect(result.groupStandings).toEqual([{
      group: "Group A",
      rankingBasis: "provisional_points_goal_difference_goals_for",
      rows: [
        { position: 1, team: "Team Alpha", played: 3, won: 2, drawn: 0, lost: 1, goalsFor: 3, goalsAgainst: 1, goalDifference: 2, points: 6 },
        { position: 2, team: "Team Charlie", played: 3, won: 1, drawn: 2, lost: 0, goalsFor: 4, goalsAgainst: 3, goalDifference: 1, points: 5 },
        { position: 3, team: "Team Bravo", played: 3, won: 1, drawn: 1, lost: 1, goalsFor: 5, goalsAgainst: 4, goalDifference: 1, points: 4 },
        { position: 4, team: "Team Delta", played: 3, won: 0, drawn: 1, lost: 2, goalsFor: 1, goalsAgainst: 5, goalDifference: -4, points: 1 },
      ],
    }]);
  });

  it("narrows only by an exact case-insensitive team or group and retains the complete relevant table", async () => {
    const service = provider();
    const team = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      focus: "  team ALPHA  ",
      requesterId: "focus",
    }));
    expect(team.focus).toBe("team ALPHA");
    expect(team.coverage).toMatchObject({ totalMatches: 104, matchingMatches: 3, finished: 3 });
    expect(team.groupStandings).toHaveLength(1);
    expect(team.groupStandings[0]?.rows).toHaveLength(4);
    expect([...team.recentResults, ...team.awaitingResults, ...team.upcomingMatches]
      .every((match) => [match.homeTeam, match.awayTeam].includes("Team Alpha"))).toBe(true);

    const group = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      focus: "group a",
      requesterId: "focus",
    }));
    expect(group.coverage.matchingMatches).toBe(6);
    expect(group.groupStandings.map((table) => table.group)).toEqual(["Group A"]);

    await expect(service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      focus: "Alpha",
      requesterId: "focus",
    })).resolves.toBeUndefined();
    await expect(service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      focus: "unknown team",
      requesterId: "focus",
    })).resolves.toBeUndefined();
  });

  it("uses the configured display time zone for today instead of the provider-local calendar date", async () => {
    const result = expectSnapshot(await provider().snapshot({
      targetId: "FIFA_WC_2026",
      view: "today",
      requesterId: "today",
    }));
    const matches = [...result.recentResults, ...result.awaitingResults, ...result.upcomingMatches];

    expect(matches.map((match) => match.homeTeam)).toEqual([
      "Knockout Home 25",
      "Knockout Home 27",
      "Knockout Home 28",
    ]);
    expect(matches.map((match) => match.status)).toEqual(["finished", "awaiting_result", "scheduled"]);
    expect(matches.map((match) => match.kickoffUtc)).toEqual([
      "2026-07-15T03:30:00.000Z",
      "2026-07-15T12:00:00.000Z",
      "2026-07-15T20:00:00.000Z",
    ]);
    expect(matches.some((match) => match.homeTeam === "Knockout Home 26")).toBe(false);
    expect(result.groupStandings).toEqual([]);
  });

  it("changes the today projection when the configured IANA display zone crosses a different date", async () => {
    const result = expectSnapshot(await provider({ displayTimeZone: "America/Los_Angeles" }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "today",
      requesterId: "pacific-today",
    }));
    const matches = [...result.recentResults, ...result.awaitingResults, ...result.upcomingMatches];

    expect(result.displayTimeZone).toBe("America/Los_Angeles");
    expect(matches.map((match) => match.homeTeam)).toEqual([
      "Knockout Home 27",
      "Knockout Home 28",
    ]);
    expect(matches.some((match) => match.homeTeam === "Knockout Home 25")).toBe(false);
    expect(matches.some((match) => match.homeTeam === "Knockout Home 26")).toBe(false);
  });

  it.each([
    ["2026-06-10T23:59:59.000Z", "upcoming"],
    ["2026-06-11T00:00:00.000Z", "ongoing"],
    ["2026-07-19T23:59:59.000Z", "ongoing"],
    ["2026-07-20T00:00:00.000Z", "completed"],
  ] as const)("derives lifecycle at %s as %s", async (instant, lifecycle) => {
    const at = Date.parse(instant);
    const result = expectSnapshot(await provider({ now: () => at }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: instant,
    }));
    expect(result.competition.lifecycle).toBe(lifecycle);
  });

  it("rejects invalid targets, views, focus and display time zones before provider work", async () => {
    const fetcher = vi.fn(async () => jsonResponse(completeTournament())) as unknown as typeof fetch;
    const service = provider({ fetcher });
    await expect(service.snapshot({
      targetId: "OTHER" as "FIFA_WC_2026",
      view: "overview",
    })).resolves.toBeUndefined();
    await expect(service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "fixtures" as "overview",
    })).resolves.toBeUndefined();
    await expect(service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      focus: "!",
    })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => provider({ displayTimeZone: "Not/A_Time_Zone" })).toThrow(TypeError);
  });
});

describe("football provider caching, single-flight and bounded rate limits", () => {
  it("reuses cache across views, expires it at the TTL and refreshes retrievedAt", async () => {
    let now = NOW;
    const fetcher = vi.fn(async () => jsonResponse(completeTournament())) as unknown as typeof fetch;
    const service = provider({ now: () => now, fetcher, cacheTtlMs: 1_000 });

    const first = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "cache",
    }));
    now += 999;
    const cached = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "standings", requesterId: "cache",
    }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cached.retrievedAt).toBe(first.retrievedAt);

    now += 1;
    const refreshed = expectSnapshot(await service.snapshot({
      targetId: "FIFA_WC_2026", view: "upcoming", requesterId: "cache",
    }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.retrievedAt).toBe(new Date(now).toISOString());
  });

  it("deduplicates concurrent cold loads across requesters and views", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => {
      await gate;
      return jsonResponse(completeTournament());
    }) as unknown as typeof fetch;
    const service = provider({ fetcher });

    const overview = service.snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "one",
    });
    const standings = service.snapshot({
      targetId: "FIFA_WC_2026", view: "standings", requesterId: "two",
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([overview, standings])).resolves.toEqual([
      expect.objectContaining({ view: "overview" }),
      expect.objectContaining({ view: "standings" }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bypasses a completed cache but still single-flights concurrent bypass refreshes", async () => {
    let fetchCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetcher = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 2) await refreshGate;
      return jsonResponse(completeTournament());
    }) as unknown as typeof fetch;
    const service = provider({ fetcher });

    await service.snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: "initial" });
    await service.snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: "cached" });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const firstBypass = service.snapshot({
      targetId: "FIFA_WC_2026", view: "recent_results", requesterId: "bypass-1", cachePolicy: "bypass",
    });
    const secondBypass = service.snapshot({
      targetId: "FIFA_WC_2026", view: "upcoming", requesterId: "bypass-2", cachePolicy: "bypass",
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releaseRefresh();
    await expect(Promise.all([firstBypass, secondBypass])).resolves.toEqual([
      expect.objectContaining({ view: "recent_results" }),
      expect.objectContaining({ view: "upcoming" }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("enforces normalized per-requester limits and resets the window", async () => {
    let now = NOW;
    const fetcher = vi.fn(async () => jsonResponse(completeTournament())) as unknown as typeof fetch;
    const service = provider({
      now: () => now,
      fetcher,
      rateWindowMs: 1_000,
      perRequesterLimit: 2,
      globalLimit: 100,
    });

    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: " Alice " }))
      .resolves.toBeDefined();
    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "today", requesterId: "alice" }))
      .resolves.toBeDefined();
    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "standings", requesterId: "ALICE" }))
      .resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 1_000;
    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "standings", requesterId: "alice" }))
      .resolves.toBeDefined();
  });

  it("enforces the global request limit even across distinct requesters", async () => {
    const service = provider({ perRequesterLimit: 10, globalLimit: 2 });
    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: "one" }))
      .resolves.toBeDefined();
    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: "two" }))
      .resolves.toBeDefined();
    await expect(service.snapshot({ targetId: "FIFA_WC_2026", view: "overview", requesterId: "three" }))
      .resolves.toBeUndefined();
  });

  it("bounds requester buckets and evicts the least recently touched identity", async () => {
    const service = provider({
      perRequesterLimit: 1,
      globalLimit: 100,
      maxRequesterBuckets: 16,
    });
    for (let index = 0; index < 17; index += 1) {
      await expect(service.snapshot({
        targetId: "FIFA_WC_2026",
        view: "overview",
        requesterId: `requester-${index}`,
      })).resolves.toBeDefined();
    }
    await expect(service.snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: "requester-0",
    })).resolves.toBeDefined();
  });
});

describe("football provider transport and body safety", () => {
  it.each([
    ["HTTP status", () => jsonResponse({}, { status: 503 })],
    ["content type", () => jsonResponse({}, { contentType: "text/html" })],
    ["invalid content length", () => jsonResponse({}, { contentLength: "12x" })],
    ["announced oversized body", () => jsonResponse({}, { contentLength: "256001" })],
  ] as const)("rejects invalid %s", async (_label, response) => {
    const fetcher = (async () => response()) as unknown as typeof fetch;
    await expect(provider({ fetcher }).snapshot({
      targetId: "FIFA_WC_2026",
      view: "overview",
      requesterId: `transport-${_label}`,
    })).rejects.toThrow(/transport validation|content length|byte limit/u);
  });

  it("accepts bounded text/plain JSON and structured +json media types", async () => {
    for (const contentType of ["text/plain; charset=utf-8", "application/vnd.worldcup+json"]) {
      const fetcher = (async () => jsonResponse(completeTournament(), { contentType })) as unknown as typeof fetch;
      await expect(provider({ fetcher }).snapshot({
        targetId: "FIFA_WC_2026",
        view: "overview",
        requesterId: contentType,
      })).resolves.toBeDefined();
    }
  });

  it("rejects malformed JSON, invalid UTF-8 and an actually oversized streamed body", async () => {
    const malformed = (async () => jsonResponse("{not-json")) as unknown as typeof fetch;
    await expect(provider({ fetcher: malformed }).snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "bad-json",
    })).rejects.toThrow(SyntaxError);

    const invalidUtf8 = (async () => new Response(new Uint8Array([0xff, 0xfe]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    await expect(provider({ fetcher: invalidUtf8 }).snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "bad-utf8",
    })).rejects.toThrow();

    const oversized = (async () => new Response(`"${"x".repeat(256_001)}"`, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    await expect(provider({ fetcher: oversized }).snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "actual-large",
    })).rejects.toThrow("byte limit");
  });

  it("propagates a bounded fetch failure without caching it and permits the next retry", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(jsonResponse(completeTournament())) as unknown as typeof fetch;
    const service = provider({ fetcher });

    await expect(service.snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "retry",
    })).rejects.toThrow("network unavailable");
    await expect(service.snapshot({
      targetId: "FIFA_WC_2026", view: "overview", requesterId: "retry",
    })).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
