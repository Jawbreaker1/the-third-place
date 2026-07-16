#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  AMBIENT_ACTION_KINDS,
  decideAmbientAction,
  sampleAmbientEpisodeShape,
} from "../server/ambientActionPlanner.ts";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIRECTOR_PATH = resolve(SCRIPT_DIRECTORY, "../server/director.ts");
const DEFAULT_EPISODES_PER_SCENARIO = 240;

const round = (value, digits = 4) => Number(value.toFixed(digits));

/** A tiny reproducible PRNG; it is test machinery, never production pacing. */
export const seededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const frequencyReport = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count, share: round(count / values.length) }))
    .sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)));
};

/**
 * Exercises the deterministic transport/action policy over every room mode,
 * origin and debate setting. No model text, language heuristic or network is
 * involved: this audit is specifically about shape and scheduling signatures.
 */
export const simulateAmbientEngine = ({
  seed = 0xa11d1e,
  episodesPerScenario = DEFAULT_EPISODES_PER_SCENARIO,
} = {}) => {
  const rng = seededRandom(seed);
  const lengths = [];
  const actions = [];
  const scenarios = [];
  let hardCapStops = 0;
  let naturalStops = 0;
  let immediateActionRepeats = 0;
  let hardCapViolations = 0;

  const modes = ["discussion", "casual", "banter"];
  const origins = ["room_seed", "human_topic", "autonomous_research"];
  for (const mode of modes) {
    for (const origin of origins) {
      for (const debateBeat of [false, true]) {
        const scenarioLengths = [];
        for (let episodeIndex = 0; episodeIndex < episodesPerScenario; episodeIndex += 1) {
          const shape = sampleAmbientEpisodeShape({ origin, mode, debateBeat, rng });
          const previousActions = [];
          let messageCount = 0;
          for (let guard = 0; guard < 16; guard += 1) {
            const decision = decideAmbientAction({
              messageCount,
              shape,
              origin,
              mode,
              debateBeat,
              hasResearch: origin === "autonomous_research",
              hasOpenHook: messageCount < shape.minimumMessages || rng() < 0.22,
              previousActions,
              rng,
            });
            if (!decision.continueEpisode) {
              if (messageCount >= shape.hardMaximumMessages) hardCapStops += 1;
              else naturalStops += 1;
              break;
            }
            if (previousActions.at(-1) === decision.kind) immediateActionRepeats += 1;
            previousActions.push(decision.kind);
            actions.push(decision.kind);
            messageCount += 1;
            if (messageCount > shape.hardMaximumMessages) {
              hardCapViolations += 1;
              break;
            }
          }
          lengths.push(messageCount);
          scenarioLengths.push(messageCount);
        }
        scenarios.push({
          mode,
          origin,
          debateBeat,
          uniqueLengths: new Set(scenarioLengths).size,
          dominantLengthShare: frequencyReport(scenarioLengths)[0]?.share ?? 0,
          meanLength: round(scenarioLengths.reduce((sum, value) => sum + value, 0) / scenarioLengths.length),
        });
      }
    }
  }

  const lengthFrequency = frequencyReport(lengths);
  const actionFrequency = frequencyReport(actions);
  const actionKindsSeen = new Set(actions);
  const issues = [];
  if (hardCapViolations > 0) issues.push(`${hardCapViolations} simulated episodes exceeded their hard maximum`);
  if (immediateActionRepeats > 0) issues.push(`${immediateActionRepeats} immediate action repetitions survived planning`);
  const seenLengths = new Set(lengths);
  const unreachableLengths = Array.from({ length: 8 }, (_, index) => index + 1)
    .filter((length) => !seenLengths.has(length));
  if (unreachableLengths.length > 0) {
    issues.push(`published lengths were unreachable in this sample: ${unreachableLengths.join(", ")}`);
  }
  if ((lengthFrequency[0]?.share ?? 1) > 0.34) {
    issues.push(`one thread length dominates ${(100 * lengthFrequency[0].share).toFixed(1)}% of episodes`);
  }
  if (scenarios.some((scenario) => scenario.uniqueLengths < 4)) {
    issues.push("at least one mode/origin/debate scenario collapsed below four distinct lengths");
  }
  if (naturalStops === 0 || hardCapStops === 0) {
    issues.push("the simulation did not exercise both natural silence and hard-cap closure");
  }
  const missingActionKinds = AMBIENT_ACTION_KINDS.filter((kind) => !actionKindsSeen.has(kind));
  if (missingActionKinds.length > 0) issues.push(`action kinds never selected: ${missingActionKinds.join(", ")}`);

  return {
    seed,
    episodes: lengths.length,
    lengthFrequency,
    actionFrequency,
    scenarios,
    naturalStops,
    hardCapStops,
    hardCapViolations,
    immediateActionRepeats,
    passed: issues.length === 0,
    issues,
  };
};

const methodName = (method, sourceFile) => {
  if (!method.name) return undefined;
  if (ts.isIdentifier(method.name) || ts.isStringLiteral(method.name)) return method.name.text;
  return method.name.getText(sourceFile);
};

const classMethods = (sourceFile, className) => {
  const methods = new Map();
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) methods.set(methodName(member, sourceFile), member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
};

const calledMemberName = (call) => {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const callsIn = (node) => {
  const calls = [];
  const visit = (candidate) => {
    if (ts.isCallExpression(candidate)) {
      calls.push({ name: calledMemberName(candidate), position: candidate.getStart() });
    }
    ts.forEachChild(candidate, visit);
  };
  if (node) visit(node);
  return calls;
};

const hasPublishedMessageOperationKey = (node) => {
  let found = false;
  const visit = (candidate) => {
    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === "operationId" &&
      candidate.initializer &&
      ts.isTemplateExpression(candidate.initializer) &&
      candidate.initializer.head.text === "publish:" &&
      candidate.initializer.templateSpans.length === 1
    ) {
      const expression = candidate.initializer.templateSpans[0].expression;
      found = ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "message" &&
        expression.name.text === "id";
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  if (node) visit(node);
  return found;
};

/**
 * Static AST audit of the durable publication boundary. This deliberately
 * checks call topology rather than matching source-code whitespace or prose.
 */
export const auditPublicationBoundarySource = (source, fileName = "director.ts") => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = classMethods(sourceFile, "SocialDirector");
  const issues = [];
  const required = ["runAmbient", "recordAmbientPost", "commitAmbientPublication"];
  for (const name of required) {
    if (!methods.has(name)) issues.push(`SocialDirector.${name} is missing`);
  }
  if (issues.length > 0) return { passed: false, issues, callSites: {} };

  const runCalls = callsIn(methods.get("runAmbient").body);
  const postPositions = runCalls.filter((call) => call.name === "postPublic").map((call) => call.position);
  const recordPositions = runCalls.filter((call) => call.name === "recordAmbientPost").map((call) => call.position);
  if (postPositions.length === 0) issues.push("runAmbient has no public-message publication call");
  if (recordPositions.length === 0) issues.push("runAmbient never records a successful ambient post");
  if (recordPositions.some((position) => !postPositions.some((postPosition) => postPosition < position))) {
    issues.push("ambient state can be recorded before any preceding postPublic call");
  }

  const recordCalls = callsIn(methods.get("recordAmbientPost").body);
  if (recordCalls.filter((call) => call.name === "commitAmbientPublication").length !== 1) {
    issues.push("recordAmbientPost must commit episode metadata exactly once");
  }

  const commitCallers = [];
  for (const [name, method] of methods) {
    if (name === "commitAmbientPublication") continue;
    if (callsIn(method.body).some((call) => call.name === "commitAmbientPublication")) commitCallers.push(name);
  }
  if (commitCallers.length !== 1 || commitCallers[0] !== "recordAmbientPost") {
    issues.push(`durable ambient commit has unexpected caller(s): ${commitCallers.join(", ") || "none"}`);
  }

  const commitMethod = methods.get("commitAmbientPublication");
  const commitCalls = callsIn(commitMethod.body);
  if (!commitCalls.some((call) => call.name === "openEpisode")) {
    issues.push("first publication cannot open a durable episode");
  }
  if (!commitCalls.some((call) => call.name === "updateEpisode")) {
    issues.push("later publications cannot update a durable episode");
  }
  if (!hasPublishedMessageOperationKey(commitMethod.body)) {
    issues.push("durable publication operations are not idempotently keyed by published message ID");
  }

  return {
    passed: issues.length === 0,
    issues,
    callSites: {
      postPublic: postPositions.length,
      recordAmbientPost: recordPositions.length,
      commitCallers,
      ledgerOpen: commitCalls.filter((call) => call.name === "openEpisode").length,
      ledgerUpdate: commitCalls.filter((call) => call.name === "updateEpisode").length,
    },
  };
};

export const runAmbientAudit = async ({ directorPath = DEFAULT_DIRECTOR_PATH, seed } = {}) => {
  const simulation = simulateAmbientEngine({ seed });
  const publicationBoundary = auditPublicationBoundarySource(
    await readFile(directorPath, "utf8"),
    directorPath,
  );
  const issues = [
    ...simulation.issues.map((issue) => `shape: ${issue}`),
    ...publicationBoundary.issues.map((issue) => `publication: ${issue}`),
  ];
  return {
    simulation,
    publicationBoundary,
    passed: issues.length === 0,
    issues,
  };
};

export const renderAmbientAudit = (report) => {
  const dominant = report.simulation.lengthFrequency[0];
  const actions = report.simulation.actionFrequency
    .map((entry) => `${entry.value}:${entry.count}`)
    .join(" ");
  return [
    "Ambient engine deterministic audit",
    `Episodes: ${report.simulation.episodes}`,
    `Lengths: ${report.simulation.lengthFrequency.map((entry) => `${entry.value}:${entry.count}`).join(" ")}`,
    `Dominant length: ${dominant?.value ?? "none"} (${((dominant?.share ?? 0) * 100).toFixed(1)}%)`,
    `Natural/hard-cap stops: ${report.simulation.naturalStops}/${report.simulation.hardCapStops}`,
    `Actions: ${actions}`,
    `Publication boundary: ${report.publicationBoundary.passed ? "PASS" : "FAIL"}`,
    report.passed ? "Result: PASS" : `Result: FAIL\n- ${report.issues.join("\n- ")}`,
  ].join("\n");
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const report = await runAmbientAudit();
  console.log(json ? JSON.stringify(report, null, 2) : renderAmbientAudit(report));
  if (!report.passed) process.exitCode = 1;
}
