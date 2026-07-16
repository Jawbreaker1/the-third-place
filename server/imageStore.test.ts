import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fetchRemoteImage, ImageStore, ImageStoreError, sanitizeImageBuffer } from "./imageStore.js";
import { createMessage } from "./store.js";

const png = async (width: number, height: number): Promise<Buffer> =>
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 31, g: 122, b: 199 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

const expectImageStoreError = async (
  promise: Promise<unknown>,
  status: number,
  message?: RegExp,
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected image processing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ImageStoreError);
    expect((error as ImageStoreError).status).toBe(status);
    if (message) expect((error as Error).message).toMatch(message);
  }
};

describe("image store safety", () => {
  it("re-encodes accepted input as bounded static WebP variants", async () => {
    const input = await png(2_400, 1_200);

    const sanitized = await sanitizeImageBuffer(input, "image/png; charset=binary");
    const fullMetadata = await sharp(sanitized.full).metadata();
    const thumbnailMetadata = await sharp(sanitized.thumbnail).metadata();

    expect(sanitized.full.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(sanitized.full.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(fullMetadata).toMatchObject({ format: "webp", width: 2_048, height: 1_024 });
    expect(thumbnailMetadata).toMatchObject({ format: "webp", width: 640, height: 320 });
    expect(fullMetadata.pages ?? 1).toBe(1);
    expect(thumbnailMetadata.pages ?? 1).toBe(1);
    expect(sanitized.width).toBe(2_048);
    expect(sanitized.height).toBe(1_024);
  });

  it("rejects a declared MIME type that disagrees with the magic bytes", async () => {
    const input = await png(16, 16);

    await expectImageStoreError(
      sanitizeImageBuffer(input, "image/jpeg"),
      415,
      /static JPEG, PNG or WebP/i,
    );
  });

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["fake PNG", Buffer.from("this is not an image")],
  ])("rejects %s content even when the caller declares image/png", async (_label, input) => {
    await expectImageStoreError(
      sanitizeImageBuffer(input, "image/png"),
      415,
      /static JPEG, PNG or WebP/i,
    );
  });

  it("rejects decoded images above the 20 megapixel limit", async () => {
    const input = await png(5_000, 4_001);

    await expectImageStoreError(
      sanitizeImageBuffer(input, "image/png"),
      413,
      /dimensions are too large/i,
    );
  });

  it.each([
    "https://127.0.0.1/private.png",
    "https://169.254.169.254/latest/meta-data/iam.png",
    "https://localhost/private.png",
    "https://renderer.internal/private.png",
  ])("rejects private image destination %s before fetching", async (url) => {
    await expectImageStoreError(fetchRemoteImage(url), 400, /direct public HTTPS image URL/i);
  });

  it("restores referenced attachments and removes their files on retention cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-images-"));
    try {
      const firstStore = new ImageStore(directory);
      await firstStore.initialize([]);
      const attachment = await firstStore.create(await png(40, 20), "image/png");
      expect(await firstStore.read(attachment.id)).toBeDefined();

      const restoredStore = new ImageStore(directory);
      await restoredStore.initialize([
        {
          id: "message-1",
          channelId: "lobby",
          authorId: "human-test",
          content: "",
          createdAt: new Date().toISOString(),
          reactions: [],
          attachments: [attachment],
        },
      ]);
      expect(await restoredStore.read(attachment.id, true)).toBeDefined();

      await restoredStore.remove(attachment.id);
      expect(await restoredStore.read(attachment.id)).toBeUndefined();
      expect((await readdir(directory)).some((name) => name.startsWith(attachment.id))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains sanitized files referenced by a private message during restart recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-private-images-"));
    try {
      const firstStore = new ImageStore(directory);
      const attachment = await firstStore.create(await png(16, 12), "image/png");
      const privateMessage = createMessage(
        "dm:ai-mira:human-johan",
        "human-johan",
        "private image",
        { attachments: [attachment] },
      );

      const restartedStore = new ImageStore(directory);
      await restartedStore.initialize([privateMessage]);
      expect((await restartedStore.read(attachment.id))?.byteLength).toBeGreaterThan(0);
      expect((await restartedStore.read(attachment.id, true))?.byteLength).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sweeps orphaned images and interrupted temporary files at startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-images-"));
    const orphanId = "11111111-1111-4111-8111-111111111111";
    const temporaryId = "22222222-2222-4222-8222-222222222222";
    try {
      await writeFile(join(directory, `${orphanId}.webp`), "orphan");
      await writeFile(join(directory, `${orphanId}-thumb.webp`), "orphan");
      await writeFile(join(directory, `${orphanId}.webp.${temporaryId}.tmp`), "partial");

      await new ImageStore(directory).initialize([]);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
