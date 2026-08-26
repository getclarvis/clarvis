import { describe, expect, test } from "bun:test";

import type { CapabilityExecutablePort, CapabilityExecutableSession } from "@clarvis/capability";
import { createExecutableMemoryProvider } from "../../src/executable-provider.ts";

function portWith(request: CapabilityExecutableSession["request"]): CapabilityExecutablePort {
  return {
    session: () =>
      Promise.resolve({
        providerKind: "fixture",
        writable: false,
        request,
        close: () => Promise.resolve(),
      }),
  };
}

async function providerWith(request: CapabilityExecutableSession["request"]) {
  return createExecutableMemoryProvider({
    declaration: { command: "fixture", args: [], env: {}, timeout_ms: 1_000 },
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    owner: "owner",
    port: portWith(request),
  });
}

describe("executable memory provider failures", () => {
  test("turns malformed and thrown tool responses into tool errors", async () => {
    for (const value of [null, { text: 1, isError: false }]) {
      const provider = await providerWith(() => Promise.resolve(value));
      const result = await provider.readTools[0]!.execute({});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("must return");
    }

    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const provider = await providerWith(() => Promise.reject("offline"));
    expect(await provider.readTools[0]!.execute({})).toEqual({
      text: "memory provider failed: offline",
      isError: true,
    });
  });
});
