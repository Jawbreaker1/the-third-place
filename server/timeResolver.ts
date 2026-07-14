import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";

export interface LocalDateTimeRequest {
  timeZone: string;
  languageTag?: string;
  locationLabel?: string;
  now?: Date;
}

export interface LocalDateTimeResult {
  timeZone: string;
  /** Cleaned display text derived from the request; never treat it as an instruction or computed clock fact. */
  locationLabel: string;
  /** Canonical formatting language when known; absent is never encoded as `und`. */
  languageTag?: string;
  instant: string;
  localDate: string;
  localTime: string;
  utcOffset: string;
  weekday: string;
  hour: number;
  daypart: LocalDaypart;
  formatted: string;
  /** Trusted server-authored clock facts. The request-derived display label is deliberately excluded. */
  promptFact: string;
  /** A deterministic, locale-independent last-resort rendering. */
  fallbackText: string;
}

export const LOCAL_DAYPARTS = ["night", "morning", "midday", "afternoon", "evening"] as const;
export type LocalDaypart = (typeof LOCAL_DAYPARTS)[number];

export const TEMPORAL_SURFACE_POLICIES = [
  "reactive_only",
  "direct_answer",
  "welcome_optional",
  "ambient_silent",
  "ambient_optional",
] as const;
export type TemporalSurfacePolicy = (typeof TEMPORAL_SURFACE_POLICIES)[number];

export interface SceneTemporalContext {
  timeZone: string;
  locationLabel: string;
  instant: string;
  localDate: string;
  localTime: string;
  utcOffset: string;
  weekday: string;
  daypart: LocalDaypart;
  surfacePolicy: TemporalSurfacePolicy;
  surfaceActorId?: string;
}

export interface CommunityTimeZoneRequest {
  configuredTimeZone?: string;
  /** Injectable because some runtimes report no IANA host zone. */
  hostTimeZone?: string;
}

export interface SceneTemporalContextRequest {
  now?: Date;
  timeZone: string;
  locationLabel?: string;
  surfacePolicy?: TemporalSurfacePolicy;
  surfaceActorId?: string;
}

export type TimedTranscriptLine<T> = T & {
  ageSeconds?: number;
  sincePreviousSeconds?: number;
};

const safeLanguageTag = (raw: string | undefined): string | undefined => {
  // The shared canonicalizer strips extensions and rejects merely
  // syntax-shaped provider names that Intl.Locale would otherwise accept.
  return canonicalRegisteredLanguageTag(raw);
};

export const isSupportedTimeZone = (raw: string): boolean => {
  const value = raw.trim();
  if (!value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

const safeLocationLabel = (raw: string | undefined, timeZone: string): string => {
  const normalized = raw
    ? stripDangerousTextControls(raw.normalize("NFKC"))
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 80)
    : undefined;
  return normalized || timeZone;
};

interface DeterministicLocalParts {
  localDate: string;
  localTime: string;
  utcOffset: string;
  hour: number;
}

const deterministicLocalParts = (instant: Date, timeZone: string): DeterministicLocalParts => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  const localTime = `${value("hour")}:${value("minute")}:${value("second")}`;
  return {
    localDate,
    localTime,
    utcOffset: value("timeZoneName"),
    hour: Number.parseInt(value("hour"), 10),
  };
};

export const localDaypartForHour = (hour: number): LocalDaypart => {
  const normalized = Math.max(0, Math.min(23, Math.floor(hour)));
  if (normalized < 5 || normalized >= 23) return "night";
  if (normalized < 11) return "morning";
  if (normalized < 14) return "midday";
  if (normalized < 18) return "afternoon";
  return "evening";
};

/** Explicit invalid configuration is an operator error; an unknown host zone safely falls back to UTC. */
export const resolveCommunityTimeZone = (request: CommunityTimeZoneRequest = {}): string => {
  const configured = request.configuredTimeZone?.trim();
  if (configured) {
    if (!isSupportedTimeZone(configured)) {
      throw new TypeError(`COMMUNITY_TIME_ZONE is not a valid IANA time zone: ${configured}`);
    }
    return configured;
  }
  const host = (request.hostTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)?.trim();
  return host && isSupportedTimeZone(host) ? host : "UTC";
};

/** Resolves clock facts from the server clock. The model selects only a validated IANA zone. */
export const resolveLocalDateTime = (request: LocalDateTimeRequest): LocalDateTimeResult | undefined => {
  const timeZone = request.timeZone.trim();
  if (!isSupportedTimeZone(timeZone)) return undefined;
  const now = request.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return undefined;
  const locale = safeLanguageTag(request.languageTag);
  const formattingLocale = locale && Intl.DateTimeFormat.supportedLocalesOf([locale], { localeMatcher: "lookup" }).length === 1
    ? locale
    : undefined;
  const locationLabel = safeLocationLabel(request.locationLabel, timeZone);
  const local = deterministicLocalParts(now, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    weekday: "long",
  }).format(now);
  const formatted = formattingLocale
    ? new Intl.DateTimeFormat(formattingLocale, {
        timeZone,
        calendar: "gregory",
        numberingSystem: "latn",
        dateStyle: "full",
        timeStyle: "medium",
      }).format(now)
    : `${local.localDate} ${local.localTime} ${local.utcOffset}`.trim();
  const instant = now.toISOString();
  return {
    timeZone,
    locationLabel,
    ...(locale ? { languageTag: locale } : {}),
    instant,
    ...local,
    weekday,
    daypart: localDaypartForHour(local.hour),
    formatted,
    promptFact: "Trusted server clock result: IANA time zone=" + timeZone +
      ", local date and time=" + JSON.stringify(formatted) +
      ", local daypart=" + localDaypartForHour(local.hour) + ", UTC instant=" + instant + ".",
    fallbackText: locationLabel + " (" + timeZone + "): " + formatted,
  };
};

/** Refreshes computed clock facts at publication time while preserving only the cleaned display label. */
export const refreshLocalDateTime = (
  clock: LocalDateTimeResult,
  now = new Date(),
): LocalDateTimeResult => resolveLocalDateTime({
  timeZone: clock.timeZone,
  locationLabel: clock.locationLabel,
  languageTag: clock.languageTag,
  now,
}) ?? clock;

export const createSceneTemporalContext = (
  request: SceneTemporalContextRequest,
): SceneTemporalContext => {
  const resolved = resolveLocalDateTime({
    timeZone: request.timeZone,
    locationLabel: request.locationLabel,
    now: request.now,
  });
  if (!resolved) throw new TypeError(`Could not resolve scene clock for ${request.timeZone}`);
  return {
    timeZone: resolved.timeZone,
    locationLabel: resolved.locationLabel,
    instant: resolved.instant,
    localDate: resolved.localDate,
    localTime: resolved.localTime,
    utcOffset: resolved.utcOffset,
    weekday: resolved.weekday,
    daypart: resolved.daypart,
    surfacePolicy: request.surfacePolicy ?? "reactive_only",
    ...(request.surfaceActorId ? { surfaceActorId: request.surfaceActorId } : {}),
  };
};

/** Adds trusted elapsed-time metadata without parsing chat text or localized clock strings. */
export const annotateTranscriptTiming = <T extends { createdAt: string }>(
  lines: readonly T[],
  sceneInstant: string,
): Array<TimedTranscriptLine<T>> => {
  const sceneAt = Date.parse(sceneInstant);
  return lines.map((line, index) => {
    const createdAt = Date.parse(line.createdAt);
    const previousAt = index > 0 ? Date.parse(lines[index - 1]!.createdAt) : Number.NaN;
    const ageSeconds = Number.isFinite(sceneAt) && Number.isFinite(createdAt) && createdAt <= sceneAt
      ? Math.floor((sceneAt - createdAt) / 1_000)
      : undefined;
    const sincePreviousSeconds = Number.isFinite(previousAt) && Number.isFinite(createdAt) && createdAt >= previousAt
      ? Math.floor((createdAt - previousAt) / 1_000)
      : undefined;
    return {
      ...line,
      ...(ageSeconds !== undefined ? { ageSeconds } : {}),
      ...(sincePreviousSeconds !== undefined ? { sincePreviousSeconds } : {}),
    };
  });
};
