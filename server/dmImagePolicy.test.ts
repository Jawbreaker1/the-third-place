import { describe, expect, it, vi } from "vitest";
import { planDmImageVision, startPlannedDmImageVision } from "./dmImagePolicy.js";

describe("private DM image vision policy", () => {
  it("stores a human-to-human image terminally without starting model vision", () => {
    const plan = planDmImageVision(
      ["human-johan", "human-friend"],
      "human-johan",
      new Set(["ai-mira"]),
    );
    const startVision = vi.fn();

    expect(plan).toEqual({
      kind: "private_storage_only",
      initialAnalysis: { status: "not_requested" },
    });
    expect(startPlannedDmImageVision(plan, startVision)).toBeUndefined();
    expect(startVision).not.toHaveBeenCalled();
  });

  it("starts vision exactly once for the trusted resident peer", () => {
    const plan = planDmImageVision(
      ["ai-mira", "human-johan"],
      "human-johan",
      new Set(["ai-mira"]),
    );
    const startVision = vi.fn((residentId: string) => `started:${residentId}`);

    expect(plan).toEqual({
      kind: "resident_vision",
      residentId: "ai-mira",
      initialAnalysis: { status: "pending" },
    });
    expect(startPlannedDmImageVision(plan, startVision)).toBe("started:ai-mira");
    expect(startVision).toHaveBeenCalledOnce();
    expect(startVision).toHaveBeenCalledWith("ai-mira");
  });

  it("fails closed when the uploader is not in the trusted participant tuple", () => {
    const plan = planDmImageVision(
      ["ai-mira", "human-johan"],
      "human-outsider",
      new Set(["ai-mira"]),
    );
    const startVision = vi.fn();

    expect(plan.kind).toBe("private_storage_only");
    startPlannedDmImageVision(plan, startVision);
    expect(startVision).not.toHaveBeenCalled();
  });
});
