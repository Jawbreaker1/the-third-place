export type AdminPresence = "online" | "idle" | "dnd" | "offline";

export type AdminTuningKey =
  | "activity"
  | "autonomousLinkFrequency"
  | "competence"
  | "aggression"
  | "explicitness";

export interface AdminBehaviorTuning {
  activity: number;
  /** Frequency of AI-initiated, room-profiled research links. Human lookups are unaffected. */
  autonomousLinkFrequency: number;
  competence: number;
  aggression: number;
  explicitness: number;
}

export type AdminPersonaCoreKey =
  | "talkativeness"
  | "warmth"
  | "curiosity"
  | "mischief"
  | "conscientiousness"
  | "disagreement";

export interface AdminPersonaCore {
  talkativeness: number;
  warmth: number;
  curiosity: number;
  mischief: number;
  conscientiousness: number;
  disagreement: number;
}

export interface AdminPersonaConfig {
  id: string;
  name: string;
  role: string;
  bio: string;
  prompt: string;
  avatarImageUrl?: string;
  core: AdminPersonaCore;
  canResearch: boolean;
  roomAffinities: Record<string, number>;
  /** BCP-47 language tag to provider voice ID. */
  voices: Record<string, string>;
}

export interface AdminChannelConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
  topic: string;
  guidance: string;
  register: "everyday" | "banter" | "technical" | "analytical" | "fandom" | "studio";
  mode: "discussion" | "casual" | "banter";
  seeds: string[];
}

export interface AdminHumanMember {
  id: string;
  name: string;
  status: AdminPresence;
  activeChannelId?: string;
  joinedAt?: string;
}

export interface AdminBanRecord {
  memberId: string;
  name: string;
  reason?: string;
  bannedAt: string;
}

export interface AdminVoiceOption {
  id: string;
  label: string;
  /** Empty means the backend reports no language restriction. */
  languages: string[];
}

export interface AdminVoiceOptions {
  languages: string[];
  voices: AdminVoiceOption[];
}

export interface AdminStateSnapshot {
  behavior: {
    global: AdminBehaviorTuning;
    channels: Record<string, AdminBehaviorTuning>;
  };
  automation: {
    /** Rooms with trusted server-authored subjects for autonomous source posts. */
    autonomousLinkChannelIds: string[];
  };
  personas: AdminPersonaConfig[];
  channels: AdminChannelConfig[];
  humans: AdminHumanMember[];
  bans: AdminBanRecord[];
  voiceOptions: AdminVoiceOptions;
  revision?: string;
}

export type AdminBehaviorPatch =
  | { scope: "global"; tuning: AdminBehaviorTuning; channelId?: never }
  | { scope: "channel"; channelId: string; tuning: AdminBehaviorTuning | null };

export type AdminPersonaWrite = AdminPersonaConfig;
export type AdminChannelWrite = AdminChannelConfig;

export interface AdminSessionState {
  authenticated: boolean;
}
