import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_PASSWORD_MIN_CHARACTERS,
  AccountStore,
  AccountStoreLoadError,
  normalizeLoginHandle,
} from "./accountStore.js";

const directories: string[] = [];
const makePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-accounts-"));
  directories.push(directory);
  return join(directory, "accounts.json");
};

const fastScrypt = {
  N: 1_024,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 4 * 1_024 * 1_024,
} as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local account store", () => {
  it("persists one stable social actor and authenticates it after restart", async () => {
    const path = await makePath();
    const first = new AccountStore(path, {
      scrypt: fastScrypt,
      randomToken: () => "first_session_token_is_opaque_and_long_enough_123",
    });
    await first.load();

    expect(ACCOUNT_PASSWORD_MIN_CHARACTERS).toBe(8);
    const registration = await first.register({
      loginHandle: "  Jöhän  ",
      displayName: "  Johan på telefon  ",
      password: "correct horse battery staple",
      actorId: "human-existing-johan",
    });
    expect(registration).toMatchObject({
      ok: true,
      account: {
        kind: "registered",
        profileState: "pending",
        actorId: "human-existing-johan",
        loginHandle: "Jöhän",
        displayName: "Johan på telefon",
        adultConfirmed: false,
      },
    });
    if (!registration.ok) return;
    expect(await first.markProfileReady(registration.account.id)).toMatchObject({ profileState: "ready" });

    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain("correct horse battery staple");
    expect(stored).not.toContain("first_session_token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const restored = new AccountStore(path, {
      scrypt: fastScrypt,
      randomToken: () => "first_session_token_is_opaque_and_long_enough_123",
    });
    await restored.load();
    expect(restored.getAccountByActorId("human-existing-johan")?.id).toBe(registration.account.id);

    const login = await restored.login({
      loginHandle: "JÖHÄN",
      password: "correct horse battery staple",
      sourceIdentity: "203.0.113.4",
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(restored.authenticateSession(login.token)).toMatchObject({
      account: { id: registration.account.id, actorId: "human-existing-johan" },
      session: { id: login.sessionId, accountId: registration.account.id },
    });

    const persistedAfterLogin = await readFile(path, "utf8");
    expect(persistedAfterLogin).not.toContain(login.token);
    expect(JSON.parse(persistedAfterLogin).sessions[0].tokenHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("persists a one-way adult-community confirmation across restarts", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 18, 10, 0, 0);
    const first = new AccountStore(path, { now: () => now, scrypt: fastScrypt });
    await first.load();
    const registration = await first.register({
      loginHandle: "adult-confirmation",
      displayName: "Adult confirmation",
      password: "confirmation-password",
      actorId: "human-adult-confirmation",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;

    expect(registration.account.adultConfirmed).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).accounts[0].adultConfirmed).toBe(false);

    now += 1_000;
    const confirmed = await first.confirmAdult(registration.account.id);
    expect(confirmed).toMatchObject({
      id: registration.account.id,
      actorId: "human-adult-confirmation",
      adultConfirmed: true,
      updatedAt: new Date(now).toISOString(),
    });
    expect(JSON.parse(await readFile(path, "utf8")).accounts[0].adultConfirmed).toBe(true);

    now += 1_000;
    const unchanged = await first.confirmAdult(registration.account.id);
    expect(unchanged?.updatedAt).toBe(confirmed?.updatedAt);
    expect(await first.confirmAdult("account-missing")).toBeUndefined();

    const restored = new AccountStore(path, { now: () => now, scrypt: fastScrypt });
    await restored.load();
    expect(restored.getAccountByActorId("human-adult-confirmation")?.adultConfirmed).toBe(true);
  });

  it("can persist an adult confirmation atomically when registering", async () => {
    const path = await makePath();
    const store = new AccountStore(path, { scrypt: fastScrypt });
    await store.load();
    const registration = await store.register({
      loginHandle: "confirmed-at-entry",
      displayName: "Confirmed at entry",
      password: "confirmed-password",
      adultConfirmed: true,
    });
    expect(registration).toMatchObject({ ok: true, account: { adultConfirmed: true } });
    expect(JSON.parse(await readFile(path, "utf8")).accounts[0]).toMatchObject({
      adultConfirmed: true,
    });
    await expect(store.register({
      loginHandle: "invalid-confirmation",
      displayName: "Invalid confirmation",
      password: "confirmed-password",
      adultConfirmed: "true" as never,
    })).rejects.toThrow(TypeError);
  });

  it("confirms an existing account only after a valid login and returns the confirmed account", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 18, 11, 0, 0);
    const store = new AccountStore(path, {
      now: () => now,
      scrypt: fastScrypt,
      randomToken: () => "adult_confirmation_login_token_aaaaaaaaaaaaaa",
    });
    await store.load();
    const registration = await store.register({
      loginHandle: "confirm-on-login",
      displayName: "Confirm on login",
      password: "confirmation-password",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);
    expect(store.getAccount(registration.account.id)?.adultConfirmed).toBe(false);

    const failed = await store.login({
      loginHandle: "confirm-on-login",
      password: "wrong-password",
      adultConfirmed: true,
      sourceIdentity: "failed-source",
    });
    expect(failed).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(store.getAccount(registration.account.id)?.adultConfirmed).toBe(false);

    now += 1_000;
    const login = await store.login({
      loginHandle: "confirm-on-login",
      password: "confirmation-password",
      adultConfirmed: true,
      sourceIdentity: "valid-source",
    });
    expect(login).toMatchObject({
      ok: true,
      account: {
        id: registration.account.id,
        adultConfirmed: true,
        updatedAt: new Date(now).toISOString(),
      },
    });
    if (!login.ok) return;
    expect(store.authenticateSession(login.token)?.account.adultConfirmed).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).accounts[0].adultConfirmed).toBe(true);

    await expect(store.login({
      loginHandle: "confirm-on-login",
      password: "confirmation-password",
      adultConfirmed: "true" as never,
      sourceIdentity: "invalid-input",
    })).rejects.toThrow(TypeError);
  });

  it("migrates v1 romantic eligibility to v2 with an exact, private rollback backup", async () => {
    const path = await makePath();
    const first = new AccountStore(path, { scrypt: fastScrypt });
    await first.load();
    for (const suffix of ["true", "false", "missing"] as const) {
      const registration = await first.register({
        loginHandle: `legacy-${suffix}`,
        displayName: `Legacy ${suffix}`,
        password: "legacy-password",
      });
      expect(registration.ok).toBe(true);
    }

    const legacy = JSON.parse(await readFile(path, "utf8"));
    expect(legacy.version).toBe(2);
    legacy.version = 1;
    for (const account of legacy.accounts) delete account.adultConfirmed;
    legacy.accounts[0].romanticInteractionsOptIn = true;
    legacy.accounts[1].romanticInteractionsOptIn = false;
    delete legacy.accounts[2].profileState;
    const legacyBytes = ` ${JSON.stringify(legacy, null, 1)}\n`;
    await writeFile(path, legacyBytes, "utf8");

    const restored = new AccountStore(path, { scrypt: fastScrypt });
    await restored.load();
    expect(restored.getAccountByActorId(legacy.accounts[0].actorId)?.adultConfirmed).toBe(true);
    expect(restored.getAccountByActorId(legacy.accounts[1].actorId)?.adultConfirmed).toBe(false);
    expect(restored.getAccountByActorId(legacy.accounts[2].actorId)?.adultConfirmed).toBe(false);

    const normalized = JSON.parse(await readFile(path, "utf8"));
    expect(normalized.version).toBe(2);
    expect(normalized.accounts.map((account: Record<string, unknown>) => account.adultConfirmed)).toEqual([
      true,
      false,
      false,
    ]);
    expect(normalized.accounts[2].profileState).toBe("ready");
    expect(normalized.accounts.every((account: Record<string, unknown>) =>
      !("romanticInteractionsOptIn" in account))).toBe(true);

    const backupNames = (await readdir(dirname(path))).filter((name) =>
      name.startsWith("accounts.json.pre-v2-from-1-") && name.endsWith(".bak")
    );
    expect(backupNames).toHaveLength(1);
    const backupPath = join(dirname(path), backupNames[0]!);
    expect(await readFile(backupPath, "utf8")).toBe(legacyBytes);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("leaves valid v1 bytes untouched when its rollback backup cannot be secured", async () => {
    const path = await makePath();
    const first = new AccountStore(path, { scrypt: fastScrypt });
    await first.load();
    const registration = await first.register({
      loginHandle: "backup-failure",
      displayName: "Backup failure",
      password: "backup-password",
    });
    expect(registration.ok).toBe(true);

    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.version = 1;
    delete legacy.accounts[0].adultConfirmed;
    legacy.accounts[0].romanticInteractionsOptIn = true;
    const legacyBytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, legacyBytes, "utf8");

    const digest = createHash("sha256").update(legacyBytes, "utf8").digest("hex").slice(0, 16);
    const backupPath = `${path}.pre-v2-from-1-${digest}.bak`;
    // A directory at the content-addressed target deterministically simulates
    // a backup write failure without monkey-patching filesystem primitives.
    await mkdir(backupPath);

    const restored = new AccountStore(path, { scrypt: fastScrypt });
    await expect(restored.load()).rejects.toBeInstanceOf(AccountStoreLoadError);
    expect(restored.listAccounts()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(legacyBytes);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    expect((await readdir(dirname(path))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it.each([
    ["a non-boolean adult confirmation", (account: Record<string, unknown>) => {
      account.adultConfirmed = "false";
    }],
    ["a missing adult confirmation", (account: Record<string, unknown>) => {
      delete account.adultConfirmed;
    }],
    ["a non-boolean legacy preference", (account: Record<string, unknown>) => {
      delete account.adultConfirmed;
      account.romanticInteractionsOptIn = "false";
    }],
    ["both the new and legacy fields", (account: Record<string, unknown>) => {
      account.adultConfirmed = true;
      account.romanticInteractionsOptIn = true;
    }],
    ["a consent-shaped unknown field", (account: Record<string, unknown>) => {
      account.romanticInteractionsConsent = true;
    }],
  ])("rejects %s without rewriting the source file", async (_description, tamper) => {
    const path = await makePath();
    const first = new AccountStore(path, { scrypt: fastScrypt });
    await first.load();
    const registration = await first.register({
      loginHandle: "strict-preference",
      displayName: "Strict preference",
      password: "strict-password",
    });
    expect(registration.ok).toBe(true);

    const persisted = JSON.parse(await readFile(path, "utf8"));
    tamper(persisted.accounts[0] as Record<string, unknown>);
    const tamperedSource = `${JSON.stringify(persisted)}\n`;
    await writeFile(path, tamperedSource, "utf8");

    const restored = new AccountStore(path, { scrypt: fastScrypt });
    await expect(restored.load()).rejects.toBeInstanceOf(AccountStoreLoadError);
    expect(await readFile(path, "utf8")).toBe(tamperedSource);
  });

  it("keeps handles Unicode-capable but case-insensitively unique, including concurrent registration", async () => {
    const path = await makePath();
    const store = new AccountStore(path, { scrypt: fastScrypt });
    await store.load();
    expect(normalizeLoginHandle(" Åsa.東京_7 ")).toEqual({ handle: "Åsa.東京_7", key: "åsa.東京_7" });
    expect(normalizeLoginHandle("contains spaces")).toBeUndefined();
    expect(normalizeLoginHandle("Straße")?.key).toBe(normalizeLoginHandle("STRASSE")?.key);

    const [first, second] = await Promise.all([
      store.register({ loginHandle: "Åsa", displayName: "Åsa", password: "password-one" }),
      store.register({ loginHandle: "ÅSA", displayName: "Another display name", password: "password-two" }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toEqual({ ok: false, code: "HANDLE_TAKEN" });
    expect(store.listAccounts()).toHaveLength(1);
  });

  it("keeps a pending account unusable until its social profile transaction commits", async () => {
    const path = await makePath();
    const store = new AccountStore(path, {
      scrypt: fastScrypt,
      randomToken: () => "pending_profile_session_aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await store.load();
    const registration = await store.register({
      loginHandle: "pending-user",
      displayName: "Pending user",
      password: "pending-password",
      actorId: "human-pending-profile",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;

    expect(store.getAccount(registration.account.id)?.profileState).toBe("pending");
    expect(await store.issueSession(registration.account.id)).toBeUndefined();
    expect((await store.login({
      loginHandle: "pending-user",
      password: "pending-password",
      sourceIdentity: "local",
    })).ok).toBe(false);

    const staged = await store.issueSession(registration.account.id, { allowPendingProfile: true });
    expect(staged).toBeDefined();
    expect(store.authenticateSession(staged?.token)).toBeUndefined();
    expect(await store.markProfileReady(registration.account.id)).toMatchObject({ profileState: "ready" });
    expect(store.authenticateSession(staged?.token)?.account.actorId).toBe("human-pending-profile");
  });

  it("supports independent device sessions, revoking the current session or every session", async () => {
    const path = await makePath();
    const tokens = [
      "desktop_session_token_aaaaaaaaaaaaaaaaaaaaaaaa",
      "phone_session_token_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    ];
    const store = new AccountStore(path, {
      scrypt: fastScrypt,
      randomToken: () => tokens.shift()!,
    });
    await store.load();
    const registration = await store.register({
      loginHandle: "johan",
      displayName: "Johan",
      password: "password-for-johan",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);

    const desktop = await store.login({
      loginHandle: "johan",
      password: "password-for-johan",
      sourceIdentity: "desktop",
    });
    const phone = await store.login({
      loginHandle: "johan",
      password: "password-for-johan",
      sourceIdentity: "phone",
    });
    expect(desktop.ok && phone.ok).toBe(true);
    if (!desktop.ok || !phone.ok) return;
    expect(desktop.sessionId).not.toBe(phone.sessionId);
    expect(store.authenticateSession(desktop.token)).toBeDefined();
    expect(store.authenticateSession(phone.token)).toBeDefined();

    expect(await store.revokeSession(desktop.token)).toBe(true);
    expect(store.authenticateSession(desktop.token)).toBeUndefined();
    expect(store.authenticateSession(phone.token)).toBeDefined();
    expect(await store.revokeAllSessions(registration.account.id)).toBe(1);
    expect(store.authenticateSession(phone.token)).toBeUndefined();
    expect(await store.revokeAllSessions(registration.account.id)).toBe(0);
  });

  it("caps active device sessions per account and evicts the oldest one", async () => {
    const path = await makePath();
    const tokens = [
      "capped_session_token_aaaaaaaaaaaaaaaaaaaaaaaaa",
      "capped_session_token_bbbbbbbbbbbbbbbbbbbbbbbbb",
      "capped_session_token_ccccccccccccccccccccccccccc",
    ];
    const store = new AccountStore(path, {
      scrypt: fastScrypt,
      maxSessionsPerAccount: 2,
      randomToken: () => tokens.shift()!,
    });
    await store.load();
    const registration = await store.register({
      loginHandle: "bounded-devices",
      displayName: "Bounded devices",
      password: "bounded-device-password",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);

    const first = await store.login({ loginHandle: "bounded-devices", password: "bounded-device-password", sourceIdentity: "one" });
    const second = await store.login({ loginHandle: "bounded-devices", password: "bounded-device-password", sourceIdentity: "two" });
    const third = await store.login({ loginHandle: "bounded-devices", password: "bounded-device-password", sourceIdentity: "three" });
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(store.authenticateSession(first.token)).toBeUndefined();
    expect(store.authenticateSession(second.token)).toBeDefined();
    expect(store.authenticateSession(third.token)).toBeDefined();
  });

  it("deletes one registered credential and all of its device sessions without guessing at social data", async () => {
    const path = await makePath();
    const store = new AccountStore(path, {
      scrypt: fastScrypt,
      randomToken: () => "account_delete_session_eeeeeeeeeeeeeeeeeeeeeeee",
    });
    await store.load();
    const registration = await store.register({
      loginHandle: "delete-me",
      displayName: "Delete me",
      password: "password-delete-me",
      actorId: "human-social-actor",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);
    const login = await store.login({
      loginHandle: "delete-me",
      password: "password-delete-me",
      sourceIdentity: "local",
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(await store.verifyPassword(registration.account.id, "wrong-password")).toBe(false);
    expect(await store.verifyPassword(registration.account.id, "password-delete-me")).toBe(true);

    expect(await store.deleteAccount(registration.account.id)).toMatchObject({
      actorId: "human-social-actor",
      loginHandle: "delete-me",
    });
    expect(store.getAccountByActorId("human-social-actor")).toBeUndefined();
    expect(store.authenticateSession(login.token)).toBeUndefined();
    expect(await store.deleteAccount(registration.account.id)).toBeUndefined();
  });

  it("issues a trusted first session after registration without reprocessing the password", async () => {
    const path = await makePath();
    const store = new AccountStore(path, {
      scrypt: fastScrypt,
      randomToken: () => "post_registration_session_fffffffffffffffffffffff",
    });
    await store.load();
    const registration = await store.register({
      loginHandle: "first-session",
      displayName: "First session",
      password: "password-first-session",
    });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);
    const issued = await store.issueSession(registration.account.id);
    expect(issued).toMatchObject({ account: { id: registration.account.id } });
    expect(store.authenticateSession(issued?.token)).toMatchObject({
      account: { actorId: registration.account.actorId },
      session: { id: issued?.sessionId },
    });
  });

  it("returns enumeration-safe login failures and a source-local retry time", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 18, 10, 0, 0);
    const tokens = [
      "valid_session_token_cccccccccccccccccccccccccc",
      "valid_session_token_dddddddddddddddddddddddddd",
    ];
    const store = new AccountStore(path, {
      now: () => now,
      scrypt: fastScrypt,
      loginMaxFailures: 2,
      loginWindowMs: 60_000,
      randomToken: () => tokens.shift()!,
    });
    await store.load();
    const registration = await store.register({ loginHandle: "mira", displayName: "Mira", password: "mira-password" });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);

    expect(await store.login({
      loginHandle: "missing-account",
      password: "mira-password",
      sourceIdentity: "198.51.100.10",
    })).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(await store.login({
      loginHandle: "mira",
      password: "wrong-password",
      sourceIdentity: "198.51.100.10",
    })).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(await store.login({
      loginHandle: "mira",
      password: "mira-password",
      sourceIdentity: "198.51.100.10",
    })).toEqual({ ok: false, code: "RATE_LIMITED", retryAfterMs: 60_000 });

    expect((await store.login({
      loginHandle: "mira",
      password: "mira-password",
      sourceIdentity: "198.51.100.11",
    })).ok).toBe(true);
    expect(JSON.stringify(store)).not.toContain("198.51.100.10");
    now += 60_001;
    expect((await store.login({
      loginHandle: "mira",
      password: "mira-password",
      sourceIdentity: "198.51.100.10",
    })).ok).toBe(true);
  });

  it("does not let a valid account reset the source-wide login attempt budget", async () => {
    const path = await makePath();
    const store = new AccountStore(path, {
      scrypt: fastScrypt,
      loginMaxFailures: 10,
      loginMaxAttempts: 3,
      loginWindowMs: 60_000,
      randomToken: () => "valid_budget_session_token_aaaaaaaaaaaaaaaaaaaa",
    });
    await store.load();
    const registration = await store.register({ loginHandle: "attacker", displayName: "Attacker", password: "known-password" });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await store.markProfileReady(registration.account.id);

    const sourceIdentity = "198.51.100.42";
    expect((await store.login({ loginHandle: "victim", password: "guess-one", sourceIdentity })).ok).toBe(false);
    expect((await store.login({ loginHandle: "attacker", password: "known-password", sourceIdentity })).ok).toBe(true);
    expect((await store.login({ loginHandle: "victim", password: "guess-two", sourceIdentity })).ok).toBe(false);
    expect(await store.login({ loginHandle: "attacker", password: "known-password", sourceIdentity })).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
    });
  });

  it("never admits a guest-shaped persisted record as a registered account", async () => {
    const path = await makePath();
    const first = new AccountStore(path, { scrypt: fastScrypt });
    await first.load();
    const registration = await first.register({
      loginHandle: "visitor",
      displayName: "Visitor",
      password: "visitor-password",
    });
    expect(registration.ok).toBe(true);

    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.accounts[0].kind = "guest";
    await writeFile(path, `${JSON.stringify(tampered)}\n`, "utf8");
    const restored = new AccountStore(path, { scrypt: fastScrypt });
    await expect(restored.load()).rejects.toBeInstanceOf(AccountStoreLoadError);
    expect(await readFile(path, "utf8")).toContain('"kind":"guest"');
  });

  it("tightens legacy file permissions and removes expired sessions on restart", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 18, 12, 0, 0);
    const first = new AccountStore(path, {
      now: () => now,
      scrypt: fastScrypt,
      sessionTtlMs: 15 * 60_000,
      randomToken: () => "expiring_session_token_dddddddddddddddddddddddd",
    });
    await first.load();
    const registration = await first.register({ loginHandle: "otto", displayName: "Otto", password: "otto-password" });
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    await first.markProfileReady(registration.account.id);
    const login = await first.login({
      loginHandle: "otto",
      password: "otto-password",
      sourceIdentity: "local",
    });
    expect(login.ok).toBe(true);
    await chmod(path, 0o644);

    now += 15 * 60_000;
    const restored = new AccountStore(path, { now: () => now, scrypt: fastScrypt });
    await restored.load();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).sessions).toEqual([]);
    if (login.ok) expect(restored.authenticateSession(login.token)).toBeUndefined();
  });
});
