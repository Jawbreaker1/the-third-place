import { describe, expect, it } from "vitest";
import { AdminModerationGuard } from "./adminModeration.js";

describe("admin moderation reconnect guard", () => {
  it("uses member/name identity, survives harmless separator changes and expires without IP state", () => {
    let now = 1_000;
    const guard = new AdminModerationGuard({ now: () => now, kickCooldownMs: 5_000 });
    expect(guard.kick("human-1", "Jaw_B")).toBe(6_000);
    expect(guard.isKicked("human-1", "renamed")).toBe(true);
    expect(guard.isKicked(undefined, "jaw b")).toBe(true);
    expect(JSON.stringify(guard)).not.toMatch(/ip|address|socket/iu);
    now = 6_000;
    expect(guard.isKicked("human-1", "Jaw_B")).toBe(false);
  });

  it("can clear a cooldown explicitly", () => {
    const guard = new AdminModerationGuard({ kickCooldownMs: 5_000 });
    guard.kick("human-2", "Alex");
    guard.clear("human-2");
    expect(guard.isKicked("human-2", "Different")).toBe(false);
  });

  it("falls back to a finite cooldown when environment parsing supplies NaN", () => {
    let now = 1_000;
    const guard = new AdminModerationGuard({ now: () => now, kickCooldownMs: Number.NaN });
    expect(guard.kick("human-3", "Finite")).toBe(301_000);
    now = 301_000;
    expect(guard.isKicked("human-3", "Finite")).toBe(false);
  });
});
