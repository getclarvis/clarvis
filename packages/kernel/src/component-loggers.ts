import {
  NOOP_LOGGER,
  activeLevelOf,
  bindLevelled,
  componentLogger,
  levelFor,
  parseLogScopes,
  type Logger,
  type LogLevel,
} from "@clarvis/capability";

/**
 * Derives the logger one subsystem writes through.
 *
 * @remarks Called once per collaborator the kernel constructs, never per record.
 */
export type ComponentLoggers = (component: string) => Logger;

/**
 * The level a component child should be pinned at for one host.
 *
 * @param root - the host's logger, or `undefined` when it supplied none.
 * @param configured - the environment's `CLARVIS_LOG_LEVEL`.
 * @returns the host's own level when it reports one, else `configured`.
 * @remarks A host may configure its logger itself, and pinning that host's
 *   component children to an environment variable it never set is how a
 *   deliberately silenced logger starts writing again. `@clarvis/code` boots
 *   every kernel at `silent` because its stdout and stderr are a rendered
 *   canvas; a component child pinned at the `info` default wrote raw JSON over
 *   the frame on every workspace acquire. Where the host's logger *is* built
 *   from `CLARVIS_LOG_LEVEL`, the two agree and this changes nothing.
 */
export function componentFloor(root: Logger | undefined, configured: LogLevel): LogLevel {
  return root === undefined ? configured : (activeLevelOf(root) ?? configured);
}

/**
 * Build the per-component logger factory for one host.
 *
 * @param root - the host's logger; `undefined` yields an all-silent factory.
 * @param spec - the raw `CLARVIS_LOG` value, e.g. `mcp=debug,paths.lease=debug`.
 * @param fallback - the level a component no scope covers emits at, normally
 *   `CLARVIS_LOG_LEVEL`.
 * @returns a {@link ComponentLoggers}.
 * @remarks This is where a single global level stops being the only knob. A run
 *   that needs `mcp` at `debug` should not have to take the whole engine to
 *   `debug` with it, and an operator debugging one subsystem should not have to
 *   read every other subsystem's per-iteration output to do it.
 *
 *   Component names are matched longest-prefix on dot boundaries and the
 *   vocabulary is open, so a capability outside the engine names its own without
 *   the engine declaring it.
 *
 *   A **silent root yields an all-silent factory**, exactly as an absent one
 *   does, and for the reason {@link createAuditLogger} states: `silent` is not a
 *   verbosity preference, it is a host saying it has no channel. `componentFloor`
 *   guards only this function's `fallback`, and `levelFor` overrides a fallback
 *   whenever a scope matches — so one `CLARVIS_LOG=worktrees=debug` in the
 *   operator's environment pinned a child above a root `@clarvis/code` had
 *   deliberately silenced, and a pino child's level wins over its parent in both
 *   directions. That wrote raw JSON over the rendered canvas, mid-string,
 *   including across the plan-approval gate.
 */
export function createComponentLoggers(
  root: Logger | undefined,
  spec: string | undefined,
  fallback: LogLevel,
): ComponentLoggers {
  if (root === undefined || activeLevelOf(root) === "silent") return () => NOOP_LOGGER;
  const scopes = parseLogScopes(spec);
  const cache = new Map<string, Logger>();
  return (component: string): Logger => {
    const existing = cache.get(component);
    if (existing !== undefined) return existing;
    const derived = componentLogger(root, component, levelFor(scopes, component, fallback));
    cache.set(component, derived);
    return derived;
  };
}

/**
 * Build the channel every audit record is written through.
 *
 * @param root - the host's logger; `undefined` yields a silent channel.
 * @param enabled - the resolved `CLARVIS_LOG_AUDIT`.
 * @returns a logger stamped `{ component: "audit", audit: true }` and pinned at
 *   `info`, or {@link NOOP_LOGGER} when the host has none or audit is off.
 * @remarks Pinned rather than inherited, over the same destination, because
 *   `CLARVIS_LOG_LEVEL=warn` is a legitimate production setting and would
 *   otherwise silence every authentication success, every config reload and
 *   every guard verdict — the records an operator is least able to reconstruct
 *   after the fact. See `specs/cross-cutting/observability.md` §4.3.
 *
 *   `silent` is the one level it does not override, because `silent` is not a
 *   verbosity preference — it is a host saying it has no channel. `@clarvis/code`
 *   boots every kernel at `silent` because its stdout and stderr are a rendered
 *   canvas, and a pino child's level wins over its parent in **both** directions,
 *   so pinning audit at `info` there wrote a raw JSON line over the frame on
 *   every guarded tool call. Audit bypasses a level that would *filter* it, never
 *   a host that cannot receive it.
 */
export function createAuditLogger(root: Logger | undefined, enabled: boolean): Logger {
  if (root === undefined || !enabled) return NOOP_LOGGER;
  if (activeLevelOf(root) === "silent") return NOOP_LOGGER;
  return bindLevelled(root, { component: "audit", audit: true }, "info");
}
