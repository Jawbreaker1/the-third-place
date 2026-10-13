import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { scenarios } from "./dm-public-memory-live-eval.mjs";
import { ACTORS, assessTrace, chainScenarios, evidenceFor, extractActorPacket, FORBIDDEN_MARKERS, installBindingTrace, installMemoryTrace, parseOptions, sentinelHits, stageSeed } from "./dm-public-memory-chain-live-eval.mjs";

const scenario = chainScenarios[0];
const facts = () => [{ subjectId: ACTORS.a, memory: evidenceFor("sv").memoryA }, { subjectId: ACTORS.b, memory: evidenceFor("sv").memoryB }];
const note = (memory) => `PUBLIC DATA\n${JSON.stringify({ subjectivePublicRecollections: [{ perspective: memory }] })}`;
function cleanResult() {
  const publicFacts = facts(), publicNote = note(publicFacts[0].memory);
  const row = { messageId: `chain-public-${ACTORS.a}`, authorId: ACTORS.a, author: "EmberOtter", content: "A public fact", createdAt: "2026-10-13T08:29:00.000Z", role: "anchor", anchorMatches: ["author_identity"] };
  const witness = { ...row, messageId: `chain-witness-${ACTORS.a}`, authorId: ACTORS.resident, author: "Mira", role: "context", anchorMatches: [] };
  const common = { sourceChannel: { id: "lobby", name: "lobby" }, witnessPersonaIds: [ACTORS.resident] };
  const memory = { id: "memory-a", ownerId: ACTORS.resident, subjectIds: [ACTORS.a], scope: { kind: "public", channelId: "lobby" } };
  return { publicFacts, identitySelections: [{ selectedIds: [ACTORS.a] }], publicProjections: [{ ownerId: ACTORS.resident, subjectId: ACTORS.a }],
    memoryQueries: [{ projectionIndex: 0, query: { ownerId: ACTORS.resident, subjectId: ACTORS.a, visibleInScope: { kind: "public", channelId: "public" } }, memories: [memory] }],
    memoryInventory: [memory], memoryRecalls: [{ projectionIndex: 0, memoryIds: ["memory-a"] }],
    calls: [{ schema: "social_scene", userPayload: [{ publicParticipantNotes: { [ACTORS.resident]: publicNote }, recalledRoomEvidence: { ...common, transcript: [row, witness] } }] },
      { schema: "multilingual_candidate_review", userPayload: [{ candidates: [{ personaId: ACTORS.resident, publicParticipantNote: publicNote }], roomRecall: { ...structuredClone(common), timeline: structuredClone([row, witness]) } }] }],
    privacyViolations: [], reviews: [{ lines: [{ content: "A reviewed line" }] }], generated: [{ lines: [{ content: "A reviewed line" }] }], replies: [{ content: "A reviewed line" }] };
}

function packetResult(subjectIds = [ACTORS.a]) {
  const result = cleanResult();
  const binding = { status: subjectIds.length === 2 ? "group" : subjectIds.length ? "single" : "none", confidence: 0.99,
    subjects: subjectIds.map((personId) => ({ personId, sourceMessageId: "latest", mentionExcerpt: personId === ACTORS.a ? "EmberOtter" : "LindenFox", latestTurnExcerpt: "What did each collect?" })), alternatives: [] };
  const templateRecall = result.calls[0].userPayload[0].recalledRoomEvidence;
  const context = { ownerId: ACTORS.resident, binding, packets: subjectIds.map((subjectId) => ({
    ownerId: ACTORS.resident, subjectId, displayName: subjectId === ACTORS.a ? "EmberOtter" : "LindenFox",
    publicMemoryNote: note(result.publicFacts.find((fact) => fact.subjectId === subjectId).memory),
    roomRecall: { ...structuredClone(templateRecall), sourceChannel: { id: subjectId === ACTORS.a ? "lobby" : "the-pub" },
      transcript: templateRecall.transcript.map((row) => ({ author: row.author, content: row.content, createdAt: row.createdAt })),
      provenance: templateRecall.transcript.map((row) => ({ messageId: row.role === "anchor" ? `chain-public-${subjectId}` : `chain-witness-${subjectId}`, authorId: row.authorId === ACTORS.a ? subjectId : row.authorId, role: row.role, anchorMatches: row.anchorMatches, system: false, generation: row.authorId === ACTORS.resident ? "lm" : null })) },
    coverage: { publicEvidence: "supplied", privateHistory: "unavailable", completeness: "partial" },
  })) };
  result.bindingApiAvailable = true;
  result.memoryPresentation = "packets";
  result.bindingSelections = [{ result: structuredClone(binding), selectedIds: subjectIds }];
  result.publicProjections = []; result.memoryQueries = []; result.memoryRecalls = [];
  result.calls = [{ schema: "social_scene", userPayload: [{ dmPersonContext: context }] },
    { schema: "multilingual_candidate_review", userPayload: [{ candidates: [{ personaId: ACTORS.resident, dmPersonContext: structuredClone(context) }] }] }];
  return result;
}

test("extended chain matrix preserves original eight, earlier nine and thirteen while adding fresh external controls", () => {
  assert.equal(scenarios.length, 8); assert.equal(chainScenarios.length, 15);
  assert.equal(new Set(chainScenarios.map((entry) => entry.id)).size, 15);
  assert.deepEqual(chainScenarios.slice(0, 9).map((entry) => entry.id), ["sv-person-a", "en-person-b", "en-person-b-reversed-catalog", "fr-corrected-person", "de-pronoun-person", "en-ambiguous-person", "fr-private-probe", "de-pruned-public-history", "en-unknown-person"]);
  assert.equal(chainScenarios.slice(9).filter((entry) => entry.expectedSubjects.length === 2).length, 2);
  assert.equal(createHash("sha256").update(JSON.stringify(chainScenarios.slice(0, 9))).digest("hex"), "ac20bf5e8f57592b6fd50fc38a353214d3601741787f0285a786652dadaabf5d");
  assert.equal(createHash("sha256").update(JSON.stringify(chainScenarios.slice(0, 13))).digest("hex"), "d6b1f7f3cecca1777f0452d5ce771de5647fc3560ae340b0cbb35a36f38e247a");
  assert.deepEqual(chainScenarios.slice(13).map((entry) => entry.expectedEvidenceAction), ["web_search", "web_search"]);
  assert.deepEqual([...new Set(chainScenarios.map((entry) => entry.language))].sort(), ["de", "en", "fr", "sv"]);
  for (const language of ["sv", "en", "fr", "de"]) {
    const evidence = evidenceFor(language);
    assert.notEqual(evidence.memoryA, evidence.memoryB);
    assert.deepEqual(sentinelHits(evidence), []);
  }
});

test("catalog reversal shares semantic input and all stage seeds; extra routing cannot shift writer seeds", () => {
  const first = chainScenarios[1], second = chainScenarios[2];
  assert.equal(first.text, second.text); assert.deepEqual(first.expectedSubjects, second.expectedSubjects);
  for (const schema of ["multilingual_turn_router_v2", "social_scene", "multilingual_candidate_review"]) assert.equal(stageSeed(first, 1, schema), stageSeed(second, 1, schema));
  const writer = stageSeed(first, 1, "social_scene");
  stageSeed(first, 1, "multilingual_evidence_plan_verifier_v1", 2);
  assert.equal(stageSeed(first, 1, "social_scene"), writer);
  assert.notEqual(writer, stageSeed(first, 2, "social_scene"));
  assert.equal(stageSeed(first, 3, "dm_person_binding_v1"), 1_542_140);
  assert.throws(() => stageSeed(first, 1, "dm_public_person_reference_v1"));
});

test("strict selection and bounded fresh-temp output options reject unsafe invocations", () => {
  assert.deepEqual(parseOptions(["--cases=de-pronoun-person,sv-person-a"]).selected.map((entry) => entry.id), ["de-pronoun-person", "sv-person-a"]);
  assert.equal(parseOptions(["--repeats=3"]).repeats, 3);
  assert.equal(parseOptions([]).memoryPresentation, "legacy");
  assert.equal(parseOptions(["--memory-presentation=packets"]).memoryPresentation, "packets");
  for (const args of [["--output=/etc/data"], ["--repeats=4"], ["--repeats=0"], ["--repeats=1.5"], ["--cases=missing"], ["--cases=sv-person-a,sv-person-a"], ["--memory-presentation=automatic"], ["--unknown"]]) assert.throws(() => parseOptions(args));
});

test("sentinel detection covers complete raw payloads and all private plus other-owner markers", () => {
  for (const marker of FORBIDDEN_MARKERS) assert.deepEqual(sentinelHits({ content: "a".repeat(30_000) + marker }), [marker]);
  assert.deepEqual(sentinelHits({ ordinary: "A public recollection" }), []);
});

test("real-memory wrappers record owner/scope/selected IDs without changing returns or arguments", () => {
  const memory = { id: "m1", eventId: "e1", ownerId: ACTORS.resident, subjectIds: [ACTORS.a], perspective: "Public text", event: { scope: { kind: "public", channelId: "lobby" }, sourceMessageIds: ["s1"] } };
  const result = { memoryQueries: [], memoryRecalls: [], publicProjections: [] };
  const calls = [];
  const memoryStore = { listMemories: (query) => { calls.push(query); return [memory]; }, markMemoriesRecalled: (ids) => { calls.push(ids); return 1; } };
  const coordinator = { publicThirdPartyPromptNote: (ownerId, subjectId) => {
    memoryStore.listMemories({ ownerId, subjectId, visibleInScope: { kind: "public", channelId: "public" } });
    memoryStore.markMemoriesRecalled(["m1"]); return "untouched note";
  } };
  installMemoryTrace(memoryStore, coordinator, result);
  assert.equal(coordinator.publicThirdPartyPromptNote(ACTORS.resident, ACTORS.a, { kind: "dm", threadId: "d", participantIds: [ACTORS.asker, ACTORS.resident] }), "untouched note");
  assert.equal(calls.length, 2); assert.equal(result.memoryQueries[0].projectionIndex, 0);
  assert.deepEqual(result.memoryQueries[0].memories[0].scope, { kind: "public", channelId: "lobby" });
  assert.deepEqual(result.memoryRecalls[0].memoryIds, ["m1"]);
  assert.equal(result.publicProjections[0].note, "untouched note");
});

test("writer/reviewer source metadata and escaped memory strings match without grading answer language", () => {
  const result = cleanResult(), assessment = assessTrace(scenario, result);
  assert.equal(assessment.structuralPass, true); assert.equal(assessment.expectedEvidenceDelivered, true);
  assert.equal(assessment.semanticAnswerQuality, "manual_review_required");
  const writer = extractActorPacket(result.calls[0].schema, result.calls[0].userPayload[0]);
  const reviewer = extractActorPacket(result.calls[1].schema, result.calls[1].userPayload[0]);
  assert.deepEqual(writer.recall, reviewer.recall);
});

test("binding observation preserves real inputs, return identity, errors and API absence", async () => {
  const binding = { status: "single", subjects: [{ personId: ACTORS.b }], alternatives: [], confidence: 0.97 };
  const input = { latestMessage: { id: "latest", content: "Tell me about LindenFox" } };
  const options = { signal: new AbortController().signal };
  const calls = [], result = {};
  const lm = { bindDmPersons: async (...args) => { calls.push(args); return binding; } };
  installBindingTrace(lm, result);
  assert.equal(await lm.bindDmPersons(input, options), binding);
  assert.equal(calls[0][0], input); assert.equal(calls[0][1], options);
  assert.deepEqual(result.bindingSelections[0], { input, result: binding, selectedIds: [ACTORS.b] });
  const absent = {}; installBindingTrace({}, absent);
  assert.equal(absent.bindingApiAvailable, false); assert.deepEqual(absent.bindingSelections, []);
  const failed = {}; const throwing = { bindDmPersons: async () => { throw new Error("fixture failure"); } }; installBindingTrace(throwing, failed);
  await assert.rejects(throwing.bindDmPersons(input), /fixture failure/);
  assert.equal(failed.bindingSelections[0].error, "fixture failure");
});

test("candidate binding controls identity scoring; unavailable never falls back to broad p.h", () => {
  const result = packetResult(); result.identitySelections[0].selectedIds = [ACTORS.b];
  assert.equal(assessTrace(scenario, result).structuralPass, true);
  assert.equal(assessTrace(scenario, result).identitySource, "dm_person_binding");
  result.bindingSelections[0] = { result: { status: "unavailable", subjects: [], alternatives: [], confidence: 0 }, selectedIds: [] };
  assert.equal(assessTrace(scenario, result).identitySelectionMatches, false);
});

test("legacy binding-only is valid while explicit packets requires the new context; re-assessment does not mutate raw traces", () => {
  const result = cleanResult();
  result.bindingApiAvailable = true;
  result.bindingSelections = [{ selectedIds: [ACTORS.a], result: { status: "single", subjects: [{ personId: ACTORS.a }], alternatives: [], confidence: 1 } }];
  const before = structuredClone(result);
  assert.equal(assessTrace(scenario, result).structuralPass, true);
  const strict = assessTrace(scenario, result, { memoryPresentation: "packets" });
  assert.equal(strict.structuralPass, false);
  assert.ok(strict.failures.some((failure) => failure.code === "dm_person_context_missing"));
  assert.deepEqual(result, before);
  result.memoryPresentation = "packets";
  assert.equal(assessTrace(scenario, result).structuralPass, false);
  assert.equal(assessTrace(scenario, result, { memoryPresentation: "legacy" }).structuralPass, true);
  const supplied = packetResult(); supplied.calls[0].userPayload[0].dmPersonContext.packets[0].ownerId = ACTORS.otherResident;
  assert.ok(assessTrace(scenario, supplied, { memoryPresentation: "legacy" }).failures.some((failure) => failure.code === "wrong_person_packet_identity"));
  assert.throws(() => assessTrace(scenario, result, { memoryPresentation: "automatic" }));
});

test("coherent two-person packets deliver both exact sources, with strict complete metadata parity", () => {
  const group = chainScenarios.find((entry) => entry.id === "en-two-person-group");
  const result = packetResult([ACTORS.a, ACTORS.b]);
  assert.equal(assessTrace(group, result).structuralPass, true);
  assert.equal(assessTrace(group, result).expectedRecallDelivered, true);
  const candidate = result.calls[1].userPayload[0].candidates[0];
  candidate.dmPersonContext.packets[0].roomRecall.provenance[0].anchorMatches = [];
  assert.ok(assessTrace(group, result).failures.some((failure) => failure.code === "writer_reviewer_evidence_mismatch"));
});

test("crosswired group evidence, current-interlocutor packets, coverage and binding drift fail independently", () => {
  const group = chainScenarios.find((entry) => entry.id === "en-two-person-group");
  const mutations = [
    ["wrong_public_person_in_outbound_note", (context) => { context.packets[0].publicMemoryNote = context.packets[1].publicMemoryNote; }],
    ["wrong_public_person_in_outbound_recall", (context) => { context.packets[0].roomRecall = structuredClone(context.packets[1].roomRecall); }],
    ["wrong_person_packet_identity", (context) => { context.packets[0].subjectId = ACTORS.asker; }],
    ["wrong_context_owner", (context) => { context.ownerId = ACTORS.otherResident; }],
    ["wrong_person_packet_identity", (context) => { context.packets[0].ownerId = ACTORS.otherResident; }],
    ["wrong_person_packet_coverage", (context) => { context.packets[0].coverage.privateHistory = "supplied"; }],
    ["outbound_binding_mismatch", (context) => { context.binding.confidence = 0.5; }],
    ["binding_packet_subject_mismatch", (context) => { context.packets.pop(); }],
  ];
  for (const [code, mutate] of mutations) {
    const result = packetResult([ACTORS.a, ACTORS.b]); mutate(result.calls[0].userPayload[0].dmPersonContext);
    const assessed = assessTrace(group, result); assert.equal(assessed.structuralPass, false, code);
    assert.ok(assessed.failures.some((failure) => failure.code === code), code);
  }
  assert.equal(assessTrace(chainScenarios.find((entry) => entry.id === "sv-current-interlocutor"), packetResult([])).structuralPass, true);
  const missing = packetResult(); delete missing.calls[0].userPayload[0].dmPersonContext;
  assert.ok(assessTrace(scenario, missing).failures.some((failure) => failure.code === "dm_person_context_missing"));
});

test("memory-only group does not require pruned transcripts but does require both distinct public memories", () => {
  const memoryOnly = chainScenarios.find((entry) => entry.id === "en-pruned-two-person-group");
  const result = packetResult([ACTORS.a, ACTORS.b]);
  for (const call of result.calls) for (const payload of call.userPayload) {
    const context = payload.dmPersonContext ?? payload.candidates[0].dmPersonContext;
    for (const person of context.packets) delete person.roomRecall;
  }
  assert.equal(assessTrace(memoryOnly, result).structuralPass, true);
  delete result.calls[0].userPayload[0].dmPersonContext.packets[1].publicMemoryNote;
  assert.equal(assessTrace(memoryOnly, result).expectedEvidenceDelivered, false);
});

test("wrong public person, owner/scope, parity and publication bugs are distinct mechanical failures", () => {
  const mutations = [
    ["wrong_public_projection", (result) => { result.publicProjections[0].subjectId = ACTORS.b; }],
    ["wrong_memory_provenance", (result) => { result.memoryQueries[0].memories[0].scope.kind = "dm"; }],
    ["wrong_memory_query_scope", (result) => { result.memoryQueries[0].query.visibleInScope.kind = "dm"; }],
    ["wrong_public_person_in_outbound_recall", (result) => { result.calls[0].userPayload[0].recalledRoomEvidence.transcript[0].authorId = ACTORS.b; }],
    ["wrong_public_person_in_outbound_note", (result) => { result.calls[0].userPayload[0].publicParticipantNotes[ACTORS.resident] = note(result.publicFacts[1].memory); }],
    ["writer_reviewer_evidence_mismatch", (result) => { result.calls[1].userPayload[0].roomRecall.sourceChannel.id = "different"; }],
    ["published_line_not_returned_by_generation", (result) => { result.replies[0].content = "A different line"; }],
    ["published_line_without_observed_review", (result) => { result.reviews = []; }],
    ["expected_exact_public_episode_missing_at_writer", (result) => { result.calls[0].userPayload[0].recalledRoomEvidence.transcript = []; }],
    ["identity_selection_mismatch", (result) => { result.identitySelections[0].selectedIds = [ACTORS.b]; }],
  ];
  for (const [code, mutate] of mutations) { const result = cleanResult(); mutate(result); const assessed = assessTrace(scenario, result); assert.equal(assessed.structuralPass, false, code); assert.ok(assessed.failures.some((failure) => failure.code === code), code); }
});

test("unresolved people cannot silently receive public notes; a private boundary need not recite public memory", () => {
  const unresolved = { ...scenario, expectedSubjects: [] }, result = cleanResult();
  assert.ok(assessTrace(unresolved, result).failures.some((failure) => failure.code === "public_note_on_unresolved_person"));
  const noEvidence = { ...cleanResult(), publicProjections: [], memoryQueries: [], memoryRecalls: [], calls: [], replies: [] };
  assert.equal(assessTrace({ ...scenario, privateProbe: true }, noEvidence).structuralPass, true);
  assert.equal(assessTrace(scenario, noEvidence).structuralPass, false);
});

test("fresh external control permits optional relevant public memory but still requires actual failed research; mixed control needs both", () => {
  const fresh = chainScenarios.find((entry) => entry.id === "en-fresh-external-with-public-memory");
  const mixed = chainScenarios.find((entry) => entry.id === "fr-public-recall-and-fresh-external");
  const result = cleanResult();
  result.analyses = [{ evidence: { action: "web_search" } }]; result.forbiddenLookups = ["research"];
  assert.equal(assessTrace(fresh, result).structuralPass, true);
  assert.equal(assessTrace(mixed, result).structuralPass, true);
  const noMemory = { ...structuredClone(result), identitySelections: [{ selectedIds: [] }], publicProjections: [], memoryQueries: [], memoryRecalls: [], calls: [], replies: [] };
  assert.equal(assessTrace(fresh, noMemory).structuralPass, true);
  assert.equal(assessTrace(mixed, noMemory).structuralPass, false);
  result.forbiddenLookups = [];
  assert.ok(assessTrace(fresh, result).failures.some((failure) => failure.code === "explicit_external_attempt_missing"));
  result.analyses[0].evidence.action = "none";
  assert.ok(assessTrace(fresh, result).failures.some((failure) => failure.code === "explicit_external_action_missing"));
  result.identitySelections[0].selectedIds = [ACTORS.b];
  assert.equal(assessTrace(fresh, result).identitySelectionMatches, false);
});

test("import and dry-run do not load model/runtime, create stores or contact network", () => {
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "globalThis.fetch=()=>{throw Error('network forbidden')}; await import('./scripts/dm-public-memory-chain-live-eval.mjs'); console.log('safe');"], { encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), "safe");
  const dry = spawnSync(process.execPath, ["scripts/dm-public-memory-chain-live-eval.mjs", "--dry-run", "--runtime-root=/does-not-exist"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).modelCalls, 0);
});
