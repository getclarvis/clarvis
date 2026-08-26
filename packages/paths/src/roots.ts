import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { CLARVIS_DIR } from "./constants.ts";
import { announceOnce, pathsLogger, type PathsLogger } from "./diag.ts";

/**
 * Environment variable naming the Clarvis global root, overriding `~/.clarvis`.
 */
export const HOME_ENV = "CLARVIS_HOME";

/**
 * Environment variable naming the workspace root, overriding the process cwd.
 *
 * @remarks
 * The same name `@clarvis/hooks` injects into every hook subprocess, so a hook
 * that invokes Clarvis inherits a variable that already points at the right
 * tree.
 */
export const WORKSPACE_ENV = "CLARVIS_WORKSPACE_ROOT";

/**
 * Ambient inputs a root resolution may draw on.
 *
 * @remarks
 * Every field is injectable so resolution is testable without mutating the
 * process. Omitted fields fall back to the ambient value at call time, never at
 * module load.
 */
export interface RootOptions {
  /** Environment to read overrides from; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** User home directory; defaults to {@link homedir}. */
  home?: string;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Where to report the resolved root; defaults to the process-wide sink.
   *
   * @remarks Reported once per process per distinct root, because which root a
   *   process chose — and whether an environment override chose it — is the
   *   first thing every other path in this package is derived from.
   */
  logger?: PathsLogger;
}

/**
 * Read an environment override, treating blank and whitespace-only as unset.
 *
 * @param env - the environment to read.
 * @param name - the variable to read.
 * @returns the trimmed value, or `undefined` when absent or blank.
 */
function override(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the Clarvis global root — `$CLARVIS_HOME`, else `<home>/.clarvis`.
 *
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns an absolute path.
 */
export function globalRoot(opts: RootOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = override(env, HOME_ENV);
  const root =
    fromEnv === undefined ? resolve(join(opts.home ?? homedir(), CLARVIS_DIR)) : resolve(fromEnv);
  if (announceOnce(`paths.roots_resolved\u0000global\u0000${root}`)) {
    (opts.logger ?? pathsLogger()).debug(
      {
        event: "paths.roots_resolved",
        global_root: root,
        global_from: fromEnv === undefined ? "home" : "env",
      },
      "resolved the Clarvis global root; every global path is derived from it",
    );
  }
  return root;
}

/**
 * Resolve the workspace root — `$CLARVIS_WORKSPACE_ROOT`, else the cwd.
 *
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns an absolute path to the working tree, *not* to its `.clarvis` dir.
 */
export function workspaceRoot(opts: RootOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = override(env, WORKSPACE_ENV);
  const root = fromEnv === undefined ? resolve(opts.cwd ?? process.cwd()) : resolve(fromEnv);
  if (announceOnce(`paths.roots_resolved\u0000workspace\u0000${root}`)) {
    (opts.logger ?? pathsLogger()).debug(
      {
        event: "paths.roots_resolved",
        workspace_root: root,
        workspace_from: fromEnv === undefined ? "cwd" : "env",
      },
      "resolved the Clarvis workspace root; every workspace path is derived from it",
    );
  }
  return root;
}

/**
 * Derive a filesystem-safe owner id from a workspace directory.
 *
 * @param workspaceDir - the workspace path; resolved to absolute before hashing.
 * @param fallback - the id to encode only if resolving the workspace somehow
 *   produces an empty value (defaults to `"clarvis"`).
 * @returns `ws_<sha256>`, derived from the canonical absolute path.
 * @remarks The old separator-to-underscore slug was lossy: `/a/b` and `/a_b`
 *   both became `_a_b`, silently merging their state. Hashing the complete
 *   canonical path keeps the id fixed-width and collision-resistant without
 *   putting a path separator into an owner id.
 */
export function ownerFromWorkspace(workspaceDir: string, fallback = "clarvis"): string {
  const canonical = resolve(workspaceDir) || fallback;
  return `ws_${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Stable owner/project/workspace namespace for persisted execution state. */
export function workspaceScopeKey(owner: string, projectId: string, workspaceId: string): string {
  return `scope_${createHash("sha256").update(`${owner}\0${projectId}\0${workspaceId}`).digest("hex")}`;
}

/** Canonical checkout path for one operator-requested Git worktree. */
export function worktreeCheckoutRoot(primaryWorkspaceRoot: string, name: string): string {
  return join(resolve(primaryWorkspaceRoot), CLARVIS_DIR, "worktrees", ownerSegment(name));
}

/** Longest encoded segment kept verbatim before falling back to a hash. */
const SEGMENT_MAX = 200;

/**
 * Percent-encode a value into a single safe path segment.
 *
 * @remarks Extends `encodeURIComponent` over the characters it leaves alone —
 * notably `.`, which must be encoded so a segment can never be `.` or `..`, and
 * so a flat `<owner>.<id>` filename has an unambiguous separator.
 */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[.!~*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

/**
 * Encode an arbitrary id as one filesystem-safe path segment.
 *
 * @param value - the raw id (an owner key, execution id or session id).
 * @returns the percent-encoded segment, or `h_<sha256hex>` when the encoded form
 *   would exceed {@link SEGMENT_MAX} bytes and risk a filename-length limit.
 * @throws {@link TypeError} when `value` is empty — an empty segment would
 *   resolve to the parent root itself, silently merging every owner into one.
 * @remarks The result never contains `/`, `\`, `.` or `..` and is never empty, so
 *   it is always exactly one non-escaping segment. The hashed branch is **not**
 *   reversible: a host that must map a directory name back to an owner keeps its
 *   own registry, or reads the owner off the stored record.
 *
 *   It sits beside {@link ownerFromWorkspace} because the two are the same kind
 *   of thing — encoders for a path segment — and because a trace store and an
 *   MCP connection pool both need it, so it must live in a leaf both can reach.
 */
export function ownerSegment(value: string): string {
  if (value.length === 0) throw new TypeError("owner segment must not be empty");
  const encoded = encodeSegment(value);
  if (Buffer.byteLength(encoded, "utf8") <= SEGMENT_MAX) return encoded;
  return `h_${createHash("sha256").update(value).digest("hex")}`;
}
