import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_AGENT_INVITATION_DEFAULT_EXPIRY_MINUTES,
  EXTERNAL_AGENT_INVITATION_MAX_EXPIRY_MINUTES,
  EXTERNAL_AGENT_INVITATION_MIN_EXPIRY_MINUTES,
  type ExternalAgentAccessPolicyInput,
} from "../shared/agentTypes.js";
import {
  AGENT_BEARER_TOKEN_PREFIX,
  AGENT_INVITATION_TOKEN_PREFIX,
  AgentAccessStore,
  AgentAccessStoreCapacityError,
  AgentAccessStoreLoadError,
} from "./agentAccessStore.js";

const directories: string[] = [];
const makePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-agents-"));
  directories.push(directory);
  return join(directory, "agent-access.json");
};

const agentToken = (byte: number): string =>
  `${AGENT_BEARER_TOKEN_PREFIX}${Buffer.alloc(32, byte).toString("base64url")}`;
const invitationToken = (byte: number): string =>
  `${AGENT_INVITATION_TOKEN_PREFIX}${Buffer.alloc(32, byte).toString("base64url")}`;

const access = (channelIds = ["lobby", "ai-hacking"]): ExternalAgentAccessPolicyInput => ({
  channelIds,
  scopes: ["rooms:read", "messages:write", "reactions:write"],
});

const enrollmentInvitation = (overrides: Record<string, unknown> = {}) => ({
  purpose: "enroll" as const,
  adminLabel: "Johan's outside collaborator",
  ...access(),
  ...overrides,
});

const profile = (displayName = "Field Agent") => ({
  displayName,
  publicBio: "A curious visitor operated outside The Third Place.",
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("external-agent access store v2", () => {
  it.each(["dist", "public"])("rejects credential state inside the statically served %s tree", (directory) => {
    expect(() => new AgentAccessStore(join(process.cwd(), directory, "private-agent-access.json"))).toThrow(
      "External-agent credential state must be outside the statically served dist/ and public/ trees.",
    );
  });

  it("rejects an existing credential-path symlink whose final target is publicly served", async () => {
    const path = await makePath();
    await symlink(join(process.cwd(), "public", "favicon.svg"), path);
    expect(() => new AgentAccessStore(path)).toThrow(
      "External-agent credential state must be outside the statically served dist/ and public/ trees.",
    );
  });

  it("rejects a missing nested credential path below a symlink into a static tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-agent-path-"));
    directories.push(directory);
    const alias = join(directory, "static-alias");
    await symlink(join(process.cwd(), "public"), alias);

    expect(() => new AgentAccessStore(join(alias, "not-created-yet", "agent-access.json"))).toThrow(
      "External-agent credential state must be outside the statically served dist/ and public/ trees.",
    );
  });

  it("atomically migrates strict v1 state, scrubs private prompts and preserves actor credentials and access", async () => {
    const path = await makePath();
    const activeToken = agentToken(1);
    const revokedToken = agentToken(2);
    const createdAt = "2026-07-21T08:00:00.000Z";
    const activeUpdatedAt = "2026-07-21T09:00:00.000Z";
    const revokedAt = "2026-07-21T10:00:00.000Z";
    const privateSentinel = "PRIVATE OWNER PROMPT THAT MUST BE SCRUBBED";
    await writeFile(path, `${JSON.stringify({
      version: 1,
      agents: [
        {
          id: "agent-legacy-active",
          displayName: "Legacy Active",
          publicBio: "Still here after migration.",
          personalityPrompt: privateSentinel,
          ...access(["lobby"]),
          tokenDigest: createHash("sha256").update(activeToken).digest("hex"),
          createdAt,
          updatedAt: activeUpdatedAt,
        },
        {
          id: "agent-legacy-revoked",
          displayName: "Legacy Revoked",
          publicBio: "A retained historical identity.",
          personalityPrompt: "Another private prompt.",
          ...access(["the-pub"]),
          tokenDigest: createHash("sha256").update(revokedToken).digest("hex"),
          createdAt,
          updatedAt: revokedAt,
          revokedAt,
        },
      ],
    }, null, 2)}\n`, "utf8");

    const store = new AgentAccessStore(path, { now: () => Date.parse("2026-07-22T08:00:00.000Z") });
    // Nothing from disk is exposed before the awaited load/migration barrier.
    expect(store.list()).toEqual([]);
    await store.load();

    const persisted = await readFile(path, "utf8");
    const parsed = JSON.parse(persisted) as Record<string, unknown>;
    expect(parsed.version).toBe(2);
    expect(parsed).toMatchObject({ invitations: [] });
    expect(persisted).not.toContain("personalityPrompt");
    expect(persisted).not.toContain(privateSentinel);
    expect(persisted).not.toContain(activeToken);
    const backups = (await readdir(join(path, ".."))).filter((name) =>
      name.startsWith("agent-access.json.pre-v2-from-1-") && name.endsWith(".bak")
    );
    expect(backups).toHaveLength(1);
    const backup = await readFile(join(path, "..", backups[0]!), "utf8");
    expect(backup).toContain(privateSentinel);
    expect(JSON.parse(backup)).toMatchObject({ version: 1 });
    expect(store.authenticate(activeToken)).toMatchObject({
      id: "agent-legacy-active",
      displayName: "Legacy Active",
      channelIds: ["lobby"],
    });
    expect(Date.parse(store.get("agent-legacy-active")!.updatedAt)).toBeGreaterThan(Date.parse(activeUpdatedAt));
    expect(store.get("agent-legacy-revoked")).toMatchObject({ id: "agent-legacy-revoked", revokedAt });
    expect(store.authenticate(revokedToken)).toBeUndefined();
    expect(JSON.stringify(store.list())).not.toContain(privateSentinel);

    const restarted = new AgentAccessStore(path);
    await restarted.load();
    expect(restarted.authenticate(activeToken)?.id).toBe("agent-legacy-active");
    expect(restarted.get("agent-legacy-revoked")?.id).toBe("agent-legacy-revoked");
  });

  it("issues a bounded one-time invitation while persisting only its digest", async () => {
    const path = await makePath();
    const plaintext = invitationToken(3);
    const now = Date.UTC(2026, 6, 22, 8);
    const store = new AgentAccessStore(path, {
      now: () => now,
      randomId: () => "reserved-owner",
      randomInvitationId: () => "first",
      randomInvitationToken: () => plaintext,
    });
    await store.load();
    const issued = await store.createInvitation(enrollmentInvitation());

    expect(issued).toMatchObject({
      token: plaintext,
      invitation: {
        id: "agent-invite-first",
        agentId: "agent-reserved-owner",
        status: "pending",
        purpose: "enroll",
      },
    });
    expect(Date.parse(issued!.invitation.expiresAt) - now).toBe(
      EXTERNAL_AGENT_INVITATION_DEFAULT_EXPIRY_MINUTES * 60_000,
    );
    expect(store.authenticateInvitation(plaintext)).toEqual(issued!.invitation);
    expect(store.authenticate(plaintext)).toBeUndefined();

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(plaintext);
    expect(JSON.parse(persisted).invitations[0].tokenDigest).toBe(
      createHash("sha256").update(plaintext).digest("hex"),
    );
    expect(JSON.stringify(store.listInvitations())).not.toContain("tokenDigest");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("enforces the five-minute to twenty-four-hour invitation window and expires at the exact boundary", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 22, 8);
    const store = new AgentAccessStore(path, {
      now: () => now,
      randomId: () => "expiring",
      randomInvitationId: () => "expiring",
      randomInvitationToken: () => invitationToken(4),
      randomToken: () => agentToken(4),
    });
    await store.load();
    await expect(store.createInvitation(enrollmentInvitation({
      expiresInMinutes: EXTERNAL_AGENT_INVITATION_MIN_EXPIRY_MINUTES - 1,
    }))).rejects.toThrow();
    await expect(store.createInvitation(enrollmentInvitation({
      expiresInMinutes: EXTERNAL_AGENT_INVITATION_MAX_EXPIRY_MINUTES + 1,
    }))).rejects.toThrow();

    const issued = await store.createInvitation(enrollmentInvitation({
      expiresInMinutes: EXTERNAL_AGENT_INVITATION_MIN_EXPIRY_MINUTES,
    }));
    now = Date.parse(issued!.invitation.expiresAt);
    expect(store.authenticateInvitation(issued!.token)).toBeUndefined();
    expect(store.getInvitation(issued!.invitation.id)?.status).toBe("expired");
    expect(await store.redeemInvitation(issued!.token, profile())).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("revokes an invitation without exposing it and keeps the terminal tombstone after restart", async () => {
    const path = await makePath();
    const secret = invitationToken(5);
    const store = new AgentAccessStore(path, {
      randomId: () => "revoked-invite",
      randomInvitationId: () => "revoked",
      randomInvitationToken: () => secret,
    });
    await store.load();
    const issued = await store.createInvitation(enrollmentInvitation());
    const revoked = await store.revokeInvitation(issued!.invitation.id);

    expect(revoked).toMatchObject({ status: "revoked" });
    expect(store.authenticateInvitation(secret)).toBeUndefined();
    expect(await store.redeemInvitation(secret, profile())).toBeUndefined();
    expect(await store.revokeInvitation("agent-invite-missing")).toBeUndefined();

    const restarted = new AgentAccessStore(path);
    await restarted.load();
    expect(restarted.getInvitation(issued!.invitation.id)).toMatchObject({ status: "revoked" });
    expect(restarted.authenticateInvitation(secret)).toBeUndefined();
  });

  it("redeems atomically so exactly one concurrent replay receives the final credential", async () => {
    const path = await makePath();
    const invite = invitationToken(6);
    const finalToken = agentToken(6);
    const store = new AgentAccessStore(path, {
      randomId: () => "atomic-owner",
      randomInvitationId: () => "atomic",
      randomInvitationToken: () => invite,
      randomToken: () => finalToken,
    });
    await store.load();
    const issued = await store.createInvitation(enrollmentInvitation());
    const attempts = await Promise.all([
      store.redeemInvitation(invite, profile("Patchwork")),
      store.redeemInvitation(invite, profile("Patchwork")),
      store.redeemInvitation(invite, profile("Patchwork")),
    ]);
    const successful = attempts.filter((attempt) => attempt !== undefined);

    expect(successful).toHaveLength(1);
    expect(successful[0]).toMatchObject({
      token: finalToken,
      agent: { id: issued!.invitation.agentId, displayName: "Patchwork" },
      invitation: { status: "redeemed" },
    });
    expect(store.authenticateInvitation(invite)).toBeUndefined();
    expect(store.authenticate(finalToken)?.id).toBe(issued!.invitation.agentId);
    expect(store.list()).toHaveLength(1);

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(invite);
    expect(persisted).not.toContain(finalToken);
    expect(persisted).not.toContain("personalityPrompt");
    const restarted = new AgentAccessStore(path);
    await restarted.load();
    expect(restarted.authenticate(finalToken)?.displayName).toBe("Patchwork");
    expect(restarted.getInvitation(issued!.invitation.id)?.status).toBe("redeemed");
  });

  it("does not consume the invitation when the owner profile is invalid or contains private prompt fields", async () => {
    const path = await makePath();
    const invite = invitationToken(7);
    const store = new AgentAccessStore(path, {
      randomId: () => "validation",
      randomInvitationId: () => "validation",
      randomInvitationToken: () => invite,
      randomToken: () => agentToken(7),
    });
    await store.load();
    await store.createInvitation(enrollmentInvitation());

    await expect(store.redeemInvitation(invite, {
      ...profile(),
      personalityPrompt: "This must stay in the owner runtime.",
    } as Parameters<AgentAccessStore["redeemInvitation"]>[1])).rejects.toThrow();
    await expect(store.redeemInvitation(invite, { displayName: "", publicBio: "" })).rejects.toThrow();
    expect(store.authenticateInvitation(invite)?.status).toBe("pending");

    const redeemed = await store.redeemInvitation(invite, profile("Valid Owner Agent"));
    expect(redeemed?.agent.displayName).toBe("Valid Owner Agent");
  });

  it("reconnects a retained actor atomically without letting a stale handoff overwrite profile or host policy", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 22, 8);
    const invitationTokens = [invitationToken(8), invitationToken(9)];
    const agentTokens = [agentToken(8), agentToken(9)];
    const ids = ["initial", "unused"];
    const invitationIds = ["enroll", "reconnect"];
    const store = new AgentAccessStore(path, {
      now: () => now,
      randomId: () => ids.shift()!,
      randomInvitationId: () => invitationIds.shift()!,
      randomInvitationToken: () => invitationTokens.shift()!,
      randomToken: () => agentTokens.shift()!,
    });
    await store.load();
    const firstInvite = await store.createInvitation(enrollmentInvitation());
    const first = await store.redeemInvitation(firstInvite!.token, profile("Original Voice"));
    const originalCreatedAt = first!.agent.createdAt;
    now += 1_000;
    await store.revoke(first!.agent.id);

    now += 1_000;
    const reconnect = await store.createInvitation({
      purpose: "reconnect",
      agentId: first!.agent.id,
      adminLabel: "Return Original Voice",
      ...access(["the-pub"]),
      scopes: ["rooms:read", "messages:write"],
    });
    expect(reconnect?.invitation.agentId).toBe(first!.agent.id);
    expect(reconnect?.invitation).toMatchObject({
      channelIds: ["lobby", "ai-hacking"],
      scopes: ["rooms:read", "messages:write", "reactions:write"],
    });
    // A later host reduction wins over the stale policy snapshot embedded in
    // the already-issued reconnect invitation.
    await store.updateAccess(first!.agent.id, {
      channelIds: ["lobby"],
      scopes: ["rooms:read"],
    });
    now += 1_000;
    const restored = await store.redeemInvitation(reconnect!.token, {
      displayName: "Original Voice Returns",
      publicBio: "Same actor, owner-refreshed public profile.",
    });

    expect(restored).toMatchObject({
      token: agentToken(9),
      agent: {
        id: first!.agent.id,
        displayName: "Original Voice",
        publicBio: "A curious visitor operated outside The Third Place.",
        channelIds: ["lobby"],
        scopes: ["rooms:read"],
        createdAt: originalCreatedAt,
      },
      invitation: { purpose: "reconnect", status: "redeemed" },
    });
    expect(restored!.agent.revokedAt).toBeUndefined();
    expect(store.authenticate(agentToken(8))).toBeUndefined();
    expect(store.authenticate(agentToken(9))?.id).toBe(first!.agent.id);
    expect(store.list()).toHaveLength(1);
    expect(await store.redeemInvitation(reconnect!.token, profile("Replay"))).toBeUndefined();
  });

  it("invalidates every older reconnect invitation when the actor is revoked", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 22, 8);
    const invitationTokens = [invitationToken(21), invitationToken(22), invitationToken(23)];
    const agentTokens = [agentToken(21), agentToken(22)];
    const invitationIds = ["enroll-before-revoke", "stale-reconnect", "fresh-reconnect"];
    const store = new AgentAccessStore(path, {
      now: () => now,
      randomId: () => "revoke-barrier",
      randomInvitationId: () => invitationIds.shift()!,
      randomInvitationToken: () => invitationTokens.shift()!,
      randomToken: () => agentTokens.shift()!,
    });
    await store.load();
    const enrollment = await store.createInvitation(enrollmentInvitation());
    const enrolled = await store.redeemInvitation(enrollment!.token, profile("Revocation Barrier"));
    now += 1_000;
    const staleReconnect = await store.createInvitation({
      purpose: "reconnect",
      agentId: enrolled!.agent.id,
      adminLabel: "Issued before explicit revocation",
      ...access(["lobby"]),
    });

    now += 1_000;
    await store.revoke(enrolled!.agent.id);
    expect(store.getInvitation(staleReconnect!.invitation.id)?.status).toBe("revoked");
    expect(await store.redeemInvitation(staleReconnect!.token, profile("Must Stay Revoked"))).toBeUndefined();
    expect(store.authenticate(enrolled!.token)).toBeUndefined();

    // A deliberate reconnect invitation issued by Admin after revocation can
    // still restore the same stable actor with a newly disclosed credential.
    now += 1_000;
    const freshReconnect = await store.createInvitation({
      purpose: "reconnect",
      agentId: enrolled!.agent.id,
      adminLabel: "Issued after explicit revocation",
      ...access(["lobby"]),
    });
    now += 1_000;
    const restored = await store.redeemInvitation(freshReconnect!.token, profile("Revocation Barrier"));
    expect(restored?.agent.id).toBe(enrolled!.agent.id);
    expect(restored?.agent.revokedAt).toBeUndefined();
    expect(store.authenticate(restored!.token)?.id).toBe(enrolled!.agent.id);
  });

  it("keeps owner profile and host access mutations structurally separate", async () => {
    const path = await makePath();
    const bearer = agentToken(10);
    const store = new AgentAccessStore(path, {
      randomId: () => "separated",
      randomInvitationId: () => "separated",
      randomInvitationToken: () => invitationToken(10),
      randomToken: () => bearer,
    });
    await store.load();
    const invitation = await store.createInvitation(enrollmentInvitation());
    const redeemed = await store.redeemInvitation(invitation!.token, profile("Owner Profile"));
    const originalAccess = {
      channelIds: redeemed!.agent.channelIds,
      scopes: redeemed!.agent.scopes,
    };

    const profileUpdated = await store.updateProfile(redeemed!.agent.id, {
      displayName: "Owner Updated",
      publicBio: "Public owner-controlled copy.",
    });
    expect(profileUpdated).toMatchObject({ ...originalAccess, displayName: "Owner Updated" });
    expect(store.authenticate(bearer)?.displayName).toBe("Owner Updated");
    await expect(store.updateProfile(redeemed!.agent.id, {
      channelIds: ["secret-room"],
    } as Parameters<AgentAccessStore["updateProfile"]>[1])).rejects.toThrow();
    await expect(store.updateProfile(redeemed!.agent.id, {
      personalityPrompt: "Never accepted here.",
    } as Parameters<AgentAccessStore["updateProfile"]>[1])).rejects.toThrow();

    const accessUpdated = await store.updateAccess(redeemed!.agent.id, {
      channelIds: ["the-pub"],
      scopes: ["rooms:read"],
    });
    expect(accessUpdated).toMatchObject({
      displayName: "Owner Updated",
      publicBio: "Public owner-controlled copy.",
      channelIds: ["the-pub"],
      scopes: ["rooms:read"],
    });
    await expect(store.updateAccess(redeemed!.agent.id, {
      ...access(["lobby"]),
      displayName: "Host must not rewrite owner profile",
    } as Parameters<AgentAccessStore["updateAccess"]>[1])).rejects.toThrow();
  });

  it("touches and revokes credentials without changing stable identity or public profile", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 22, 8);
    const finalTokens = [agentToken(11)];
    const store = new AgentAccessStore(path, {
      now: () => now,
      randomId: () => "lifecycle",
      randomInvitationId: () => "lifecycle",
      randomInvitationToken: () => invitationToken(11),
      randomToken: () => finalTokens.shift()!,
      touchPersistenceIntervalMs: 0,
    });
    await store.load();
    const invitation = await store.createInvitation(enrollmentInvitation());
    const first = await store.redeemInvitation(invitation!.token, profile("Lifecycle"));

    now += 1_000;
    expect((await store.touch(first!.agent.id))?.lastSeenAt).toBe(new Date(now).toISOString());
    now += 1_000;
    const revoked = await store.revoke(first!.agent.id);
    expect(revoked?.revokedAt).toBe(new Date(now).toISOString());
    expect(store.authenticate(first!.token)).toBeUndefined();
    expect(await store.updateProfile(first!.agent.id, { publicBio: "Blocked while revoked." })).toBeUndefined();

    expect(await store.touch("agent-missing")).toBeUndefined();
    expect(await store.revoke("agent-missing")).toBeUndefined();
    expect(await store.updateProfile("agent-missing", { publicBio: "Missing" })).toBeUndefined();
    expect(await store.updateAccess("agent-missing", access())).toBeUndefined();
  });

  it("bounds retained actors and pending reservations while compacting the oldest invitation tombstone", async () => {
    const actorIds = ["first-slot", "second-slot", "third-slot"];
    const store = new AgentAccessStore(await makePath(), {
      maxRecords: 1,
      maxInvitations: 2,
      randomId: () => actorIds.shift()!,
      randomInvitationId: (() => {
        const values = ["first", "second", "third"];
        return () => values.shift()!;
      })(),
      randomInvitationToken: (() => {
        const values = [invitationToken(13), invitationToken(14), invitationToken(15)];
        return () => values.shift()!;
      })(),
    });
    await store.load();
    const first = await store.createInvitation(enrollmentInvitation());
    await expect(store.createInvitation(enrollmentInvitation({ adminLabel: "No free actor slot" })))
      .rejects.toBeInstanceOf(AgentAccessStoreCapacityError);
    await store.revokeInvitation(first!.invitation.id);
    // The revoked invitation is a tombstone but no longer reserves its actor slot.
    const second = await store.createInvitation(enrollmentInvitation({ adminLabel: "Second invitation" }));
    expect(second?.invitation.status).toBe("pending");
    await store.revokeInvitation(second!.invitation.id);
    const third = await store.createInvitation(enrollmentInvitation({ adminLabel: "Compacts old tombstone" }));
    expect(third?.invitation.status).toBe("pending");
    expect(store.listInvitations().map((invitation) => invitation.id)).toEqual([
      second!.invitation.id,
      third!.invitation.id,
    ]);
    expect(store.getInvitation(first!.invitation.id)).toBeUndefined();
  });

  it("rejects malformed, oversized and prompt-bearing v2 state without replacing it", async () => {
    const corruptPath = await makePath();
    const corrupt = '{"version":2,"agents":[{"token":"plaintext"}],"invitations":[]}\n';
    await writeFile(corruptPath, corrupt, "utf8");
    const corruptStore = new AgentAccessStore(corruptPath);
    await expect(corruptStore.load()).rejects.toBeInstanceOf(AgentAccessStoreLoadError);
    expect(await readFile(corruptPath, "utf8")).toBe(corrupt);

    const promptPath = await makePath();
    const token = agentToken(16);
    const promptBearing = `${JSON.stringify({
      version: 2,
      agents: [{
        id: "agent-prompt-bearing",
        ...profile("Prompt Bearing"),
        ...access(["lobby"]),
        personalityPrompt: "This field is forbidden in v2.",
        tokenDigest: createHash("sha256").update(token).digest("hex"),
        createdAt: "2026-07-22T08:00:00.000Z",
        updatedAt: "2026-07-22T08:00:00.000Z",
      }],
      invitations: [],
    })}\n`;
    await writeFile(promptPath, promptBearing, "utf8");
    await expect(new AgentAccessStore(promptPath).load()).rejects.toBeInstanceOf(AgentAccessStoreLoadError);
    expect(await readFile(promptPath, "utf8")).toBe(promptBearing);

    const oversizedPath = await makePath();
    await writeFile(oversizedPath, "x".repeat(2 * 1_024 * 1_024 + 1), "utf8");
    await expect(new AgentAccessStore(oversizedPath).load()).rejects.toBeInstanceOf(AgentAccessStoreLoadError);
  });

  it("restores restrictive file permissions on a valid v2 catalog", async () => {
    const path = await makePath();
    const source = new AgentAccessStore(path);
    await source.load();
    await chmod(path, 0o644);
    const restored = new AgentAccessStore(path);
    await restored.load();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
