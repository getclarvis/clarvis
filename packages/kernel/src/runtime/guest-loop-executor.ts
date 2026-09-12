import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  NOOP_LOGGER,
  type CompactionRequest,
  type ExecutionRecord,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type MessageContent,
  type SteerMessage,
} from "@clarvis/capability";
import { buildExecuteRunDeps } from "@clarvis/loop/host";
import { executeRun, type ExecuteRunArgs } from "@clarvis/loop";
import type { StoredExecution, TraceStore } from "@clarvis/trace";
import type { GuestExecutionBridge, GuestRunExecutor } from "./execution-worker.ts";
import { createRuntimePreviewCapability } from "./preview-capability.ts";
import { createGuestPlanFactory } from "./plan-bridge.ts";
import { createPlansCapability } from "@clarvis/plan/capability";
import { plansSettingsSpec } from "@clarvis/plan/settings";
import { memorySettingsSpec } from "@clarvis/memory/settings";
import { createTasksCapability } from "@clarvis/tasks/capability";
import { tasksSettingsSpec } from "@clarvis/tasks/settings";
import { createGuestTaskResolver } from "./tasks-bridge.ts";
import { createGuestHooksCapabilities, type RuntimeHooksDescriptor } from "./hooks-bridge.ts";
import {
  createGuestWorkflowCapabilities,
  type RuntimeWorkflowDescriptor,
} from "./workflows-bridge.ts";
import { createLeaderOutputBudgetCapability, createWorkflowLedger } from "@clarvis/workflows";
import {
  createGuestSkillsCapability,
  type RuntimeSkillBootstrapEntry,
  type RuntimeSkillCatalogEntry,
} from "./skills-bridge.ts";
import { createGuestMemoryCapability, validRuntimeMemoryDescriptor } from "./memory-bridge.ts";
import type { MemoryRuntimeDescriptor } from "@clarvis/memory/capability";
import { createCompactionQueue, type CompactionQueue } from "../runs/compaction-queue.ts";
import { createSteerQueue, type SteerQueue } from "../runs/steer-queue.ts";
import { createGuestHookMcpCaller } from "./hook-mcp.ts";
import { createGuestMcpConnections } from "./remote-mcp.ts";
import { validRuntimeToolPolicy, type RuntimeToolPolicy } from "./tool-policy.ts";
import {
  createGuestGoalCapability,
  validRuntimeGoalDescriptor,
  type RuntimeGoalDescriptor,
} from "./goal-bridge.ts";
import {
  guestLoopEnvironment,
  validRuntimeLoopPolicy,
  type RuntimeLoopPolicy,
} from "./loop-policy.ts";

interface GuestRunEnvelope {
  readonly rawBody: unknown;
  readonly owner: string;
  readonly modelLeaseId: string;
  readonly toolPolicy: RuntimeToolPolicy;
  readonly loopPolicy: RuntimeLoopPolicy;
  readonly priorExecution?: StoredExecution;
  readonly hostCapabilities?: readonly string[];
  readonly skillCatalog?: readonly RuntimeSkillCatalogEntry[];
  readonly skillBootstraps?: readonly RuntimeSkillBootstrapEntry[];
  readonly memory?: MemoryRuntimeDescriptor;
  readonly hooks?: RuntimeHooksDescriptor;
  readonly workflow?: RuntimeWorkflowDescriptor;
  readonly goal?: RuntimeGoalDescriptor;
  readonly parentRunId?: string;
  readonly outputBudgets?: ReadonlyArray<{ tokens: number | null; maxParallelSubagents: number }>;
}

interface GuestRunControl {
  readonly steer: SteerQueue;
  readonly compaction: CompactionQueue;
  readonly hookCalls: AbortController;
  callHookMcp?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  elicitMcp?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}

type GuestControlInput =
  | { readonly kind: "steer"; readonly message: SteerMessage }
  | { readonly kind: "compact"; readonly request: CompactionRequest };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = Object.keys(value);
  return names.length <= allowed.length && names.every((name) => allowed.includes(name));
}

function validMessageContent(value: unknown): value is MessageContent {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  return value.every((candidate) => {
    const part = record(candidate);
    if (part === undefined || typeof part.type !== "string") return false;
    if (part.type === "text") {
      return exactKeys(part, ["type", "text"]) && typeof part.text === "string";
    }
    return (
      part.type === "image" &&
      exactKeys(part, ["type", "image", "mediaType"]) &&
      typeof part.image === "string" &&
      (part.mediaType === undefined || typeof part.mediaType === "string")
    );
  });
}

function validSteerMessage(value: unknown): value is SteerMessage {
  const message = record(value);
  return (
    message !== undefined &&
    exactKeys(message, ["content", "id"]) &&
    validMessageContent(message.content) &&
    (message.id === undefined || typeof message.id === "string")
  );
}

function validCompactionRequest(value: unknown): value is CompactionRequest {
  const request = record(value);
  return (
    request !== undefined &&
    exactKeys(request, ["request"]) &&
    (request.request === undefined || typeof request.request === "string")
  );
}

function validControlInput(value: unknown): value is GuestControlInput {
  const input = record(value);
  if (input?.kind === "steer") {
    return exactKeys(input, ["kind", "message"]) && validSteerMessage(input.message);
  }
  if (input?.kind === "compact") {
    return exactKeys(input, ["kind", "request"]) && validCompactionRequest(input.request);
  }
  return false;
}

function guestControlError(
  code: "conflict" | "invalid_request" | "not_found" | "unauthorized",
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

function guestTraceStore(
  owner: string,
  prior: StoredExecution | undefined,
  bridge: GuestExecutionBridge,
): TraceStore {
  let inserted: ExecutionRecord | undefined;
  return {
    async insert(record) {
      const projection = { ...record };
      delete projection.operator_authority_state;
      await bridge.event({ channel: "trace_record", record: projection });
      inserted = record;
    },
    getById(requestOwner, id) {
      if (requestOwner !== owner) return null;
      if (inserted?.id === id) return inserted;
      return prior?.id === id ? prior : null;
    },
    async replaceFinalContext() {
      return false;
    },
    list() {
      return { items: [], total: 0 };
    },
    deleteById() {
      return false;
    },
    deleteOwner() {
      return 0;
    },
    existsForOwner(requestOwner, id) {
      return requestOwner === owner && (inserted?.id === id || prior?.id === id);
    },
    cleanup() {
      return 0;
    },
  };
}

function validEnvelope(value: unknown): value is GuestRunEnvelope {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !exactKeys(candidate, [
      "rawBody",
      "owner",
      "modelLeaseId",
      "toolPolicy",
      "loopPolicy",
      "priorExecution",
      "hostCapabilities",
      "skillCatalog",
      "skillBootstraps",
      "memory",
      "hooks",
      "workflow",
      "goal",
      "parentRunId",
      "outputBudgets",
    ]) ||
    typeof (value as GuestRunEnvelope).owner !== "string" ||
    typeof (value as GuestRunEnvelope).modelLeaseId !== "string" ||
    !validRuntimeToolPolicy((value as GuestRunEnvelope).toolPolicy) ||
    !validRuntimeLoopPolicy((value as GuestRunEnvelope).loopPolicy) ||
    !Object.prototype.hasOwnProperty.call(value, "rawBody")
  ) {
    return false;
  }
  const envelope = value as GuestRunEnvelope;
  return (
    (envelope.hostCapabilities === undefined ||
      (Array.isArray(envelope.hostCapabilities) &&
        envelope.hostCapabilities.every((name) => typeof name === "string"))) &&
    (envelope.goal === undefined
      ? envelope.hostCapabilities?.includes("goal") !== true
      : envelope.hostCapabilities?.includes("goal") === true &&
        validRuntimeGoalDescriptor(envelope.goal, envelope.rawBody) &&
        envelope.workflow === undefined &&
        envelope.parentRunId === undefined) &&
    (envelope.memory === undefined || validRuntimeMemoryDescriptor(envelope.memory)) &&
    (envelope.memory === undefined || envelope.hostCapabilities?.includes("memory") === true)
  );
}

function modelBody(params: LLMCallParams): unknown {
  return {
    model: params.model,
    provider: params.provider,
    messages: params.messages,
    tools: params.tools,
    ...(params.toolChoice === undefined ? {} : { toolChoice: params.toolChoice }),
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    ...(params.maxRetries === undefined ? {} : { maxRetries: params.maxRetries }),
    ...(params.maxRetryAfterMs === undefined ? {} : { maxRetryAfterMs: params.maxRetryAfterMs }),
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    ...(params.reasoningSummary === undefined ? {} : { reasoningSummary: params.reasoningSummary }),
    ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
    ...(params.promptCacheKey === undefined ? {} : { promptCacheKey: params.promptCacheKey }),
    ...(params.callPurpose === undefined ? {} : { callPurpose: params.callPurpose }),
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    ...(params.agentInstanceId === undefined ? {} : { agentInstanceId: params.agentInstanceId }),
    ...(params.promptCacheTtl === undefined ? {} : { promptCacheTtl: params.promptCacheTtl }),
    ...(params.cacheBreakpoints === undefined ? {} : { cacheBreakpoints: params.cacheBreakpoints }),
  };
}

function guestModelProvider(
  runId: string,
  leaseId: string,
  bridge: GuestExecutionBridge,
): LLMProvider {
  return {
    async call(params): Promise<LLMCallResult> {
      let final: unknown;
      const consume = (event: unknown): void => {
        if (typeof event !== "object" || event === null) return;
        const value = event as {
          type?: unknown;
          channel?: unknown;
          text?: unknown;
          reset?: unknown;
          result?: unknown;
        };
        if (
          value.type === "stream" &&
          (value.channel === "text" || value.channel === "reasoning") &&
          typeof value.text === "string" &&
          typeof value.reset === "boolean"
        ) {
          params.onStreamDelta?.({ channel: value.channel, text: value.text, reset: value.reset });
        } else if (value.type === "result") final = value.result;
      };
      const result = await bridge.model(
        randomUUID(),
        {
          leaseId,
          provider: params.provider,
          model: params.model,
          requestId: randomUUID(),
          conversationId: runId,
          body: modelBody(params),
        },
        params.signal,
        consume,
      );
      for (const event of result.events) consume(event);
      if (typeof final !== "object" || final === null) {
        throw new Error("host model broker returned no terminal model result");
      }
      return final as LLMCallResult;
    },
  };
}

/** Create the headless guest loop implementation used by the runtime image. */
export function createGuestLoopExecutor(
  options: {
    readonly workspaceRoot?: string;
    readonly scratchRoot?: string;
  } = {},
): GuestRunExecutor {
  const workspaceRoot = options.workspaceRoot ?? "/workspace";
  const scratchRoot = options.scratchRoot ?? "/tmp/clarvis-runtime";
  const controls = new Map<string, GuestRunControl>();
  const children = new Map<string, { parentRunId: string; args: ExecuteRunArgs }>();
  return {
    async execute(runId, envelope, bridge, signal) {
      if (!validEnvelope(envelope)) throw new Error("guest run envelope is invalid");
      if (envelope.goal !== undefined && envelope.goal.binding.execution_id !== runId)
        throw guestControlError("unauthorized", "guest goal execution identity mismatches");
      const child = children.get(runId);
      if (
        envelope.parentRunId !== undefined &&
        (child === undefined || child.parentRunId !== envelope.parentRunId)
      ) {
        throw guestControlError("unauthorized", "guest workflow child composition is not admitted");
      }
      if (child !== undefined && child.parentRunId !== envelope.parentRunId) {
        throw guestControlError("unauthorized", "guest workflow parent identity mismatches");
      }
      if (controls.has(runId)) throw guestControlError("conflict", "guest run already exists");
      const control: GuestRunControl = {
        steer: createSteerQueue(),
        compaction: createCompactionQueue(),
        hookCalls: new AbortController(),
      };
      controls.set(runId, control);
      try {
        const traceDir = `${scratchRoot}/traces`;
        await mkdir(traceDir, { recursive: true });
        let eventTail = Promise.resolve();
        const enqueueEvent = (event: unknown): void => {
          eventTail = eventTail.then(() => bridge.event(event));
        };
        const env = guestLoopEnvironment(envelope.loopPolicy, envelope.toolPolicy);
        const plans = envelope.hostCapabilities?.includes("plans")
          ? createPlansCapability({
              factory: createGuestPlanFactory(bridge, signal),
              defaultPendingTaskNudges: env.CLARVIS_DEFAULT_PENDING_TASK_NUDGES,
              defaultElicitWaitMs: env.CLARVIS_DEFAULT_ELICIT_WAIT_MS,
              logger: NOOP_LOGGER,
            })
          : undefined;
        const skills = envelope.hostCapabilities?.includes("skills")
          ? createGuestSkillsCapability(
              envelope.skillCatalog ?? [],
              bridge,
              envelope.skillBootstraps ?? [],
            )
          : undefined;
        const memory = createGuestMemoryCapability(
          envelope.hostCapabilities?.includes("memory") === true ? envelope.memory : undefined,
          bridge,
        );
        const built = await buildExecuteRunDeps({
          env,
          environment: {
            PATH: process.env.PATH,
            HOME: scratchRoot,
            TMPDIR: `${scratchRoot}/tmp`,
          },
          logger: NOOP_LOGGER,
          workspaceRoot,
          traceDir,
          builtins: { tools: envelope.toolPolicy.enabled, skills: false, hooks: false },
          resolveSecretNames: () => [],
          allowHostEscalation: false,
          capabilities: [
            ...(envelope.toolPolicy.enabled && envelope.toolPolicy.maxGrant === "exec"
              ? [createRuntimePreviewCapability(bridge)]
              : []),
            ...(plans === undefined ? [] : [plans]),
            ...(skills === undefined ? [] : [skills]),
            memory,
            ...(envelope.hooks === undefined
              ? []
              : createGuestHooksCapabilities(envelope.hooks, bridge)),
            createTasksCapability({
              ...(envelope.hostCapabilities?.includes("tasks") === true
                ? { resolver: createGuestTaskResolver(bridge) }
                : {}),
            }),
          ],
        });
        built.deps.capabilityRegistry?.register(plansSettingsSpec);
        built.deps.capabilityRegistry?.register(memorySettingsSpec);
        built.deps.capabilityRegistry?.register(tasksSettingsSpec);
        built.deps.llm = guestModelProvider(runId, envelope.modelLeaseId, bridge);
        const connections = createGuestMcpConnections({
          local: built.deps.connections,
          bridge,
          signal,
        });
        built.deps.connections = connections;
        control.elicitMcp = (input, signal) => connections.elicit(input, signal);
        built.deps.traceStore = guestTraceStore(envelope.owner, envelope.priorExecution, bridge);
        const extraCapabilities = [
          ...(envelope.goal === undefined
            ? []
            : [
                createGuestGoalCapability(
                  envelope.goal,
                  {
                    ...bridge,
                    async capability(...args) {
                      await eventTail;
                      return bridge.capability(...args);
                    },
                  },
                  signal,
                ),
              ]),
          ...(child?.args.capabilities ?? []),
          ...(envelope.outputBudgets ?? []).map((budget) =>
            createLeaderOutputBudgetCapability(
              createWorkflowLedger(budget.tokens),
              budget.maxParallelSubagents,
            ),
          ),
          ...(envelope.workflow === undefined
            ? []
            : createGuestWorkflowCapabilities({
                descriptor: envelope.workflow,
                bridge,
                runId,
                owner: envelope.owner,
                deps: built.deps,
                signal,
                enqueueEvent,
                registerChild(childRunId, args) {
                  if (children.has(childRunId) || controls.has(childRunId))
                    throw new Error("duplicate guest workflow child");
                  const admission = { parentRunId: runId, args };
                  children.set(childRunId, admission);
                  return () => {
                    if (children.get(childRunId) === admission) children.delete(childRunId);
                  };
                },
              })),
        ];
        let sequence = 0;
        try {
          const servers = record(envelope.rawBody)?.servers;
          control.callHookMcp = createGuestHookMcpCaller({
            servers: Array.isArray(servers) ? servers : [],
            owner: envelope.owner,
            connections: built.deps.connections,
            signal: AbortSignal.any([signal, control.hookCalls.signal]),
          });
          const outcome = await executeRun({
            rawBody: envelope.rawBody,
            owner: envelope.owner,
            deps: built.deps,
            capabilities: extraCapabilities,
            externalSignal: signal,
            steer:
              child?.args.steer === undefined
                ? control.steer
                : {
                    drain: () => [...control.steer.drain(), ...child.args.steer!.drain()],
                  },
            compaction: control.compaction,
            elicit: (params, opts) =>
              bridge.capability(
                randomUUID(),
                {
                  method: "runtime.elicit",
                  revision: "v1",
                  arguments: { params, timeoutMs: opts.timeoutMs },
                },
                opts.signal,
              ) as ReturnType<NonNullable<Parameters<typeof executeRun>[0]["elicit"]>>,
            onEvent: (event) => {
              child?.args.onEvent?.(event);
              enqueueEvent({ channel: "trace", event });
            },
            onCapabilityEvent: (event) => {
              enqueueEvent({ channel: "capability", event });
            },
          });
          await eventTail;
          sequence += 1;
          await bridge.checkpoint({ sequence, terminal: false, state: { outcome } });
          return outcome;
        } finally {
          control.hookCalls.abort(new Error("guest run MCP hooks closed"));
          try {
            await eventTail;
          } finally {
            try {
              await connections.closeAll();
            } finally {
              await built.dispose();
            }
          }
        }
      } finally {
        control.hookCalls.abort(new Error("guest run MCP hooks closed"));
        control.steer.close();
        control.compaction.close();
        if (controls.get(runId) === control) controls.delete(runId);
      }
    },
    async callHookMcp(runId, input, signal) {
      const control = controls.get(runId);
      if (control?.callHookMcp === undefined) {
        throw guestControlError("not_found", "run MCP hooks are unavailable");
      }
      return control.callHookMcp(input, signal);
    },
    async elicitMcp(runId, input, signal) {
      const control = controls.get(runId);
      if (control?.elicitMcp === undefined) {
        throw guestControlError("not_found", "run MCP elicitation is unavailable");
      }
      return control.elicitMcp(input, signal);
    },
    async steer(runId, input, _signal) {
      const control = controls.get(runId);
      if (control === undefined) {
        throw guestControlError("not_found", "run cannot be steered");
      }
      if (!validControlInput(input)) {
        throw guestControlError("invalid_request", "runtime control input is invalid");
      }
      if (input.kind === "compact") {
        if (!control.compaction.push(input.request)) {
          throw guestControlError("not_found", "run cannot be compacted");
        }
        return;
      }
      if (!(await control.steer.push(input.message))) {
        throw guestControlError("not_found", "run is no longer accepting steering");
      }
    },
  };
}
