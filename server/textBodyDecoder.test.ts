import { describe, expect, it } from "vitest";
import { decodeTextBody } from "./textBodyDecoder.js";

describe("bounded standards-based text decoding", () => {
  const windows1252Html = (): Buffer => Buffer.concat([
    Buffer.from('<meta charset="windows-1252"><p>caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("</p>", "ascii"),
  ]);

  it("falls back safely to UTF-8 when an HTTP charset label is unsupported", () => {
    const source = "Καλημέρα — こんにちは — مرحبًا";
    expect(decodeTextBody(Buffer.from(source), {
      contentType: "text/plain; charset=not-a-real-encoding",
      maxBytes: 1_024,
    })).toBe(source);
  });

  it("uses a supported HTTP charset before a conflicting HTML meta declaration", () => {
    const body = Buffer.from('<meta charset="windows-1251"><p>日本語</p>', "utf8");
    expect(decodeTextBody(body, {
      contentType: "text/html; charset=utf-8",
      allowHtmlMeta: true,
      maxBytes: 1_024,
    })).toContain("日本語");
  });

  it("honours an explicit byte-order mark before a conflicting transport label", () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("日本語", "utf8")]);
    expect(decodeTextBody(body, {
      contentType: "text/html; charset=windows-1251",
      allowHtmlMeta: true,
      maxBytes: 1_024,
    })).toBe("日本語");
  });

  it("applies BOM, HTTP, early HTML meta and UTF-8 fallback in that exact order", () => {
    const utf16Le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("مرحبا", "utf16le"),
    ]);
    expect(decodeTextBody(utf16Le, {
      contentType: "text/html; charset=windows-1252",
      allowHtmlMeta: true,
      maxBytes: 1_024,
    })).toBe("مرحبا");

    const utf8WithConflictingMeta = Buffer.from('<meta charset="windows-1252"><p>Καλημέρα</p>', "utf8");
    expect(decodeTextBody(utf8WithConflictingMeta, {
      contentType: "text/html; charset=utf-8",
      allowHtmlMeta: true,
      maxBytes: 1_024,
    })).toContain("Καλημέρα");

    expect(decodeTextBody(windows1252Html(), {
      contentType: "text/html",
      allowHtmlMeta: true,
      maxBytes: 1_024,
    })).toContain("café");

    const declarationFreeUtf8 = "हिंदी — עברית — 한국어";
    expect(decodeTextBody(Buffer.from(declarationFreeUtf8), {
      contentType: "text/plain",
      allowHtmlMeta: false,
      maxBytes: 1_024,
    })).toBe(declarationFreeUtf8);
  });

  it("falls through an unsupported HTTP label to a supported early HTML meta declaration", () => {
    expect(decodeTextBody(windows1252Html(), {
      contentType: "text/html; charset=not-a-real-encoding",
      allowHtmlMeta: true,
      maxBytes: 1_024,
    })).toContain("café");
  });

  it("ignores HTML encoding declarations outside the bounded early scan", () => {
    const lateDeclaration = Buffer.concat([
      Buffer.from(" ".repeat(4_097), "ascii"),
      windows1252Html(),
    ]);
    const decoded = decodeTextBody(lateDeclaration, {
      contentType: "text/html",
      allowHtmlMeta: true,
      maxBytes: 8_192,
    });
    expect(decoded).not.toContain("café");
    expect(decoded).toContain("caf�");
  });

  it("does not interpret HTML meta syntax in plain text", () => {
    const source = '<meta charset="windows-1251"> Привет';
    expect(decodeTextBody(Buffer.from(source), {
      contentType: "text/plain",
      allowHtmlMeta: false,
      maxBytes: 1_024,
    })).toBe(source);
  });

  it("rejects a body beyond the caller's transport bound before decoding", () => {
    expect(decodeTextBody(Buffer.alloc(33), { contentType: "text/plain", maxBytes: 32 })).toBeUndefined();
  });
});
