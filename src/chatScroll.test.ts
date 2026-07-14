import { describe, expect, it } from "vitest";
import { conversationEntryTarget, type ConversationViewport } from "./chatScroll";

const saved: ConversationViewport = { messageId: "visible-before-switch", offsetTop: 73, atBottom: false };

describe("conversation entry scroll target", () => {
  it("lands at the first unread message before a stale manual viewport", () => {
    expect(conversationEntryTarget("the-pub", "first-new", saved)).toEqual({
      channelId: "the-pub",
      kind: "message",
      messageId: "first-new",
      offsetTop: 28,
    });
  });

  it("restores the visible row when there are no newer unread messages", () => {
    expect(conversationEntryTarget("lobby", undefined, saved)).toEqual({
      channelId: "lobby",
      kind: "message",
      messageId: "visible-before-switch",
      offsetTop: 73,
    });
  });

  it("opens at the latest message when the previous viewport was already read", () => {
    expect(conversationEntryTarget("lobby", undefined, { ...saved, atBottom: true })).toEqual({
      channelId: "lobby",
      kind: "bottom",
    });
  });

  it("opens a never-visited conversation at the bottom", () => {
    expect(conversationEntryTarget("dm-1", undefined, undefined)).toEqual({
      channelId: "dm-1",
      kind: "bottom",
    });
  });
});
