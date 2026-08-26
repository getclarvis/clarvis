import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { ConnectionEvent, ConnectionEventSink } from "@clarvis/kernel/bootstrap";

/** Tracks pooled MCP connection health for the readiness probe. */
export interface ConnectionHealth {
  /** The sink handed to `createFileKernel`. */
  readonly sink: ConnectionEventSink;
  /** Server names with at least one live connection in the `unavailable` state. */
  unavailable(): string[];
  /** Whether every required name is currently not unavailable. */
  ready(required: readonly string[]): boolean;
}

/**
 * Fold pooled-connection transitions into a readiness signal.
 *
 * @returns the health tracker; hand `sink` to the kernel at construction.
 * @remarks Connections open lazily, on the first run that references one, so a
 *   name that has never been observed reads as **ready** rather than blocking the
 *   probe forever. A host that wants the check to be a real assertion warms the
 *   required servers at boot, which both populates this and primes the pool.
 *
 *   State is kept per **connection**, not per server name. Several connections to
 *   one `mcp_name` exist at once — every non-`shared` server gets a dedicated one
 *   and pooled ones are keyed per workspace/owner — so keying on the name alone
 *   let one run's failure mark the server down for everyone and an unrelated run's
 *   recovery clear it. A name is unavailable while *any* of its live connections
 *   is: readiness is a property of the container, not of one owner.
 *
 *   `closed` drops the entry, which is why this counts connections rather than
 *   summing transitions. A connection that goes `unavailable` and is then closed
 *   never emits `recovered` — the pool discards a slot whose connection is no
 *   longer connected — so any tally that only ever cancelled `unavailable` against
 *   `recovered` would leave the server permanently down until the process
 *   restarted.
 */
export function createConnectionHealth(logger: Logger = NOOP_LOGGER): ConnectionHealth {
  const live = new Map<string, string>();

  const unavailableNames = (): Set<string> => new Set(live.values());

  const report = (event: ConnectionEvent, verb: "unavailable" | "recovered"): void => {
    logger.warn(
      {
        event: `mcp.connection.${verb}`,
        mcp_name: event.mcp_name,
        connection_id: event.connection_id,
        down_count: live.size,
        ...(event.cause !== undefined ? { cause: event.cause } : {}),
      },
      verb === "unavailable"
        ? "a pooled MCP connection went down; /readyz reports it while any connection to that server is down"
        : "a pooled MCP connection came back; /readyz clears that server once none of its connections is down",
    );
  };

  return {
    sink: (event: ConnectionEvent) => {
      if (event.state === "unavailable") {
        const known = live.has(event.connection_id);
        live.set(event.connection_id, event.mcp_name);
        if (!known) report(event, "unavailable");
        return;
      }
      const wasDown = live.delete(event.connection_id);
      if (wasDown) report(event, "recovered");
    },
    unavailable(): string[] {
      return [...unavailableNames()];
    },
    ready(required): boolean {
      const down = unavailableNames();
      return required.every((name) => !down.has(name));
    },
  };
}
