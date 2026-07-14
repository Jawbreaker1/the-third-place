import type { PageProviderAdapter } from "./types.js";

export class PageProviderRegistry {
  private readonly adapters: readonly PageProviderAdapter[];

  constructor(adapters: readonly PageProviderAdapter[] = []) {
    const ids = new Set<string>();
    for (const adapter of adapters) {
      if (!adapter.id || ids.has(adapter.id)) {
        throw new TypeError(`Page provider IDs must be non-empty and unique: ${adapter.id || "<empty>"}`);
      }
      ids.add(adapter.id);
    }
    this.adapters = Object.freeze([...adapters]);
  }

  /** Returns the first registered structural URL match, without interpreting chat text. */
  supporting(url: URL): PageProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.supports(url));
  }
}
