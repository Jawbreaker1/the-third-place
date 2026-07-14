import { describe, expect, it } from "vitest";
import type { ChatMessage, Member } from "../shared/types";
import { clearChannelNotice, messageAddressesMember, nextDmUnread, noteChannelMessage, type ChannelNotices } from "./unread";

const member: Member = {
  id: "human-johan",
  name: "Johan",
  kind: "human",
  status: "online",
  avatar: { color: "#111", accent: "#222", glyph: "J" },
};

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message-1",
  channelId: "lobby",
  authorId: "ai-mira",
  content: "vanligt kanalprat",
  createdAt: "2026-07-13T18:00:00.000Z",
  reactions: [],
  ...overrides,
});

describe("messageAddressesMember", () => {
  it("counts a case-insensitive explicit @mention", () => {
    expect(messageAddressesMember(message({ content: "Vad tror du, @JOHAN?" }), member)).toBe(true);
  });

  it("counts a reply to the member's message", () => {
    expect(messageAddressesMember(message({
      replyToId: "human-message",
      replyPreview: { authorId: member.id, authorName: member.name, content: "min tanke" },
    }), member)).toBe(true);
  });

  it("does not count ordinary channel traffic or a longer similar name", () => {
    expect(messageAddressesMember(message(), member)).toBe(false);
    expect(messageAddressesMember(message({ content: "@Johanna, vad tror du?" }), member)).toBe(false);
  });

  it("does not mistake an email address for a mention", () => {
    expect(messageAddressesMember(message({ content: "mejla test@johan.se" }), member)).toBe(false);
  });

  it("does not count a username-looking URL path", () => {
    expect(messageAddressesMember(message({ content: "profil: https://example.com/@Johan" }), member)).toBe(false);
    expect(messageAddressesMember(message({ content: "profil: www.example.com/@Johan" }), member)).toBe(false);
    expect(messageAddressesMember(message({ content: "見てhttps://例え.テスト/@Johan。" }), member)).toBe(false);
  });

  it("recognizes exact mentions beside no-space CJK and RTL prose", () => {
    expect(messageAddressesMember(message({ content: "你好@Johan，你觉得呢" }), member)).toBe(true);
    expect(messageAddressesMember(message({ content: "مرحبا@Johan؟" }), member)).toBe(true);
    expect(messageAddressesMember(message({ content: "@Johan你好" }), member)).toBe(true);
    expect(messageAddressesMember(message({ content: "@Johanمرحبا" }), member)).toBe(true);
  });

  it("still rejects longer ASCII and Unicode display-name collisions", () => {
    expect(messageAddressesMember(message({ content: "@Johanna" }), member)).toBe(false);
    expect(messageAddressesMember(message({ content: "@Johan_2" }), member)).toBe(false);
    expect(messageAddressesMember(message({ content: "@Johan.exe" }), member)).toBe(false);
    const cjkMember = { ...member, name: "小明" };
    expect(messageAddressesMember(message({ content: "@小明白" }), cjkMember)).toBe(false);
    expect(messageAddressesMember(message({ content: "你好@小明。" }), cjkMember)).toBe(true);
  });

  it("never counts the member's own message", () => {
    expect(messageAddressesMember(message({ authorId: member.id, content: "@Johan anteckning" }), member)).toBe(false);
  });

  it("escapes punctuation in display names", () => {
    expect(messageAddressesMember(message({ content: "@Johan.exe den här är din" }), { ...member, name: "Johan.exe" })).toBe(true);
  });

  it("does not turn a system message into a mention", () => {
    expect(messageAddressesMember(message({ content: "@Johan joined", system: true }), member)).toBe(false);
  });
});

describe("channel notices", () => {
  it("marks ordinary off-channel traffic unread without a number", () => {
    expect(noteChannelMessage({}, message({ channelId: "the-pub" }), "lobby", member)).toEqual({
      "the-pub": { unread: true, mentions: 0 },
    });
  });

  it("increments once when a message both replies to and mentions the member", () => {
    const addressed = message({
      channelId: "the-pub",
      content: "@Johan, precis",
      replyToId: "human-message",
      replyPreview: { authorId: member.id, authorName: member.name, content: "min tanke" },
    });
    expect(noteChannelMessage({}, addressed, "lobby", member)["the-pub"]).toEqual({ unread: true, mentions: 1 });
  });

  it("ignores active-channel and self-authored traffic", () => {
    const existing: ChannelNotices = { lobby: { unread: true, mentions: 1 } };
    expect(noteChannelMessage(existing, message(), "lobby", member)).toBe(existing);
    expect(noteChannelMessage(existing, message({ channelId: "the-pub", authorId: member.id }), "lobby", member)).toBe(existing);
  });

  it("caps mention counts and clears the selected channel", () => {
    const existing: ChannelNotices = { "the-pub": { unread: true, mentions: 99 } };
    const mentioned = message({ channelId: "the-pub", content: "@Johan" });
    expect(noteChannelMessage(existing, mentioned, "lobby", member)["the-pub"]?.mentions).toBe(99);
    expect(clearChannelNotice(existing, "the-pub")["the-pub"]).toEqual({ unread: false, mentions: 0 });
  });
});

describe("DM unread", () => {
  it("counts only incoming traffic outside the active thread", () => {
    const incoming = message({ channelId: "dm-1", authorId: "ai-mira" });
    expect(nextDmUnread(2, incoming, "dm-1", "lobby", member.id)).toBe(3);
    expect(nextDmUnread(2, incoming, "dm-1", "dm-1", member.id)).toBe(0);
    expect(nextDmUnread(2, { ...incoming, authorId: member.id }, "dm-1", "lobby", member.id)).toBe(2);
  });
});
