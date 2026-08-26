import { describe, expect, it } from "bun:test";
import { resolveOwnerId } from "../../src/config/owner.ts";

describe("misconfiguration", () => {
  it("reports a token-mode resolution with no authenticated caller as an internal fault", () => {
    expect(() =>
      resolveOwnerId({
        headers: new Headers(),
        mode: "token",
        header: "x-clarvis-owner",
        fixed: "default",
        allowlist: new Set(),
      }),
    ).toThrow(/requires an authenticated caller/);
  });
});
