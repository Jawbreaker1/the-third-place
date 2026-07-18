export type TrustedActorKind = "human" | "resident";

export interface LiveActorKindRegistry {
  /** Consult the current trusted resident catalog on every lookup. */
  isResident(actorId: string): boolean;
  /** Consult the current trusted human identity stores on every lookup. */
  isHuman(actorId: string): boolean;
}

/**
 * Builds a fail-closed actor-kind lookup without snapshotting either registry.
 *
 * Admin catalog mutations replace the live resident collection at runtime and
 * account/profile stores finish loading after parts of server construction.
 * Keeping the registry callbacks live ensures those later trusted changes are
 * visible to relationship-budget decisions.
 */
export const createLiveActorKindResolver = (
  registry: LiveActorKindRegistry,
): ((actorId: string) => TrustedActorKind | undefined) => (actorId) => {
  if (registry.isResident(actorId)) return "resident";
  if (registry.isHuman(actorId)) return "human";
  return undefined;
};
