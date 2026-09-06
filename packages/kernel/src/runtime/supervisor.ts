import { assertRuntimeLaunchSpec } from "./launch-policy.ts";
import {
  RuntimeLaunchError,
  type RuntimeBackend,
  type RuntimeLaunchSpec,
  type RuntimeSession,
} from "./types.ts";

/** Host-side admission boundary for an explicitly selected container runtime. */
export interface RuntimeSupervisor {
  launch(spec: RuntimeLaunchSpec): Promise<RuntimeSession>;
}

/** Create a fail-closed supervisor around one configured engine backend. */
export function createRuntimeSupervisor(backend: RuntimeBackend): RuntimeSupervisor {
  let active: RuntimeSession | undefined;
  return {
    async launch(spec) {
      if (active !== undefined) {
        throw new RuntimeLaunchError("operational_failure", "a runtime session is already active");
      }
      assertRuntimeLaunchSpec(spec);
      const availability = await backend.inspect();
      if (!availability.available) {
        throw new RuntimeLaunchError(availability.reason, availability.message);
      }
      const started = await backend.start(spec);
      if (
        started.info.generation !== spec.generation ||
        started.info.imageDigest !== spec.imageDigest
      ) {
        await started.stop().catch(() => undefined);
        throw new RuntimeLaunchError(
          "handshake_mismatch",
          "runtime identity did not match the admitted launch specification",
        );
      }
      active = started;
      return {
        info: started.info,
        startRun: (runId, envelope, signal) => started.startRun(runId, envelope, signal),
        steer: (runId, input, signal) => started.steer(runId, input, signal),
        cancel: (runId) => started.cancel(runId),
        exposePort: (guestPort, protocol, signal) =>
          started.exposePort(guestPort, protocol, signal),
        async stop() {
          if (active === undefined) return;
          active = undefined;
          await started.stop();
        },
      };
    },
  };
}
