import { loadEnv, ValidationError } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";
import type { StoredExecution, StoredSummary } from "@clarvis/trace";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import type { PluginBootstrapSkill } from "../../src/runtime/capabilities/skills-settings.ts";
import type { Capability, ProviderConfig, RunResponse } from "@clarvis/capability";
import type { LLMProvider } from "@clarvis/capability";
import type { MCPClientFactory } from "@clarvis/mcp-client";
import { createConnectionManager } from "@clarvis/mcp-client";
import type { Logger } from "@clarvis/capability";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";
import type { SkillsProvider } from "@clarvis/skills/capability";
import type { Guard, Elicit as GuardElicit } from "../../src/runtime/tools/builtin/index.ts";
import type { LifecycleHook, SteerSource } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import type { ExecutionStatus, RunRequest, Trace } from "@clarvis/capability";

interface ExecutionDetail {
  execution_id: string;
  status: ExecutionStatus;
  started_at: string;
  ended_at: string;
  elapsed_ms: number;
  owner_key_name: string;
  request: RunRequest;
  response: RunResponse;
  trace: Trace;
}

interface ExecutionSummary {
  execution_id: string;
  status: ExecutionStatus;
  started_at: string;
  elapsed_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_cache_write_tokens: number;
}

interface ExecutionList {
  items: ExecutionSummary[];
  limit: number;
  offset: number;
  total: number;
}

type RunEnvelope = RunResponse & { execution_id: string };

export const TEST_PROVIDERS: ProviderConfig[] = [
  { name: "anthropic", kind: "anthropic" },
  { name: "openai", kind: "openai" },
  { name: "google", kind: "google" },
  { name: "openai-compatible", kind: "openai-compatible", base_url: "http://localhost:1/v1" },
];

function withProviders(providers: ProviderConfig[], body: unknown): unknown {
  return body && typeof body === "object"
    ? { providers, ...(body as Record<string, unknown>) }
    : body;
}

function withTestProviders(body: unknown): unknown {
  return withProviders(TEST_PROVIDERS, body);
}

export interface TestHarness {
  owner: string;
  traceStore: TraceStore;
  run(body: unknown, opts?: { owner?: string }): Promise<RunEnvelope>;
  getRun(id: string, opts?: { owner?: string }): Promise<ExecutionDetail | null>;
  listRuns(
    query?: { limit?: number; offset?: number },
    opts?: { owner?: string },
  ): Promise<ExecutionList>;
  deleteRun(id: string, opts?: { owner?: string }): Promise<boolean>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  llm: LLMProvider;
  mcpFactory: MCPClientFactory;
  mcpLimits?: { maxConnections?: number; maxParallelConnects?: number };
  env?: Partial<Record<string, string>>;
  workspaceRoot?: string;
  owner?: string;
  logger?: Logger;
  traceStore?: TraceStore;
  elicit?: Elicit;
  steer?: SteerSource;
  agentTools?: true | { guard?: Guard; guardElicit?: GuardElicit };
  askUser?: true;
  skills?: {
    provider?: SkillsProvider;
    bootstraps?: () => readonly PluginBootstrapSkill[];
  };
  hooks?: LifecycleHook[];
  capabilities?: readonly Capability[];
  onEvent?: (event: TraceEvent) => void;
}

export { makeExecutionRecord } from "../helpers/execution-record.ts";

function toDetail(row: StoredExecution): ExecutionDetail {
  return {
    execution_id: row.id,
    status: row.status,
    started_at: new Date(row.started_at).toISOString(),
    ended_at: new Date(row.ended_at).toISOString(),
    elapsed_ms: row.elapsed_ms,
    owner_key_name: row.owner_key_name,
    request: row.request,
    response: row.response,
    trace: row.trace,
  };
}

function toSummary(row: StoredSummary): ExecutionSummary {
  return {
    execution_id: row.id,
    status: row.status,
    started_at: new Date(row.started_at).toISOString(),
    elapsed_ms: row.elapsed_ms,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    total_cached_tokens: row.total_cached_tokens,
    total_cache_write_tokens: row.total_cache_write_tokens,
  };
}

export async function makeHarness(opts: HarnessOptions): Promise<TestHarness> {
  const defaultOwner = opts.owner ?? "test";
  const env = loadEnv({
    CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000",
    ...opts.env,
  });
  const traceStore = opts.traceStore ?? createMemoryTraceStore();
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const capabilities: Capability[] = [...(opts.capabilities ?? [])];
  if (opts.agentTools !== undefined) {
    const { createAgentToolsCapability } = await import("../../src/runtime/capabilities/tools.ts");
    const ports = opts.agentTools === true ? undefined : opts.agentTools;
    capabilities.push(
      createAgentToolsCapability(
        ports !== undefined
          ? {
              resolveGuard: () => ({
                ...(ports.guard !== undefined ? { guard: ports.guard } : {}),
                ...(ports.guardElicit !== undefined ? { elicit: ports.guardElicit } : {}),
              }),
            }
          : undefined,
      ),
    );
  }
  if (opts.askUser === true) {
    const { createAskUserCapability } = await import("../../src/runtime/capabilities/ask-user.ts");
    capabilities.push(createAskUserCapability());
  }
  if (opts.skills !== undefined) {
    const { createSkillsCapability } = await import("@clarvis/skills/capability");
    capabilities.push(
      createSkillsCapability(
        opts.skills.provider,
        opts.skills.bootstraps !== undefined ? { bootstraps: opts.skills.bootstraps } : {},
      ),
    );
  }
  if (opts.hooks !== undefined) {
    const { createHooksCapability } = await import("@clarvis/hooks/capability");
    capabilities.push(createHooksCapability(opts.hooks));
  }
  const connections = createConnectionManager({
    workspace: workspaceRoot,
    factory: opts.mcpFactory,
    connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    logger: opts.logger,
    ...(opts.mcpLimits ?? {}),
  });
  const deps: ExecuteRunDeps = {
    env,
    llm: opts.llm,
    connections,
    traceStore,
    logger: opts.logger,
    workspaceRoot,
    capabilities,
  };

  let closed = false;

  return {
    owner: defaultOwner,
    traceStore,
    async run(body, callOpts = {}) {
      const owner = callOpts.owner ?? defaultOwner;
      const { executionId, response } = await executeRun({
        rawBody: withTestProviders(body),
        owner,
        deps,
        ...(opts.elicit !== undefined ? { elicit: opts.elicit } : {}),
        ...(opts.steer !== undefined ? { steer: opts.steer } : {}),
        ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
      });
      return { execution_id: executionId, ...response };
    },
    async getRun(id, callOpts = {}) {
      const owner = callOpts.owner ?? defaultOwner;
      const row = traceStore.getById(owner, id);
      return row === null ? null : toDetail(row);
    },
    async listRuns(query = {}, callOpts = {}) {
      const owner = callOpts.owner ?? defaultOwner;
      const limit = query.limit ?? 20;
      const offset = query.offset ?? 0;
      if (limit < 1 || limit > 100) {
        throw new ValidationError("invalid_pagination", "limit must be between 1 and 100");
      }
      if (offset < 0 || offset > 1_000_000) {
        throw new ValidationError("invalid_pagination", "offset must be between 0 and 1000000");
      }
      const { items, total } = traceStore.list(owner, limit, offset);
      return { items: items.map(toSummary), limit, offset, total };
    },
    async deleteRun(id, callOpts = {}) {
      const owner = callOpts.owner ?? defaultOwner;
      return traceStore.deleteById(owner, id);
    },
    async close() {
      if (closed) return;
      closed = true;
      await connections.closeAll();
    },
  };
}
