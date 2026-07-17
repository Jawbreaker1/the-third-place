import { describe, expect, it } from "vitest";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ImageAttachment, Member } from "../shared/types.js";
import { createMessage, RoomStateLoadError, RoomStore } from "./store.js";
import { CHANNELS } from "./channels.js";

const tempStorePath = () => `/tmp/third-place-store-${Date.now()}-${Math.random()}.json`;
const tempStore = () => new RoomStore(tempStorePath());
const imageAttachment = (id = "7fa0a7d6-3915-4b2c-9db0-928f416a8301"): ImageAttachment => ({
  id,
  kind: "image",
  url: `/api/images/${id}`,
  thumbnailUrl: `/api/images/${id}?variant=thumbnail`,
  mimeType: "image/webp",
  width: 640,
  height: 480,
  sizeBytes: 12_345,
  analysis: { status: "pending" },
});

describe("room history", () => {
  it("seeds every configured channel so newly added rooms do not open empty", async () => {
    const store = tempStore();
    await store.load();
    for (const channel of CHANNELS) {
      expect(store.getRecent(channel.id, 10).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("migrates an existing seven-room history by adding the pub exactly once", async () => {
    const filePath = tempStorePath();
    const existing = createMessage("lobby", "human-returning", "keep this old history");
    await writeFile(filePath, JSON.stringify({ version: 1, messages: [existing] }), "utf8");

    const migrated = new RoomStore(filePath);
    await migrated.load();
    const firstPubIds = migrated.getRecent("the-pub", 50).map((message) => message.id);
    expect(firstPubIds.length).toBeGreaterThanOrEqual(2);
    expect(migrated.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);

    const reloaded = new RoomStore(filePath);
    await reloaded.load();
    expect(reloaded.getRecent("the-pub", 50).map((message) => message.id)).toEqual(firstPubIds);
    expect(reloaded.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);
  });

  it("migrates existing history with a lively football opening exactly once", async () => {
    const filePath = tempStorePath();
    const existing = createMessage("lobby", "human-returning", "preserve this pre-football history");
    await writeFile(filePath, JSON.stringify({ version: 1, messages: [existing] }), "utf8");

    const migrated = new RoomStore(filePath);
    await migrated.load();
    const footballMessages = migrated.getRecent("football-talk", 50);
    const firstFootballIds = footballMessages.map((message) => message.id);

    expect(footballMessages.length).toBeGreaterThanOrEqual(3);
    expect(new Set(footballMessages.map((message) => message.authorId))).toEqual(
      new Set(["ai-bosse", "ai-vale", "ai-linnea"]),
    );
    expect(footballMessages.some((message) =>
      message.reactions?.some((reaction) => reaction.emoji === "⚽"),
    )).toBe(true);
    expect(migrated.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);

    const reloaded = new RoomStore(filePath);
    await reloaded.load();
    expect(reloaded.getRecent("football-talk", 50).map((message) => message.id)).toEqual(firstFootballIds);
    expect(reloaded.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);
  });

  it("returns stable chronological pages before a composite cursor", async () => {
    const store = tempStore();
    for (let index = 0; index < 95; index += 1) {
      const message = createMessage("lobby", "ai-mira", `message ${index}`);
      message.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      store.addPublicMessage(message);
    }
    const latest = store.getHistoryPage("lobby", undefined, 40);
    expect(latest.messages).toHaveLength(40);
    expect(latest.messages[0]?.content).toBe("message 55");
    expect(latest.hasMore).toBe(true);
    const first = latest.messages[0]!;
    const older = store.getHistoryPage("lobby", { createdAt: first.createdAt, id: first.id }, 40);
    expect(older.messages).toHaveLength(40);
    expect(older.messages[0]?.content).toBe("message 15");
    expect(older.messages.at(-1)?.content).toBe("message 54");
    await store.flush();
  });

  it("round-trips a bounded longer considered resident turn", async () => {
    const filePath = tempStorePath();
    const store = new RoomStore(filePath);
    await store.load();
    const content = "å".repeat(650);
    const message = createMessage("ai-programming", "ai-sana", content, undefined, "lm");
    store.addPublicMessage(message);
    await store.flush();

    const restored = new RoomStore(filePath);
    await restored.load();
    expect(restored.getMessage(message.id)?.content).toBe(content);
  });

  it("persists private conversations across a restart without exposing them as public history", async () => {
    const filePath = tempStorePath();
    const first = new RoomStore(filePath);
    await first.load();
    const thread = first.openDm("human-johan", "ai-mira");
    expect(first.getAllDmParticipantIds()).toEqual(["ai-mira", "human-johan"]);
    const humanMessage = first.addDmMessage(thread.id, "human-johan", "Minns du det här efter omstart?");
    const residentMessage = first.addDmMessage(thread.id, "ai-mira", "Japp, den här tråden ligger kvar.", humanMessage?.id, "lm");
    expect(residentMessage).toBeDefined();
    await first.flush();

    const restored = new RoomStore(filePath);
    await restored.load();
    expect(restored.openDm("human-johan", "ai-mira").messages.map((message) => message.content)).toEqual([
      "Minns du det här efter omstart?",
      "Japp, den här tråden ligger kvar.",
    ]);
    expect(restored.getAllMessages().some((message) => message.channelId === thread.id)).toBe(false);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 3,
      trustedChannelLanguages: [],
    });
  });

  it("persists private image rows and authorizes only their exact DM participants", async () => {
    const filePath = tempStorePath();
    const first = new RoomStore(filePath);
    await first.load();
    const human: Member = {
      id: "human-private-image",
      name: "Private uploader",
      kind: "human",
      status: "offline",
      avatar: { color: "#123456", accent: "#abcdef", glyph: "P" },
    };
    const thread = first.openDm(human.id, "ai-mira");
    const attachment = imageAttachment();
    const message = first.addDmMessage(
      thread.id,
      human.id,
      "bara för Mira",
      undefined,
      undefined,
      undefined,
      undefined,
      [attachment],
      human,
    );

    expect(message?.attachments).toEqual([attachment]);
    expect(first.canViewImageAttachment(attachment.id, human.id)).toBe(true);
    expect(first.canViewImageAttachment(attachment.id, "ai-mira")).toBe(true);
    expect(first.canViewImageAttachment(attachment.id, "human-outsider")).toBe(false);
    expect(first.imageAttachmentVisibilityFor(attachment.id, human.id)).toBe("private");
    expect(first.imageAttachmentVisibilityFor(attachment.id, "human-outsider")).toBeUndefined();
    expect(first.getAllMessages()).not.toContainEqual(message);
    expect(first.getAllImageMessages()).toContainEqual(message);

    const ready = first.setImageAnalysis(thread.id, message!.id, attachment.id, {
      status: "ready",
      observation: {
        summary: "A red bicycle beside a wall.",
        details: ["The front wheel is turned left."],
        visibleText: [],
        topics: ["bicycle"],
        uncertainties: [],
        analyzedAt: "2026-07-17T00:00:00.000Z",
      },
    });
    expect(ready?.analysis.status).toBe("ready");
    await first.flush();

    const restored = new RoomStore(filePath);
    await restored.load();
    expect(restored.getAllImageMessages()).toHaveLength(1);
    expect(restored.openDm(human.id, "ai-mira").messages[0]?.attachments?.[0]?.analysis.status).toBe("ready");
    expect(restored.canViewImageAttachment(attachment.id, human.id)).toBe(true);
    expect(restored.canViewImageAttachment(attachment.id, "human-outsider")).toBe(false);
  });

  it("round-trips the terminal no-vision state for a private human DM image", async () => {
    const filePath = tempStorePath();
    const first = new RoomStore(filePath);
    await first.load();
    const thread = first.openDm("human-one", "human-two");
    const attachment = imageAttachment("3cf0054d-9d96-4815-8497-d78582e25bcc");
    attachment.analysis = { status: "not_requested" };
    first.addDmMessage(
      thread.id,
      "human-one",
      "bara mellan oss",
      undefined,
      undefined,
      undefined,
      undefined,
      [attachment],
    );
    await first.flush();

    const restored = new RoomStore(filePath);
    await restored.load();
    expect(restored.getDmMessages(thread.id)[0]?.attachments?.[0]?.analysis).toEqual({
      status: "not_requested",
    });
  });

  it("keeps public images join-visible while removing forgotten private image ownership", async () => {
    const store = tempStore();
    await store.load();
    const publicAttachment = imageAttachment("e880c73e-09db-4f57-8c35-b50050b727b2");
    store.addPublicMessage(createMessage("lobby", "human-public", "public", {
      attachments: [publicAttachment],
    }));
    expect(store.canViewImageAttachment(publicAttachment.id, "human-any-joined-member")).toBe(true);
    expect(store.imageAttachmentVisibilityFor(publicAttachment.id, "human-any-joined-member")).toBe("public");

    const privateAttachment = imageAttachment("e1035c41-4f18-45d8-89ca-7a955a1f5632");
    const thread = store.openDm("human-forgotten", "ai-mira");
    const privateMessage = store.addDmMessage(
      thread.id,
      "human-forgotten",
      "private",
      undefined,
      undefined,
      undefined,
      undefined,
      [privateAttachment],
    );
    const removedIds: string[] = [];
    store.onMessagesRemoved((messages) => {
      removedIds.push(...messages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) ?? []));
    });
    const removed = store.forgetDmParticipant("human-forgotten");
    expect(removedIds).toContain(privateAttachment.id);
    expect(removed).toEqual([
      expect.objectContaining({
        id: thread.id,
        participantIds: ["ai-mira", "human-forgotten"],
      }),
    ]);
    expect(removed.flatMap((removedThread) => removedThread.messages).map((message) => message.id))
      .toContain(privateMessage?.id);
    expect(store.canViewImageAttachment(privateAttachment.id, "ai-mira")).toBe(false);
  });

  it("hands private image files to retention cleanup when bounded DM history trims them", () => {
    const store = new RoomStore(tempStorePath(), {
      dmHistoryHardLimit: 160,
      dmHistoryTrimTo: 120,
    });
    const thread = store.openDm("human-dm-retention", "ai-mira");
    const oldAttachment = imageAttachment("35c5c4ac-b6b3-498e-b0f1-f71ccbadd8bb");
    store.addDmMessage(
      thread.id,
      "human-dm-retention",
      "old private image",
      undefined,
      undefined,
      undefined,
      undefined,
      [oldAttachment],
    );
    const removedIds: string[] = [];
    store.onMessagesRemoved((messages) => {
      removedIds.push(...messages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) ?? []));
    });

    for (let index = 0; index < 160; index += 1) {
      store.addDmMessage(thread.id, "ai-mira", `newer private message ${index}`);
    }

    expect(store.getDmMessages(thread.id)).toHaveLength(120);
    expect(removedIds).toContain(oldAttachment.id);
    expect(store.canViewImageAttachment(oldAttachment.id, "human-dm-retention")).toBe(false);
  });

  it("migrates version 2 and persists canonical trusted channel languages across restart", async () => {
    const filePath = tempStorePath();
    const existing = createMessage("lobby", "human-returning", "preserve this v2 history");
    await writeFile(filePath, JSON.stringify({
      version: 2,
      messages: [existing],
      privateThreads: [],
      autonomousPublications: [],
    }), "utf8");

    const migrated = new RoomStore(filePath);
    await migrated.load();
    expect(migrated.setTrustedChannelLanguage(
      "lobby",
      "swe",
      "resident",
      "2026-07-16T09:00:00.000Z",
    )).toBe(true);
    await migrated.flush();

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      trustedChannelLanguages: unknown[];
    };
    expect(persisted).toMatchObject({
      version: 3,
      trustedChannelLanguages: [{
        channelId: "lobby",
        languageTag: "sv",
        observedAt: "2026-07-16T09:00:00.000Z",
        authority: "resident",
      }],
    });

    const restored = new RoomStore(filePath);
    await restored.load();
    expect(restored.getTrustedChannelLanguage("lobby")).toEqual({
      channelId: "lobby",
      languageTag: "sv",
      observedAt: "2026-07-16T09:00:00.000Z",
      authority: "resident",
    });
  });

  it("lets residents seed only empty rooms while later human observations remain authoritative", async () => {
    const filePath = tempStorePath();
    const store = new RoomStore(filePath);

    expect(store.setTrustedChannelLanguage(
      "stock-market",
      "en",
      "resident",
      "2026-07-16T09:00:00.000Z",
    )).toBe(true);
    expect(store.setTrustedChannelLanguage(
      "stock-market",
      "sv",
      "resident",
      "2026-07-16T10:00:00.000Z",
    )).toBe(false);
    expect(store.getTrustedChannelLanguage("stock-market")?.languageTag).toBe("en");

    expect(store.setTrustedChannelLanguage(
      "stock-market",
      "sv-SE",
      "human",
      "2026-07-16T10:30:00.000Z",
    )).toBe(true);
    expect(store.setTrustedChannelLanguage(
      "stock-market",
      "en-GB",
      "resident",
      "2026-07-16T11:00:00.000Z",
    )).toBe(false);
    expect(store.setTrustedChannelLanguage(
      "stock-market",
      "en-GB",
      "human",
      "2026-07-16T10:00:00.000Z",
    )).toBe(false);
    expect(store.setTrustedChannelLanguage(
      "stock-market",
      "en-GB",
      "human",
      "2026-07-16T11:30:00.000Z",
    )).toBe(true);
    expect(store.getTrustedChannelLanguage("stock-market")).toEqual({
      channelId: "stock-market",
      languageTag: "en-GB",
      observedAt: "2026-07-16T11:30:00.000Z",
      authority: "human",
    });
    await store.flush();
  });

  it("fails closed on malformed version 3 trusted channel-language state", async () => {
    const validRow = {
      channelId: "lobby",
      languageTag: "sv",
      observedAt: "2026-07-16T09:00:00.000Z",
      authority: "human",
    };
    const malformedStates: unknown[] = [
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
      },
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
        trustedChannelLanguages: [{ ...validRow, unexpected: true }],
      },
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
        trustedChannelLanguages: [validRow, { ...validRow, languageTag: "en" }],
      },
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
        trustedChannelLanguages: [{ ...validRow, languageTag: "swe" }],
      },
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
        trustedChannelLanguages: [{ ...validRow, observedAt: "2026-07-16" }],
      },
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
        trustedChannelLanguages: [{ ...validRow, authority: "system" }],
      },
      {
        version: 3,
        messages: [],
        privateThreads: [],
        autonomousPublications: [],
        trustedChannelLanguages: [validRow],
        unexpected: true,
      },
    ];

    for (const [index, malformed] of malformedStates.entries()) {
      const filePath = `${tempStorePath()}-${index}`;
      const originalBytes = JSON.stringify(malformed);
      await writeFile(filePath, originalBytes, "utf8");

      const store = new RoomStore(filePath);
      await expect(store.load()).rejects.toBeInstanceOf(RoomStateLoadError);
      expect(await readFile(filePath, "utf8")).toBe(originalBytes);
      expect(store.getAllMessages()).toEqual([]);
      expect(store.getTrustedChannelLanguages()).toEqual([]);
    }
  });

  it("inventories durable public humans only from matching frozen server snapshots", async () => {
    const store = tempStore();
    await store.load();
    const humanSnapshot = {
      id: "human-history-only",
      name: "History Only",
      kind: "human" as const,
      status: "offline" as const,
      avatar: { color: "#123456", accent: "#abcdef", glyph: "H" },
    };
    store.addPublicMessage(createMessage("lobby", humanSnapshot.id, "I was here.", {
      authorSnapshot: humanSnapshot,
    }));
    store.addPublicMessage(createMessage("lobby", "human-untrusted-label", "No trusted type snapshot."));
    store.addPublicMessage(createMessage("lobby", "human-mismatch", "Snapshot belongs to somebody else.", {
      authorSnapshot: { ...humanSnapshot, id: "human-somebody-else" },
    }));

    expect(store.getAllPublicHumanAuthorIds()).toEqual(["human-history-only"]);
  });

  it("freezes legacy public authors before profile erasure and preserves them across restart", async () => {
    const filePath = tempStorePath();
    const store = new RoomStore(filePath);
    await store.load();
    const human: Member = {
      id: "human-legacy-retired",
      name: "Legacy Visitor",
      kind: "human",
      status: "online",
      avatar: { color: "#123456", accent: "#abcdef", glyph: "L" },
    };
    const legacy = createMessage("lobby", human.id, "Keep this historical line visible.");
    store.addPublicMessage(legacy);

    expect(store.freezePublicAuthorSnapshot(human)).toBe(1);
    expect(store.freezePublicAuthorSnapshot({ ...human, name: "Later Name" })).toBe(0);
    await store.flush();

    const restarted = new RoomStore(filePath);
    await restarted.load();
    const restored = restarted.getRecent("lobby", 100).find((message) => message.id === legacy.id);
    expect(restored?.authorSnapshot).toEqual({
      ...human,
      status: "offline",
      avatar: { ...human.avatar },
    });
    expect(restarted.getAllPublicHumanAuthorIds()).toContain(human.id);
  });

  it("inventories every non-system public actor for missing-companion continuity", async () => {
    const filePath = tempStorePath();
    const store = new RoomStore(filePath);
    await store.load();
    store.addPublicMessage(createMessage("lobby", "human-legacy", "Predates frozen snapshots."));
    const residentMessage = createMessage("lobby", "ai-mira", "Known resident with a legacy reactor.", {
      replyPreview: {
        authorId: "human-quoted-after-trim",
        authorName: "Quoted person",
        content: "The original row has aged out.",
      },
    });
    residentMessage.reactions.push({ emoji: "👍", memberIds: ["human-reaction-only"] });
    store.addPublicMessage(residentMessage);
    const systemMessage = createMessage("lobby", "system", "Transport notice.", {
      system: true,
      replyPreview: {
        authorId: "human-quoted-by-system-row",
        authorName: "Earlier visitor",
        content: "Still durable in the preview.",
      },
    });
    systemMessage.reactions.push({ emoji: "👋", memberIds: ["human-reacted-to-system"] });
    store.addPublicMessage(systemMessage);
    await store.flush();

    const restored = new RoomStore(filePath);
    await restored.load();
    const actorIds = restored.getAllPublicParticipantActorIds();
    expect(actorIds).toContain("human-legacy");
    expect(actorIds).toContain("ai-mira");
    expect(actorIds).toContain("human-reaction-only");
    expect(actorIds).toContain("human-quoted-after-trim");
    expect(actorIds).toContain("human-reacted-to-system");
    expect(actorIds).toContain("human-quoted-by-system-row");
    expect(actorIds).not.toContain("system");
  });

  it("restricts a legacy room-state file before it can contain persisted DMs", async () => {
    const filePath = tempStorePath();
    await writeFile(filePath, JSON.stringify({ version: 1, messages: [
      createMessage("lobby", "human-returning", "legacy history"),
    ] }), "utf8");
    await chmod(filePath, 0o644);

    const restored = new RoomStore(filePath);
    await restored.load();

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("fails closed without replacing malformed room history with seed data", async () => {
    const filePath = tempStorePath();
    const corruptBytes = "{ definitely not valid room history";
    await writeFile(filePath, corruptBytes, "utf8");

    const store = new RoomStore(filePath);
    await expect(store.load()).rejects.toMatchObject({
      name: "RoomStateLoadError",
      code: "ROOM_STATE_LOAD_FAILED",
    });
    expect(await readFile(filePath, "utf8")).toBe(corruptBytes);
    expect(store.getAllMessages()).toEqual([]);
    expect(store.getAllDmParticipantIds()).toEqual([]);

    const restarted = new RoomStore(filePath);
    await expect(restarted.load()).rejects.toBeInstanceOf(RoomStateLoadError);
    expect(await readFile(filePath, "utf8")).toBe(corruptBytes);
  });

  it("fails closed and preserves bytes for malformed nested public message data", async () => {
    const validSnapshot = {
      id: "human-history-author",
      name: "History Author",
      kind: "human" as const,
      status: "offline" as const,
      avatar: { color: "#123456", accent: "#abcdef", glyph: "H" },
      role: "Guest",
      bio: "A valid frozen snapshot.",
    };
    const valid = createMessage("lobby", validSnapshot.id, "Nested data must be trustworthy.", {
      authorSnapshot: validSnapshot,
    });
    const malformedMessages: unknown[] = [
      { ...valid, reactions: [{ emoji: "👍", memberIds: [42] }] },
      { ...valid, authorSnapshot: { ...validSnapshot, id: "human-somebody-else" } },
    ];

    for (const [index, malformed] of malformedMessages.entries()) {
      const filePath = `${tempStorePath()}-${index}`;
      const originalBytes = JSON.stringify({ version: 1, messages: [malformed] });
      await writeFile(filePath, originalBytes, "utf8");

      const store = new RoomStore(filePath);
      await expect(store.load()).rejects.toBeInstanceOf(RoomStateLoadError);
      expect(await readFile(filePath, "utf8")).toBe(originalBytes);
      expect(store.getAllMessages()).toEqual([]);
    }
  });

  it("applies the same fail-closed nested validation to durable DM rows", async () => {
    const filePath = tempStorePath();
    const participantIds = ["ai-mira", "human-dm-author"] as const;
    const threadId = `dm:${[...participantIds].sort().join(":")}`;
    const malformedDm = {
      ...createMessage(threadId, "human-dm-author", "This row must never be partially restored."),
      authorSnapshot: {
        id: "human-not-the-author",
        name: "Wrong snapshot",
        kind: "human",
        status: "offline",
        avatar: { color: "#123456", accent: "#abcdef", glyph: "W" },
      },
    };
    const originalBytes = JSON.stringify({
      version: 2,
      messages: [],
      privateThreads: [{ id: threadId, participantIds: [...participantIds].sort(), messages: [malformedDm] }],
      autonomousPublications: [],
    });
    await writeFile(filePath, originalBytes, "utf8");

    const store = new RoomStore(filePath);
    await expect(store.load()).rejects.toBeInstanceOf(RoomStateLoadError);
    expect(await readFile(filePath, "utf8")).toBe(originalBytes);
    expect(store.getAllDmParticipantIds()).toEqual([]);
  });

  it("fails closed on an unreadable room-state path instead of creating a replacement", async () => {
    const parentBlocker = tempStorePath();
    await writeFile(parentBlocker, "this is a file, not a directory", "utf8");
    const impossiblePath = `${parentBlocker}/room-state.json`;

    const store = new RoomStore(impossiblePath);
    await expect(store.load()).rejects.toBeInstanceOf(RoomStateLoadError);
    expect(await readFile(parentBlocker, "utf8")).toBe("this is a file, not a directory");
    expect(store.getAllMessages()).toEqual([]);
  });

  it("retains quiet-channel history when a different channel becomes busy", async () => {
    const store = new RoomStore(tempStorePath(), {
      publicHistoryHardLimit: 600,
      publicHistoryTrimTo: 500,
    });
    store.addPublicMessage(createMessage("ai-lab", "ai-zed", "keep me"));
    for (let index = 0; index <= 600; index += 1) {
      store.addPublicMessage(createMessage("lobby", "ai-mira", `busy ${index}`));
    }
    expect(store.getRecent("ai-lab", 10).map((message) => message.content)).toEqual(["keep me"]);
    expect(store.getRecent("lobby", 1)[0]?.content).toBe("busy 600");
    expect(store.getAllMessages().filter((message) => message.channelId === "lobby").length).toBe(500);
    await store.flush();
  });

  it("keeps private autonomous accounting after visible history trimming and reload", async () => {
    const filePath = tempStorePath();
    const retention = { publicHistoryHardLimit: 600, publicHistoryTrimTo: 500 };
    const store = new RoomStore(filePath, retention);
    const tracked = createMessage("lobby", "ai-mira", "tracked unattended post");
    store.addPublicMessage(tracked, { kind: "ambient", attendance: "unattended" });
    for (let index = 0; index < 650; index += 1) {
      store.addPublicMessage(createMessage("lobby", "human-busy", `busy ${index}`));
    }

    expect(store.getMessage(tracked.id)).toBeUndefined();
    expect(store.getAutonomousPublicationHistory()).toEqual([expect.objectContaining({
      messageId: tracked.id,
      attendance: "unattended",
    })]);
    expect(tracked).not.toHaveProperty("autonomousPublication");
    await store.flush();

    const restored = new RoomStore(filePath, retention);
    await restored.load();
    expect(restored.getAutonomousPublicationHistory()).toEqual([expect.objectContaining({
      messageId: tracked.id,
      attendance: "unattended",
    })]);
  });

  it("serializes overlapping flushes and atomically leaves the latest state on disk", async () => {
    const filePath = tempStorePath();
    const store = new RoomStore(filePath);
    const expectedIds: string[] = [];
    const flushes: Array<Promise<void>> = [];

    for (let index = 0; index < 12; index += 1) {
      const message = createMessage("lobby", "ai-mira", `overlap ${index}`);
      expectedIds.push(message.id);
      store.addPublicMessage(message);
      flushes.push(store.flush());
    }

    await expect(Promise.all(flushes)).resolves.toHaveLength(12);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      messages: Array<{ id: string }>;
    };
    expect(persisted.version).toBe(3);
    expect(persisted.messages.map((message) => message.id)).toEqual(expectedIds);

    const temporaryPrefix = `${basename(filePath)}.`;
    const leftovers = (await readdir(dirname(filePath))).filter(
      (entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
