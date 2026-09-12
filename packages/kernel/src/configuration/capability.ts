import {
  handlerBaseOf,
  openCallEnvelope,
  OPERATOR_AUTHORITY_PORT,
  type OperatorAuthorityReader,
  type ProviderConfig,
  type Capability,
  type NamespacedTool,
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

/** Configuration file tools are bound to a live, approved native run, never to a persisted grant. */
export function createConfigurationCapability(options: {
  roots: Readonly<Record<ConfigurationRoot, string>>;
  assertAuthorized(): void;
  operate(
    request: ConfigurationFileRequest,
    authority?: OperatorAuthorityReader,
    providers?: ProviderConfig[],
  ): unknown;
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
    name: "native-configuration",
    grants: [{ name: TOOL_NAME }],
    reservedWireNames: [TOOL_NAME],
    toolEffects: { [TOOL_NAME]: "mutate" },
    forRun(ctx) {
      options.assertAuthorized();
      return {
        name: "native-configuration",
        systemSection: () =>
          "Native configuration mode is active for this run after human consent. " +
          "Use configure_clarvis only for authored configuration. " +
          "No shell, MCP, plugins, hooks, memory or subagents run in this mode. " +
          "Configuration roots: " +
          JSON.stringify(options.roots),
        forAgent(scope) {
          if (!scope.entry || !scope.grants.includes(TOOL_NAME)) return null;
          return {
            attach(build) {
              const authority = ctx.services.get(OPERATOR_AUTHORITY_PORT);
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
                        options.assertAuthorized();
                        const request = call.arguments as ConfigurationFileRequest;
                        const result = options.operate(request, authority, ctx.request.providers);
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
