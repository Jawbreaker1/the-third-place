import type { AdminChannelFeedControl } from "../shared/adminTypes.js";

const copyControl = (control: AdminChannelFeedControl): AdminChannelFeedControl => ({
  ...control,
  publisher: { ...control.publisher },
});

/**
 * Projects coordinator-owned controls through the process startup boundary.
 *
 * A coordinator can still expose its registered adapter catalog after its
 * durable state failed to load. Those controls remain useful diagnostics, but
 * must not claim that the adapter is currently operable or advertise a due
 * time that no scheduler will service during this process run.
 */
export const projectChannelFeedAdminControls = (
  controls: readonly AdminChannelFeedControl[],
  runtimeStarted: boolean,
): AdminChannelFeedControl[] => controls.map((source) => {
  const control = copyControl(source);
  if (runtimeStarted) return control;
  const { nextPollAt: _unserviceableDueTime, ...withoutNextPoll } = control;
  return {
    ...withoutNextPoll,
    available: false,
    status: "unavailable",
    cardAvailable: false,
  };
});
