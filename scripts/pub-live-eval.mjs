#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { deriveActiveRoomSocialMode, LmStudioClient } from "../server/lmStudio.ts";
import { PERSONAS } from "../server/personas.ts";

const jsonMode = process.argv.includes("--json");
const instant = "2026-07-17T21:30:00.000Z";
const byId = (id) => {
  const persona = PERSONAS.find((candidate) => candidate.id === id);
  if (!persona) throw new Error(`Unknown Pub eval persona: ${id}`);
  return persona;
};
const mira = byId("ai-mira");
const bosse = byId("ai-bosse");

const lm = new LmStudioClient({
  now: () => Date.parse(instant),
  communityTimeZone: "Europe/Stockholm",
});
const health = await lm.probe();
if (!health.connected) {
  const unavailable = { passed: false, unavailable: true, model: health.label, fixtures: [] };
  if (jsonMode) console.log(JSON.stringify(unavailable, null, 2));
  else console.error(`Pub live eval unavailable: ${health.label}.`);
  process.exitCode = 2;
} else {
  const humanToastRequest = {
    kind: "public",
    channelId: "the-pub",
    channelName: "the-pub",
    selected: [bosse],
    history: [],
    trigger: {
      author: "guest",
      content: "Skål Bosse. Jag öppnade en öl till slut — tar du en med mig?",
      messageId: "pub-eval-human-toast",
    },
    mustReplyIds: [bosse.id],
    languageHint: "Swedish",
    semanticContext: {
      languageTag: "sv",
      socialTrusted: true,
      warmth: 0.82,
      playfulness: 0.7,
      energy: 0.72,
      asksForList: false,
      asksAboutAiIdentity: false,
      asksAboutAcoustics: false,
    },
  };

  let lateRequest;
  let activeMode = null;
  for (let index = 0; index < 100 && !activeMode; index += 1) {
    lateRequest = {
      kind: "ambient",
      channelId: "the-pub",
      channelName: "the-pub",
      selected: [mira],
      history: [],
      mustReplyIds: [mira.id],
      languageHint: "Swedish",
      premise: `Late-table eval scene ${index}: make one fresh, concrete table-chat contribution. Do not explain the room or its mood.`,
      semanticContext: {
        languageTag: "sv",
        socialTrusted: true,
        warmth: 0.74,
        playfulness: 0.64,
        energy: 0.58,
        asksForList: false,
        asksAboutAiIdentity: false,
        asksAboutAcoustics: false,
      },
    };
    activeMode = deriveActiveRoomSocialMode(lateRequest, {
      localDate: "2026-07-17",
      localTime: "23:30:00",
    });
  }
  if (!lateRequest || !activeMode) throw new Error("Could not derive a deterministic late-table eval scene");

  const fixtures = [
    { id: "human-led-toast", request: humanToastRequest, expectedActorId: bosse.id, socialMode: null },
    { id: "late-table-move", request: lateRequest, expectedActorId: mira.id, socialMode: activeMode },
  ];
  const results = [];
  for (const fixture of fixtures) {
    const started = performance.now();
    let lines = [];
    let error = null;
    try {
      lines = await lm.generateScene(fixture.request);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const line = lines.find((candidate) => candidate.personaId === fixture.expectedActorId);
    results.push({
      id: fixture.id,
      passed: Boolean(line) && !error,
      durationMs: Math.round(performance.now() - started),
      socialMode: fixture.socialMode,
      line: line?.content ?? null,
      error,
    });
  }
  const report = {
    passed: results.every((fixture) => fixture.passed),
    unavailable: false,
    model: health.label,
    fixtures: results,
  };
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else {
    for (const fixture of results) {
      console.log(`${fixture.passed ? "PASS" : "FAIL"} ${fixture.id} (${fixture.durationMs} ms)`);
      if (fixture.socialMode) console.log(`  ${fixture.socialMode.surfaceActorId}: ${fixture.socialMode.socialMove}`);
      console.log(`  ${fixture.line ?? fixture.error ?? "no reviewed line survived"}`);
    }
  }
  if (!report.passed) process.exitCode = 1;
}
