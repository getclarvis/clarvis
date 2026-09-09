import type { HostedRunAttachment, HostedRunRef, HostingService } from "@clarvis/protocol";

export function hostedRef(patch: Partial<HostedRunRef> = {}): HostedRunRef {
  return {
    execution_id: "exec_background",
    session_id: "session_background",
    workspace_id: "ws_test",
    host_generation: "host_test",
    title: "Review the build",
    config: { agent: "ronin", model: "test/model" },
    created_at: 1000,
    updated_at: 1000,
    revision: 1,
    disconnect_policy: "continue",
    execution_state: "running",
    attention: "none",
    control_epoch: 1,
    control: "available",
    ...patch,
  };
}

export function hostedAttachment(ref = hostedRef()): HostedRunAttachment {
  return {
    run: ref,
    observation_id: "observation_test",
    pending_elicitations: [],
    snapshot: {
      snapshot_id: "snapshot_test",
      bytes: 0,
      cursor: { host_generation: ref.host_generation, execution_id: ref.execution_id, sequence: 0 },
    },
    handle: {
      execution_id: ref.execution_id,
      events: { async *[Symbol.asyncIterator]() {} },
      done: Promise.resolve({ execution_id: ref.execution_id, status: "completed" }),
      closed: Promise.resolve(),
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => () => {},
    },
  };
}

export function hostingFixture(overrides: Partial<HostingService> = {}): {
  service: HostingService;
  calls: string[];
} {
  const calls: string[] = [];
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected hosted operation");
  };
  const service: HostingService = {
    controlObservation: unsupported,
    resolveRecovery: unsupported,
    list: async () => [hostedRef()],
    start: unsupported,
    detach: unsupported,
    receipt: unsupported,
    attach: async () => hostedAttachment(),
    readSnapshot: unsupported,
    releaseSnapshot: async () => {
      calls.push("snapshot.release");
    },
    releaseObservation: async () => {
      calls.push("observation.release");
    },
    closeSession: async () => {
      calls.push("control.release");
    },
    acknowledge: unsupported,
    reserveActivity: unsupported,
    releaseActivity: unsupported,
    ...overrides,
  };
  return { service, calls };
}
