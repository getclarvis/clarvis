import { describe, expect, test } from "bun:test";

import {
  CapabilityExecutableRpcError,
  capabilityExecutableDeclarationSchema,
  capabilityExecutablesSchema,
  resolveCapabilityExecutable,
} from "../../src/capability-executables.ts";
import { capabilityRunPoliciesSchema } from "../../src/capability-run-policies.ts";

describe("capability executable declarations", () => {
  test("applies stable defaults", () => {
    expect(capabilityExecutableDeclarationSchema.parse({ command: "python3" })).toEqual({
      command: "python3",
      args: [],
      env: {},
      timeout_ms: 30_000,
    });
  });

  test("platform argv replaces the base argv while environment merges", () => {
    const declaration = capabilityExecutableDeclarationSchema.parse({
      command: "python3",
      args: ["-B", "server.py", "memory"],
      env: { BASE: "${HOST_VALUE}", SHARED: "base" },
      platforms: {
        win32: {
          command: "py",
          args: ["-3", "-B", "server.py", "memory"],
          env: { SHARED: "windows", EXTRA: "${OTHER}" },
        },
      },
      timeout_ms: 12_345,
    });
    expect(
      resolveCapabilityExecutable(declaration, "win32", {
        HOST_VALUE: "host",
        OTHER: "other",
      }),
    ).toEqual({
      command: "py",
      args: ["-3", "-B", "server.py", "memory"],
      env: { BASE: "host", SHARED: "windows", EXTRA: "other" },
      timeout_ms: 12_345,
      platform: "win32",
    });
  });

  test("rejects shell strings and unknown declaration keys as data-shape errors", () => {
    expect(() =>
      capabilityExecutableDeclarationSchema.parse({ command: "", shell: true }),
    ).toThrow();
    expect(() => capabilityExecutablesSchema.parse({ memory: { args: [] } })).toThrow();
  });

  test("fails closed when an environment interpolation is unresolved", () => {
    const declaration = capabilityExecutableDeclarationSchema.parse({
      command: "provider",
      env: { TOKEN: "Bearer ${MISSING_TOKEN}" },
    });
    expect(() => resolveCapabilityExecutable(declaration, "linux", {})).toThrow("MISSING_TOKEN");
  });

  test("exposes JSON-RPC and domain error codes without trusting malformed data", () => {
    const domain = new CapabilityExecutableRpcError("conflict", -32_000, {
      code: "plan_conflict",
    });
    expect(domain).toBeInstanceOf(Error);
    expect(domain.name).toBe("CapabilityExecutableRpcError");
    expect(domain.rpcCode).toBe(-32_000);
    expect(domain.domainCode).toBe("plan_conflict");
    expect(new CapabilityExecutableRpcError("missing", -32_000).domainCode).toBeUndefined();
    expect(
      new CapabilityExecutableRpcError("bad", -32_000, { code: 7 }).domainCode,
    ).toBeUndefined();
  });
});

describe("capability run policies", () => {
  test("accepts only explicit per-skill Plans modes", () => {
    expect(
      capabilityRunPoliciesSchema.parse({
        plans: { skills: { "speckit-plan": "off", "speckit-implement": "review" } },
      }),
    ).toEqual({
      plans: { skills: { "speckit-plan": "off", "speckit-implement": "review" } },
    });
    expect(() =>
      capabilityRunPoliciesSchema.parse({ plans: { skills: { unsafe: "disabled" } } }),
    ).toThrow();
    expect(() => capabilityRunPoliciesSchema.parse({ plans: { default: "off" } })).toThrow();
  });
});
