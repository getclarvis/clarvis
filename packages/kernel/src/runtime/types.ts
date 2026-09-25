import type { RuntimeStatus } from "@clarvis/protocol";

/** Informational placement transition emitted to local user interfaces. */
export interface RuntimePlacementNotice {
  readonly status: RuntimeStatus;
  readonly message?: string;
}
