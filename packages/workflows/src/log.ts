/**
 * The narrow logging seam this package consumes.
 *
 * @remarks Fan-out is the hardest thing in the product to debug, because a
 * failure is distributed across runs that each have their own trace. Nothing
 * here *constructs* a logger: `@clarvis/loop` owns the only factory, and a
 * logger built locally would write to a fixed descriptor and bypass a TUI
 * host's silencing. The port arrives on {@link WorkflowCtx.deps}, which every
 * call site in this package already holds, so the events below cost no
 * signature change.
 *
 * The vocabulary is `specs/cross-cutting/observability.md`: `event` is the machine contract,
 * the message is a lowercase sentence naming the consequence, and no
 * model-authored prose — a leader brief, a work-item goal, a leader result —
 * is ever a field value. Sizes, counts, identifiers and shapes only.
 */
import { bind, NOOP_LOGGER, sanitizeErrorMessage, type Logger } from "@clarvis/capability";
import type { WorkflowCtx } from "./types.ts";

/**
 * The logger a workflow context carries, or a silent one.
 *
 * @param ctx - the tree-wide context.
 * @returns the host's logger, or {@link NOOP_LOGGER} when it wired none.
 * @remarks {@link ExecuteRunDeps.logger} is optional and predates this standard,
 *   so the one permitted `?? NOOP_LOGGER` normalization happens here rather
 *   than at every call site.
 */
export function workflowLogger(ctx: WorkflowCtx): Logger {
  return ctx.deps.logger ?? NOOP_LOGGER;
}

/**
 * Derive engine deps whose logger carries `bindings`.
 *
 * @param deps - the deps a leader run will execute against.
 * @param bindings - correlation fields every record below this point should
 *   carry.
 * @returns `deps` unchanged when it carries no logger, else a shallow clone
 *   whose `logger` is bound.
 * @remarks The identity of `deps` is preserved in the no-logger case on
 *   purpose: `runLeader` hands it to `executeRun` by reference, and a host that
 *   wired no logger should observe exactly the object it supplied.
 *
 *   Typed structurally rather than against `ExecuteRunDeps` so this module adds
 *   no `@clarvis/loop` import: the two seams this package may reach the engine
 *   through are asserted exactly, in
 *   `tests/architecture/dependency-direction.test.ts`.
 */
export function withBoundLogger<T extends { logger?: Logger }>(
  deps: T,
  bindings: Record<string, unknown>,
): T {
  const logger = deps.logger;
  if (logger === undefined) return deps;
  return { ...deps, logger: bind(logger, bindings) };
}

/**
 * Project a thrown value into the fields a fault record carries.
 *
 * @param err - whatever was thrown.
 * @returns the sanitized message as `err`, plus `stack` and `cause` when the
 *   value is an `Error` that has them.
 * @remarks Only an `error`-level record should carry a stack, per
 *   `specs/cross-cutting/observability.md` §3.1. The three fault sites in this package are the
 *   only places a workflow stack exists at all: the trace edge keeps the
 *   message and drops everything above it.
 *
 *   A `cause` that is neither an `Error` nor a string is dropped rather than
 *   coerced: an arbitrary object stringifies to `[object Object]`, which is a
 *   field that costs a record's budget and says nothing.
 */
export function faultFields(err: unknown): Record<string, unknown> {
  const error = err instanceof Error ? err : undefined;
  const cause = describeThrown(error?.cause);
  return {
    err: sanitizeErrorMessage(error === undefined ? describeThrown(err) : error.message),
    ...(error?.stack === undefined ? {} : { stack: error.stack }),
    ...(cause === "" ? {} : { cause: sanitizeErrorMessage(cause) }),
  };
}

/**
 * Render a thrown or attached value as a message, or as nothing.
 *
 * @param value - an `Error`, a string, or anything else.
 * @returns the message, or the empty string when there is nothing safe to say.
 */
function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : "";
}

/**
 * Sum the output tokens a leader's usage reports.
 *
 * @param byAgent - the per-agent usage rows of one leader response.
 * @returns the total output tokens, which is what the tree ledger meters.
 */
export function outputTokensOf(byAgent: readonly { output_tokens: number }[]): number {
  return byAgent.reduce((total, row) => total + row.output_tokens, 0);
}

/** How many identifiers a joined `ids`-style field carries before it is cut. */
const MAX_JOINED_IDS = 32;

/**
 * Join a bounded list of identifiers into one scalar field value.
 *
 * @param ids - authored identifiers, never model prose.
 * @returns a comma-separated string, truncated with an ellipsis past
 *   {@link MAX_JOINED_IDS} entries.
 * @remarks A diagnostic field value is a scalar by convention, so a list
 *   arrives as one comma-joined field a consumer can filter on rather than as a
 *   nested array it would have to destructure. The sink does not enforce this —
 *   it is plain `pino` with no serializers — which is why the convention lives
 *   at the call sites, here among them.
 */
export function joinIds(ids: readonly string[]): string {
  const head = ids.slice(0, MAX_JOINED_IDS).join(",");
  return ids.length > MAX_JOINED_IDS ? `${head},…` : head;
}
