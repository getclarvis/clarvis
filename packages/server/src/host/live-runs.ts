import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { RunHandle } from "@clarvis/protocol";
import { serverError } from "../mcp/errors.ts";
import type { ElicitationController } from "../mcp/elicitation.ts";

/** A run in flight on one MCP session. */
export interface LiveRun {
  readonly executionId: string;
  readonly owner: string;
  readonly handle: RunHandle;
  readonly startedAt: number;
  readonly elicit: ElicitationController;
  /** Settles after the event pump, sink and bounded `RunHandle.closed` observation finish. */
  readonly lifecycleDone: Promise<void>;
  /** Set when something other than the model ended the run. */
  cancelledBy?: "client" | "session_close" | "wall_clock" | "shutdown";
}

/**
 * The runs one MCP session owns.
 *
 * @remarks Session-scoped and in-memory on purpose: a run exists only while its
 * connection is open, so there is no durable registry and no cross-session
 * lookup. Without this table, though, `steer` would be unimplementable — a
 * blocking `run` tool call and the `steer` that targets it are two different
 * requests. A foreign session simply sees `not_found`.
 */
export interface LiveRunTable {
  /** @throws a `conflict` {@link ServerError} when the id is already in flight. */
  add(run: LiveRun): void;
  get(executionId: string): LiveRun | undefined;
  /** @throws a `not_found` {@link ServerError} when no such run is live here. */
  require(executionId: string): LiveRun;
  delete(executionId: string): void;
  values(): LiveRun[];
  readonly size: number;
}

/** Build an empty {@link LiveRunTable}. */
export function createLiveRunTable(): LiveRunTable {
  const runs = new Map<string, LiveRun>();
  return {
    add(run): void {
      if (runs.has(run.executionId)) {
        throw serverError("conflict", `run '${run.executionId}' is already in flight`, {
          execution_id: run.executionId,
        });
      }
      runs.set(run.executionId, run);
    },
    get(executionId): LiveRun | undefined {
      return runs.get(executionId);
    },
    require(executionId): LiveRun {
      const run = runs.get(executionId);
      if (run === undefined) {
        throw serverError("not_found", `no live run '${executionId}' on this session`, {
          execution_id: executionId,
        });
      }
      return run;
    },
    delete(executionId): void {
      runs.delete(executionId);
    },
    values(): LiveRun[] {
      return [...runs.values()];
    },
    get size(): number {
      return runs.size;
    },
  };
}

/** Caps how many runs may be in flight, globally and per owner. */
export interface ConcurrencyGate {
  /**
   * Claim a slot.
   *
   * @param owner - the owner the run is charged to.
   * @param ownerLimit - a caller's own cap, typically its role's `max_runs`. The
   *   effective limit is the lower of this and the server-wide per-owner cap, so
   *   a role can only narrow the operator's setting, never widen it.
   * @returns the release function; call it exactly once when the run settles.
   * @throws a `resource_exhausted` {@link ServerError} when either cap is reached.
   */
  acquire(owner: string, ownerLimit?: number): () => void;
  inFlight(owner: string): number;
  readonly total: number;
}

/** Options for {@link createConcurrencyGate}. */
export interface ConcurrencyGateOptions {
  perOwner: number;
  global: number;
  /** Where a refusal is recorded; nothing else about the gate is logged. */
  logger?: Logger;
}

/**
 * Record one refused admission.
 *
 * @param logger - the diagnostic channel.
 * @param scope - which cap was reached.
 * @param owner - the owner the run would have been charged to.
 * @param inFlight - how many runs that scope already holds.
 * @param limit - the cap that was reached.
 * @remarks A named function rather than an inline call so it carries a coverage
 * counter of its own; a line inside the `throw` path is otherwise counted
 * against the enclosing function whether or not it ran.
 */
function reportRejected(
  logger: Logger,
  scope: "server" | "owner",
  owner: string,
  inFlight: number,
  limit: number,
): void {
  logger.warn(
    {
      event: "run.rejected",
      reason: "concurrency_limit",
      scope,
      in_flight: inFlight,
      limit,
      owner,
    },
    "a run was refused at the concurrency cap; the caller may retry once one in flight finishes",
  );
}

/** Build a {@link ConcurrencyGate}. */
export function createConcurrencyGate(opts: ConcurrencyGateOptions): ConcurrencyGate {
  const byOwner = new Map<string, number>();
  const logger = opts.logger ?? NOOP_LOGGER;
  let total = 0;
  return {
    acquire(owner, ownerLimit): () => void {
      const owned = byOwner.get(owner) ?? 0;
      const limit = ownerLimit === undefined ? opts.perOwner : Math.min(opts.perOwner, ownerLimit);
      if (total >= opts.global) {
        reportRejected(logger, "server", owner, total, opts.global);
        throw serverError("resource_exhausted", "the server is at its concurrent-run limit", {
          reason: "concurrency_limit",
          scope: "server",
          in_flight: total,
          limit: opts.global,
        });
      }
      if (owned >= limit) {
        reportRejected(logger, "owner", owner, owned, limit);
        throw serverError("resource_exhausted", "this owner is at its concurrent-run limit", {
          reason: "concurrency_limit",
          scope: "owner",
          in_flight: owned,
          limit,
        });
      }
      byOwner.set(owner, owned + 1);
      total += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const next = (byOwner.get(owner) ?? 1) - 1;
        if (next <= 0) byOwner.delete(owner);
        else byOwner.set(owner, next);
      };
    },
    inFlight(owner): number {
      return byOwner.get(owner) ?? 0;
    },
    get total(): number {
      return total;
    },
  };
}
