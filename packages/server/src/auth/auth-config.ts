import { statSync } from "node:fs";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { z } from "zod";
import { OWNER_MAX_LENGTH, OWNER_RE } from "../config/owner.ts";
import { isClientSecretHash } from "./secrets.ts";
import { readBoundedUtf8Sync } from "./bounded-file.ts";

const MAX_AUTH_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_CLIENTS = 4_096;
const MAX_AUTH_ROLES = 256;
const MAX_ROLE_AGENTS = 256;

/** What a role may do, after the built-in defaults have been folded in. */
export interface RolePermissions {
  /** Agents the role may run: every one, or an explicit allowlist. */
  readonly agents: "*" | readonly string[];
  /** Whether a guarded command may be approved by this caller at all. */
  readonly guardConfirmations: "relay" | "deny";
  /** Whether the caller may act for an owner other than its own. */
  readonly mayImpersonateOwner: boolean;
  /** Per-role concurrent-run cap; the server-wide per-owner cap still applies. */
  readonly maxRuns?: number;
}

/** One enrolled client: the config file's unit of enrolment. */
export interface AuthClient {
  readonly clientId: string;
  /** A `sha256:<base64url>` digest, never a plaintext secret. */
  readonly secretHash: string;
  readonly owner: string;
  readonly role: string;
  readonly disabled: boolean;
}

/** The validated contents of `auth.json`, with every default resolved. */
export interface AuthConfig {
  readonly issuer: string;
  /** This server's RFC 8707 resource identifier: the `aud` of every token it mints. */
  readonly resource: string;
  readonly tokenTtlS: number;
  readonly clients: readonly AuthClient[];
  readonly roles: Readonly<Record<string, RolePermissions>>;
}

/**
 * The two roles that exist without being declared.
 *
 * @remarks `agents: "*"` is the permissive default because agents are
 * operator-authored files in the operator's own config directory; narrowing a
 * role to a subset is the opt-in. A declared role of the same name overrides
 * these field by field, and a role name that is not one of these starts from
 * `user`.
 */
export const BUILT_IN_ROLES: Readonly<Record<string, RolePermissions>> = Object.freeze({
  admin: Object.freeze({
    agents: "*",
    guardConfirmations: "relay",
    mayImpersonateOwner: true,
  }),
  user: Object.freeze({
    agents: "*",
    guardConfirmations: "deny",
    mayImpersonateOwner: false,
  }),
});

/** A client id: a token `sub`, so punctuation common in service names is allowed. */
const clientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/,
    "client_id must start and end with [A-Za-z0-9], with interior '.', '_', ':' or '-'",
  );

/** A role name, in the same lowercase shape as an owner id. */
const roleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, "role names are lowercase, starting with a letter");

/** An owner id, held to exactly the rule {@link resolveOwnerId} enforces per request. */
const ownerSchema = z
  .string()
  .min(1)
  .max(OWNER_MAX_LENGTH)
  .regex(OWNER_RE, "owner must match [a-z0-9] with interior '_' or '-' only");

/**
 * A stored secret digest.
 *
 * @remarks Rejecting a value that is not a recognised digest is what stops a
 * plaintext secret pasted into `secret_hash` from becoming a client that boots
 * cleanly and can never authenticate.
 */
const secretHashSchema = z
  .string()
  .min(1)
  .refine(
    isClientSecretHash,
    "secret_hash must be a `sha256:<base64url>` digest — produce one with `clarvis-server hash-secret`",
  );

/** A declared role: every field optional, folded onto its base. */
const roleSchema = z
  .object({
    agents: z
      .union([z.literal("*"), z.array(z.string().min(1).max(128)).min(1).max(MAX_ROLE_AGENTS)])
      .optional(),
    guard_confirmations: z.enum(["relay", "deny"]).optional(),
    may_impersonate_owner: z.boolean().optional(),
    max_runs: z.coerce.number().int().positive().optional(),
  })
  .strict();

const clientSchema = z
  .object({
    client_id: clientIdSchema,
    secret_hash: secretHashSchema,
    owner: ownerSchema,
    role: roleNameSchema.default("user"),
    disabled: z.boolean().default(false),
  })
  .strict();

/** The on-disk shape of `auth.json`. */
const authFileSchema = z
  .object({
    version: z.literal(1),
    issuer: z.string().url().optional(),
    resource: z.string().url().optional(),
    /**
     * Access-token lifetime, in seconds.
     *
     * @remarks Bounded on both sides because both directions fail. A live
     * session re-resolves its principal per call, so a *narrowed* role takes
     * effect immediately and the TTL does not gate it — what the TTL does gate
     * is how long a leaked or revoked token stays usable, which is what sets the
     * ceiling at a day. The floor exists because the exchange is a real
     * round-trip: below a minute a caller spends a meaningful share of its
     * requests re-authenticating, and a clock skew between issuer and verifier
     * of ordinary size starts rejecting tokens that were valid when minted. An
     * hour is the default as the usual balance between the two.
     */
    token_ttl_s: z.coerce.number().int().min(60).max(86_400).default(3_600),
    clients: z
      .array(clientSchema)
      .min(1, "auth.json must declare at least one client — an empty table is not 'allow everyone'")
      .max(MAX_AUTH_CLIENTS),
    roles: z
      .record(roleNameSchema, roleSchema)
      .refine((value) => Object.keys(value).length <= MAX_AUTH_ROLES, {
        message: `auth.json may declare at most ${String(MAX_AUTH_ROLES)} roles`,
      })
      .default({}),
  })
  .strict();

/** Inputs {@link parseAuthConfig} resolves the issuer and resource from. */
export interface AuthConfigDefaults {
  /** The externally reachable base URL, e.g. `https://clarvis.example.com`. */
  readonly publicUrl?: string | undefined;
  /** The MCP endpoint path, appended to `publicUrl` to form the resource. */
  readonly mcpPath: string;
}

/** Condense a {@link z.ZodError} into one line per offending field. */
function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/** Strip a trailing slash so `publicUrl + mcpPath` never doubles it. */
function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Validate a parsed `auth.json` and resolve its defaults.
 *
 * @param raw - the JSON value read from disk.
 * @param defaults - how to derive `issuer`/`resource` when the file omits them.
 * @returns the {@link AuthConfig} with roles merged and identifiers resolved.
 * @throws {@link Error} naming every offending field. Every failure here is a
 *   boot failure by design: a half-understood auth file must not become a
 *   running server.
 */
export function parseAuthConfig(raw: unknown, defaults: AuthConfigDefaults): AuthConfig {
  const parsed = authFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid auth config: ${issueSummary(parsed.error)}`);
  const file = parsed.data;

  const base = defaults.publicUrl !== undefined ? trimSlash(defaults.publicUrl) : undefined;
  const issuer = file.issuer ?? base;
  const resource = file.resource ?? (base !== undefined ? `${base}${defaults.mcpPath}` : undefined);
  if (issuer === undefined || resource === undefined) {
    throw new Error(
      "invalid auth config: cannot determine this server's identity — set `issuer` and `resource` " +
        "in auth.json, or set CLARVIS_SERVER_PUBLIC_URL to the URL clients reach it on",
    );
  }

  const roles: Record<string, RolePermissions> = { ...BUILT_IN_ROLES };
  for (const [name, declared] of Object.entries(file.roles)) {
    const inherited = BUILT_IN_ROLES[name] ?? BUILT_IN_ROLES.user;
    roles[name] = {
      agents: declared.agents ?? inherited?.agents ?? "*",
      guardConfirmations: declared.guard_confirmations ?? inherited?.guardConfirmations ?? "deny",
      mayImpersonateOwner:
        declared.may_impersonate_owner ?? inherited?.mayImpersonateOwner ?? false,
      ...(declared.max_runs !== undefined ? { maxRuns: declared.max_runs } : {}),
    };
  }

  const seen = new Set<string>();
  const clients: AuthClient[] = [];
  for (const client of file.clients) {
    if (seen.has(client.client_id)) {
      throw new Error(`invalid auth config: duplicate client_id '${client.client_id}'`);
    }
    seen.add(client.client_id);
    if (roles[client.role] === undefined) {
      throw new Error(
        `invalid auth config: client '${client.client_id}' has undeclared role '${client.role}'`,
      );
    }
    clients.push({
      clientId: client.client_id,
      secretHash: client.secret_hash,
      owner: client.owner,
      role: client.role,
      disabled: client.disabled,
    });
  }

  return { issuer, resource, tokenTtlS: file.token_ttl_s, clients, roles };
}

/**
 * Read and validate `auth.json`.
 *
 * @param file - absolute path to the auth config.
 * @param defaults - see {@link AuthConfigDefaults}.
 * @returns the validated {@link AuthConfig}.
 * @throws {@link Error} when the file is missing, unreadable, not JSON, or fails
 *   {@link parseAuthConfig}.
 */
export function readAuthConfig(file: string, defaults: AuthConfigDefaults): AuthConfig {
  let text: string;
  try {
    text = readBoundedUtf8Sync(file, MAX_AUTH_CONFIG_BYTES);
  } catch (err) {
    throw new Error(
      `cannot read auth config at ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`auth config at ${file} is not valid JSON`, { cause: err });
  }
  return parseAuthConfig(raw, defaults);
}

/** A config that re-reads itself when the file underneath it changes. */
export interface AuthConfigSource {
  /** The current configuration, reloading first when the file has changed. */
  current(): AuthConfig;
  readonly path: string;
}

/** Options for {@link createAuthConfigSource}. */
export interface AuthConfigSourceOptions {
  file: string;
  defaults: AuthConfigDefaults;
  /**
   * Shortest interval between two `stat` calls; defaults to 1000ms.
   *
   * @remarks A test seam, and the only caller is the suite: production
   * construction in {@link import("./bootstrap.ts").createAuthLayer |
   * createAuthLayer} passes `file`, `defaults` and `audit` and leaves this at
   * its default. It is a plain optional field rather than a hidden one because
   * the throttle bounds `stat` frequency and nothing else — a host choosing its
   * own interval changes how quickly an enrolment edit is noticed, never
   * whether the file is honoured. `0` is what lets a test write the file and
   * observe the reload without sleeping past a real second.
   */
  reloadThrottleMs?: number;
  /**
   * Where every reload outcome is recorded.
   *
   * @remarks The audit channel, not a diagnostic one, and not a caller-supplied
   * callback: who may authenticate is an audit fact, and
   * `CLARVIS_LOG_LEVEL=warn` is a legitimate production setting that must not
   * silence a change to the enrolment table.
   */
  audit?: Logger;
}

/** The change stamp a file that is not there produces. */
const MISSING_STAMP = "missing";

/** Ids present in `next` and absent from `prev`, as one scalar field value. */
function idsJoined(ids: readonly string[]): string {
  return ids.join(",");
}

/** Record a reload that replaced the enrolment table. */
function reportReloaded(audit: Logger, file: string, previous: AuthConfig, next: AuthConfig): void {
  const before = new Map(previous.clients.map((client) => [client.clientId, client]));
  const after = new Map(next.clients.map((client) => [client.clientId, client]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const disabled = [...after.values()]
    .filter((client) => client.disabled && before.get(client.clientId)?.disabled !== true)
    .map((client) => client.clientId);
  audit.info(
    {
      event: "auth.config.reloaded",
      file,
      clients: next.clients.length,
      added: idsJoined(added),
      removed: idsJoined(removed),
      disabled: idsJoined(disabled),
    },
    "the enrolment table was re-read; a removed or disabled client's outstanding tokens stop working on its next request",
  );
}

/** Record a reload that failed, leaving the last known-good table in place. */
function reportReloadFailed(audit: Logger, file: string, err: unknown, keptClients: number): void {
  audit.warn(
    {
      event: "auth.config.reload_failed",
      file,
      err: err instanceof Error ? err.message : String(err),
      kept_clients: keptClients,
    },
    "the enrolment table could not be re-read; the last known-good one is still in force",
  );
}

/** Record an enrolment table that has vanished from disk. */
function reportDisappeared(audit: Logger, file: string, keptClients: number): void {
  audit.warn(
    { event: "auth.config.disappeared", file, kept_clients: keptClients },
    "the enrolment table is gone from disk; the last known-good one is still in force and no client was revoked by its deletion",
  );
}

/**
 * Build a self-reloading {@link AuthConfigSource}.
 *
 * @param opts - file, defaults and the reload-failure sink.
 * @returns the source; the first read happens eagerly, so a bad file fails at
 *   boot.
 * @throws {@link Error} when the initial read fails.
 * @remarks **Fail closed at boot, fail safe on reload.** The first read must
 *   succeed or the process has no business serving. A later read that fails —
 *   a half-written save, a bad edit — keeps the last known-good configuration
 *   and reports the error, because dropping every enrolled client because
 *   somebody's editor wrote a partial file is the worse outcome.
 *
 *   Reloading is what lets the token stay free of owner and role: removing or
 *   disabling a client takes effect on its next request rather than at its
 *   token's expiry.
 *
 *   A file that has **vanished** is reported as its own thing rather than as a
 *   failed read. It is the one degradation an operator would otherwise never
 *   see: the table stays in force, so every enrolled client keeps working, and
 *   deleting `auth.json` looks exactly like changing nothing.
 */
export function createAuthConfigSource(opts: AuthConfigSourceOptions): AuthConfigSource {
  const throttleMs = opts.reloadThrottleMs ?? 1_000;
  const audit = opts.audit ?? NOOP_LOGGER;
  let config = readAuthConfig(opts.file, opts.defaults);
  let stamp = fingerprint(opts.file);
  let checkedAt = Date.now();

  const reload = (): void => {
    try {
      const next = readAuthConfig(opts.file, opts.defaults);
      reportReloaded(audit, opts.file, config, next);
      config = next;
    } catch (err) {
      reportReloadFailed(audit, opts.file, err, config.clients.length);
    }
  };

  return {
    path: opts.file,
    current(): AuthConfig {
      const now = Date.now();
      if (now - checkedAt < throttleMs) return config;
      checkedAt = now;
      const next = fingerprint(opts.file);
      if (next === stamp) return config;
      stamp = next;
      if (next === MISSING_STAMP) reportDisappeared(audit, opts.file, config.clients.length);
      else reload();
      return config;
    },
  };
}

/** A cheap change stamp: size and mtime, or {@link MISSING_STAMP} when the file is gone. */
function fingerprint(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return MISSING_STAMP;
  }
}
