import { describe, expect, it } from "vitest";
import { participantIdentityKey } from "./participantIdentity.js";

describe("participant identity key", () => {
  it("matches the reservation boundary across case and harmless separators", () => {
    expect(participantIdentityKey("Jaw_B")).toBe(participantIdentityKey("jaw b"));
    expect(participantIdentityKey("M.I-R_A")).toBe(participantIdentityKey("mira"));
  });
});
