import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditPublicationBoundarySource,
  runAmbientAudit,
  seededRandom,
  simulateAmbientEngine,
  simulateAmbientScenario,
} from "./ambient-audit.mjs";

test("fake model streams, not scheduled semantic moves, determine publication count", () => {
  const first = simulateAmbientEngine({ seed: 42 });
  const repeated = simulateAmbientEngine({ seed: 42 });

  assert.deepEqual(repeated, first, "the audit must be reproducible for the same seed");
  assert.equal(first.passed, true, first.issues.join("; "));
  assert.equal(first.hardCapViolations, 0);
  assert.ok(first.naturalStops > 0);
  assert.ok(first.hardCapStops > 0);
  assert.deepEqual(
    [...new Set(first.lengthFrequency.map((entry) => Number(entry.value)))].sort((left, right) => left - right),
    [0, 1, 2, 4, 7, 8],
  );
  assert.match(first.scope, /not an LLM quality evaluation/);
  assert.equal("actionFrequency" in first, false, "the scheduler must not assign a rhetorical action distribution");
});

test("an abstaining candidate yields to someone else and only publications enter the ledger", () => {
  const result = simulateAmbientScenario({
    seed: 2,
    decisions: [
      { kind: "speak", content: "I liked the film." },
      { kind: "abstain" },
      { kind: "speak", content: "The ending got me too." },
      { kind: "speak", content: "Rejected transport draft", publicationSucceeded: false },
    ],
  });
  assert.notEqual(result.attempts[1].candidateId, result.attempts[2].candidateId);
  assert.equal(result.stop, "publication_failed");
  assert.deepEqual(result.ledger.map((entry) => entry.content), ["I liked the film.", "The ending got me too."]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.publishedBefore), [0, 1, 1, 2]);
});

test("two distinct abstentions close a discussion without synthesizing a final message", () => {
  const result = simulateAmbientScenario({ decisions: [
    { kind: "speak", content: "A real published opening." },
    { kind: "abstain" },
    { kind: "abstain" },
    { kind: "speak", content: "This fake decision must never be requested." },
  ] });
  assert.equal(result.stop, "quiet");
  assert.equal(result.attempts.length, 3);
  assert.notEqual(result.attempts[1].candidateId, result.attempts[2].candidateId);
  assert.equal(result.ledger.length, 1);
});

test("a willing model stream cannot exceed the fairness cap or force consecutive self-replies", () => {
  const result = simulateAmbientScenario({ decisions: Array.from({ length: 20 }, (_, index) => ({
    kind: "speak", content: `Contribution ${index}`,
  })) });
  assert.equal(result.stop, "budget");
  assert.equal(result.attempts.length, 8);
  assert.equal(result.ledger.length, 8);
  assert.ok(result.ledger.every((entry, index) => entry.authorId !== result.ledger[index - 1]?.authorId));
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

test("AST audit requires production to use the tested scheduler and rejects scripted moves", async () => {
  const realSource = await readFile(new URL("../server/director.ts", import.meta.url), "utf8");
  const regressed = realSource.replace("const opportunity = conversationOpportunity({", "const opportunity = decideAmbientAction({");
  assert.notEqual(regressed, realSource, "the mutation must affect the production opportunity call");
  const report = auditPublicationBoundarySource(regressed);
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.includes("does not use the audited production")));
  assert.ok(report.issues.some((issue) => issue.includes("prescribes semantic moves")));
});
