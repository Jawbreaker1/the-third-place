import { describe, expect, it } from "vitest";
import { parseCookieHeader } from "./cookies.js";

describe("bounded cookie parsing", () => {
  it("never throws on malformed percent encoding or separator-free parts", () => {
    expect(() => parseCookieHeader("atrium_session=%; broken; other=%E0%A4%A")).not.toThrow();
    expect(parseCookieHeader("atrium_session=%; broken; safe=value")).toEqual({ safe: "value" });
  });

  it("preserves encoded values containing equals and lets the first duplicate win", () => {
    expect(parseCookieHeader("atrium_session=real%3Dtoken; atrium_session=shadow; theme=dark")).toEqual({
      atrium_session: "real=token",
      theme: "dark",
    });
  });

  it("fails closed for unreasonably large or numerous cookie headers", () => {
    expect(parseCookieHeader(`a=${"x".repeat(16_384)}`)).toEqual({});
    expect(parseCookieHeader(Array.from({ length: 65 }, (_, index) => `c${index}=v`).join(";"))).toEqual({});
  });
});
