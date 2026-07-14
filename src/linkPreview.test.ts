import { describe, expect, it } from "vitest";
import { formatSourceDate, linkPreviewAriaLabel, linkPreviewDomainLabel } from "./linkPreview";

describe("link preview presentation", () => {
  it("does not repeat a host when site and display names differ only by www or case", () => {
    expect(linkPreviewDomainLabel("example.com", "www.example.com")).toBe("example.com");
    expect(linkPreviewDomainLabel("WWW.Example.com.", "example.com")).toBe("WWW.Example.com.");
    expect(linkPreviewDomainLabel("Example News", "www.example.com")).toBe("Example News · www.example.com");
  });

  it("normalizes valid source dates for semantic time markup and rejects invalid dates", () => {
    expect(formatSourceDate("Mon, 14 Jul 2025 10:00:00 GMT", "en-US")).toEqual({
      label: "Jul 14, 2025",
      dateTime: "2025-07-14T10:00:00.000Z",
    });
    expect(formatSourceDate("not-a-date", "en-US")).toBeUndefined();
    expect(formatSourceDate(undefined, "en-US")).toBeUndefined();
  });

  it("uses a concise explicit accessible label for ordinary and sourced cards", () => {
    expect(linkPreviewAriaLabel("  A concrete\nsource  ", true)).toBe(
      "Open looked-up source: A concrete source (opens in a new tab)",
    );
    expect(linkPreviewAriaLabel("Release notes", false)).toBe(
      "Open link preview: Release notes (opens in a new tab)",
    );
  });
});
