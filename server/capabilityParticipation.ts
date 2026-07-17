import type { Persona } from "./personas.js";
import type { CapabilityInvocation } from "./capabilities/registry.js";

export type CapabilityParticipationDecision = "attempt" | "decline";

/**
 * A social decision made before any external action starts. It is deliberately
 * independent from capability success/failure so an outage can never be
 * rewritten as personality. Retries and corrections always attempt: once a
 * resident has engaged with the request, "couldn't be bothered" is no longer
 * an honest explanation for a failed turn.
 */
export const decideCapabilityParticipation = (input: {
  persona: Pick<Persona, "conscientiousness" | "talkativeness" | "mentionResponse">;
  invocation: Pick<CapabilityInvocation, "externalEvidence" | "requestKind">;
  directlyAddressed: boolean;
  urgency: number;
  automatic: boolean;
  recovery: boolean;
  rng: () => number;
}): CapabilityParticipationDecision => {
  if (
    input.automatic ||
    input.recovery ||
    !input.invocation.externalEvidence ||
    input.invocation.requestKind !== "execute" ||
    input.urgency >= 0.72
  ) return "attempt";

  const reluctance = 1 - input.persona.conscientiousness;
  const quietness = 1 - input.persona.talkativeness;
  const addressResistance = 1 - input.persona.mentionResponse;
  const chance = input.directlyAddressed
    ? Math.min(0.07, 0.012 + reluctance * 0.055 + addressResistance * 0.03)
    : Math.min(0.2, 0.055 + reluctance * 0.1 + quietness * 0.035);
  return input.rng() < chance ? "decline" : "attempt";
};
