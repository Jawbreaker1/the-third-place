import { describe, expect, it } from "vitest";
import { preferredRequestLanguage } from "./requestLanguage.js";

describe("request language metadata", () => {
  it("selects and canonicalizes the highest-quality BCP-47 base tag", () => {
    expect(preferredRequestLanguage("en-US;q=0.4, fr-CA;q=0.9, sv;q=0.7")).toBe("fr-CA");
    expect(preferredRequestLanguage("zh-hant-tw, en;q=0.5")).toBe("zh-Hant-TW");
  });

  it("drops wildcards, unknown-language tags and locale extensions", () => {
    expect(preferredRequestLanguage("*, und-Latn, en-u-ca-hebrew;q=0.8")).toBe("en");
    expect(preferredRequestLanguage("not_a_locale")).toBeUndefined();
    expect(preferredRequestLanguage("swedish, english;q=0.5")).toBeUndefined();
  });
});
