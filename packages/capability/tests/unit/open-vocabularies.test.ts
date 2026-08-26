import { describe, expect, it } from "../helpers/bun-test.ts";

import {
  BUILTIN_ERROR_CODES,
  BUILTIN_RUN_ENDED_REASONS,
  isBuiltinErrorCode,
  isBuiltinRunEndedReason,
} from "../../src/run.ts";
import {
  BUILTIN_TRACE_EVENT_TYPES,
  isBuiltinTraceEvent,
  type TraceEvent,
} from "../../src/trace.ts";
import { BUILTIN_AGENT_ERROR_CODES, type AgentResult } from "../../src/agent-result.ts";

/**
 * The three vocabularies opened so a capability can terminate, fail and record
 * under names the engine does not declare. Each follows the same shape as
 * `BUILTIN_TRACE_KINDS`: a runtime list, a derived union, and a guard that
 * narrows back to the engine's own half.
 */
describe("BUILTIN_ERROR_CODES", () => {
  it("has no duplicates", () => {
    expect(new Set(BUILTIN_ERROR_CODES).size).toBe(BUILTIN_ERROR_CODES.length);
  });

  it("recognises every code it lists", () => {
    for (const code of BUILTIN_ERROR_CODES) expect(isBuiltinErrorCode(code)).toBe(true);
  });

  it("no longer declares the codes the plans capability owns", () => {
    for (const code of [
      "plan_review_unreviewed",
      "plan_review_revision_limit",
      "pending_tasks_unfinished",
    ]) {
      expect(isBuiltinErrorCode(code)).toBe(false);
    }
  });
});

describe("isBuiltinErrorCode", () => {
  it("rejects a code contributed by a capability", () => {
    expect(isBuiltinErrorCode("audit_budget_exhausted")).toBe(false);
  });

  it("rejects a near-miss rather than matching loosely", () => {
    expect(isBuiltinErrorCode("timeout ")).toBe(false);
    expect(isBuiltinErrorCode("TIMEOUT")).toBe(false);
  });
});

describe("BUILTIN_RUN_ENDED_REASONS", () => {
  it("has no duplicates", () => {
    expect(new Set(BUILTIN_RUN_ENDED_REASONS).size).toBe(BUILTIN_RUN_ENDED_REASONS.length);
  });

  it("recognises every reason it lists", () => {
    for (const reason of BUILTIN_RUN_ENDED_REASONS) {
      expect(isBuiltinRunEndedReason(reason)).toBe(true);
    }
  });
});

describe("isBuiltinRunEndedReason", () => {
  it("rejects a reason contributed by a capability", () => {
    expect(isBuiltinRunEndedReason("review_abandoned")).toBe(false);
  });
});

/**
 * The point of opening `AgentErrorCode`: a capability's finalize gate ends the
 * agent through {@link AgentResult}, so a code it owns has to be assignable
 * there. This asserts the property that the previous `Extract<ErrorCode, …>`
 * definition silently lost the moment `ErrorCode` opened.
 */
describe("AgentErrorCode", () => {
  it("has no duplicates and stays a subset of the engine's error codes", () => {
    expect(new Set(BUILTIN_AGENT_ERROR_CODES).size).toBe(BUILTIN_AGENT_ERROR_CODES.length);
    for (const code of BUILTIN_AGENT_ERROR_CODES) expect(isBuiltinErrorCode(code)).toBe(true);
  });

  it("admits a capability's own code on an AgentResult", () => {
    const result: AgentResult = {
      status: "error",
      partialText: "",
      error: { code: "plan_review_unreviewed", message: "the gate was never presented" },
    };
    expect(result.error?.code).toBe("plan_review_unreviewed");
    expect(isBuiltinErrorCode(result.error!.code)).toBe(false);
  });
});

describe("BUILTIN_TRACE_EVENT_TYPES", () => {
  it("has no duplicates", () => {
    expect(new Set(BUILTIN_TRACE_EVENT_TYPES).size).toBe(BUILTIN_TRACE_EVENT_TYPES.length);
  });

  it("no longer declares the event types the plans capability records", () => {
    const types: readonly string[] = BUILTIN_TRACE_EVENT_TYPES;
    expect(types).not.toContain("plan_review");
    expect(types).not.toContain("task_nudge");
  });
});

describe("isBuiltinTraceEvent", () => {
  it("narrows a built-in event so its payload stays exactly typed", () => {
    const event: TraceEvent = {
      type: "lead_iteration_started",
      iteration: 1,
      started_at: 0,
      occurred_at: 5,
      model: "m",
    };
    expect(isBuiltinTraceEvent(event)).toBe(true);
    if (!isBuiltinTraceEvent(event)) throw new Error("unreachable");
    if (event.type === "lead_iteration_started") expect(event.model).toBe("m");
  });

  it("rejects a contributed event, whose payload rides under `detail`", () => {
    const event: TraceEvent = {
      type: "plan_review",
      occurred_at: 5,
      detail: { outcome: "approved", revision_index: 2 },
    };
    expect(isBuiltinTraceEvent(event)).toBe(false);
  });

  it("recognises every type it lists", () => {
    for (const type of BUILTIN_TRACE_EVENT_TYPES) {
      expect(isBuiltinTraceEvent({ type, occurred_at: 0, detail: undefined })).toBe(true);
    }
  });
});
