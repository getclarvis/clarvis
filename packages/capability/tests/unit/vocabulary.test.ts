import { describe, expect, it } from "../helpers/bun-test.ts";

import { EXECUTION_STATUSES } from "../../src/execution-status.ts";
import { ProviderError } from "../../src/llm-port.ts";

describe("EXECUTION_STATUSES", () => {
  it("lists every terminal status exactly once", () => {
    expect([...EXECUTION_STATUSES]).toEqual([
      "completed",
      "budget_exhausted",
      "error",
      "cancelled",
      "soft_limit_declined",
      "interrupted",
    ]);
    expect(new Set(EXECUTION_STATUSES).size).toBe(EXECUTION_STATUSES.length);
  });
});

describe("ProviderError", () => {
  it("carries its classification and stays an Error", () => {
    const err = new ProviderError("slow down", {
      kind: "quota",
      status: 429,
      retryAfterMs: 1500,
      streamStarted: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderError");
    expect(err.code).toBe("provider_error");
    expect(err.kind).toBe("quota");
    expect(err.message).toBe("slow down");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(1500);
    expect(err.streamStarted).toBe(true);
  });

  it("classifies an unqualified failure as transient, since that is the retried kind", () => {
    const err = new ProviderError("nope");
    expect(err.kind).toBe("transient");
    expect(err.status).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.partialUsage).toBeUndefined();
    expect(err.streamStarted).toBe(false);
  });
});
