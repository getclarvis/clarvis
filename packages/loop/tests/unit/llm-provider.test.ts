import { describe, it, expect } from "../bun-test.ts";
import { ProviderError } from "@clarvis/capability";

describe("ProviderError — default construction", () => {
  it("defaults kind to transient and leaves status/retryAfterMs unset", () => {
    const err = new ProviderError("only message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderError");
    expect(err.code).toBe("provider_error");
    expect(err.kind).toBe("transient");
    expect(err.status).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.message).toBe("only message");
  });

  it("retains an explicit kind, status and retryAfterMs", () => {
    const err = new ProviderError("rate limited", {
      kind: "client",
      status: 429,
      retryAfterMs: 1500,
    });
    expect(err.kind).toBe("client");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(1500);
  });
});
