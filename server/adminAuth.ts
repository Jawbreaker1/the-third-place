import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "atrium_admin";
export const ADMIN_SESSION_MAX_TTL_MS = 12 * 60 * 60_000;
export const ADMIN_PASSWORD_MIN_CHARACTERS = 12;

const passwordDigest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const tokenDigest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export interface AdminAuthOptions {
  password?: string;
  now?: () => number;
  randomToken?: () => string;
  sessionTtlMs?: number;
  loginWindowMs?: number;
  loginMaxAttempts?: number;
}

export type AdminLoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; code: "NOT_CONFIGURED" | "RATE_LIMITED" | "INVALID_CREDENTIALS" };

interface StoredAdminSession {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Isolated admin authentication. Only SHA-256 token digests are retained;
 * neither the configured password nor raw session tokens enter application
 * state, API payloads or logs.
 */
export class AdminAuthManager {
  private readonly configuredPasswordDigest: Buffer;
  private readonly configured: boolean;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly sessionTtlMs: number;
  private readonly loginWindowMs: number;
  private readonly loginMaxAttempts: number;
  private readonly sessions = new Map<string, StoredAdminSession>();
  // Deliberately global and bounded: admin login throttling stores no IPs.
  private loginAttempts: number[] = [];

  constructor(options: AdminAuthOptions = {}) {
    const password = options.password ?? "";
    if (
      password.length > 0 &&
      ([...password].length < ADMIN_PASSWORD_MIN_CHARACTERS || !/\S/u.test(password))
    ) {
      throw new TypeError(
        `ADMIN_PASSWORD must contain at least ${ADMIN_PASSWORD_MIN_CHARACTERS} characters; leave it unset to disable administration.`,
      );
    }
    this.configured = password.length > 0;
    // A fixed-size dummy digest keeps the comparison path well-formed even
    // when administration is disabled by missing configuration.
    this.configuredPasswordDigest = passwordDigest(this.configured ? password : "admin-disabled");
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.sessionTtlMs = Math.max(60_000, Math.min(options.sessionTtlMs ?? ADMIN_SESSION_MAX_TTL_MS, ADMIN_SESSION_MAX_TTL_MS));
    this.loginWindowMs = Math.max(10_000, Math.min(options.loginWindowMs ?? 10 * 60_000, 60 * 60_000));
    this.loginMaxAttempts = Math.max(1, Math.min(options.loginMaxAttempts ?? 6, 20));
  }

  isConfigured(): boolean {
    return this.configured;
  }

  login(candidate: string): AdminLoginResult {
    const now = this.now();
    this.prune(now);
    if (!this.configured) return { ok: false, code: "NOT_CONFIGURED" };
    if (this.loginAttempts.length >= this.loginMaxAttempts) return { ok: false, code: "RATE_LIMITED" };
    this.loginAttempts.push(now);

    const supplied = passwordDigest(candidate);
    if (!timingSafeEqual(supplied, this.configuredPasswordDigest)) {
      return { ok: false, code: "INVALID_CREDENTIALS" };
    }

    const token = this.randomToken();
    if (token.length < 32 || token.length > 256) throw new TypeError("Admin token generator returned an invalid token");
    const tokenHash = tokenDigest(token);
    const expiresAt = now + this.sessionTtlMs;
    this.sessions.set(tokenHash, { tokenHash, createdAt: now, expiresAt });
    return { ok: true, token, expiresAt };
  }

  validate(token: string | undefined): StoredAdminSession | undefined {
    if (!token) return undefined;
    const now = this.now();
    this.prune(now);
    const session = this.sessions.get(tokenDigest(token));
    return session && session.expiresAt > now ? { ...session } : undefined;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(tokenDigest(token));
  }

  prune(now = this.now()): void {
    this.loginAttempts = this.loginAttempts.filter((timestamp) => now - timestamp < this.loginWindowMs).slice(-this.loginMaxAttempts);
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(hash);
    }
  }
}

export const parseCookieHeader = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    try {
      const name = decodeURIComponent(part.slice(0, separator).trim());
      // Browsers order longer-path cookies before shorter-path cookies. Keep
      // the first value so a non-HttpOnly cookie at `/` cannot shadow the
      // isolated `/api/admin` cookie with the same name.
      if (!(name in result)) result[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie pairs rather than accepting an ambiguous token.
    }
  }
  return result;
};

export const adminCookie = (token: string, maxAgeSeconds: number, secure: boolean): string =>
  `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure ? "; Secure" : ""}`;

export const clearAdminCookie = (secure: boolean): string => adminCookie("", 0, secure);

export interface OriginGuardRequest {
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  host?: string;
}

const normalizedOrigin = (value: string | undefined): string | undefined => {
  if (!value || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/** Mutating admin requests must carry Origin, or a same-origin Referer fallback. */
export const hasStrictAdminOrigin = (
  request: OriginGuardRequest,
  configuredOrigins: readonly string[] = [],
): boolean => {
  const allowed = new Set(configuredOrigins.flatMap((value) => {
    const origin = normalizedOrigin(value);
    return origin ? [origin] : [];
  }));
  if (request.host) {
    const local = normalizedOrigin(`${request.protocol}://${request.host}`);
    if (local) allowed.add(local);
  }
  const originHeader = request.headers.origin;
  const origin = normalizedOrigin(typeof originHeader === "string" ? originHeader : originHeader?.[0]);
  if (originHeader !== undefined) return Boolean(origin && allowed.has(origin));
  const refererHeader = request.headers.referer;
  const referer = normalizedOrigin(typeof refererHeader === "string" ? refererHeader : refererHeader?.[0]);
  return Boolean(referer && allowed.has(referer));
};

export const adminTokenFromCookie = (cookieHeader: string | undefined): string | undefined =>
  parseCookieHeader(cookieHeader)[ADMIN_SESSION_COOKIE];
