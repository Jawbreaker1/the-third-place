import { describe, expect, it } from "vitest";
import type { HumanMemoryProfile } from "./humanMemory.js";
import { buildAdminHumanCatalog } from "./adminHumanCatalog.js";

const offlineLegacyProfile: HumanMemoryProfile = {
  tokenHash: "a".repeat(64),
  member: {
    id: "human-offline-legacy",
    name: "Offline legacy",
    kind: "human",
    status: "offline",
    avatar: { color: "#111111", accent: "#eeeeee", glyph: "O" },
    role: "Guest",
    bio: "A returning person.",
  },
  createdAt: 1_000,
  lastSeenAt: 2_000,
  visitCount: 1,
  facts: [],
  channelScores: [],
  relations: {},
  recoveryConfigured: false,
};

describe("admin human catalog", () => {
  it("keeps an offline credentialed profile visible even when the public roster omits it", () => {
    const catalog = buildAdminHumanCatalog({
      profiles: [offlineLegacyProfile],
      visibleMembers: [],
      accounts: [],
      hasRecoveryKey: () => false,
    });
    expect(catalog).toEqual([expect.objectContaining({
      id: "human-offline-legacy",
      status: "offline",
      identityKind: "guest",
      recoveryConfigured: false,
    })]);
  });

  it("reflects a newly issued return key without requiring the person to reconnect", () => {
    const catalog = buildAdminHumanCatalog({
      profiles: [{ ...offlineLegacyProfile, recoveryConfigured: true }],
      visibleMembers: [],
      accounts: [],
      hasRecoveryKey: (actorId) => actorId === "human-offline-legacy",
    });
    expect(catalog[0]).toMatchObject({ identityKind: "legacy", recoveryConfigured: true });
  });
});
