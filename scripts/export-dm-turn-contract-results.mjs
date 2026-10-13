#!/usr/bin/env node

// Loss-aware offline export: keep outputs and validated verdicts, deduplicate
// source scenes, and replace full outbound prompts with reproducible digests.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const copy = (value) => structuredClone(value);

export function parseOptions(argv) {
  const inputs = [];
  let output;
  for (const arg of argv) {
    if (arg.startsWith("--output=")) {
      if (output || !arg.slice("--output=".length)) throw new Error("Supply --output exactly once with a path");
      output = resolve(arg.slice("--output=".length));
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else inputs.push(resolve(arg));
  }
  if (!inputs.length || !output) throw new Error("Usage: export-dm-turn-contract-results.mjs report.json [report.json ...] --output=compact.json");
  if (new Set(inputs).size !== inputs.length) throw new Error("Duplicate report input");
  if (inputs.includes(output)) throw new Error("Output must not replace a source report");
  return { inputs, output };
}

function intern(value, store) {
  if (value === undefined || value === null) return null;
  const digest = sha(JSON.stringify(value));
  store[digest] ??= copy(value);
  return digest;
}

function assertDigest(value, expected, label) {
  const actual = sha(JSON.stringify(value));
  if (expected && expected !== actual) throw new Error(`${label} SHA256 does not match its recorded content`);
  return actual;
}

export function compactCall(call) {
  const { request, ...retained } = call;
  if (!request || !Array.isArray(request.messages)) throw new Error("Model call lacks its original request/messages; refusing unverifiable export");
  const { messages, response_format: responseFormat, ...requestParameters } = request;
  const requestSha256 = assertDigest(request, call.requestSha256, "Model request");
  const userPayloadSha256 = assertDigest(messages.filter((message) => message.role === "user"), call.userPayloadSha256, "User payload");
  const systemSha256 = assertDigest(messages.filter((message) => message.role === "system"), call.systemSha256, "System payload");
  return { ...copy(retained), requestSha256, userPayloadSha256, systemSha256,
    messagesSha256: sha(JSON.stringify(messages)),
    responseFormatSha256: responseFormat === undefined ? null : sha(JSON.stringify(responseFormat)),
    requestParameters: copy(requestParameters),
    promptMessageCount: messages.length,
    promptContentCharacters: messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? null).length), 0),
  };
}

function compactReview(review, scenes) {
  const { scene, ...retained } = review;
  if (scene) assertDigest(scene, review.sceneSha256, "Review scene");
  return { ...copy(retained), ...(scene ? { sceneRef: intern(scene, scenes) } : {}),
    verdictValidation: Array.isArray(review.verdicts) && review.verdicts.length ? "validated" : "no_validated_verdict" };
}

export function compactResult(result, dictionaries) {
  const {
    scene, fixtureBaseScene, neutralInputScene, contractProjection,
    calls, reviews, entryPointReviews, rubric: _duplicateRubric,
    ...retained
  } = result;
  if (!Array.isArray(calls) || !Array.isArray(reviews)) throw new Error("Result lacks calls or reviews");
  if (scene) assertDigest(scene, result.sceneSha256, "Initial scene");
  if (fixtureBaseScene) assertDigest(fixtureBaseScene, result.fixtureBaseSceneSha256, "Fixture scene");
  if (neutralInputScene) assertDigest(neutralInputScene, result.neutralInputSceneSha256, "Neutral scene");
  let projectionRef = null;
  if (contractProjection) {
    const { scene: projectedScene, ...projection } = contractProjection;
    projectionRef = intern({ ...projection, sceneRef: intern(projectedScene, dictionaries.scenes) }, dictionaries.projections);
  }
  const fixedReview = result.task !== "generation";
  const summary = fixedReview
    ? { kind: "fixed_review", validation: result.review && ["allow", "block"].includes(result.overallDecision) ? "validated" : "no_validated_verdict",
      publicationDecision: result.overallDecision ?? null, expectedPublicationDecision: result.expectedDecision ?? null,
      groundingDecision: result.groundingDecision ?? null, expectedGroundingDecision: result.expectedGroundingDecision ?? result.expectedDecision ?? null,
      executionError: result.error ?? null }
    : { kind: "generation", delivery: result.lines?.length ? "reply_returned" : "no_reply", executionError: result.error ?? null };
  return { ...copy(retained), outcomeSummary: summary,
    sceneRef: intern(scene, dictionaries.scenes),
    ...(fixtureBaseScene ? { fixtureBaseSceneRef: intern(fixtureBaseScene, dictionaries.scenes) } : {}),
    ...(neutralInputScene ? { neutralInputSceneRef: intern(neutralInputScene, dictionaries.scenes) } : {}),
    projectionRef,
    reviews: reviews.map((review) => compactReview(review, dictionaries.scenes)),
    ...(entryPointReviews ? { entryPointReviews: entryPointReviews.map((review) => compactReview(review, dictionaries.scenes)) } : {}),
    calls: calls.map(compactCall),
  };
}

export function completionFor(report) {
  if (!Array.isArray(report.manifest) || !Number.isInteger(report.repeats) || !["all", "generation", "review"].includes(report.mode)) {
    return { state: "unknown", expectedTaskCount: null, observedTaskCount: report.results.length };
  }
  const tasks = report.mode === "generation" ? ["generation"] : report.mode === "review" ? ["review-good", "review-bad"] : ["generation", "review-good", "review-bad"];
  const expected = [];
  for (let repetition = 1; repetition <= report.repeats; repetition++) {
    for (const item of report.manifest) for (const task of [...tasks, ...(report.mode !== "generation" && item.staleDraft ? ["review-stale"] : [])]) expected.push(`${item.id}/${task}#${repetition}`);
  }
  const observed = report.results.map((result) => `${result.id}/${result.task}#${result.repetition}`);
  const observedSet = new Set(observed), expectedSet = new Set(expected);
  const missing = expected.filter((key) => !observedSet.has(key));
  const unexpected = observed.filter((key) => !expectedSet.has(key));
  const duplicateTaskKeys = observed.filter((key, index) => observed.indexOf(key) !== index);
  return { state: !missing.length && !unexpected.length && !duplicateTaskKeys.length ? "complete" : "partial_or_mismatched",
    expectedTaskCount: expected.length, observedTaskCount: observed.length, missingTaskKeys: missing, unexpectedTaskKeys: unexpected, duplicateTaskKeys };
}

export function compactReports(sources) {
  const dictionaries = { scenes: {}, projections: {} };
  const reports = sources.map(({ path, bytes }) => {
    const report = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(report.results)) throw new Error(`Not an evaluation report: ${path}`);
    const { results, ...metadata } = report;
    return { sourcePath: resolve(path), sourceBytes: Buffer.byteLength(bytes), sourceSha256: sha(bytes),
      metadata: copy(metadata), completion: completionFor(report),
      results: results.map((result) => compactResult(result, dictionaries)),
    };
  });
  return { format: "third-place-dm-turn-contract-compact", version: 1,
    preservation: {
      retained: ["source report byte digest and metadata", "scenario manifest and gold rubrics", "generated prose", "raw model output and parsed output", "validated reviews including normalized requestDelivery and issues", "privacy sentinel flags", "task kinds and repetition", "publication and grounding expectations separately", "latency and usage", "model parameters and per-call request/prompt/schema SHA256", "deduplicated exact source scenes and registry projections"],
      omitted: ["full outbound model request.messages", "full outbound response_format schemas; their hashes and schema names remain", "repeated rubric strings already in scenario manifest"],
      interpretation: "No new model judgments or semantic scoring. Invalid/no validated review is never counted as a valid rejection. A returned reply is an isolated test result, not an application publication. Missing tasks are reported, not silently treated as a completed run.",
    }, reports, dictionaries };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const sources = await Promise.all(options.inputs.map(async (path) => ({ path, bytes: await readFile(path) })));
  const compact = compactReports(sources);
  const encoded = `${JSON.stringify(compact, null, 2)}\n`;
  // Never overwrite either source reports or an earlier export implicitly.
  await writeFile(options.output, encoded, { flag: "wx" });
  console.log(JSON.stringify({ output: options.output, inputBytes: sources.reduce((sum, source) => sum + source.bytes.length, 0), outputBytes: Buffer.byteLength(encoded),
    reports: compact.reports.map((report) => ({ label: report.metadata.label, ...report.completion })) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
