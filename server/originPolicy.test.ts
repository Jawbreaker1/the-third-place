import { describe, expect, it } from "vitest";
import {
  configuredWebOrigin,
  parseWebOriginConfiguration,
  socketOriginAllowed,
} from "./originPolicy.js";

describe("deployment origin configuration", () => {
  it("accepts and normalizes exact localhost and ngrok HTTP(S) origins", () => {
    expect(parseWebOriginConfiguration(
      " http://localhost:4000, http://127.0.0.1:4000/, https://demo.ngrok.app ",
      "https://demo.ngrok.app/",
    )).toEqual({
      configuredOrigins: [
        "http://localhost:4000",
        "http://127.0.0.1:4000",
        "https://demo.ngrok.app",
      ],
      publicOrigin: "https://demo.ngrok.app",
    });
    expect(parseWebOriginConfiguration(" , ", " ")).toEqual({ configuredOrigins: [] });
  });

  it.each([
    ["invalid-only ALLOWED_ORIGINS", "not a URL", undefined],
    ["mixed valid and invalid ALLOWED_ORIGINS", "https://demo.ngrok.app,file:///tmp/demo", undefined],
    ["null ALLOWED_ORIGINS", "null", undefined],
    ["file ALLOWED_ORIGINS", "file:///tmp/demo", undefined],
    ["websocket ALLOWED_ORIGINS", "ws://localhost:4000", undefined],
    ["invalid PUBLIC_ORIGIN", undefined, "not a URL"],
    ["file PUBLIC_ORIGIN", undefined, "file:///tmp/demo"],
    ["websocket PUBLIC_ORIGIN", undefined, "wss://demo.ngrok.app"],
  ])("fails closed for %s", (_label, allowed, publicOrigin) => {
    expect(() => parseWebOriginConfiguration(allowed, publicOrigin)).toThrow(
      /must contain only exact absolute http\(s\) origins/u,
    );
  });

  it.each([
    "https://user:secret@demo.ngrok.app",
    "https://@demo.ngrok.app",
    "https://demo.ngrok.app/admin",
    "https://demo.ngrok.app/.",
    "https://demo.ngrok.app/%2e",
    "https://demo.ngrok.app?mode=admin",
    "https://demo.ngrok.app?",
    "https://demo.ngrok.app#admin",
    "https://demo.ngrok.app#",
  ])("rejects credentials and URL extras without echoing the configured value: %s", (configured) => {
    let error: unknown;
    try {
      parseWebOriginConfiguration(undefined, configured);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(configured);
  });
});

describe("browser origin policy", () => {
  it("normalizes configured/public origins and rejects malformed origins when an allowlist is active", () => {
    const configured = [configuredWebOrigin("https://admin.example/path")!];
    const publicOrigin = configuredWebOrigin("https://demo.ngrok.app/");
    expect(socketOriginAllowed("https://admin.example", configured, publicOrigin)).toBe(true);
    expect(socketOriginAllowed("https://demo.ngrok.app", configured, publicOrigin)).toBe(true);
    expect(socketOriginAllowed("https://evil.example", configured, publicOrigin)).toBe(false);
    expect(socketOriginAllowed("null", configured, undefined)).toBe(false);
    expect(socketOriginAllowed("not a URL", configured, undefined)).toBe(false);
    expect(socketOriginAllowed(undefined, configured, undefined)).toBe(true);
  });

  it("retains the explicitly open development mode when ALLOWED_ORIGINS is empty", () => {
    expect(socketOriginAllowed("https://dev.example", [], undefined)).toBe(true);
  });

  it("treats PUBLIC_ORIGIN by itself as an exact browser-origin boundary", () => {
    const publicOrigin = configuredWebOrigin("https://demo.ngrok.app/");
    expect(socketOriginAllowed("https://demo.ngrok.app", [], publicOrigin)).toBe(true);
    expect(socketOriginAllowed("https://evil.example", [], publicOrigin)).toBe(false);
    expect(socketOriginAllowed("null", [], publicOrigin)).toBe(false);
  });
});
