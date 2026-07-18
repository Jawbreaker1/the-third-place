import { describe, expect, it } from "vitest";
import { HumanPresenceRuntime } from "./humanPresence.js";

const idleAfterMs = 60_000;

describe("HumanPresenceRuntime", () => {
  it("moves a visible connection from online to idle at the exact server-owned boundary", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);
    presence.connect("socket-a", { visible: true, active: true }, 1_000);

    expect(presence.status(60_999)).toBe("online");
    expect(presence.status(61_000)).toBe("idle");
    expect(presence.status(90_000)).toBe("idle");
  });

  it("treats hidden connections as idle immediately and ignores hidden activity", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);
    presence.connect("socket-a", { visible: true, active: true }, 1_000);
    expect(presence.status(1_000)).toBe("online");

    presence.update("socket-a", { visible: false, active: false }, 2_000);
    expect(presence.status(2_000)).toBe("idle");

    presence.update("socket-a", { visible: false, active: true }, 3_000);
    expect(presence.status(3_000)).toBe("idle");

    presence.update("socket-a", { visible: true, active: true }, 4_000);
    expect(presence.status(4_000)).toBe("online");
  });

  it("aggregates multiple tabs with any active tab winning", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);
    presence.connect("hidden-tab", { visible: false, active: false }, 1_000);
    presence.connect("active-tab", { visible: true, active: true }, 1_000);

    expect(presence.status(1_000)).toBe("online");
    presence.update("active-tab", { visible: false, active: false }, 2_000);
    expect(presence.status(2_000)).toBe("idle");
    presence.update("hidden-tab", { visible: true, active: true }, 3_000);
    expect(presence.status(3_000)).toBe("online");
  });

  it("derives idle or offline correctly as sockets disconnect", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);
    presence.connect("idle-tab", { visible: false, active: false }, 1_000);
    presence.connect("active-tab", { visible: true, active: true }, 1_000);

    presence.disconnect("active-tab");
    expect(presence.status(2_000)).toBe("idle");
    presence.disconnect("idle-tab");
    expect(presence.status(2_000)).toBe("offline");
  });

  it("keeps a trusted voice participant online even with a hidden page", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);
    presence.connect("voice-tab", { visible: false, active: false }, 1_000);
    expect(presence.status(1_000)).toBe("idle");

    presence.setVoiceConnected("voice-tab", true);
    expect(presence.status(500_000)).toBe("online");
    presence.setVoiceConnected("voice-tab", false);
    expect(presence.status(500_000)).toBe("idle");
  });

  it("ignores delayed events for removed sockets and clears revoked sessions", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);
    presence.connect("old-socket", { visible: true, active: true }, 1_000);
    presence.clear();

    expect(presence.update("old-socket", { visible: true, active: true }, 2_000)).toBe(false);
    expect(presence.setVoiceConnected("old-socket", true)).toBe(false);
    expect(presence.status(2_000)).toBe("offline");

    presence.connect("replacement-socket", { visible: false, active: false }, 3_000);
    expect(presence.disconnect("old-socket")).toBe(false);
    expect(presence.status(3_000)).toBe("idle");
  });

  it("does not turn a visible but already-idle reconnect into activity", () => {
    const presence = new HumanPresenceRuntime(idleAfterMs);

    presence.connect("reconnected-socket", { visible: true, active: false }, 120_000);

    expect(presence.status(120_000)).toBe("idle");
    presence.update("reconnected-socket", { visible: true, active: true }, 121_000);
    expect(presence.status(121_000)).toBe("online");
  });
});
