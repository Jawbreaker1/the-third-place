import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACTORS } from "./dm-public-memory-chain-live-eval.mjs";
import { sceneCases, buildFrozenScene, buildRunPlan, stageSeed } from "./dm-research-memory-scene-live-eval.mjs";
import { createSceneProjector, withInitialSceneProjection, evaluateProductionTask, FROZEN_SCENE_HARNESS_SHA256, FROZEN_MANIFEST_SHA256 } from "./dm-research-memory-production-live-eval.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const persona = { id: ACTORS.resident, name: "Mira", personality: "fixture" };
const verdict = { personaId: persona.id, severity: "none", issues: [], rewriteInstruction: null, sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 } };
function fakeRuntime(candidate = false, Client = class {}) {
  const observations = { sceneCalls: [], scopeCalls: 0 };
  class Registry {
    constructor(options) { observations.providerOptions = options; }
    sceneContract(invocation, resolution, context) {
      assert.equal(resolution.invocation, invocation); assert.equal(resolution.state, "failed_temporary");
      observations.sceneCalls.push(structuredClone({ invocation, resolution, context }));
      return { premise: "raw production failure only", groundingInstruction: "raw production fresh evidence only", evidenceOutcome: "failed", externalEvidence: true, suppressResponse: false, responsePolicy: invocation.responsePolicy };
    }
  }
  return { imported: { personas: { PERSONAS: [persona] }, capabilityRegistry: { CapabilityRegistry: Registry },
    lmStudio: { LmStudioClient: Client, ...(candidate ? { hasIndependentDmEvidence: (scene) => Boolean(scene.publicParticipantNotes?.[persona.id] || scene.roomRecall) } : {}) },
    ...(candidate ? { dmEvidenceScope: { scopeDmCapabilityScene: (raw) => { observations.scopeCalls++; return { ...raw, premise: "scoped production failure", groundingInstruction: "scoped production fresh evidence" }; } } } : {}) }, observations };
}

test("wrapper preserves the frozen fixture manifest, evaluator file and 66-task plan", async () => {
  assert.equal(sha(JSON.stringify(sceneCases)), FROZEN_MANIFEST_SHA256);
  assert.equal(sha(await readFile(new URL("./dm-research-memory-scene-live-eval.mjs", import.meta.url))), FROZEN_SCENE_HARNESS_SHA256);
  assert.equal(buildRunPlan(sceneCases, 3, "all").length, 66);
  assert.equal(stageSeed(sceneCases[1], 2, "review-good", "multilingual_candidate_review"), 2811240);
});

test("real-contract adapter preserves source data and only candidate availability activates scoping", () => {
  const item = sceneCases[1], original = buildFrozenScene(item, persona), before = structuredClone(original);
  for (const candidate of [false, true]) {
    const runtime = fakeRuntime(candidate), result = createSceneProjector(runtime, item)(original);
    assert.deepEqual(original, before);
    assert.equal(runtime.observations.sceneCalls.length, 1);
    assert.equal(runtime.observations.sceneCalls[0].invocation.goal, item.question);
    assert.equal(result.projection, candidate ? "production_scoped_dm" : "production_raw");
    assert.equal(result.scene.premise, candidate ? "scoped production failure" : "raw production failure only");
    assert.equal(result.scene.capabilityGroundingInstruction, candidate ? "scoped production fresh evidence" : "raw production fresh evidence only");
    for (const key of ["trigger", "roomRecall", "publicParticipantNotes", "semanticContext", "capabilityContext", "mustReplyIds", "requestOwnerIds"]) assert.deepEqual(result.scene[key], original[key]);
    assert.equal(result.scene.research, undefined);
    assert.equal(result.scene.evidenceOutcome, "failed");
    assert.throws(() => runtime.observations.providerOptions.researchBroker.research(), /never execute/);
  }
});

test("no-lookup and empty-memory controls preserve raw paths; other-person memory is availability not relevance", () => {
  const runtime = fakeRuntime(true);
  const none = createSceneProjector(runtime, sceneCases[0])(buildFrozenScene(sceneCases[0], persona));
  assert.equal(none.projection, "no_lookup"); assert.equal(runtime.observations.sceneCalls.length, 0);
  assert.equal(none.scene.premise, undefined);
  const empty = createSceneProjector(runtime, sceneCases[5])(buildFrozenScene(sceneCases[5], persona));
  assert.equal(empty.projection, "production_raw"); assert.equal(empty.scene.publicParticipantNotes, undefined); assert.equal(runtime.observations.scopeCalls, 0);
  const unrelated = createSceneProjector(runtime, sceneCases[6])(buildFrozenScene(sceneCases[6], persona));
  assert.equal(unrelated.projection, "production_scoped_dm");
  assert.equal(unrelated.scene.trigger.content, sceneCases[6].question);
  assert.equal(unrelated.scene.roomRecall.provenance[0].authorId, ACTORS.a);
  assert.ok(!unrelated.scene.publicParticipantNotes[persona.id].includes("LindenFox"));
});

test("projection applies once and does not overwrite runtime recovery requests", async () => {
  const seen = [], observed = { reviews: [] };
  class Base {
    async generateScene(request) {
      seen.push(request.premise);
      await this.reviewCandidateLines(request, []);
      await this.reviewCandidateLines({ ...request, premise: "production-owned recovery" }, []);
      return [];
    }
    async reviewCandidateLines(request) { seen.push(request.premise); return new Map([[persona.id, verdict]]); }
  }
  const runtime = fakeRuntime(true, Base);
  const adapted = withInitialSceneProjection(runtime, createSceneProjector(runtime, sceneCases[1]), observed);
  await new adapted.imported.lmStudio.LmStudioClient().generateScene(buildFrozenScene(sceneCases[1], persona));
  assert.deepEqual(seen, ["scoped production failure", "scoped production failure", "production-owned recovery"]);
  assert.equal(runtime.observations.sceneCalls.length, 1);
  assert.equal(observed.reviews[1].scene.premise, "production-owned recovery");
  assert.equal(observed.projection.scene.premise, "scoped production failure");
});

test("direct fixed reviewer receives projected scene and result preserves actual and neutral evidence separately", async () => {
  class Client {
    async reviewCandidateLines(request, lines) { assert.equal(request.premise, "scoped production failure"); assert.equal(lines[0].content, sceneCases[1].goodDraft); return new Map([[persona.id, verdict]]); }
    applyCandidateReview(assessment) { return assessment; }
    cancelPending() {}
  }
  const runtime = fakeRuntime(true, Client);
  const transport = { providerId: "fixture", configuredModel: "fixture", complete: () => { throw new Error("No network allowed"); } };
  const result = await evaluateProductionTask({ item: sceneCases[1], task: "review-good", repetition: 1, runtime, transport, model: "fixture" });
  assert.equal(result.error, undefined); assert.equal(result.overallDecision, "allow");
  assert.equal(result.scene.premise, "scoped production failure");
  assert.equal(result.neutralInputScene.premise, "The external lookup failed; no external content was returned.");
  assert.notEqual(result.sceneSha256, result.neutralInputSceneSha256);
  assert.equal(result.reviews[0].sceneSha256, result.sceneSha256);
  assert.equal(result.entryPointReviews[0].sceneSha256, result.neutralInputSceneSha256);
  assert.equal(result.calls.length, 0);
});

test("import and dry-run do not load model, create artifacts or require runtime", () => {
  const result = spawnSync(process.execPath, ["scripts/dm-research-memory-production-live-eval.mjs", "--dry-run", "--repeats=3"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.modelCalls, 0); assert.equal(report.runPlan.length, 66);
  assert.equal(report.manifestSha256, FROZEN_MANIFEST_SHA256);
});
