import type { HostedRunAttachment, HostingService } from "@clarvis/protocol";

/** A consumed result's acknowledgement and an observation's release have distinct lifetimes. */
export interface HostedObservationLease {
  release: () => Promise<void>;
  settle: (consumed: Promise<unknown>) => Promise<void>;
}

/**
 * Share foreground retention ownership between interactive and print consumers. Only a fully
 * consumed, settled, controlled result is acknowledged. Early release abandons acknowledgement;
 * failed consumption, settlement or acknowledgement still releases the observation exactly once.
 */
export function createHostedObservationLease(
  hosting: HostingService,
  attachment: HostedRunAttachment,
  interactive: boolean | (() => boolean),
): HostedObservationLease {
  let released = false;
  let release: Promise<void> | undefined;
  let settlement: Promise<void> | undefined;
  const releaseObservation = (): Promise<void> => {
    released = true;
    return (release ??= hosting.releaseObservation(attachment.observation_id));
  };
  return {
    release: releaseObservation,
    settle(consumed) {
      return (settlement ??= Promise.all([
        consumed,
        attachment.handle.closed,
        attachment.handle.done,
      ])
        .then(async () => {
          if (!released && (typeof interactive === "function" ? interactive() : interactive))
            await hosting.acknowledge(attachment.handle.execution_id);
        })
        .finally(releaseObservation));
    },
  };
}
