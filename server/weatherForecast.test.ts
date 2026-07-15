import { describe, expect, it, vi } from "vitest";
import { WeatherForecastProvider } from "./weatherForecast.js";

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(value), {
  status: init.status ?? 200,
  headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
});

const geocodingResult = (overrides: Record<string, unknown> = {}) => ({
  id: 2711537,
  name: "Gothenburg",
  latitude: 57.70716,
  longitude: 11.96679,
  elevation: 10,
  feature_code: "PPLA",
  country_code: "SE",
  admin1_id: 3337385,
  timezone: "Europe/Stockholm",
  population: 587549,
  country_id: 2661886,
  country: "Sweden",
  admin1: "Västra Götaland",
  ...overrides,
});

const geocodingPayload = (results: unknown[] = [geocodingResult()]) => ({
  results,
  generationtime_ms: 0.21,
});

const dates = [
  "2026-07-15",
  "2026-07-16",
  "2026-07-17",
  "2026-07-18",
  "2026-07-19",
  "2026-07-20",
  "2026-07-21",
];

const forecastPayload = (dailyOverrides: Record<string, unknown> = {}) => ({
  latitude: 57.7,
  longitude: 11.95,
  generationtime_ms: 0.34,
  utc_offset_seconds: 7200,
  timezone: "Europe/Stockholm",
  timezone_abbreviation: "CEST",
  elevation: 10,
  daily_units: {
    time: "iso8601",
    temperature_2m_max: "°C",
    temperature_2m_min: "°C",
    precipitation_probability_max: "%",
    precipitation_sum: "mm",
    weather_code: "wmo code",
  },
  daily: {
    time: dates,
    temperature_2m_max: [20, 19, 18, 17, 16, 15, 14],
    temperature_2m_min: [12, 11, 10, 9, 8, 7, 6],
    precipitation_probability_max: [10, 20, 30, 40, 50, 60, 70],
    precipitation_sum: [0, 0.2, 0.5, 1.2, 2.4, 3.1, 4.8],
    weather_code: [0, 1, 2, 3, 61, 63, 65],
    ...dailyOverrides,
  },
});

const successfulFetch = (requested: URL[] = []): typeof fetch => (async (input) => {
  const url = new URL(String(input));
  requested.push(url);
  return url.hostname === "geocoding-api.open-meteo.com"
    ? jsonResponse(geocodingPayload())
    : jsonResponse(forecastPayload());
}) as typeof fetch;

describe("structured weather forecast provider", () => {
  it("resolves a Göteborg-like location and computes a server-owned temperature trend", async () => {
    const requested: URL[] = [];
    const provider = new WeatherForecastProvider(successfulFetch(requested), {
      now: () => Date.parse("2026-07-15T10:00:00.000Z"),
    });

    const result = await provider.forecast({
      location: "  Göteborg\u0000   ",
      requesterId: "human-1",
    });

    expect(result).toEqual({
      provider: "open-meteo",
      query: "Göteborg",
      retrievedAt: "2026-07-15T10:00:00.000Z",
      resolved: {
        place: "Gothenburg",
        country: "Sweden",
        countryCode: "SE",
        admin: "Västra Götaland",
        timezone: "Europe/Stockholm",
        latitude: 57.70716,
        longitude: 11.96679,
      },
      sourceUrl: expect.stringContaining("https://api.open-meteo.com/v1/forecast?"),
      units: {
        temperature: "°C",
        precipitationProbability: "%",
        precipitation: "mm",
        weatherCode: "wmo code",
      },
      daily: expect.arrayContaining([
        {
          date: "2026-07-15",
          temperatureMax: 20,
          temperatureMin: 12,
          precipitationProbabilityMax: 10,
          precipitationSum: 0,
          weatherCode: 0,
        },
      ]),
      temperatureTrend: {
        direction: "cooler",
        change: -6,
        fromDate: "2026-07-15",
        toDate: "2026-07-21",
        basis: "daily_mean_temperature",
        unit: "°C",
      },
    });
    expect(result?.daily).toHaveLength(7);
    expect(Object.isFrozen(result)).toBe(true);
    expect(requested).toHaveLength(2);

    const geocodingUrl = requested[0]!;
    expect([geocodingUrl.protocol, geocodingUrl.hostname, geocodingUrl.pathname]).toEqual([
      "https:",
      "geocoding-api.open-meteo.com",
      "/v1/search",
    ]);
    expect(Object.fromEntries(geocodingUrl.searchParams)).toEqual({
      name: "Göteborg",
      count: "5",
      language: "en",
      format: "json",
    });

    const forecastUrl = requested[1]!;
    expect([forecastUrl.protocol, forecastUrl.hostname, forecastUrl.pathname]).toEqual([
      "https:",
      "api.open-meteo.com",
      "/v1/forecast",
    ]);
    expect(Object.fromEntries(forecastUrl.searchParams)).toEqual({
      latitude: "57.70716",
      longitude: "11.96679",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weather_code",
      timezone: "auto",
      forecast_days: "7",
    });
    expect(result?.sourceUrl).toBe(forecastUrl.toString());
  });

  it.each([
    ["misaligned arrays", { precipitation_sum: [0, 0.2] }],
    ["non-consecutive dates", { time: [...dates.slice(0, 3), "2026-07-19", ...dates.slice(4)] }],
    ["minimum above maximum", { temperature_2m_min: [22, 11, 10, 9, 8, 7, 6] }],
    ["unknown weather code", { weather_code: [0, 1, 2, 3, 61, 63, 123] }],
  ])("fails closed for malformed daily data: %s", async (_label, malformed) => {
    const fetchImpl = (async (input: string | URL | Request) =>
      new URL(String(input)).hostname === "geocoding-api.open-meteo.com"
        ? jsonResponse(geocodingPayload())
        : jsonResponse(forecastPayload(malformed))) as typeof fetch;
    await expect(new WeatherForecastProvider(fetchImpl).forecast({ location: "Göteborg" }))
      .resolves.toBeUndefined();
  });

  it("trusts the first validated exact result in the provider's ranked duplicate-name results", async () => {
    const ranked = [
      geocodingResult({
        id: 2673730,
        name: "Stockholm",
        latitude: 59.32938,
        longitude: 18.06871,
        population: 1_515_017,
        country: "Sweden",
        country_code: "SE",
      }),
      geocodingResult({
        id: 4979937,
        name: "Stockholm",
        latitude: 47.04226,
        longitude: -68.13948,
        population: 282,
        country: "United States",
        country_code: "US",
        timezone: "America/New_York",
      }),
    ];
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).hostname === "geocoding-api.open-meteo.com"
        ? jsonResponse(geocodingPayload(ranked))
        : jsonResponse(forecastPayload())) as unknown as typeof fetch;
    const provider = new WeatherForecastProvider(fetchImpl);

    await expect(provider.forecast({ location: "Stockholm" })).resolves.toMatchObject({
      query: "Stockholm",
      resolved: {
        place: "Stockholm",
        country: "Sweden",
        latitude: 59.32938,
        longitude: 18.06871,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not replace a localized first-ranked result with a later exact spelling", async () => {
    const ranked = [
      geocodingResult({
        name: "Gothenburg",
        latitude: 57.70716,
        longitude: 11.96679,
      }),
      geocodingResult({
        id: 999,
        name: "Göteborg",
        latitude: 40.1,
        longitude: -75.2,
        country_code: "US",
        // Real geocoding result sets can contain lower-ranked physical
        // features without country metadata; they must not invalidate a
        // complete first-ranked place.
        country: undefined,
        timezone: "America/New_York",
      }),
    ];
    const fetchImpl = (async (input: string | URL | Request) =>
      new URL(String(input)).hostname === "geocoding-api.open-meteo.com"
        ? jsonResponse(geocodingPayload(ranked))
        : jsonResponse(forecastPayload())) as typeof fetch;

    await expect(new WeatherForecastProvider(fetchImpl).forecast({
      location: "Göteborg",
      languageTag: "en",
    })).resolves.toMatchObject({
      resolved: {
        place: "Gothenburg",
        country: "Sweden",
        latitude: 57.70716,
        longitude: 11.96679,
      },
    });
  });

  it("rejects absent geocoding results without requesting a forecast", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(geocodingPayload([]))) as unknown as typeof fetch;
    const provider = new WeatherForecastProvider(fetchImpl);
    await expect(provider.forecast({ location: "Nowhere" })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of substituting a lower-ranked place when the winner is incomplete", async () => {
    const results = [
      geocodingResult({ country: undefined }),
      geocodingResult({ name: "Lower-ranked complete place" }),
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(geocodingPayload(results))) as unknown as typeof fetch;

    await expect(new WeatherForecastProvider(fetchImpl).forecast({ location: "Gothenburg" }))
      .resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses a localized provider language and canonical lookup alias while preserving the display query", async () => {
    const requested: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return url.searchParams.get("name") === "札幌"
          ? jsonResponse(geocodingPayload([]))
          : jsonResponse(geocodingPayload([geocodingResult({
            id: 2128295,
            name: "札幌市",
            latitude: 43.06417,
            longitude: 141.34694,
            country_code: "JP",
            country: "日本",
            admin1: "北海道",
            timezone: "Asia/Tokyo",
          })]));
      }
      return jsonResponse({ ...forecastPayload(), timezone: "Japan" });
    }) as typeof fetch;
    const provider = new WeatherForecastProvider(fetchImpl);

    const result = await provider.forecast({
      location: "札幌",
      lookupQuery: "Sapporo",
      languageTag: "ja-JP",
      requesterId: "human-ja",
    });

    expect(result).toMatchObject({
      query: "札幌",
      resolved: {
        place: "札幌市",
        country: "日本",
        timezone: "Asia/Tokyo",
      },
    });
    expect(requested.slice(0, 2).map((url) => Object.fromEntries(url.searchParams))).toEqual([
      expect.objectContaining({ name: "札幌", language: "ja" }),
      expect.objectContaining({ name: "Sapporo", language: "ja" }),
    ]);
  });

  it("uses a model alias only as fallback and cannot replace a valid human-facing location", async () => {
    const requested: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url);
      return url.hostname === "geocoding-api.open-meteo.com"
        ? jsonResponse(geocodingPayload([geocodingResult({ name: "Göteborg" })]))
        : jsonResponse(forecastPayload());
    }) as typeof fetch;

    await expect(new WeatherForecastProvider(fetchImpl).forecast({
      location: "Göteborg",
      lookupQuery: "Gothenburg",
      languageTag: "sv",
    })).resolves.toMatchObject({
      query: "Göteborg",
      resolved: { place: "Göteborg", country: "Sweden" },
    });
    expect(requested.filter((url) => url.hostname === "geocoding-api.open-meteo.com"))
      .toHaveLength(1);
    expect(requested[0]?.searchParams.get("name")).toBe("Göteborg");
  });

  it("ignores an invalid optional alias instead of invalidating a valid location", async () => {
    const requested: URL[] = [];
    const provider = new WeatherForecastProvider(successfulFetch(requested));

    await expect(provider.forecast({
      location: "Stockholm",
      lookupQuery: "...",
      languageTag: "sv",
    })).resolves.toBeDefined();
    expect(requested[0]?.searchParams.get("name")).toBe("Stockholm");
    expect(requested).toHaveLength(2);
  });

  it("allows additive provider fields while validating all consumed fields", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return jsonResponse({
          ...geocodingPayload([{ ...geocodingResult(), provider_added_field: { version: 2 } }]),
          provider_added_envelope_field: true,
        });
      }
      const forecast = forecastPayload();
      return jsonResponse({
        ...forecast,
        provider_added_field: "safe",
        daily_units: { ...forecast.daily_units, provider_added_unit: "index" },
        daily: { ...forecast.daily, provider_added_series: [1, 2, 3, 4, 5, 6, 7] },
      });
    }) as typeof fetch;

    await expect(new WeatherForecastProvider(fetchImpl).forecast({ location: "Göteborg" }))
      .resolves.toBeDefined();
  });

  it("rejects malformed consumed geocoding fields and invalid location queries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ ...geocodingResult(), latitude: "57.7" }],
      generationtime_ms: 0.1,
    })) as unknown as typeof fetch;
    const provider = new WeatherForecastProvider(fetchImpl);
    await expect(provider.forecast({ location: "Göteborg" })).resolves.toBeUndefined();
    await expect(provider.forecast({ location: "\u0000\u202e !" })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on timeout, provider status, media type and oversized bodies", async () => {
    const timeoutFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    await expect(new WeatherForecastProvider(timeoutFetch, { timeoutMs: 10 }).forecast({ location: "Göteborg" }))
      .resolves.toBeUndefined();

    const invalidResponses = [
      new Response("unavailable", { status: 503, headers: { "content-type": "application/json" } }),
      new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("x", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "96001" },
      }),
    ];
    for (const response of invalidResponses) {
      const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
      await expect(new WeatherForecastProvider(fetchImpl).forecast({ location: "Göteborg" }))
        .resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("deduplicates concurrent work and serves later calls from its bounded cache", async () => {
    const requested: URL[] = [];
    const fetchImpl = vi.fn(successfulFetch(requested));
    const provider = new WeatherForecastProvider(fetchImpl, { maxCacheEntries: 1 });

    const [first, concurrent] = await Promise.all([
      provider.forecast({ location: "Göteborg", requesterId: "one" }),
      provider.forecast({ location: "Göteborg", requesterId: "two" }),
    ]);
    const cached = await provider.forecast({ location: "Go\u0308teborg", requesterId: "three" });

    expect(first).toBeDefined();
    expect(concurrent).toBe(first);
    expect(cached).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keys cached and in-flight work by effective lookup query and provider language", async () => {
    const requested: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname !== "geocoding-api.open-meteo.com") return jsonResponse(forecastPayload());
      const name = url.searchParams.get("name");
      return name === "札幌"
        ? jsonResponse(geocodingPayload([]))
        : jsonResponse(geocodingPayload([geocodingResult({ name })]));
    }) as unknown as typeof fetch;
    const provider = new WeatherForecastProvider(fetchImpl);

    await provider.forecast({ location: "札幌", lookupQuery: "Sapporo", languageTag: "ja-JP" });
    await provider.forecast({ location: "札幌", lookupQuery: "Sapporo", languageTag: "ja-JP" });
    await provider.forecast({ location: "札幌", lookupQuery: "Sapporo", languageTag: "en-GB" });
    await provider.forecast({ location: "札幌", lookupQuery: "Sapporo City", languageTag: "ja-JP" });

    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(requested.filter((url) => url.hostname === "geocoding-api.open-meteo.com").map((url) => ({
      name: url.searchParams.get("name"),
      language: url.searchParams.get("language"),
    }))).toEqual([
      { name: "札幌", language: "ja" },
      { name: "Sapporo", language: "ja" },
      { name: "札幌", language: "en" },
      { name: "Sapporo", language: "en" },
      { name: "札幌", language: "ja" },
      { name: "Sapporo City", language: "ja" },
    ]);
  });

  it("enforces both requester and global logical-request limits", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "geocoding-api.open-meteo.com") {
        const name = url.searchParams.get("name")!;
        return jsonResponse(geocodingPayload([geocodingResult({ name })]));
      }
      return jsonResponse(forecastPayload());
    }) as unknown as typeof fetch;
    const provider = new WeatherForecastProvider(fetchImpl, {
      perRequesterLimit: 1,
      globalLimit: 2,
    });

    await expect(provider.forecast({ location: "Alpha", requesterId: "same" })).resolves.toBeDefined();
    await expect(provider.forecast({ location: "Beta", requesterId: "same" })).resolves.toBeUndefined();
    await expect(provider.forecast({ location: "Beta", requesterId: "other" })).resolves.toBeDefined();
    await expect(provider.forecast({ location: "Gamma", requesterId: "third" })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
