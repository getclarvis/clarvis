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
import { executeRun } from "@clarvis/loop";
import type { StoredExecution, TraceStore } from "@clarvis/trace";
import type { GuestExecutionBridge, GuestRunExecutor } from "./execution-worker.ts";
import { createCompactionQueue, type CompactionQueue } from "../runs/compaction-queue.ts";
import { createSteerQueue, type SteerQueue } from "../runs/steer-queue.ts";
import { createToolInterruptChannel, TOOL_EXECUTION_ID } from "../runs/tool-interrupt-channel.ts";
import type { ToolInterruptChannel } from "../runs/tool-interrupt-channel.ts";
import { validRuntimeToolPolicy, type RuntimeToolPolicy } from "./tool-policy.ts";
import {
  guestLoopEnvironment,
  validRuntimeLoopPolicy,
  type RuntimeLoopPolicy,
} from "./loop-policy.ts";
import {
  CONTAINER_CORE_GRANTS,
  CONTAINER_FORBIDDEN_REQUEST_FIELDS,
} from "./container-core-policy.ts";

interface GuestRunEnvelope {
  readonly rawBody: unknown;
  readonly owner: string;
  readonly modelLeaseId: string;
  readonly toolPolicy: RuntimeToolPolicy;
  readonly loopPolicy: RuntimeLoopPolicy;
  readonly priorExecution?: StoredExecution;
}

interface GuestRunControl {
  readonly steer: SteerQueue;
  readonly compaction: CompactionQueue;
  readonly toolInterrupts: ToolInterruptChannel;
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

/** Validate the closed steer/compact payload accepted by a running guest. */
export function isGuestControlInput(value: unknown): value is GuestControlInput {
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
    ]) ||
    typeof (value as GuestRunEnvelope).owner !== "string" ||
    typeof (value as GuestRunEnvelope).modelLeaseId !== "string" ||
    !validRuntimeToolPolicy((value as GuestRunEnvelope).toolPolicy) ||
    !validRuntimeLoopPolicy((value as GuestRunEnvelope).loopPolicy) ||
    !Object.prototype.hasOwnProperty.call(value, "rawBody")
  ) {
    return false;
  }
  const raw = record((value as GuestRunEnvelope).rawBody);
  const profiles = raw?.profiles;
  const providers = raw?.providers;
  return (
    raw !== undefined &&
    CONTAINER_FORBIDDEN_REQUEST_FIELDS.every((key) => !(key in raw)) &&
    Array.isArray(raw.servers) &&
    raw.servers.length === 0 &&
    Array.isArray(profiles) &&
    profiles.every((candidate) => {
      const profile = record(candidate);
      return (
        profile !== undefined &&
        Array.isArray(profile.tools) &&
        profile.tools.length === 0 &&
        (profile.grants === undefined ||
          (Array.isArray(profile.grants) &&
            profile.grants.every(
              (grant) =>
                typeof grant === "string" &&
                (CONTAINER_CORE_GRANTS as readonly string[]).includes(grant),
            )))
      );
    }) &&
    Array.isArray(providers) &&
    providers.length > 0 &&
    providers.every((candidate) => {
      const provider = record(candidate);
      return (
        provider !== undefined &&
        exactKeys(provider, ["name", "kind", "base_url"]) &&
        typeof provider.name === "string" &&
        provider.kind === "openai-compatible" &&
        provider.base_url === "http://runtime-model-broker.invalid"
      );
    })
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
  return {
    async execute(runId, envelope, bridge, signal) {
      if (!validEnvelope(envelope)) throw new Error("guest run envelope is invalid");
      if (controls.has(runId)) throw guestControlError("conflict", "guest run already exists");
      const control: GuestRunControl = {
        steer: createSteerQueue(),
        compaction: createCompactionQueue(),
        toolInterrupts: createToolInterruptChannel(),
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
          capabilities: [],
        });
        built.deps.llm = guestModelProvider(runId, envelope.modelLeaseId, bridge);
        built.deps.traceStore = guestTraceStore(envelope.owner, envelope.priorExecution, bridge);
        let sequence = 0;
        try {
          const outcome = await executeRun({
            rawBody: envelope.rawBody,
            owner: envelope.owner,
            deps: built.deps,
            capabilities: [],
            externalSignal: signal,
            steer: control.steer,
            compaction: control.compaction,
            toolInterrupts: control.toolInterrupts,
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
          try {
            await eventTail;
          } finally {
            await built.dispose();
          }
        }
      } finally {
        control.steer.close();
        control.compaction.close();
        control.toolInterrupts.close();
        if (controls.get(runId) === control) controls.delete(runId);
      }
    },
    async interruptTool(runId, payload) {
      const control = controls.get(runId);
      const body = record(payload);
      const toolExecutionId = body?.tool_execution_id;
      if (
        body === undefined ||
        !exactKeys(body, ["tool_execution_id"]) ||
        typeof toolExecutionId !== "string" ||
        !TOOL_EXECUTION_ID.test(toolExecutionId)
      ) {
        throw guestControlError("invalid_request", "runtime interrupt payload is invalid");
      }
      if (control === undefined) {
        return { tool_execution_id: toolExecutionId, status: "not_running" };
      }
      return control.toolInterrupts.interruptTool(toolExecutionId);
    },
    async steer(runId, input, _signal) {
      const control = controls.get(runId);
      if (control === undefined) {
        throw guestControlError("not_found", "run cannot be steered");
      }
      if (!isGuestControlInput(input)) {
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
