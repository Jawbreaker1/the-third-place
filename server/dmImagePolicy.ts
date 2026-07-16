import type { ImageAnalysis } from "../shared/types.js";

export type DmImageVisionPlan =
  | {
    kind: "resident_vision";
    residentId: string;
    initialAnalysis: Extract<ImageAnalysis, { status: "pending" }>;
  }
  | {
    kind: "private_storage_only";
    initialAnalysis: Extract<ImageAnalysis, { status: "not_requested" }>;
  };

/**
 * Chooses vision from exact trusted actor IDs only. Display names, ID prefixes,
 * message text and locale never participate in this private-boundary decision.
 */
export const planDmImageVision = (
  participantIds: readonly [string, string],
  uploaderId: string,
  residentIds: ReadonlySet<string>,
): DmImageVisionPlan => {
  if (!participantIds.includes(uploaderId)) {
    return { kind: "private_storage_only", initialAnalysis: { status: "not_requested" } };
  }
  const peerId = participantIds.find((participantId) => participantId !== uploaderId);
  if (!peerId || !residentIds.has(peerId)) {
    return { kind: "private_storage_only", initialAnalysis: { status: "not_requested" } };
  }
  return {
    kind: "resident_vision",
    residentId: peerId,
    initialAnalysis: { status: "pending" },
  };
};

/** Executes only a previously trusted resident plan; private-only plans no-op. */
export const startPlannedDmImageVision = <T>(
  plan: DmImageVisionPlan,
  start: (residentId: string) => T,
): T | undefined => plan.kind === "resident_vision" ? start(plan.residentId) : undefined;
