import { describe, expect, it } from "vitest";
import {
  extractPreviewUrl,
  isPublicAddress,
  parseLinkMetadata,
  resolvePublicAddress,
  validatePreviewUrl,
} from "./linkPreviewBroker.js";

describe("link preview broker", () => {
  it("accepts only ordinary public HTTPS URLs", () => {
    expect(validatePreviewUrl("https://example.com/story")?.hostname).toBe("example.com");
    expect(validatePreviewUrl("http://example.com/story")).toBeUndefined();
    expect(validatePreviewUrl("https://user:pass@example.com/story")).toBeUndefined();
    expect(validatePreviewUrl("https://example.com:8443/story")).toBeUndefined();
    expect(validatePreviewUrl("https://127.0.0.1/story")).toBeUndefined();
    expect(validatePreviewUrl("https://service.internal/story")).toBeUndefined();
  });

  it("rejects private, mapped and reserved network destinations", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("::ffff:192.168.1.2")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
  });

  it("bounds DNS resolution by the shared request deadline", async () => {
    const startedAt = Date.now();
    const address = await resolvePublicAddress(
      "slow.example",
      startedAt + 30,
      async () => await new Promise<Array<{ address: string; family: number }>>(() => undefined),
    );
    expect(address).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("extracts only the first link and trims sentence punctuation", () => {
    expect(extractPreviewUrl("see https://example.com/story). then https://example.org")?.toString()).toBe(
      "https://example.com/story",
    );
  });

  it("normalizes a naked www link for previews without enabling a full page read", () => {
    expect(extractPreviewUrl("kolla www.fz.se).")?.toString()).toBe("https://www.fz.se/");
  });

  it("extracts explicit IDNs beside no-space prose while rejecting ambiguous bare-domain prose", () => {
    expect(extractPreviewUrl("看https://例子.中国/新闻。")?.toString()).toBe(
      "https://xn--fsqu00a.xn--fiqs8s/%E6%96%B0%E9%97%BB",
    );
    expect(extractPreviewUrl("شاهدhttps://مثال.إختبار؟")?.hostname).toBe("xn--mgbh0fb.xn--kgbechtv");
    expect(extractPreviewUrl("看例子.中国新闻")).toBeUndefined();
    expect(extractPreviewUrl("user@example.com")).toBeUndefined();
  });

  it("parses inert text metadata and ignores page-controlled canonical URLs", () => {
    const finalUrl = new URL("https://example.com/final");
    const preview = parseLinkMetadata(
      `<html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="Useful &amp; safe title">
        <meta property="og:description" content="A short description">
        <meta property="og:site_name" content="Example News">
        <meta property="og:url" content="https://evil.invalid/redirect">
        <script>throw new Error('never executed')</script>
      </head></html>`,
      finalUrl,
    );
    expect(preview).toMatchObject({
      url: "https://example.com/final",
      displayHost: "example.com",
      title: "Useful & safe title",
      description: "A short description",
      siteName: "Example News",
    });
  });

  it("strips dangerous controls and active markup from metadata while preserving natural RTL text", () => {
    const preview = parseLinkMetadata(
      `<html><head>
        <meta property="og:title" content="خبر آمن‮txt">
        <meta property="og:description" content="تفاصيل‪ موثوقة‬ هنا">
        <script><meta property="og:title" content="Injected title"></script>
        <noscript><title>Injected fallback</title></noscript>
      </head></html>`,
      new URL("https://xn--mgbh0fb.xn--kgbechtv/story"),
    );
    expect(preview).toMatchObject({
      title: "خبر آمنtxt",
      description: "تفاصيل موثوقة هنا",
      displayHost: "xn--mgbh0fb.xn--kgbechtv",
    });
    expect(JSON.stringify(preview)).not.toContain("Injected");
    expect(JSON.stringify(preview)).not.toContain("\u202e");
  });

  it("uses an early standards-based meta charset fallback for Windows-1251 metadata", () => {
    const encoded = Buffer.from("3c68746d6c3e3c686561643e3c6d65746120687474702d65717569763d22436f6e74656e742d547970652220636f6e74656e743d22746578742f68746d6c3b20636861727365743d77696e646f77732d31323531223e3c6d6574612070726f70657274793d226f673a7469746c652220636f6e74656e743d22cdeee2eef1f2e820ece8f0e0223e3c2f686561643e3c2f68746d6c3e", "hex");
    const preview = parseLinkMetadata(encoded, new URL("https://example.ru/news"));
    expect(preview?.title).toBe("Новости мира");
    expect(preview?.title).not.toContain("�");
  });

  it("aborts hostile HTML inside parse5's real tree builder", () => {
    const attack = `<!-- --!>${"<div>".repeat(34_000)}${"</div>".repeat(34_000)}-->`;
    const startedAt = Date.now();
    expect(parseLinkMetadata(attack, new URL("https://example.com"))).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(500);
    const attributes = Array.from({ length: 34_000 }, (_, index) => ` a${index}=x`).join("");
    const attributeAttack = `<html><head><meta${attributes}></head></html>`;
    const attributeStartedAt = Date.now();
    expect(parseLinkMetadata(attributeAttack, new URL("https://example.com"))).toBeUndefined();
    expect(Date.now() - attributeStartedAt).toBeLessThan(500);
  });

  it("labels redirected metadata with its final host without exposing a redirect URL", () => {
    const preview = parseLinkMetadata(
      "<html><head><title>Redirected story</title></head></html>",
      new URL("https://destination.example/story?server_token=secret"),
      new URL("https://shared.example/go"),
    );
    expect(preview).toMatchObject({
      url: "https://shared.example/go",
      displayHost: "destination.example",
      siteName: "destination.example",
      title: "Redirected story",
    });
    expect(JSON.stringify(preview)).not.toContain("server_token");
  });
});
