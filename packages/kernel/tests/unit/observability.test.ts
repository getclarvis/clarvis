import { describe, expect, it } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import { MEMORY_INGEST_EVENT } from "@clarvis/memory/settings";
import type { CapabilityEvent, TraceEvent } from "@clarvis/capability";
import { capabilityEventToProto, engineEventToProto } from "../../src/runs/map-events.ts";
import { storedToDetail } from "../../src/runs/map-result.ts";
import { createKernelLifecycle } from "../../src/application/lifecycle.ts";
import { observationSink } from "../../src/core/observed.ts";
import { recordingLogger } from "../helpers/logger.ts";

describe("runs.event.unmapped", () => {
  const unknownTrace = { type: "totally_unknown", occurred_at: 1 } as unknown as TraceEvent;

  it("reports an engine event with no builtin projection", () => {
    const logger = recordingLogger();
    expect(engineEventToProto(unknownTrace, logger)).toBeNull();
    expect(logger.events("runs.event.unmapped")[0]).toMatchObject({
      path: "engine",
      kind: "totally_unknown",
      reason: "not_builtin",
    });
  });

  it("reports a builtin the kernel deliberately keeps internal", () => {
    const logger = recordingLogger();
    const event = {
      type: "guard_escalation",
      occurred_at: 1,
      tool: "shell",
      outcome: "approved",
    } as unknown as TraceEvent;
    expect(engineEventToProto(event, logger)).toBeNull();
    expect(logger.events("runs.event.unmapped")[0]).toMatchObject({
      path: "engine",
      kind: "guard_escalation",
      reason: "deliberately_internal",
    });
  });

  it("reports a capability event carrying no wire projection", () => {
    const logger = recordingLogger();
    const event: CapabilityEvent = { capability: "plans", kind: "plan_created" };
    expect(capabilityEventToProto(event, logger)).toBeNull();
    expect(logger.events("runs.event.unmapped")[0]).toMatchObject({
      path: "capability",
      capability: "plans",
      kind: "plan_created",
      reason: "no_wire_projection",
    });
  });

  it("reports a memory event that is not an ingest notice", () => {
    const logger = recordingLogger();
    const event: CapabilityEvent = { capability: "memory", kind: "something_else" };
    expect(capabilityEventToProto(event, logger)).toBeNull();
    expect(logger.events("runs.event.unmapped")[0]).toMatchObject({ reason: "not_ingest" });
  });

  it("reports an ingest notice whose payload does not match the wire union", () => {
    const logger = recordingLogger();
    const event: CapabilityEvent = {
      capability: "memory",
      kind: MEMORY_INGEST_EVENT,
      detail: { phase: "not-a-phase" },
    };
    expect(capabilityEventToProto(event, logger)).toBeNull();
    expect(logger.events("runs.event.unmapped")[0]).toMatchObject({ reason: "schema" });
  });

  it("costs nothing when the logger discards debug", () => {
    expect(engineEventToProto(unknownTrace, NOOP_LOGGER)).toBeNull();
    expect(engineEventToProto(unknownTrace)).toBeNull();
  });

  it("samples a repeating kind rather than one line per event", () => {
    const logger = recordingLogger();
    for (let i = 0; i < 40; i++) engineEventToProto(unknownTrace, logger);
    const count = logger.events("runs.event.unmapped").length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(40);
  });
});

describe("runs.rehydrated", () => {
  it("counts what a restored run kept and what it lost", () => {
    const logger = recordingLogger();
    const stored = {
      id: "run-9",
      owner: "o",
      status: "completed",
      started_at: 1,
      ended_at: 2,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      request: { messages: [] },
      response: {
        status: "completed",
        usage: {
          iterations_used: 1,
          elapsed_ms: 1,
          by_agent: [],
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
        },
      },
      trace: {
        events: [
          { type: "run_started", occurred_at: 1 },
          {
            type: "tool_input_delta",
            agent: "lead",
            occurred_at: 2,
            call_id: "call-1",
            tool_name: "write_file",
            chars: 0,
          },
          { type: "totally_unknown", occurred_at: 2 },
        ],
      },
    } as unknown as Parameters<typeof storedToDetail>[0];
    const detail = storedToDetail(stored, logger);
    expect(detail.events).toHaveLength(1);
    expect(logger.events("runs.rehydrated")[0]).toMatchObject({
      execution_id: "run-9",
      events_total: 3,
      events_mapped: 1,
      events_dropped: 2,
    });
  });
});

describe("observationSink", () => {
  it("stamps an event name on a detached failure and reaches the logger", async () => {
    const logger = recordingLogger();
    const lifecycle = createKernelLifecycle(logger);
    await lifecycle.close();
    lifecycle.register({
      close: () => {
        throw new Error("resource did not close");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(logger.events("lifecycle.late_close_failed")[0]).toMatchObject({
      operation: "kernel_late_resource_close",
      cause: "resource did not close",
    });
  });

  it("carries the caller's fields through unchanged", () => {
    const logger = recordingLogger();
    observationSink(logger, "x.y.failed").warn({ operation: "op", cause: "why" }, "ignored");
    expect(logger.events("x.y.failed")[0]).toMatchObject({ operation: "op", cause: "why" });
  });
});
