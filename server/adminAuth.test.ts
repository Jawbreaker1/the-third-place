import { describe, expect, it } from "vitest";
import {
  ADMIN_LOGIN_SOURCE_CAPACITY,
  ADMIN_SESSION_MAX_TTL_MS,
  ADMIN_PASSWORD_MIN_CHARACTERS,
  AdminAuthManager,
  adminCookie,
  adminTokenFromCookie,
  clearAdminCookie,
  hasStrictAdminOrigin,
} from "./adminAuth.js";

describe("admin authentication", () => {
  it("has no default password and retains only a digest of random session tokens", () => {
    const disabled = new AdminAuthManager({ randomToken: () => "x".repeat(43) });
    expect(disabled.isConfigured()).toBe(false);
    expect(disabled.login("admin")).toEqual({ ok: false, code: "NOT_CONFIGURED" });

    const auth = new AdminAuthManager({ password: " exact secret ", randomToken: () => "r".repeat(43) });
    expect(auth.login("exact secret")).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    const login = auth.login(" exact secret ");
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(auth.validate(login.token)).toBeDefined();
    expect(JSON.stringify(auth)).not.toContain(login.token);
    expect(JSON.stringify(auth)).not.toContain(" exact secret ");
  });

  it("fails startup clearly for a weak configured password while blank remains disabled", () => {
    expect(ADMIN_PASSWORD_MIN_CHARACTERS).toBe(12);
    expect(() => new AdminAuthManager({ password: "short" })).toThrow(
      "ADMIN_PASSWORD must contain at least 12 characters",
    );
    expect(() => new AdminAuthManager({ password: " ".repeat(12) })).toThrow(
      "ADMIN_PASSWORD must contain at least 12 characters",
    );
    expect(new AdminAuthManager({ password: "" }).isConfigured()).toBe(false);
  });

  it("caps sessions at twelve hours, expires absolutely and revokes by raw cookie token", () => {
    let now = 1_000;
    const auth = new AdminAuthManager({
      password: "long-enough-secret",
      now: () => now,
      randomToken: () => "t".repeat(43),
      sessionTtlMs: 99 * 60 * 60_000,
    });
    const login = auth.login("long-enough-secret");
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.expiresAt - now).toBe(ADMIN_SESSION_MAX_TTL_MS);
    now = login.expiresAt - 1;
    expect(auth.validate(login.token)).toBeDefined();
    now = login.expiresAt;
    expect(auth.validate(login.token)).toBeUndefined();

    now += 1;
    const replacement = new AdminAuthManager({ password: "long-enough-secret", now: () => now, randomToken: () => "u".repeat(43) });
    const second = replacement.login("long-enough-secret");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    replacement.revoke(second.token);
    expect(replacement.validate(second.token)).toBeUndefined();
  });

  it("rate limits each source independently without retaining its raw identity", () => {
    let now = 10_000;
    const auth = new AdminAuthManager({
      password: "long-enough-secret",
      now: () => now,
      loginMaxAttempts: 2,
      loginWindowMs: 60_000,
    });
    expect(auth.login("wrong", "203.0.113.10")).toMatchObject({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(auth.login("wrong-again", "203.0.113.10")).toMatchObject({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(auth.login("long-enough-secret", "203.0.113.10")).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(auth.login("long-enough-secret", "203.0.113.11").ok).toBe(true);
    expect(JSON.stringify(auth)).not.toContain("203.0.113.10");
    expect(JSON.stringify(auth)).not.toContain("203.0.113.11");
    now += 60_001;
    expect(auth.login("long-enough-secret", "203.0.113.10").ok).toBe(true);
  });

  it("keeps the per-source limiter strictly bounded with opaque fixed-size keys", () => {
    expect(ADMIN_LOGIN_SOURCE_CAPACITY).toBe(512);
    const auth = new AdminAuthManager({
      password: "long-enough-secret",
      loginMaxAttempts: 1,
      loginSourceCapacity: 3,
    });
    for (let index = 0; index < 50; index += 1) {
      expect(auth.login("wrong", `untrusted-source-${index}`).ok).toBe(false);
    }
    const buckets = (auth as unknown as {
      loginAttemptsBySource: Map<string, { attempts: number[]; lastSeenAt: number }>;
    }).loginAttemptsBySource;
    expect(buckets.size).toBe(3);
    for (const sourceHash of buckets.keys()) expect(sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify([...buckets])).not.toContain("untrusted-source-");
  });

  it("sets an isolated Strict HttpOnly cookie and adds Secure only for HTTPS", () => {
    const plain = adminCookie("token", 120, false);
    expect(plain).toContain("atrium_admin=token");
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Strict");
    expect(plain).toContain("Path=/api/admin");
    expect(plain).not.toContain("Secure");
    expect(adminCookie("token", 120, true)).toContain("; Secure");
    expect(clearAdminCookie(true)).toContain("Max-Age=0");
    expect(adminTokenFromCookie("foo=1; atrium_admin=secret-token")).toBe("secret-token");
    expect(adminTokenFromCookie("atrium_admin=path-token; atrium_admin=shadow-token")).toBe("path-token");
  });
});

describe("strict admin mutation origin", () => {
  const request = (headers: Record<string, string | undefined>, protocol = "https", host = "example.test") => ({
    headers,
    protocol,
    host,
  });

  it("accepts exact same/configured origins and a same-origin Referer fallback", () => {
    expect(hasStrictAdminOrigin(request({ origin: "https://example.test" }))).toBe(true);
    expect(hasStrictAdminOrigin(
      request({ origin: "https://demo.ngrok.app" }, "http", "127.0.0.1:4000"),
      ["https://demo.ngrok.app"],
    )).toBe(true);
    expect(hasStrictAdminOrigin(request({ referer: "https://example.test/admin?tab=people" }))).toBe(true);
  });

  it("rejects cross-origin, originless, null and malformed Origin requests", () => {
    expect(hasStrictAdminOrigin(request({ origin: "https://evil.test" }))).toBe(false);
    expect(hasStrictAdminOrigin(request({}))).toBe(false);
    expect(hasStrictAdminOrigin(request({ origin: "null", referer: "https://example.test/admin" }))).toBe(false);
    expect(hasStrictAdminOrigin(request({ origin: "not a url", referer: "https://example.test/admin" }))).toBe(false);
  });
});
