#!/usr/bin/env node

// Real timers + real local model, isolated from HTTP, real users and app data.
// node --env-file=.env --import tsx scripts/director-live-smoke.mjs
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ActorChannelRuntime } from "../server/actorChannels.ts";
import { DEFAULT_RUNTIME_BEHAVIOR_TUNING } from "../server/behaviorTuning.ts";
import { SocialDirector } from "../server/director.ts";
import { HumanMemoryStore } from "../server/humanMemory.ts";
import { LmStudioClient } from "../server/lmStudio.ts";
import { LmStudioBackend } from "../server/lmStudioBackend.ts";
import { PERSONAS } from "../server/personas.ts";
import { RoomStore } from "../server/store.ts";

const directory = await mkdtemp("/tmp/third-place-director-smoke-");
const enabledRooms = new Set(["the-pub", "ai-programming", "fnaf"]);
const startedAt = performance.now();
const elapsedMs = () => Math.round(performance.now() - startedAt);
const behaviorTuningProvider = (channelId) => ({
  ...DEFAULT_RUNTIME_BEHAVIOR_TUNING,
  activity: !channelId || enabledRooms.has(channelId) ? 50 : 0,
  autonomousLinkFrequency: 0,
});
const publications = [];
const attempts = [];
const calls = [];
const events = [];
const warnings = [];
const samples = [];
const pendingGenerations = new Set();
let researchCalls = 0;
let stopReason = "time_budget";
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
const originalWarn = console.warn;
console.warn = (...args) => {
  warnings.push({ elapsedMs: elapsedMs(), text: args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(" ") });
  originalWarn(...args);
};

const transport = new LmStudioBackend();
const backend = {
  providerId: transport.providerId,
  configuredModel: transport.configuredModel,
  probe: (signal) => transport.probe(signal),
  async complete(body, signal) {
    const call = { startedMs: elapsedMs(), schema: body.response_format?.json_schema?.name ?? null };
    calls.push(call);
    try {
      const result = await transport.complete(body, signal);
      call.finishReason = result?.choices?.[0]?.finish_reason;
      call.content = result?.choices?.[0]?.message?.content ?? null;
      call.usage = result?.usage;
      return result;
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { call.finishedMs = elapsedMs(); }
  },
};
const lm = new LmStudioClient({ backend, behaviorTuningProvider });
const health = await lm.probe();
if (!health.connected) throw new Error(`Model unavailable: ${health.label}`);
const generateScene = lm.generateScene.bind(lm);
lm.generateScene = (request, ...args) => {
  const attempt = {
    startedMs: elapsedMs(), channelId: request.channelId, kind: request.kind,
    phase: request.conversationContext?.phase,
    selected: request.selected.map((persona) => persona.id),
  };
  attempts.push(attempt);
  const promise = generateScene(request, ...args).then((lines) => {
    attempt.lines = lines;
    attempt.outcome = lines.length ? "reviewed_lines" : "empty_or_rejected";
    return lines;
  }, (error) => {
    attempt.outcome = "execution_error";
    attempt.error = error instanceof Error ? error.message : String(error);
    throw error;
  }).finally(() => {
    attempt.finishedMs = elapsedMs();
    pendingGenerations.delete(promise);
  });
  pendingGenerations.add(promise);
  return promise;
};
const store = new RoomStore(join(directory, "rooms.json"));
// load() intentionally seeds demo dialogue for a fresh installation. For this
// empty-room experiment use the real store's empty constructor and persist it.
await store.flush();
const humanMemory = new HumanMemoryStore({ filePath: join(directory, "humans.json") });
await humanMemory.load();
const actorChannels = new ActorChannelRuntime();
const forbiddenResearch = async () => { researchCalls += 1; throw new Error("Research is disabled in the isolated scheduler smoke"); };
const io = { to: (room) => ({ emit: (event, payload) => {
  if (event === "director:event") events.push({ elapsedMs: elapsedMs(), room, payload });
} }) };
const director = new SocialDirector(
  io, store, lm, actorChannels,
  { research: forbiddenResearch, researchSite: forbiddenResearch },
  humanMemory, () => PERSONAS, () => 0,
  {
    behaviorTuningProvider,
    autonomousResearchEnabled: false,
    autoSharedLinkDiscussionEnabled: false,
    weatherForecastProvider: null,
    marketSnapshotProvider: null,
    footballCompetitionProvider: null,
    marketPulseCoordinator: null,
    onPublicMessagePublished: (message) => {
      const row = { elapsedMs: elapsedMs(), ...message };
      publications.push(row);
      const name = PERSONAS.find((persona) => persona.id === message.authorId)?.name ?? message.authorId;
      console.log(`[+${(row.elapsedMs / 1_000).toFixed(1)}s #${message.channelId}] ${name}: ${message.content}`);
      if (!enabledRooms.has(message.channelId)) { stopReason = "disabled_room_publication"; finish(); }
      else if (publications.length >= 24) { stopReason = "publication_budget"; finish(); }
    },
  },
);
const snapshot = () => ({
  elapsedMs: elapsedMs(), publications: publications.length,
  rooms: Object.fromEntries([...enabledRooms].map((id) => [id, publications.filter((row) => row.channelId === id).length])),
  health: lm.health(),
});
console.log(`Real director timer smoke: 0 humans; 3 rooms at activity50; research disabled. ${directory}`);
const deadline = setTimeout(finish, 180_000);
const statusTimer = setInterval(() => {
  const sample = snapshot();
  samples.push(sample);
  console.log(`Progress: ${JSON.stringify(sample)}`);
}, 15_000);
const stopFromSignal = () => { stopReason = "interrupted"; finish(); };
process.once("SIGINT", stopFromSignal);
process.once("SIGTERM", stopFromSignal);
try {
  director.start();
  await finished;
} finally {
  director.stop();
  clearTimeout(deadline);
  clearInterval(statusTimer);
  lm.cancelPending("Isolated live smoke completed");
  await Promise.allSettled([...pendingGenerations]);
  // Let already-scheduled short reaction callbacks observe the stopped guard.
  await delay(2_700);
  await Promise.all([store.flush(), humanMemory.flush()]);
  process.removeListener("SIGINT", stopFromSignal);
  process.removeListener("SIGTERM", stopFromSignal);
  console.warn = originalWarn;
}
const report = {
  generatedAt: new Date().toISOString(), model: health.id, stopReason,
  connectedHumans: 0, initialMessages: 0, researchCalls,
  final: snapshot(), publications, attempts, calls, events, warnings, samples,
};
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(`Report: ${join(directory, "report.json")}`);
if (researchCalls || stopReason === "disabled_room_publication" || lm.health().queueDepth) process.exitCode = 1;
