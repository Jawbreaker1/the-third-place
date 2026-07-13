import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";
import {
  analyzeSocialSignals,
  consideredConversationPremise,
  normalizeGeneratedMessageContent,
  selectConsideredConversation,
  selectResponders,
  shouldRejectPublicCandidate,
  shouldStartConsideredConversation,
  type ConsideredConversationGate,
} from "./director.js";

describe("social director", () => {
  it("always prioritises a directly mentioned quiet resident", () => {
    const signals = analyzeSocialSignals("@moss what do you think about this?");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(selected.map((persona) => persona.id)).toContain("ai-moss");
  });

  it("recognises high-energy absurd messages", () => {
    const signals = analyzeSocialSignals("HEAR ME OUT!!! what if the banana runs the server? 🤯🤯");
    expect(signals.absurdity).toBeGreaterThan(0.4);
    expect(signals.energy).toBeGreaterThan(0.5);
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
    const examplePremise = consideredConversationPremise({ ...plan!, responseRole: "example" });
    const questionPremise = consideredConversationPremise({ ...plan!, responseRole: "question" });
    expect(challengePremise).toContain("45–75-word post");
    expect(challengePremise).toContain("8–28 words");
    expect(examplePremise).toContain("8–28 words");
    expect(questionPremise).toContain("8–24 words");
    expect([challengePremise, examplePremise, questionPremise].join(" ")).not.toContain("12–35 words");
    expect(challengePremise).toContain("hidden assumption");
    expect(challengePremise).toContain("nobody piles on");
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

  it("rejects an overlong generated message atomically instead of cutting a URL", () => {
    const longUrl = `https://example.com/${"a".repeat(520)}`;
    expect(normalizeGeneratedMessageContent(`läs ${longUrl}`)).toBeUndefined();
  });
});
