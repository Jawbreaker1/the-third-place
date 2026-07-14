import { describe, expect, it } from "vitest";
import type { PageProviderAdapter } from "./types.js";
import { PageProviderRegistry } from "./registry.js";

const adapter = (id: string, hostname: string): PageProviderAdapter => ({
  id,
  supports: (url) => url.hostname === hostname,
  read: async () => undefined,
});

describe("PageProviderRegistry", () => {
  it("selects adapters only by their structural URL support contract", () => {
    const first = adapter("first", "one.example");
    const second = adapter("second", "two.example");
    const registry = new PageProviderRegistry([first, second]);
    expect(registry.supporting(new URL("https://two.example/path"))).toBe(second);
    expect(registry.supporting(new URL("https://unknown.example/path"))).toBeUndefined();
  });

  it("rejects duplicate provider identities", () => {
    expect(() => new PageProviderRegistry([
      adapter("duplicate", "one.example"),
      adapter("duplicate", "two.example"),
    ])).toThrow(/unique/u);
  });
});
