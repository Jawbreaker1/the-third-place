import type { Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceActivityPayload } from "../shared/types";
import { attachBrowserHumanPresenceActivity, HumanPresenceActivityReporter } from "./humanPresenceActivity";

afterEach(() => vi.unstubAllGlobals());

describe("HumanPresenceActivityReporter", () => {
  it("reports current visibility whenever a socket connects", () => {
    const sent: PresenceActivityPayload[] = [];
    let visible = true;
    const reporter = new HumanPresenceActivityReporter((payload) => {
      sent.push(payload);
      return true;
    }, () => visible, () => 1_000);

    reporter.sync();
    visible = false;
    reporter.sync();

    expect(sent).toEqual([
      { visible: true, active: true },
      { visible: false, active: false },
    ]);
  });

  it("preserves idle state across a transport reconnect until real activity occurs", () => {
    const sent: PresenceActivityPayload[] = [];
    let now = 0;
    const reporter = new HumanPresenceActivityReporter((payload) => {
      sent.push(payload);
      return true;
    }, () => true, () => now, 30_000, 60_000);

    reporter.sync();
    now = 60_000;
    reporter.sync();
    now = 61_000;
    reporter.noteActivity();

    expect(sent).toEqual([
      { visible: true, active: true },
      { visible: true, active: false },
      { visible: true, active: true },
    ]);
  });

  it("throttles repeated activity but never visibility transitions", () => {
    const sent: PresenceActivityPayload[] = [];
    let now = 0;
    let visible = true;
    const reporter = new HumanPresenceActivityReporter((payload) => {
      sent.push(payload);
      return true;
    }, () => visible, () => now, 30_000);

    reporter.noteActivity();
    now = 1_000;
    reporter.noteActivity();
    visible = false;
    reporter.noteVisibilityChange();
    now = 2_000;
    visible = true;
    reporter.noteVisibilityChange();

    expect(sent).toEqual([
      { visible: true, active: true },
      { visible: false, active: false },
      { visible: true, active: true },
    ]);
  });

  it("does not report activity from a hidden document", () => {
    const send = vi.fn(() => true);
    const reporter = new HumanPresenceActivityReporter(send, () => false, () => 1_000);

    reporter.noteActivity();

    expect(send).not.toHaveBeenCalled();
  });

  it("does not consume the throttle window while disconnected", () => {
    const sent: PresenceActivityPayload[] = [];
    let connected = false;
    let now = 1_000;
    const reporter = new HumanPresenceActivityReporter((payload) => {
      if (!connected) return false;
      sent.push(payload);
      return true;
    }, () => true, () => now, 30_000);

    reporter.noteActivity();
    connected = true;
    now = 1_001;
    reporter.noteActivity();

    expect(sent).toEqual([{ visible: true, active: true }]);
  });

  it("forces an idle hint for pagehide and can resync after BFCache restore", () => {
    const sent: PresenceActivityPayload[] = [];
    const reporter = new HumanPresenceActivityReporter((payload) => {
      sent.push(payload);
      return true;
    }, () => true, () => 1_000);

    reporter.notePageHidden();
    reporter.sync();

    expect(sent).toEqual([
      { visible: false, active: false },
      { visible: true, active: true },
    ]);
  });

  it("detaches every browser and socket listener on terminal cleanup", () => {
    class FakeTarget {
      readonly listeners = new Map<string, Set<EventListener>>();

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const normalized = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(normalized);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener !== "function") return;
        this.listeners.get(type)?.delete(listener);
      }

      listenerCount(): number {
        return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
      }
    }

    const fakeDocument = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const fakeWindow = new FakeTarget();
    const socketListeners = new Map<string, Set<() => void>>();
    const fakeSocket = {
      connected: true,
      emit: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        const listeners = socketListeners.get(event) ?? new Set<() => void>();
        listeners.add(listener);
        socketListeners.set(event, listeners);
        return fakeSocket;
      }),
      off: vi.fn((event: string, listener: () => void) => {
        socketListeners.get(event)?.delete(listener);
        return fakeSocket;
      }),
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", fakeWindow);

    const reporter = new HumanPresenceActivityReporter(
      (payload) => {
        fakeSocket.emit("presence:activity", payload);
        return true;
      },
      () => fakeDocument.visibilityState === "visible",
    );
    const cleanup = attachBrowserHumanPresenceActivity(fakeSocket as unknown as Socket, reporter);
    expect(fakeDocument.listenerCount()).toBe(6);
    expect(fakeWindow.listenerCount()).toBe(3);
    expect(socketListeners.get("connect")?.size).toBe(1);

    cleanup();

    expect(fakeDocument.listenerCount()).toBe(0);
    expect(fakeWindow.listenerCount()).toBe(0);
    expect(socketListeners.get("connect")?.size).toBe(0);
  });
});
