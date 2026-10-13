import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Decode archived bytes before hashing or parsing so fixture identities do not
// depend on whether a result is stored as plain JSON or lossless gzip.
export async function readEvaluationText(path) {
  const bytes = await readFile(path);
  const filename = path instanceof URL ? fileURLToPath(path) : path;
  return (extname(filename) === ".gz" ? gunzipSync(bytes) : bytes).toString("utf8");
}
