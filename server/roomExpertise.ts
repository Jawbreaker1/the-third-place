import { CHANNEL_PROFILES, type ChannelProfile, type ExpertiseLevel } from "./channels.js";
import type { Persona } from "./personas.js";

export interface ActorRoomExpertise {
  level: ExpertiseLevel;
  specialties: string[];
  blindSpots: string[];
}

export type RoomExpertiseMatrix = ReadonlyMap<string, ReadonlyMap<string, ActorRoomExpertise>>;

export const EXPERTISE_RANK: Record<ExpertiseLevel, number> = {
  basic: 0,
  casual: 1,
  competent: 2,
  advanced: 3,
  specialist: 4,
};

const LEVELS_DESCENDING: ExpertiseLevel[] = ["specialist", "advanced", "competent", "casual", "basic"];

const behaviorByLevel: Record<ExpertiseLevel, string> = {
  basic: "You know the common vocabulary and broad premise, but not the fine points. Prefer a reaction or honest question to a confident technical claim.",
  casual: "You follow ordinary conversation and common concepts, but should hedge on edge cases and let stronger residents handle deep corrections.",
  competent: "You can make practical, specific contributions and spot common mistakes, while acknowledging uncertainty outside your strengths.",
  advanced: "You can add strong technical nuance and challenge weak claims, but you are not omniscient and should not dominate every exchange.",
  specialist: "You have unusually deep command of your specialties and may correct subtle misconceptions concisely. Expertise does not make you omniscient or long-winded.",
};

const stableUnit = (value: string): number => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
};

const rankingScore = (persona: Persona, profile: ChannelProfile): number =>
  (persona.expertiseDomains.includes(profile.expertiseDomain) ? 2.2 : 0) +
  persona.curiosity * 0.7 +
  persona.conscientiousness * 0.45 +
  stableUnit(`${profile.public.id}:${persona.id}`) * 0.65;

const targetCounts = (size: number): Record<ExpertiseLevel, number> => {
  if (size === 0) return { basic: 0, casual: 0, competent: 0, advanced: 0, specialist: 0 };
  const specialist = Math.max(1, Math.round(size * 0.05));
  const advanced = size >= 5 ? Math.max(1, Math.round(size * 0.1)) : 0;
  const competent = Math.round(size * 0.25);
  const basic = Math.round(size * 0.15);
  return {
    specialist,
    advanced,
    competent,
    basic,
    casual: Math.max(0, size - specialist - advanced - competent - basic),
  };
};

const distributionFor = (personas: Persona[], profile: ChannelProfile): ReadonlyMap<string, ActorRoomExpertise> => {
  const counts = targetCounts(personas.length);
  const assigned = new Map<string, ActorRoomExpertise>();
  const byId = new Map(personas.map((persona) => [persona.id, persona]));

  for (const [personaId, override] of Object.entries(profile.expertiseOverrides ?? {})) {
    if (!override || !byId.has(personaId)) continue;
    assigned.set(personaId, {
      level: override.level,
      specialties: override.specialties ?? [],
      blindSpots: override.blindSpots ?? [],
    });
    counts[override.level] = Math.max(0, counts[override.level] - 1);
  }

  const remaining = personas
    .filter((persona) => !assigned.has(persona.id))
    .sort((a, b) => rankingScore(b, profile) - rankingScore(a, profile) || a.id.localeCompare(b.id));

  for (const level of LEVELS_DESCENDING) {
    for (let index = 0; index < counts[level]; index += 1) {
      const persona = remaining.shift();
      if (!persona) break;
      assigned.set(persona.id, { level, specialties: [], blindSpots: [] });
    }
  }
  for (const persona of remaining) {
    assigned.set(persona.id, { level: "casual", specialties: [], blindSpots: [] });
  }
  return assigned;
};

export const buildRoomExpertiseMatrix = (
  personas: Persona[],
  profiles: ChannelProfile[] = CHANNEL_PROFILES,
): RoomExpertiseMatrix =>
  new Map(profiles.map((profile) => [profile.public.id, distributionFor(personas, profile)]));

export const expertisePromptNote = (
  profile: ChannelProfile,
  expertise: ActorRoomExpertise,
): string => {
  const specialties = expertise.specialties.length > 0 ? ` Your particular strengths are ${expertise.specialties.join(", ")}.` : "";
  const blindSpots = expertise.blindSpots.length > 0 ? ` Your blind spots include ${expertise.blindSpots.join(", ")}.` : "";
  const freshness = profile.topic.freshnessRule ? ` Freshness rule: ${profile.topic.freshnessRule}` : "";
  return `This room is about ${profile.topic.brief}. Your private competence level here is ${expertise.level}; never announce this label. ${behaviorByLevel[expertise.level]}${specialties}${blindSpots}${freshness} Never invent human credentials, employment, trades, holdings or play history.`;
};
