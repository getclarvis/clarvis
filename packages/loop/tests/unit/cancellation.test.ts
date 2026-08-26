import { describe, it, expect } from "../bun-test.ts";
import {
  cancellationReason,
  recordCancellation,
  checkCancelled,
} from "../../src/runtime/loop/index.ts";
import { createTrace } from "@clarvis/trace";

describe("cancellationReason", () => {
  it("reads {source} or a string reason, else a default; undefined when not aborted", () => {
    expect(cancellationReason(undefined)).toBeUndefined();
    const live = new AbortController();
    expect(cancellationReason(live.signal)).toBeUndefined();

    const a = new AbortController();
    a.abort({ source: "mcp" });
    expect(cancellationReason(a.signal)).toBe("mcp");

    const b = new AbortController();
    b.abort("manual");
    expect(cancellationReason(b.signal)).toBe("manual");

    const d = new AbortController();
    d.abort();
    expect(cancellationReason(d.signal)).toBe("cancelled");
  });
});

describe("cancellation helpers", () => {
  it("falls back to 'cancelled' when the reason source is not a string", () => {
    const c = new AbortController();
    c.abort({ source: 7 });
    expect(cancellationReason(c.signal)).toBe("cancelled");
  });

  it("records a cancellation with no reason field when the signal is not aborted", () => {
    const trace = createTrace();
    const c = new AbortController();
    recordCancellation({ trace, agent: "subagent", signal: c.signal });
    const entry = trace.entries().find((e) => e.kind === "cancellation");
    expect(entry).toBeDefined();
    expect((entry!.detail as { reason?: string }).reason).toBeUndefined();
  });

  it("records the reason when the signal is aborted with a string", () => {
    const trace = createTrace();
    const c = new AbortController();
    c.abort("manual-stop");
    const hit = checkCancelled({
      signal: c.signal,
      trace,
      agent: "subagent",
      subagentInstanceId: "w1",
    });
    expect(hit).toBe(true);
    const entry = trace.entries().find((e) => e.kind === "cancellation");
    expect((entry!.detail as { reason?: string }).reason).toBe("manual-stop");
  });
});
