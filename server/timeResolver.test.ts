import { describe, expect, it } from "vitest";
import { isSupportedTimeZone, resolveLocalDateTime } from "./timeResolver.js";

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

  it("preserves a registered low-resource tag but never mislabels an English ICU fallback", () => {
    const result = resolveLocalDateTime({ timeZone: "Asia/Kolkata", languageTag: "dv", now: summer });
    expect(result?.languageTag).toBe("dv");
    expect(result?.formatted).toBe("2026-07-14 17:30:00 GMT+05:30");
    expect(result?.formatted).not.toContain("Tuesday");
  });
});
