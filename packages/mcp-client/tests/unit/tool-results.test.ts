import { describe, expect, it } from "bun:test";
import type { ToolResult } from "@clarvis/capability";
import {
  abortedResult,
  becameUnavailableResult,
  interpretCallResult,
  interruptedResult,
  runtimeErrorResult,
  timeoutResult,
  unavailableResult,
} from "../../src/tool-results.ts";

describe("MCP tool result mapping", () => {
  it("preserves successful SDK results", () => {
    const raw = { content: [{ type: "text", text: "ok" }] };
    expect(interpretCallResult(raw, "search")).toEqual({ ok: true, data: raw });
  });

  // Defence in depth for the MCPClientFactory substitution seam: the real SDK
  // parses a tools/call response against a z.looseObject, so null resolves as a
  // rejection and cannot reach the mapper. A stand-in client can resolve it, and
  // before the guard `(null).isError` threw a TypeError out of the mapper.
  it("degrades a nullish result to an operational error instead of throwing", () => {
    const expected: ToolResult = {
      ok: false,
      error: {
        code: "mcp_runtime_error",
        message: "Tool 'search' returned no result.",
        kind: "operational",
      },
    };
    expect(interpretCallResult(null, "search")).toEqual(expected);
    expect(interpretCallResult(undefined, "search")).toEqual(expected);
  });

  // `outcome: "unknown"` means "may not have executed". A response arrived, so
  // only the payload is in doubt; the field must stay absent.
  it("does not claim a nullish result may not have executed", () => {
    expect(interpretCallResult(null, "search").error?.outcome).toBeUndefined();
  });

  it("extracts the first readable text from an SDK error result", () => {
    expect(
      interpretCallResult(
        { isError: true, content: [null, { image: "ignored" }, { text: "server rejected it" }] },
        "search",
      ),
    ).toEqual({
      ok: false,
      error: { code: "mcp_runtime_error", message: "server rejected it", kind: "operational" },
    });
  });

  it("uses a labeled fallback for an SDK error without readable content", () => {
    expect(interpretCallResult({ isError: true, content: "invalid" }, "search")).toEqual({
      ok: false,
      error: {
        code: "mcp_runtime_error",
        message: "Tool 'search' returned an error.",
        kind: "operational",
      },
    });
    expect(interpretCallResult({ isError: true, content: [null, { text: 42 }] }, "search")).toEqual(
      {
        ok: false,
        error: {
          code: "mcp_runtime_error",
          message: "Tool 'search' returned an error.",
          kind: "operational",
        },
      },
    );
  });

  it("formats aborted, unavailable, and timeout results", () => {
    expect(abortedResult("search")).toEqual({
      ok: false,
      error: {
        code: "mcp_runtime_error",
        message: "Tool 'search' call aborted (run cancelled).",
        kind: "cancelled",
      },
    });
    expect(abortedResult("search", true).error?.outcome).toBe("unknown");
    expect(unavailableResult("docs")).toEqual({
      ok: false,
      error: {
        code: "mcp_unavailable",
        message: "MCP 'docs' is unavailable.",
        kind: "unavailable",
      },
    });
    expect(timeoutResult("search", 250)).toEqual({
      ok: false,
      error: {
        code: "mcp_timeout",
        message: "Tool 'search' timed out after 250ms (still connected).",
        kind: "timeout",
        outcome: "unknown",
      },
    });
  });

  it("formats runtime, interrupted, and newly unavailable failures", () => {
    expect(runtimeErrorResult("search", new Error("bad params"))).toEqual({
      ok: false,
      error: {
        code: "mcp_runtime_error",
        message: "Tool 'search' failed: bad params",
        kind: "operational",
      },
    });
    expect(interruptedResult("search", "socket closed").error).toEqual({
      code: "mcp_runtime_error",
      message:
        "Tool 'search' failed in transit: socket closed. The connection was restored, but the call may or may not have executed on the server — retry only if running it twice is safe.",
      kind: "operational",
      outcome: "unknown",
    });
    expect(becameUnavailableResult("docs", new Error("offline"))).toEqual({
      ok: false,
      error: {
        code: "mcp_unavailable",
        message: "MCP 'docs' became unavailable: offline",
        kind: "unavailable",
        outcome: "unknown",
      },
    });
  });
});
