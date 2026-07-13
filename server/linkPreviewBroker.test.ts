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
