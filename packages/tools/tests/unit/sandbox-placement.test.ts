import { describe, expect, it } from "bun:test";
import { sandboxCommand, sandboxWouldApply, type SandboxConfig } from "../../src/sandbox-entry.ts";

const base = {
  command: "true",
  cwd: "/ws",
  workspaceRoot: "/ws",
  shell: () => ({ file: "sh", flavor: "posix" as const }),
};

describe("sandboxWouldApply", () => {
  it.each([undefined, "required", "optional"] as const)(
    "commits to containment or failure for availability %s",
    (availability) => {
      const sandbox: SandboxConfig = { type: "native", availability };
      expect(sandboxWouldApply(sandbox)).toBe(true);
      expect(() =>
        sandboxCommand({
          ...base,
          sandbox,
          probe: () => ({
            backend: "unsupported",
            mode: "unavailable",
            reason: "test unavailable",
          }),
        }),
      ).toThrow("Native sandbox is required: test unavailable");
      expect(
        sandboxCommand({
          ...base,
          sandbox,
          probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
        }).sandboxed,
      ).toBe(true);
    },
  );

  it("never calls a disabled or explicitly bare policy contained and never probes it", () => {
    const disabled = { type: "native" as const, enabled: false };
    const sandbox = { type: "native" as const };
    const probe = (): never => {
      throw new Error("must not probe");
    };
    expect(sandboxWouldApply(undefined)).toBe(false);
    expect(sandboxWouldApply(disabled)).toBe(false);
    expect(sandboxWouldApply(sandbox, true)).toBe(false);
    for (const policy of [
      { sandbox: undefined },
      { sandbox: disabled },
      { sandbox, forceBare: true },
    ]) {
      expect(sandboxCommand({ ...base, ...policy, probe }).sandboxed).toBe(false);
    }
  });
});
