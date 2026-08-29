import { z } from "zod";
import { isWellFormedHttpUrl } from "../../http-url.ts";
import { boundedRecord, INPUT_LIMITS } from "../input-limits.ts";

const boundedValues = z
  .record(
    z.string().min(1).max(INPUT_LIMITS.mcpNameChars),
    z.string().max(INPUT_LIMITS.mcpValueChars),
  )
  .refine((value) => boundedRecord(value, INPUT_LIMITS.mcpMapEntries), {
    message: `must contain at most ${String(INPUT_LIMITS.mcpMapEntries)} entries`,
  });

const serverBase = z
  .object({
    name: z
      .string()
      .min(1, "server name must be a non-empty string")
      .max(INPUT_LIMITS.mcpNameChars)
      .describe("Namespace for this MCP server's tools."),
    transport: z
      .enum(["stdio", "http", "sse"], {
        error: "transport must be 'stdio' | 'http' | 'sse'",
      })
      .default("stdio")
      .describe("Transport to the MCP server. Absent = 'stdio'."),
    command: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.mcpCommandChars)
      .optional()
      .describe("Required when transport is 'stdio'."),
    args: z.array(z.string().max(INPUT_LIMITS.mcpArgChars)).max(INPUT_LIMITS.mcpArgs).optional(),
    url: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.mcpValueChars)
      .optional()
      .describe("Required when transport is 'http'/'sse'. A well-formed http(s) URL."),
    headers: boundedValues
      .optional()
      .describe(
        "Optional headers for a remote transport. Values may embed ${VAR}, resolved from the " +
          "loop's env at connect time (never a literal secret on the wire).",
      ),
    env: boundedValues
      .optional()
      .describe(
        "Optional environment variables for a stdio transport, merged onto a safe default " +
          "environment. Values may embed ${VAR}, resolved from the loop's env at spawn time " +
          "(never a literal secret on the wire).",
      ),
    cwd: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.pathChars)
      .optional()
      .describe("Optional working directory for a stdio transport's subprocess."),
    expandVariables: z
      .boolean()
      .optional()
      .describe("Whether Clarvis ${VAR} interpolation applies to env/header values."),
    shared: z
      .boolean()
      .optional()
      .describe(
        "Opt-in to share this stdio server's subprocess across runs: one warm connection " +
          "serves overlapping runs concurrently and is reused by sequential runs. Because that " +
          "subprocess outlives any one run and may serve several at once, a shared connection " +
          "does NOT advertise the MCP 'elicitation' capability — this server can never prompt a " +
          "human. Do not set it on a server that authenticates by asking. " +
          "Default false (a fresh subprocess per run).",
      ),
    resources: z
      .boolean()
      .optional()
      .describe(
        "Opt-out of MCP resource support for this server. When the server advertises the " +
          "'resources' capability, the engine auto-attaches synthetic '<server>.list_resources' " +
          "and '<server>.read_resource' tools. Set false to suppress them. Default on.",
      ),
    auto_tools: z
      .boolean()
      .optional()
      .describe(
        "When true, every tool this server advertises is added to every agent's effective MCP " +
          "allow-list for this run. Host composition only; it does not alter transport identity " +
          "or a persisted agent profile.",
      ),
  })
  .strict();

interface ServerTransportFields {
  transport: "stdio" | "http" | "sse";
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  expandVariables?: boolean | undefined;
  shared?: boolean | undefined;
}

/**
 * Zod `superRefine` body enforcing the transport-conditional shape of an MCP
 * server descriptor.
 *
 * @param server - the server's transport-relevant fields.
 * @param ctx - the refinement context issues are added to.
 * @remarks For `stdio`: `command` is required and `url`/`headers` are forbidden.
 *   For `http`/`sse`: `url` is required and must be a well-formed http(s) URL
 *   (see {@link isWellFormedHttpUrl}), and `command`/`args`/`env`/`cwd`/`shared`
 *   are forbidden. Each violation is reported at its own field path. `shared`
 *   pools a spawned subprocess, so it is meaningless on a remote transport and
 *   is rejected here exactly as `mcpServers[].shared` is in `settings.json` —
 *   otherwise a run request could carry a server shape the settings file
 *   refuses.
 */
function refineServerTransport(server: ServerTransportFields, ctx: z.core.$RefinementCtx): void {
  if (server.transport === "stdio") {
    if (!server.command) {
      ctx.addIssue({
        code: "custom",
        message: "servers[].command is required when transport is 'stdio'",
        path: ["command"],
      });
    }
    if (server.url !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "servers[].url is not valid for a 'stdio' transport",
        path: ["url"],
      });
    }
    if (server.headers !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "servers[].headers is not valid for a 'stdio' transport",
        path: ["headers"],
      });
    }
  } else {
    if (!server.url) {
      ctx.addIssue({
        code: "custom",
        message: `servers[].url is required when transport is '${server.transport}'`,
        path: ["url"],
      });
    } else if (!isWellFormedHttpUrl(server.url)) {
      ctx.addIssue({
        code: "custom",
        message: "servers[].url must be a well-formed http(s) URL",
        path: ["url"],
      });
    }
    if (server.command !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `servers[].command is not valid for a '${server.transport}' transport`,
        path: ["command"],
      });
    }
    if (server.args !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `servers[].args is not valid for a '${server.transport}' transport`,
        path: ["args"],
      });
    }
    if (server.env !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `servers[].env is not valid for a '${server.transport}' transport`,
        path: ["env"],
      });
    }
    if (server.cwd !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `servers[].cwd is not valid for a '${server.transport}' transport`,
        path: ["cwd"],
      });
    }
    if (server.shared !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `servers[].shared is not valid for a '${server.transport}' transport (stdio only)`,
        path: ["shared"],
      });
    }
  }
}

/** {@link serverBase} with {@link refineServerTransport} applied — the full MCP server descriptor schema. */
export const serverSchema = serverBase.superRefine(refineServerTransport);
