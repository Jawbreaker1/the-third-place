import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { PERSONAS } from "./personas.js";
import {
  addressedPersonaIds,
  ambientConversationPremise,
  ambientLanguageHint,
  ambientSceneWordLimits,
  analyzeSocialSignals,
  consideredConversationLeadPremise,
  consideredConversationPremise,
  consideredConversationResponsePremise,
  ensureEvidenceResponder,
  normalizeGeneratedMessageContent,
  selectAmbientLead,
  selectConsideredConversation,
  selectResponders,
  SocialDirector,
  shouldRejectPublicCandidate,
  shouldStartConsideredConversation,
  sourceIdsForPageResponder,
  trailingAiMessageCount,
  type ConsideredConversationGate,
} from "./director.js";

describe("social director", () => {
  it("keeps mentions while reserving one bounded slot for a capable evidence reader", () => {
    const researcher = PERSONAS.find((persona) => persona.canResearch)!;
    const nonResearchers = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 3);
    const result = ensureEvidenceResponder(
      nonResearchers,
      [researcher, ...nonResearchers],
      [nonResearchers[0]!.id],
      new Map([[researcher.id, 1]]),
    );
    expect(result.selected).toHaveLength(3);
    expect(result.selected.map((persona) => persona.id)).toContain(nonResearchers[0]!.id);
    expect(result.selected.map((persona) => persona.id)).toContain(researcher.id);
    expect(result.responder?.id).toBe(researcher.id);
  });

  it("can designate a mentioned resident for a supplied page when all three slots are mentioned", () => {
    const mentioned = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 3);
    const result = ensureEvidenceResponder(mentioned, mentioned, mentioned.map((persona) => persona.id), new Map(), false);
    expect(result.selected).toEqual(mentioned);
    expect(result.responder?.id).toBe(mentioned[0]?.id);
  });

  it("guarantees the validated page source on the designated generated answer only", () => {
    const pageResearch = {
      kind: "page" as const,
      query: "read it",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S1", title: "Example", url: "https://example.com", snippet: "evidence" }],
    };
    expect(sourceIdsForPageResponder(pageResearch, [], true)).toEqual(["S1"]);
    expect(sourceIdsForPageResponder(pageResearch, ["S1"], true)).toEqual(["S1"]);
    expect(sourceIdsForPageResponder(pageResearch, [], false)).toEqual([]);
    expect(sourceIdsForPageResponder(pageResearch, ["S1"], false)).toEqual([]);
    expect(sourceIdsForPageResponder({ ...pageResearch, kind: "search" }, [], true)).toEqual([]);
  });

  it("always prioritises a directly mentioned quiet resident", () => {
    const signals = analyzeSocialSignals("@moss what do you think about this?");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(selected.map((persona) => persona.id)).toContain("ai-moss");
  });

  it("treats a Discord reply to an AI resident as direct address even outside their roster", () => {
    expect(addressedPersonaIds([], { authorId: "ai-kim" })).toEqual(["ai-kim"]);
    expect(addressedPersonaIds(["ai-sana"], { authorId: "ai-kim" })).toEqual(["ai-sana", "ai-kim"]);
    expect(addressedPersonaIds([], { authorId: "human-johan" })).toEqual([]);
    expect(addressedPersonaIds([], { authorId: "ai-kim", system: true })).toEqual([]);
  });

  it("recognises high-energy absurd messages", () => {
    const signals = analyzeSocialSignals("HEAR ME OUT!!! what if the banana runs the server? 🤯🤯");
    expect(signals.absurdity).toBeGreaterThan(0.4);
    expect(signals.energy).toBeGreaterThan(0.5);
  });

  it("measures an uninterrupted autonomous tail without letting room notices reset it", () => {
    const history = [
      { authorId: "human-johan" },
      { authorId: "ai-sana" },
      { authorId: "room", system: true },
      { authorId: "ai-vale" },
    ];
    expect(trailingAiMessageCount(history)).toBe(2);
    expect(trailingAiMessageCount([...history, { authorId: "human-friend" }])).toBe(0);
  });

  it("anchors autonomous language to the latest human-authored message", () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    const oldHuman = {
      id: "old",
      authorId: "human-old",
      content: "old thought",
      createdAt: new Date(now - 31 * 60_000).toISOString(),
    };
    const freshHuman = {
      id: "fresh",
      authorId: "human-johan",
      content: "hur skulle ni lösa det här?",
      createdAt: new Date(now - 60_000).toISOString(),
    };
    const aiTail = {
      id: "ai-tail",
      authorId: "ai-sana",
      content: "en tidigare replik",
      createdAt: new Date(now - 30_000).toISOString(),
    };
    expect(ambientLanguageHint([oldHuman, freshHuman, aiTail])).toBe("Swedish");
  });

  it("chooses a room-relevant lead over the loudest generic resident", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-bosse", "ai-sana"].includes(persona.id));
    const lead = selectAmbientLead(candidates, (id) => (id === "ai-sana" ? 1 : 0), () => 0);
    expect(lead?.id).toBe("ai-sana");
  });

  it("rotates among the strongest room-relevant leads instead of crowning one permanent host", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-pixel", "ai-bosse", "ai-juno"].includes(persona.id));
    const affinities = new Map([
      ["ai-pixel", 0.95],
      ["ai-bosse", 0.86],
      ["ai-juno", 0.84],
    ]);
    const leads = [0.05, 0.55, 0.95].map((roll) =>
      selectAmbientLead(candidates, (id) => affinities.get(id) ?? 0, () => roll)?.id,
    );
    expect(new Set(leads).size).toBeGreaterThan(1);
    expect(leads).not.toContain(undefined);
  });

  it("turns a concrete seed into a bounded claim-and-response contract", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-sana")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-vale")!;
    const seed = "Fail-silent background agents create more trust than canned fallback chatter.";
    const premise = ambientConversationPremise(seed, lead, responder, false, true);
    const limits = ambientSceneWordLimits(lead, responder, false);
    expect(premise).toContain(seed);
    expect(premise).toContain("specific, defensible claim");
    expect(premise).toContain("counterexample or hidden cost");
    expect(premise).toContain("Exactly the selected residents speak in order");
    expect(limits[lead.id]).toEqual({ minimum: 16, maximum: lead.style.hardMaxWords });
    expect(limits[responder.id]).toEqual({ minimum: 8, maximum: 28 });
  });

  it("keeps autonomous rooms silent when the model is offline or returns no valid lines", async () => {
    const runCase = async (
      connected: boolean,
      recentMessages: Array<Record<string, unknown>> = [],
      knownHumanChannel = false,
    ) => {
      const emit = vi.fn();
      const io = { to: vi.fn(() => ({ emit })) };
      const store = {
        getRecent: vi.fn(() => recentMessages),
        addPublicMessage: vi.fn(),
      };
      const lm = {
        health: vi.fn(() => ({ connected, queueDepth: 0, label: connected ? "Gemma" : "offline" })),
        generateScene: vi.fn(async () => []),
      };
      const director = new SocialDirector(
        io as never,
        store as never,
        lm as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        { rng: () => 0, now: () => 2_000_000, consideredConversationChance: 0 },
      );
      if (knownHumanChannel) {
        (director as unknown as { lastHumanMessageAtByChannel: Map<string, number> })
          .lastHumanMessageAtByChannel.set("lobby", 1_900_000);
      }
      await (director as unknown as { runAmbient: () => Promise<void> }).runAmbient();
      director.stop();
      return { store, lm };
    };

    const offline = await runCase(false);
    const empty = await runCase(true);
    const freshRestartTail = await runCase(true, [{
      id: "recent-ai",
      channelId: "lobby",
      authorId: "ai-sana",
      content: "one prior autonomous line",
      createdAt: new Date(1_970_000).toISOString(),
      reactions: [],
    }]);
    const humanTriggeredTail = await runCase(true, [{
      id: "human-triggered-ai",
      channelId: "lobby",
      authorId: "ai-sana",
      content: "a reply caused by a known human message",
      createdAt: new Date(1_970_000).toISOString(),
      reactions: [],
    }], true);
    expect(offline.lm.generateScene).not.toHaveBeenCalled();
    expect(offline.store.addPublicMessage).not.toHaveBeenCalled();
    expect(empty.lm.generateScene).toHaveBeenCalledTimes(1);
    expect(empty.store.addPublicMessage).not.toHaveBeenCalled();
    expect(freshRestartTail.lm.generateScene).not.toHaveBeenCalled();
    expect(freshRestartTail.store.addPublicMessage).not.toHaveBeenCalled();
    expect(humanTriggeredTail.lm.generateScene).toHaveBeenCalledTimes(1);
    expect(humanTriggeredTail.store.addPublicMessage).not.toHaveBeenCalled();
  });

  it("does not recruit the moderator for ordinary banter", () => {
    const signals = analyzeSocialSignals("pineapple pizza is obviously the best");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.5);
    expect(selected.map((persona) => persona.id)).not.toContain("ai-runa");
  });

  it("does not confuse names with substrings", () => {
    expect(analyzeSocialSignals("det här är en beautiful idé").mentionedIds).not.toContain("ai-bea");
    expect(analyzeSocialSignals("vad tycker ni om valet?").mentionedIds).not.toContain("ai-vale");
    expect(analyzeSocialSignals("Vale, vad tycker du?").mentionedIds).toContain("ai-vale");
  });

  it("routes a single clear attack to the moderator", () => {
    const signals = analyzeSocialSignals("du är en idiot");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(signals.aggression).toBeGreaterThanOrEqual(0.4);
    expect(selected.map((persona) => persona.id)).toEqual(["ai-runa"]);
  });

  it("treats a single absolute claim as dissent-worthy without substring false positives", () => {
    expect(analyzeSocialSignals("Gemma är bäst").claimStrength).toBeGreaterThan(0.28);
    expect(analyzeSocialSignals("min beställning kom idag").claimStrength).toBeLessThan(0.28);
  });

  it("opens a considered beat only on the rare roll after quiet and cooldown", () => {
    const now = 2_000_000;
    const base: ConsideredConversationGate = {
      now,
      lastStartedAt: now - 600_000,
      lastHumanActivityAt: now - 75_000,
      cooldownMs: 600_000,
      humanQuietMs: 75_000,
      chance: 0.1,
      queueDepth: 0,
      availableMessageSlots: 2,
      voiceRoomActive: false,
      alreadyInFlight: false,
      rng: () => 0.099,
    };

    expect(shouldStartConsideredConversation(base)).toBe(true);
    expect(shouldStartConsideredConversation({ ...base, rng: () => 0.1 })).toBe(false);
  });

  it("blocks considered beats before rolling when people, voice, queue, spam limits or another beat intervene", () => {
    const now = 2_000_000;
    let rolls = 0;
    const base: ConsideredConversationGate = {
      now,
      lastStartedAt: now - 600_000,
      lastHumanActivityAt: now - 75_000,
      cooldownMs: 600_000,
      humanQuietMs: 75_000,
      chance: 1,
      queueDepth: 0,
      availableMessageSlots: 2,
      voiceRoomActive: false,
      alreadyInFlight: false,
      rng: () => {
        rolls += 1;
        return 0;
      },
    };
    const blocked: Partial<ConsideredConversationGate>[] = [
      { voiceRoomActive: true },
      { alreadyInFlight: true },
      { queueDepth: 1 },
      { availableMessageSlots: 1 },
      { lastStartedAt: now - 599_999 },
      { lastHumanActivityAt: now - 74_999 },
    ];

    for (const override of blocked) {
      expect(shouldStartConsideredConversation({ ...base, ...override })).toBe(false);
    }
    expect(rolls).toBe(0);
  });

  it("pairs distinct relevant residents and gives the responder a non-echo role", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-sana", "ai-vale", "ai-mira"].includes(persona.id));
    const affinities = new Map([
      ["ai-sana", 0.95],
      ["ai-vale", 0.8],
      ["ai-mira", 0.7],
    ]);
    const plan = selectConsideredConversation(candidates, new Map(), 2_000_000, (id) => affinities.get(id) ?? 0, () => 0);

    expect(plan?.lead.id).toBe("ai-sana");
    expect(plan?.responder.id).toBe("ai-vale");
    expect(plan?.responseRole).toBe("challenge");
    expect(plan?.lead.id).not.toBe(plan?.responder.id);
    const challengePremise = consideredConversationPremise(plan!);
    const anchoredPremise = consideredConversationPremise(plan!, "A deterministic director should own pacing.");
    const leadPremise = consideredConversationLeadPremise(plan!, "A deterministic director should own pacing.");
    const responsePremise = consideredConversationResponsePremise(plan!);
    const examplePremise = consideredConversationPremise({ ...plan!, responseRole: "example" });
    const questionPremise = consideredConversationPremise({ ...plan!, responseRole: "question" });
    expect(challengePremise).toContain("45–75-word post");
    expect(challengePremise).toContain("8–28 words");
    expect(examplePremise).toContain("8–28 words");
    expect(questionPremise).toContain("8–24 words");
    expect([challengePremise, examplePremise, questionPremise].join(" ")).not.toContain("12–35 words");
    expect(challengePremise).toContain("hidden assumption");
    expect(challengePremise).toContain("nobody piles on");
    expect(anchoredPremise).toContain("A deterministic director should own pacing.");
    expect(leadPremise).toContain("Only Sana speaks in this generation");
    expect(responsePremise).toContain("Respond directly to Sana's latest transcript line");
    expect(responsePremise).toContain("Only Vale speaks in this generation");
  });

  it("does not recruit a relevant resident who is still cooling down", () => {
    const now = 2_000_000;
    const candidates = PERSONAS.filter((persona) => ["ai-sana", "ai-vale", "ai-mira"].includes(persona.id));
    const plan = selectConsideredConversation(
      candidates,
      new Map([["ai-vale", now - 1_000]]),
      now,
      (id) => (id === "ai-sana" ? 0.95 : id === "ai-vale" ? 0.8 : 0.7),
      () => 0,
    );

    expect(plan?.lead.id).toBe("ai-sana");
    expect(plan?.responder.id).toBe("ai-mira");
    expect(plan?.responseRole).toBe("question");
  });

  it("rejects exact channel duplicates and high-severity repetition of the same persona", () => {
    const exactPeerHistory = [
      { channelId: "ai-programming", authorId: "ai-vale", content: "samma lilla tanke" },
    ];
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Samma lilla tanke!",
      history: exactPeerHistory,
    })).toBe(true);

    const ownHistory = [
      {
        channelId: "ai-programming",
        authorId: "ai-sana",
        content: "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.",
      },
    ];
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Jag tror faktiskt att en liten TURN-server löser nog det här för de flesta användare.",
      history: ownHistory,
    })).toBe(true);
  });

  it("allows medium self-similarity and near repetition of a peer", () => {
    const prior = "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.";
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "En liten TURN-server löser nog det här för de flesta användare.",
      history: [{ channelId: "ai-programming", authorId: "ai-sana", content: prior }],
    })).toBe(false);

    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Jag tror faktiskt att en liten TURN-server löser nog det här för de flesta användare.",
      history: [{ channelId: "ai-programming", authorId: "ai-vale", content: prior }],
    })).toBe(false);
  });

  it("keeps short natural replies and shared technical vocabulary publishable", () => {
    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-mira",
      content: "haha ja exakt",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "haha exakt" }],
    })).toBe(false);

    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "WebRTC behöver ofta TURN bakom restriktiv NAT, medan ngrok bara bär signaleringen.",
      history: [
        {
          channelId: "ai-programming",
          authorId: "ai-sana",
          content: "WebRTC använder ICE-kandidater för att hitta en fungerande väg mellan webbläsarna.",
        },
        {
          channelId: "ai-programming",
          authorId: "ai-sana",
          content: "En TURN-server reläar media när direkt P2P blockeras av nätet.",
        },
      ],
    })).toBe(false);
  });

  it("preserves technical fragments and intentional line breaks through publication cleanup", () => {
    const input = "Testa i den här ordningen:\n1. Kör `npm test`\n2. Läs https://example.com/docs.\n```ts\nconst x = 1;\n```";
    expect(normalizeGeneratedMessageContent(input)).toBe(input);
  });

  it("removes standalone model-written source tokens in common punctuation forms", () => {
    const cleaned = normalizeGeneratedMessageContent("[S1]: svar\n[S2]; mer\n[S3]-slut\n`[S4]` kod");
    expect(cleaned).not.toMatch(/\[S\d+\]/u);
    expect(cleaned).toContain("svar");
    expect(cleaned).toContain("mer");
    expect(normalizeGeneratedMessageContent("Läs https://example.com/[S1]/docs")).toContain("https://example.com/[S1]/docs");
  });

  it("rejects an overlong generated message atomically instead of cutting a URL", () => {
    const longUrl = `https://example.com/${"a".repeat(520)}`;
    expect(normalizeGeneratedMessageContent(`läs ${longUrl}`)).toBeUndefined();
  });
});
