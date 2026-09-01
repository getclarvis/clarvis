import { z } from "zod";
import { isWellFormedHttpUrl } from "../http-url.ts";
import { capabilitySettingsFields } from "../runtime/capabilities/settings-specs.ts";
import { budgetSchema, modelField, providerConfigSchema } from "../validation/request-schema.ts";

/**
 * The run budget as *settings* may declare it: every field optional.
 *
 * @remarks {@link budgetSchema} is the **run-request** shape, where `on_exceed`
 * is required because a request is a complete instruction. Settings are a set
 * of defaults, and reusing the request schema verbatim made
 * `budget: { total_token_limit: 200000 }` — an entirely reasonable thing to
 * write — a **fatal boot failure**, with the repair path then discarding the
 * whole block rather than completing the one missing field. The host fills
 * `on_exceed` from its own fallback when it assembles a request; see
 * `settings-assembler.ts`.
 */
const settingsBudgetSchema = budgetSchema.extend({
  on_exceed: budgetSchema.shape.on_exceed
    .optional()
    .describe(
      "What happens when a limit is reached. Omitted, the host's default applies " +
        "(CLARVIS_DEFAULT_ON_EXCEED).",
    ),
});
import { boundedRecord, INPUT_LIMITS } from "../validation/input-limits.ts";

const RESERVED_PLUGIN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const boundedMcpValues = z
  .record(
    z.string().min(1).max(INPUT_LIMITS.mcpNameChars),
    z.string().max(INPUT_LIMITS.mcpValueChars),
  )
  .refine((value) => boundedRecord(value, INPUT_LIMITS.mcpMapEntries), {
    message: `must contain at most ${String(INPUT_LIMITS.mcpMapEntries)} entries`,
  });

const mcpEnvName = z
  .string()
  .min(1)
  .max(INPUT_LIMITS.mcpNameChars)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment-variable name");

const boundedMcpNames = z
  .array(z.string().min(1).max(INPUT_LIMITS.mcpNameChars))
  .max(INPUT_LIMITS.mcpMapEntries)
  .transform((values) => [...new Set(values)]);

const mcpOAuthSchema = z
  .preprocess(
    (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      const source = value as Record<string, unknown>;
      return {
        client_id: source.client_id ?? source.clientId,
        callback_url: source.callback_url ?? source.callbackUrl,
        callback_port: source.callback_port ?? source.callbackPort,
        client_metadata_url: source.client_metadata_url ?? source.clientMetadataUrl,
      };
    },
    z
      .object({
        client_id: z.string().min(1).max(INPUT_LIMITS.mcpValueChars).optional(),
        callback_url: z
          .string()
          .url()
          .max(INPUT_LIMITS.mcpValueChars)
          .refine((raw) => {
            const url = new URL(raw);
            return (
              (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase()))) &&
              url.pathname !== "/" &&
              url.username.length === 0 &&
              url.password.length === 0 &&
              url.hash.length === 0
            );
          }, "must be an HTTPS or loopback HTTP callback URL with a non-root path")
          .optional(),
        callback_port: z.number().int().min(0).max(65_535).optional(),
        client_metadata_url: z
          .string()
          .url()
          .max(INPUT_LIMITS.mcpValueChars)
          .refine((raw) => {
            const url = new URL(raw);
            return url.protocol === "https:" && url.pathname !== "/";
          }, "must be an HTTPS URL with a non-root path")
          .optional(),
      })
      .strict(),
  )
  .optional();

function inferMcpTransport(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const normalized = { ...source };
  if (normalized.headers === undefined && normalized.http_headers !== undefined) {
    normalized.headers = normalized.http_headers;
  }
  delete normalized.http_headers;
  if (normalized.type === undefined && typeof normalized.url === "string") {
    normalized.type = "http";
  }
  return normalized;
}

/**
 * A validated plugin name: a lowercase filesystem-safe token that doubles as a
 * directory name and namespace prefix. Dots are accepted for Agent Plugin
 * compatibility; path separators, edge punctuation and ambiguous repeated
 * separators are rejected. Prototype-polluting keys remain forbidden because
 * plugin names index trust and contribution maps.
 */
export const pluginNameField = z
  .string()
  .min(1, "a plugin name must be a non-empty string")
  .max(64, "a plugin name must contain at most 64 characters")
  .regex(
    /^[a-z0-9](?!.*(?:--|\.\.))[a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/,
    "a plugin name must be lowercase, start and end with an alphanumeric character, and contain only '.', '_', or '-' separators",
  )
  .refine((name) => !RESERVED_PLUGIN_NAMES.has(name), {
    error:
      "a plugin name may not be '__proto__', 'constructor', or 'prototype': as an object key those " +
      "corrupt the trust map instead of storing an approval.",
  });

/**
 * The transport-agnostic field set for one MCP server entry, before the
 * cross-field refinement in {@link refineMcpServer} enforces which fields are
 * legal for the chosen `type`.
 */
const mcpServerBase = z
  .object({
    type: z
      .enum(["stdio", "http", "sse"], {
        error: "mcpServers[].type must be 'stdio' | 'http' | 'sse'",
      })
      .default("stdio")
      .describe("Transport to the MCP server. Absent = 'stdio'."),
    command: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.mcpCommandChars)
      .optional()
      .describe("Required when type is 'stdio'."),
    args: z.array(z.string().max(INPUT_LIMITS.mcpArgChars)).max(INPUT_LIMITS.mcpArgs).optional(),
    url: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.mcpValueChars)
      .optional()
      .describe("Required when type is 'http'/'sse'. A well-formed http(s) URL."),
    headers: boundedMcpValues
      .optional()
      .describe(
        "Optional headers for a remote transport. Values may embed ${VAR}, resolved from the " +
          "server's env at connect time (never a literal secret on the wire).",
      ),
    env: boundedMcpValues
      .optional()
      .describe(
        "Optional environment variables for a stdio transport. Values may embed ${VAR}, resolved " +
          "from the server's env at spawn time (never a literal secret on the wire).",
      ),
    cwd: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.pathChars)
      .optional()
      .describe("Optional working directory for a stdio transport."),
    expandVariables: z
      .boolean()
      .optional()
      .describe(
        "Whether Clarvis ${VAR} interpolation applies to env/header values. Default true; " +
          "portable Agent Plugin declarations set false because their format permits only " +
          "PLUGIN_ROOT and PLUGIN_DATA expansion.",
      ),
    shared: z
      .boolean()
      .optional()
      .describe(
        "Opt-in to share this stdio server's subprocess across runs: one warm connection serves " +
          "overlapping runs concurrently and is reused by sequential runs. Because that " +
          "subprocess outlives any one run and may serve several at once, a shared connection " +
          "does NOT advertise the MCP 'elicitation' capability — this server can never prompt a " +
          "human. Do not set it on a server that authenticates by asking. Default false.",
      ),
    resources: z
      .boolean()
      .optional()
      .describe(
        "Opt-out of MCP resource support for this server. When the server advertises the " +
          "'resources' capability, the engine auto-attaches synthetic '<server>.list_resources' " +
          "and '<server>.read_resource' tools. Set false to suppress them. Default on.",
      ),
    oauth: mcpOAuthSchema,
    bearer_token_env_var: mcpEnvName.optional(),
    env_http_headers: z
      .record(z.string().min(1).max(INPUT_LIMITS.mcpNameChars), mcpEnvName)
      .refine((value) => boundedRecord(value, INPUT_LIMITS.mcpMapEntries), {
        message: `must contain at most ${String(INPUT_LIMITS.mcpMapEntries)} entries`,
      })
      .optional(),
    env_vars: z.array(mcpEnvName).max(INPUT_LIMITS.mcpMapEntries).optional(),
    startup_timeout_sec: z.number().positive().max(3_600).optional(),
    tool_timeout_sec: z.number().positive().max(3_600).optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    enabled_tools: boundedMcpNames.optional(),
    disabled_tools: boundedMcpNames.optional(),
    authentication: z.enum(["on_install", "on_first_use"]).optional(),
  })
  .strip();

/**
 * Cross-field validation for one MCP server: a `stdio` server requires `command`
 * and forbids the remote-only `url`/`headers`; an `http`/`sse` server requires a
 * well-formed http(s) `url` and forbids the stdio-only
 * `command`/`args`/`env`/`shared`.
 *
 * @param server - the parsed {@link mcpServerBase} object.
 * @param ctx - the Zod refinement context issues are pushed onto.
 */
function refineMcpServer(server: z.infer<typeof mcpServerBase>, ctx: z.core.$RefinementCtx): void {
  if (server.type === "stdio") {
    if (!server.command) {
      ctx.addIssue({
        code: "custom",
        message: "mcpServers[].command is required when type is 'stdio'",
        path: ["command"],
      });
    }
    if (server.url !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "mcpServers[].url is not valid for a 'stdio' transport",
        path: ["url"],
      });
    }
    if (server.headers !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "mcpServers[].headers is not valid for a 'stdio' transport",
        path: ["headers"],
      });
    }
    for (const field of ["oauth", "bearer_token_env_var", "env_http_headers"] as const) {
      if (server[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `mcpServers[].${field} is not valid for a 'stdio' transport`,
          path: [field],
        });
      }
    }
  } else {
    if (!server.url) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].url is required when type is '${server.type}'`,
        path: ["url"],
      });
    } else if (!isWellFormedHttpUrl(server.url)) {
      ctx.addIssue({
        code: "custom",
        message: "mcpServers[].url must be a well-formed http(s) URL",
        path: ["url"],
      });
    }
    if (server.command !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].command is not valid for a '${server.type}' transport`,
        path: ["command"],
      });
    }
    if (server.args !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].args is not valid for a '${server.type}' transport`,
        path: ["args"],
      });
    }
    if (server.env !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].env is not valid for a '${server.type}' transport`,
        path: ["env"],
      });
    }
    if (server.cwd !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].cwd is not valid for a '${server.type}' transport`,
        path: ["cwd"],
      });
    }
    if (server.shared !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].shared is not valid for a '${server.type}' transport (stdio only)`,
        path: ["shared"],
      });
    }
    if (server.env_vars !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `mcpServers[].env_vars is not valid for a '${server.type}' transport`,
        path: ["env_vars"],
      });
    }
  }
  const overlap = server.enabled_tools?.filter((tool) => server.disabled_tools?.includes(tool));
  if ((overlap?.length ?? 0) > 0) {
    ctx.addIssue({
      code: "custom",
      message: `mcpServers[].enabled_tools and disabled_tools overlap: ${overlap!.join(", ")}`,
      path: ["disabled_tools"],
    });
  }
}

/**
 * One validated MCP server entry: {@link mcpServerBase} plus the
 * transport-consistency checks from {@link refineMcpServer}.
 */
export const mcpServerSettingsSchema = mcpServerBase.strict().superRefine(refineMcpServer);

/**
 * The same entry as {@link mcpServerSettingsSchema}, but tolerant of keys this
 * host gives no meaning to.
 *
 * @remarks
 * For a **plugin manifest** only, never for `settings.json`. The two documents
 * have opposite failure economics. An operator writing their own settings is
 * best served by a strict schema: a misspelled key there is a typo they can fix,
 * and telling them is the whole point. A manifest arrives from a checkout
 * written against another agent host, and every configuration key that host has
 * and this one does not — a working directory, a per-server startup budget, a
 * note to the reader — arrives with it. Rejecting the entry over one of those
 * did not withhold a server; it failed the manifest, and with it the plugin's
 * agents, hooks and skills. Measured on a public catalog of 196 plugins, that
 * single rule broke 24 of them and cost 82 skills that had nothing to do with
 * MCP.
 *
 * Unknown keys are dropped rather than carried, so nothing downstream can start
 * reading one by accident and make it a contract this host never agreed to.
 * What a key *means* elsewhere is not knowable here, and acting on a guess is
 * how a plugin ends up doing something its author never asked this host to do.
 */
export const mcpServerPluginSchema = z
  .preprocess(inferMcpTransport, mcpServerBase)
  .superRefine(refineMcpServer);

/** Exact identity of one plugin installation in settings. */
export const pluginRefField = z
  .object({
    scope: z.enum(["global", "workspace"]),
    source: z.enum(["agents", "clarvis"]),
    name: pluginNameField,
  })
  .strict();

/**
 * The full `settings.json` schema: provider instances, MCP servers, model /
 * reasoning / budget defaults, every capability's settings block (spread in from
 * {@link capabilitySettingsFields}), plugin marketplaces, and the exact
 * `enabledPlugins` activation list used by `builtin:default`.
 *
 * @remarks `.strict()` — an unrecognized top-level key is rejected. Merge
 *   strategy across global/workspace/plugin scopes is defined in the settings
 *   merge module, not here.
 */
export const settingsSchema = z
  .object({
    providers: z
      .array(providerConfigSchema)
      .max(1_000, "providers must contain at most 1000 entries")
      .optional()
      .describe("Named provider instances referenced by profile model tokens."),
    mcpServers: z
      .record(z.string().min(1), mcpServerSettingsSchema)
      .refine((value) => boundedRecord(value, INPUT_LIMITS.mcpMapEntries), {
        message: `mcpServers may contain at most ${String(INPUT_LIMITS.mcpMapEntries)} entries`,
      })
      .optional()
      .describe(
        "MCP servers keyed by name (the name is the map key) — the ecosystem-standard " +
          "`mcpServers` shape. Each agent references a server's tools as `<name>.<tool>`.",
      ),
    default_model: modelField
      .optional()
      .describe(
        "Model used by the run's Lead, overriding its agent profile. A spawned Sub-agent keeps " +
          "its own model when it declares one.",
      ),
    default_vision_model: modelField
      .optional()
      .describe(
        "Model used to read a turn's images when the agent's own model cannot see them. The " +
          "pass is a single completion with no tools; its reading is spliced into the agent's " +
          "context. Omit to leave images as numbered placeholders for a blind model.",
      ),
    default_reasoning_effort: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe(
        "Reasoning effort used by the run's Lead, overriding its agent profile. A spawned " +
          "Sub-agent keeps its own effort when it declares one.",
      ),
    budget: settingsBudgetSchema
      .optional()
      .describe("Default run budget when an agent declares none."),
    ...capabilitySettingsFields,
    marketplaces: z
      .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.marketplaces)
      .optional()
      .describe(
        "Git URLs of plugin marketplaces to browse. A marketplace is a git repo with a " +
          "marketplace.json at its root. Listing a plugin there grants it nothing: it still has " +
          "to be installed, enabled, and approved.",
      ),
    enabledPlugins: z
      .array(pluginRefField)
      .max(INPUT_LIMITS.enabledPlugins)
      .optional()
      .describe(
        "Exact plugin installations to enable in builtin:default. Duplicate exact references " +
          "are removed while distinct installations with the same runtime name make the " +
          "resolved Environment invalid.",
      ),
  })
  .strict();

/** The inferred type of a validated `settings.json`; see {@link settingsSchema}. */
export type SettingsFile = z.infer<typeof settingsSchema>;
/** The inferred type of one validated MCP server entry; see {@link mcpServerSettingsSchema}. */
export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>;
/** The inferred exact plugin identity used by `enabledPlugins`. */
export type PluginRefSettings = z.infer<typeof pluginRefField>;
