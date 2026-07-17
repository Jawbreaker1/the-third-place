import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const HUMAN_IDENTITY_RECOVERY_KEY_PREFIX = "ttp_";
export const HUMAN_IDENTITY_RECOVERY_KEY_RANDOM_BYTES = 24;
const ENCODED_KEY_LENGTH = 32;
const RECOVERY_KEY = /^ttp_[A-Za-z\d_-]{32}$/u;
const RECOVERY_KEY_HASH = /^[a-f\d]{64}$/u;
const DUMMY_RECOVERY_KEY_HASH = createHash("sha256")
  .update("the-third-place:invalid-human-identity-recovery-key", "utf8")
  .digest("hex");

/** A copy/paste recovery credential with 192 bits of server-generated entropy. */
export const generateHumanIdentityRecoveryKey = (): string =>
  `${HUMAN_IDENTITY_RECOVERY_KEY_PREFIX}${randomBytes(HUMAN_IDENTITY_RECOVERY_KEY_RANDOM_BYTES).toString("base64url")}`;

/**
 * Credentials are case-sensitive opaque bytes. Leading and trailing whitespace
 * from copy/paste is the only normalization allowed.
 */
export const normalizeHumanIdentityRecoveryKey = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  if (!RECOVERY_KEY.test(normalized)) return undefined;
  const encoded = normalized.slice(HUMAN_IDENTITY_RECOVERY_KEY_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.length !== HUMAN_IDENTITY_RECOVERY_KEY_RANDOM_BYTES ||
    decoded.toString("base64url") !== encoded ||
    encoded.length !== ENCODED_KEY_LENGTH
  ) return undefined;
  return normalized;
};

export const isHumanIdentityRecoveryKeyHash = (value: unknown): value is string =>
  typeof value === "string" && RECOVERY_KEY_HASH.test(value);

export const hashHumanIdentityRecoveryKey = (raw: unknown): string => {
  const normalized = normalizeHumanIdentityRecoveryKey(raw);
  if (!normalized) throw new TypeError("A valid human identity recovery key is required.");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
};

/**
 * Compares two fixed-width digests even when either side is absent or malformed.
 * The final validity mask prevents the dummy value from authenticating.
 */
export const humanIdentityRecoveryKeyHashesMatch = (
  candidateHash: unknown,
  expectedHash: unknown,
): boolean => {
  const candidateValid = isHumanIdentityRecoveryKeyHash(candidateHash);
  const expectedValid = isHumanIdentityRecoveryKeyHash(expectedHash);
  const candidateBytes = Buffer.from(candidateValid ? candidateHash : DUMMY_RECOVERY_KEY_HASH, "hex");
  const expectedBytes = Buffer.from(expectedValid ? expectedHash : DUMMY_RECOVERY_KEY_HASH, "hex");
  const equal = timingSafeEqual(candidateBytes, expectedBytes);
  return candidateValid && expectedValid && equal;
};

/** Raw-key convenience wrapper for HTTP authentication boundaries. */
export const verifyHumanIdentityRecoveryKey = (
  candidate: unknown,
  expectedHash: unknown,
): boolean => {
  const normalized = normalizeHumanIdentityRecoveryKey(candidate);
  const candidateHash = normalized
    ? createHash("sha256").update(normalized, "utf8").digest("hex")
    : undefined;
  return humanIdentityRecoveryKeyHashesMatch(candidateHash, expectedHash);
};
