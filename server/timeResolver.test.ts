import { describe, expect, it } from "vitest";
import {
  annotateTranscriptTiming,
  createSceneTemporalContext,
  isSupportedTimeZone,
  localDaypartForHour,
  refreshLocalDateTime,
  resolveCommunityTimeZone,
  resolveLocalDateTime,
} from "./timeResolver.js";

describe("local date/time resolver", () => {
  const summer = new Date("2026-07-14T12:00:00.000Z");

  it("uses IANA rules for arbitrary locations rather than search results", () => {
    expect(resolveLocalDateTime({ timeZone: "Europe/Stockholm", languageTag: "sv", now: summer })?.formatted)
      .toContain("14:00:00");
    expect(resolveLocalDateTime({ timeZone: "Asia/Tokyo", languageTag: "ja", now: summer })?.formatted)
      .toContain("21:00:00");
    expect(resolveLocalDateTime({ timeZone: "America/New_York", languageTag: "en-US", now: summer })?.formatted)
      .toContain("8:00:00 AM");
  });

  it("handles daylight-saving changes through Intl", () => {
    const winter = new Date("2026-01-14T12:00:00.000Z");
    expect(resolveLocalDateTime({ timeZone: "Europe/Stockholm", languageTag: "sv", now: winter })?.formatted)
      .toContain("13:00:00");
  });

  it("rejects invalid or fabricated zones without guessing or searching", () => {
    expect(isSupportedTimeZone("Europe/Stockholm")).toBe(true);
    expect(isSupportedTimeZone("Sweden/Somewhere")).toBe(false);
    expect(resolveLocalDateTime({ timeZone: "not-a-zone", now: summer })).toBeUndefined();
  });

  it("keeps user-facing labels bounded and strips control characters", () => {
    const result = resolveLocalDateTime({
      timeZone: "Europe/Paris",
      languageTag: "fr",
      locationLabel: "Paris\u0000\u202e   centre",
      now: summer,
    });
    expect(result?.locationLabel).toBe("Paris centre");
    expect(result?.promptFact).toContain("Europe/Paris");
    expect(result?.promptFact).not.toContain("Paris centre");
  });

  it("strips locale extensions that could change the trusted calendar", () => {
    const result = resolveLocalDateTime({
      timeZone: "Europe/Stockholm",
      languageTag: "en-u-ca-hebrew",
      now: summer,
    });
    expect(result?.languageTag).toBe("en");
    expect(result?.formatted).toContain("2026");
    expect(result?.formatted).not.toContain("5786");
  });

  it("never labels host-locale formatting as und", () => {
    const missing = resolveLocalDateTime({
      timeZone: "Asia/Bangkok",
      now: summer,
    });
    const undetermined = resolveLocalDateTime({
      timeZone: "Asia/Bangkok",
      languageTag: "und-Latn",
      now: summer,
    });
    expect(missing?.languageTag).toBeUndefined();
    expect(undetermined?.languageTag).toBeUndefined();
    expect(undetermined?.formatted).toBe(missing?.formatted);
    expect(undetermined?.formatted).toBe("2026-07-14 19:00:00 GMT+07:00");
  });

  it("does not reinterpret provider language names as English locale tags", () => {
    const named = resolveLocalDateTime({
      timeZone: "Europe/Stockholm",
      languageTag: "swedish",
      now: summer,
    });
    expect(named?.languageTag).toBeUndefined();
    expect(named?.formatted).toBe("2026-07-14 14:00:00 GMT+02:00");
  });

  it("keeps valid CJK and Thai BCP-47 formatting tags explicit", () => {
    expect(resolveLocalDateTime({ timeZone: "Asia/Tokyo", languageTag: "ja-JP", now: summer })?.languageTag)
      .toBe("ja-JP");
    expect(resolveLocalDateTime({ timeZone: "Asia/Bangkok", languageTag: "th-TH", now: summer })?.languageTag)
      .toBe("th-TH");
  });

  it("uses one Gregorian calendar for structured and localized clock facts", () => {
    for (const languageTag of ["th-TH", "fa-IR"]) {
      const result = resolveLocalDateTime({
        timeZone: "Asia/Bangkok",
        languageTag,
        now: summer,
      });
      expect(result?.localDate).toBe("2026-07-14");
      expect(result?.formatted).toContain("2026");
      expect(result?.formatted).not.toContain("2569");
      expect(result?.formatted).not.toContain("1405");
    }
  });

  it("refreshes computed facts at publication time without reinterpreting the display label", () => {
    const initial = resolveLocalDateTime({
      timeZone: "Europe/Stockholm",
      locationLabel: "Sverige",
      languageTag: "sv",
      now: new Date("2026-07-14T12:00:00.000Z"),
    })!;
    expect(refreshLocalDateTime(initial, new Date("2026-07-14T12:01:30.000Z"))).toMatchObject({
      locationLabel: "Sverige",
      instant: "2026-07-14T12:01:30.000Z",
      localTime: "14:01:30",
    });
  });

  it("preserves a registered low-resource tag but never mislabels an English ICU fallback", () => {
    const result = resolveLocalDateTime({ timeZone: "Asia/Kolkata", languageTag: "dv", now: summer });
    expect(result?.languageTag).toBe("dv");
    expect(result?.formatted).toBe("2026-07-14 17:30:00 GMT+05:30");
    expect(result?.formatted).not.toContain("Tuesday");
  });

  it("resolves an explicit community zone before the host zone and rejects bad operator config", () => {
    expect(resolveCommunityTimeZone({
      configuredTimeZone: "Asia/Tokyo",
      hostTimeZone: "Europe/Stockholm",
    })).toBe("Asia/Tokyo");
    expect(resolveCommunityTimeZone({ hostTimeZone: "Europe/Stockholm" })).toBe("Europe/Stockholm");
    expect(resolveCommunityTimeZone({ hostTimeZone: "Host/Unknown" })).toBe("UTC");
    expect(() => resolveCommunityTimeZone({
      configuredTimeZone: "Sweden/Somewhere",
      hostTimeZone: "Europe/Stockholm",
    })).toThrow(/COMMUNITY_TIME_ZONE/u);
  });

  it.each([
    [4, "night"],
    [5, "morning"],
    [10, "morning"],
    [11, "midday"],
    [13, "midday"],
    [14, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [22, "evening"],
    [23, "night"],
  ] as const)("maps local hour %i to %s", (hour, daypart) => {
    expect(localDaypartForHour(hour)).toBe(daypart);
  });

  it("creates one structured, server-authored scene clock snapshot", () => {
    expect(createSceneTemporalContext({
      now: summer,
      timeZone: "Europe/Stockholm",
      locationLabel: "The Third Place",
      surfacePolicy: "welcome_optional",
      surfaceActorId: "ai-mira",
    })).toEqual({
      timeZone: "Europe/Stockholm",
      locationLabel: "The Third Place",
      instant: "2026-07-14T12:00:00.000Z",
      localDate: "2026-07-14",
      localTime: "14:00:00",
      utcOffset: "GMT+02:00",
      weekday: "Tuesday",
      daypart: "afternoon",
      surfacePolicy: "welcome_optional",
      surfaceActorId: "ai-mira",
    });
  });

  it("tracks Stockholm's exact DST spring and autumn boundaries", () => {
    const local = (instant: string) => resolveLocalDateTime({
      timeZone: "Europe/Stockholm",
      now: new Date(instant),
    });
    expect(local("2026-03-29T00:59:59.000Z")).toMatchObject({ localTime: "01:59:59", utcOffset: "GMT+01:00" });
    expect(local("2026-03-29T01:00:00.000Z")).toMatchObject({ localTime: "03:00:00", utcOffset: "GMT+02:00" });
    expect(local("2026-10-25T00:59:59.000Z")).toMatchObject({ localTime: "02:59:59", utcOffset: "GMT+02:00" });
    expect(local("2026-10-25T01:00:00.000Z")).toMatchObject({ localTime: "02:00:00", utcOffset: "GMT+01:00" });
  });

  it("annotates real elapsed time and gaps from UTC instants", () => {
    const timed = annotateTranscriptTiming([
      { id: "one", createdAt: "2026-07-14T10:00:00.000Z" },
      { id: "two", createdAt: "2026-07-14T10:03:30.000Z" },
    ], "2026-07-14T10:05:00.000Z");
    expect(timed).toEqual([
      { id: "one", createdAt: "2026-07-14T10:00:00.000Z", ageSeconds: 300 },
      { id: "two", createdAt: "2026-07-14T10:03:30.000Z", ageSeconds: 90, sincePreviousSeconds: 210 },
    ]);
  });

  it("omits invalid, future and backwards relative values instead of emitting negatives or NaN", () => {
    const timed = annotateTranscriptTiming([
      { id: "future", createdAt: "2026-07-14T10:06:00.000Z" },
      { id: "past", createdAt: "2026-07-14T10:04:00.000Z" },
      { id: "bad", createdAt: "not-a-date" },
    ], "2026-07-14T10:05:00.000Z");
    expect(timed[0]).not.toHaveProperty("ageSeconds");
    expect(timed[1]).toMatchObject({ ageSeconds: 60 });
    expect(timed[1]).not.toHaveProperty("sincePreviousSeconds");
    expect(timed[2]).toEqual({ id: "bad", createdAt: "not-a-date" });
  });
});
