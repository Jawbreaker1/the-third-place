import { describe, expect, it } from "vitest";
import { createMessage } from "./store.js";
import { ActorChannelRuntime } from "./actorChannels.js";
import { CHANNELS } from "./channels.js";
import { PERSONAS } from "./personas.js";

describe("actor channel runtime", () => {
  it("keeps the moderator subscribed to every public channel", () => {
    const runtime = new ActorChannelRuntime();
    for (const channel of CHANNELS) {
      expect(runtime.candidatesFor(channel.id).some((persona) => persona.id === "ai-runa")).toBe(true);
    }
  });

  it("tracks all configured rooms and keeps expertise stable when attention changes", () => {
    const runtime = new ActorChannelRuntime();
    const before = runtime.expertise("ai-pixel", "world-of-warcraft");
    runtime.noteChannelEvent(createMessage("world-of-warcraft", "ai-bosse", "pull timer"));
    runtime.markRead("ai-pixel", "world-of-warcraft", "message-1");
    const state = runtime.snapshot("ai-pixel");
    expect(Object.keys(state?.attentionByChannel ?? {})).toEqual(expect.arrayContaining(CHANNELS.map((channel) => channel.id)));
    expect(Object.keys(state?.unreadByChannel ?? {})).toEqual(expect.arrayContaining(CHANNELS.map((channel) => channel.id)));
    expect(runtime.expertise("ai-pixel", "world-of-warcraft")).toEqual(before);
  });

  it("calibrates specialists and basic residents differently in the trusted expertise notes", () => {
    const runtime = new ActorChannelRuntime();
    const farah = PERSONAS.find((persona) => persona.id === "ai-farah")!;
    const basic = PERSONAS.find((persona) => runtime.expertise(persona.id, "stock-market").level === "basic")!;
    const notes = runtime.expertiseNotes([farah, basic], "stock-market");
    expect(notes[farah.id]).toContain("specialist");
    expect(notes[farah.id]).toContain("macro trade-offs");
    expect(notes[basic.id]).toContain("basic");
    expect(notes[basic.id]).toContain("honest question");
    expect(notes[farah.id]).toContain("Never invent live prices");
  });

  it("still lets a directly mentioned outsider answer", () => {
    const runtime = new ActorChannelRuntime();
    const outsider = PERSONAS.find(
      (persona) => !runtime.snapshot(persona.id)?.subscribedChannels.includes("stock-market") && persona.id !== "ai-runa",
    );
    expect(outsider).toBeDefined();
    expect(runtime.candidatesFor("stock-market", [outsider!.id]).map((persona) => persona.id)).toContain(outsider!.id);
  });

  it("restores an actor's last channel focus from persisted history", () => {
    const runtime = new ActorChannelRuntime();
    runtime.restore([createMessage("side-quests", "ai-pixel", "tiny art quest")]);
    expect(runtime.snapshot("ai-pixel")?.focusChannelId).toBe("side-quests");
    expect(runtime.promptNotes([], "lobby")).toEqual({});
  });

  it("restores quiet-channel state even after another channel has over 300 newer messages", () => {
    const runtime = new ActorChannelRuntime();
    const quietMessage = createMessage("ai-lab", "ai-pixel", "remember this lab visit");
    quietMessage.createdAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const busyMessages = Array.from({ length: 320 }, (_, index) => {
      const message = createMessage("lobby", "ai-mira", `busy lobby ${index}`);
      message.createdAt = new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString();
      return message;
    });

    runtime.restore([quietMessage, ...busyMessages]);

    expect(runtime.snapshot("ai-pixel")?.lastSpokeAtByChannel["ai-lab"]).toBeDefined();
  });
});
