import { describe, expect, it, vi } from "vitest";
import { decideCapabilityParticipation } from "./capabilityParticipation.js";

const persona = {
  conscientiousness: 0.56,
  talkativeness: 0.92,
  mentionResponse: 0.99,
};

describe("capability participation", () => {
  it("allows a rare explicit social decline before a first external attempt", () => {
    expect(decideCapabilityParticipation({
      persona,
      invocation: { externalEvidence: true, requestKind: "execute" },
      directlyAddressed: true,
      urgency: 0.1,
      automatic: false,
      recovery: false,
      rng: () => 0,
    })).toBe("decline");
  });

  it.each(["retry", "correct_limitation"] as const)("never relabels a %s failure as reluctance", (requestKind) => {
    const rng = vi.fn(() => 0);
    expect(decideCapabilityParticipation({
      persona,
      invocation: { externalEvidence: true, requestKind },
      directlyAddressed: true,
      urgency: 0,
      automatic: false,
      recovery: false,
      rng,
    })).toBe("attempt");
    expect(rng).not.toHaveBeenCalled();
  });

  it("never declines passive automatic reads or urgent requests", () => {
    expect(decideCapabilityParticipation({
      persona,
      invocation: { externalEvidence: true, requestKind: "execute" },
      directlyAddressed: false,
      urgency: 0,
      automatic: true,
      recovery: false,
      rng: () => 0,
    })).toBe("attempt");
    expect(decideCapabilityParticipation({
      persona,
      invocation: { externalEvidence: true, requestKind: "execute" },
      directlyAddressed: false,
      urgency: 0.9,
      automatic: false,
      recovery: false,
      rng: () => 0,
    })).toBe("attempt");
  });

  it("never turns an internal capability into a social refusal", () => {
    const rng = vi.fn(() => 0);
    expect(decideCapabilityParticipation({
      persona,
      invocation: { externalEvidence: false, requestKind: "execute" },
      directlyAddressed: true,
      urgency: 0,
      automatic: false,
      recovery: false,
      rng,
    })).toBe("attempt");
    expect(rng).not.toHaveBeenCalled();
  });

  it("never re-rolls an interrupted durable turn into social reluctance", () => {
    const rng = vi.fn(() => 0);
    expect(decideCapabilityParticipation({
      persona,
      invocation: { externalEvidence: true, requestKind: "execute" },
      directlyAddressed: true,
      urgency: 0,
      automatic: false,
      recovery: true,
      rng,
    })).toBe("attempt");
    expect(rng).not.toHaveBeenCalled();
  });
});
