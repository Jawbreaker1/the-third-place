import { describe, expect, it } from "vitest";
import { normalizeDisplayName, validDisplayName } from "../shared/displayName";
import {
  hasUnsafeControlOrFormat,
  stripDangerousTextControls,
  unicodeCaselessKey,
} from "../shared/unicodeSafety";
import { UNICODE_CASE_FOLD_VERSION } from "../shared/unicodeCaseFold.generated";

describe("Unicode text safety", () => {
  it("removes bidi controls without removing natural RTL text or mixed links", () => {
    const raw = "مرحبا \u202Ehttps://example.com\u202C @ميرا שלום";
    expect(stripDangerousTextControls(raw)).toBe("مرحبا https://example.com @ميرا שלום");
  });

  it("allows contextual orthographic join controls but rejects formatting tricks", () => {
    const persian = normalizeDisplayName("علی‌رضا");
    expect(persian).toBe("علی‌رضا");
    expect(validDisplayName(persian)).toBe(true);
    expect(hasUnsafeControlOrFormat("علی‌رضا")).toBe(false);
    expect(hasUnsafeControlOrFormat("علی‌ رضا")).toBe(true);
    expect(hasUnsafeControlOrFormat("abc\u202Edef")).toBe(true);
  });

  it("builds language-neutral caseless keys without collapsing distinct scripts", () => {
    expect(UNICODE_CASE_FOLD_VERSION).toBe("17.0.0");
    expect(unicodeCaselessKey("ΟΣ")).toBe(unicodeCaselessKey("οσ"));
    expect(unicodeCaselessKey("Straße")).toBe(unicodeCaselessKey("STRASSE"));
    expect(unicodeCaselessKey("cafe\u0301 ＡＢＣ")).toBe(unicodeCaselessKey("café ABC"));
    expect(unicodeCaselessKey("कि")).not.toBe(unicodeCaselessKey("की"));
    expect(unicodeCaselessKey("ı")).not.toBe(unicodeCaselessKey("i"));
    expect(unicodeCaselessKey("İ")).not.toBe(unicodeCaselessKey("I"));
  });

  it("supports canonical and non-Latin caseless message search", () => {
    const matches = (message: string, query: string) =>
      unicodeCaselessKey(message).includes(unicodeCaselessKey(query.trim()));

    expect(matches("Vi ses på café senare", "cafe\u0301")).toBe(true);
    expect(matches("ΑΥΤΟ ΕΙΝΑΙ ΤΟ ΟΣ", "οσ")).toBe(true);
    expect(matches("Vi ses på café senare", "tehus")).toBe(false);
  });
});
