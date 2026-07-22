import { describe, expect, it } from "vitest";
import {
  EXTERNAL_AGENT_IDLE_AFTER_MS,
  EXTERNAL_AGENT_OFFLINE_AFTER_MS,
  ExternalAgentPresenceRuntime,
} from "./externalAgentPresence.js";

describe("ExternalAgentPresenceRuntime", () => {
  it("starts offline and derives idle/offline without durable false-green state", () => {
    let now = 1_000;
    const runtime = new ExternalAgentPresenceRuntime(() => now);
    expect(runtime.status("agent-a")).toBe("offline");
    expect(runtime.noteAuthenticated("agent-a")).toBe("online");
    now += EXTERNAL_AGENT_IDLE_AFTER_MS;
    expect(runtime.status("agent-a")).toBe("idle");
    now = 1_000 + EXTERNAL_AGENT_OFFLINE_AFTER_MS;
    expect(runtime.status("agent-a")).toBe("offline");
  });

  it("keeps polling authentication separate from meaningful activity", () => {
    let now = 1_000;
    const runtime = new ExternalAgentPresenceRuntime(() => now);
    runtime.noteInteractive("agent-a");
    now += EXTERNAL_AGENT_IDLE_AFTER_MS;
    runtime.noteAuthenticated("agent-a");
    expect(runtime.status("agent-a")).toBe("idle");
    expect(runtime.noteInteractive("agent-a")).toBe("online");
  });

  it("honors explicit idle heartbeats and forgets revoked runtime state", () => {
    const runtime = new ExternalAgentPresenceRuntime(() => 1_000);
    expect(runtime.heartbeat("agent-a", "idle")).toBe("idle");
    expect(runtime.noteAuthenticated("agent-a")).toBe("idle");
    expect(runtime.forget("agent-a")).toBe(true);
    expect(runtime.status("agent-a")).toBe("offline");
  });
});
