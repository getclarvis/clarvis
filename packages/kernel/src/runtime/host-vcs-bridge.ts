import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  dispatch,
  resolveConfig,
  type AgentToolsOptions,
  type HostVcsDispatcher,
  type HostVcsDispatchResult,
} from "@clarvis/tools";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

/** Exact isolated-runtime capability used for host-owned VCS execution. */
export const RUNTIME_HOST_VCS_METHOD = "runtime.host_vcs";
export const RUNTIME_HOST_VCS_REVISION = "v1";

const requestSchema = z.record(z.string(), z.unknown());
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict(),
]);
const guardSchema = z
  .object({
    mode: z.enum(["off", "on", "auto"]),
    outcome: z.enum(["allowed", "denied"]),
    answerer: z.enum(["policy", "human", "judge", "session_allowlist", "unavailable"]),
  })
  .strict();
const resultSchema = z
  .object({
    isError: z.boolean(),
    content: z.array(contentSchema),
    meta: z.record(z.string(), z.unknown()).optional(),
    guard: guardSchema.optional(),
  })
  .strict();

/** Build the host-side, non-idempotent capability that revalidates and executes `host_vcs`. */
export function createHostVcsGrant(
  options: Omit<AgentToolsOptions, "hostVcsDispatcher">,
): HostCapabilityGrant {
  const config = resolveConfig({ ...options, probeRipgrep: () => false });
  return {
    method: RUNTIME_HOST_VCS_METHOD,
    revision: RUNTIME_HOST_VCS_REVISION,
    idempotent: false,
    validateArguments: (value) => requestSchema.safeParse(value).success,
    async invoke(value, signal): Promise<HostVcsDispatchResult> {
      signal.throwIfAborted();
      return dispatch("host_vcs", requestSchema.parse(value), config, signal);
    },
  };
}

/** Build the guest-side dispatcher whose only authority is one fenced host capability call. */
export function createGuestHostVcsDispatcher(
  bridge: GuestExecutionBridge,
  runtimeSignal: AbortSignal,
): HostVcsDispatcher {
  return async (args, signal) => {
    const result = await bridge.capability(
      randomUUID(),
      {
        method: RUNTIME_HOST_VCS_METHOD,
        revision: RUNTIME_HOST_VCS_REVISION,
        arguments: args,
      },
      signal ?? runtimeSignal,
    );
    return resultSchema.parse(result) as HostVcsDispatchResult;
  };
}
