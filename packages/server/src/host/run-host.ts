import type { RunService } from "@clarvis/protocol";
import type { Principal } from "../auth/principals.ts";

/**
 * The kernel surface the facade consumes: starting a run, and nothing else.
 *
 * @remarks Deliberately narrower than `InProcessKernel`. It makes the read-only
 * posture structural — there is no reachable path to config, secrets, files or
 * cross-owner run listing — and it lets tests inject a hand-written fake without
 * pulling in the engine. `InProcessKernel` satisfies it structurally.
 */
export interface RunHost {
  readonly runs: Pick<RunService, "start">;
}

/** What {@link KernelResolver} decides from. */
export interface OwnerContext {
  /** MCP session id, absent during `initialize`. */
  readonly sessionId: string | undefined;
  /** The validated owner this connection speaks for. */
  readonly owner: string;
  /** Request headers — where the authentication layer reads its credential. */
  readonly headers: Headers;
  /** The authenticated caller, absent when the deployment runs without auth. */
  readonly principal?: Principal | undefined;
}

/** The host bound to one owner for the lifetime of a session. */
export interface ResolvedHost {
  readonly host: RunHost;
  /** Canonical owner id, echoed back in run envelopes. */
  readonly owner: string;
  /**
   * The caller this session was opened by, absent without auth.
   *
   * @remarks Carried through so the tool handlers can enforce the caller's role
   * without re-reading a credential the transport has already consumed.
   */
  readonly principal?: Principal | undefined;
  /** Released when the session closes; a per-owner kernel cache hooks in here. */
  readonly release?: () => void;
}

/**
 * Resolves the host serving a connection.
 *
 * @remarks The single seam authentication and per-owner scoping both land in.
 * It is called once per session, at `initialize`, and never per request.
 */
export type KernelResolver = (ctx: OwnerContext) => Promise<ResolvedHost>;

/**
 * A resolver serving one kernel to every caller.
 *
 * @param host - the kernel backing every session.
 * @param owner - the owner id reported back; defaults to `"default"`.
 * @returns a {@link KernelResolver} that ignores the request context.
 * @remarks The one-container-one-config deployment. Per-owner data separation
 *   replaces this with a resolver that scopes the kernel by `ctx.owner`.
 */
export function fixedKernelResolver(host: RunHost, owner = "default"): KernelResolver {
  return () => Promise.resolve({ host, owner });
}
