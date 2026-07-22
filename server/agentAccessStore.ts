import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  createExternalAgentInputSchema,
  externalAgentChannelIdsSchema,
  externalAgentDisplayNameSchema,
  externalAgentPersonalityPromptSchema,
  externalAgentPublicBioSchema,
  externalAgentScopesSchema,
  type AuthenticatedExternalAgent,
  type CanonicalUpdateExternalAgentInput,
  type CreateExternalAgentInput,
  type ExternalAgentAdminDetail,
  type ExternalAgentSummary,
  type IssuedExternalAgentCredential,
  type UpdateExternalAgentInput,
  updateExternalAgentInputSchema,
} from "../shared/agentTypes.js";

export const AGENT_ACCESS_MAX_RECORDS = 64;
export const AGENT_BEARER_TOKEN_PREFIX = "ttp_agent_";

const AGENT_BEARER_SECRET_BYTES = 32;
const AGENT_BEARER_SECRET_CHARACTERS = 43;
const AGENT_BEARER_TOKEN_CHARACTERS = AGENT_BEARER_TOKEN_PREFIX.length + AGENT_BEARER_SECRET_CHARACTERS;
const MAX_STATE_BYTES = 2 * 1_024 * 1_024;
const agentIdSchema = z.string().min(7).max(100).regex(/^agent-[a-z0-9][a-z0-9-]*$/u);
const canonicalTimestampSchema = z.string().datetime().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "Timestamp must use canonical UTC ISO-8601 form");
const tokenDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const persistedAgentSchema = z.object({
  id: agentIdSchema,
  displayName: externalAgentDisplayNameSchema,
  publicBio: externalAgentPublicBioSchema,
  personalityPrompt: externalAgentPersonalityPromptSchema,
  channelIds: externalAgentChannelIdsSchema,
  scopes: externalAgentScopesSchema,
  tokenDigest: tokenDigestSchema,
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  lastSeenAt: canonicalTimestampSchema.optional(),
  revokedAt: canonicalTimestampSchema.optional(),
}).strict().superRefine((agent, context) => {
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
});

const persistedStateSchema = z.object({
  version: z.literal(1),
  agents: z.array(persistedAgentSchema).max(AGENT_ACCESS_MAX_RECORDS),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  const digests = new Set<string>();
  state.agents.forEach((agent, index) => {
    if (ids.has(agent.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "id"], message: "Duplicate agent ID" });
    }
    if (digests.has(agent.tokenDigest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", index, "tokenDigest"],
        message: "Duplicate bearer-token digest",
      });
    }
    ids.add(agent.id);
    digests.add(agent.tokenDigest);
  });
});

type PersistedAgent = z.infer<typeof persistedAgentSchema>;
type PersistedAgentState = z.infer<typeof persistedStateSchema>;

export interface AgentAccessStoreOptions {
  now?: () => number;
  /** Test hook. Production tokens still must be canonical 256-bit bearer credentials. */
  randomToken?: () => string;
  randomId?: () => string;
  maxRecords?: number;
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

const emptyState = (): PersistedAgentState => ({ version: 1, agents: [] });

const pathIsWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
};

const realPathOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Credential state must never be reachable through the app's static trees. */
const assertPrivateAgentAccessPath = (candidate: string, cwd = process.cwd()): void => {
  const resolvedCandidate = resolve(candidate);
  const realCandidate = join(realPathOrResolved(dirname(resolvedCandidate)), basename(resolvedCandidate));
  const protectedRoots = ["dist", "public"].flatMap((name) => {
    const lexical = resolve(cwd, name);
    const real = realPathOrResolved(lexical);
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

const isCanonicalBearerToken = (token: unknown): token is string => {
  if (typeof token !== "string" || token.length !== AGENT_BEARER_TOKEN_CHARACTERS ||
      !token.startsWith(AGENT_BEARER_TOKEN_PREFIX)) return false;
  const encoded = token.slice(AGENT_BEARER_TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return false;
  try {
    const secret = Buffer.from(encoded, "base64url");
    return secret.length === AGENT_BEARER_SECRET_BYTES && secret.toString("base64url") === encoded;
  } catch {
    return false;
  }
};

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

const detail = (agent: PersistedAgent): ExternalAgentAdminDetail => ({
  ...summary(agent),
  personalityPrompt: agent.personalityPrompt,
});

/**
 * Local external-agent credential authority.
 *
 * Plaintext bearer credentials exist only in create/rotate return values. The
 * durable catalog keeps a SHA-256 digest and a revocation tombstone so old
 * chat history and social memory can continue resolving the same actor.
 */
export class AgentAccessStore {
  readonly path: string;
  private state: PersistedAgentState = emptyState();
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;
  private readonly maxRecords: number;
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
      `${AGENT_BEARER_TOKEN_PREFIX}${randomBytes(AGENT_BEARER_SECRET_BYTES).toString("base64url")}`);
    this.randomId = options.randomId ?? randomUUID;
    this.maxRecords = Math.max(1, Math.min(options.maxRecords ?? AGENT_ACCESS_MAX_RECORDS, AGENT_ACCESS_MAX_RECORDS));
    this.touchPersistenceIntervalMs = Math.max(
      0,
      Math.min(options.touchPersistenceIntervalMs ?? 15_000, 5 * 60_000),
    );
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      let next: PersistedAgentState;
      let exists = true;
      try {
        const metadata = await stat(this.path);
        if (!metadata.isFile()) throw new TypeError("External-agent state path is not a regular file.");
        if (metadata.size > MAX_STATE_BYTES) throw new RangeError("External-agent state exceeded its size bound.");
        const payload = await readFile(this.path);
        if (payload.byteLength > MAX_STATE_BYTES) throw new RangeError("External-agent state exceeded its size bound.");
        next = persistedStateSchema.parse(JSON.parse(payload.toString("utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentAccessStoreLoadError(error);
        next = emptyState();
        exists = false;
      }
      try {
        if (exists) await chmod(this.path, 0o600);
        else await this.persist(next);
      } catch (error) {
        throw new AgentAccessStoreLoadError(error);
      }
      this.state = next;
    });
  }

  /** Catalog-safe projection: no bearer digest, plaintext token or private personality prompt. */
  list(): ExternalAgentSummary[] {
    return this.state.agents
      .map(summary)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  /** Private administrator detail. The bearer secret/digest remains deliberately absent. */
  get(agentId: string): ExternalAgentAdminDetail | undefined {
    const agent = this.state.agents.find((candidate) => candidate.id === agentId);
    return agent ? detail(agent) : undefined;
  }

  async create(input: CreateExternalAgentInput): Promise<IssuedExternalAgentCredential> {
    const canonical = createExternalAgentInputSchema.parse(input);
    return this.enqueue(async () => {
      if (this.state.agents.length >= this.maxRecords) throw new AgentAccessStoreCapacityError();
      const id = `agent-${this.randomId()}`;
      if (!agentIdSchema.safeParse(id).success || this.state.agents.some((agent) => agent.id === id)) {
        throw new Error("Agent ID generator returned a duplicate or invalid identifier.");
      }
      const token = this.issueUniqueToken();
      const timestamp = new Date(this.now()).toISOString();
      const agent: PersistedAgent = {
        id,
        ...canonical,
        tokenDigest: digestToken(token).toString("hex"),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = persistedStateSchema.parse({ ...this.state, agents: [...this.state.agents, agent] });
      await this.persist(next);
      this.state = next;
      return { agent: detail(agent), token };
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
    return valid && matched && !matched.revokedAt ? detail(matched) : undefined;
  }

  async touch(agentId: string): Promise<ExternalAgentAdminDetail | undefined> {
    return this.enqueue(async () => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent || agent.revokedAt) return undefined;
      const now = this.now();
      if (agent.lastSeenAt && now - Date.parse(agent.lastSeenAt) < this.touchPersistenceIntervalMs) {
        return detail(agent);
      }
      const lastSeenAt = new Date(Math.max(now, Date.parse(agent.createdAt))).toISOString();
      if (agent.lastSeenAt === lastSeenAt) return detail(agent);
      const next = persistedStateSchema.parse({
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
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return undefined;
      if (agent.revokedAt) return detail(agent);
      const timestamp = nextConfigurationTimestamp(this.now(), agent.updatedAt);
      const next = persistedStateSchema.parse({
        ...this.state,
        agents: this.state.agents.map((candidate) => candidate.id === agentId
          ? { ...candidate, revokedAt: timestamp, updatedAt: timestamp }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      return this.get(agentId);
    });
  }

  /** Issues a replacement credential and deliberately re-enables a revoked actor. */
  async rotate(agentId: string): Promise<IssuedExternalAgentCredential | undefined> {
    return this.enqueue(async () => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return undefined;
      const token = this.issueUniqueToken();
      const timestamp = nextConfigurationTimestamp(this.now(), agent.updatedAt);
      const next = persistedStateSchema.parse({
        ...this.state,
        agents: this.state.agents.map((candidate) => candidate.id === agentId
          ? {
              ...candidate,
              tokenDigest: digestToken(token).toString("hex"),
              updatedAt: timestamp,
              revokedAt: undefined,
            }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      const updated = this.get(agentId);
      if (!updated) throw new Error("Agent disappeared during credential rotation.");
      return { agent: updated, token };
    });
  }

  async update(agentId: string, input: UpdateExternalAgentInput): Promise<ExternalAgentAdminDetail | undefined> {
    const canonical = updateExternalAgentInputSchema.parse(input) as CanonicalUpdateExternalAgentInput;
    return this.enqueue(async () => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return undefined;
      const updatedAt = nextConfigurationTimestamp(this.now(), agent.updatedAt);
      const next = persistedStateSchema.parse({
        ...this.state,
        agents: this.state.agents.map((candidate) => candidate.id === agentId
          ? { ...candidate, ...canonical, updatedAt }
          : candidate),
      });
      await this.persist(next);
      this.state = next;
      return this.get(agentId);
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private issueUniqueToken(): string {
    const token = this.randomToken();
    if (!isCanonicalBearerToken(token)) {
      throw new TypeError("Agent bearer-token generator must return a canonical 256-bit credential.");
    }
    const digest = digestToken(token).toString("hex");
    if (this.state.agents.some((agent) => agent.tokenDigest === digest)) {
      throw new Error("Agent bearer-token generator returned a duplicate credential.");
    }
    return token;
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
