import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  loadEnv,
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
import { createGuardResolver, type GuardSettings } from "../guard/resolver.ts";
import { createGuestGuardAuditLogger } from "./guard-audit-bridge.ts";
import { createRuntimePreviewCapability } from "./preview-capability.ts";
import { createGuestPlanFactory } from "./plan-bridge.ts";
import { createPlansCapability } from "@clarvis/plan/capability";
import { plansSettingsSpec } from "@clarvis/plan/settings";
import { memorySettingsSpec } from "@clarvis/memory/settings";
import {
  createGuestSkillsCapability,
  type RuntimeSkillBootstrapEntry,
  type RuntimeSkillCatalogEntry,
} from "./skills-bridge.ts";
import { createGuestMemoryCapability, validRuntimeMemoryDescriptor } from "./memory-bridge.ts";
import type { MemoryRuntimeDescriptor } from "@clarvis/memory/capability";
import { createCompactionQueue, type CompactionQueue } from "../runs/compaction-queue.ts";
import { createSteerQueue, type SteerQueue } from "../runs/steer-queue.ts";

interface GuestRunEnvelope {
  readonly rawBody: unknown;
  readonly owner: string;
  readonly modelLeaseId: string;
  readonly priorExecution?: StoredExecution;
  readonly guardSettings?: Omit<GuardSettings, "providers">;
  readonly hostCapabilities?: readonly string[];
  readonly skillCatalog?: readonly RuntimeSkillCatalogEntry[];
  readonly skillBootstraps?: readonly RuntimeSkillBootstrapEntry[];
  readonly memory?: MemoryRuntimeDescriptor;
}

interface GuestRunControl {
  readonly steer: SteerQueue;
  readonly compaction: CompactionQueue;
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
  code: "conflict" | "invalid_request" | "not_found",
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
      await bridge.event({ channel: "trace_record", record });
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
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as GuestRunEnvelope).owner !== "string" ||
    typeof (value as GuestRunEnvelope).modelLeaseId !== "string" ||
    !Object.prototype.hasOwnProperty.call(value, "rawBody")
  ) {
    return false;
  }
  const envelope = value as GuestRunEnvelope;
  return (
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
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    ...(params.reasoningSummary === undefined ? {} : { reasoningSummary: params.reasoningSummary }),
    ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
    ...(params.promptCacheKey === undefined ? {} : { promptCacheKey: params.promptCacheKey }),
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
      );
      let final: unknown;
      for (const event of result.events) {
        if (typeof event !== "object" || event === null) continue;
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
      }
      if (typeof final !== "object" || final === null) {
        throw new Error("host model broker returned no terminal model result");
      }
      return final as LLMCallResult;
    },
  };
}

function guestGuardSettings(envelope: GuestRunEnvelope): GuardSettings {
  const raw = envelope.rawBody as { providers?: unknown };
  return {
    ...(envelope.guardSettings?.guard === undefined ? {} : { guard: envelope.guardSettings.guard }),
    ...(envelope.guardSettings?.defaultModel === undefined
      ? {}
      : { defaultModel: envelope.guardSettings.defaultModel }),
    ...(Array.isArray(raw.providers) ? { providers: raw.providers } : {}),
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
      };
      controls.set(runId, control);
      try {
        const traceDir = `${scratchRoot}/traces`;
        await mkdir(traceDir, { recursive: true });
        let eventTail = Promise.resolve();
        const enqueueEvent = (event: unknown): void => {
          eventTail = eventTail.then(() => bridge.event(event));
        };
        const env = loadEnv({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
        });
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
          builtins: { tools: true, skills: false, hooks: false },
          resolveGuard: createGuardResolver({
            loadSettings: () => guestGuardSettings(envelope),
            logger: NOOP_LOGGER,
            audit: createGuestGuardAuditLogger(enqueueEvent),
          }),
          resolveSecretNames: () => [],
          capabilities: [
            createRuntimePreviewCapability(bridge),
            ...(plans === undefined ? [] : [plans]),
            ...(skills === undefined ? [] : [skills]),
            memory,
          ],
        });
        if (plans !== undefined) built.deps.capabilityRegistry?.register(plansSettingsSpec);
        built.deps.capabilityRegistry?.register(memorySettingsSpec);
        built.deps.llm = guestModelProvider(runId, envelope.modelLeaseId, bridge);
        built.deps.traceStore = guestTraceStore(envelope.owner, envelope.priorExecution, bridge);
        let sequence = 0;
        try {
          const outcome = await executeRun({
            rawBody: envelope.rawBody,
            owner: envelope.owner,
            deps: built.deps,
            externalSignal: signal,
            steer: control.steer,
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
          await eventTail;
          await built.dispose();
        }
      } finally {
        control.steer.close();
        control.compaction.close();
        if (controls.get(runId) === control) controls.delete(runId);
      }
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
