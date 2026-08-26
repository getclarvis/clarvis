import { z } from "zod";
import { boolFromEnv } from "@clarvis/capability";

/** A schema field coercing an env string to a positive integer. */
const positiveInt = z.coerce.number().int().positive();
/** A schema field coercing an env string to a non-negative integer. */
const nonnegativeInt = z.coerce.number().int().nonnegative();

/** A comma-separated list, trimmed per entry with empties dropped, so a trailing
 * comma or padded value in a container spec is not read as a member. */
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

/** Field-level schema for every `CLARVIS_SERVER_*` variable; see
 * {@link serverEnvSchema} for the cross-field checks layered on top. */
const baseServerEnvSchema = z.object({
  CLARVIS_SERVER_HOST: z.string().min(1).default("127.0.0.1"),
  CLARVIS_SERVER_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  CLARVIS_SERVER_PATH: z.string().min(1).default("/mcp"),
  CLARVIS_WORKSPACE_ROOT: z.string().min(1).optional(),
  CLARVIS_HOME: z.string().min(1).optional(),

  CLARVIS_SERVER_OWNER: z.string().min(1).default("default"),
  CLARVIS_SERVER_OWNER_MODE: z.enum(["fixed", "header", "allowlist", "token"]).default("fixed"),
  CLARVIS_SERVER_OWNER_HEADER: z.string().min(1).default("x-clarvis-owner"),
  CLARVIS_SERVER_OWNER_ALLOWLIST: csv,

  CLARVIS_SERVER_AUTH: z.enum(["off", "required"]).default("off"),
  CLARVIS_SERVER_AUTH_FILE: z.string().min(1).optional(),
  CLARVIS_SERVER_PUBLIC_URL: z.string().url().optional(),

  CLARVIS_SERVER_MAX_RUNS: positiveInt.default(16),
  CLARVIS_SERVER_MAX_RUNS_PER_OWNER: positiveInt.default(4),
  CLARVIS_SERVER_RUN_MAX_MS: positiveInt.default(1_800_000),
  CLARVIS_SERVER_RUN_SETTLE_GRACE_MS: positiveInt.default(10_000),
  CLARVIS_SERVER_SESSION_IDLE_MS: positiveInt.default(900_000),
  CLARVIS_SERVER_MAX_SESSIONS: positiveInt.default(128),
  CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS: positiveInt.default(30_000),

  CLARVIS_SERVER_DRAIN_DELAY_MS: nonnegativeInt.default(5_000),
  CLARVIS_SERVER_SHUTDOWN_GRACE_MS: positiveInt.default(15_000),

  CLARVIS_SERVER_HEARTBEAT_MS: positiveInt.default(10_000),
  CLARVIS_SERVER_STREAM_BUFFER_MAX: positiveInt.default(1_024),
  CLARVIS_SERVER_STREAM_BUFFER_BYTES: positiveInt.default(8 * 1024 * 1024),
  CLARVIS_SERVER_STREAM_SEND_TIMEOUT_MS: positiveInt.default(30_000),

  CLARVIS_SERVER_ELICIT_TOOL_WAIT_MS: positiveInt.default(120_000),
  CLARVIS_SERVER_ELICIT_RELAY_MS: positiveInt.default(600_000),
  CLARVIS_SERVER_ELICIT_BACKSTOP_MS: positiveInt.default(60_000),
  CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL: boolFromEnv(false),

  CLARVIS_SERVER_ALLOW_PUBLIC_BIND: boolFromEnv(false),
  CLARVIS_SERVER_ALLOW_LAN_BIND: boolFromEnv(false),
  CLARVIS_SERVER_ALLOWED_ORIGINS: csv,
  CLARVIS_SERVER_ALLOWED_HOSTS: csv,
  CLARVIS_SERVER_MAX_BODY_BYTES: positiveInt.default(4_194_304),

  /**
   * How much of the per-request hot path reaches the log.
   *
   * @remarks An environment variable and not a `settings.json` key, on the same
   * reasoning that keeps `auth.json` out of `ConfigService`: settings merge the
   * **workspace** scope, which is a file inside the agent's own working tree, so
   * a run that could write it could silence the record of what it did.
   */
  CLARVIS_SERVER_LOG_REQUESTS: z.enum(["off", "errors", "all"]).default("errors"),

  CLARVIS_SERVER_MEMORY: boolFromEnv(false),
  CLARVIS_SERVER_READINESS_REQUIRE_MCP: csv,
  CLARVIS_SERVER_KEY_SOURCES: z
    .string()
    .default("{}")
    .transform((s, ctx) => {
      try {
        return z.record(z.string(), z.enum(["auto", "env", "keyfile"])).parse(JSON.parse(s));
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "must be a JSON object mapping NAME to auto|env|keyfile",
        });
        return z.NEVER;
      }
    }),
});

/**
 * The server's own environment schema plus the cross-field checks that make an
 * incoherent deployment fail at boot rather than at the first request.
 */
const serverEnvSchema = baseServerEnvSchema.superRefine((cfg, ctx) => {
  if (cfg.CLARVIS_SERVER_MAX_RUNS_PER_OWNER > cfg.CLARVIS_SERVER_MAX_RUNS) {
    ctx.addIssue({
      code: "custom",
      path: ["CLARVIS_SERVER_MAX_RUNS_PER_OWNER"],
      message:
        `CLARVIS_SERVER_MAX_RUNS_PER_OWNER (${cfg.CLARVIS_SERVER_MAX_RUNS_PER_OWNER}) must be <= ` +
        `CLARVIS_SERVER_MAX_RUNS (${cfg.CLARVIS_SERVER_MAX_RUNS})`,
    });
  }
  if (
    cfg.CLARVIS_SERVER_OWNER_MODE === "allowlist" &&
    cfg.CLARVIS_SERVER_OWNER_ALLOWLIST.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["CLARVIS_SERVER_OWNER_ALLOWLIST"],
      message: "CLARVIS_SERVER_OWNER_ALLOWLIST must list at least one owner in allowlist mode",
    });
  }
  if (cfg.CLARVIS_SERVER_OWNER_MODE === "token" && cfg.CLARVIS_SERVER_AUTH !== "required") {
    ctx.addIssue({
      code: "custom",
      path: ["CLARVIS_SERVER_OWNER_MODE"],
      message:
        "owner mode 'token' takes the owner from the authenticated caller, so it requires " +
        "CLARVIS_SERVER_AUTH=required",
    });
  }
  if (
    cfg.CLARVIS_SERVER_AUTH === "required" &&
    (cfg.CLARVIS_SERVER_OWNER_MODE === "header" || cfg.CLARVIS_SERVER_OWNER_MODE === "allowlist")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["CLARVIS_SERVER_OWNER_MODE"],
      message:
        `owner mode '${cfg.CLARVIS_SERVER_OWNER_MODE}' reads the owner from a header the caller ` +
        "chooses, which would leave the data namespace unauthenticated on a server whose callers " +
        "are authenticated; use 'token' or 'fixed'",
    });
  }
});

/** The parsed, frozen server configuration produced by {@link loadServerEnv}. */
export type ServerEnv = Readonly<z.infer<typeof baseServerEnvSchema>>;

/**
 * Parse the server's `CLARVIS_SERVER_*` environment.
 *
 * @param source - the environment to read (defaults to `process.env`).
 * @returns the validated, frozen configuration.
 * @throws {@link Error} naming every offending field when the environment is
 *   invalid.
 * @remarks Deliberately separate from the loop's `loadEnv`: concurrency, wall
 *   clock, bind address and drain are concepts the embedded engine does not have,
 *   and adding them to `EnvConfig` would put dead fields in every host.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid server environment configuration: ${issues}`);
  }
  return Object.freeze(parsed.data);
}

/** Hosts reachable only from this machine. */
const LOOPBACK_HOST_RE = /^(?:127\.\d+\.\d+\.\d+|::1|localhost)$/;

/** RFC1918 ranges: reachable from the local network, not from the internet. */
const PRIVATE_LAN_HOST_RE =
  /^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * Whether a bind address is reachable only from this machine.
 *
 * @param host - the address the server would bind.
 * @returns `true` for `127.0.0.0/8`, `::1` and `localhost`.
 * @remarks This is the only bind that needs no opt-in. There is no
 *   authentication, so on loopback the operating system's process boundary is
 *   the whole security model — and that is a real boundary.
 */
export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_HOST_RE.test(host.trim());
}

/**
 * Whether a bind address is an RFC1918 local-network address.
 *
 * @param host - the address the server would bind.
 * @returns `true` for `10/8`, `172.16/12` and `192.168/16`.
 * @remarks Kept distinct from loopback because the two carry completely
 *   different exposure and were previously conflated: binding `192.168.1.20`
 *   passed the "private" check silently and handed arbitrary command execution
 *   to every device on the network. "Private" describes who routes the packet,
 *   not who is trusted.
 */
export function isPrivateLanBind(host: string): boolean {
  return PRIVATE_LAN_HOST_RE.test(host.trim());
}

/**
 * Whether a bind address is loopback or an RFC1918 private-range address.
 *
 * @param host - the address the server would bind.
 * @returns `true` when the address is not publicly routable.
 * @remarks Retained for the public-bind gate, which still treats "not public" as
 *   one category. The LAN case has its own, separate opt-in; see
 *   {@link isLoopbackBind} and {@link isPrivateLanBind}.
 */
export function isPrivateBind(host: string): boolean {
  return isLoopbackBind(host) || isPrivateLanBind(host);
}
