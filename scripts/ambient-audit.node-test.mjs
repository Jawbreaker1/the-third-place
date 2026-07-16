import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditPublicationBoundarySource,
  runAmbientAudit,
  seededRandom,
  simulateAmbientEngine,
} from "./ambient-audit.mjs";

test("seeded ambient simulation has varied lengths, actions and natural stopping", () => {
  const first = simulateAmbientEngine({ seed: 42, episodesPerScenario: 160 });
  const repeated = simulateAmbientEngine({ seed: 42, episodesPerScenario: 160 });

  assert.deepEqual(repeated, first, "the audit must be reproducible for the same seed");
  assert.equal(first.passed, true, first.issues.join("; "));
  assert.equal(first.hardCapViolations, 0);
  assert.equal(first.immediateActionRepeats, 0);
  assert.ok(first.naturalStops > 0);
  assert.ok(first.hardCapStops > 0);
  assert.deepEqual(
    [...new Set(first.lengthFrequency.map((entry) => Number(entry.value)))].sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.ok(first.lengthFrequency[0].share <= 0.34);
  assert.equal(first.actionFrequency.length, 9);
});

test("seeded RNG is stable and remains inside the unit interval", () => {
  const left = seededRandom(123);
  const right = seededRandom(123);
  const leftValues = Array.from({ length: 20 }, () => left());
  const rightValues = Array.from({ length: 20 }, () => right());
  assert.deepEqual(leftValues, rightValues);
  assert.ok(leftValues.every((value) => value >= 0 && value < 1));
});

test("actual director keeps durable episode metadata behind successful publication", async () => {
  const report = await runAmbientAudit({ seed: 7 });
  assert.equal(report.publicationBoundary.passed, true, report.publicationBoundary.issues.join("; "));
  assert.deepEqual(report.publicationBoundary.callSites.commitCallers, ["recordAmbientPost"]);
  assert.equal(report.publicationBoundary.callSites.postPublic, 1);
  assert.equal(report.publicationBoundary.callSites.recordAmbientPost, 1);
  assert.equal(report.publicationBoundary.callSites.ledgerOpen, 1);
  assert.equal(report.publicationBoundary.callSites.ledgerUpdate, 1);
  assert.equal(report.passed, true, report.issues.join("; "));
});

test("publication AST audit rejects a pre-publication durable commit", async () => {
  const realSource = await readFile(new URL("../server/director.ts", import.meta.url), "utf8");
  const regressed = realSource.replace(
    "posted = this.postPublic(\n          channel.id,",
    "this.recordAmbientPost(thread, { id: 'draft' } as never);\n        posted = this.postPublic(\n          channel.id,",
  );
  assert.notEqual(regressed, realSource, "the regression fixture must modify the real call path");

  const report = auditPublicationBoundarySource(regressed, "regressed-director.ts");
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.includes("before any preceding postPublic")));
});
