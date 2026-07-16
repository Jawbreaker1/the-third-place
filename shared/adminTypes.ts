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

export interface AdminAutonomousResearchDiagnostics {
  /** Attempts selected by the scheduler in this server process. */
  attempts: number;
  /** Source-backed lead messages actually committed to room history. */
  published: number;
  /** Attempts that stopped before a source-backed lead was committed. */
  failed: number;
  lastFailure?: {
    channelId: string;
    seedId: string;
    reason: string;
    failedAt: number;
    retryAfterAt: number;
    consecutiveFailures: number;
  };
}

export interface AdminStateSnapshot {
  behavior: {
    global: AdminBehaviorTuning;
    channels: Record<string, AdminBehaviorTuning>;
  };
  automation: {
    /** Rooms with trusted server-authored subjects for autonomous source posts. */
    autonomousLinkChannelIds: string[];
    /** Ephemeral process diagnostics; absent when the director is unavailable. */
    autonomousResearch?: AdminAutonomousResearchDiagnostics;
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

/** Read-only actor projection used by the private social-memory inspector. */
export interface AdminMemoryActorSummary {
  id: string;
  name: string;
  kind: "resident" | "human";
  memoryCount: number;
  outgoingRelationshipCount: number;
  incomingRelationshipCount: number;
  openLoopCount: number;
  lastActivityAt?: string;
}

export interface AdminMemoryStats {
  actors: number;
  memories: number;
  relationships: number;
  openLoops: number;
  auditEntries: number;
}

export interface AdminMemoryOverview {
  stats: AdminMemoryStats;
  actors: AdminMemoryActorSummary[];
}

/**
 * One resident-owned, subjective memory. Source IDs point back to immutable
 * observed events/messages; the summary itself is never treated as provenance.
 */
export interface AdminMemoryItem {
  id: string;
  ownerId: string;
  kind: string;
  scope: string;
  perspective: string;
  summary: string;
  confidence: number;
  salience: number;
  pinned: boolean;
  sourceEventIds: string[];
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

/** A directed relationship: the owner is the actor holding this view. */
export interface AdminMemoryRelationship {
  ownerId: string;
  subjectId: string;
  ownerName: string;
  subjectName: string;
  familiarity: number;
  warmth: number;
  trust: number;
  respect: number;
  friction: number;
  updatedAt: string;
}

export interface AdminMemoryOpenLoop {
  id: string;
  ownerId: string;
  kind: string;
  summary: string;
  status: string;
  subjectIds: string[];
  sourceEventIds: string[];
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminMemoryAuditEntry {
  id: string;
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  sourceEventIds: string[];
  sourceMessageIds: string[];
  createdAt: string;
}

export interface AdminMemoryActorDetail {
  actor: AdminMemoryActorSummary;
  ownedMemories: AdminMemoryItem[];
  outgoingRelationships: AdminMemoryRelationship[];
  incomingRelationships: AdminMemoryRelationship[];
  openLoops: AdminMemoryOpenLoop[];
  audit: AdminMemoryAuditEntry[];
}

export interface AdminMemoryItemPatch {
  pinned: boolean;
}
