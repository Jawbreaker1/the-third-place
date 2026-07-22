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
  /**
   * Trusted administrator assertion that this fictional resident is an adult.
   * This is romance eligibility only; it is never evidence of interest or consent.
   */
  fictionalAdult: boolean;
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
  identityKind?: "registered" | "guest" | "legacy";
  recoveryConfigured?: boolean;
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

export type AdminChannelFeedStatus = "disabled" | "waiting" | "polling" | "ready" | "unavailable";

/**
 * Read/write projection of one server-owned room integration. The server owns
 * the adapter, room binding and safety limits; administrators only control its
 * enabled state, fetch cadence and autonomous discussion frequency.
 */
export interface AdminChannelFeedControl {
  id: string;
  channelId: string;
  kind: string;
  label: string;
  description: string;
  publisher: {
    id: string;
    name: string;
    badge: "BOT";
  };
  available: boolean;
  enabled: boolean;
  /** 0 disables autonomous resident discussion of this feed; 100 is the bounded ceiling. */
  discussionFrequency: number;
  activeIntervalMinutes: number;
  idleIntervalMinutes: number;
  defaultEnabled: boolean;
  defaultDiscussionFrequency: number;
  defaultActiveIntervalMinutes: number;
  defaultIdleIntervalMinutes: number;
  minimumIntervalMinutes: number;
  maximumIntervalMinutes: number;
  status: AdminChannelFeedStatus;
  cardAvailable: boolean;
  failures: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  nextPollAt?: number;
}

export interface AdminChannelFeedPatch {
  enabled: boolean;
  discussionFrequency: number;
  activeIntervalMinutes: number;
  idleIntervalMinutes: number;
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
    /** Server-owned information bots, grouped in the UI by their bound room. */
    channelFeeds: AdminChannelFeedControl[];
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

/** Capabilities granted to one owner-operated external agent credential. */
export type AdminExternalAgentScope =
  | "rooms:read"
  | "messages:write"
  | "reactions:write";

/** Administrator projection of an enrolled owner-operated agent. */
export interface AdminExternalAgent {
  id: string;
  /** Owner-submitted public identity. Read-only in administration. */
  displayName: string;
  publicBio: string;
  channelIds: string[];
  scopes: AdminExternalAgentScope[];
  state: "enabled" | "revoked";
  /** Credential activity, independent from whether access is enabled. */
  presence: "online" | "idle" | "offline";
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** Access policy controlled by the server administrator, never owner identity. */
export interface AdminExternalAgentPolicyWrite {
  /** Explicit allowlist. Empty never means every room. */
  channelIds: string[];
  scopes: AdminExternalAgentScope[];
}

export type AdminExternalAgentInvitationState = "pending" | "redeemed" | "expired" | "revoked";

/** Token-free administrator projection of an enrollment invitation. */
export interface AdminExternalAgentInvitation {
  id: string;
  /** Private administrative label; it does not choose the future agent's name. */
  label: string;
  channelIds: string[];
  scopes: AdminExternalAgentScope[];
  state: AdminExternalAgentInvitationState;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  revokedAt?: string;
  /** Stable actor created or reconnected by a redeemed invitation. */
  agentId?: string;
}

export interface AdminExternalAgentInvitationWrite {
  label: string;
  expiresInSeconds: number;
  /** Explicit allowlist. Empty never means every room. */
  channelIds: string[];
  scopes: AdminExternalAgentScope[];
}

export interface AdminExternalAgentReconnectInvitationWrite {
  label: string;
  expiresInSeconds: number;
}

export interface AdminExternalAgentList {
  agents: AdminExternalAgent[];
  invitations: AdminExternalAgentInvitation[];
}

/** Returned only when an enrollment invitation is created. */
export interface AdminIssuedExternalAgentInvitation {
  invitation: AdminExternalAgentInvitation;
  /** One-time enrollment secret, not the agent's durable bearer credential. */
  token: string;
  /** May be same-origin relative when the server has no configured public origin. */
  enrollmentUrl: string;
  /** Optional server-authored appendix; the client adds the credential handoff envelope. */
  handoffPrompt?: string;
}

/** Read-only actor projection used by the private social-memory inspector. */
export interface AdminMemoryActorSummary {
  id: string;
  name: string;
  /** Unknown is historical storage provenance whose actor type is no longer trusted. */
  kind: "resident" | "human" | "agent" | "unknown";
  memoryCount: number;
  /** True when the inspector reached its row bound; additional rows may exist. */
  memoryRowsTruncated: boolean;
  /** Active, source-event memories that have not yet been consolidated away. */
  activeEpisodicMemoryCount: number;
  /** Durable summaries produced by source-bound multilingual consolidation. */
  consolidatedMemoryCount: number;
  /** Older items retained only as lifecycle provenance. */
  supersededMemoryCount: number;
  /** Items whose retention deadline has elapsed and are awaiting/reported by lifecycle cleanup. */
  expiredMemoryCount: number;
  outgoingRelationshipCount: number;
  incomingRelationshipCount: number;
  openLoopCount: number;
  lastActivityAt?: string;
}

export interface AdminMemoryStats {
  actors: number;
  memories: number;
  activeEpisodicMemories: number;
  consolidatedMemories: number;
  supersededMemories: number;
  expiredMemories: number;
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
  tier: "episodic" | "consolidated";
  sourceEventIds: string[];
  sourceEventCount: number;
  sourceMessageIds: string[];
  recallCount: number;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt?: string;
  reinforcedAt?: string;
  expiresAt?: string;
  supersededBy?: string;
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
  romanticInterest: number;
  romanticBoundary: {
    /** Unspecified means no stored veto; it is never affirmative consent. */
    state: "unspecified" | "closed";
    blockers: Array<{ actorId: string; actorName: string }>;
  };
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
