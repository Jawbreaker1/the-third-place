import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { ACTORS, sentinelHits } from "./dm-public-memory-chain-live-eval.mjs";
import { buildFrozenScene, buildRunPlan, evaluateTask, parseOptions, sceneCases, stageSeed } from "./dm-research-memory-scene-live-eval.mjs";

const persona = { id: ACTORS.resident, name: "Mira", personality: "test fixture" };
test("seven scenes preserve the initial five and six exactly, adding only another-person relevance control", () => {
  assert.equal(sceneCases.length, 7); assert.equal(new Set(sceneCases.map((item) => item.id)).size, 7);
  assert.equal(createHash("sha256").update(JSON.stringify(sceneCases.slice(0, 5))).digest("hex"), "9653dc1bd485ab4ae67fa1d2ec6353bcfea31c736d0bd6c785062918f59a8841");
  assert.equal(createHash("sha256").update(JSON.stringify(sceneCases.slice(0, 6))).digest("hex"), "1b5234927e7a8fe6da366b2b6ab840fb581a38e667e61fbf4c962a21c0077a84");
  assert.equal(buildRunPlan(sceneCases, 3, "all").length, 66);
  assert.equal(buildRunPlan(sceneCases, 3, "generation").length, 21);
  assert.equal(buildRunPlan(sceneCases, 3, "review").length, 45);
  assert.equal(sceneCases.filter((item) => item.historicalExternalQuote && item.staleDraft).length, 1);
  assert.deepEqual(sentinelHits(sceneCases), []);
});

test("other-person relevance control preserves exact A evidence while asking about B", () => {
  const item = sceneCases[6], scene = buildFrozenScene(item, persona);
  assert.equal(item.seedIndex, 6); assert.equal(scene.trigger.content, "What did LindenFox tell you they collect?");
  assert.ok(scene.roomRecall.provenance.some((row) => row.authorId === ACTORS.a));
  assert.ok(scene.roomRecall.provenance.every((row) => row.authorId !== ACTORS.b));
  assert.ok(!scene.publicParticipantNotes[persona.id].includes("LindenFox"));
  assert.equal(scene.capabilityContext.executionStatus, "failed_temporary");
});

test("fixed scene includes actual public source metadata but no gold drafts or evaluative instructions", () => {
  for (const item of sceneCases) {
    const scene = buildFrozenScene(item, persona), raw = JSON.stringify(scene);
    assert.equal(scene.kind, "dm"); assert.equal(scene.trigger.content, item.question);
    assert.ok(!raw.includes(item.goodDraft)); assert.ok(!raw.includes(item.badDraft)); assert.ok(!raw.includes(item.rubric));
    if (item.withoutPublicMemory) {
      assert.equal(scene.roomRecall, undefined); assert.equal(scene.publicParticipantNotes, undefined); assert.deepEqual(scene.history, []); assert.ok(!raw.includes(JSON.stringify(ACTORS.a)));
    } else {
      assert.ok(raw.includes(ACTORS.a));
      assert.equal(scene.roomRecall.transcript.length, scene.roomRecall.provenance.length);
      assert.equal(scene.roomRecall.sourceChannel.id, "lobby"); assert.deepEqual(scene.roomRecall.witnessPersonaIds, [persona.id]);
      assert.equal(scene.roomRecall.provenance[0].authorId, ACTORS.a);
    }
    if (item.failedLookup) { assert.equal(scene.evidenceOutcome, "failed"); assert.equal(scene.capabilityContext.executionStatus, "failed_temporary"); assert.equal(scene.research, undefined); assert.equal(scene.premise, "The external lookup failed; no external content was returned."); }
    else { assert.equal(scene.evidenceOutcome, undefined); assert.equal(scene.capabilityContext, undefined); }
  }
});

test("historical external quote is source evidence of the old report, not a successful current lookup", () => {
  const item = sceneCases.find((entry) => entry.staleDraft), scene = buildFrozenScene(item, persona);
  assert.equal(scene.roomRecall.transcript.at(-1).content, item.historicalExternalQuote);
  assert.equal(scene.roomRecall.provenance.at(-1).messageId, "frozen-old-external-quote");
  assert.equal(scene.capabilityContext.executionStatus, "failed_temporary");
  assert.ok(!JSON.stringify(scene).includes(item.staleDraft));
});

test("scenes and budgets are independent snapshots and seeds are stage-specific", () => {
  const first = buildFrozenScene(sceneCases[0], persona), second = buildFrozenScene(sceneCases[0], persona);
  first.humanizerBudget.repairsRemaining = 0; first.selected[0].name = "changed"; first.roomRecall.transcript[0].content = "changed";
  assert.equal(second.humanizerBudget.repairsRemaining, 1); assert.equal(persona.name, "Mira"); assert.notEqual(second.roomRecall.transcript[0].content, "changed");
  const seed = stageSeed(sceneCases[0], 1, "generation", "social_scene");
  stageSeed(sceneCases[0], 1, "generation", "multilingual_candidate_review", 3);
  assert.equal(stageSeed(sceneCases[0], 1, "generation", "social_scene"), seed);
  assert.notEqual(seed, stageSeed(sceneCases[0], 2, "generation", "social_scene"));
  assert.notEqual(stageSeed(sceneCases[0], 1, "review-good", "multilingual_candidate_review"), stageSeed(sceneCases[0], 1, "review-bad", "multilingual_candidate_review"));
  assert.throws(() => stageSeed(sceneCases[0], 1, "generation", "multilingual_turn_router_v2"));
});

test("strict options and import/dry-run do not access model, runtime or output directory", () => {
  assert.equal(parseOptions(["--mode=review", "--repeats=3"]).mode, "review");
  for (const args of [["--mode=other"], ["--repeats=4"], ["--cases=missing"], ["--output=/etc/new"], ["--mode=all", "--mode=all"]]) assert.throws(() => parseOptions(args));
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "globalThis.fetch=()=>{throw Error('network forbidden')};await import('./scripts/dm-research-memory-scene-live-eval.mjs');console.log('safe');"], { encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), "safe");
  const dry = spawnSync(process.execPath, ["scripts/dm-research-memory-scene-live-eval.mjs", "--dry-run", "--runtime-root=/missing"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).modelCalls, 0);
});

test("fixed probe uses actual client review method, preserves returned verdict, and records exact seeded request", async () => {
  const verdict = { personaId: persona.id, severity: "none", issues: [] };
  let delivered;
  class Client {
    constructor({ backend }) { this.backend = backend; }
    async reviewCandidateLines(scene, lines) {
      delivered = { scene, lines };
      await this.backend.complete({ messages: [{ role: "system", content: "actual mocked runtime prompt" }, { role: "user", content: JSON.stringify({ candidates: lines }) }], response_format: { json_schema: { name: "multilingual_candidate_review" } }, temperature: 0.1, max_tokens: 600, stream: false });
      scene.humanizerBudget.repairsRemaining = 0;
      return new Map([[persona.id, verdict]]);
    }
    applyCandidateReview() { return { acceptable: true }; }
    cancelPending() {}
  }
  const runtime = { imported: { personas: { PERSONAS: [persona] }, lmStudio: { LmStudioClient: Client } } };
  const transport = { providerId: "offline", configuredModel: "synthetic", complete: async () => ({ choices: [{ message: { content: JSON.stringify({ reviews: [verdict] }) }, finish_reason: "stop" }] }) };
  const result = await evaluateTask({ item: sceneCases[0], task: "review-good", repetition: 1, runtime, transport, model: "synthetic" });
  assert.equal(result.error, undefined); assert.equal(result.matchesExpectedDecision, true);
  assert.equal(delivered.lines[0].content, sceneCases[0].goodDraft);
  assert.equal(result.scene.humanizerBudget.repairsRemaining, 1);
  assert.deepEqual(result.review, verdict); assert.equal(result.calls[0].settings.seed, stageSeed(sceneCases[0], 1, "review-good", "multilingual_candidate_review"));
  assert.equal(result.calls[0].request.messages[0].content, "actual mocked runtime prompt");
});
