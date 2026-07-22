export interface PublicOriginProvider {
  id: string;
  discover: () => Promise<string | undefined>;
}

export interface PublicOriginResolution {
  origin?: string;
  source: "configured" | "local-tunnel" | "same-origin";
  providerId?: string;
}

interface NgrokTunnel {
  public_url?: unknown;
  proto?: unknown;
  config?: { addr?: unknown } | null;
}

interface NgrokTunnelResponse {
  tunnels?: unknown;
}

export interface NgrokPublicOriginProviderOptions {
  localPort: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const loopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const exactHttpsOrigin = (value: string): string | undefined => {
  try {
    const origin = exactHttpOrigin(value, "discovered public origin");
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const addressLiteral = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (
      parsed.protocol !== "https:" ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      isIP(addressLiteral) !== 0
    ) return undefined;
    return origin;
  } catch {
    return undefined;
  }
};

const MAX_NGROK_INSPECTION_BYTES = 64 * 1024;

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_NGROK_INSPECTION_BYTES) return undefined;
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_NGROK_INSPECTION_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
};

const tunnelTargetsLocalPort = (value: unknown, localPort: number): boolean => {
  if (typeof value !== "string") return false;
  try {
    const target = new URL(value);
    if (
      target.protocol !== "http:" ||
      !loopbackHostname(target.hostname) ||
      target.username ||
      target.password ||
      (target.pathname !== "" && target.pathname !== "/") ||
      target.search ||
      target.hash
    ) return false;
    const port = target.port ? Number.parseInt(target.port, 10) : 80;
    return port === localPort;
  } catch {
    return false;
  }
};

/**
 * Reads only ngrok's fixed loopback inspection endpoint and accepts only an
 * HTTPS tunnel whose upstream is this server's loopback port. The response is
 * treated as untrusted data; it can suggest an origin but never changes CORS,
 * cookie or authentication trust boundaries.
 */
export const createNgrokPublicOriginProvider = (
  options: NgrokPublicOriginProviderOptions,
): PublicOriginProvider => ({
  id: "ngrok",
  discover: async () => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = Math.max(50, Math.min(options.timeoutMs ?? 500, 2_000));
    try {
      const response = await fetchImpl("http://127.0.0.1:4040/api/tunnels", {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return undefined;
      const body = await readBoundedJson(response) as NgrokTunnelResponse | undefined;
      if (!body) return undefined;
      if (!Array.isArray(body.tunnels)) return undefined;
      const origins = (body.tunnels as NgrokTunnel[])
        .filter((tunnel) => tunnel?.proto === "https")
        .filter((tunnel) => tunnelTargetsLocalPort(tunnel.config?.addr, options.localPort))
        .map((tunnel) => typeof tunnel.public_url === "string"
          ? exactHttpsOrigin(tunnel.public_url)
          : undefined)
        .filter((origin): origin is string => Boolean(origin))
        .filter((origin, index, rows) => rows.indexOf(origin) === index)
        .sort();
      // Multiple public tunnels are a real deployment choice. Do not silently
      // hand a recipient an arbitrary one; Admin can still accept a manual URL.
      return origins.length === 1 ? origins[0] : undefined;
    } catch {
      return undefined;
    }
  },
});

/**
 * Trusted operator configuration always wins. Local provider discovery is a
 * handoff convenience only and fails back to the Admin page's own origin.
 */
export const resolvePublicHandoffOrigin = async (
  configuredOrigin: string | undefined,
  providers: readonly PublicOriginProvider[],
): Promise<PublicOriginResolution> => {
  if (configuredOrigin) {
    return { origin: configuredOrigin, source: "configured" };
  }
  for (const provider of providers) {
    try {
      const candidate = await provider.discover();
      const origin = candidate ? exactHttpsOrigin(candidate) : undefined;
      if (origin) return { origin, source: "local-tunnel", providerId: provider.id };
    } catch {
      // A tunnel helper is optional. One provider must never prevent the
      // one-time invitation secret from reaching the administrator.
    }
  }
  return { source: "same-origin" };
};
import { isIP } from "node:net";
import { exactHttpOrigin } from "./originPolicy.js";
