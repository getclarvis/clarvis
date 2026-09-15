import { describe, it, expect } from "../bun-test.ts";
import {
  loopResultToResponse,
  mapErrorToResponse,
} from "../../src/runtime/run-response-mapping.ts";
import { CodedError, ProviderError } from "@clarvis/capability";
import type { Usage } from "@clarvis/capability";

const usage: Usage = { iterations_used: 1, elapsed_ms: 5, by_agent: [] };

describe("checkpoint response mapping", () => {
  it.each(["completed", "error", "cancelled", "budget_exhausted", "soft_limit_declined"] as const)(
    "preserves %s independently of the stage disposition",
    (status) => {
      const checkpoint = { summary: "stage summary", next_step: "verify" };
      const response = loopResultToResponse(
        {
          status,
          disposition: "checkpoint",
          checkpoint,
          partialText: "partial",
          structuredResult: { value: { invalid_final: true } },
        },
        usage,
        () => "stopped",
      );
      expect(response).toMatchObject({ status, disposition: "checkpoint", checkpoint, usage });
      if (response.status === "completed") expect(response.result).toBeUndefined();
      if (response.status === "error") expect(response.error.code).toBe("empty_response");
    },
  );
});

describe("mapErrorToResponse — provider failure codes", () => {
  it("gives quota and content policy their own error codes", () => {
    const quota = mapErrorToResponse(
      new ProviderError("out of credit", { kind: "quota", status: 429 }),
      usage,
    );
    const policy = mapErrorToResponse(
      new ProviderError("refused", { kind: "content_policy", status: 400 }),
      usage,
    );

    expect(quota.status).toBe("error");
    expect(policy.status).toBe("error");
    if (quota.status !== "error" || policy.status !== "error") return;
    expect(quota.error.code).toBe("provider_quota_exhausted");
    expect(policy.error.code).toBe("provider_content_policy");
  });

  it("keeps context_overflow and the generic provider_error unchanged", () => {
    const overflow = mapErrorToResponse(
      new ProviderError("too long", { kind: "context_overflow" }),
      usage,
    );
    const generic = mapErrorToResponse(new ProviderError("nope", { kind: "client" }), usage);

    if (overflow.status !== "error" || generic.status !== "error")
      throw new Error("expected error");
    expect(overflow.error.code).toBe("context_overflow");
    expect(generic.error.code).toBe("provider_error");
  });

  it("still carries the kind and status in details, whatever the code", () => {
    const res = mapErrorToResponse(
      new ProviderError("out of credit", { kind: "quota", status: 429, retryAfterMs: 1500 }),
      usage,
    );
    if (res.status !== "error") throw new Error("expected error");
    expect(res.error.details).toEqual({ kind: "quota", status: 429, retry_after_ms: 1500 });
  });

  it("reports a cancelled run as cancelled regardless of the error", () => {
    const controller = new AbortController();
    controller.abort();
    const res = mapErrorToResponse(
      new ProviderError("out of credit", { kind: "quota" }),
      usage,
      controller.signal,
    );
    expect(res.status).toBe("cancelled");
  });
});

describe("mapErrorToResponse — open capability errors", () => {
  it("preserves the code and structurally sanitizes nested details", () => {
    class FixtureError extends CodedError {
      readonly code = "fixture_unavailable";
    }
    const details = {
      plugin: "fixture",
      nested: [{ authorization: "Bearer secret-value", count: 2 }],
    };
    const result = mapErrorToResponse(
      new FixtureError("failed with token='secret-value'", details),
      usage,
    );
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error.code).toBe("fixture_unavailable");
    expect(result.error.message).not.toContain("secret-value");
    expect(result.error.details).toEqual({
      plugin: "fixture",
      nested: [{ authorization: "Bearer [redacted]", count: 2 }],
    });
    expect(details.nested[0]!.authorization).toBe("Bearer secret-value");
  });
});
