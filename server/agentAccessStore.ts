import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  EXTERNAL_AGENT_INVITATION_DEFAULT_EXPIRY_MINUTES,
  createExternalAgentInvitationInputSchema,
  externalAgentAccessPolicyInputSchema,
  externalAgentChannelIdsSchema,
  externalAgentDisplayNameSchema,
  externalAgentInvitationLabelSchema,
  externalAgentPublicBioSchema,
  externalAgentPublicProfileInputSchema,
  externalAgentScopesSchema,
  updateExternalAgentPublicProfileInputSchema,
  type AuthenticatedExternalAgent,
  type CanonicalUpdateExternalAgentPublicProfileInput,
  type CreateExternalAgentInvitationInput,
  type ExternalAgentAccessPolicyInput,
  type ExternalAgentAdminDetail,
  type ExternalAgentInvitationStatus,
  type ExternalAgentInvitationSummary,
  type ExternalAgentPublicProfileInput,
  type ExternalAgentSummary,
  type IssuedExternalAgentInvitation,
  type RedeemedExternalAgentInvitation,
  type UpdateExternalAgentPublicProfileInput,
} from "../shared/agentTypes.js";
import { stripDangerousTextControls } from "../shared/unicodeSafety.js";
import { preservePreMigrationState } from "./persistenceMigrationBackup.js";

export const AGENT_ACCESS_MAX_RECORDS = 64;
export const AGENT_ACCESS_MAX_INVITATIONS = 128;
export const AGENT_BEARER_TOKEN_PREFIX = "ttp_agent_";
export const AGENT_INVITATION_TOKEN_PREFIX = "ttp_invite_";

const TOKEN_SECRET_BYTES = 32;
const TOKEN_SECRET_CHARACTERS = 43;
const MAX_STATE_BYTES = 2 * 1_024 * 1_024;
const LEGACY_PERSONALITY_MAX_CODE_POINTS = 12_000;
const agentIdSchema = z.string().min(7).max(100).regex(/^agent-[a-z0-9][a-z0-9-]*$/u);
const invitationIdSchema = z.string().min(14).max(120).regex(/^agent-invite-[a-z0-9][a-z0-9-]*$/u);
const canonicalTimestampSchema = z.string().datetime().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "Timestamp must use canonical UTC ISO-8601 form");
const tokenDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const persistedAgentBaseShape = {
  id: agentIdSchema,
  displayName: externalAgentDisplayNameSchema,
  publicBio: externalAgentPublicBioSchema,
  channelIds: externalAgentChannelIdsSchema,
  scopes: externalAgentScopesSchema,
  tokenDigest: tokenDigestSchema,
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  lastSeenAt: canonicalTimestampSchema.optional(),
  revokedAt: canonicalTimestampSchema.optional(),
};

const validateAgentTimestamps = (
  agent: {
    createdAt: string;
    updatedAt: string;
    lastSeenAt?: string;
    revokedAt?: string;
  },
  context: z.RefinementCtx,
): void => {
  const created = Date.parse(agent.createdAt);
  if (Date.parse(agent.updatedAt) < created) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["updatedAt"], message: "Update predates creation" });
  }
  if (agent.lastSeenAt && Date.parse(agent.lastSeenAt) < created) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lastSeenAt"], message: "Activity predates creation" });
  }
  if (agent.revokedAt && Date.parse(agent.revokedAt) < created) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["revokedAt"], message: "Revocation predates creation" });
  }
};

const persistedAgentSchema = z.object(persistedAgentBaseShape).strict().superRefine(validateAgentTimestamps);

// Version 1 is accepted only as an input migration format. Its private prompt
// is validated, discarded and never assigned to live store state.
const legacyPersonalityPromptSchema = z.string().superRefine((value, context) => {
  const canonical = stripDangerousTextControls(value.normalize("NFC").replace(/\r\n?/gu, "\n")).trim();
  if (canonical !== value || [...value].length < 1 || [...value].length > LEGACY_PERSONALITY_MAX_CODE_POINTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Legacy personality prompt is not canonical" });
  }
});
const legacyPersistedAgentSchema = z.object({
  ...persistedAgentBaseShape,
  personalityPrompt: legacyPersonalityPromptSchema,
}).strict().superRefine(validateAgentTimestamps);

const persistedInvitationSchema = z.object({
  id: invitationIdSchema,
  agentId: agentIdSchema,
  adminLabel: externalAgentInvitationLabelSchema,
  purpose: z.enum(["enroll", "reconnect"]),
  channelIds: externalAgentChannelIdsSchema,
  scopes: externalAgentScopesSchema,
  tokenDigest: tokenDigestSchema,
  createdAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  redeemedAt: canonicalTimestampSchema.optional(),
  revokedAt: canonicalTimestampSchema.optional(),
  expiredAt: canonicalTimestampSchema.optional(),
}).strict().superRefine((invitation, context) => {
  const created = Date.parse(invitation.createdAt);
  const expires = Date.parse(invitation.expiresAt);
  if (expires <= created) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Invitation must expire after creation" });
  }
  if (invitation.redeemedAt && Date.parse(invitation.redeemedAt) < created) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["redeemedAt"], message: "Redemption predates invitation" });
  }
  if (invitation.redeemedAt && Date.parse(invitation.redeemedAt) >= expires) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["redeemedAt"], message: "Redemption did not precede expiry" });
  }
  if (invitation.revokedAt && Date.parse(invitation.revokedAt) < created) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["revokedAt"], message: "Revocation predates invitation" });
  }
  if (invitation.expiredAt && Date.parse(invitation.expiredAt) !== expires) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiredAt"], message: "Expiry tombstone must match expiresAt" });
  }
  const terminalStates = [invitation.redeemedAt, invitation.revokedAt, invitation.expiredAt].filter(Boolean).length;
  if (terminalStates > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invitation can have only one terminal state" });
  }
});

const validateUniqueState = (
  state: {
    agents: Array<z.infer<typeof persistedAgentSchema>>;
    invitations: Array<z.infer<typeof persistedInvitationSchema>>;
  },
  context: z.RefinementCtx,
): void => {
  const agentIds = new Set<string>();
  const invitationIds = new Set<string>();
  const tokenDigests = new Set<string>();
  const openInvitationAgentIds = new Set<string>();

  state.agents.forEach((agent, index) => {
    if (agentIds.has(agent.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "id"], message: "Duplicate agent ID" });
    }
    if (tokenDigests.has(agent.tokenDigest)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "tokenDigest"], message: "Duplicate token digest" });
    }
    agentIds.add(agent.id);
    tokenDigests.add(agent.tokenDigest);
  });

  state.invitations.forEach((invitation, index) => {
    if (invitationIds.has(invitation.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["invitations", index, "id"], message: "Duplicate invitation ID" });
    }
    if (tokenDigests.has(invitation.tokenDigest)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["invitations", index, "tokenDigest"], message: "Duplicate token digest" });
    }
    invitationIds.add(invitation.id);
    tokenDigests.add(invitation.tokenDigest);

    const terminal = Boolean(invitation.redeemedAt || invitation.revokedAt || invitation.expiredAt);
    if (!terminal) {
      if (openInvitationAgentIds.has(invitation.agentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["invitations", index, "agentId"],
          message: "An actor cannot have multiple open invitations",
        });
      }
      openInvitationAgentIds.add(invitation.agentId);
    }

    if (invitation.purpose === "reconnect" && !agentIds.has(invitation.agentId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["invitations", index, "agentId"],
        message: "Reconnect invitation target is missing",
      });
    }
    if (invitation.purpose === "enroll") {
      const hasAgent = agentIds.has(invitation.agentId);
      if (Boolean(invitation.redeemedAt) !== hasAgent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["invitations", index, "agentId"],
          message: "Enrollment invitation and actor lifecycle disagree",
        });
      }
    }
  });
};

const persistedStateV2Schema = z.object({
  version: z.literal(2),
  agents: z.array(persistedAgentSchema).max(AGENT_ACCESS_MAX_RECORDS),
  invitations: z.array(persistedInvitationSchema).max(AGENT_ACCESS_MAX_INVITATIONS),
}).strict().superRefine(validateUniqueState);

const persistedStateV1Schema = z.object({
  version: z.literal(1),
  agents: z.array(legacyPersistedAgentSchema).max(AGENT_ACCESS_MAX_RECORDS),
}).strict().superRefine((state, context) => validateUniqueState({
  agents: state.agents.map(({ personalityPrompt: _discarded, ...agent }) => agent),
  invitations: [],
}, context));

type PersistedAgent = z.infer<typeof persistedAgentSchema>;
type PersistedInvitation = z.infer<typeof persistedInvitationSchema>;
type PersistedAgentState = z.infer<typeof persistedStateV2Schema>;

export interface AgentAccessStoreOptions {
  now?: () => number;
  /** Test hook for final agent credentials. Production still requires canonical 256-bit tokens. */
  randomToken?: () => string;
  /** Test hook for invitation credentials. Production still requires canonical 256-bit tokens. */
  randomInvitationToken?: () => string;
  randomId?: () => string;
  randomInvitationId?: () => string;
  maxRecords?: number;
  maxInvitations?: number;
  /** Bounds disk churn when a polling agent reports presence on every request. */
  touchPersistenceIntervalMs?: number;
}

export class AgentAccessStoreLoadError extends Error {
  readonly code = "AGENT_ACCESS_STORE_LOAD_FAILED";

  constructor(cause: unknown) {
    super("External-agent credentials could not be read safely. Startup was aborted and the original file was left untouched.", {
      cause,
    });
    this.name = "AgentAccessStoreLoadError";
  }
}

export class AgentAccessStoreCapacityError extends Error {
  readonly code = "AGENT_ACCESS_STORE_CAPACITY_REACHED";

  constructor() {
    super("The bounded external-agent credential store is full.");
    this.name = "AgentAccessStoreCapacityError";
  }
}

const emptyState = (): PersistedAgentState => ({ version: 2, agents: [], invitations: [] });

const pathIsWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
};

const realPathThroughExistingAncestor = (path: string): string => {
  const unresolvedComponents: string[] = [];
  let existingAncestor = resolve(path);

  while (true) {
    try {
      return resolve(realpathSync(existingAncestor), ...[...unresolvedComponents].reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Missing descendants are expected for a store that has not been created
      // yet. Any other realpath failure is security-relevant and must fail
      // closed rather than silently falling back to its lexical spelling.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      unresolvedComponents.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
};

/** Credential state must never be reachable through the app's static trees. */
const assertPrivateAgentAccessPath = (candidate: string, cwd = process.cwd()): void => {
  const resolvedCandidate = resolve(candidate);
  // Resolve symlinks in the longest existing prefix. Resolving only the
  // immediate parent is insufficient when a not-yet-created child directory
  // sits below an existing symlink into a static tree.
  const realCandidate = realPathThroughExistingAncestor(resolvedCandidate);
  const protectedRoots = ["dist", "public"].flatMap((name) => {
    const lexical = resolve(cwd, name);
    const real = realPathThroughExistingAncestor(lexical);
    return lexical === real ? [lexical] : [lexical, real];
  });
  if (protectedRoots.some((root) =>
    pathIsWithin(root, resolvedCandidate) || pathIsWithin(root, realCandidate)
  )) {
    throw new TypeError("External-agent credential state must be outside the statically served dist/ and public/ trees.");
  }
};

const digestToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** `updatedAt` doubles as the externally observed configuration version. */
const nextConfigurationTimestamp = (now: number, previous: string): string =>
  new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();

const isCanonicalToken = (token: unknown, prefix: string): token is string => {
  if (typeof token !== "string" || token.length !== prefix.length + TOKEN_SECRET_CHARACTERS ||
      !token.startsWith(prefix)) return false;
  const encoded = token.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return false;
  try {
    const secret = Buffer.from(encoded, "base64url");
    return secret.length === TOKEN_SECRET_BYTES && secret.toString("base64url") === encoded;
  } catch {
    return false;
  }
};

const isCanonicalBearerToken = (token: unknown): token is string =>
  isCanonicalToken(token, AGENT_BEARER_TOKEN_PREFIX);
const isCanonicalInvitationToken = (token: unknown): token is string =>
  isCanonicalToken(token, AGENT_INVITATION_TOKEN_PREFIX);

const summary = (agent: PersistedAgent): ExternalAgentSummary => ({
  id: agent.id,
  displayName: agent.displayName,
  publicBio: agent.publicBio,
  channelIds: [...agent.channelIds],
  scopes: [...agent.scopes],
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
  ...(agent.lastSeenAt ? { lastSeenAt: agent.lastSeenAt } : {}),
  ...(agent.revokedAt ? { revokedAt: agent.revokedAt } : {}),
});

const invitationStatus = (invitation: PersistedInvitation, now: number): ExternalAgentInvitationStatus => {
  if (invitation.redeemedAt) return "redeemed";
  if (invitation.revokedAt) return "revoked";
  if (invitation.expiredAt) return "expired";
  if (now >= Date.parse(invitation.expiresAt)) return "expired";
  return "pending";
};

const invitationSummary = (invitation: PersistedInvitation, now: number): ExternalAgentInvitationSummary => ({
  id: invitation.id,
  agentId: invitation.agentId,
  adminLabel: invitation.adminLabel,
  purpose: invitation.purpose,
  channelIds: [...invitation.channelIds],
  scopes: [...invitation.scopes],
  status: invitationStatus(invitation, now),
  createdAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
  ...(invitation.redeemedAt ? { redeemedAt: invitation.redeemedAt } : {}),
  ...(invitation.revokedAt ? { revokedAt: invitation.revokedAt } : {}),
  ...(invitation.expiredAt ? { expiredAt: invitation.expiredAt } : {}),
});

/**
 * Local credential authority for owner-operated external agents.
 *
 * The durable catalog contains only SHA-256 credential digests, public owner
 * profiles and host-owned access policy. Private personality instructions and
 * plaintext credentials never enter this store.
 */
export class AgentAccessStore {
  readonly path: string;
  private state: PersistedAgentState = emptyState();
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly randomInvitationToken: () => string;
  private readonly randomId: () => string;
  private readonly randomInvitationId: () => string;
  private readonly maxRecords: number;
  private readonly maxInvitations: number;
  private readonly touchPersistenceIntervalMs: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    path = resolve(process.cwd(), process.env.AGENT_ACCESS_STATE_PATH ?? "data/agent-access.json"),
    options: AgentAccessStoreOptions = {},
  ) {
    this.path = resolve(path);
    assertPrivateAgentAccessPath(this.path);
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() =>
      `${AGENT_BEARER_TOKEN_PREFIX}${randomBytes(TOKEN_SECRET_BYTES).toString("base64url")}`);
    this.randomInvitationToken = options.randomInvitationToken ?? (() =>
      `${AGENT_INVITATION_TOKEN_PREFIX}${randomBytes(TOKEN_SECRET_BYTES).toString("base64url")}`);
    this.randomId = options.randomId ?? randomUUID;
    this.randomInvitationId = options.randomInvitationId ?? randomUUID;
    this.maxRecords = Math.max(1, Math.min(options.maxRecords ?? AGENT_ACCESS_MAX_RECORDS, AGENT_ACCESS_MAX_RECORDS));
    this.maxInvitations = Math.max(
      1,
      Math.min(options.maxInvitations ?? AGENT_ACCESS_MAX_INVITATIONS, AGENT_ACCESS_MAX_INVITATIONS),
    );
    this.touchPersistenceIntervalMs = Math.max(
      0,
      Math.min(options.touchPersistenceIntervalMs ?? 15_000, 5 * 60_000),
    );
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      let next: PersistedAgentState;
      let exists = true;
      let migrated = false;
      let migrationSource: string | undefined;
      try {
        const metadata = await stat(this.path);
        if (!metadata.isFile()) throw new TypeError("External-agent state path is not a regular file.");
        if (metadata.size > MAX_STATE_BYTES) throw new RangeError("External-agent state exceeded its size bound.");
        const payload = await readFile(this.path);
        if (payload.byteLength > MAX_STATE_BYTES) throw new RangeError("External-agent state exceeded its size bound.");
        const rawText = payload.toString("utf8");
        const raw = JSON.parse(rawText) as unknown;
        if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 1) {
          const legacy = persistedStateV1Schema.parse(raw);
          next = persistedStateV2Schema.parse({
            version: 2,
            agents: legacy.agents.map(({ personalityPrompt: _discarded, ...agent }) => ({
              ...agent,
              updatedAt: nextConfigurationTimestamp(this.now(), agent.updatedAt),
            })),
            invitations: [],
          });
          migrated = true;
          migrationSource = rawText;
        } else {
          next = persistedStateV2Schema.parse(raw);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentAccessStoreLoadError(error);
        next = emptyState();
        exists = false;
      }
      try {
        // A legacy private prompt is scrubbed durably before the migrated state
        // becomes observable through list(), get() or authenticate().
        if (migrationSource !== undefined) {
          await preservePreMigrationState(this.path, migrationSource, 1, 2);
        }
        if (!exists || migrated) await this.persist(next);
        else await chmod(this.path, 0o600);
      } catch (error) {
        throw new AgentAccessStoreLoadError(error);
      }
      this.state = next;
    });
  }

  /** Catalog-safe projection: no bearer digest, plaintext token or private prompt. */
  list(): ExternalAgentSummary[] {
    return this.state.agents
      .map(summary)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  get(agentId: string): ExternalAgentAdminDetail | undefined {
    const agent = this.state.agents.find((candidate) => candidate.id === agentId);
    return agent ? summary(agent) : undefined;
  }

  listInvitations(): ExternalAgentInvitationSummary[] {
    const now = this.now();
    return this.state.invitations
      .map((invitation) => invitationSummary(invitation, now))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  getInvitation(invitationId: string): ExternalAgentInvitationSummary | undefined {
    const invitation = this.state.invitations.find((candidate) => candidate.id === invitationId);
    return invitation ? invitationSummary(invitation, this.now()) : undefined;
  }

  async createInvitation(
    input: CreateExternalAgentInvitationInput,
  ): Promise<IssuedExternalAgentInvitation | undefined> {
    const canonical = createExternalAgentInvitationInputSchema.parse(input);
    return this.enqueue(async () => {
      const now = this.now();
      const timestamp = new Date(now).toISOString();
      const terminalized = this.compactInvitationHistoryForIssue(
        this.terminalizeExpiredInvitations(this.state, now),
        now,
      );

      let agentId: string;
      let invitationAccess = {
        channelIds: [...canonical.channelIds],
        scopes: [...canonical.scopes],
      };
      if (canonical.purpose === "reconnect") {
        const target = terminalized.agents.find((agent) => agent.id === canonical.agentId);
        if (!target) return undefined;
        agentId = canonical.agentId;
        // Reconnect does not carry authority. Capture the host's current
        // policy for display, then re-read it from the target at redemption.
        invitationAccess = {
          channelIds: [...target.channelIds],
          scopes: [...target.scopes],
        };
      } else {
        const reservedEnrollments = terminalized.invitations.filter((invitation) =>
          invitation.purpose === "enroll" && !invitation.redeemedAt && !invitation.revokedAt && !invitation.expiredAt
        ).length;
        if (terminalized.agents.length + reservedEnrollments >= this.maxRecords) {
          throw new AgentAccessStoreCapacityError();
        }
        agentId = `agent-${this.randomId()}`;
        const existingActor = terminalized.agents.some((agent) => agent.id === agentId) ||
          terminalized.invitations.some((invitation) => invitation.agentId === agentId);
        if (!agentIdSchema.safeParse(agentId).success || existingActor) {
          throw new Error("Agent ID generator returned a duplicate or invalid identifier.");
        }
      }

      if (terminalized.invitations.some((invitation) =>
        invitation.agentId === agentId && !invitation.redeemedAt && !invitation.revokedAt && !invitation.expiredAt
      )) return undefined;

      const id = `agent-invite-${this.randomInvitationId()}`;
      if (!invitationIdSchema.safeParse(id).success ||
          terminalized.invitations.some((invitation) => invitation.id === id)) {
        throw new Error("Invitation ID generator returned a duplicate or invalid identifier.");
      }
      const token = this.issueUniqueInvitationToken(terminalized);
      const expiresInMinutes = canonical.expiresInMinutes ?? EXTERNAL_AGENT_INVITATION_DEFAULT_EXPIRY_MINUTES;
      const invitation: PersistedInvitation = {
        id,
        agentId,
        adminLabel: canonical.adminLabel,
        purpose: canonical.purpose,
        ...invitationAccess,
        tokenDigest: digestToken(token).toString("hex"),
        createdAt: timestamp,
        expiresAt: new Date(now + expiresInMinutes * 60_000).toISOString(),
      };
      const next = persistedStateV2Schema.parse({
        ...terminalized,
        invitations: [...terminalized.invitations, invitation],
      });
      await this.persist(next);
      this.state = next;
      return { invitation: invitationSummary(invitation, now), token };
    });
  }

  /** Returns only currently usable invitations after a full timing-safe digest pass. */
  authenticateInvitation(token: string | undefined): ExternalAgentInvitationSummary | undefined {
    const invitation = this.matchInvitation(token);
    if (!invitation || invitationStatus(invitation, this.now()) !== "pending") return undefined;
    return invitationSummary(invitation, this.now());
  }

  async revokeInvitation(invitationId: string): Promise<ExternalAgentInvitationSummary | undefined> {
    return this.enqueue(async () => {
      const invitation = this.state.invitations.find((candidate) => candidate.id === invitationId);
      if (!invitation) return undefined;
      if (invitationStatus(invitation, this.now()) !== "pending") {
        return invitationSummary(invitation, this.now());
      }
      const revokedAt = new Date(Math.max(this.now(), Date.parse(invitation.createdAt))).toISOString();
      const next = persistedStateV2Schema.parse({
        ...this.state,
        invitations: this.state.invitations.map((candidate) => candidate.id === invitationId
          ? { ...candidate, revokedAt }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      return this.getInvitation(invitationId);
    });
  }

  /**
   * Atomically consumes one invitation and issues the final agent credential.
   * Concurrent replays serialize through the same write queue, so exactly one
   * caller can receive a plaintext agent token.
   */
  async redeemInvitation(
    token: string | undefined,
    profile: ExternalAgentPublicProfileInput,
  ): Promise<RedeemedExternalAgentInvitation | undefined> {
    const canonicalProfile = externalAgentPublicProfileInputSchema.parse(profile);
    return this.enqueue(async () => {
      const invitation = this.matchInvitation(token);
      const now = this.now();
      if (!invitation || invitationStatus(invitation, now) !== "pending") return undefined;

      const timestamp = new Date(Math.max(now, Date.parse(invitation.createdAt))).toISOString();
      if (Date.parse(timestamp) >= Date.parse(invitation.expiresAt)) return undefined;
      const agentToken = this.issueUniqueAgentToken(this.state);
      let nextAgent: PersistedAgent;
      let agents: PersistedAgent[];

      if (invitation.purpose === "enroll") {
        if (this.state.agents.length >= this.maxRecords ||
            this.state.agents.some((agent) => agent.id === invitation.agentId)) return undefined;
        nextAgent = {
          id: invitation.agentId,
          ...canonicalProfile,
          channelIds: [...invitation.channelIds],
          scopes: [...invitation.scopes],
          tokenDigest: digestToken(agentToken).toString("hex"),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        agents = [...this.state.agents, nextAgent];
      } else {
        const current = this.state.agents.find((agent) => agent.id === invitation.agentId);
        if (!current) return undefined;
        nextAgent = {
          ...current,
          // Reconnection rotates authority; it does not mutate identity. The
          // owner can PATCH the profile with the newly authenticated bearer.
          // This also prevents a stale handoff page from rolling back a newer
          // owner-authored name or bio while an invitation is outstanding.
          // A reconnect invitation carries an issuance-time access snapshot
          // for the handoff UI. It must never restore permissions that the
          // host narrowed while the invitation was outstanding.
          channelIds: [...current.channelIds],
          scopes: [...current.scopes],
          tokenDigest: digestToken(agentToken).toString("hex"),
          updatedAt: nextConfigurationTimestamp(now, current.updatedAt),
          revokedAt: undefined,
        };
        agents = this.state.agents.map((agent) => agent.id === current.id ? nextAgent : agent);
      }

      const redeemedInvitation: PersistedInvitation = { ...invitation, redeemedAt: timestamp };
      const invitations = this.state.invitations.map((candidate): PersistedInvitation => {
        if (candidate.id === invitation.id) return redeemedInvitation;
        if (candidate.agentId !== invitation.agentId || candidate.redeemedAt || candidate.revokedAt || candidate.expiredAt) {
          return candidate;
        }
        return now >= Date.parse(candidate.expiresAt)
          ? { ...candidate, expiredAt: candidate.expiresAt }
          : { ...candidate, revokedAt: timestamp };
      });
      const next = persistedStateV2Schema.parse({
        ...this.state,
        agents,
        invitations,
      });
      await this.persist(next);
      this.state = next;
      return {
        agent: summary(nextAgent),
        token: agentToken,
        invitation: invitationSummary(redeemedInvitation, now),
      };
    });
  }

  /**
   * Authenticates every structurally valid credential with timing-safe digest
   * comparisons. Revoked rows still participate in the full comparison pass.
   */
  authenticate(token: string | undefined): AuthenticatedExternalAgent | undefined {
    const valid = isCanonicalBearerToken(token);
    const presented = digestToken(valid ? token : `${AGENT_BEARER_TOKEN_PREFIX}${"A".repeat(43)}`);
    let matched: PersistedAgent | undefined;
    for (const agent of this.state.agents) {
      const expected = Buffer.from(agent.tokenDigest, "hex");
      const equal = expected.length === presented.length && timingSafeEqual(expected, presented);
      if (equal) matched = agent;
    }
    return valid && matched && !matched.revokedAt ? summary(matched) : undefined;
  }

  async touch(agentId: string): Promise<ExternalAgentAdminDetail | undefined> {
    return this.enqueue(async () => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent || agent.revokedAt) return undefined;
      const now = this.now();
      if (agent.lastSeenAt && now - Date.parse(agent.lastSeenAt) < this.touchPersistenceIntervalMs) {
        return summary(agent);
      }
      const lastSeenAt = new Date(Math.max(now, Date.parse(agent.createdAt))).toISOString();
      if (agent.lastSeenAt === lastSeenAt) return summary(agent);
      const next = persistedStateV2Schema.parse({
        ...this.state,
        agents: this.state.agents.map((candidate) => candidate.id === agentId
          ? { ...candidate, lastSeenAt }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      return this.get(agentId);
    });
  }

  async revoke(agentId: string): Promise<ExternalAgentAdminDetail | undefined> {
    return this.enqueue(async () => {
      const now = this.now();
      const terminalized = this.terminalizeExpiredInvitations(this.state, now);
      const agent = terminalized.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return undefined;
      const timestamp = nextConfigurationTimestamp(now, agent.updatedAt);
      const invitations = terminalized.invitations.map((invitation): PersistedInvitation => {
        if (invitation.agentId !== agentId || invitationStatus(invitation, now) !== "pending") {
          return invitation;
        }
        return {
          ...invitation,
          revokedAt: new Date(Math.max(now, Date.parse(invitation.createdAt))).toISOString(),
        };
      });
      const invitationsChanged = invitations.some(
        (invitation, index) => invitation !== terminalized.invitations[index],
      );
      if (agent.revokedAt && !invitationsChanged && terminalized === this.state) return summary(agent);
      const next = persistedStateV2Schema.parse({
        ...terminalized,
        agents: terminalized.agents.map((candidate) => candidate.id === agentId && !candidate.revokedAt
          ? { ...candidate, revokedAt: timestamp, updatedAt: timestamp }
          : candidate),
        invitations,
      });
      await this.persist(next);
      this.state = next;
      return this.get(agentId);
    });
  }

  /** Owner-controlled public profile update; access policy cannot enter this schema. */
  async updateProfile(
    agentId: string,
    input: UpdateExternalAgentPublicProfileInput,
  ): Promise<ExternalAgentAdminDetail | undefined> {
    const canonical = updateExternalAgentPublicProfileInputSchema.parse(input) as
      CanonicalUpdateExternalAgentPublicProfileInput;
    return this.enqueue(async () => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent || agent.revokedAt) return undefined;
      const updatedAt = nextConfigurationTimestamp(this.now(), agent.updatedAt);
      const updated: PersistedAgent = { ...agent, ...canonical, updatedAt };
      const next = persistedStateV2Schema.parse({
        ...this.state,
        agents: this.state.agents.map((candidate) => candidate.id === agentId ? updated : candidate),
      });
      await this.persist(next);
      this.state = next;
      return summary(updated);
    });
  }

  /** Host-controlled access update; owner-controlled profile fields cannot enter this schema. */
  async updateAccess(
    agentId: string,
    input: ExternalAgentAccessPolicyInput,
  ): Promise<ExternalAgentAdminDetail | undefined> {
    const canonical = externalAgentAccessPolicyInputSchema.parse(input);
    return this.enqueue(async () => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return undefined;
      const updatedAt = nextConfigurationTimestamp(this.now(), agent.updatedAt);
      const updated: PersistedAgent = {
        ...agent,
        channelIds: [...canonical.channelIds],
        scopes: [...canonical.scopes],
        updatedAt,
      };
      const next = persistedStateV2Schema.parse({
        ...this.state,
        agents: this.state.agents.map((candidate) => candidate.id === agentId ? updated : candidate),
      });
      await this.persist(next);
      this.state = next;
      return summary(updated);
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private matchInvitation(token: string | undefined): PersistedInvitation | undefined {
    const valid = isCanonicalInvitationToken(token);
    const presented = digestToken(valid ? token : `${AGENT_INVITATION_TOKEN_PREFIX}${"A".repeat(43)}`);
    let matched: PersistedInvitation | undefined;
    for (const invitation of this.state.invitations) {
      const expected = Buffer.from(invitation.tokenDigest, "hex");
      const equal = expected.length === presented.length && timingSafeEqual(expected, presented);
      if (equal) matched = invitation;
    }
    return valid ? matched : undefined;
  }

  private issueUniqueAgentToken(state: PersistedAgentState): string {
    const token = this.randomToken();
    if (!isCanonicalBearerToken(token)) {
      throw new TypeError("Agent bearer-token generator must return a canonical 256-bit credential.");
    }
    this.assertUniqueTokenDigest(state, token, "Agent bearer-token generator returned a duplicate credential.");
    return token;
  }

  private issueUniqueInvitationToken(state: PersistedAgentState): string {
    const token = this.randomInvitationToken();
    if (!isCanonicalInvitationToken(token)) {
      throw new TypeError("Invitation-token generator must return a canonical 256-bit credential.");
    }
    this.assertUniqueTokenDigest(state, token, "Invitation-token generator returned a duplicate credential.");
    return token;
  }

  private assertUniqueTokenDigest(state: PersistedAgentState, token: string, message: string): void {
    const digest = digestToken(token).toString("hex");
    if (state.agents.some((agent) => agent.tokenDigest === digest) ||
        state.invitations.some((invitation) => invitation.tokenDigest === digest)) {
      throw new Error(message);
    }
  }

  private terminalizeExpiredInvitations(
    state: PersistedAgentState,
    now: number,
  ): PersistedAgentState {
    const invitations = state.invitations.map((invitation) =>
      !invitation.redeemedAt && !invitation.revokedAt && now >= Date.parse(invitation.expiresAt)
        ? { ...invitation, expiredAt: invitation.expiresAt }
        : invitation
    );
    return persistedStateV2Schema.parse({ ...state, invitations });
  }

  /**
   * Invitation tombstones are useful as a short Admin audit trail, but they
   * must never consume the finite onboarding capacity forever. Before issuing
   * one new secret, discard only the oldest terminal rows needed to make one
   * slot. Pending invitations and stable agent actors are never compacted.
   */
  private compactInvitationHistoryForIssue(
    state: PersistedAgentState,
    now: number,
  ): PersistedAgentState {
    const required = state.invitations.length - this.maxInvitations + 1;
    if (required <= 0) return state;
    const removable = state.invitations
      .filter((invitation) => invitationStatus(invitation, now) !== "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (removable.length < required) throw new AgentAccessStoreCapacityError();
    const removeIds = new Set(removable.slice(0, required).map((invitation) => invitation.id));
    return persistedStateV2Schema.parse({
      ...state,
      invitations: state.invitations.filter((invitation) => !removeIds.has(invitation.id)),
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(state: PersistedAgentState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
      throw new RangeError("External-agent state exceeded its size bound.");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
