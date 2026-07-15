import { describe, expect, it } from "vitest";
import { WeatherForecastProvider } from "./weatherForecast.js";

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
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

const forecastPayload = (timezone: string) => ({
  latitude: 59.25,
  longitude: 18,
  generationtime_ms: 0.3,
  utc_offset_seconds: 7_200,
  timezone,
  timezone_abbreviation: "LOCAL",
  elevation: 24,
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
    temperature_2m_max: [30.4, 29.6, 30.1, 22.3, 17.3, 14.4, 16.7],
    temperature_2m_min: [17.2, 20.8, 18.2, 17, 9.9, 10.1, 11.1],
    precipitation_probability_max: [0, 0, 14, 94, 82, 59, 24],
    precipitation_sum: [0, 0, 0, 25, 7.8, 6.3, 5.1],
    weather_code: [3, 3, 3, 81, 53, 53, 53],
  },
});

interface GeocodingFixture {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  feature_code: string;
  country_code: string;
  timezone: string;
  population?: number;
  country: string;
  admin1?: string;
}

const place = (fixture: GeocodingFixture): GeocodingFixture => fixture;

const rankedHomonyms = [
  {
    query: "Stockholm",
    expected: place({
      id: 2_673_730,
      name: "Stockholm",
      latitude: 59.32938,
      longitude: 18.06871,
      feature_code: "PPLC",
      country_code: "SE",
      timezone: "Europe/Stockholm",
      population: 1_515_017,
      country: "Sweden",
      admin1: "Stockholm County",
    }),
    alternatives: [place({
      id: 4_979_937,
      name: "Stockholm",
      latitude: 47.04226,
      longitude: -68.13948,
      feature_code: "PPL",
      country_code: "US",
      timezone: "America/New_York",
      population: 282,
      country: "United States",
      admin1: "Maine",
    })],
  },
  {
    query: "Barcelona",
    expected: place({
      id: 3_128_760,
      name: "Barcelona",
      latitude: 41.38879,
      longitude: 2.15899,
      feature_code: "PPLA",
      country_code: "ES",
      timezone: "Europe/Madrid",
      population: 1_686_208,
      country: "Spain",
      admin1: "Catalonia",
    }),
    alternatives: [place({
      id: 3_648_559,
      name: "Barcelona",
      latitude: 10.1384,
      longitude: -64.68769,
      feature_code: "PPLA",
      country_code: "VE",
      timezone: "America/Caracas",
      population: 815_141,
      country: "Venezuela",
      admin1: "Anzoátegui",
    })],
  },
  {
    query: "Seattle",
    expected: place({
      id: 5_809_844,
      name: "Seattle",
      latitude: 47.60621,
      longitude: -122.33207,
      feature_code: "PPLA2",
      country_code: "US",
      timezone: "America/Los_Angeles",
      population: 780_995,
      country: "United States",
      admin1: "Washington",
    }),
    alternatives: [place({
      id: 13_400_065,
      name: "Seattle",
      latitude: 20.71951,
      longitude: -103.37311,
      feature_code: "PPLX",
      country_code: "MX",
      timezone: "America/Mexico_City",
      country: "Mexico",
      admin1: "Jalisco",
    })],
  },
] as const;

describe("weather provider cross-layer location contract", () => {
  it.each(rankedHomonyms)(
    "accepts Open-Meteo's first-ranked principal $query instead of rejecting every exact homonym",
    async ({ query, expected, alternatives }) => {
      const requested: URL[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(url);
        return url.hostname === "geocoding-api.open-meteo.com"
          ? jsonResponse({ results: [expected, ...alternatives], generationtime_ms: 0.2 })
          : jsonResponse(forecastPayload(expected.timezone));
      }) as typeof fetch;
      const provider = new WeatherForecastProvider(fetchImpl, {
        now: () => Date.parse("2026-07-15T20:00:00.000Z"),
      });

      const result = await provider.forecast({ location: query, requesterId: "lobby-human" });

      expect(result?.resolved).toMatchObject({
        place: expected.name,
        country: expected.country,
        countryCode: expected.country_code,
        latitude: expected.latitude,
        longitude: expected.longitude,
      });
      expect(requested).toHaveLength(2);
      expect(requested[1]?.searchParams.get("latitude")).toBe(String(expected.latitude));
      expect(requested[1]?.searchParams.get("longitude")).toBe(String(expected.longitude));
    },
  );

  it.each([
    {
      query: "Ciudad de México",
      canonical: "Mexico City",
      country: "Mexico",
      countryCode: "MX",
      timezone: "America/Mexico_City",
      latitude: 19.42847,
      longitude: -99.12766,
    },
    {
      query: "札幌",
      canonical: "Sapporo",
      country: "Japan",
      countryCode: "JP",
      timezone: "Asia/Tokyo",
      latitude: 43.06667,
      longitude: 141.35,
    },
  ])(
    "keeps the human-facing $query while accepting the geocoder's canonical $canonical result",
    async ({ query, canonical, country, countryCode, timezone, latitude, longitude }) => {
      const requested: URL[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(url);
        if (url.hostname === "geocoding-api.open-meteo.com") {
          return url.searchParams.get("name") === query
            ? jsonResponse({ results: [], generationtime_ms: 0.2 })
            : jsonResponse({
              results: [place({
                id: 1,
                name: canonical,
                latitude,
                longitude,
                feature_code: "PPLC",
                country_code: countryCode,
                timezone,
                population: 1_000_000,
                country,
              })],
              generationtime_ms: 0.2,
            });
        }
        return jsonResponse(forecastPayload(timezone));
      }) as typeof fetch;
      const provider = new WeatherForecastProvider(fetchImpl, {
        now: () => Date.parse("2026-07-15T20:00:00.000Z"),
      });

      const result = await provider.forecast({
        location: query,
        lookupQuery: canonical,
        languageTag: query === "札幌" ? "ja-JP" : "es-MX",
        requesterId: "multilingual-human",
      });

      expect(result).toMatchObject({
        query,
        resolved: { place: canonical, country, countryCode, timezone },
      });
      expect(requested.slice(0, 2).map((url) => url.searchParams.get("name"))).toEqual([query, canonical]);
      expect(requested.slice(0, 2).map((url) => url.searchParams.get("language")))
        .toEqual(query === "札幌" ? ["ja", "ja"] : ["es", "es"]);
    },
  );
});
