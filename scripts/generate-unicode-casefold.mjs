import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [inputPath, outputPath = "shared/unicodeCaseFold.generated.ts"] = process.argv.slice(2);
if (!inputPath) throw new Error("Usage: node scripts/generate-unicode-casefold.mjs <CaseFolding.txt> [output]");

const source = await readFile(resolve(inputPath), "utf8");
const version = /^# CaseFolding-([^\s]+)\.txt$/mu.exec(source)?.[1];
const date = /^# Date:\s*(.+)$/mu.exec(source)?.[1];
if (!version || !date) throw new Error("The input does not look like Unicode CaseFolding.txt");

const mappings = {};
for (const line of source.split(/\r?\n/gu)) {
  const match = /^([0-9A-F]+);\s*([CFTS]);\s*([0-9A-F ]+);/u.exec(line);
  if (!match || (match[2] !== "C" && match[2] !== "F")) continue;
  const sourceCharacter = String.fromCodePoint(Number.parseInt(match[1], 16));
  const folded = match[3]
    .trim()
    .split(/\s+/u)
    .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .join("");
  mappings[sourceCharacter] = folded;
}

const output = `// Generated from Unicode CaseFolding-${version}.txt (${date}). Do not edit by hand.\n` +
  `// Source: https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt\n` +
  `// License: https://www.unicode.org/license.txt\n` +
  `export const UNICODE_CASE_FOLD_VERSION = ${JSON.stringify(version)};\n` +
  `export const UNICODE_CASE_FOLD_DATE = ${JSON.stringify(date)};\n` +
  `export const UNICODE_FULL_CASE_FOLD: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(mappings)});\n`;

await writeFile(resolve(outputPath), output, "utf8");
