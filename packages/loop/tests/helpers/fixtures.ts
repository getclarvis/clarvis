export {
  MockLLM,
  mockMCPFactory,
  type MockLLMOptions,
  type MockLLMScriptStep,
  type MockMCPOptions,
  type MockMCPResource,
  type MockMCPTool,
} from "../../src/testing/index.ts";

import type { MCPClientFactory } from "@clarvis/mcp-client";
import { createConnectionManager, type ConnectionManager } from "@clarvis/mcp-client";
import { loadEnv, type EnvConfig } from "@clarvis/capability";
import type { LLMProvider, LLMCallParams, LLMCallResult } from "@clarvis/capability";

export function mockConnections(
  factory: MCPClientFactory,
  env?: EnvConfig,
  workspace = process.cwd(),
): ConnectionManager {
  const e = env ?? loadEnv({});
  return createConnectionManager({
    workspace,
    factory,
    connectTimeoutMs: e.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: e.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    idleTtlMs: e.CLARVIS_MCP_POOL_IDLE_TTL_MS,
  });
}

/**
 * A Lead+Subagent LLM double for integration concurrency tests. The Lead's
 * first turn emits `spawnCount` spawn_subagent calls; each Subagent turn delays
 * while tracking the peak number of Subagent calls in flight, then the Lead
 * synthesizes.
 */
export function makeConcurrencyLLM(
  spawnCount: number,
  subagentDelayMs: number,
): LLMProvider & { peak: number } {
  const state = { peak: 0, active: 0 };
  let leadCalls = 0;
  return {
    get peak() {
      return state.peak;
    },
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      if (params.model === "claude-haiku-4-5") {
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        await new Promise((resolve) => setTimeout(resolve, subagentDelayMs));
        state.active -= 1;
        return {
          text: "subagent ok",
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
        };
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return {
          toolCalls: Array.from({ length: spawnCount }, (_, i) => ({
            id: `s${i}`,
            name: "spawn_subagent",
            arguments: { title: "w", task: `sub-task ${i}` },
          })),
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
        };
      }
      return {
        text: "final synthesis",
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
      };
    },
  };
}
