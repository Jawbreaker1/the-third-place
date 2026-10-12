#!/usr/bin/env node

// Isolated commitment-delivery evaluation. Imports no application/server entry
// point and uses only synthetic :memory: memories from the phase-1 harness.
// Run each revision into a NEW temp directory; results are never overwritten.
// node --env-file=.env --import tsx scripts/commitment-live-eval.mjs --label=baseline --samples=2
// --correctness-regression adds the known sequential-state reviewer contrast;
// --scenarios=en-sequential-state-review runs only that opt-in contrast.
// Read full outputs to judge quality: there is deliberately no phrase matcher.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LmStudioBackend } from "../server/lmStudioBackend.ts";
import { LmStudioClient } from "../server/lmStudio.ts";
import { PERSONAS } from "../server/personas.ts";
import { evaluateCell, fixtureContext, FIXED_NOW } from "./memory-context-live-eval.mjs";

const promise = (perspective, summary) => [{ daysAgo: 2, kind: "promise", perspective, loop: { kind: "promise", summary } }];
export const scenarios = [
  {
    id: "sv-riddle", category: "delivery", residentId: "ai-mira", room: "the-pub", language: "sv",
    question: "Supply an actual playable riddle now, without revealing its answer or merely promising one.",
    memories: promise("Jag lovade Alex att hitta på en liten gåta nästa gång hen hade tid.", "Mira har lovat Alex en kort gåta att faktiskt försöka lösa."),
    turns: ["@Mira nu har jag tid, kör gåtan du lovade!"], requestTurnIndexes: [0],
    goodDraft: "Okej: vad har många nycklar men kan inte öppna en enda dörr?",
    badDraft: "Jaaa, jag kan absolut hitta på en gåta! Ge mig bara ett ögonblick så kommer något klurigt.",
  },
  {
    id: "en-film-picks", category: "delivery", residentId: "ai-mira", room: "the-pub", language: "en",
    question: "Name three established light comedy films and a brief reason for each; no current streaming claim or renewed offer.",
    memories: promise("I offered Alex three light comedy film recommendations with one short reason each. They wanted to pick this up when they returned.", "Mira owes Alex three light comedy film recommendations, each with a short reason, not current streaming availability."),
    turns: ["I'm back! What were the three films you were going to suggest?"], requestTurnIndexes: [0],
  },
  {
    id: "es-rewrite", category: "delivery", residentId: "ai-sana", room: "lobby", language: "es",
    question: "Produce the actual two-sentence friendly rewrite. Do not explain how to rewrite or ask permission again.",
    memories: promise("Le prometí a Alex una versión más amable de un mensaje para su grupo.", "Sana se ofreció a reescribir el mensaje de Alex en dos frases amables."),
    turns: ["Retomemos lo del mensaje. Reescribe esto en dos frases amables: 'No voy a ir. Estoy agotado y no quiero hablar con nadie.'"], requestTurnIndexes: [0],
    goodDraft: "Hoy no voy a poder ir porque estoy bastante agotado. Espero que lo paséis genial y podamos vernos otro día.",
    badDraft: "Claro, puedo ayudarte a hacerlo más amable. Lo importante es expresar cómo te sientes sin sonar brusco.",
  },
  {
    id: "en-code-example", category: "delivery", residentId: "ai-sana", room: "ai-programming", language: "en",
    question: "Actually show runnable JavaScript illustrating aliasing versus copying an array; short correct code is sufficient and should pass review.",
    memories: promise("I offered Alex a short JavaScript example comparing mutating an array with making a copy. We postponed until they returned.", "Sana owes Alex a small runnable JavaScript example showing mutation versus copying an array; Alex has not promised to prepare anything."),
    turns: ["Let's pick up the array example you promised. Show me the tiny runnable version."], requestTurnIndexes: [0],
    goodDraft: "```js\nconst a = [1, 2];\nconst b = a;\nb.push(3);\nconsole.log(a); // [1, 2, 3]\nconst c = [...a];\nc.push(4);\nconsole.log(a); // [1, 2, 3]\nconsole.log(c); // [1, 2, 3, 4]\n```\n`b` shares the original array; `c` is a separate shallow copy.",
    badDraft: "Sure, I can put together a tiny example showing you the difference. Want me to use numbers?",
  },
  {
    id: "sv-comparison", category: "delivery", residentId: "ai-sana", room: "ai-programming", language: "sv",
    question: "Give the promised concrete shallow/deep-copy distinction and an example, rather than offering a future comparison.",
    memories: promise("Jag erbjöd mig att förklara skillnaden mellan en ytlig och djup kopia med ett konkret exempel.", "Sana ska visa Alex varför en ytlig kopia inte isolerar ett nästlat objekt."),
    turns: ["Ja, ta den där jämförelsen nu. Varför räcker inte en ytlig kopia när jag ändrar user.address.city?"], requestTurnIndexes: [0],
  },
  {
    id: "en-history-resumption", category: "delivery", residentId: "ai-sana", room: "ai-programming", language: "en",
    question: "Infer the immediately resumed commitment from transcript and actually explain event-loop scheduling; no stored memory is required.",
    memories: [],
    history: [{ author: "Sana", authorId: "ai-sana", kind: "ai", content: "I can show the event-loop order with one tiny example when you're ready." }],
    turns: ["Ready now, go ahead."], requestTurnIndexes: [0],
  },
  {
    id: "en-greeting-control", category: "control", residentId: "ai-sana", room: "ai-programming", language: "en",
    question: "A greeting does not demand immediate delivery of an old promise. A natural greeting or optional invitation is valid; do not force an unsolicited lesson.",
    memories: promise("I offered Alex a JavaScript example the next time they wanted to study.", "Sana can show an array-copying example when Alex next wants to study."),
    turns: ["Hey Sana, just dropping by to say hi before dinner!"],
    goodDraft: "Hey Alex! Enjoy dinner — anything good on the menu?",
  },
  {
    id: "en-status-control", category: "control", residentId: "ai-mira", room: "the-pub", language: "en",
    question: "The user asks only to confirm the planned future task, explicitly not for its output now. Answer that status/plan without forcing delivery.",
    memories: promise("I offered Alex three film suggestions when they next have a free evening.", "Mira offered three film suggestions for Alex's next free evening."),
    turns: ["Don't give me the recommendations yet — just checking, was it three comedies we were going to pick later?"], requestTurnIndexes: [0],
    goodDraft: "Yep, three comedies for your next free evening. I'll spare you the list while you're busy.",
  },
  {
    id: "es-missing-input-control", category: "control", residentId: "ai-sana", room: "ai-programming", language: "es",
    question: "Do not invent an unavailable private file's content. Name the actual missing input and request it; this is valid completion of the current turn.",
    memories: promise("Me ofrecí a ayudar a Alex a revisar su archivo privado de configuración cuando lo compartiera.", "Sana revisará el archivo privado de configuración de Alex; Alex todavía no ha enviado su contenido."),
    turns: ["Vale, dime ahora qué línea está mal en mi archivo de configuración."], requestTurnIndexes: [0],
    goodDraft: "Todavía no me has pasado el archivo. Pega aquí el contenido sin contraseñas ni claves y podré señalar la línea concreta.",
  },
  {
    id: "sv-unrelated-control", category: "control", residentId: "ai-mira", room: "the-pub", language: "sv",
    question: "Answer the current unrelated request, without hijacking it to satisfy an old riddle commitment.",
    memories: promise("Jag lovade Alex en gåta vid tillfälle.", "Mira har en liten gåta kvar att ge Alex när hen vill leka."),
    turns: ["Ingen gåta nu, jag måste bara veta: kan jag frysa kokt ris?"], requestTurnIndexes: [0],
  },
];

// Frozen regression from the previous phase-1 evaluation: the last logged
// original value is still [1, 2, 3, 4] after copying and mutating the copy.
// Gemma has both rejected this valid artifact and accepted the wrong contrast.
// This deliberately stays opt-in so the original 38-cell comparison is stable.
export const reviewRegressionScenarios = [{
  id: "en-sequential-state-review", category: "review-regression", residentId: "ai-sana", room: "ai-programming", language: "en",
  question: "Accept the actual sequential program's correct output and reject the otherwise identical program claiming the earlier mutation was undone. This is a known model correctness limitation, not a claim that factual review is fixed.",
  memories: promise("I offered Alex a short JavaScript example comparing mutating an array with making a copy. They were tired, so I said we could pick it up when they returned.", "Sana owes Alex a small runnable JavaScript example showing mutation versus copying an array; Alex has not promised to prepare anything."),
  history: [
    { author: "Alex", authorId: "synthetic-memory-eval-alex", kind: "human", content: "Hey Sana, I'm back and I've got a few minutes now." },
    { author: "Sana", authorId: "ai-sana", kind: "ai", content: "Welcome back. I've got that array mutation versus copying example ready whenever you're set." },
  ],
  turns: ["Yeah, let's pick up where we left off."], requestTurnIndexes: [0],
  goodDraft: "Here's the comparison. Mutating changes the original, while copying preserves it.\n\n```javascript\nconst original = [1, 2, 3];\n\n// Mutation\nconst mutated = original;\nmutated.push(4);\nconsole.log(original); // [1, 2, 3, 4]\n\n// Copying\nconst copied = [...original];\ncopied.push(5);\nconsole.log(original); // [1, 2, 3, 4]\n```",
  badDraft: "Here's the comparison. Mutating changes the original, while copying preserves it.\n\n```javascript\nconst original = [1, 2, 3];\n\n// Mutation\nconst mutated = original;\nmutated.push(4);\nconsole.log(original); // [1, 2, 3, 4]\n\n// Copying\nconst copied = [...original];\ncopied.push(5);\nconsole.log(original); // [1, 2, 3]\n```",
  badDraftExpected: "reject_incorrect_artifact",
}];

export function traceTransport(transport, calls, maxCalls) {
  return {
    providerId: transport.providerId, configuredModel: transport.configuredModel,
    probe: (signal) => transport.probe(signal),
    async complete(body, signal) {
      if (calls.length >= maxCalls) throw new Error("Synthetic cell model-call budget exhausted");
      const call = { request: structuredClone(body), startedAt: new Date().toISOString() };
      calls.push(call);
      try { call.response = await transport.complete(body, signal); return call.response; }
      catch (error) { call.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { call.finishedAt = new Date().toISOString(); }
    },
  };
}

export function reviewRequest(scenario, context) {
  const persona = PERSONAS.find((entry) => entry.id === scenario.residentId);
  if (!persona) throw new Error("Missing synthetic fixture persona");
  const expected = scenario.requestTurnIndexes?.includes(0) === true;
  return {
    kind: "public", channelId: scenario.room, channelName: scenario.room, selected: [persona],
    history: (scenario.history ?? []).map((row) => ({ ...row, createdAt: new Date(FIXED_NOW - 30_000).toISOString() })),
    trigger: { authorId: context.subjectId, authorKind: "human", author: context.subjectName,
      content: scenario.turns[0], messageId: `${scenario.id}-review-turn`, createdAt: new Date(FIXED_NOW).toISOString() },
    mustReplyIds: [persona.id], responseRecoveryIds: [persona.id], requestOwnerIds: expected ? [persona.id] : [],
    relationshipNotes: context.phase1Note ? { [persona.id]: context.phase1Note } : {}, languageHint: scenario.language,
    semanticContext: { languageTag: scenario.language, intentTrusted: true, replyExpected: expected ? "expected" : "optional",
      answerDepth: "normal", asksForList: scenario.id === "en-film-picks", asksAboutAiIdentity: false, asksAboutAcoustics: false },
    temporalPolicy: "reactive_only",
  };
}

export async function evaluateReview({ scenario, content, expected, transport, maxCalls, model }) {
  const context = fixtureContext(scenario);
  const trace = [];
  try {
    const client = new LmStudioClient({ backend: traceTransport(transport, trace, maxCalls), now: () => FIXED_NOW,
      communityTimeZone: "Europe/Stockholm", maxConcurrentPredictions: 1, maxBackgroundPredictions: 1 });
    const request = reviewRequest(scenario, context);
    // Exercise the exact production reviewer independently of generation so
    // false positives and missed non-delivery cannot hide behind better drafts.
    const reviews = await client.reviewCandidateLines(request, [{ personaId: scenario.residentId, content, sourceIds: [] }], model, AbortSignal.timeout(90_000));
    return { scenarioId: scenario.id, mode: "review", expected, content, request,
      reviews: reviews ? Object.fromEntries(reviews) : null, trace };
  } finally { context.close(); }
}

const option = (args, name, fallback) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const bounded = (args, name, fallback, maximum) => {
  const result = Number(option(args, name, fallback));
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return result;
};
export function selectScenarios(args) {
  const ids = option(args, "--scenarios", "").split(",").filter(Boolean);
  const available = [...scenarios, ...reviewRegressionScenarios];
  if (ids.length && (new Set(ids).size !== ids.length || ids.some((id) => !available.some((item) => item.id === id)))) throw new Error("Unknown or repeated scenario");
  return ids.length ? available.filter((item) => ids.includes(item.id)) : args.includes("--correctness-regression") ? available : scenarios;
}
export async function main(args = process.argv.slice(2)) {
  const samples = bounded(args, "--samples", 2, 3);
  const concurrency = bounded(args, "--concurrency", 2, 2);
  const maxCalls = bounded(args, "--max-calls", 12, 24);
  const label = option(args, "--label", "current");
  const mode = option(args, "--mode", "all");
  if (!["all", "generation", "review"].includes(mode)) throw new Error("--mode must be all, generation or review");
  const selected = selectScenarios(args);
  if (mode === "generation" && selected.every((scenario) => scenario.category === "review-regression")) {
    throw new Error("Correctness regression fixtures are review-only");
  }
  if (args.includes("--list") || args.includes("--dry-run")) {
    const manifest = selected.map(({ id, category, language, question, turns, goodDraft, badDraft }) => ({ id, category, language, question, turns,
      directReviewCases: Number(Boolean(goodDraft)) + Number(Boolean(badDraft)) }));
    console.log(JSON.stringify({ samples, concurrency, mode, scenarios: manifest }, null, 2));
    return;
  }
  process.env.CANDIDATE_REVIEW_ENABLED = "true";
  const transport = new LmStudioBackend();
  const health = await transport.probe(AbortSignal.timeout(8_000));
  if (!health.connected || !health.id) throw new Error("LM Studio unavailable; no server or alternate provider will be started");
  const requested = option(args, "--output", "");
  const output = requested ? resolve(requested) : await mkdtemp(join(tmpdir(), "third-place-commitments-"));
  if (![resolve(tmpdir()), "/tmp", "/private/tmp"].some((root) => { const child = relative(root, output); return child && !child.startsWith("..") && !isAbsolute(child); })) throw new Error("Reports must be below the system temp directory");
  if (requested) await mkdir(output); // Existing paths fail: baseline evidence must be immutable.
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim();
  const jobs = selected.flatMap((scenario) => Array.from({ length: samples }, (_, i) => [
    ...(mode === "review" || scenario.category === "review-regression" ? [] : [{ scenario, mode: "generation", sample: i + 1 }]),
    ...(mode === "generation" ? [] : [
      ...(scenario.goodDraft ? [{ scenario, mode: "review", sample: i + 1, expected: "accept", content: scenario.goodDraft }] : []),
      ...(scenario.badDraft ? [{ scenario, mode: "review", sample: i + 1, expected: scenario.badDraftExpected ?? "reject_non_delivery", content: scenario.badDraft }] : []),
    ]),
  ]).flat());
  if (!jobs.length) throw new Error("Selected fixtures have no jobs in this mode; correctness regressions are review-only");
  const report = { label, revision, dirty, model: health.id, startedAt: new Date().toISOString(), samples, concurrency,
    limitations: ["Synthetic in-memory identities only; no server, persisted memory or accounts are touched.",
      "Fixture-owned intent isolates generation and review; this does not test semantic routing or scheduling.",
      "Full request/response traces may contain only these synthetic fixture notes and repository persona prompts.",
      "Judgements require reading full replies; no wording heuristic or automatic quality score is used.",
      "Direct review invokes the existing production reviewer independently; it is not a replacement review prompt."], cells: [] };
  let cursor = 0;
  console.log(`Commitment live evaluation ${label}: ${jobs.length} cells; ${output}`);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      let cell;
      if (job.mode === "review") cell = await evaluateReview({ ...job, transport, maxCalls, model: health.id });
      else {
        const trace = [];
        cell = { ...await evaluateCell({ scenario: job.scenario, variant: "phase1", sample: job.sample,
          transport: traceTransport(transport, trace, maxCalls), maxCalls }), mode: "generation", trace };
      }
      cell.sample = job.sample;
      report.cells.push(cell);
      const name = `${job.scenario.id}-${job.mode}-${job.expected ?? "generated"}-${job.sample}.json`;
      await writeFile(join(output, name), JSON.stringify(cell, null, 2), { flag: "wx" });
      console.log(`Completed ${name}`);
    }
  }));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, cells: report.cells.length, revision, model: health.id }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
