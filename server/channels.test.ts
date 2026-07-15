import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROFILES,
  CHANNELS,
  CONVERSATION_REGISTERS,
  type ChannelProfile,
} from "./channels.js";
import { PERSONAS, type Persona } from "./personas.js";
import { buildRoomExpertiseMatrix, EXPERTISE_RANK } from "./roomExpertise.js";

const NEW_ROOM_IDS = ["the-pub", "ai-programming", "stock-market", "world-of-warcraft", "3d-visualisation"];
const RESEARCH_ROOM_IDS = [
  "the-pub",
  "ai-lab",
  "ai-programming",
  "stock-market",
  "world-of-warcraft",
  "3d-visualisation",
];

const normalizedContentKey = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("und");

describe("channel profiles", () => {
  it("defines a single scalable profile for every public room", () => {
    const ids = CHANNEL_PROFILES.map((profile) => profile.public.id);
    const personaIds = new Set(PERSONAS.map((persona) => persona.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(NEW_ROOM_IDS));
    expect(CHANNELS.map((channel) => channel.id)).toEqual(ids);
    for (const profile of CHANNEL_PROFILES) {
      expect(profile.topic.brief.length).toBeGreaterThan(20);
      expect(profile.topic.tags.length).toBeGreaterThan(2);
      expect(profile.ambientPremises.length).toBeGreaterThanOrEqual(profile.public.id === "the-pub" ? 20 : 16);
      expect(new Set(profile.ambientPremises.map(normalizedContentKey)).size).toBe(profile.ambientPremises.length);
      if (profile.ambientPremiseFamilies) {
        expect(profile.ambientPremiseFamilies).toHaveLength(profile.ambientPremises.length);
        expect(profile.ambientPremiseFamilies.every((family) => /^[a-z0-9-]{3,48}$/.test(family))).toBe(true);
        expect(new Set(profile.ambientPremiseFamilies).size).toBeGreaterThanOrEqual(8);
      }
      expect(CONVERSATION_REGISTERS[profile.conversationRegister].guidance.length).toBeGreaterThan(40);
      expect(Object.keys(profile.expertiseOverrides ?? {}).every((personaId) => personaIds.has(personaId))).toBe(true);
    }
    const allPremises = CHANNEL_PROFILES.flatMap((profile) => profile.ambientPremises.map(normalizedContentKey));
    expect(new Set(allPremises).size).toBe(allPremises.length);
  });

  it("defines bounded, stable and non-repeating autonomous research starters", () => {
    const allIds: string[] = [];
    const allQueries: string[] = [];
    for (const profile of CHANNEL_PROFILES) {
      const seeds = profile.autonomousResearchSeeds ?? [];
      if (RESEARCH_ROOM_IDS.includes(profile.public.id)) {
        expect(seeds.length, profile.public.id).toBeGreaterThanOrEqual(3);
        expect(seeds.length, profile.public.id).toBeLessThanOrEqual(8);
      }
      for (const seed of seeds) {
        expect(seed.id, profile.public.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
        expect(seed.id.length, profile.public.id).toBeLessThanOrEqual(80);
        expect(seed.query.length, seed.id).toBeGreaterThanOrEqual(12);
        expect(seed.query.length, seed.id).toBeLessThanOrEqual(140);
        expect(seed.query, seed.id).not.toMatch(/https?:\/\//u);
        expect(["web", "news"], seed.id).toContain(seed.mode);
        if (seed.mode === "news") expect(seed.maxAgeDays, seed.id).toBeDefined();
        if (seed.maxAgeDays !== undefined) {
          expect(Number.isInteger(seed.maxAgeDays), seed.id).toBe(true);
          expect(seed.maxAgeDays, seed.id).toBeGreaterThanOrEqual(1);
          expect(seed.maxAgeDays, seed.id).toBeLessThanOrEqual(365);
        }
        expect(seed.discussionAngle.length, seed.id).toBeGreaterThanOrEqual(30);
        expect(seed.discussionAngle.length, seed.id).toBeLessThanOrEqual(280);
        allIds.push(seed.id);
        allQueries.push(normalizedContentKey(seed.query));
      }
    }
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(new Set(allQueries).size).toBe(allQueries.length);
    const pubSeedIds = CHANNEL_PROFILES.find((profile) => profile.public.id === "the-pub")!
      .autonomousResearchSeeds!.map((seed) => seed.id);
    expect(pubSeedIds).toEqual(expect.arrayContaining([
      "pub-new-music-releases",
      "pub-film-festival-reaction",
      "pub-limited-beer-release",
      "pub-distinctive-pub",
    ]));
  });

  it("keeps internal expertise and freshness rules out of public channel objects", () => {
    for (const channel of CHANNELS) {
      expect(channel).not.toHaveProperty("topic");
      expect(channel).not.toHaveProperty("expertiseOverrides");
      expect(channel).not.toHaveProperty("ambientPremises");
      expect(channel).not.toHaveProperty("autonomousResearchSeeds");
      expect(channel).not.toHaveProperty("conversationGuidance");
      expect(channel).not.toHaveProperty("conversationRegister");
      expect(channel).not.toHaveProperty("ambientMode");
    }
  });

  it("uses casual pacing for social rooms while preserving technical and analytical registers", () => {
    const profile = (id: string) => CHANNEL_PROFILES.find((entry) => entry.public.id === id)!;

    expect(profile("lobby")).toMatchObject({ ambientMode: "casual", conversationRegister: "everyday" });
    expect(profile("the-pub")).toMatchObject({ ambientMode: "banter", conversationRegister: "banter" });
    expect(profile("world-of-warcraft")).toMatchObject({ ambientMode: "casual", conversationRegister: "fandom" });
    expect(profile("side-quests")).toMatchObject({ ambientMode: "casual", conversationRegister: "everyday" });
    expect(profile("ai-programming").conversationRegister).toBe("technical");
    expect(profile("stock-market").conversationRegister).toBe("analytical");
    expect(profile("3d-visualisation").conversationRegister).toBe("studio");
  });

  it("gives every resident baseline knowledge while keeping experts rare", () => {
    const matrix = buildRoomExpertiseMatrix(PERSONAS);
    for (const channelId of NEW_ROOM_IDS) {
      const expertise = [...(matrix.get(channelId)?.values() ?? [])];
      expect(expertise).toHaveLength(PERSONAS.length);
      expect(expertise.every((entry) => EXPERTISE_RANK[entry.level] >= EXPERTISE_RANK.basic)).toBe(true);
      const deepExperts = expertise.filter((entry) => EXPERTISE_RANK[entry.level] >= EXPERTISE_RANK.advanced);
      const everydayResidents = expertise.filter((entry) => EXPERTISE_RANK[entry.level] <= EXPERTISE_RANK.casual);
      expect(deepExperts.length).toBeGreaterThanOrEqual(1);
      expect(deepExperts.length).toBeLessThanOrEqual(3);
      expect(everydayResidents.length).toBeGreaterThan(deepExperts.length * 2);
    }
  });

  it("is deterministic even if persona input order changes", () => {
    const fingerprint = (personas: typeof PERSONAS) => {
      const matrix = buildRoomExpertiseMatrix(personas);
      return CHANNELS.flatMap((channel) =>
        PERSONAS.map((persona) => `${channel.id}:${persona.id}:${matrix.get(channel.id)?.get(persona.id)?.level}`),
      ).sort();
    };
    expect(fingerprint(PERSONAS)).toEqual(fingerprint([...PERSONAS].reverse()));
  });

  it("keeps expertise routing independent of localized labels, topic copy, tags and interests", () => {
    const fingerprint = (personas: Persona[], profiles: ChannelProfile[]) => {
      const matrix = buildRoomExpertiseMatrix(personas, profiles);
      return profiles.flatMap((profile) =>
        personas.map((persona) =>
          `${profile.public.id}:${persona.id}:${matrix.get(profile.public.id)?.get(persona.id)?.level}`,
        ),
      ).sort();
    };
    const localizedPersonas: Persona[] = PERSONAS.map((persona, index) => ({
      ...persona,
      name: index % 2 === 0 ? `住人${index}` : `مقيم${index}`,
      role: index % 2 === 0 ? "常連のメンバー" : "عضو دائم",
      bio: index % 2 === 0 ? "自由に翻訳された紹介文。" : "نص تعريفي محلي حر.",
      prompt: index % 2 === 0 ? "この人物説明は日本語です。" : "وصف الشخصية بالعربية.",
      interests: index % 2 === 0 ? ["音楽", "技術"] : ["الموسيقى", "التقنية"],
    }));
    const localizedProfiles: ChannelProfile[] = CHANNEL_PROFILES.map((profile, index) => ({
      ...profile,
      public: {
        ...profile.public,
        name: index % 2 === 0 ? `部屋${index}` : `غرفة-${index}`,
        description: index % 2 === 0 ? "翻訳された部屋の説明" : "وصف الغرفة المحلي",
      },
      topic: {
        ...profile.topic,
        brief: index % 2 === 0 ? "表示用の自由な日本語トピック説明" : "وصف موضوع عربي محلي للعرض",
        tags: index % 2 === 0 ? ["ゲーム", "会話", "音楽"] : ["ألعاب", "حوار", "موسيقى"],
      },
    }));

    expect(fingerprint(localizedPersonas, localizedProfiles)).toEqual(
      fingerprint(PERSONAS, CHANNEL_PROFILES),
    );
  });

  it("anchors the intended room specialists", () => {
    const matrix = buildRoomExpertiseMatrix(PERSONAS);
    expect(matrix.get("ai-programming")?.get("ai-sana")?.level).toBe("specialist");
    expect(matrix.get("stock-market")?.get("ai-farah")?.level).toBe("specialist");
    expect(matrix.get("world-of-warcraft")?.get("ai-pixel")?.level).toBe("specialist");
    expect(matrix.get("3d-visualisation")?.get("ai-pixel")?.level).toBe("specialist");
    expect(matrix.get("the-pub")?.get("ai-juno")?.level).toBe("specialist");
  });

  it("gives the two technical AI rooms explicit broad seed families", () => {
    const aiLab = CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-lab")!;
    const programming = CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-programming")!;
    expect(aiLab.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "multimodal",
      "voice-interaction",
      "privacy-deployment",
      "safety",
    ]));
    expect(programming.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "language-contracts",
      "accessibility-ui",
      "python-runtime",
      "local-hardware",
      "api-backpressure",
      "open-source-delivery",
    ]));
  });

  it("gives the pub a broad subject mix and a room-local banter contract", () => {
    const pub = CHANNEL_PROFILES.find((profile) => profile.public.id === "the-pub")!;
    expect(pub.ambientMode).toBe("banter");
    expect(pub.ambientPremises.length).toBeGreaterThanOrEqual(20);
    expect(pub.topic.tags).toEqual(expect.arrayContaining(["film", "music", "work", "politics", "memes", "food", "beer", "pubs"]));
    expect(pub.topic.brief).toContain("brewing craft");
    expect(pub.topic.brief).toContain("pub history");
    expect(pub.conversationGuidance).toContain("A rare supplied source may make brewing craft");
    expect(pub.conversationGuidance).toContain("without inventing drinking, intoxication, a visit or a lifestyle");
    expect(pub.conversationGuidance).toContain("never explain a punchline");
    expect(pub.ambientReactionPalette).toEqual(expect.arrayContaining(["😂", "🍿", "🎵"]));
  });

  it("keeps stock-market discussion concrete and informal without weakening evidence boundaries", () => {
    const stock = CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")!;
    expect(stock.topic.freshnessRule).toContain("Never invent live prices, market moves, news, filings or sources");
    expect(stock.topic.freshnessRule).toContain("Current facts require supplied fresh research");
    expect(stock.topic.freshnessRule).not.toContain("avoid personalized financial instructions");
    expect(stock.conversationGuidance).toContain("take bull or bear sides");
    expect(stock.conversationGuidance).toContain("give personal or informal tips");
    expect(stock.conversationGuidance).toContain("not a standardized AI/finance limitation");
    expect(stock.conversationGuidance).toContain("Keep caution proportional and inside the actual thesis");
    expect(stock.conversationGuidance).toContain("instead of inventing a live number, quote, URL or citation");
    expect(stock.ambientPremises).toEqual(expect.arrayContaining([
      expect.stringContaining("personal watchlist case"),
      expect.stringContaining("informal bull case"),
    ]));
    expect(stock.autonomousResearchSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "stock-capital-allocation-filing",
        discussionAngle: expect.stringContaining("which choice they personally prefer"),
      }),
    ]));
  });
});
