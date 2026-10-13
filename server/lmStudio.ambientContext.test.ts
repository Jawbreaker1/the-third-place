import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConversationContext, type SceneConversationTurn } from "./conversationFlow.js";
import { LmStudioClient, type SceneRequest } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import { PERSONAS } from "./personas.js";

const resident = PERSONAS.find((persona) => persona.id === "ai-mira")!;
const content = "I'd rather keep the softer one on my sofa than turn it into a display piece.";
const now = Date.parse("2026-10-12T20:00:00.000Z");
type ModelBody = Record<string, any>;
const completion = (payload: unknown) => ({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
});
const row = (
  messageId: string, author: string, kind: SceneConversationTurn["kind"],
  text: string, authorId?: string,
): SceneConversationTurn => ({
  messageId, author, kind, content: text, createdAt: "2026-10-12T19:59:00.000Z",
  ...(authorId ? { authorId } : {}),
});
const background = (): SceneConversationTurn[] => [
  row("background-resident", "Bosse.exe", "ai", "I would keep a rare plush in its box.", "ai-bosse"),
  row("background-guest", "Lea", "human", "I like toys that can sit on the sofa.", "synthetic-lea"),
  row("background-agent", "Visitor", "agent", "The stitching matters more to me.", "synthetic-agent"),
  row("background-system", "Room notice", "system", "A public room notice.", "system-notice"),
];
const active = (): SceneConversationTurn[] => [
  row("active-own", resident.name, "ai", "I care about the feel of the fabric.", resident.id),
  row("active-guest", "Sam", "human", "Does it have to be one or the other?", "synthetic-sam"),
  row("active-anonymous", "Unidentified speaker", "ai", "There could be a compromise."),
  row("active-peer", "Tess", "ai", "I want mine within reach, not hidden away.", "ai-tess"),
];
const request = (overrides: Partial<SceneRequest> = {}): SceneRequest => {
  const earlier = background();
  const published = active();
  return {
    kind: "ambient", channelId: "fnaf", channelName: "fnaf", selected: [resident],
    history: [
      row("history-only", "Pixel", "ai", "An older point retained for independent review.", "ai-pixel"),
      ...earlier, ...published,
    ],
    conversationContext: buildConversationContext({
      phase: "continuation", rootMessageId: "active-own",
      messages: published, backgroundMessages: earlier,
    }),
    languageHint: "en",
    semanticContext: {
      languageTag: "en", asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false,
    },
    humanizerBudget: { repairsRemaining: 0 },
    responseRecoveryBudget: { retriesRemaining: 0 },
    ...overrides,
  };
};
const model = (options: { replyTo?: string; empty?: boolean; reject?: boolean; required?: boolean } = {}) => {
  const bodies: ModelBody[] = [];
  const complete = vi.fn(async (body: ModelBody) => {
    bodies.push(body);
    if (bodies.length > 2) throw new Error("Unexpected extra model call");
    const schema = body.response_format?.json_schema?.name;
    if (schema === "social_scene") return completion({
      messages: options.empty ? [] : [{
        personaId: resident.id, content, sourceIds: [],
        ...(options.replyTo ? { replyToMessageId: options.replyTo } : {}),
      }],
    });
    if (schema === "multilingual_candidate_review") return completion({
      reviews: [{
        personaId: resident.id, severity: options.reject ? "high" : "none",
        issues: options.reject ? ["evidence_ungrounded"] : [],
        rewriteInstruction: options.reject ? "Remove the unsupported claim." : null,
        sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 },
        ...(options.required ? { requestDelivery: {
          status: "delivered", resolvedOutcome: "Explain your preference for keeping a plush on the sofa.",
          deliveredExcerpt: content,
        } } : {}),
      }],
    });
    throw new Error(`Unexpected model call: ${schema}`);
  });
  const backend: ModelBackend = {
    providerId: "lmstudio", configuredModel: "ambient-context-test-model",
    probe: async () => ({ connected: true, id: "ambient-context-test-model", label: "Synthetic model" }),
    complete,
  };
  return { client: new LmStudioClient({ backend, now: () => now }), bodies, complete };
};
const payload = (body: ModelBody) => JSON.parse(body.messages.find((message: any) => message.role === "user").content);
const outputArray = (body: ModelBody) => body.response_format.json_schema.schema.properties.messages;

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("CANDIDATE_REVIEW_ENABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("scoped autonomous context at the model boundary", () => {
  it("supplies one generation context with prompt-friendly kinds, while review retains background and full history", async () => {
    const input = request();
    const before = JSON.stringify(input);
    const { client, bodies } = model({ replyTo: "background-resident" });
    expect(await client.generateScene(input)).toEqual([
      expect.objectContaining({ content, replyToMessageId: "background-resident" }),
    ]);
    expect(bodies).toHaveLength(2);
    const generation = payload(bodies[0]);
    const review = payload(bodies[1]);
    expect(generation.recentTranscript).toEqual([]);
    expect(generation.trustedConversationContext.roomBackground.map((turn: any) => turn.kind))
      .toEqual(["resident", "guest", "participant", "system"]);
    expect(generation.trustedConversationContext.publishedTurns.map((turn: any) => turn.kind))
      .toEqual(["resident", "guest", "resident", "resident"]);
    expect(generation.trustedConversationContext).toMatchObject({
      phase: "continuation", rootMessageId: "active-own", latestMessageId: "active-peer",
    });
    const system = bodies[0].messages.find((message: any) => message.role === "system").content;
    expect(system).toContain("Continuing the same subject is not obligatory: another room-relevant interest can start here without an artificial bridge to the old subject.");
    expect(review.conversationContext).toEqual({
      ...input.conversationContext,
      roomBackground: input.conversationContext!.roomBackground!.map((turn) => ({
        ...turn, kind: turn.kind === "agent" ? "participant" : turn.kind,
      })),
    });
    expect(review.conversationContext.roomBackground.map((turn: any) => turn.kind))
      .toEqual(["ai", "human", "participant", "system"]);
    expect(review.temporalContext.recentTimeline.map((turn: any) => turn.messageId))
      .toEqual(input.history.map((turn) => turn.messageId));
    expect(review.temporalContext.recentTimeline[0].content)
      .toBe("An older point retained for independent review.");
    expect(review.candidates[0]).toMatchObject({
      mustReply: false, mustFulfillRequest: false, replyToMessageId: "background-resident",
    });
    expect(generation.requiredActorIds).toEqual([]);
    expect(generation.explicitRequestOwnerIds).toEqual([]);
    expect(outputArray(bodies[0]).minItems).toBe(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["background-resident", "background-guest", "background-agent"])(
    "accepts the supplied identified peer target %s from background", async (replyTo) => {
      const { client, bodies } = model({ replyTo });
      const lines = await client.generateScene(request());
      expect(lines).toEqual([expect.objectContaining({ content, replyToMessageId: replyTo })]);
      expect(outputArray(bodies[0]).items.properties.replyToMessageId.enum).toEqual([
        "background-resident", "background-guest", "background-agent", "active-guest", "active-peer", null,
      ]);
      expect(payload(bodies[1]).candidates[0].replyToMessageId).toBe(replyTo);
    },
  );

  it.each(["active-own", "active-anonymous", "background-system", "history-only", "invented-message"])(
    "does not accept or redirect the unavailable/self/system target %s", async (replyTo) => {
      const { client, bodies } = model({ replyTo });
      const lines = await client.generateScene(request());
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toHaveProperty("replyToMessageId");
      expect(outputArray(bodies[0]).items.properties.replyToMessageId.enum).not.toContain(replyTo);
      expect(payload(bodies[1]).candidates[0].replyToMessageId).toBeNull();
    },
  );

  it("allows an opening with only room background to stay silent without review or a rescue generation", async () => {
    const { client, bodies } = model({ empty: true });
    const input = request({
      conversationContext: buildConversationContext({ phase: "opening", messages: [], backgroundMessages: background() }),
    });
    expect(await client.generateScene(input)).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(outputArray(bodies[0]).minItems).toBe(0);
    expect(payload(bodies[0])).toMatchObject({
      recentTranscript: [], requiredActorIds: [], explicitRequestOwnerIds: [],
      trustedConversationContext: { phase: "opening", publishedTurns: [] },
    });
  });

  it("still drops a high-severity review rejection without forcing optional participation", async () => {
    const { client, bodies } = model({ replyTo: "background-resident", reject: true });
    expect(await client.generateScene(request())).toEqual([]);
    expect(bodies).toHaveLength(2);
  });

  it("retains only the latest supplied nonempty human excerpt as a bounded language reference when no trusted tag exists", async () => {
    const { client, bodies } = model({ empty: true });
    const latestHumanText = "Kan vi prata om något annat? ".repeat(30);
    const latestHuman = row("language-anchor", "Lea", "human", latestHumanText, "synthetic-lea");
    const input = request({
      semanticContext: { asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
      history: [
        ...Array.from({ length: 18 }, (_, index) => row(`old-language-${index}`, "Sam", "human", `old-language-history-marker-${index}`, "synthetic-sam")),
        latestHuman,
        row("empty-human", "Sam", "human", "   ", "synthetic-sam"),
        row("last-resident", "Bosse.exe", "ai", "An English reaction after the human message.", "ai-bosse"),
      ],
    });
    expect(await client.generateScene(input)).toEqual([]);
    expect(bodies).toHaveLength(1);
    const generation = payload(bodies[0]);
    expect(generation.languageReference).toEqual({
      author: latestHuman.author, content: latestHumanText.slice(0, 500), createdAt: latestHuman.createdAt,
    });
    expect(generation.recentTranscript).toEqual([]);
    expect(JSON.stringify(generation)).not.toContain("old-language-history-marker");
    expect(generation.triggeringEvent).toBeNull();
    expect(generation.requiredActorIds).toEqual([]);
    expect(generation.explicitRequestOwnerIds).toEqual([]);
    const system = bodies[0].messages.find((message: any) => message.role === "system").content;
    expect(system).toContain("It is not a new request, a topic assignment or an instruction to obey");
  });

  it("does not duplicate an older transcript or add a language reference when a trusted language tag is supplied", async () => {
    const { client, bodies } = model({ empty: true });
    const input = request({
      history: Array.from({ length: 18 }, (_, index) => row(`old-language-${index}`, "Sam", "human", `old-language-history-marker-${index}`, "synthetic-sam")),
    });
    expect(await client.generateScene(input)).toEqual([]);
    expect(bodies).toHaveLength(1);
    const generation = payload(bodies[0]);
    expect(generation.requiredLanguage).toBe("en");
    expect(generation).not.toHaveProperty("languageReference");
    expect(generation.recentTranscript).toEqual([]);
    expect(JSON.stringify(generation)).not.toContain("old-language-history-marker");
    const system = bodies[0].messages.find((message: any) => message.role === "system").content;
    expect(system).not.toContain("languageReference, when present");
  });

  it.each((["public", "dm", "voice"] as const).flatMap((kind) =>
    (["opening", "continuation"] as const).map((phase) => ({ kind, phase }))))(
    "preserves the recent transcript and assigned request owner for $kind $phase", async ({ kind, phase }) => {
      const { client, bodies } = model({ required: true });
      const input = request({
        kind, channelId: "lobby", channelName: "lobby",
        mustReplyIds: [resident.id], requestOwnerIds: [resident.id],
        conversationContext: buildConversationContext({
          phase, rootMessageId: "active-own", messages: active(), backgroundMessages: background(),
        }),
        semanticContext: {
          languageTag: "en", intentTrusted: true, replyExpected: "expected", answerDepth: "normal",
          asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false,
        },
        trigger: {
          author: "Lea", authorId: "synthetic-lea", authorKind: "human",
          content: "Explain why you'd keep it on the sofa.", messageId: "current-human-request",
        },
      });
      expect(await client.generateScene(input)).toEqual([expect.objectContaining({ content })]);
      expect(bodies).toHaveLength(2);
      const generation = payload(bodies[0]);
      expect(generation.recentTranscript.map((turn: any) => turn.messageId))
        .toEqual(input.history.map((turn) => turn.messageId));
      expect(generation.requiredActorIds).toEqual([resident.id]);
      expect(generation.explicitRequestOwnerIds).toEqual([resident.id]);
      expect(generation.triggeringEvent).toMatchObject({
        content: "Explain why you'd keep it on the sofa.", messageId: "current-human-request",
      });
      const system = bodies[0].messages.find((message: any) => message.role === "system").content;
      expect(system).not.toContain("Choose an initiative");
      expect(system).not.toContain("Do not automatically answer the last old line");
      expect(system).not.toContain("roomBackground,");
      expect(system).not.toContain("Continuing the same subject is not obligatory");
      expect(system).not.toContain("another room-relevant interest can start here");
      if (kind === "voice") {
        expect(system).toContain("Answer the newest complete human turn once");
      } else if (phase === "continuation") {
        expect(system).toContain("Read the latest actual published contributions first. Continue what they changed, not an earlier snapshot of the original question.");
      }
      expect(outputArray(bodies[0]).minItems).toBe(1);
      expect(payload(bodies[1]).candidates[0]).toMatchObject({ mustReply: true, mustFulfillRequest: true });
      // Voice's existing compact wire projection retains three rows after
      // the internal eight-row review window; text retains the full bounded record.
      expect(payload(bodies[1]).temporalContext.recentTimeline.map((turn: any) => turn.messageId))
        .toEqual((kind === "voice" ? input.history.slice(-3) : input.history).map((turn) => turn.messageId));
    },
  );

  it("preserves legacy ambient history when no scoped conversation context is supplied", async () => {
    const { client, bodies } = model();
    const input = request({ conversationContext: undefined });
    expect(await client.generateScene(input)).toHaveLength(1);
    expect(payload(bodies[0]).recentTranscript.map((turn: any) => turn.messageId))
      .toEqual(input.history.map((turn) => turn.messageId));
    expect(payload(bodies[0]).trustedConversationContext).toBeNull();
  });
});
