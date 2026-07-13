import { describe, expect, it } from "vitest";
import { CHANNEL_PROFILES, CHANNELS } from "./channels.js";
import { PERSONAS } from "./personas.js";
import { buildRoomExpertiseMatrix, EXPERTISE_RANK } from "./roomExpertise.js";

const NEW_ROOM_IDS = ["ai-programming", "stock-market", "world-of-warcraft", "3d-visualisation"];

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
      expect(profile.ambientPremises.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(profile.expertiseOverrides ?? {}).every((personaId) => personaIds.has(personaId))).toBe(true);
    }
  });

  it("keeps internal expertise and freshness rules out of public channel objects", () => {
    for (const channel of CHANNELS) {
      expect(channel).not.toHaveProperty("topic");
      expect(channel).not.toHaveProperty("expertiseOverrides");
      expect(channel).not.toHaveProperty("ambientPremises");
    }
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

  it("anchors the intended room specialists", () => {
    const matrix = buildRoomExpertiseMatrix(PERSONAS);
    expect(matrix.get("ai-programming")?.get("ai-sana")?.level).toBe("specialist");
    expect(matrix.get("stock-market")?.get("ai-farah")?.level).toBe("specialist");
    expect(matrix.get("world-of-warcraft")?.get("ai-pixel")?.level).toBe("specialist");
    expect(matrix.get("3d-visualisation")?.get("ai-pixel")?.level).toBe("specialist");
  });
});
