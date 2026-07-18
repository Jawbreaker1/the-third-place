export interface AccountUpgradePrefillState {
  identityId: string | null;
  handle: string;
}

export interface UpgradeableGuestIdentity {
  id: string;
  name: string;
}

/**
 * Seeds an account-upgrade handle exactly once for each guest identity.
 * Subsequent presence updates keep whatever the human typed, including an
 * intentionally cleared field; switching identities starts from the new
 * guest's current display name.
 */
export const accountUpgradePrefill = (
  current: AccountUpgradePrefillState,
  identity: UpgradeableGuestIdentity | null,
): AccountUpgradePrefillState => {
  if (!identity) return { identityId: null, handle: "" };
  if (current.identityId === identity.id) return current;
  return { identityId: identity.id, handle: identity.name };
};
