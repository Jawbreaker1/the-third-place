import { describe, expect, it } from "vitest";
import { IANA_LANGUAGE_SUBTAG_FILE_DATE } from "./ianaLanguageSubtags.generated.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";

describe("IANA-backed server language tags", () => {
  it.each(["dv", "iu", "ny", "quc", "bal", "tlh"])(
    "accepts a registered low-resource language independently of ICU: %s",
    (value) => expect(canonicalRegisteredLanguageTag(value)).toBe(value),
  );

  it.each(["osd", "bih", "lfb", "tvg"])(
    "accepts languages added to the current registry snapshot: %s",
    (value) => expect(canonicalRegisteredLanguageTag(value)).toBe(value),
  );

  it("tracks the checked-in official registry snapshot date", () => {
    expect(IANA_LANGUAGE_SUBTAG_FILE_DATE).toBe("2026-06-14");
  });

  it("canonicalizes aliases and grandfathered tags", () => {
    expect(canonicalRegisteredLanguageTag("swe")).toBe("sv");
    expect(canonicalRegisteredLanguageTag("iw")).toBe("he");
    expect(canonicalRegisteredLanguageTag("i-klingon")).toBe("tlh");
  });

  it("preserves registered variants in their IANA prefix order", () => {
    expect(canonicalRegisteredLanguageTag("sl-rozaj-biske")).toBe("sl-rozaj-biske");
    expect(canonicalRegisteredLanguageTag("en-foobar")).toBeUndefined();
  });

  it("canonicalizes registered extlang forms without relying on host ICU", () => {
    expect(canonicalRegisteredLanguageTag("ar-aao")).toBe("aao");
    expect(canonicalRegisteredLanguageTag("zh-cmn-Hans-CN")).toBe("cmn-Hans-CN");
  });

  it("expands all private-use ranges recorded by IANA", () => {
    expect(canonicalRegisteredLanguageTag("qaa-Latn-QM")).toBe("qaa-Latn-QM");
    expect(canonicalRegisteredLanguageTag("qtz-Qabx-XZ")).toBe("qtz-Qabx-XZ");
  });

  it("preserves registered grandfathered tags that intentionally lack a replacement", () => {
    expect(canonicalRegisteredLanguageTag("i-default")).toBe("i-default");
  });

  it.each(["swedish", "english", "japanese", "und", "zz", "Latn"])(
    "rejects an unregistered or undetermined primary: %s",
    (value) => expect(canonicalRegisteredLanguageTag(value)).toBeUndefined(),
  );
});
