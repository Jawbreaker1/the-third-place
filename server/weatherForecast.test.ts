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

  it("rejects ambiguous and absent geocoding results without requesting a forecast", async () => {
    for (const results of [
      [],
      [
        geocodingResult({ name: "Göteborg" }),
        geocodingResult({
          id: 999,
          name: "Göteborg",
          latitude: 40.1,
          longitude: -75.2,
          country_code: "US",
          country: "United States",
        }),
      ],
    ]) {
      const fetchImpl = vi.fn(async () => jsonResponse(geocodingPayload(results))) as unknown as typeof fetch;
      const provider = new WeatherForecastProvider(fetchImpl);
      await expect(provider.forecast({ location: "Göteborg" })).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed geocoding envelopes and invalid location queries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ ...geocodingResult(), unexpected: "field" }],
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
