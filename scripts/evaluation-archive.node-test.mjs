import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import { readEvaluationText } from "./evaluation-archive.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("plain and gzip evaluation reads preserve exact UTF-8 text and hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-archive-test-"));
  try {
    const text = '{\n  "transcript": "Hej! 🇸🇪 Ça va? العربية"\n}\n';
    const plain = join(directory, "result.json"), compressed = `${plain}.gz`;
    await writeFile(plain, text);
    await writeFile(compressed, gzipSync(text));
    for (const path of [plain, compressed, pathToFileURL(plain), pathToFileURL(compressed)]) {
      const result = await readEvaluationText(path);
      assert.equal(result, text);
      assert.equal(sha(result), sha(text));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt gzip is rejected rather than reinterpreted as plain text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-archive-test-"));
  try {
    const path = join(directory, "result.json.gz");
    await writeFile(path, "not gzip");
    await assert.rejects(readEvaluationText(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed archive index verifies both compressed and decoded result bytes", async () => {
  const root = new URL("../docs/evaluations/", import.meta.url);
  const index = JSON.parse(await readFile(new URL("archive-index-2026-10-13.json", root), "utf8"));
  assert.ok(index.archives.length > 0);
  for (const item of index.archives) {
    const compressed = await readFile(new URL(item.archive, root));
    const decoded = gunzipSync(compressed);
    assert.equal(compressed.byteLength, item.compressedBytes, item.archive);
    assert.equal(decoded.byteLength, item.originalBytes, item.original);
    assert.equal(sha(compressed), item.compressedSha256, item.archive);
    assert.equal(sha(decoded), item.originalSha256, item.original);
    assert.equal(await readEvaluationText(new URL(item.archive, root)), decoded.toString("utf8"));
    assert.doesNotThrow(() => JSON.parse(decoded.toString("utf8")), item.original);
  }
});
