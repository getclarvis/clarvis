import { describe, it, expect } from "bun:test";
import { ContinuationUnavailableError } from "@clarvis/loop";
import { KernelException, toKernelError } from "../../src/core/errors.ts";

describe("toKernelError", () => {
  it("honors ContinuationUnavailableError's own code so recovery survives the hop", () => {
    const mapped = toKernelError(new ContinuationUnavailableError("exec-1"));
    expect(mapped).toBeInstanceOf(KernelException);
    expect(mapped.code).toBe("continuation_unavailable");
  });

  it("maps validation and conflict error names, defaulting to internal", () => {
    const validation = Object.assign(new Error("bad"), { name: "ValidationError" });
    const conflict = Object.assign(new Error("clash"), { name: "ConflictError" });
    expect(toKernelError(validation).code).toBe("invalid_request");
    expect(toKernelError(conflict).code).toBe("conflict");
    expect(toKernelError(new Error("boom")).code).toBe("internal");
  });

  it("passes an existing KernelException through unchanged", () => {
    const original = new KernelException("not_found", "gone");
    expect(toKernelError(original)).toBe(original);
  });
});
