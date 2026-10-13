import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildRunPlan, cases, evaluateCase, inspectPersonalAssessments, loadRuntime, parseOptions, requestForCase, structuredPersonalRequest, STRUCTURED_PERSONAL_GUIDANCE, summarize, validateOutputPath } from "./personal-context-review-live-eval.mjs";

test("balanced multilingual fixtures include grounded and nonconfirming controls alongside both polarities of fabrication", () => {
  assert.equal(cases.length, 8);
  assert.equal(new Set(cases.map((item) => item.id)).size, 8);
  assert.equal(cases.filter((item) => item.expected === "clear").length, 4);
  assert.equal(cases.filter((item) => item.expected === "blocked").length, 4);
  assert.deepEqual([...new Set(cases.map((item) => item.language))].sort(), ["en", "es", "sv"]);
  assert.ok(cases.some((item) => item.id === "en-invented-private-contact"));
  assert.ok(cases.some((item) => item.id === "en-unsupported-private-absence"));
  assert.ok(cases.some((item) => item.id === "sv-attributed-bounded-negative"));
});

test("runtime request is allowlisted and never contains the fixture oracle", () => {
  const item = { ...cases[0], expected: "EXPECTATION_SENTINEL", rationale: "RATIONALE_SENTINEL", pair: "PAIR_SENTINEL", id: "CASE_SENTINEL" };
  const request = requestForCase(item, { id: "test-resident", name: "Test resident" });
  for (const sentinel of ["EXPECTATION_SENTINEL", "RATIONALE_SENTINEL", "PAIR_SENTINEL", "CASE_SENTINEL"]) {
    assert.ok(!JSON.stringify(request).includes(sentinel));
  }
  assert.equal(request.roomRecall.transcript[0].content, item.publicRows[0].content);
  assert.equal(request.publicParticipantNotes["test-resident"], item.publicNote);
  assert.equal(request.trigger.content, item.question);
  assert.equal(request.semanticContext.asksAboutAiIdentity, false);
  assert.equal(Object.hasOwn(requestForCase(cases[4], { id: "test-resident" }), "roomRecall"), false);
});

test("strict options preserve order and repeat bounds without silently adding live work", () => {
  assert.equal(parseOptions([]).structuredPersonal, false);
  assert.equal(parseOptions(["--structured-personal"]).structuredPersonal, true);
  const options = parseOptions(["--cases=en-unsupported-private-absence,sv-grounded-public-impression", "--repeats=2"]);
  assert.deepEqual(buildRunPlan(options.selected, options.repeats).map(({ item, repetition }) => `${item.id}#${repetition}`), [
    "en-unsupported-private-absence#1", "sv-grounded-public-impression#1", "en-unsupported-private-absence#2", "sv-grounded-public-impression#2",
  ]);
  for (const argv of [["--repeats=0"], ["--repeats=4"], ["--repeats=1.5"], ["--cases=missing"],
    ["--cases=sv-grounded-public-impression,sv-grounded-public-impression"], ["--repeats=1", "--repeats=2"], ["--typo"]]) {
    assert.throws(() => parseOptions(argv));
  }
  assert.throws(() => validateOutputPath("/etc/report"));
  assert.throws(() => validateOutputPath("./report"));
  assert.equal(validateOutputPath("/private/tmp/synthetic-review-new"), "/private/tmp/synthetic-review-new");
});

test("summary keeps false approvals, false rejections, unrelated blocks and unavailable reviews distinct", () => {
  const row = (expected, groundingDecision, overallDecision = groundingDecision) => ({ expected, groundingDecision, overallDecision, review: {} });
  assert.deepEqual(summarize([
    row("blocked", "clear"), row("clear", "blocked"), row("clear", "clear", "blocked"),
    row("clear", "clear"), row("blocked", "blocked"), { expected: "clear", error: "timeout" },
  ]), { total: 6, correctGrounding: 3, falseApprovals: 1, falseRejections: 1, cleanControlBlockedForOtherReason: 1, unavailable: 1 });
});

test("dry run does not import runtime or make model calls", () => {
  const result = spawnSync(process.execPath, ["scripts/personal-context-review-live-eval.mjs", "--dry-run", "--runtime-root=/missing", "--cases=en-unsupported-private-absence"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.modelCalls, 0);
  assert.equal(output.cases[0].id, "en-unsupported-private-absence");
});

test("real client reviewer path uses synthetic evidence only and excludes expected labels from all outbound payloads", async () => {
  const runtime = await loadRuntime();
  const item = { ...cases[0], rationale: "RATIONALE_NOT_FOR_MODEL", expected: "EXPECTED_NOT_FOR_MODEL" };
  const requests = [];
  const transport = {
    providerId: "lmstudio", configuredModel: "synthetic-test-model",
    probe: async () => { throw new Error("Unexpected probe"); },
    complete: async (body) => {
      requests.push(body);
      assert.equal(body.response_format.json_schema.name, "multilingual_candidate_review");
      assert.equal(Object.hasOwn(body.response_format.json_schema.schema.properties.reviews.items.properties, "personalContext"), false);
      const data = JSON.parse(body.messages.find((message) => message.role === "user").content);
      return { choices: [{ message: { content: JSON.stringify({ reviews: data.candidates.map((candidate) => ({
        personaId: candidate.personaId, severity: "none", issues: [], rewriteInstruction: null,
        requestDelivery: { resolvedOutcome: "Current impression", status: "delivered", deliveredExcerpt: candidate.content },
        sameSceneOverlap: "none", outputLanguage: { tag: "sv", confidence: 1 },
      })) }) } }] };
    },
  };
  const result = await evaluateCase({ item, repetition: 1, runtime, transport, model: transport.configuredModel });
  assert.equal(result.error, undefined);
  assert.equal(result.groundingDecision, "clear");
  assert.equal(result.overallDecision, "clear");
  assert.equal(requests.length, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].systemSha256.length, 64);
  assert.ok(!JSON.stringify(requests).includes(item.rationale));
  assert.ok(!JSON.stringify(requests).includes(item.expected));
  assert.ok(!Object.hasOwn(result.calls[0], "headers"));
});

test("a malformed review is unavailable, never promoted to a clean result", async () => {
  const runtime = await loadRuntime();
  const transport = {
    providerId: "lmstudio", configuredModel: "synthetic-test-model", probe: async () => { throw new Error("Unexpected probe"); },
    complete: async () => ({ choices: [{ message: { content: "{}" } }] }),
  };
  const result = await evaluateCase({ item: cases[2], repetition: 1, runtime, transport, model: transport.configuredModel });
  assert.equal(result.error, "No validated reviewer assessment");
  assert.equal(result.groundingDecision, undefined);
  assert.equal(summarize([result]).unavailable, 1);
});

test("opt-in assessment is first after identity, changes no sampling/budgets or user evidence, and never mutates the original request", () => {
  const body = {
    messages: [{ role: "system", content: "Existing review contract" }, { role: "user", content: JSON.stringify({ candidates: [] }) }],
    max_tokens: 780, temperature: 0, top_p: 1,
    response_format: { type: "json_schema", json_schema: { name: "multilingual_candidate_review", strict: true, schema: {
      properties: { reviews: { items: { properties: { personaId: { type: "string" }, severity: { type: "string" }, issues: { type: "array" } },
        required: ["personaId", "severity", "issues"] } } },
    } } },
  };
  const before = structuredClone(body);
  const actual = structuredPersonalRequest(body);
  assert.deepEqual(body, before);
  assert.deepEqual(Object.keys(actual.response_format.json_schema.schema.properties.reviews.items.properties), ["personaId", "personalContext", "severity", "issues"]);
  assert.deepEqual(actual.response_format.json_schema.schema.properties.reviews.items.required, ["personaId", "personalContext", "severity", "issues"]);
  assert.equal(actual.messages[0].content, `${STRUCTURED_PERSONAL_GUIDANCE}\n\nExisting review contract`);
  assert.deepEqual(actual.messages[1], body.messages[1]);
  for (const key of ["max_tokens", "temperature", "top_p"]) assert.equal(actual[key], body[key]);
});

test("assessment validation requires exact candidate excerpts and records contradictory issues without changing them", () => {
  const candidates = [{ personaId: "mira", content: "We have never talked privately." }];
  const review = { personaId: "mira", personalContext: { verdict: "unsupported", claimExcerpt: candidates[0].content }, severity: "none", issues: [] };
  const payload = { reviews: [review] };
  const before = structuredClone(payload);
  const inspected = inspectPersonalAssessments(payload, candidates);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.records[0].issueConsistent, false);
  assert.deepEqual(payload, before);
  for (const personalContext of [undefined, { verdict: "none", claimExcerpt: "We" }, { verdict: "supported", claimExcerpt: null },
    { verdict: "unsupported", claimExcerpt: "Invented excerpt" }, { verdict: "unsupported", claimExcerpt: "We", extra: true }]) {
    assert.equal(inspectPersonalAssessments({ reviews: [{ ...review, personalContext }] }, candidates).valid, false);
  }
  assert.equal(inspectPersonalAssessments({ reviews: [review, review] }, candidates).valid, false);
  assert.equal(inspectPersonalAssessments({ reviews: [] }, candidates).valid, false);
  assert.equal(inspectPersonalAssessments({ reviews: [{ ...review, severity: "high", issues: ["evidence_ungrounded"] }] }, candidates).records[0].issueConsistent, true);
  assert.equal(inspectPersonalAssessments({ reviews: [{ ...review, personalContext: { verdict: "none", claimExcerpt: null } }] }, candidates).valid, true);
});

test("experimental adapter preserves raw unsupported assessment and original clean review but never reports the contradictory gate as passed", async () => {
  const runtime = await loadRuntime();
  const item = cases[2];
  const transport = {
    providerId: "lmstudio", configuredModel: "synthetic-test-model", probe: async () => { throw new Error("Unexpected probe"); },
    complete: async (body) => {
      assert.ok(body.messages[0].content.startsWith(STRUCTURED_PERSONAL_GUIDANCE));
      assert.equal(body.max_tokens, 780);
      assert.ok(body.response_format.json_schema.schema.properties.reviews.items.required.includes("personalContext"));
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reviews: [{
        personaId: "ai-mira", personalContext: { verdict: "unsupported", claimExcerpt: "There's no secret!" },
        severity: "none", issues: [], rewriteInstruction: null,
        requestDelivery: { resolvedOutcome: "Respond to the request for private information.", status: "delivered", deliveredExcerpt: item.candidate },
        sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 },
      }] }) } }] };
    },
  };
  const result = await evaluateCase({ item, repetition: 1, runtime, transport, model: transport.configuredModel, structuredPersonal: true });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].parsed.reviews[0].personalContext.verdict, "unsupported");
  assert.equal(result.calls[0].finishReason, "stop");
  assert.equal(result.personalAssessmentDecision, "blocked");
  assert.equal(result.personalIssueConsistent, false);
  assert.equal(result.groundingDecision, "clear");
  assert.equal(result.validatedGroundingDecision, null);
  const summary = summarize([result]);
  assert.equal(summary.falseApprovals, 1);
  assert.equal(summary.structuredPersonal.correctAssessment, 1);
  assert.equal(summary.structuredPersonal.issueContradictions, 1);
  assert.equal(summary.structuredPersonal.validatedCorrect, 0);
  assert.equal(summary.structuredPersonal.validatedUnavailable, 1);
});

test("invalid or truncated experimental assessment fails closed and keeps the raw failure for audit", async () => {
  const runtime = await loadRuntime();
  for (const content of ["{", JSON.stringify({ reviews: [{ personaId: "ai-mira", severity: "none", issues: [],
    personalContext: { verdict: "supported", claimExcerpt: "Words not in the candidate" } }] })]) {
    const transport = {
      providerId: "lmstudio", configuredModel: "synthetic-test-model", probe: async () => { throw new Error("Unexpected probe"); },
      complete: async () => ({ choices: [{ finish_reason: "length", message: { content } }] }),
    };
    const result = await evaluateCase({ item: cases[2], repetition: 1, runtime, transport, model: transport.configuredModel, structuredPersonal: true });
    assert.equal(result.error, "Invalid structured personal-context assessment");
    assert.equal(result.calls[0].content, content);
    assert.equal(result.calls[0].finishReason, "length");
    assert.equal(result.validatedGroundingDecision, null);
    assert.equal(result.personalAssessmentValid, false);
    assert.equal(summarize([result]).structuredPersonal.missingOrInvalidAssessment, 1);
  }
});
