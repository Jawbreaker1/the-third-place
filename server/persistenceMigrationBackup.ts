import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const safeVersionLabel = (value: string | number): string =>
  String(value).replace(/[^0-9A-Za-z._-]/gu, "_").slice(0, 32) || "legacy";

/**
 * Preserve the exact previous bytes before a one-way local schema rewrite.
 * Content-addressed names make repeated starts idempotent while retaining a
 * different backup if the old application writes new data after a rollback.
 */
export const preservePreMigrationState = async (
  filePath: string,
  raw: string,
  fromVersion: string | number,
  toVersion: string | number,
): Promise<string> => {
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
  const backupPath = `${filePath}.pre-v${safeVersionLabel(toVersion)}-from-${safeVersionLabel(fromVersion)}-${digest}.bak`;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(backupPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(backupPath, "utf8") !== raw) throw error;
  }
  await chmod(backupPath, 0o600);
  return backupPath;
};
