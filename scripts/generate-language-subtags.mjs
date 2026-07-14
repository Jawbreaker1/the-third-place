import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [inputPath, outputPath = "server/ianaLanguageSubtags.generated.ts"] = process.argv.slice(2);
if (!inputPath) throw new Error("Usage: node scripts/generate-language-subtags.mjs <IANA registry file> [output]");

const source = await readFile(resolve(inputPath), "utf8");
const records = source.split(/\n%%\s*\n/gu).map((block) => {
  const record = new Map();
  let currentKey;
  for (const line of block.split(/\r?\n/gu)) {
    const field = /^([A-Za-z-]+):\s*(.*)$/u.exec(line);
    if (field) {
      currentKey = field[1];
      const values = record.get(currentKey) ?? [];
      values.push(field[2]);
      record.set(currentKey, values);
    } else if (currentKey && /^\s+/u.test(line)) {
      const values = record.get(currentKey);
      values[values.length - 1] += ` ${line.trim()}`;
    }
  }
  return record;
});

const one = (record, key) => record.get(key)?.[0];
const fileDate = one(records[0], "File-Date");
if (!fileDate) throw new Error("The input does not look like the IANA Language Subtag Registry");

const expandRegisteredRange = (raw) => {
  const value = raw.toLowerCase();
  if (!value.includes("..")) return [value];
  const [start, end, extra] = value.split("..");
  if (extra !== undefined || !start || !end || start.length !== end.length) {
    throw new Error(`Unsupported IANA subtag range: ${raw}`);
  }
  if (/^[a-z]+$/u.test(start) && /^[a-z]+$/u.test(end)) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const decode = (candidate) => [...candidate].reduce(
      (total, character) => total * alphabet.length + alphabet.indexOf(character),
      0,
    );
    const encode = (number) => {
      let remaining = number;
      let result = "";
      for (let index = 0; index < start.length; index += 1) {
        result = `${alphabet[remaining % alphabet.length]}${result}`;
        remaining = Math.floor(remaining / alphabet.length);
      }
      return result;
    };
    const first = decode(start);
    const last = decode(end);
    if (last < first) throw new Error(`Descending IANA subtag range: ${raw}`);
    return Array.from({ length: last - first + 1 }, (_, index) => encode(first + index));
  }
  if (/^\d+$/u.test(start) && /^\d+$/u.test(end)) {
    const first = Number.parseInt(start, 10);
    const last = Number.parseInt(end, 10);
    if (last < first) throw new Error(`Descending IANA subtag range: ${raw}`);
    return Array.from(
      { length: last - first + 1 },
      (_, index) => String(first + index).padStart(start.length, "0"),
    );
  }
  throw new Error(`Unsupported mixed IANA subtag range: ${raw}`);
};

const sets = new Map([
  ["language", new Set()],
  ["extlang", new Set()],
  ["script", new Set()],
  ["region", new Set()],
  ["variant", new Set()],
]);
const preferredTags = {};
const registeredTags = {};
const preferredExtlangs = {};
const preferredSubtags = {};
for (const record of records.slice(1)) {
  const type = one(record, "Type");
  const subtag = one(record, "Subtag")?.toLowerCase();
  if (type && subtag && sets.has(type)) {
    for (const expanded of expandRegisteredRange(subtag)) sets.get(type).add(expanded);
  }
  const tag = one(record, "Tag")?.toLowerCase();
  const canonicalTag = one(record, "Tag");
  const preferred = one(record, "Preferred-Value");
  if (type && subtag && preferred && sets.has(type)) preferredSubtags[`${type}|${subtag}`] = preferred;
  if (tag && canonicalTag && (type === "grandfathered" || type === "redundant")) registeredTags[tag] = canonicalTag;
  if (tag && preferred && (type === "grandfathered" || type === "redundant")) preferredTags[tag] = preferred;
  if (type === "extlang" && subtag) {
    const prefix = one(record, "Prefix")?.toLowerCase();
    if (prefix) preferredExtlangs[`${prefix}|${subtag}`] = preferred ?? subtag;
  }
}

const joined = (type) => [...sets.get(type)].sort().join("|");
const output = `// Generated from the official IANA Language Subtag Registry. Do not edit by hand.\n` +
  `// Refresh: curl -fsS https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry -o /tmp/language-subtag-registry\n` +
  `//          node scripts/generate-language-subtags.mjs /tmp/language-subtag-registry\n` +
  `export const IANA_LANGUAGE_SUBTAG_FILE_DATE = ${JSON.stringify(fileDate)};\n` +
  `export const IANA_LANGUAGE_SUBTAGS = new Set(${JSON.stringify(joined("language"))}.split("|"));\n` +
  `export const IANA_EXTLANG_SUBTAGS = new Set(${JSON.stringify(joined("extlang"))}.split("|"));\n` +
  `export const IANA_SCRIPT_SUBTAGS = new Set(${JSON.stringify(joined("script"))}.split("|"));\n` +
  `export const IANA_REGION_SUBTAGS = new Set(${JSON.stringify(joined("region"))}.split("|"));\n` +
  `export const IANA_VARIANT_SUBTAGS = new Set(${JSON.stringify(joined("variant"))}.split("|"));\n` +
  `export const IANA_REGISTERED_TAGS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(registeredTags)});\n` +
  `export const IANA_PREFERRED_TAGS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(preferredTags)});\n` +
  `export const IANA_PREFERRED_EXTLANGS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(preferredExtlangs)});\n` +
  `export const IANA_PREFERRED_SUBTAGS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(preferredSubtags)});\n`;

await writeFile(resolve(outputPath), output, "utf8");
