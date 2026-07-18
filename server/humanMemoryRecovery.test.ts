import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Member } from "../shared/types.js";
import {
  generateHumanIdentityRecoveryKey,
  hashHumanIdentityRecoveryKey,
} from "./humanIdentityRecovery.js";
import { HumanMemoryLoadError, HumanMemoryStore } from "./humanMemory.js";

const tokenHash = (value: string): string => createHash("sha256").update(value).digest("hex");

const member = (id: string, name: string): Member => ({
  id,
  name,
  kind: "human",
  status: "online",
  avatar: { color: "#123456", accent: "#abcdef", glyph: name[0] ?? "?" },
  role: "Guest",
  bio: "A real person visiting The Third Place.",
});

const tempStore = async (): Promise<{ filePath: string; store: HumanMemoryStore }> => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-human-recovery-"));
  const filePath = join(directory, "human-memory.json");
  const store = new HumanMemoryStore({ filePath, persistDelayMs: 60_000 });
  await store.load();
  return { filePath, store };
};

describe("persistent human recovery identity", () => {
  it("persists only a digest and exposes recovery capability as a boolean", async () => {
    const { filePath, store } = await tempStore();
    const key = generateHumanIdentityRecoveryKey();
    const digest = hashHumanIdentityRecoveryKey(key);
    const sessionHash = tokenHash("visitor-session");
    store.upsertSession({ tokenHash: sessionHash, member: member("human-visitor", "Visitor"), seenAt: 1_000 });

    expect(store.hasRecoveryKey("human-visitor")).toBe(false);
    expect(store.replaceRecoveryKeyHash("human-visitor", digest)).toBeUndefined();
    expect(store.hasRecoveryKey("human-visitor")).toBe(true);
    const snapshot = store.findByHumanId("human-visitor")!;
    expect(snapshot.recoveryConfigured).toBe(true);
    expect(snapshot).not.toHaveProperty("recoveryKeyHash");
    expect(JSON.stringify(snapshot)).not.toContain(digest);
    expect(store.listRestorableProfiles()[0]).not.toHaveProperty("recoveryKeyHash");
    await store.flush();

    const serialized = await readFile(filePath, "utf8");
    expect(serialized).toContain(digest);
    expect(serialized).not.toContain(key);

    const restarted = new HumanMemoryStore({ filePath, persistDelayMs: 60_000, now: () => 2_000 });
    await restarted.load();
    expect(restarted.hasRecoveryKey("human-visitor")).toBe(true);
    expect(restarted.findByRecoveryKey("  ｖｉｓｉｔｏｒ  ", digest)).toMatchObject({
      tokenHash: sessionHash,
      member: { id: "human-visitor", name: "Visitor" },
      recoveryConfigured: true,
    });
    expect(restarted.findByRecoveryKey("Visitor", tokenHash("wrong recovery key"))).toBeUndefined();

    const replacementDigest = hashHumanIdentityRecoveryKey(generateHumanIdentityRecoveryKey());
    expect(restarted.replaceRecoveryKeyHash("human-visitor", replacementDigest)).toBe(digest);
    expect(restarted.replaceRecoveryKeyHash("human-visitor", digest)).toBe(replacementDigest);
    expect(restarted.replaceRecoveryKeyHash("human-visitor", undefined)).toBe(digest);
    expect(restarted.hasRecoveryKey("human-visitor")).toBe(false);
    expect(restarted.findByHumanId("human-visitor")?.recoveryConfigured).toBe(false);
  });

  it("uses the secret to disambiguate legacy compatibility-caseless identities", async () => {
    const { store } = await tempStore();
    const firstDigest = hashHumanIdentityRecoveryKey(generateHumanIdentityRecoveryKey());
    const secondDigest = hashHumanIdentityRecoveryKey(generateHumanIdentityRecoveryKey());
    store.upsertSession({
      tokenHash: tokenHash("first-per-session"),
      member: member("human-per-one", "Per"),
    });
    store.replaceRecoveryKeyHash("human-per-one", firstDigest);
    store.upsertSession({
      tokenHash: tokenHash("second-per-session"),
      member: member("human-per-two", "ｐｅｒ"),
    });
    store.replaceRecoveryKeyHash("human-per-two", secondDigest);

    expect(store.findByRecoveryKey("per", firstDigest)?.member.id).toBe("human-per-one");
    expect(store.findByRecoveryKey("P_E-R", secondDigest)?.member.id).toBe("human-per-two");
    store.replaceRecoveryKeyHash("human-per-two", firstDigest);
    expect(store.findByRecoveryKey("per", firstDigest)).toBeUndefined();
    expect(store.findByRecoveryKey("missing", firstDigest)).toBeUndefined();
    expect(store.findByRecoveryKey("not/a/display/name", firstDigest)).toBeUndefined();
  });

  it("rotates an expected session digest without changing actor memory", async () => {
    const { filePath, store } = await tempStore();
    const oldSessionHash = tokenHash("old-session");
    const nextSessionHash = tokenHash("next-session");
    const recoveryDigest = hashHumanIdentityRecoveryKey(generateHumanIdentityRecoveryKey());
    store.upsertSession({
      tokenHash: oldSessionHash,
      member: member("human-stable", "Stable"),
      seenAt: 1_000,
    });
    store.replaceRecoveryKeyHash("human-stable", recoveryDigest);
    store.noteVisit("human-stable", 1_000);
    store.notePublicMessage("human-stable", "lobby", "hello", 1_500);
    store.updateRelation("human-stable", "ai-mira", { familiarity: 0.4, affinity: 0.3 }, 1_700);
    const before = store.findByHumanId("human-stable")!;

    const rotated = store.rotateSessionToken(
      "human-stable",
      oldSessionHash.toUpperCase(),
      nextSessionHash.toUpperCase(),
      2_000,
    );
    expect(rotated).toMatchObject({
      tokenHash: nextSessionHash,
      member: { id: "human-stable", name: "Stable" },
      createdAt: before.createdAt,
      lastSeenAt: 2_000,
      visitCount: before.visitCount,
      facts: before.facts,
      channelScores: before.channelScores,
      relations: before.relations,
      recoveryConfigured: true,
    });
    expect(store.findByTokenHash(oldSessionHash)).toBeUndefined();
    expect(store.findByTokenHash(nextSessionHash)?.member.id).toBe("human-stable");
    expect(store.findByRecoveryKey("stable", recoveryDigest)?.tokenHash).toBe(nextSessionHash);
    expect(store.rotateSessionToken("human-stable", oldSessionHash, tokenHash("stale-attempt"))).toBeUndefined();
    expect(store.findByTokenHash(nextSessionHash)?.member.id).toBe("human-stable");
    expect(store.rotateSessionToken("human-stable", nextSessionHash, oldSessionHash, 2_100)?.tokenHash).toBe(oldSessionHash);
    expect(store.rotateSessionToken("human-stable", oldSessionHash, nextSessionHash, 2_200)?.tokenHash).toBe(nextSessionHash);
    await store.flush();

    const restarted = new HumanMemoryStore({ filePath, persistDelayMs: 60_000, now: () => 3_000 });
    await restarted.load();
    expect(restarted.findByTokenHash(oldSessionHash)).toBeUndefined();
    expect(restarted.findByTokenHash(nextSessionHash)).toMatchObject({
      member: { id: "human-stable" },
      recoveryConfigured: true,
    });
  });

  it("rejects token collisions and malformed recovery digests without mutation", async () => {
    const { store } = await tempStore();
    const firstToken = tokenHash("first-token");
    const secondToken = tokenHash("second-token");
    store.upsertSession({ tokenHash: firstToken, member: member("human-first", "First") });
    store.upsertSession({ tokenHash: secondToken, member: member("human-second", "Second") });

    expect(store.rotateSessionToken("human-first", firstToken, secondToken)).toBeUndefined();
    expect(store.rotateSessionToken("human-first", firstToken, firstToken)).toBeUndefined();
    expect(store.findByTokenHash(firstToken)?.member.id).toBe("human-first");
    expect(store.findByTokenHash(secondToken)?.member.id).toBe("human-second");
    expect(() => store.replaceRecoveryKeyHash("human-first", "not-a-digest")).toThrow(TypeError);
    expect(store.hasRecoveryKey("human-first")).toBe(false);
  });

  it("migrates every v1 credential and social field into the v2 split schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-human-v1-migration-"));
    const filePath = join(directory, "human-memory.json");
    const sessionDigest = tokenHash("v1-session");
    const recoveryDigest = hashHumanIdentityRecoveryKey(generateHumanIdentityRecoveryKey());
    await writeFile(filePath, JSON.stringify({
      version: 1,
      continuityVerified: true,
      pendingActorForgetIds: [],
      profiles: [{
        tokenHash: sessionDigest,
        recoveryKeyHash: recoveryDigest,
        member: member("human-v1", "Version One"),
        createdAt: 100,
        lastSeenAt: 200,
        visitCount: 3,
        lastVisitAt: 180,
        facts: [{
          kind: "likes",
          value: "Rust",
          channelId: "ai-programming",
          learnedAt: 120,
          lastConfirmedAt: 150,
        }],
        channelScores: [{ channelId: "ai-programming", messageCount: 8, lastActiveAt: 175 }],
        relations: [{ personaId: "ai-mira", familiarity: 0.7, affinity: 0.3, irritation: 0.1, updatedAt: 190 }],
      }],
    }), "utf8");

    const migrated = new HumanMemoryStore({ filePath, now: () => 250, persistDelayMs: 60_000 });
    await migrated.load();
    expect(migrated.findByRecoveryKey("Version One", recoveryDigest)).toMatchObject({
      tokenHash: sessionDigest,
      member: { id: "human-v1", name: "Version One" },
      createdAt: 100,
      lastSeenAt: 200,
      visitCount: 3,
      lastVisitAt: 180,
      facts: [expect.objectContaining({ kind: "likes", value: "Rust", learnedAt: 120 })],
      channelScores: [expect.objectContaining({ channelId: "ai-programming", messageCount: 8 })],
      relations: { "ai-mira": expect.objectContaining({ familiarity: 0.7, affinity: 0.3 }) },
      recoveryConfigured: true,
    });

    const v2 = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      profiles: Array<Record<string, unknown>>;
    };
    expect(v2.version).toBe(2);
    expect(v2.profiles[0]).toMatchObject({
      credential: { tokenHash: sessionDigest, recoveryKeyHash: recoveryDigest },
      visitCount: 3,
    });
    expect(v2.profiles[0]).not.toHaveProperty("tokenHash");
    expect(v2.profiles[0]).not.toHaveProperty("recoveryKeyHash");
  });

  it("detaches a legacy credential on account conversion without deleting actor memory", async () => {
    const { filePath, store } = await tempStore();
    const sessionDigest = tokenHash("convert-session");
    const recoveryDigest = hashHumanIdentityRecoveryKey(generateHumanIdentityRecoveryKey());
    store.upsertSession({
      tokenHash: sessionDigest,
      member: member("human-convert", "Convert"),
      seenAt: 1_000,
    });
    store.replaceRecoveryKeyHash("human-convert", recoveryDigest);
    store.noteVisit("human-convert", 1_000);
    store.notePublicMessage("human-convert", "lobby", "hello", 1_100);
    store.updateRelation("human-convert", "ai-mira", { familiarity: 0.6, affinity: 0.5 }, 1_200);

    expect(store.detachCredential("human-convert", tokenHash("wrong"))).toBeUndefined();
    expect(store.findByTokenHash(sessionDigest)?.member.id).toBe("human-convert");
    const detached = store.detachCredential("human-convert", sessionDigest.toUpperCase());
    expect(detached).toEqual({ tokenHash: sessionDigest, recoveryKeyHash: recoveryDigest });
    expect(store.detachCredential("human-convert")).toBeUndefined();
    expect(store.findByTokenHash(sessionDigest)).toBeUndefined();
    expect(store.findByRecoveryKey("Convert", recoveryDigest)).toBeUndefined();
    expect(store.listRestorableProfiles()).toEqual([]);
    expect(store.findByHumanId("human-convert")).toMatchObject({
      visitCount: 1,
      channelScores: [expect.objectContaining({ channelId: "lobby", messageCount: 1 })],
      relations: { "ai-mira": expect.objectContaining({ affinity: 0.5 }) },
      recoveryConfigured: false,
    });
    expect(store.findByHumanId("human-convert")).not.toHaveProperty("tokenHash");

    expect(detached && store.restoreCredential("human-convert", detached)).toBe(true);
    expect(store.findByTokenHash(sessionDigest)?.member.id).toBe("human-convert");
    expect(store.findByRecoveryKey("Convert", recoveryDigest)?.member.id).toBe("human-convert");
    expect(detached && store.restoreCredential("human-convert", detached)).toBe(false);
    const detachedAgain = store.detachCredential("human-convert", sessionDigest);
    expect(detachedAgain).toEqual(detached);
    await store.flush();

    const restarted = new HumanMemoryStore({ filePath, now: () => 2_000, persistDelayMs: 60_000 });
    await restarted.load();
    expect(restarted.listRestorableProfiles()).toEqual([]);
    expect(restarted.findByHumanId("human-convert")).toMatchObject({
      member: { id: "human-convert", name: "Convert" },
      visitCount: 1,
      relations: { "ai-mira": expect.objectContaining({ familiarity: 0.6 }) },
      recoveryConfigured: false,
    });
  });

  it("loads credentialed profiles without a recovery key and fails closed on a malformed v2 credential", async () => {
    const { filePath, store } = await tempStore();
    store.upsertSession({
      tokenHash: tokenHash("legacy-session"),
      member: member("human-legacy", "Legacy"),
      seenAt: 1_000,
    });
    await store.flush();

    const legacy = new HumanMemoryStore({ filePath, persistDelayMs: 60_000, now: () => 2_000 });
    await legacy.load();
    expect(legacy.findByHumanId("human-legacy")?.recoveryConfigured).toBe(false);
    expect(legacy.hasRecoveryKey("human-legacy")).toBe(false);

    const payload = JSON.parse(await readFile(filePath, "utf8")) as {
      profiles: Array<Record<string, unknown>>;
    };
    (payload.profiles[0]!.credential as Record<string, unknown>).recoveryKeyHash = "malformed";
    const malformedBytes = JSON.stringify(payload);
    await writeFile(filePath, malformedBytes, "utf8");
    const malformed = new HumanMemoryStore({ filePath, persistDelayMs: 60_000 });
    await expect(malformed.load()).rejects.toBeInstanceOf(HumanMemoryLoadError);
    expect(await readFile(filePath, "utf8")).toBe(malformedBytes);
    expect(malformed.listRestorableProfiles()).toEqual([]);
  });
});
