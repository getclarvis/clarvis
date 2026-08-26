import { describe, expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createTestRunInfrastructure, createTestTraceStore } from "../../src/testing/index.ts";

describe("engine testing runtime", () => {
  it("owns fresh trace and MCP infrastructure for downstream real-loop tests", async () => {
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const workspaceRoot = process.cwd();
    const infrastructure = createTestRunInfrastructure({ env, workspaceRoot });
    const secondTraceStore = createTestTraceStore();

    expect(infrastructure.workspaceRoot).toBe(workspaceRoot);
    expect(infrastructure.traceStore).not.toBe(secondTraceStore);
    expect(infrastructure.traceStore.existsForOwner("owner", "missing")).toBe(false);
    expect(secondTraceStore.existsForOwner("owner", "missing")).toBe(false);

    await infrastructure.connections.closeAll();
  });
});
