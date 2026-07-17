export type IdentityJoinMode = "new" | "returning";

export type SessionResult<TMember = unknown> =
  | { ok: true; me: TMember; recoveryKey?: string }
  | { ok: false; error?: string; code?: string; recoveryConfigured?: boolean; online?: boolean };

export type RecoveryKeyResult =
  | { ok: true; recoveryKey?: string }
  | { ok: false; error?: string; code?: string };

const inviteCodes = new Set(["INVITE_REQUIRED", "INVALID_INVITE", "INVITE_INVALID"]);

export const needsIdentityTakeover = (
  mode: IdentityJoinMode,
  status: number,
  result: SessionResult,
) => mode === "returning" && status === 409 && !result.ok && result.code === "IDENTITY_ONLINE";

export const identityJoinError = (
  mode: IdentityJoinMode,
  result: SessionResult | null,
) => {
  const code = result && !result.ok ? result.code : undefined;

  if (inviteCodes.has(code ?? "")) return "That invite code didn't work. Check it and try again.";
  if (code === "BANNED") return "This visit can't be opened. Ask the host if you think that is a mistake.";

  if (mode === "returning") {
    if (code === "RECOVERY_RATE_LIMITED") return "Too many return attempts. Wait a while before trying again.";
    if (code === "KICK_COOLDOWN") return "This identity can't reconnect yet. Wait a little and try again.";
    if (code === "RECOVERY_CHANGED" || code === "RECOVERY_UNAVAILABLE") {
      return "The identity couldn't be moved safely. Its existing login is unchanged; try again shortly.";
    }
    if (code === "ORIGIN_REQUIRED") return "Reload the room before trying the return key again.";
    return "We couldn't return with those details. Check the display name and return key, then try again.";
  }

  if (code === "RETURNING_IDENTITY") {
    return result && !result.ok && result.recoveryConfigured === false
      ? "That name belongs to an earlier saved visit without a return key. Ask the server host to issue one for you."
      : "That name belongs to an earlier saved visit. Choose “I have a return key” below to return as the same person.";
  }
  if (code === "NAME_RESERVED") {
    return "That display name belongs to an AI resident. Choose another name.";
  }
  if (code === "IDENTITY_ONLINE") {
    return "That saved identity is already connected. Use its return key to move it to this browser.";
  }

  return result && !result.ok && result.error
    ? result.error
    : "Could not join the room.";
};

export const returnedRecoveryKey = (result: SessionResult | RecoveryKeyResult | null) => {
  if (!result?.ok || typeof result.recoveryKey !== "string") return undefined;
  const key = result.recoveryKey.trim();
  return key || undefined;
};
