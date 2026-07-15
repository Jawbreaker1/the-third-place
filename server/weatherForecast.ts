import { z } from "zod";
import {
  hasUnsafeControlOrFormat,
  stripDangerousTextControls,
  unicodeCaselessKey,
} from "../shared/unicodeSafety.js";

const GEOCODING_ORIGIN = "https://geocoding-api.open-meteo.com";
const GEOCODING_PATH = "/v1/search";
const FORECAST_ORIGIN = "https://api.open-meteo.com";
const FORECAST_PATH = "/v1/forecast";
const DAILY_VARIABLES = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "weather_code",
] as const;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_PER_REQUESTER_LIMIT = 3;
const DEFAULT_GLOBAL_LIMIT = 12;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_MAX_REQUESTER_BUCKETS = 256;
const GEOCODING_MAX_BYTES = 96_000;
const FORECAST_MAX_BYTES = 128_000;
const TREND_THRESHOLD_CELSIUS = 1;

export type TemperatureTrendDirection = "cooler" | "warmer" | "steady";

export interface WeatherForecastRequest {
  location: string;
  requesterId?: string;
}

export interface WeatherForecastDay {
  date: string;
  temperatureMax: number;
  temperatureMin: number;
  precipitationProbabilityMax: number;
  precipitationSum: number;
  weatherCode: number;
}

export interface WeatherTemperatureTrend {
  direction: TemperatureTrendDirection;
  /** Final-day mean minus first-day mean, rounded to one decimal place. */
  change: number;
  fromDate: string;
  toDate: string;
  basis: "daily_mean_temperature";
  unit: "°C";
}

export interface WeatherForecastResult {
  provider: "open-meteo";
  query: string;
  retrievedAt: string;
  resolved: {
    place: string;
    country: string;
    countryCode: string;
    admin?: string;
    timezone: string;
    latitude: number;
    longitude: number;
  };
  sourceUrl: string;
  units: {
    temperature: "°C";
    precipitationProbability: "%";
    precipitation: "mm";
    weatherCode: "wmo code";
  };
  daily: readonly WeatherForecastDay[];
  temperatureTrend: WeatherTemperatureTrend;
}

export interface WeatherForecastProviderOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  rateWindowMs?: number;
  perRequesterLimit?: number;
  globalLimit?: number;
  maxCacheEntries?: number;
  maxInFlight?: number;
  maxRequesterBuckets?: number;
  now?: () => number;
}

interface CachedForecast {
  expiresAt: number;
  result: WeatherForecastResult;
}

const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number =>
  Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;

const boundedLocation = (raw: string): string | undefined => {
  const location = stripDangerousTextControls(raw.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  if (location.length < 2 || !/[\p{L}\p{N}]/u.test(location) || hasUnsafeControlOrFormat(location)) return undefined;
  return location;
};

const boundedRequester = (raw: string | undefined): string => {
  const requester = stripDangerousTextControls((raw ?? "anonymous").normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 128);
  return unicodeCaselessKey(requester || "anonymous");
};

const providerText = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !hasUnsafeControlOrFormat(value));

const optionalProviderText = (maximum: number) => z.string()
  .trim()
  .max(maximum)
  .refine((value) => !hasUnsafeControlOrFormat(value));

const geocodingResultSchema = z.object({
  id: z.number().int().nonnegative(),
  name: providerText(160),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  elevation: z.number().finite().min(-500).max(10_000).optional(),
  feature_code: z.string().regex(/^[A-Z0-9]{1,12}$/u).optional(),
  country_code: z.string().regex(/^[A-Z]{2}$/u).optional(),
  admin1_id: z.number().int().nonnegative().optional(),
  admin2_id: z.number().int().nonnegative().optional(),
  admin3_id: z.number().int().nonnegative().optional(),
  admin4_id: z.number().int().nonnegative().optional(),
  timezone: z.string().trim().min(1).max(80),
  population: z.number().int().nonnegative().optional(),
  postcodes: z.array(providerText(32)).max(100).optional(),
  country_id: z.number().int().nonnegative().optional(),
  country: providerText(160).optional(),
  admin1: optionalProviderText(160).optional(),
  admin2: optionalProviderText(160).optional(),
  admin3: optionalProviderText(160).optional(),
  admin4: optionalProviderText(160).optional(),
}).strict();

const geocodingResponseSchema = z.object({
  results: z.array(geocodingResultSchema).max(5).optional(),
  generationtime_ms: z.number().finite().nonnegative().max(1_000_000).optional(),
}).strict();

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((date) => {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
});

const weatherCodes = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
  71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
] as const;
const weatherCodeSet = new Set<number>(weatherCodes);

const sevenDates = z.array(isoDateSchema).length(7);
const sevenTemperatures = z.array(z.number().finite().min(-120).max(80)).length(7);
const sevenProbabilities = z.array(z.number().finite().min(0).max(100)).length(7);
const sevenPrecipitationAmounts = z.array(z.number().finite().min(0).max(5_000)).length(7);
const sevenWeatherCodes = z.array(
  z.number().int().refine((code) => weatherCodeSet.has(code)),
).length(7);

const forecastResponseSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  generationtime_ms: z.number().finite().nonnegative().max(1_000_000),
  utc_offset_seconds: z.number().int().min(-86_400).max(86_400),
  timezone: z.string().trim().min(1).max(80),
  timezone_abbreviation: providerText(32),
  elevation: z.number().finite().min(-500).max(10_000),
  daily_units: z.object({
    time: z.literal("iso8601"),
    temperature_2m_max: z.literal("°C"),
    temperature_2m_min: z.literal("°C"),
    precipitation_probability_max: z.literal("%"),
    precipitation_sum: z.literal("mm"),
    weather_code: z.literal("wmo code"),
  }).strict(),
  daily: z.object({
    time: sevenDates,
    temperature_2m_max: sevenTemperatures,
    temperature_2m_min: sevenTemperatures,
    precipitation_probability_max: sevenProbabilities,
    precipitation_sum: sevenPrecipitationAmounts,
    weather_code: sevenWeatherCodes,
  }).strict(),
}).strict();

type GeocodingResult = z.infer<typeof geocodingResultSchema>;
type ResolvedGeocodingResult = GeocodingResult & { country: string; country_code: string };
type ForecastResponse = z.infer<typeof forecastResponseSchema>;

const hasJsonContentType = (response: Response): boolean => {
  const value = response.headers.get("content-type")?.toLocaleLowerCase().trim() ?? "";
  return /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/u.test(value);
};

const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  if (response.status !== 200 || !hasJsonContentType(response) || !response.body) {
    throw new Error("Weather provider response failed transport validation");
  }
  const announced = response.headers.get("content-length");
  if (announced !== null) {
    if (!/^\d+$/u.test(announced)) throw new Error("Weather provider returned an invalid content length");
    if (Number(announced) > maxBytes) throw new Error("Weather provider response exceeded the byte limit");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Weather provider response exceeded the byte limit");
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body) as unknown;
};

const supportedTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

const selectUnambiguousLocation = (
  query: string,
  results: readonly GeocodingResult[],
): ResolvedGeocodingResult | undefined => {
  const usable = results.filter((candidate): candidate is ResolvedGeocodingResult =>
    Boolean(candidate.country && candidate.country_code) && supportedTimeZone(candidate.timezone));
  if (usable.length === 1) return usable[0];
  const queryKey = unicodeCaselessKey(query);
  const exact = usable.filter((candidate) => unicodeCaselessKey(candidate.name) === queryKey);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  // Open-Meteo can localize the winning name (for example Göteborg to
  // Gothenburg), so an exact comparison is not always available. Its ordered
  // first result remains the deterministic resolution for otherwise fuzzy
  // matches; repeated exact names above are treated as genuinely ambiguous.
  return usable[0];
};

const areConsecutiveDates = (dates: readonly string[]): boolean => dates.every((date, index) => {
  if (index === 0) return true;
  const previous = Date.parse(`${dates[index - 1]}T00:00:00.000Z`);
  const current = Date.parse(`${date}T00:00:00.000Z`);
  return current - previous === 24 * 60 * 60_000;
});

const dailyRows = (forecast: ForecastResponse): WeatherForecastDay[] | undefined => {
  const { daily } = forecast;
  if (!areConsecutiveDates(daily.time)) return undefined;
  const rows = daily.time.map((date, index) => ({
    date,
    temperatureMax: daily.temperature_2m_max[index]!,
    temperatureMin: daily.temperature_2m_min[index]!,
    precipitationProbabilityMax: daily.precipitation_probability_max[index]!,
    precipitationSum: daily.precipitation_sum[index]!,
    weatherCode: daily.weather_code[index]!,
  }));
  return rows.every((row) => row.temperatureMin <= row.temperatureMax) ? rows : undefined;
};

const temperatureTrend = (days: readonly WeatherForecastDay[]): WeatherTemperatureTrend => {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const firstMean = (first.temperatureMax + first.temperatureMin) / 2;
  const lastMean = (last.temperatureMax + last.temperatureMin) / 2;
  const change = Math.round((lastMean - firstMean) * 10) / 10;
  const direction: TemperatureTrendDirection = change <= -TREND_THRESHOLD_CELSIUS
    ? "cooler"
    : change >= TREND_THRESHOLD_CELSIUS
      ? "warmer"
      : "steady";
  return {
    direction,
    change,
    fromDate: first.date,
    toDate: last.date,
    basis: "daily_mean_temperature",
    unit: "°C",
  };
};

const freezeForecast = (result: WeatherForecastResult): WeatherForecastResult => {
  Object.freeze(result.resolved);
  Object.freeze(result.units);
  for (const day of result.daily) Object.freeze(day);
  Object.freeze(result.daily);
  Object.freeze(result.temperatureTrend);
  return Object.freeze(result);
};

export class WeatherForecastProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CachedForecast>();
  private readonly inFlight = new Map<string, Promise<WeatherForecastResult | undefined>>();
  private readonly globalRequestTimestamps: number[] = [];
  private readonly requesterTimestamps = new Map<string, number[]>();
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly rateWindowMs: number;
  private readonly perRequesterLimit: number;
  private readonly globalLimit: number;
  private readonly maxCacheEntries: number;
  private readonly maxInFlight: number;
  private readonly maxRequesterBuckets: number;
  private readonly now: () => number;

  constructor(options?: WeatherForecastProviderOptions);
  constructor(fetchImpl?: typeof fetch, options?: WeatherForecastProviderOptions);
  constructor(
    fetchOrOptions: typeof fetch | WeatherForecastProviderOptions = fetch,
    explicitOptions: WeatherForecastProviderOptions = {},
  ) {
    const options = typeof fetchOrOptions === "function" ? explicitOptions : fetchOrOptions;
    this.fetchImpl = typeof fetchOrOptions === "function" ? fetchOrOptions : fetch;
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 30_000);
    this.cacheTtlMs = boundedInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1, 60 * 60_000);
    this.rateWindowMs = boundedInteger(options.rateWindowMs, DEFAULT_RATE_WINDOW_MS, 1, 10 * 60_000);
    this.perRequesterLimit = boundedInteger(options.perRequesterLimit, DEFAULT_PER_REQUESTER_LIMIT, 1, 100);
    this.globalLimit = boundedInteger(options.globalLimit, DEFAULT_GLOBAL_LIMIT, 1, 1_000);
    this.maxCacheEntries = boundedInteger(options.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 1, 512);
    this.maxInFlight = boundedInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT, 1, 64);
    this.maxRequesterBuckets = boundedInteger(
      options.maxRequesterBuckets,
      DEFAULT_MAX_REQUESTER_BUCKETS,
      1,
      2_048,
    );
    this.now = options.now ?? Date.now;
  }

  async forecast(request: WeatherForecastRequest): Promise<WeatherForecastResult | undefined> {
    const query = boundedLocation(request.location);
    if (!query) return undefined;
    const key = unicodeCaselessKey(query);
    const now = this.now();
    if (!Number.isFinite(now)) return undefined;
    this.prune(now);

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result;
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= this.maxInFlight || !this.reserve(boundedRequester(request.requesterId), now)) {
      return undefined;
    }

    const pending = this.fetchForecast(query, now)
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    const result = await pending;
    if (result) {
      this.cache.set(key, { result, expiresAt: now + this.cacheTtlMs });
      this.prune(this.now());
    }
    return result;
  }

  private reserve(requesterId: string, now: number): boolean {
    this.pruneTimestamps(this.globalRequestTimestamps, now);
    const existing = this.requesterTimestamps.get(requesterId);
    if (!existing && this.requesterTimestamps.size >= this.maxRequesterBuckets) return false;
    const requester = existing ?? [];
    this.pruneTimestamps(requester, now);
    if (this.globalRequestTimestamps.length >= this.globalLimit || requester.length >= this.perRequesterLimit) {
      return false;
    }
    this.globalRequestTimestamps.push(now);
    requester.push(now);
    this.requesterTimestamps.set(requesterId, requester);
    return true;
  }

  private pruneTimestamps(timestamps: number[], now: number): void {
    while (timestamps[0] !== undefined && now - timestamps[0] >= this.rateWindowMs) timestamps.shift();
  }

  private prune(now: number): void {
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    for (const [requester, timestamps] of this.requesterTimestamps) {
      this.pruneTimestamps(timestamps, now);
      if (timestamps.length === 0) this.requesterTimestamps.delete(requester);
    }
  }

  private async fetchForecast(query: string, requestedAt: number): Promise<WeatherForecastResult | undefined> {
    const geocodingUrl = new URL(GEOCODING_PATH, GEOCODING_ORIGIN);
    geocodingUrl.searchParams.set("name", query);
    geocodingUrl.searchParams.set("count", "5");
    geocodingUrl.searchParams.set("language", "en");
    geocodingUrl.searchParams.set("format", "json");
    const geocodingResponse = await this.fetchImpl(geocodingUrl, {
      headers: { Accept: "application/json", "User-Agent": "TheThirdPlace/0.2" },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    const geocoding = geocodingResponseSchema.safeParse(
      await readBoundedJson(geocodingResponse, GEOCODING_MAX_BYTES),
    );
    if (!geocoding.success) return undefined;
    const resolved = selectUnambiguousLocation(query, geocoding.data.results ?? []);
    if (!resolved) return undefined;

    const forecastUrl = new URL(FORECAST_PATH, FORECAST_ORIGIN);
    forecastUrl.searchParams.set("latitude", String(resolved.latitude));
    forecastUrl.searchParams.set("longitude", String(resolved.longitude));
    forecastUrl.searchParams.set("daily", DAILY_VARIABLES.join(","));
    forecastUrl.searchParams.set("timezone", "auto");
    forecastUrl.searchParams.set("forecast_days", "7");
    const forecastResponse = await this.fetchImpl(forecastUrl, {
      headers: { Accept: "application/json", "User-Agent": "TheThirdPlace/0.2" },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    const forecast = forecastResponseSchema.safeParse(
      await readBoundedJson(forecastResponse, FORECAST_MAX_BYTES),
    );
    if (!forecast.success || forecast.data.timezone !== resolved.timezone) return undefined;
    const days = dailyRows(forecast.data);
    if (!days) return undefined;

    return freezeForecast({
      provider: "open-meteo",
      query,
      retrievedAt: new Date(requestedAt).toISOString(),
      resolved: {
        place: resolved.name,
        country: resolved.country,
        countryCode: resolved.country_code,
        ...(resolved.admin1 ? { admin: resolved.admin1 } : {}),
        timezone: resolved.timezone,
        latitude: resolved.latitude,
        longitude: resolved.longitude,
      },
      sourceUrl: forecastUrl.toString(),
      units: {
        temperature: "°C",
        precipitationProbability: "%",
        precipitation: "mm",
        weatherCode: "wmo code",
      },
      daily: days,
      temperatureTrend: temperatureTrend(days),
    });
  }
}
