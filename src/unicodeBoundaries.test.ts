import { describe, expect, it } from "vitest";
import { containsExactMention, findExactMentionRanges, findUrlTextCandidates } from "../shared/unicodeBoundaries";

describe("shared Unicode URL boundaries", () => {
  it("keeps client-style links separate from adjacent no-space prose", () => {
    const content = "見てhttp://example.comニュース";
    const match = findUrlTextCandidates(content, { allowHttp: true, allowWww: false })[0];
    expect(match).toMatchObject({ value: "http://example.com" });
    expect(content.slice(match?.end)).toBe("ニュース");
  });

  it("uses the public suffix boundary for same-script IDNs", () => {
    expect(findUrlTextCandidates("看https://例子.中国新闻")[0]?.value).toBe("https://例子.中国");
    expect(findUrlTextCandidates("見てhttps://foo.exampleニュース")[0]?.value).toBe("https://foo.example");
  });

  it("bounds public-suffix work for an adversarial no-space suffix", () => {
    const suffix = "続".repeat(4_000);
    const started = performance.now();
    expect(findUrlTextCandidates(`https://example.com${suffix}`)[0]?.value).toBe("https://example.com");
    // This is deliberately generous for shared CI. The old per-code-point PSL
    // scan took hundreds of milliseconds and scaled with the attacker suffix.
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("preserves legitimate Unicode IDNs and Unicode paths", () => {
    expect(findUrlTextCandidates("https://例子.中国/新闻/今天")[0]?.value).toBe("https://例子.中国/新闻/今天");
    expect(findUrlTextCandidates("https://例え.テスト/記事")[0]?.value).toBe("https://例え.テスト/記事");
    expect(findUrlTextCandidates("https://उदाहरण.भारत/लेख")[0]?.value).toBe("https://उदाहरण.भारत/लेख");
  });

  it("shares Unicode mention boundaries with client rendering", () => {
    const content = "こんにちは@Mira次、@Miraé と @ミラ次。https://example.com/@Mira";
    expect(findExactMentionRanges(content, ["Mira", "ミラ"]).map((item) => item.value))
      .toEqual(["@Mira", "@ミラ"]);
    expect(containsExactMention(content, "Mira")).toBe(true);
    expect(containsExactMention("@Miraé", "Mira")).toBe(false);
    expect(containsExactMention("@ミラ次", "ミラ")).toBe(true);
  });

  it("keeps canonical mention matching and original UI offsets in sync", () => {
    const content = "ﬀ före @Jose\u0301 och inget mer";
    const start = content.indexOf("@");
    const ranges = findExactMentionRanges(content, ["José"]);
    expect(ranges).toEqual([{
      value: "@Jose\u0301",
      name: "José",
      start,
      end: start + "@Jose\u0301".length,
    }]);
    expect(containsExactMention(content, "José")).toBe(true);
  });

  it("uses full Unicode folding without collapsing dotless-i identities", () => {
    const content = "@STRASSE möter @ı och @I";
    expect(findExactMentionRanges(content, ["Straße", "ı", "i"]).map((range) => range.name))
      .toEqual(["Straße", "ı", "i"]);
    expect(containsExactMention("@i", "ı")).toBe(false);
    expect(containsExactMention("@ı", "i")).toBe(false);
  });

  it("does not address a short Persian name inside a joined full name", () => {
    const content = "سلام @علی‌رضا";
    expect(containsExactMention(content, "علی")).toBe(false);
    expect(containsExactMention(content, "علی‌رضا")).toBe(true);
    expect(findExactMentionRanges(content, ["علی", "علی‌رضا"]).map((range) => range.name))
      .toEqual(["علی‌رضا"]);
  });
});
