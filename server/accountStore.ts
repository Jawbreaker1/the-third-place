import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { unicodeCaselessKey } from "../shared/unicodeSafety.js";
import { preservePreMigrationState } from "./persistenceMigrationBackup.js";

export const ACCOUNT_PASSWORD_MIN_CHARACTERS = 8;
export const ACCOUNT_PASSWORD_MAX_CHARACTERS = 1_024;
export const ACCOUNT_SESSION_DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000;
export const ACCOUNT_SESSION_MAX_TTL_MS = 90 * 24 * 60 * 60_000;
export const ACCOUNT_LOGIN_SOURCE_CAPACITY = 512;
export const ACCOUNT_DEFAULT_MAX_SESSIONS_PER_ACCOUNT = 12;

const MAX_ACCOUNTS = 10_000;
const MAX_SESSIONS = 100_000;
const MAX_LOGIN_HANDLE_CHARACTERS = 64;
const MAX_DISPLAY_NAME_CHARACTERS = 100;

export interface AccountRecord {
  id: string;
  kind: "registered";
  /** Two-store registration/upgrade transaction state. */
  profileState: "pending" | "ready";
  actorId: string;
  loginHandle: string;
  displayName: string;
  /**
   * The account owner has acknowledged that The Third Place is an adult
   * community. This is a local age attestation, not identity verification and
   * not consent to any particular topic or interaction.
   */
  adultConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSession {
  id: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

interface PasswordDigest {
  algorithm: "scrypt";
  salt: string;
  digest: string;
  keyLength: number;
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

interface PersistedAccount extends AccountRecord {
  normalizedHandle: string;
  password: PasswordDigest;
}

interface PersistedSession extends AccountSession {
  tokenHash: string;
}

interface PersistedAccountState {
  version: 2;
  accounts: PersistedAccount[];
  sessions: PersistedSession[];
}

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  maxmem: number;
}

const DEFAULT_SCRYPT_PARAMETERS: ScryptParameters = {
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
  maxmem: 64 * 1_024 * 1_024,
};

export interface AccountStoreOptions {
  now?: () => number;
  randomToken?: () => string;
  randomId?: () => string;
  sessionTtlMs?: number;
  loginWindowMs?: number;
  loginMaxFailures?: number;
  /** Source-wide attempts, including successful logins, per login window. */
  loginMaxAttempts?: number;
  loginSourceCapacity?: number;
  maxSessionsPerAccount?: number;
  scrypt?: Partial<ScryptParameters>;
}

export interface RegisterAccountInput {
  loginHandle: string;
  displayName: string;
  password: string;
  /** Optional so trusted callers can persist the entry acknowledgement atomically. */
  adultConfirmed?: boolean;
  /** Used only by trusted migration code to preserve an existing social actor. */
  actorId?: string;
}

export type RegisterAccountResult =
  | { ok: true; account: AccountRecord }
  | {
      ok: false;
      code:
        | "INVALID_HANDLE"
        | "INVALID_DISPLAY_NAME"
        | "WEAK_PASSWORD"
        | "HANDLE_TAKEN"
        | "ACTOR_ALREADY_LINKED";
    };

export interface AccountLoginInput {
  loginHandle: string;
  password: string;
  /** Optional so entry routes can persist the acknowledgement after authentication succeeds. */
  adultConfirmed?: boolean;
  /** Usually a trusted proxy-aware remote address. It is HMACed and never persisted. */
  sourceIdentity: string;
}

export type AccountLoginResult =
  | {
      ok: true;
      token: string;
      expiresAt: string;
      sessionId: string;
      account: AccountRecord;
    }
  | { ok: false; code: "INVALID_CREDENTIALS" }
  | { ok: false; code: "RATE_LIMITED"; retryAfterMs: number };

export interface AuthenticatedAccountSession {
  account: AccountRecord;
  session: AccountSession;
}

export interface IssuedAccountSession {
  token: string;
  expiresAt: string;
  sessionId: string;
  account: AccountRecord;
}

interface LoginFailureBucket {
  failures: number[];
  lastSeenAt: number;
}

interface LoginAttemptBucket {
  attempts: number[];
  lastSeenAt: number;
}

export class AccountStoreLoadError extends Error {
  readonly code = "ACCOUNT_STORE_LOAD_FAILED";

  constructor(cause: unknown) {
    super("Local account data could not be read safely. Startup was aborted and the original file was left untouched.");
    this.name = "AccountStoreLoadError";
    this.cause = cause;
  }
}

const emptyState = (): PersistedAccountState => ({ version: 2, accounts: [], sessions: [] });

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const codePointLength = (value: string): number => [...value].length;

const isSafeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100 &&
  value.trim() === value && !/[\p{C}\s]/u.test(value);

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isBase64UrlBytes = (value: unknown, byteLength: number): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === byteLength && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
};

const isValidScryptParameters = (value: ScryptParameters): boolean => {
  const minimumMemory = 128 * value.N * value.r + 1_024;
  return Number.isInteger(value.N) && value.N >= 1_024 && value.N <= 131_072 &&
    (value.N & (value.N - 1)) === 0 &&
    Number.isInteger(value.r) && value.r >= 1 && value.r <= 32 &&
    Number.isInteger(value.p) && value.p >= 1 && value.p <= 16 &&
    Number.isInteger(value.keyLength) && value.keyLength >= 32 && value.keyLength <= 64 &&
    Number.isInteger(value.maxmem) && value.maxmem >= minimumMemory && value.maxmem <= 256 * 1_024 * 1_024;
};

const normalizeDisplayName = (value: string): string | undefined => {
  const normalized = value.normalize("NFC").trim();
  if (codePointLength(normalized) < 1 || codePointLength(normalized) > MAX_DISPLAY_NAME_CHARACTERS ||
      /[\p{Cc}\p{Cs}]/u.test(normalized)) return undefined;
  return normalized;
};

/** Case-insensitive, Unicode-capable login key; display names remain free and non-unique. */
export const normalizeLoginHandle = (value: string): { handle: string; key: string } | undefined => {
  const handle = value.normalize("NFKC").trim();
  const length = codePointLength(handle);
  if (length < 1 || length > MAX_LOGIN_HANDLE_CHARACTERS ||
      !/^[\p{L}\p{N}._-]+$/u.test(handle)) return undefined;
  return { handle, key: unicodeCaselessKey(handle) };
};

const publicAccount = (account: PersistedAccount): AccountRecord => ({
  id: account.id,
  kind: "registered",
  profileState: account.profileState,
  actorId: account.actorId,
  loginHandle: account.loginHandle,
  displayName: account.displayName,
  adultConfirmed: account.adultConfirmed,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

const publicSession = (session: PersistedSession): AccountSession => ({
  id: session.id,
  accountId: session.accountId,
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
});

const LEGACY_ACCOUNT_KEYS = new Set([
  "id", "kind", "profileState", "actorId", "loginHandle", "normalizedHandle", "displayName",
  "romanticInteractionsOptIn", "createdAt", "updatedAt", "password",
]);
const CURRENT_ACCOUNT_KEYS = new Set([
  "id", "kind", "profileState", "actorId", "loginHandle", "normalizedHandle", "displayName",
  "adultConfirmed", "createdAt", "updatedAt", "password",
]);
const PASSWORD_KEYS = new Set(["algorithm", "salt", "digest", "keyLength", "N", "r", "p", "maxmem"]);
const SESSION_KEYS = new Set(["id", "accountId", "tokenHash", "createdAt", "expiresAt"]);
const STATE_KEYS = new Set(["version", "accounts", "sessions"]);

const parsePasswordDigest = (value: unknown): PasswordDigest => {
  if (!isRecord(value) || !hasOnlyKeys(value, PASSWORD_KEYS) || value.algorithm !== "scrypt") {
    throw new TypeError("Account store contains an invalid password digest.");
  }
  const parameters: ScryptParameters = {
    N: value.N as number,
    r: value.r as number,
    p: value.p as number,
    keyLength: value.keyLength as number,
    maxmem: value.maxmem as number,
  };
  if (!isValidScryptParameters(parameters) || !isBase64UrlBytes(value.salt, 16) ||
      !isBase64UrlBytes(value.digest, parameters.keyLength)) {
    throw new TypeError("Account store contains an invalid password digest.");
  }
  return { algorithm: "scrypt", salt: value.salt, digest: value.digest, ...parameters };
};

const parseState = (value: unknown): PersistedAccountState => {
  if (!isRecord(value) || !hasOnlyKeys(value, STATE_KEYS) ||
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS ||
      !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) {
    throw new TypeError("Account store has an invalid root structure.");
  }
  const sourceVersion = value.version;
  const accountKeys = sourceVersion === 1 ? LEGACY_ACCOUNT_KEYS : CURRENT_ACCOUNT_KEYS;

  const accounts: PersistedAccount[] = value.accounts.map((candidate) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, accountKeys) || candidate.kind !== "registered" ||
        (sourceVersion === 1
          ? candidate.profileState !== undefined && candidate.profileState !== "pending" && candidate.profileState !== "ready"
          : candidate.profileState !== "pending" && candidate.profileState !== "ready") ||
        !isSafeIdentifier(candidate.id) || !isSafeIdentifier(candidate.actorId) ||
        typeof candidate.loginHandle !== "string" || typeof candidate.normalizedHandle !== "string" ||
        typeof candidate.displayName !== "string" || !isCanonicalTimestamp(candidate.createdAt) ||
        !isCanonicalTimestamp(candidate.updatedAt) ||
        (sourceVersion === 1
          ? candidate.romanticInteractionsOptIn !== undefined &&
            typeof candidate.romanticInteractionsOptIn !== "boolean"
          : typeof candidate.adultConfirmed !== "boolean")) {
      throw new TypeError("Account store contains an invalid registered account.");
    }
    const normalized = normalizeLoginHandle(candidate.loginHandle);
    const displayName = normalizeDisplayName(candidate.displayName);
    if (!normalized || normalized.key !== candidate.normalizedHandle || candidate.loginHandle !== normalized.handle ||
        displayName !== candidate.displayName) {
      throw new TypeError("Account store contains a non-canonical registered account.");
    }
    return {
      id: candidate.id,
      kind: "registered",
      // Version 1 predates the two-store account/profile transaction marker.
      profileState: candidate.profileState === "pending" ? "pending" : "ready",
      actorId: candidate.actorId,
      loginHandle: candidate.loginHandle,
      normalizedHandle: candidate.normalizedHandle,
      displayName: candidate.displayName,
      // Version 1 used romantic storyline eligibility as an adult-account
      // proxy. Preserve an explicit true acknowledgement; false or missing is
      // migrated fail-closed. Version 2 stores only the neutral attestation.
      adultConfirmed: sourceVersion === 1
        ? candidate.romanticInteractionsOptIn === true
        : candidate.adultConfirmed === true,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      password: parsePasswordDigest(candidate.password),
    };
  });

  const accountIds = new Set<string>();
  const actorIds = new Set<string>();
  const handles = new Set<string>();
  for (const account of accounts) {
    if (accountIds.has(account.id) || actorIds.has(account.actorId) || handles.has(account.normalizedHandle)) {
      throw new TypeError("Account store contains duplicate account, actor or login identities.");
    }
    accountIds.add(account.id);
    actorIds.add(account.actorId);
    handles.add(account.normalizedHandle);
  }

  const sessionIds = new Set<string>();
  const tokenHashes = new Set<string>();
  const sessions: PersistedSession[] = value.sessions.map((candidate) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, SESSION_KEYS) ||
        !isSafeIdentifier(candidate.id) || !isSafeIdentifier(candidate.accountId) ||
        typeof candidate.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.tokenHash) ||
        !isCanonicalTimestamp(candidate.createdAt) || !isCanonicalTimestamp(candidate.expiresAt) ||
        !accountIds.has(candidate.accountId)) {
      throw new TypeError("Account store contains an invalid session.");
    }
    const session: PersistedSession = {
      id: candidate.id,
      accountId: candidate.accountId,
      tokenHash: candidate.tokenHash,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
    };
    if (sessionIds.has(session.id) || tokenHashes.has(session.tokenHash)) {
      throw new TypeError("Account store contains duplicate sessions.");
    }
    sessionIds.add(session.id);
    tokenHashes.add(session.tokenHash);
    return session;
  });
  return { version: 2, accounts, sessions };
};

const deriveScrypt = (
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> => new Promise((resolvePromise, rejectPromise) => {
  const options: ScryptOptions = {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: parameters.maxmem,
  };
  scrypt(password, salt, parameters.keyLength, options, (error, derivedKey) => {
    if (error) rejectPromise(error);
    else resolvePromise(derivedKey);
  });
});

const digestToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Local, dependency-free account and session authority. It intentionally has
 * no guest API: temporary guests remain a separate runtime concern and can
 * never silently become persisted accounts.
 */
export class AccountStore {
  readonly path: string;
  private state: PersistedAccountState = emptyState();
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;
  private readonly sessionTtlMs: number;
  private readonly loginWindowMs: number;
  private readonly loginMaxFailures: number;
  private readonly loginMaxAttempts: number;
  private readonly loginSourceCapacity: number;
  private readonly maxSessionsPerAccount: number;
  private readonly scryptParameters: ScryptParameters;
  private readonly loginSourceHashKey = randomBytes(32);
  private readonly loginFailures = new Map<string, LoginFailureBucket>();
  private readonly loginAttempts = new Map<string, LoginAttemptBucket>();
  private readonly dummySalt = randomBytes(16);
  private readonly dummyDigest: Buffer;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path = resolve(process.cwd(), process.env.ACCOUNT_STATE_PATH ?? "data/accounts.json"), options: AccountStoreOptions = {}) {
    this.path = resolve(path);
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.randomId = options.randomId ?? randomUUID;
    this.sessionTtlMs = Math.max(
      15 * 60_000,
      Math.min(options.sessionTtlMs ?? ACCOUNT_SESSION_DEFAULT_TTL_MS, ACCOUNT_SESSION_MAX_TTL_MS),
    );
    this.loginWindowMs = Math.max(10_000, Math.min(options.loginWindowMs ?? 10 * 60_000, 60 * 60_000));
    this.loginMaxFailures = Math.max(1, Math.min(options.loginMaxFailures ?? 6, 20));
    this.loginMaxAttempts = Math.max(1, Math.min(options.loginMaxAttempts ?? 30, 120));
    this.loginSourceCapacity = Math.max(1, Math.min(options.loginSourceCapacity ?? ACCOUNT_LOGIN_SOURCE_CAPACITY, 4_096));
    this.maxSessionsPerAccount = Math.max(
      1,
      Math.min(options.maxSessionsPerAccount ?? ACCOUNT_DEFAULT_MAX_SESSIONS_PER_ACCOUNT, 64),
    );
    this.scryptParameters = { ...DEFAULT_SCRYPT_PARAMETERS, ...options.scrypt };
    if (!isValidScryptParameters(this.scryptParameters)) throw new TypeError("Invalid scrypt parameters.");
    this.dummyDigest = randomBytes(this.scryptParameters.keyLength);
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      let next: PersistedAccountState;
      let fileExists = true;
      let migrationSource: string | undefined;
      try {
        const raw = await readFile(this.path, "utf8");
        const persisted = JSON.parse(raw) as unknown;
        next = parseState(persisted);
        // parseState validates the root version before this branch. Keep the
        // exact bytes until the v2 replacement has committed successfully.
        if ((persisted as { version: number }).version === 1) migrationSource = raw;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AccountStoreLoadError(error);
        next = emptyState();
        fileExists = false;
      }
      const now = this.now();
      const sessions = next.sessions.filter((session) => Date.parse(session.expiresAt) > now);
      const pruned = sessions.length !== next.sessions.length;
      next = { ...next, sessions };
      try {
        if (migrationSource !== undefined) {
          await preservePreMigrationState(this.path, migrationSource, 1, 2);
        }
        if (!fileExists || pruned || migrationSource !== undefined) await this.persist(next);
        else await chmod(this.path, 0o600);
      } catch (error) {
        throw new AccountStoreLoadError(error);
      }
      this.state = next;
    });
  }

  listAccounts(): AccountRecord[] {
    return this.state.accounts
      .map(publicAccount)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  getAccount(accountId: string): AccountRecord | undefined {
    const account = this.state.accounts.find((candidate) => candidate.id === accountId);
    return account ? publicAccount(account) : undefined;
  }

  getAccountByActorId(actorId: string): AccountRecord | undefined {
    const account = this.state.accounts.find((candidate) => candidate.actorId === actorId);
    return account ? publicAccount(account) : undefined;
  }

  /** Password re-check for an already authenticated destructive operation. */
  async verifyPassword(accountId: string, password: string): Promise<boolean> {
    return this.enqueue(async () => {
      const account = this.state.accounts.find((candidate) => candidate.id === accountId);
      const passwordWithinBound = codePointLength(password) <= ACCOUNT_PASSWORD_MAX_CHARACTERS;
      const passwordRecord = account?.password;
      const parameters: ScryptParameters = passwordRecord ? {
        N: passwordRecord.N,
        r: passwordRecord.r,
        p: passwordRecord.p,
        keyLength: passwordRecord.keyLength,
        maxmem: passwordRecord.maxmem,
      } : this.scryptParameters;
      const expected = passwordRecord ? Buffer.from(passwordRecord.digest, "base64url") : this.dummyDigest;
      const salt = passwordRecord ? Buffer.from(passwordRecord.salt, "base64url") : this.dummySalt;
      const supplied = passwordWithinBound
        ? await deriveScrypt(password, salt, parameters)
        : randomBytes(expected.length);
      return Boolean(
        account?.profileState === "ready" &&
        passwordWithinBound &&
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected),
      );
    });
  }

  async register(input: RegisterAccountInput): Promise<RegisterAccountResult> {
    const normalized = normalizeLoginHandle(input.loginHandle);
    if (!normalized) return { ok: false, code: "INVALID_HANDLE" };
    const displayName = normalizeDisplayName(input.displayName);
    if (!displayName) return { ok: false, code: "INVALID_DISPLAY_NAME" };
    if (codePointLength(input.password) < ACCOUNT_PASSWORD_MIN_CHARACTERS ||
        codePointLength(input.password) > ACCOUNT_PASSWORD_MAX_CHARACTERS) {
      return { ok: false, code: "WEAK_PASSWORD" };
    }
    if (input.adultConfirmed !== undefined && typeof input.adultConfirmed !== "boolean") {
      throw new TypeError("Adult confirmation must be boolean.");
    }
    if (input.actorId !== undefined && !isSafeIdentifier(input.actorId)) {
      return { ok: false, code: "ACTOR_ALREADY_LINKED" };
    }

    const salt = randomBytes(16);
    const digest = await deriveScrypt(input.password, salt, this.scryptParameters);
    return this.enqueue(async () => {
      if (this.state.accounts.some((account) => account.normalizedHandle === normalized.key)) {
        return { ok: false, code: "HANDLE_TAKEN" } as const;
      }
      const actorId = input.actorId ?? `human-${this.randomId()}`;
      if (!isSafeIdentifier(actorId) || this.state.accounts.some((account) => account.actorId === actorId)) {
        return { ok: false, code: "ACTOR_ALREADY_LINKED" } as const;
      }
      const id = `account-${this.randomId()}`;
      if (!isSafeIdentifier(id) || this.state.accounts.some((account) => account.id === id)) {
        throw new Error("Account ID generator returned a duplicate or invalid identifier.");
      }
      const timestamp = new Date(this.now()).toISOString();
      const account: PersistedAccount = {
        id,
        kind: "registered",
        profileState: "pending",
        actorId,
        loginHandle: normalized.handle,
        normalizedHandle: normalized.key,
        displayName,
        adultConfirmed: input.adultConfirmed ?? false,
        createdAt: timestamp,
        updatedAt: timestamp,
        password: {
          algorithm: "scrypt",
          salt: salt.toString("base64url"),
          digest: digest.toString("base64url"),
          ...this.scryptParameters,
        },
      };
      const next = parseState({ ...this.state, accounts: [...this.state.accounts, account] });
      await this.persist(next);
      this.state = next;
      return { ok: true, account: publicAccount(account) } as const;
    });
  }

  async login(input: AccountLoginInput): Promise<AccountLoginResult> {
    if (input.adultConfirmed !== undefined && typeof input.adultConfirmed !== "boolean") {
      throw new TypeError("Adult confirmation must be boolean.");
    }
    return this.enqueue(async () => {
      const now = this.now();
      const sourceHash = this.sourceHash(input.sourceIdentity);
      this.pruneLoginBudgets(now);
      const retryAfterMs = Math.max(
        this.retryAfterFailures(sourceHash, now),
        this.retryAfterAttempts(sourceHash, now),
      );
      if (retryAfterMs > 0) return { ok: false, code: "RATE_LIMITED", retryAfterMs };
      this.recordLoginAttempt(sourceHash, now);

      const normalized = normalizeLoginHandle(input.loginHandle);
      const account = normalized
        ? this.state.accounts.find((candidate) => candidate.normalizedHandle === normalized.key)
        : undefined;
      const passwordWithinBound = codePointLength(input.password) <= ACCOUNT_PASSWORD_MAX_CHARACTERS;
      const passwordRecord = account?.password;
      const parameters: ScryptParameters = passwordRecord ? {
        N: passwordRecord.N,
        r: passwordRecord.r,
        p: passwordRecord.p,
        keyLength: passwordRecord.keyLength,
        maxmem: passwordRecord.maxmem,
      } : this.scryptParameters;
      const expected = passwordRecord ? Buffer.from(passwordRecord.digest, "base64url") : this.dummyDigest;
      const salt = passwordRecord ? Buffer.from(passwordRecord.salt, "base64url") : this.dummySalt;
      const supplied = passwordWithinBound
        ? await deriveScrypt(input.password, salt, parameters)
        : randomBytes(expected.length);
      if (!account || account.profileState !== "ready" || !passwordWithinBound ||
          supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        this.recordLoginFailure(sourceHash, now);
        return { ok: false, code: "INVALID_CREDENTIALS" };
      }

      this.loginFailures.delete(sourceHash);
      const token = this.randomToken();
      if (token.length < 32 || token.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
        throw new TypeError("Session token generator returned an invalid opaque token.");
      }
      const tokenHash = digestToken(token);
      if (this.state.sessions.some((session) => session.tokenHash === tokenHash)) {
        throw new Error("Session token generator returned a duplicate token.");
      }
      const id = `session-${this.randomId()}`;
      if (!isSafeIdentifier(id) || this.state.sessions.some((session) => session.id === id)) {
        throw new Error("Session ID generator returned a duplicate or invalid identifier.");
      }
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + this.sessionTtlMs).toISOString();
      const session: PersistedSession = { id, accountId: account.id, tokenHash, createdAt, expiresAt };
      const accounts = input.adultConfirmed === true && !account.adultConfirmed
        ? this.state.accounts.map((candidate) => candidate.id === account.id
          ? { ...candidate, adultConfirmed: true, updatedAt: createdAt }
          : candidate)
        : this.state.accounts;
      const next = parseState({
        ...this.state,
        accounts,
        sessions: this.sessionsAfterIssuing(session, now),
      });
      await this.persist(next);
      this.state = next;
      const authenticatedAccount = next.accounts.find((candidate) => candidate.id === account.id);
      if (!authenticatedAccount) throw new Error("Authenticated account disappeared during session issuance.");
      return {
        ok: true,
        token,
        expiresAt,
        sessionId: session.id,
        account: publicAccount(authenticatedAccount),
      };
    });
  }

  /** Trusted post-registration/upgrade session issuance; never accepts a handle or password. */
  async issueSession(
    accountId: string,
    options: { allowPendingProfile?: boolean } = {},
  ): Promise<IssuedAccountSession | undefined> {
    return this.enqueue(async () => {
      const now = this.now();
      const account = this.state.accounts.find((candidate) => candidate.id === accountId);
      if (!account || (account.profileState !== "ready" && !options.allowPendingProfile)) return undefined;
      const token = this.randomToken();
      if (token.length < 32 || token.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
        throw new TypeError("Session token generator returned an invalid opaque token.");
      }
      const tokenHash = digestToken(token);
      if (this.state.sessions.some((session) => session.tokenHash === tokenHash)) {
        throw new Error("Session token generator returned a duplicate token.");
      }
      const id = `session-${this.randomId()}`;
      if (!isSafeIdentifier(id) || this.state.sessions.some((session) => session.id === id)) {
        throw new Error("Session ID generator returned a duplicate or invalid identifier.");
      }
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + this.sessionTtlMs).toISOString();
      const session: PersistedSession = { id, accountId: account.id, tokenHash, createdAt, expiresAt };
      const next = parseState({ ...this.state, sessions: this.sessionsAfterIssuing(session, now) });
      await this.persist(next);
      this.state = next;
      return { token, expiresAt, sessionId: id, account: publicAccount(account) };
    });
  }

  authenticateSession(token: string | undefined): AuthenticatedAccountSession | undefined {
    if (!token || token.length > 512) return undefined;
    const tokenHash = digestToken(token);
    const session = this.state.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session || Date.parse(session.expiresAt) <= this.now()) return undefined;
    const account = this.state.accounts.find((candidate) => candidate.id === session.accountId);
    return account?.profileState === "ready"
      ? { account: publicAccount(account), session: publicSession(session) }
      : undefined;
  }

  isSessionActive(accountId: string, sessionId: string): boolean {
    return this.state.sessions.some((session) =>
      session.accountId === accountId && session.id === sessionId && Date.parse(session.expiresAt) > this.now()
    );
  }

  /** Commits the social-profile half of a local registration/upgrade. */
  async markProfileReady(accountId: string): Promise<AccountRecord | undefined> {
    return this.enqueue(async () => {
      const account = this.state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) return undefined;
      if (account.profileState === "ready") return publicAccount(account);
      const updatedAt = new Date(this.now()).toISOString();
      const next = parseState({
        ...this.state,
        accounts: this.state.accounts.map((candidate) => candidate.id === accountId
          ? { ...candidate, profileState: "ready", updatedAt }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      return this.getAccount(accountId);
    });
  }

  /**
   * Records the account owner's adult-community acknowledgement. Confirmation
   * is intentionally one-way; account deletion remains the way to remove the
   * durable local identity and its acknowledgement.
   */
  async confirmAdult(accountId: string): Promise<AccountRecord | undefined> {
    return this.enqueue(async () => {
      const account = this.state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) return undefined;
      if (account.adultConfirmed) return publicAccount(account);
      const updatedAt = new Date(this.now()).toISOString();
      const next = parseState({
        ...this.state,
        accounts: this.state.accounts.map((candidate) => candidate.id === accountId
          ? { ...candidate, adultConfirmed: true, updatedAt }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      return this.getAccount(accountId);
    });
  }

  async revokeSession(token: string | undefined): Promise<boolean> {
    if (!token || token.length > 512) return false;
    const tokenHash = digestToken(token);
    return this.enqueue(async () => {
      const sessions = this.state.sessions.filter((session) => session.tokenHash !== tokenHash);
      if (sessions.length === this.state.sessions.length) return false;
      const next = parseState({ ...this.state, sessions });
      await this.persist(next);
      this.state = next;
      return true;
    });
  }

  async revokeAllSessions(accountId: string): Promise<number> {
    return this.enqueue(async () => {
      const sessions = this.state.sessions.filter((session) => session.accountId !== accountId);
      const revoked = this.state.sessions.length - sessions.length;
      if (revoked === 0) return 0;
      const next = parseState({ ...this.state, sessions });
      await this.persist(next);
      this.state = next;
      return revoked;
    });
  }

  /** Removes the credential record and every device session, but never social data. */
  async deleteAccount(accountId: string): Promise<AccountRecord | undefined> {
    return this.enqueue(async () => {
      const account = this.state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) return undefined;
      const next = parseState({
        ...this.state,
        accounts: this.state.accounts.filter((candidate) => candidate.id !== accountId),
        sessions: this.state.sessions.filter((session) => session.accountId !== accountId),
      });
      await this.persist(next);
      this.state = next;
      return publicAccount(account);
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private sourceHash(sourceIdentity: string): string {
    return createHmac("sha256", this.loginSourceHashKey)
      .update((sourceIdentity || "unknown").slice(0, 512), "utf8")
      .digest("hex");
  }

  private pruneLoginBudgets(now: number): void {
    for (const [sourceHash, bucket] of this.loginFailures) {
      bucket.failures = bucket.failures.filter((timestamp) => now - timestamp < this.loginWindowMs);
      if (bucket.failures.length === 0) this.loginFailures.delete(sourceHash);
    }
    for (const [sourceHash, bucket] of this.loginAttempts) {
      bucket.attempts = bucket.attempts.filter((timestamp) => now - timestamp < this.loginWindowMs);
      if (bucket.attempts.length === 0) this.loginAttempts.delete(sourceHash);
    }
  }

  private retryAfterFailures(sourceHash: string, now: number): number {
    const bucket = this.loginFailures.get(sourceHash);
    if (!bucket || bucket.failures.length < this.loginMaxFailures) return 0;
    return Math.max(1, bucket.failures[0]! + this.loginWindowMs - now);
  }

  private retryAfterAttempts(sourceHash: string, now: number): number {
    const bucket = this.loginAttempts.get(sourceHash);
    if (!bucket || bucket.attempts.length < this.loginMaxAttempts) return 0;
    return Math.max(1, bucket.attempts[0]! + this.loginWindowMs - now);
  }

  private recordLoginAttempt(sourceHash: string, now: number): void {
    let bucket = this.loginAttempts.get(sourceHash);
    if (!bucket) {
      this.makeSourceCapacity(this.loginAttempts);
      bucket = { attempts: [], lastSeenAt: now };
      this.loginAttempts.set(sourceHash, bucket);
    }
    bucket.lastSeenAt = now;
    bucket.attempts.push(now);
    bucket.attempts = bucket.attempts.slice(-this.loginMaxAttempts);
  }

  private recordLoginFailure(sourceHash: string, now: number): void {
    let bucket = this.loginFailures.get(sourceHash);
    if (!bucket) {
      this.makeSourceCapacity(this.loginFailures);
      bucket = { failures: [], lastSeenAt: now };
      this.loginFailures.set(sourceHash, bucket);
    }
    bucket.lastSeenAt = now;
    bucket.failures.push(now);
    bucket.failures = bucket.failures.slice(-this.loginMaxFailures);
  }

  private makeSourceCapacity<T extends { lastSeenAt: number }>(buckets: Map<string, T>): void {
    if (buckets.size < this.loginSourceCapacity) return;
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [key, candidate] of buckets) {
      if (candidate.lastSeenAt < oldestTimestamp) {
        oldestKey = key;
        oldestTimestamp = candidate.lastSeenAt;
      }
    }
    if (oldestKey) buckets.delete(oldestKey);
  }

  private sessionsAfterIssuing(session: PersistedSession, now: number): PersistedSession[] {
    const active = this.state.sessions.filter((candidate) => Date.parse(candidate.expiresAt) > now);
    const sameAccount = active
      .filter((candidate) => candidate.accountId === session.accountId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const retainedIds = new Set(
      sameAccount.slice(-Math.max(0, this.maxSessionsPerAccount - 1)).map((candidate) => candidate.id),
    );
    return [
      ...active.filter((candidate) => candidate.accountId !== session.accountId || retainedIds.has(candidate.id)),
      session,
    ];
  }

  private async persist(state: PersistedAccountState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
