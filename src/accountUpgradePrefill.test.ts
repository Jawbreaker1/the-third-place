import { describe, expect, it } from "vitest";
import { accountUpgradePrefill } from "./accountUpgradePrefill";

describe("account upgrade username prefill", () => {
  it("starts a new guest with their exact current display name", () => {
    expect(accountUpgradePrefill(
      { identityId: null, handle: "" },
      { id: "human-jaw", name: "Jaw_B" },
    )).toEqual({ identityId: "human-jaw", handle: "Jaw_B" });
  });

  it("does not overwrite an edited or intentionally cleared handle for the same identity", () => {
    expect(accountUpgradePrefill(
      { identityId: "human-jaw", handle: "johan" },
      { id: "human-jaw", name: "Jaw_B" },
    )).toEqual({ identityId: "human-jaw", handle: "johan" });
    expect(accountUpgradePrefill(
      { identityId: "human-jaw", handle: "" },
      { id: "human-jaw", name: "Jaw_B" },
    )).toEqual({ identityId: "human-jaw", handle: "" });
  });

  it("re-seeds for another guest and clears when no upgradeable identity remains", () => {
    expect(accountUpgradePrefill(
      { identityId: "human-old", handle: "custom" },
      { id: "human-new", name: "New Guest" },
    )).toEqual({ identityId: "human-new", handle: "New Guest" });
    expect(accountUpgradePrefill(
      { identityId: "human-new", handle: "New Guest" },
      null,
    )).toEqual({ identityId: null, handle: "" });
  });
});
