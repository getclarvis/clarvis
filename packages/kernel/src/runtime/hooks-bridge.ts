import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createCapabilityRequestView,
  createCapabilityServices,
  MCP_HOOK_TOOL_PORT,
  type Capability,
  type LifecycleHook,
  type RunCapability,
  type RunRequest,
} from "@clarvis/capability";
import type { RunExecutorArgs } from "../runs/run-service.ts";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

export const RUNTIME_HOOKS_METHOD = "runtime.hooks";
const REVISION = "v1";
const text = z.string();
const agent = { agent: z.enum(["lead", "subagent"]), subagentInstanceId: text.optional() };
const tool = { tool: text, toolFullName: text.optional(), arguments: z.unknown() };
const contexts = {
  beforeToolUse: z.object(tool).strict(),
  afterToolUse: z.object({ ...tool, result: z.unknown() }).strict(),
  preFinalize: z
    .object({
      ...agent,
      mode: z.enum(["text", "submit"]),
      text: text.optional(),
      value: z.unknown().optional(),
    })
    .strict(),
  preDelegateTask: z
    .object({ title: text, task: text, profile: text, taskId: text.optional() })
    .strict(),
  onRunStart: z
    .object({ mode: text, entry: text, leadModel: text.optional(), subagentModel: text.optional() })
    .strict(),
  onRunEnd: z
    .object({
      status: text,
      errorCode: text.optional(),
      iterationsUsed: z.number(),
      elapsedMs: z.number(),
    })
    .strict(),
  onSubagentStart: z
    .object({ subagentInstanceId: text, profile: text, model: text, task: text })
    .strict(),
  onSubagentComplete: z.object({ subagentInstanceId: text, status: text, result: text }).strict(),
  onPostCompact: z
    .object({
      ...agent,
      operation: z.enum(["eviction", "truncation", "summarization"]),
      freedChars: z.number().optional(),
      keptChars: z.number().optional(),
    })
    .strict(),
  onPreCompact: z.object({ ...agent, estimatedTokens: z.number() }).strict(),
  onModelCallError: z
    .object({ ...agent, iteration: z.number(), model: text, message: text })
    .strict(),
  onBudgetExhausted: z
    .object({
      agent: agent.agent,
      reason: z.enum(["exhausted", "declined"]),
      tokensUsed: z.number(),
      iterationsUsed: z.number(),
    })
    .strict(),
  onUserSteer: z
    .object({ ...agent, iteration: z.number(), message: text, id: text.optional() })
    .strict(),
} satisfies Record<keyof LifecycleHook, z.ZodType>;
const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("seed") }).strict(),
  z
    .object({
      operation: z.literal("invoke"),
      index: z.number().int().nonnegative(),
      method: z.enum(Object.keys(contexts) as [keyof LifecycleHook, ...Array<keyof LifecycleHook>]),
      context: z.unknown(),
    })
    .strict(),
]);

/** Presence is preserved: only configured hook fire points enter the guest chain. */
export interface RuntimeHooksDescriptor {
  readonly seedMarkers: readonly string[];
  readonly lifecycle: ReadonlyArray<readonly (keyof LifecycleHook)[]>;
}

/** Activate admitted hook implementations on the host; never accept a command from the guest. */
export async function createHostHooksBridge(
  args: RunExecutorArgs,
  runId: string,
): Promise<
  | {
      descriptor: RuntimeHooksDescriptor;
      grant: HostCapabilityGrant;
    }
  | undefined
> {
  const capabilities = [...(args.deps.capabilities ?? []), ...(args.capabilities ?? [])].filter(
    (capability) => capability.name === "hooks",
  );
  if (capabilities.length === 0) return undefined;
  const request = args.rawBody as RunRequest;
  const services = createCapabilityServices();
  services.provide(MCP_HOOK_TOOL_PORT, {
    async call(server, tool, input, signal) {
      const declaration = request.servers.find((candidate) => candidate.name === server);
      if (declaration === undefined) throw new Error("hook MCP server is not active for this run");
      const lease = await args.deps.connections.acquire({
        server: declaration,
        owner: args.owner,
        poolSharing: "owner",
        ...(signal === undefined ? {} : { signal }),
      });
      try {
        return await lease.conn.callTool(tool, input, signal);
      } finally {
        await lease.release();
      }
    },
  });
  const active: RunCapability[] = [];
  for (const capability of capabilities) {
    const run = await capability.forRun({
      ...createCapabilityRequestView(request),
      services,
      owner: args.owner,
      executionId: runId,
      entryGrants: request.profiles.find((profile) => profile.name === request.entry)?.grants ?? [],
      env: args.deps.env,
      workspaceRoot: args.deps.workspaceRoot,
      llm: args.deps.llm,
      ...(args.elicit === undefined ? {} : { elicit: args.elicit }),
      ...(args.externalSignal === undefined ? {} : { signal: args.externalSignal }),
      ...(args.deps.logger === undefined ? {} : { logger: args.deps.logger }),
      emit: (event) => args.onCapabilityEvent?.(event),
    });
    if (run !== null) active.push(run);
  }
  const lifecycle = active.flatMap((run) => run.lifecycle ?? []);
  const descriptor: RuntimeHooksDescriptor = {
    seedMarkers: capabilities.flatMap((capability) =>
      capability.seedMarker === undefined ? [] : [capability.seedMarker],
    ),
    lifecycle: lifecycle.map(
      (hook) =>
        Object.keys(contexts).filter(
          (method) => typeof hook[method as keyof LifecycleHook] === "function",
        ) as Array<keyof LifecycleHook>,
    ),
  };
  let seed: Promise<readonly string[]> | undefined;
  return {
    descriptor,
    grant: {
      method: RUNTIME_HOOKS_METHOD,
      revision: REVISION,
      idempotent: false,
      validateArguments(value) {
        const parsed = requestSchema.safeParse(value);
        return (
          parsed.success &&
          (parsed.data.operation === "seed" ||
            (descriptor.lifecycle[parsed.data.index]?.includes(parsed.data.method) === true &&
              contexts[parsed.data.method].safeParse(parsed.data.context).success))
        );
      },
      async invoke(value, signal) {
        const input = requestSchema.parse(value);
        signal.throwIfAborted();
        if (input.operation === "seed") {
          seed ??= Promise.all(active.map(async (run) => await run.seedBlock?.())).then((blocks) =>
            blocks.filter((block): block is string => block !== undefined),
          );
          return seed;
        }
        const callback = lifecycle[input.index]?.[input.method] as
          ((context: unknown) => Promise<unknown>) | undefined;
        if (callback === undefined || !contexts[input.method].safeParse(input.context).success)
          throw new Error("runtime hook invocation is not admitted");
        return callback(input.context);
      },
    },
  };
}

/** Preserve native gate ordering, rewrites and failure handling over exact host hook callbacks. */
export function createGuestHooksCapabilities(
  descriptor: RuntimeHooksDescriptor,
  bridge: GuestExecutionBridge,
): Capability[] {
  return [
    ...descriptor.seedMarkers.map((seedMarker, index): Capability => ({
      name: `hooks.marker.${index}`,
      seedMarker,
      forRun: () => null,
    })),
    {
      name: "hooks",
      forRun: () => ({
        name: "hooks",
        forAgent: () => null,
        seedBlock: async () =>
          (
            (await bridge.capability(randomUUID(), {
              method: RUNTIME_HOOKS_METHOD,
              revision: REVISION,
              arguments: { operation: "seed" },
            })) as string[]
          ).join("\n\n") || undefined,
        lifecycle: descriptor.lifecycle.map(
          (methods, index) =>
            Object.fromEntries(
              methods.map((method) => [
                method,
                (context: unknown) =>
                  bridge.capability(randomUUID(), {
                    method: RUNTIME_HOOKS_METHOD,
                    revision: REVISION,
                    arguments: { operation: "invoke", index, method, context },
                  }),
              ]),
            ) as LifecycleHook,
        ),
      }),
    },
  ];
}
