import { AuthFailure } from "../auth/failure.ts";
import type { Principal } from "../auth/principals.ts";
import { serverError } from "../mcp/errors.ts";

/**
 * How the facade decides which owner a connection speaks for.
 *
 * @remarks `fixed` is the default because owner ids provision per-owner data
 * directories on first use: an open endpoint that accepts any string is a
 * disk-fill vector. `header` must be opted into explicitly.
 *
 *   `token` is the only mode in which the owner is **authenticated**: it comes
 *   from the caller's enrolment record rather than from anything the caller
 *   sent. The other three separate data by namespace without proving the
 *   separation, and must not be described to a client as isolation.
 */
export type OwnerMode = "fixed" | "header" | "allowlist" | "token";

/** Longest accepted owner id, keeping the derived path segment well inside limits. */
export const OWNER_MAX_LENGTH = 64;

/**
 * Owner ids are lowercase alphanumerics plus `_`/`-`, never leading or trailing
 * punctuation.
 *
 * @remarks Exported so the auth config validates the owners it declares against
 * the very same rule a request is checked with; two copies would eventually
 * disagree, and the disagreement would be a config file that boots and then
 * refuses every request.
 */
export const OWNER_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Validate a caller-supplied owner id before anything touches the filesystem.
 *
 * @param raw - the untrusted id.
 * @returns the id, lowercased.
 * @throws a `invalid_request` {@link ServerError} when the id is empty, longer
 *   than {@link OWNER_MAX_LENGTH}, or contains anything outside
 *   {@link OWNER_RE} — which excludes `.`, `..`, `/`, `\` and NUL, so the id can
 *   never escape its own directory.
 * @remarks It normalizes before it measures — `trim().toLowerCase()` runs on the
 *   whole input, and only then is the length checked — so a header carrying an
 *   over-long value is transformed before it is refused. That ordering is
 *   deliberate: a value the caller sent with surrounding whitespace is a legal
 *   id, and measuring first would reject it. What bounds the transform is
 *   upstream and not Clarvis's: the HTTP server's own header-size limit, which
 *   this codebase neither sets nor configures. Under `fixed` and `allowlist` the
 *   input is operator-authored and bounded by the config file instead. If this
 *   is ever reached from a source with no bound of its own, it needs one here
 *   before the normalization, not after it.
 */
export function assertOwnerId(raw: string): string {
  const owner = raw.trim().toLowerCase();
  if (owner.length === 0) throw serverError("invalid_request", "owner id must not be empty");
  if (owner.length > OWNER_MAX_LENGTH) {
    throw serverError(
      "invalid_request",
      `owner id must be at most ${OWNER_MAX_LENGTH} characters (got ${owner.length})`,
    );
  }
  if (!OWNER_RE.test(owner)) {
    throw serverError(
      "invalid_request",
      "owner id must match [a-z0-9] with interior '_' or '-' only",
    );
  }
  return owner;
}

/** Inputs {@link resolveOwnerId} decides from. */
export interface ResolveOwnerInput {
  /** The request's headers, read only in `header`/`allowlist` mode. */
  headers: Headers;
  mode: OwnerMode;
  /** Header carrying the owner id in `header`/`allowlist` mode. */
  header: string;
  /** The single owner served in `fixed` mode. */
  fixed: string;
  /** Accepted ids in `allowlist` mode. */
  allowlist: ReadonlySet<string>;
  /** The authenticated caller, required in `token` mode. */
  principal?: Principal | undefined;
}

/**
 * Resolve the owner a request speaks for.
 *
 * @param input - mode, header name, the configured owner set and, under `token`
 *   mode, the authenticated caller.
 * @returns the validated owner id.
 * @throws a `invalid_request` {@link ServerError} when the header is missing in a
 *   header-driven mode, when the id fails {@link assertOwnerId}, or when
 *   `allowlist` mode receives an unregistered id — always **before** any
 *   directory is created for it.
 * @throws an {@link AuthFailure} when `token` mode receives an owner header from
 *   a role that may not act for another owner. Refusing rather than ignoring is
 *   deliberate: a caller whose owner header silently does nothing is
 *   misconfigured, and silence is how it stays that way.
 * @remarks Outside `token` mode the id is caller-supplied, so this separates data
 *   by namespace and does not authenticate the separation. Do not describe it to
 *   a client as isolation.
 */
export function resolveOwnerId(input: ResolveOwnerInput): string {
  if (input.mode === "fixed") return assertOwnerId(input.fixed);

  if (input.mode === "token") {
    const { principal } = input;
    if (principal === undefined) {
      throw serverError("internal", "owner mode 'token' requires an authenticated caller");
    }
    const claimed = input.headers.get(input.header);
    if (claimed === null || claimed.trim().length === 0) return assertOwnerId(principal.owner);
    if (!principal.permissions.mayImpersonateOwner) {
      throw new AuthFailure(
        403,
        "owner_not_permitted",
        `role '${principal.role}' may not act for another owner`,
      );
    }
    const owner = assertOwnerId(claimed);
    if (input.allowlist.size > 0 && !input.allowlist.has(owner)) {
      throw serverError("invalid_request", `owner '${owner}' is not registered`);
    }
    return owner;
  }

  const raw = input.headers.get(input.header);
  if (raw === null || raw.trim().length === 0) {
    throw serverError("invalid_request", `missing owner header '${input.header}'`);
  }
  const owner = assertOwnerId(raw);
  if (input.mode === "allowlist" && !input.allowlist.has(owner)) {
    throw serverError("invalid_request", `owner '${owner}' is not registered`);
  }
  return owner;
}
