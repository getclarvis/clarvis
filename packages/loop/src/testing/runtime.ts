import type { EnvConfig } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import type { ExecuteRunDeps } from "../runtime/execute-run.ts";

/** Inputs for the engine-owned infrastructure used by real-loop integration tests. */
export interface TestRunInfrastructureOptions {
  env: EnvConfig;
  workspaceRoot: string;
}

/**
 * Build the MCP and trace dependencies required to execute a real loop in a downstream test.
 *
 * @remarks The harness keeps packages that test the engine from depending directly on the
 * execution-service implementations the engine owns. Callers must close `connections` when a test
 * acquires any MCP lease.
 */
export function createTestRunInfrastructure(
  options: TestRunInfrastructureOptions,
): Pick<ExecuteRunDeps, "connections" | "traceStore" | "workspaceRoot"> {
  return {
    connections: createConnectionManager({
      workspace: options.workspaceRoot,
      factory: defaultMCPClientFactory,
      connectTimeoutMs: options.env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: options.env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    }),
    traceStore: createMemoryTraceStore(),
    workspaceRoot: options.workspaceRoot,
  };
}

/** Create an independent in-memory trace store for a real-loop integration test. */
export function createTestTraceStore(): ExecuteRunDeps["traceStore"] {
  return createMemoryTraceStore();
}
