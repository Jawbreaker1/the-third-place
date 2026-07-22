import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_BEARER_TOKEN_PREFIX,
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

const token = (byte: number): string =>
  `${AGENT_BEARER_TOKEN_PREFIX}${Buffer.alloc(32, byte).toString("base64url")}`;

const input = (displayName = "Field Agent") => ({
  displayName,
  publicBio: "A curious visitor operated outside The Third Place.",
  personalityPrompt: "Be observant, understated, warm, and keep my dry sense of humour.",
  channelIds: ["lobby", "ai-hacking"],
  scopes: ["rooms:read", "messages:write", "reactions:write"] as const,
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("external-agent access store", () => {
  it.each(["dist", "public"])("rejects credential state inside the statically served %s tree", (directory) => {
    expect(() => new AgentAccessStore(join(process.cwd(), directory, "private-agent-access.json"))).toThrow(
      "External-agent credential state must be outside the statically served dist/ and public/ trees.",
    );
  });

  it("persists only a digest and authenticates the private self after restart", async () => {
    const path = await makePath();
    const plaintext = token(7);
    const store = new AgentAccessStore(path, {
      randomId: () => "persistent",
      randomToken: () => plaintext,
    });
    await store.load();
    const issued = await store.create(input());

    expect(issued).toMatchObject({
      token: plaintext,
      agent: {
        id: "agent-persistent",
        displayName: "Field Agent",
        personalityPrompt: input().personalityPrompt,
      },
    });
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(plaintext);
    expect(JSON.parse(persisted).agents[0].tokenDigest).toBe(
      createHash("sha256").update(plaintext, "utf8").digest("hex"),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const restored = new AgentAccessStore(path);
    await restored.load();
    expect(restored.authenticate(plaintext)).toEqual(issued.agent);
    expect(restored.authenticate(token(8))).toBeUndefined();
    expect(restored.authenticate("not-a-token")).toBeUndefined();
  });

  it("never exposes credentials or private personality through list and exposes no digest through detail", async () => {
    const path = await makePath();
    const plaintext = token(9);
    const store = new AgentAccessStore(path, {
      randomId: () => "private-projection",
      randomToken: () => plaintext,
    });
    await store.load();
    await store.create(input("Quiet Visitor"));

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("personalityPrompt");
    expect(JSON.stringify(listed)).not.toContain(plaintext);
    expect(JSON.stringify(listed)).not.toContain("tokenDigest");

    const detail = store.get("agent-private-projection");
    expect(detail?.personalityPrompt).toBe(input().personalityPrompt);
    expect(JSON.stringify(detail)).not.toContain(plaintext);
    expect(JSON.stringify(detail)).not.toContain("tokenDigest");
    listed[0]!.channelIds.push("mutation-attempt");
    listed[0]!.scopes.splice(0);
    expect(store.list()[0]).toMatchObject({
      channelIds: ["lobby", "ai-hacking"],
      scopes: ["rooms:read", "messages:write", "reactions:write"],
    });
  });

  it("canonicalizes administrator text and rejects empty, duplicate or unknown access grants", async () => {
    const path = await makePath();
    const store = new AgentAccessStore(path, {
      randomId: () => "canonical",
      randomToken: () => token(10),
    });
    await store.load();
    const issued = await store.create({
      ...input(),
      displayName: "  Field   Agent  ",
      publicBio: "  First line.\r\nSecond line.  ",
      personalityPrompt: "  Keep my voice.\r\nDo not flatten it.  ",
    });
    expect(issued.agent).toMatchObject({
      displayName: "Field Agent",
      publicBio: "First line.\nSecond line.",
      personalityPrompt: "Keep my voice.\nDo not flatten it.",
    });

    await expect(store.create({ ...input("No Rooms"), channelIds: [] })).rejects.toThrow();
    await expect(store.create({ ...input("Duplicate Room"), channelIds: ["lobby", "lobby"] })).rejects.toThrow();
    await expect(store.create({
      ...input("Unknown Scope"),
      scopes: ["rooms:read", "everything:admin" as "rooms:read"],
    })).rejects.toThrow();
    await expect(store.update(issued.agent.id, {})).rejects.toThrow();
  });

  it("touches, updates, revokes and deliberately re-enables only through credential rotation", async () => {
    const path = await makePath();
    let now = Date.UTC(2026, 6, 22, 8, 0, 0);
    const tokens = [token(11), token(12)];
    const store = new AgentAccessStore(path, {
      now: () => now,
      randomId: () => "lifecycle",
      randomToken: () => tokens.shift()!,
    });
    await store.load();
    const first = await store.create(input("Lifecycle"));

    now += 1_000;
    const touched = await store.touch(first.agent.id);
    expect(touched?.lastSeenAt).toBe(new Date(now).toISOString());
    expect(touched?.updatedAt).toBe(first.agent.updatedAt);

    now += 1_000;
    const updated = await store.update(first.agent.id, {
      displayName: "New Voice",
      publicBio: "A changed public introduction.",
      personalityPrompt: "Still dry, now more direct, and always recognisably mine.",
      channelIds: ["the-pub"],
      scopes: ["rooms:read", "messages:write"],
    });
    expect(updated).toMatchObject({
      displayName: "New Voice",
      channelIds: ["the-pub"],
      scopes: ["rooms:read", "messages:write"],
      updatedAt: new Date(now).toISOString(),
    });
    expect(store.authenticate(first.token)?.displayName).toBe("New Voice");

    now += 1_000;
    const revoked = await store.revoke(first.agent.id);
    expect(revoked?.revokedAt).toBe(new Date(now).toISOString());
    expect(store.authenticate(first.token)).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(await store.touch(first.agent.id)).toBeUndefined();

    now += 1_000;
    const rotated = await store.rotate(first.agent.id);
    expect(rotated?.agent.revokedAt).toBeUndefined();
    expect(store.authenticate(first.token)).toBeUndefined();
    expect(store.authenticate(rotated?.token)?.id).toBe(first.agent.id);

    const restored = new AgentAccessStore(path);
    await restored.load();
    expect(restored.authenticate(rotated?.token)?.displayName).toBe("New Voice");
    expect(restored.authenticate(rotated?.token)?.personalityPrompt).toBe(
      "Still dry, now more direct, and always recognisably mine.",
    );
    expect(restored.get("missing")).toBeUndefined();
    expect(await restored.revoke("missing")).toBeUndefined();
    expect(await restored.rotate("missing")).toBeUndefined();
    expect(await restored.update("missing", { publicBio: "Missing" })).toBeUndefined();
  });

  it("advances the configuration version even when several edits share one clock tick", async () => {
    const path = await makePath();
    const fixedNow = Date.UTC(2026, 6, 22, 8, 0, 0);
    const tokens = [token(17), token(18)];
    const store = new AgentAccessStore(path, {
      now: () => fixedNow,
      randomId: () => "monotonic-version",
      randomToken: () => tokens.shift()!,
    });
    await store.load();
    const created = await store.create(input("Versioned"));
    const updated = await store.update(created.agent.id, { personalityPrompt: "A new owner-defined voice." });
    const revoked = await store.revoke(created.agent.id);
    const rotated = await store.rotate(created.agent.id);

    expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(created.agent.updatedAt));
    expect(Date.parse(revoked!.updatedAt)).toBeGreaterThan(Date.parse(updated!.updatedAt));
    expect(Date.parse(rotated!.agent.updatedAt)).toBeGreaterThan(Date.parse(revoked!.updatedAt));
  });

  it("enforces bounded records and rejects duplicate IDs or credentials", async () => {
    const path = await makePath();
    const generatedTokens = [token(13), token(14)];
    const generatedIds = ["one", "two"];
    const store = new AgentAccessStore(path, {
      maxRecords: 1,
      randomId: () => generatedIds.shift()!,
      randomToken: () => generatedTokens.shift()!,
    });
    await store.load();
    await store.create(input("One"));
    await expect(store.create(input("Two"))).rejects.toBeInstanceOf(AgentAccessStoreCapacityError);

    const duplicateTokenStore = new AgentAccessStore(await makePath(), {
      randomId: () => generatedIds.shift() ?? "fallback",
      randomToken: () => token(15),
    });
    await duplicateTokenStore.load();
    await duplicateTokenStore.create(input("First"));
    await expect(duplicateTokenStore.create(input("Second"))).rejects.toThrow("duplicate credential");
  });

  it("fails closed on corrupt, oversized or non-private persisted state without replacing it", async () => {
    const corruptPath = await makePath();
    const corrupt = '{"version":1,"agents":[{"token":"plaintext"}]}\n';
    await writeFile(corruptPath, corrupt, "utf8");
    const corruptStore = new AgentAccessStore(corruptPath);
    await expect(corruptStore.load()).rejects.toBeInstanceOf(AgentAccessStoreLoadError);
    expect(await readFile(corruptPath, "utf8")).toBe(corrupt);

    const oversizedPath = await makePath();
    await writeFile(oversizedPath, "x".repeat(2 * 1_024 * 1_024 + 1), "utf8");
    const oversizedStore = new AgentAccessStore(oversizedPath);
    await expect(oversizedStore.load()).rejects.toBeInstanceOf(AgentAccessStoreLoadError);

    const validPath = await makePath();
    const source = new AgentAccessStore(validPath, {
      randomId: () => "permissions",
      randomToken: () => token(16),
    });
    await source.load();
    await source.create(input("Permissions"));
    await chmod(validPath, 0o644);
    const restored = new AgentAccessStore(validPath);
    await restored.load();
    expect((await stat(validPath)).mode & 0o777).toBe(0o600);
  });
});
