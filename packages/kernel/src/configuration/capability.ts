import {
  handlerBaseOf,
  openCallEnvelope,
  type Capability,
  type NamespacedTool,
  type RunCapabilityContext,
} from "@clarvis/capability";
import type { ConfigurationRoot } from "@clarvis/paths";
import type { ConfigurationFileRequest } from "./files.ts";

const TOOL_NAME = "configure_clarvis";
const OPERATIONS = new Set(["list", "read", "write", "edit", "delete"]);

function traceArguments(
  roots: Readonly<Record<ConfigurationRoot, string>>,
  value: unknown,
): Record<string, string> {
  const args =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const operation = args.operation;
  const root = args.root;
  const path = args.path;
  return {
    ...(typeof operation === "string" && OPERATIONS.has(operation) ? { operation } : {}),
    ...(typeof root === "string" && Object.hasOwn(roots, root) ? { root } : {}),
    ...(typeof path === "string" && path.length <= 1024 ? { path } : {}),
  };
}

function traceResult(operation: ConfigurationFileRequest["operation"]): string {
  return `${operation.charAt(0).toUpperCase()}${operation.slice(1)} completed.`;
}

/** Configuration tools bind to the host-admitted run and review each concrete mutation. */
export function createConfigurationCapability(options: {
  roots: Readonly<Record<ConfigurationRoot, string>>;
  bind(ctx: RunCapabilityContext): ((request: ConfigurationFileRequest) => unknown) | null;
}): Capability {
  const tool: NamespacedTool = {
    fullName: TOOL_NAME,
    wireName: TOOL_NAME,
    mcpName: "",
    toolName: TOOL_NAME,
    description:
      "List, read, create, replace, edit or delete authored Clarvis/shared-agent configuration on the host. " +
      "Paths are relative to one approved root, with / separators. Empty path lists the root. " +
      "Read before writing/deleting; supply its revision (null creates an absent file). " +
      "For edit, provide old_text matching exactly once and its new_text replacement. " +
      "Credentials, private state, links and files over 256 KiB are excluded. Nothing is executed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["list", "read", "write", "edit", "delete"] },
        root: { type: "string", enum: Object.keys(options.roots) },
        path: { type: "string", maxLength: 1024 },
        content: { type: "string", maxLength: 262144 },
        old_text: { type: "string", minLength: 1, maxLength: 262144 },
        new_text: { type: "string", maxLength: 262144 },
        expected_revision: { type: ["string", "null"], maxLength: 64 },
      },
      required: ["operation", "root", "path"],
    },
  };
  return {
    name: "configuration",
    grants: [{ name: TOOL_NAME }],
    reservedWireNames: [TOOL_NAME],
    toolEffects: { [TOOL_NAME]: "mutate" },
    forRun(ctx) {
      const bound = options.bind(ctx);
      if (bound === null) return null;
      return {
        name: "configuration",
        systemSection: () =>
          "Configure Clarvis directly in this conversation using the restricted configure_clarvis writer. " +
          "Use configure_clarvis only for authored configuration. " +
          "Each mutation follows the current effect review policy; loading instructions grants no authority. " +
          "Configuration roots: " +
          JSON.stringify(options.roots),
        forAgent(scope) {
          if (!scope.entry) return null;
          return {
            attach(build) {
              const base = handlerBaseOf(build);
              return {
                tools: [tool],
                advertised: true,
                handlers: [
                  {
                    matches: (call) => call.name === TOOL_NAME,
                    async handle(call, iteration) {
                      const envelope = openCallEnvelope({
                        call,
                        name: TOOL_NAME,
                        trace: base.trace,
                        agent: base.agent,
                        iteration,
                        schema: tool.inputSchema,
                        validate: base.validateArgs,
                        traceArguments: traceArguments(options.roots, call.arguments),
                      });
                      if (envelope.invalid !== null)
                        return {
                          kind: "result",
                          text: envelope.fail(envelope.invalid),
                          progress: false,
                        };
                      if (base.signal?.aborted === true) return { kind: "cancelled" };
                      envelope.start();
                      try {
                        const request = call.arguments as ConfigurationFileRequest;
                        const result = await bound(request);
                        return {
                          kind: "result",
                          text: envelope.ok(JSON.stringify(result), traceResult(request.operation)),
                          progress: true,
                        };
                      } catch (error) {
                        const message =
                          error instanceof Error
                            ? error.message
                            : "Configuration operation failed.";
                        return { kind: "result", text: envelope.fail(message), progress: false };
                      }
                    },
                  },
                ],
              };
            },
          };
        },
      };
    },
  };
}
