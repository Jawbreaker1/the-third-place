import { describe, expect, it } from "vitest";
import { resolveSnapshotConversationId } from "./channelNavigation";

const channels = ["lobby", "ai-programming", "the-pub"];

describe("snapshot conversation navigation", () => {
  it("keeps an active public room or DM unchanged", () => {
    expect(resolveSnapshotConversationId("the-pub", channels, ["dm:1"])).toBe("the-pub");
    expect(resolveSnapshotConversationId("dm:1", channels, ["dm:1"])).toBe("dm:1");
  });

  it("moves an old ai-lab view into ai-programming", () => {
    expect(resolveSnapshotConversationId("ai-lab", channels, [])).toBe("ai-programming");
  });

  it("moves a retired room to lobby and remains safe without public rooms", () => {
    expect(resolveSnapshotConversationId("side-quests", channels, [])).toBe("lobby");
    expect(resolveSnapshotConversationId("side-quests", [], ["dm:1"])).toBe("dm:1");
  });
});
