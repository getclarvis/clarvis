import { randomUUID } from "node:crypto";
import {
  handlerBaseOf,
  openCallEnvelope,
  type AgentCapability,
  type Capability,
  type HandlerBase,
  type HandlerVerdict,
  type NamespacedTool,
  type RunCapability,
  type ToolHandler,
} from "@clarvis/capability";

import type { GuestExecutionBridge } from "./execution-worker.ts";
import type { RuntimePortPreview, RuntimePreviewProtocol } from "./types.ts";

/** Guest tool and host capability identities for loopback port previews. */
const RUNTIME_PREVIEW_CAPABILITY_NAME = "runtime-preview";
export const RUNTIME_PREVIEW_METHOD = "runtime.preview";
export const RUNTIME_PREVIEW_REVISION = "v1";
const EXPOSE_PORT_TOOL_NAME = "expose_port";

const exposePortTool: NamespacedTool = {
  fullName: EXPOSE_PORT_TOOL_NAME,
  wireName: EXPOSE_PORT_TOOL_NAME,
  mcpName: "",
  toolName: EXPOSE_PORT_TOOL_NAME,
  description:
    "Publish one TCP service already listening inside the isolated runtime as a host-only " +
    "127.0.0.1 endpoint. Start long-lived services with monitor_start, wait until ready, then " +
    "call this tool with their guest port. The host chooses the host port and may use a different " +
    "one when the same port is occupied.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65_535,
        description: "TCP port already listening on 127.0.0.1 or 0.0.0.0 inside the guest.",
      },
      protocol: {
        type: "string",
        enum: ["http", "https", "tcp"],
        description: "URL scheme shown to the user. Defaults to http; forwarding remains raw TCP.",
      },
    },
    required: ["port"],
  },
};

function isPreview(value: unknown): value is RuntimePortPreview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const preview = value as Partial<RuntimePortPreview>;
  return (
    Number.isSafeInteger(preview.guestPort) &&
    Number.isSafeInteger(preview.hostPort) &&
    preview.host === "127.0.0.1" &&
    (preview.protocol === "http" || preview.protocol === "https" || preview.protocol === "tcp") &&
    typeof preview.url === "string"
  );
}

function handler(bridge: GuestExecutionBridge, base: HandlerBase): ToolHandler {
  return {
    matches: (call) => call.name === EXPOSE_PORT_TOOL_NAME,
    async handle(call, iteration): Promise<HandlerVerdict> {
      const envelope = openCallEnvelope({
        call,
        name: EXPOSE_PORT_TOOL_NAME,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId === undefined
          ? {}
          : { subagentInstanceId: base.subagentInstanceId }),
        iteration,
        schema: exposePortTool.inputSchema,
        ...(base.validateArgs === undefined ? {} : { validate: base.validateArgs }),
      });
      if (envelope.invalid !== null) {
        return { kind: "result", text: envelope.fail(envelope.invalid), progress: false };
      }
      const args = call.arguments as { port: number; protocol?: RuntimePreviewProtocol };
      envelope.start();
      try {
        const result = await bridge.capability(
          randomUUID(),
          {
            method: RUNTIME_PREVIEW_METHOD,
            revision: RUNTIME_PREVIEW_REVISION,
            arguments: {
              port: args.port,
              ...(args.protocol === undefined ? {} : { protocol: args.protocol }),
            },
          },
          base.signal,
        );
        if (!isPreview(result) || result.guestPort !== args.port) {
          return {
            kind: "result",
            text: envelope.fail("the host returned an invalid runtime preview endpoint"),
            progress: false,
          };
        }
        const text =
          `Guest TCP port ${String(result.guestPort)} is available at ${result.url}. ` +
          "The endpoint is bound only to host loopback and remains available until the isolated " +
          "runtime stops.";
        return { kind: "result", text: envelope.ok(text), progress: true };
      } catch (error) {
        if (base.signal?.aborted === true) return { kind: "cancelled" };
        const reason = error instanceof Error ? error.message : "runtime preview failed";
        return { kind: "result", text: envelope.fail(reason), progress: false };
      }
    },
  };
}

/**
 * Create the guest-only tool that asks the host to publish one runtime TCP listener.
 *
 * @param bridge - Run-bound private capability bridge authenticated by the host.
 * @returns A capability visible only to agents carrying the existing `run_commands` grant.
 */
export function createRuntimePreviewCapability(bridge: GuestExecutionBridge): Capability {
  return {
    name: RUNTIME_PREVIEW_CAPABILITY_NAME,
    reservedWireNames: [EXPOSE_PORT_TOOL_NAME],
    toolEffects: { [EXPOSE_PORT_TOOL_NAME]: "mutate" },
    forRun(): RunCapability {
      return {
        name: RUNTIME_PREVIEW_CAPABILITY_NAME,
        systemSection(identity) {
          if (!identity.grants.includes("run_commands")) return undefined;
          return (
            "## Isolated runtime\n\n" +
            "The image intentionally carries no language toolchains. `mise` is available on PATH; " +
            "use `mise x <tool>@<version> -- <command>` to install and run a missing runtime " +
            "without modifying the read-only image. Those installs stay outside the workspace; " +
            "the host may reuse its private cache only for this workspace and image.\n\n" +
            "### Service previews\n\n" +
            "When you start a TCP service that the user needs to open, run it with " +
            "`monitor_start`, wait until it is ready, then call `expose_port`. The returned " +
            "127.0.0.1 URL is the only host-visible endpoint; do not claim the guest port itself " +
            "is reachable from the host."
          );
        },
        forAgent(scope): AgentCapability | null {
          if (!scope.grants.includes("run_commands")) return null;
          return {
            attach(build) {
              return {
                tools: [exposePortTool],
                handlers: [handler(bridge, handlerBaseOf(build))],
                advertised: true,
              };
            },
          };
        },
      };
    },
  };
}
