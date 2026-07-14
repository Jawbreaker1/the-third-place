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
  locationLabel: string;
  /** Canonical formatting language when known; absent is never encoded as `und`. */
  languageTag?: string;
  instant: string;
  formatted: string;
  /** Trusted server-authored context for the scene model, never user input. */
  promptFact: string;
  /** A deterministic, locale-independent last-resort rendering. */
  fallbackText: string;
}

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

const deterministicDateTime = (instant: Date, timeZone: string): string => {
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
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")} ${value("timeZoneName")}`.trim();
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
  const formatted = formattingLocale
    ? new Intl.DateTimeFormat(formattingLocale, {
        timeZone,
        dateStyle: "full",
        timeStyle: "medium",
      }).format(now)
    : deterministicDateTime(now, timeZone);
  const instant = now.toISOString();
  return {
    timeZone,
    locationLabel,
    ...(locale ? { languageTag: locale } : {}),
    instant,
    formatted,
    promptFact: "Trusted server clock result: location=" + JSON.stringify(locationLabel) +
      ", IANA time zone=" + timeZone + ", local date and time=" + JSON.stringify(formatted) +
      ", UTC instant=" + instant + ".",
    fallbackText: locationLabel + " (" + timeZone + "): " + formatted,
  };
};
