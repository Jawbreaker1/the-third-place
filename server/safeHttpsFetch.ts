import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { findUrlTextCandidates, hasStandaloneUrlStartBoundary } from "../shared/unicodeBoundaries.js";

export interface PublicAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeHttpsFetchPolicy {
  timeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  acceptedMediaTypes: readonly string[];
  acceptHeader: string;
  userAgent: string;
  /** Stop after this short case-insensitive ASCII delimiter has arrived. */
  stopAfterAsciiSequence?: string;
}

export interface SafeHttpsFetchResult {
  finalUrl: URL;
  body: Buffer;
  mediaType: string;
  contentType: string;
}

export interface PinnedHopResult {
  body?: Buffer;
  mediaType?: string;
  contentType?: string;
  redirect?: string;
}

export type LookupAll = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface SafeHttpsFetchDependencies {
  lookupImpl?: LookupAll;
  requestHop?: (
    url: URL,
    address: PublicAddress,
    deadline: number,
    policy: SafeHttpsFetchPolicy,
  ) => Promise<PinnedHopResult>;
}

const MAX_URL_LENGTH = 2_048;
const MAX_POLICY_TIMEOUT_MS = 10_000;
const MAX_POLICY_REDIRECTS = 3;
const MAX_POLICY_BODY_BYTES = 8 * 1024 * 1024;
const BLOCKED_HOSTS = new Set([
  "localhost",
  "local",
  "internal",
  "lan",
  "home.arpa",
  "onion",
  "invalid",
  "test",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const headerValue = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join(",") : (value ?? "");

const normalizedAddress = (raw: string): string => {
  const parsed = ipaddr.parse(raw);
  const ipv6 = parsed.kind() === "ipv6" ? (parsed as ipaddr.IPv6) : undefined;
  return ipv6?.isIPv4MappedAddress()
    ? ipv6.toIPv4Address().toString()
    : parsed.toNormalizedString();
};

const normalizedPolicy = (policy: SafeHttpsFetchPolicy): SafeHttpsFetchPolicy => ({
  timeoutMs: Math.max(100, Math.min(Math.floor(policy.timeoutMs), MAX_POLICY_TIMEOUT_MS)),
  maxRedirects: Math.max(0, Math.min(Math.floor(policy.maxRedirects), MAX_POLICY_REDIRECTS)),
  maxBodyBytes: Math.max(1, Math.min(Math.floor(policy.maxBodyBytes), MAX_POLICY_BODY_BYTES)),
  acceptedMediaTypes: [...new Set(policy.acceptedMediaTypes.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))],
  acceptHeader: policy.acceptHeader.slice(0, 512),
  userAgent: policy.userAgent.slice(0, 160),
  ...(policy.stopAfterAsciiSequence && /^[\x20-\x7e]{1,64}$/u.test(policy.stopAfterAsciiSequence)
    ? { stopAfterAsciiSequence: policy.stopAfterAsciiSequence.toLocaleLowerCase() }
    : {}),
});

export const scanAsciiSequence = (
  tail: Buffer,
  chunk: Buffer,
  sequence: string,
  processedBytes: number,
): { tail: Buffer; stopAt?: number } => {
  const window = tail.length > 0 ? Buffer.concat([tail, chunk], tail.length + chunk.length) : chunk;
  const index = window.toString("latin1").toLocaleLowerCase().indexOf(sequence);
  if (index >= 0) {
    return { tail: Buffer.alloc(0), stopAt: processedBytes - tail.length + index + sequence.length };
  }
  const retained = Math.min(Math.max(0, sequence.length - 1), window.length);
  return { tail: retained > 0 ? Buffer.from(window.subarray(window.length - retained)) : Buffer.alloc(0) };
};

export const isPublicAddress = (raw: string): boolean => {
  try {
    const parsed = ipaddr.parse(raw);
    const ipv6 = parsed.kind() === "ipv6" ? (parsed as ipaddr.IPv6) : undefined;
    const normalized = ipv6?.isIPv4MappedAddress() ? ipv6.toIPv4Address() : parsed;
    return normalized.range() === "unicast";
  } catch {
    return false;
  }
};

export const validatePublicHttpsUrl = (raw: string): URL | undefined => {
  if (!raw || raw.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/u.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const labels = host.split(".");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !host ||
      !host.includes(".") ||
      host.length > 253 ||
      labels.some((label) => !label || label.length > 63) ||
      ipaddr.isValid(host) ||
      [...BLOCKED_HOSTS].some((blocked) => host === blocked || host.endsWith(`.${blocked}`)) ||
      /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(`${url.pathname}${url.search}`)
    ) {
      return undefined;
    }
    url.hostname = host;
    url.hash = "";
    return url.toString().length <= MAX_URL_LENGTH ? url : undefined;
  } catch {
    return undefined;
  }
};

export const hasStandaloneUrlBoundary = hasStandaloneUrlStartBoundary;

export const extractPublicHttpsUrls = (content: string, limit = 3): URL[] => {
  const results: URL[] = [];
  const seen = new Set<string>();
  for (const match of findUrlTextCandidates(content, { allowWww: true, limit: Math.max(1, Math.min(limit, 10)) })) {
    const candidate = match.value;
    const normalized = validatePublicHttpsUrl(/^www\./iu.test(candidate) ? `https://${candidate}` : candidate);
    if (!normalized || seen.has(normalized.toString())) continue;
    seen.add(normalized.toString());
    results.push(normalized);
    if (results.length >= Math.max(1, Math.min(limit, 10))) break;
  }
  return results;
};

export const resolvePublicAddress = async (
  hostname: string,
  deadline: number,
  lookupImpl: LookupAll = lookup as LookupAll,
): Promise<PublicAddress | undefined> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    const results = await Promise.race([
      lookupImpl(hostname, { all: true, verbatim: true }),
      new Promise<undefined>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
    if (
      !results ||
      results.length === 0 ||
      results.some((result) => (result.family !== 4 && result.family !== 6) || !isPublicAddress(result.address))
    ) {
      return undefined;
    }
    const chosen = results[0];
    return chosen ? { address: chosen.address, family: chosen.family === 6 ? 6 : 4 } : undefined;
  } catch {
    return undefined;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
};

export const responseMediaType = (contentType: string): string =>
  contentType.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";

export const responseCanBeRead = (
  status: number,
  contentType: string,
  contentEncoding: string,
  contentLength: number | undefined,
  policy: SafeHttpsFetchPolicy,
): boolean => {
  const mediaType = responseMediaType(contentType);
  const encoding = contentEncoding.trim().toLocaleLowerCase();
  return (
    status >= 200 &&
    status < 300 &&
    policy.acceptedMediaTypes.includes(mediaType) &&
    (!encoding || encoding === "identity") &&
    (contentLength === undefined || (Number.isFinite(contentLength) && contentLength >= 0 && contentLength <= policy.maxBodyBytes))
  );
};

const requestPinnedHop = async (
  url: URL,
  address: PublicAddress,
  deadline: number,
  policy: SafeHttpsFetchPolicy,
): Promise<PinnedHopResult> =>
  await new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      resolve({});
      return;
    }
    let settled = false;
    let bodyTimer: NodeJS.Timeout | undefined;
    let hardDeadlineTimer: NodeJS.Timeout | undefined;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let stopTail: Buffer = Buffer.alloc(0);
    const stopSequence = policy.stopAfterAsciiSequence;
    const finish = (value: PinnedHopResult): void => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
      resolve(value);
    };
    const activeRequest = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        timeout: Math.max(100, deadline - Date.now()),
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address: address.address, family: address.family }]);
          } else {
            callback(null, address.address, address.family);
          }
        },
        headers: {
          Accept: policy.acceptHeader,
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          "User-Agent": policy.userAgent,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status) && response.headers.location) {
          response.destroy();
          finish({ redirect: response.headers.location });
          return;
        }
        const contentType = headerValue(response.headers["content-type"]);
        const contentEncoding = headerValue(response.headers["content-encoding"]);
        const lengthHeader = headerValue(response.headers["content-length"]);
        const parsedLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : undefined;
        if (!responseCanBeRead(status, contentType, contentEncoding, parsedLength, policy)) {
          response.destroy();
          finish({});
          return;
        }
        const mediaType = responseMediaType(contentType);
        // A single bounded backing store prevents hostile one-byte HTTP chunks
        // from amplifying into hundreds of thousands of Buffer objects.
        const bodyBuffer = Buffer.allocUnsafe(policy.maxBodyBytes);
        let total = 0;
        const resetBodyTimer = (): void => {
          if (bodyTimer) clearTimeout(bodyTimer);
          bodyTimer = setTimeout(() => {
            response.destroy();
            finish({});
          }, Math.min(2_000, Math.max(100, deadline - Date.now())));
        };
        resetBodyTimer();
        response.on("data", (rawChunk: Buffer | string) => {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          const processedBytes = total;
          const nextTotal = total + chunk.length;
          if (nextTotal > policy.maxBodyBytes || Date.now() >= deadline) {
            response.destroy();
            finish({});
            return;
          }
          chunk.copy(bodyBuffer, total);
          total = nextTotal;
          if (stopSequence) {
            const scan = scanAsciiSequence(stopTail, chunk, stopSequence, processedBytes);
            stopTail = scan.tail;
            const stopAt = scan.stopAt;
            if (stopAt !== undefined && stopAt > 0 && stopAt <= total) {
              response.destroy();
              finish({ body: Buffer.from(bodyBuffer.subarray(0, stopAt)), mediaType, contentType });
              return;
            }
          }
          resetBodyTimer();
        });
        response.on("end", () => finish({ body: Buffer.from(bodyBuffer.subarray(0, total)), mediaType, contentType }));
        response.on("error", () => finish({}));
      },
    );
    request = activeRequest;
    hardDeadlineTimer = setTimeout(() => {
      request?.destroy(new Error("HTTPS fetch exceeded its wall-clock deadline"));
      finish({});
    }, remaining);
    activeRequest.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        const remote = socket.remoteAddress;
        if (!remote || normalizedAddress(remote) !== normalizedAddress(address.address)) {
          activeRequest.destroy(new Error("TLS peer address did not match the pinned DNS answer"));
        }
      });
    });
    activeRequest.on("timeout", () => activeRequest.destroy());
    activeRequest.on("error", () => finish({}));
    activeRequest.end();
  });

export const fetchPublicHttps = async (
  rawUrl: string | URL,
  requestedPolicy: SafeHttpsFetchPolicy,
  dependencies: SafeHttpsFetchDependencies = {},
): Promise<SafeHttpsFetchResult | undefined> => {
  const startUrl = validatePublicHttpsUrl(String(rawUrl));
  if (!startUrl) return undefined;
  const policy = normalizedPolicy(requestedPolicy);
  if (policy.acceptedMediaTypes.length === 0 || !policy.acceptHeader || !policy.userAgent) return undefined;
  const deadline = Date.now() + policy.timeoutMs;
  const visited = new Set<string>();
  let current = startUrl;
  const requestHop = dependencies.requestHop ?? requestPinnedHop;
  for (let redirects = 0; redirects <= policy.maxRedirects; redirects += 1) {
    const key = current.toString();
    if (visited.has(key) || Date.now() >= deadline) return undefined;
    visited.add(key);
    const address = await resolvePublicAddress(current.hostname, deadline, dependencies.lookupImpl);
    if (!address || Date.now() >= deadline) return undefined;
    const result: PinnedHopResult = await requestHop(current, address, deadline, policy).catch(
      (): PinnedHopResult => ({}),
    );
    if (result.body && result.mediaType && result.contentType) {
      return { finalUrl: current, body: result.body, mediaType: result.mediaType, contentType: result.contentType };
    }
    if (!result.redirect || redirects === policy.maxRedirects) return undefined;
    let redirected: URL;
    try {
      redirected = new URL(result.redirect, current);
    } catch {
      return undefined;
    }
    const validated = validatePublicHttpsUrl(redirected.toString());
    if (!validated) return undefined;
    current = validated;
  }
  return undefined;
};
