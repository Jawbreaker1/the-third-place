import { describe, expect, it } from "vitest";
import { canonicalLanguageTag, isCanonicalLanguageTag } from "../shared/languageTags";
import { normalizeSpokenLanguageTag } from "../shared/spokenText";

describe("registered BCP-47 language metadata", () => {
  it("canonicalizes registered tags without a language-name allowlist", () => {
    expect(canonicalLanguageTag("zh-hant-tw-u-ca-chinese")).toBe("zh-Hant-TW");
    expect(canonicalLanguageTag("gsw")).toBe("gsw");
    expect(canonicalLanguageTag("swe")).toBe("sv");
    expect(canonicalLanguageTag("iw")).toBe("he");
    expect(isCanonicalLanguageTag("sv-SE")).toBe(true);
    expect(isCanonicalLanguageTag("sv-se")).toBe(false);
  });

  it.each(["dv", "iu", "ny", "quc", "bal", "tlh"])(
    "does not depend on the host ICU formatting-language set: %s",
    (value) => expect(canonicalLanguageTag(value)).toBe(value),
  );

  it.each(["swedish", "english", "japanese", "und"])(
    "rejects syntax-shaped but unregistered or undetermined metadata: %s",
    (value) => {
      expect(canonicalLanguageTag(value)).toBeUndefined();
      expect(normalizeSpokenLanguageTag(value)).toBeUndefined();
    },
  );

  it("allows only an exact undetermined tag when a transport explicitly opts in", () => {
    expect(canonicalLanguageTag("und", { allowUndetermined: true })).toBe("und");
    expect(canonicalLanguageTag("und-Latn", { allowUndetermined: true })).toBeUndefined();
  });
});
