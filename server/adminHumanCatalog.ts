import type { AdminHumanMember } from "../shared/adminTypes.js";
import type { Member } from "../shared/types.js";
import type { AccountRecord } from "./accountStore.js";
import type { HumanMemoryProfile } from "./humanMemory.js";

interface AdminHumanCatalogInput {
  profiles: readonly HumanMemoryProfile[];
  visibleMembers: readonly Member[];
  accounts: readonly AccountRecord[];
  hasRecoveryKey: (actorId: string) => boolean;
  now?: number;
}

/** Admin inventory is durable-profile based; the public offline roster is not. */
export const buildAdminHumanCatalog = (input: AdminHumanCatalogInput): AdminHumanMember[] => {
  const visibleHumans = new Map(
    input.visibleMembers
      .filter((member): member is Member & { kind: "human" } => member.kind === "human")
      .map((member) => [member.id, member]),
  );
  const profiles = new Map(input.profiles.map((profile) => [profile.member.id, profile]));
  const accounts = new Map(input.accounts.map((account) => [account.actorId, account]));
  const actorIds = new Set([...profiles.keys(), ...visibleHumans.keys(), ...accounts.keys()]);
  const now = input.now ?? Date.now();

  const members: AdminHumanMember[] = [];
  for (const actorId of actorIds) {
    const profile = profiles.get(actorId);
    const account = accounts.get(actorId);
    const visible = visibleHumans.get(actorId);
    const member = visible ?? profile?.member;
    if (!member) continue;
    const recoveryConfigured = !account && input.hasRecoveryKey(actorId);
    members.push({
      id: actorId,
      name: account?.displayName ?? member.name,
      status: visible?.status ?? "offline",
      identityKind: account ? "registered" as const : recoveryConfigured ? "legacy" as const : "guest" as const,
      recoveryConfigured,
      joinedAt: new Date(profile?.createdAt ?? now).toISOString(),
    });
  }
  return members.sort((left, right) => left.name.localeCompare(right.name));
};
