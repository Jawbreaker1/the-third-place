import type { Socket } from "socket.io-client";
import type { PresenceActivityPayload } from "../shared/types";
import { HUMAN_IDLE_AFTER_MS } from "../shared/presence";

export const HUMAN_ACTIVITY_REPORT_INTERVAL_MS = 30_000;

export class HumanPresenceActivityReporter {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastSentPayload?: PresenceActivityPayload;
  private lastActivityAt: number;

  constructor(
    private readonly send: (payload: PresenceActivityPayload) => boolean,
    private readonly isVisible: () => boolean,
    private readonly now: () => number = () => Date.now(),
    private readonly reportIntervalMs = HUMAN_ACTIVITY_REPORT_INTERVAL_MS,
    private readonly idleAfterMs = HUMAN_IDLE_AFTER_MS,
  ) {
    this.lastActivityAt = this.now();
  }

  snapshot(): PresenceActivityPayload {
    const visible = this.isVisible();
    return {
      visible,
      active: visible && this.now() - this.lastActivityAt < this.idleAfterMs,
    };
  }

  sync(): void {
    this.emit(this.snapshot(), true);
  }

  noteActivity(): void {
    if (!this.isVisible()) return;
    this.lastActivityAt = this.now();
    this.emit({ visible: true, active: true }, false);
  }

  noteVisibilityChange(): void {
    const visible = this.isVisible();
    if (visible) this.lastActivityAt = this.now();
    this.emit({ visible, active: visible }, true);
  }

  notePageHidden(): void {
    this.emit({ visible: false, active: false }, true);
  }

  private emit(payload: PresenceActivityPayload, force: boolean): void {
    const now = this.now();
    const stateChanged = this.lastSentPayload?.visible !== payload.visible ||
      this.lastSentPayload?.active !== payload.active;
    if (!force && !stateChanged && now - this.lastSentAt < this.reportIntervalMs) return;
    if (this.send(payload)) {
      this.lastSentAt = now;
      this.lastSentPayload = payload;
    }
  }
}

/**
 * Reports sparse, meaningful browser activity. Socket transport heartbeats,
 * mouse movement and programmatic scrolling never count as human activity.
 */
export const attachBrowserHumanPresenceActivity = (
  socket: Socket,
  reporter: HumanPresenceActivityReporter,
): (() => void) => {
  const noteActivity = (event: Event) => {
    if (event.isTrusted) reporter.noteActivity();
  };
  const noteVisibility = () => reporter.noteVisibilityChange();
  const notePageShow = () => reporter.sync();
  const notePageHide = () => reporter.notePageHidden();
  const noteConnect = () => reporter.sync();

  document.addEventListener("pointerdown", noteActivity, { capture: true, passive: true });
  document.addEventListener("keydown", noteActivity, true);
  document.addEventListener("input", noteActivity, true);
  document.addEventListener("wheel", noteActivity, { capture: true, passive: true });
  document.addEventListener("touchstart", noteActivity, { capture: true, passive: true });
  document.addEventListener("visibilitychange", noteVisibility);
  window.addEventListener("pageshow", notePageShow);
  window.addEventListener("pagehide", notePageHide);
  window.addEventListener("focus", noteVisibility);
  socket.on("connect", noteConnect);
  if (socket.connected) reporter.sync();

  return () => {
    document.removeEventListener("pointerdown", noteActivity, true);
    document.removeEventListener("keydown", noteActivity, true);
    document.removeEventListener("input", noteActivity, true);
    document.removeEventListener("wheel", noteActivity, true);
    document.removeEventListener("touchstart", noteActivity, true);
    document.removeEventListener("visibilitychange", noteVisibility);
    window.removeEventListener("pageshow", notePageShow);
    window.removeEventListener("pagehide", notePageHide);
    window.removeEventListener("focus", noteVisibility);
    socket.off("connect", noteConnect);
  };
};
