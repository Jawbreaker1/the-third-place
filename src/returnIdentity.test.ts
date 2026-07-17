import { describe, expect, it } from "vitest";
import {
  identityJoinError,
  needsIdentityTakeover,
  returnedRecoveryKey,
  type SessionResult,
} from "./returnIdentity";

describe("portable identity UI model", () => {
  it("only offers takeover after an authenticated recovery collides with an online session", () => {
    const online: SessionResult = { ok: false, code: "IDENTITY_ONLINE" };

    expect(needsIdentityTakeover("returning", 409, online)).toBe(true);
    expect(needsIdentityTakeover("new", 409, online)).toBe(false);
    expect(needsIdentityTakeover("returning", 401, online)).toBe(false);
  });

  it("does not reveal whether a failed recovery name exists", () => {
    const missing = identityJoinError("returning", { ok: false, code: "NOT_FOUND" });
    const wrongKey = identityJoinError("returning", { ok: false, code: "INVALID_RECOVERY_KEY" });

    expect(missing).toBe(wrongKey);
    expect(missing).not.toMatch(/exists|found|registered/i);
  });

  it("keeps safe operational recovery errors actionable", () => {
    expect(identityJoinError("returning", { ok: false, code: "RECOVERY_RATE_LIMITED" })).toMatch(/wait/i);
    expect(identityJoinError("returning", { ok: false, code: "RECOVERY_UNAVAILABLE" })).toMatch(/unchanged/i);
  });

  it("guides unavailable new names toward recovery without exposing details", () => {
    expect(identityJoinError("new", { ok: false, code: "RETURNING_IDENTITY", recoveryConfigured: true }))
      .toMatch(/I have a return key/i);
    expect(identityJoinError("new", { ok: false, code: "RETURNING_IDENTITY", recoveryConfigured: false }))
      .toMatch(/server host/i);
    expect(identityJoinError("new", { ok: false, code: "NAME_RESERVED" }))
      .toMatch(/AI resident/i);
  });

  it("only returns a non-empty key from successful responses", () => {
    expect(returnedRecoveryKey({ ok: true, me: {}, recoveryKey: "  key-123  " })).toBe("key-123");
    expect(returnedRecoveryKey({ ok: true, me: {}, recoveryKey: " " })).toBeUndefined();
    expect(returnedRecoveryKey({ ok: false, recoveryKey: "secret" } as never)).toBeUndefined();
  });
});
