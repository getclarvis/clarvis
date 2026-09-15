import { describe, it, expect } from "../bun-test.ts";
import {
  createRunTraceProjectors,
  deriveRunEndedDetail,
  traceBridge,
} from "../../src/runtime/run-trace.ts";
import type { RunResponse, Usage } from "@clarvis/capability";
import type { TraceEntry } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { mapTrace } from "@clarvis/trace";

const usage: Usage = { iterations_used: 1, elapsed_ms: 1, by_agent: [] };
const clean = (status: "completed" | "budget_exhausted" | "cancelled" | "soft_limit_declined") =>
  ({ status, result: "x", usage }) as RunResponse;
const err = (code: string): RunResponse =>
  ({ status: "error", error: { code: code as never, message: "m" }, usage }) as RunResponse;

describe("deriveRunEndedDetail", () => {
  it("records accepted checkpoint disposition without relabeling an unsuccessful run", () => {
    const checkpoint = { summary: "Stage saved", next_step: "Continue" };
    expect(
      deriveRunEndedDetail({
        status: "completed",
        result: undefined,
        disposition: "checkpoint",
        checkpoint,
        usage,
      }),
    ).toEqual({ reason: "completed", disposition: "checkpoint" });
    expect(
      deriveRunEndedDetail({ status: "completed", result: "Done", usage, disposition: "final" }),
    ).toEqual({
      reason: "completed",
      disposition: "final",
    });
    for (const status of ["cancelled", "budget_exhausted", "soft_limit_declined"] as const) {
      expect(
        deriveRunEndedDetail({ ...clean(status), disposition: "checkpoint", checkpoint }),
      ).toEqual({ reason: status });
    }
    expect(
      deriveRunEndedDetail({ ...err("provider_error"), disposition: "checkpoint", checkpoint }),
    ).toEqual({ reason: "error", code: "provider_error" });
  });

  it("maps the clean terminal statuses 1:1 with no code", () => {
    for (const status of [
      "completed",
      "budget_exhausted",
      "cancelled",
      "soft_limit_declined",
    ] as const) {
      expect(deriveRunEndedDetail(clean(status))).toEqual({ reason: status });
    }
  });

  it("lifts a timeout out of the generic error reason", () => {
    expect(deriveRunEndedDetail(err("timeout"))).toEqual({ reason: "timeout", code: "timeout" });
  });

  it("maps convergence/integrity guard codes to guard_trip, carrying the code", () => {
    const guards = [
      "no_progress",
      "tool_failure_loop",
      "stagnation_detected",
      "all_tools_unavailable",
      "empty_response",
    ] as const;
    for (const code of guards) {
      expect(deriveRunEndedDetail(err(code))).toEqual({ reason: "guard_trip", code });
    }
  });

  it("maps a capability-contributed guard code to guard_trip only when the capability supplies it, carrying the code", () => {
    // A feature capability may declare its own guard-trip codes on its
    // AgentLoopContribution (`guardTripCodes`, in @clarvis/capability's
    // contract.ts), which are not baked into the engine's own GUARD_TRIP_CODES
    // set. The orchestrator collects them from every active capability and
    // passes them in; a run with no such capability active sees the same code
    // as a plain error.
    const featureGuards = [
      "review_unresolved",
      "revision_limit_reached",
      "open_items_unfinished",
    ] as const;
    const capabilityGuardTripCodes = new Set<string>(featureGuards);
    for (const code of featureGuards) {
      expect(deriveRunEndedDetail(err(code), capabilityGuardTripCodes)).toEqual({
        reason: "guard_trip",
        code,
      });
      expect(deriveRunEndedDetail(err(code))).toEqual({ reason: "error", code });
    }
  });

  it("keeps provider/transport/internal failures as a generic error, carrying the code", () => {
    for (const code of [
      "provider_error",
      "mcp_connection_failed",
      "internal_error",
      "mcp_unavailable",
    ] as const) {
      expect(deriveRunEndedDetail(err(code))).toEqual({ reason: "error", code });
    }
  });
});

describe("traceBridge — a throwing consumer never reaches the run", () => {
  const entry = (): TraceEntry => ({
    at: 0,
    kind: "compaction",
    detail: { agent: "lead", operation: "eviction", evicted_count: 1, freed_chars: 10 },
  });

  /**
   * `ingest` is the agents registry's tap. It runs before the `emitEvent` guard
   * so a run with no host consumer still feeds the registry — which means a
   * throw here would otherwise escape into the tracer and take down the very
   * dispatch it was only observing.
   */
  it("contains a throwing ingest, logs it, and still emits the event", () => {
    const warned: unknown[][] = [];
    const emitted: TraceEvent[] = [];
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 0,
      ingest: () => {
        throw new Error("registry exploded");
      },
      emitEvent: (e) => emitted.push(e),
      logger: { warn: (...a: unknown[]) => warned.push(a) } as unknown as Logger,
    });

    expect(() => sink(entry(), true)).not.toThrow();
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain("registry exploded");
    expect(emitted).toHaveLength(1);
  });

  it("contains a throwing emitEvent the same way", () => {
    const warned: unknown[][] = [];
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 0,
      emitEvent: () => {
        throw new Error("consumer exploded");
      },
      logger: { warn: (...a: unknown[]) => warned.push(a) } as unknown as Logger,
    });

    expect(() => sink(entry(), true)).not.toThrow();
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain("consumer exploded");
  });

  it("swallows a throwing ingest silently when no logger is wired", () => {
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 0,
      ingest: () => {
        throw new Error("quiet");
      },
    });
    expect(() => sink(entry(), true)).not.toThrow();
  });
});

describe("traceBridge — the journal takes durable entries only", () => {
  const entry = (): TraceEntry => ({
    at: 0,
    kind: "compaction",
    detail: { agent: "lead", operation: "eviction", evicted_count: 1, freed_chars: 10 },
  });

  it("journals a durable entry and skips a live-only one", () => {
    const journalled: TraceEvent[] = [];
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 0,
      journal: (e) => journalled.push(e),
    });

    sink(entry(), true);
    sink(entry(), false);

    expect(journalled).toHaveLength(1);
  });

  /**
   * The guard used to test `emitEvent` alone, so a run with no host listener
   * returned before `mapEntry` ran. A journal hung off that path would have been
   * dead in exactly the runs nobody is watching — which are the ones a crash
   * record is for.
   */
  it("still journals when no emitEvent consumer is wired", () => {
    const journalled: TraceEvent[] = [];
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 0,
      journal: (e) => journalled.push(e),
    });

    sink(entry(), true);
    expect(journalled).toHaveLength(1);
  });

  it("maps once and hands the same event to both sinks", () => {
    const journalled: TraceEvent[] = [];
    const emitted: TraceEvent[] = [];
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 0,
      journal: (e) => journalled.push(e),
      emitEvent: (e) => emitted.push(e),
    });

    sink(entry(), true);
    expect(journalled).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(journalled[0]).toBe(emitted[0]);
  });

  it("pokes the clock for a live-only entry even with nothing else wired", () => {
    let pokes = 0;
    const sink = traceBridge({
      clockHolder: { clock: { poke: () => (pokes += 1) } as never },
      wallStartedAt: 0,
    });

    sink(entry(), false);
    expect(pokes).toBe(1);
  });
});

describe("run-scoped persisted projector composition", () => {
  it("traceBridge uses the same capability projector registry as mapTrace", () => {
    const emitted: TraceEvent[] = [];
    const projectors = createRunTraceProjectors([
      {
        name: "sample",
        forRun: () => null,
        persistedTraceProjectors: [
          {
            kind: "sample_edge",
            project: (entry, context) => ({
              type: "sample_edge",
              occurred_at: context.absoluteTime(entry.at),
              detail: entry.detail,
            }),
          },
        ],
      },
    ]);
    const sink = traceBridge({
      clockHolder: {},
      wallStartedAt: 100,
      projectors,
      emitEvent: (event) => emitted.push(event),
    });
    sink(
      {
        at: 4,
        kind: "sample_edge",
        detail: { value: 1 },
      },
      true,
    );
    expect(emitted).toEqual([
      {
        type: "sample_edge",
        occurred_at: 104,
        detail: { value: 1 },
      },
    ]);
    expect(
      mapTrace([{ at: 4, kind: "sample_edge", detail: { value: 1 } }], 100, projectors),
    ).toEqual({ events: emitted });
  });
});
