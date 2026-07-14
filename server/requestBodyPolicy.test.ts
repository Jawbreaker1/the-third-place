import { describe, expect, it } from "vitest";
import {
  ADMIN_JSON_BODY_LIMIT_BYTES,
  PUBLIC_JSON_BODY_LIMIT_BYTES,
  jsonBodyLimitBytes,
} from "./requestBodyPolicy.js";

describe("request JSON body policy", () => {
  it("admits the strict multilingual channel-seed maximum without widening public chat JSON", () => {
    const maximumCjkChannel = JSON.stringify({
      id: "cjk-room",
      name: "cjk-room",
      description: "界".repeat(180),
      icon: "界",
      topic: "界".repeat(500),
      guidance: "界".repeat(1_500),
      register: "technical",
      mode: "discussion",
      seeds: Array.from({ length: 40 }, (_, index) => `${index.toString().padStart(2, "0")}${"界".repeat(698)}`),
    });
    const bytes = Buffer.byteLength(maximumCjkChannel, "utf8");
    expect(bytes).toBeGreaterThan(64 * 1024);
    expect(bytes).toBeLessThan(ADMIN_JSON_BODY_LIMIT_BYTES);
    expect(jsonBodyLimitBytes("/api/admin/channels")).toBe(128 * 1024);
    expect(jsonBodyLimitBytes("/api/session")).toBe(PUBLIC_JSON_BODY_LIMIT_BYTES);
    expect(jsonBodyLimitBytes("/api/administrator")).toBe(PUBLIC_JSON_BODY_LIMIT_BYTES);
  });
});
