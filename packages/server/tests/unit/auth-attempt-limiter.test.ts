import { describe, expect, it } from "bun:test";
import { createAttemptLimiter } from "../../src/auth/issuer.ts";

describe("the attempt limiter", () => {
  it("evicts the oldest key once the table is full, rather than growing without bound", () => {
    const limiter = createAttemptLimiter({ max: 1, windowMs: 60_000, maxKeys: 4 });

    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);

    for (const key of ["b", "c", "d", "e", "f"]) expect(limiter.take(key)).toBe(true);

    expect(limiter.take("a")).toBe(true);
  });

  it("reports remaining budget without spending it", () => {
    const limiter = createAttemptLimiter({ max: 1, windowMs: 60_000 });
    expect(limiter.peek("k")).toBe(true);
    expect(limiter.peek("k")).toBe(true);
    expect(limiter.take("k")).toBe(true);
    expect(limiter.peek("k")).toBe(false);
  });
});
