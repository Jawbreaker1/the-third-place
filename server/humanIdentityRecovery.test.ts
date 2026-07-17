import { describe, expect, it } from "vitest";
import {
  generateHumanIdentityRecoveryKey,
  hashHumanIdentityRecoveryKey,
  humanIdentityRecoveryKeyHashesMatch,
  isHumanIdentityRecoveryKeyHash,
  normalizeHumanIdentityRecoveryKey,
  verifyHumanIdentityRecoveryKey,
} from "./humanIdentityRecovery.js";

describe("human identity recovery credentials", () => {
  it("generates canonical copy/paste keys backed by 24 random bytes", () => {
    const keys = new Set(Array.from({ length: 32 }, generateHumanIdentityRecoveryKey));
    expect(keys.size).toBe(32);
    for (const key of keys) {
      expect(key).toMatch(/^ttp_[A-Za-z\d_-]{32}$/u);
      expect(normalizeHumanIdentityRecoveryKey(key)).toBe(key);
      expect(Buffer.from(key.slice(4), "base64url")).toHaveLength(24);
      expect(isHumanIdentityRecoveryKeyHash(hashHumanIdentityRecoveryKey(key))).toBe(true);
    }
  });

  it("trims only copy/paste whitespace and keeps credentials case-sensitive", () => {
    const key = generateHumanIdentityRecoveryKey();
    expect(normalizeHumanIdentityRecoveryKey(` \n${key}\t`)).toBe(key);
    expect(normalizeHumanIdentityRecoveryKey(key.toUpperCase())).toBeUndefined();
    expect(normalizeHumanIdentityRecoveryKey(key.replace("_", "-"))).toBeUndefined();
    expect(normalizeHumanIdentityRecoveryKey("ttp_short")).toBeUndefined();
    expect(normalizeHumanIdentityRecoveryKey(null)).toBeUndefined();
  });

  it("verifies fixed-width digests and never authenticates a dummy comparison", () => {
    const key = generateHumanIdentityRecoveryKey();
    const other = generateHumanIdentityRecoveryKey();
    const digest = hashHumanIdentityRecoveryKey(key);

    expect(verifyHumanIdentityRecoveryKey(key, digest)).toBe(true);
    expect(verifyHumanIdentityRecoveryKey(`  ${key}  `, digest)).toBe(true);
    expect(verifyHumanIdentityRecoveryKey(other, digest)).toBe(false);
    expect(verifyHumanIdentityRecoveryKey("invalid", digest)).toBe(false);
    expect(verifyHumanIdentityRecoveryKey(key, undefined)).toBe(false);
    expect(humanIdentityRecoveryKeyHashesMatch(digest, digest)).toBe(true);
    expect(humanIdentityRecoveryKeyHashesMatch("invalid", undefined)).toBe(false);
    expect(humanIdentityRecoveryKeyHashesMatch(undefined, undefined)).toBe(false);
  });

  it("refuses to hash a malformed or noncanonical credential", () => {
    expect(() => hashHumanIdentityRecoveryKey("ttp_short")).toThrow(TypeError);
    expect(() => hashHumanIdentityRecoveryKey(undefined)).toThrow(TypeError);
  });
});
