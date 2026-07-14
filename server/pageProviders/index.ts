import { avanzaMarketPageProvider } from "./avanzaMarket.js";
import { PageProviderRegistry } from "./registry.js";

export const defaultPageProviderRegistry = new PageProviderRegistry([
  avanzaMarketPageProvider,
]);

export { PageProviderRegistry } from "./registry.js";
export type {
  PageProviderAdapter,
  PageProviderEvidence,
  PageProviderFetcher,
  PageProviderReadContext,
} from "./types.js";
