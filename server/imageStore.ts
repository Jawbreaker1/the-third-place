import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import type { ChatMessage, ImageAttachment } from "../shared/types.js";
import { resolvePublicAddress, validatePublicHttpsUrl } from "./safeHttpsFetch.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 20_000_000;
const MAX_EDGE = 2_048;
const MAX_REDIRECTS = 2;
const FETCH_TIMEOUT_MS = 8_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ImageStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const sniffImageType = (buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | undefined => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
};

export interface SanitizedImage {
  full: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
}

export const sanitizeImageBuffer = async (buffer: Buffer, declaredMimeType?: string): Promise<SanitizedImage> => {
  if (buffer.length === 0) throw new ImageStoreError("The image was empty.");
  if (buffer.length > MAX_INPUT_BYTES) throw new ImageStoreError("Images can be at most 8 MB.", 413);
  const sniffed = sniffImageType(buffer);
  if (!sniffed || (declaredMimeType && declaredMimeType.split(";")[0]?.trim() !== sniffed)) {
    throw new ImageStoreError("Use a static JPEG, PNG or WebP image.", 415);
  }

  try {
    const metadata = await sharp(buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw new ImageStoreError("The image dimensions are too large.", 413);
    }
    if ((metadata.pages ?? 1) > 1) throw new ImageStoreError("Animated and multi-page images are not supported.", 415);

    const fullResult = await sharp(buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 86, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();

    return {
      full: fullResult.data,
      thumbnail,
      width: fullResult.info.width,
      height: fullResult.info.height,
    };
  } catch (error) {
    if (error instanceof ImageStoreError) throw error;
    if (error instanceof Error && /pixel limit|exceeds.*pixels/i.test(error.message)) {
      throw new ImageStoreError("The image dimensions are too large.", 413);
    }
    throw new ImageStoreError("That image could not be decoded safely.", 415);
  }
};

const normalizedAddress = (raw: string): string => {
  const parsed = ipaddr.parse(raw);
  const ipv6 = parsed.kind() === "ipv6" ? (parsed as ipaddr.IPv6) : undefined;
  return ipv6?.isIPv4MappedAddress() ? ipv6.toIPv4Address().toString() : parsed.toNormalizedString();
};

const requestPinnedImage = async (
  url: URL,
  deadline: number,
): Promise<{ body?: Buffer; contentType?: string; redirect?: string }> => {
  const address = await resolvePublicAddress(url.hostname, deadline);
  if (!address || Date.now() >= deadline) return {};
  return await new Promise((resolveRequest) => {
    let settled = false;
    const finish = (result: { body?: Buffer; contentType?: string; redirect?: string }): void => {
      if (settled) return;
      settled = true;
      resolveRequest(result);
    };
    const request = httpsRequest(
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
          if (typeof options === "object" && options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
        headers: {
          Accept: "image/jpeg,image/png,image/webp",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          "User-Agent": "TheThirdPlace-ImageIngest/1.0",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.destroy();
          finish({ redirect: response.headers.location });
          return;
        }
        const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLocaleLowerCase();
        const encoding = response.headers["content-encoding"]?.toLocaleLowerCase() ?? "identity";
        const announcedLength = Number.parseInt(response.headers["content-length"] ?? "0", 10);
        if (
          status < 200 ||
          status >= 300 ||
          !contentType ||
          !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
          (encoding !== "identity" && encoding !== "") ||
          (Number.isFinite(announcedLength) && announcedLength > MAX_INPUT_BYTES)
        ) {
          response.destroy();
          finish({});
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_INPUT_BYTES || Date.now() >= deadline) {
            response.destroy();
            finish({});
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish({ body: Buffer.concat(chunks), contentType }));
        response.on("error", () => finish({}));
      },
    );
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        const remote = socket.remoteAddress;
        if (!remote || normalizedAddress(remote) !== normalizedAddress(address.address)) request.destroy();
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish({}));
    request.end();
  });
};

export const fetchRemoteImage = async (rawUrl: string): Promise<{ body: Buffer; contentType: string }> => {
  let current = validatePublicHttpsUrl(rawUrl);
  if (!current) throw new ImageStoreError("Use a direct public HTTPS image URL.");
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (visited.has(current.toString())) break;
    visited.add(current.toString());
    const result = await requestPinnedImage(current, deadline);
    if (result.body && result.contentType) return { body: result.body, contentType: result.contentType };
    if (!result.redirect || redirects === MAX_REDIRECTS) break;
    const next = validatePublicHttpsUrl(new URL(result.redirect, current).toString());
    if (!next) break;
    current = next;
  }
  throw new ImageStoreError("That image URL could not be fetched safely.", 422);
};

export class ImageStore {
  private readonly directory: string;
  private readonly attachments = new Map<string, ImageAttachment>();

  constructor(directory = resolve(process.cwd(), process.env.IMAGE_STORE_PATH ?? "data/images")) {
    this.directory = directory;
  }

  async initialize(messages: ChatMessage[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const liveIds = new Set<string>();
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind !== "image" || !ID_PATTERN.test(attachment.id)) continue;
        this.attachments.set(attachment.id, attachment);
        liveIds.add(attachment.id);
      }
    }
    for (const filename of await readdir(this.directory).catch(() => [] as string[])) {
      if (/^[0-9a-f-]{36}(?:-thumb)?\.webp\.[0-9a-f-]{36}\.tmp$/i.test(filename)) {
        await unlink(resolve(this.directory, filename)).catch(() => undefined);
        continue;
      }
      const match = filename.match(/^([0-9a-f-]{36})(?:-thumb)?\.webp$/i);
      if (match?.[1] && !liveIds.has(match[1])) await unlink(resolve(this.directory, filename)).catch(() => undefined);
    }
  }

  async create(buffer: Buffer, declaredMimeType?: string): Promise<ImageAttachment> {
    const sanitized = await sanitizeImageBuffer(buffer, declaredMimeType);
    const id = randomUUID();
    const fullPath = this.pathFor(id, false);
    const thumbnailPath = this.pathFor(id, true);
    const fullTemp = `${fullPath}.${randomUUID()}.tmp`;
    const thumbnailTemp = `${thumbnailPath}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(fullTemp, sanitized.full, { flag: "wx", mode: 0o600 });
      await writeFile(thumbnailTemp, sanitized.thumbnail, { flag: "wx", mode: 0o600 });
      await rename(fullTemp, fullPath);
      await rename(thumbnailTemp, thumbnailPath);
    } catch (error) {
      await Promise.all([
        unlink(fullTemp).catch(() => undefined),
        unlink(thumbnailTemp).catch(() => undefined),
        unlink(fullPath).catch(() => undefined),
        unlink(thumbnailPath).catch(() => undefined),
      ]);
      throw error;
    }
    const attachment: ImageAttachment = {
      id,
      kind: "image",
      url: `/api/images/${id}`,
      thumbnailUrl: `/api/images/${id}?variant=thumbnail`,
      mimeType: "image/webp",
      width: sanitized.width,
      height: sanitized.height,
      sizeBytes: sanitized.full.length,
      analysis: { status: "pending" },
    };
    this.attachments.set(id, attachment);
    return attachment;
  }

  get(id: string): ImageAttachment | undefined {
    return this.attachments.get(id);
  }

  update(attachment: ImageAttachment): void {
    if (this.attachments.has(attachment.id)) this.attachments.set(attachment.id, attachment);
  }

  async read(id: string, thumbnail = false): Promise<Buffer | undefined> {
    if (!ID_PATTERN.test(id) || !this.attachments.has(id)) return undefined;
    return await readFile(this.pathFor(id, thumbnail)).catch(() => undefined);
  }

  async remove(id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) return;
    this.attachments.delete(id);
    await Promise.all([
      unlink(this.pathFor(id, false)).catch(() => undefined),
      unlink(this.pathFor(id, true)).catch(() => undefined),
    ]);
  }

  private pathFor(id: string, thumbnail: boolean): string {
    if (!ID_PATTERN.test(id)) throw new ImageStoreError("Invalid image id.");
    return resolve(this.directory, `${id}${thumbnail ? "-thumb" : ""}.webp`);
  }
}
