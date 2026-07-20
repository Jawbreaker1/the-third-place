import { describe, expect, it } from "vitest";
import {
  activePublicChannelId,
  replacementPublicChannelId,
} from "./channelLifecycle.js";

describe("public channel lifecycle", () => {
  it("routes a renamed room to its canonical successor", () => {
    expect(replacementPublicChannelId("ai-lab")).toBe("ai-programming");
    expect(activePublicChannelId("ai-lab")).toBe("ai-programming");
  });

  it("does not expose a retired room as an active destination", () => {
    expect(replacementPublicChannelId("side-quests")).toBe("side-quests");
    expect(activePublicChannelId("side-quests")).toBeUndefined();
  });

  it("preserves unknown administrator-created room IDs", () => {
    expect(replacementPublicChannelId("custom-room")).toBe("custom-room");
    expect(activePublicChannelId("custom-room")).toBe("custom-room");
  });
});
