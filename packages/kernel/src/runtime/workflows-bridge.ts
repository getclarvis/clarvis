import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseTaskTitle, type Capability, type RunRequest } from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import { generateExecutionId } from "@clarvis/trace";
import {
  createWorkflowLedger,
  createWorkflowLeaderCount,
  createWorkflowSemaphore,
  createWorkflowsCapability,
  WORKFLOW_LIMITS,
  type WorkflowCtx,
} from "@clarvis/workflows";
import type { RunExecutor } from "../runs/run-service.ts";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

export const RUNTIME_WORKFLOWS_METHOD = "runtime.workflows";
const REVISION = "v1";
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const requestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("prepare"),
      runId: runIdSchema,
      spec: z
        .object({
          title: z.string().refine((value) => parseTaskTitle(value).ok),
          prompt: z.string().min(1).max(WORKFLOW_LIMITS.textChars),
          profile: z.string().min(1).max(WORKFLOW_LIMITS.identifierChars).optional(),
          expectSchema: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ operation: z.literal("execute"), runId: runIdSchema }).strict(),
]);

/** Data-only manager composition; execution, settings resolution and credentials remain host-owned. */
export interface RuntimeWorkflowDescriptor {
  readonly maxConcurrency: number;
  readonly maxParallelSubagents: number;
  readonly maxTotalLeaders: number;
  readonly budgetTokens: number | null;
  readonly elicitWaitMs: number;
  readonly leaderProfiles?: WorkflowCtx["leaderProfiles"];
  readonly workflowDefs?: WorkflowCtx["workflowDefs"];
}

/** Admit each leader's canonical host request once and pin its execution to this runtime generation. */
export function createHostWorkflowBridge(
  ctx: WorkflowCtx,
  executeRun: RunExecutor,
): {
  descriptor: RuntimeWorkflowDescriptor;
  grant: HostCapabilityGrant;
} {
  const prepared = new Map<string, RunRequest>();
  const used = new Set<string>();
  return {
    descriptor: {
      maxConcurrency: ctx.maxConcurrency,
      maxParallelSubagents: ctx.maxParallelSubagents,
      maxTotalLeaders: ctx.leaderCount.limit,
      budgetTokens: ctx.ledger.total,
      elicitWaitMs: ctx.elicitWaitMs,
      ...(ctx.leaderProfiles === undefined ? {} : { leaderProfiles: ctx.leaderProfiles }),
      ...(ctx.workflowDefs === undefined ? {} : { workflowDefs: ctx.workflowDefs }),
    },
    grant: {
      method: RUNTIME_WORKFLOWS_METHOD,
      revision: REVISION,
      idempotent: false,
      validateArguments: (value) => requestSchema.safeParse(value).success,
      async invoke(value, signal) {
        const request = requestSchema.parse(value);
        signal.throwIfAborted();
        ctx.signal.throwIfAborted();
        if (request.operation === "prepare") {
          if (
            request.runId === ctx.managerRunId ||
            prepared.has(request.runId) ||
            used.has(request.runId) ||
            prepared.size + used.size >= ctx.leaderCount.limit ||
            (request.spec.profile !== undefined &&
              !ctx.leaderProfiles?.some((profile) => profile.name === request.spec.profile))
          ) {
            throw Object.assign(
              new Error("workflow leader is outside the admitted manager composition"),
              { code: "unauthorized" },
            );
          }
          used.add(request.runId);
          const body = await ctx.assemble(request.spec, {
            parentRunId: ctx.managerRunId,
            runId: request.runId,
          });
          signal.throwIfAborted();
          ctx.signal.throwIfAborted();
          if (body.profiles.some((profile) => profile.grants?.includes("workflow"))) {
            throw new Error("workflow leader assembler retained a manager grant");
          }
          const admitted = {
            ...body,
            execution_id: request.runId,
            plans: "off" as const,
            memory: "off" as const,
          };
          prepared.set(request.runId, admitted);
          used.delete(request.runId);
          return admitted;
        }
        const rawBody = prepared.get(request.runId);
        if (rawBody === undefined || used.has(request.runId))
          throw Object.assign(
            new Error("workflow leader request was not prepared or was already consumed"),
            { code: "conflict" },
          );
        used.add(request.runId);
        prepared.delete(request.runId);
        const combined = AbortSignal.any([signal, ctx.signal]);
        await ctx.semaphore.acquire(combined);
        try {
          const elicit = ctx.elicitForLeader?.(request.runId);
          return await executeRun({
            rawBody,
            owner: ctx.owner,
            deps: ctx.deps,
            externalSignal: combined,
            runtimeParentRunId: ctx.managerRunId,
            ...(elicit === undefined ? {} : { elicit }),
            onEvent: (event) => ctx.onLeaderEvent?.(request.runId, event),
          });
        } finally {
          ctx.semaphore.release();
        }
      },
    },
  };
}

/** Keep native scheduling, supervision and shared budget objects together inside the guest. */
export function createGuestWorkflowCapabilities(options: {
  descriptor: RuntimeWorkflowDescriptor;
  bridge: GuestExecutionBridge;
  runId: string;
  owner: string;
  deps: ExecuteRunDeps;
  signal: AbortSignal;
  enqueueEvent: (event: unknown) => void;
  registerChild: (runId: string, args: ExecuteRunArgs) => () => void;
}): Capability[] {
  const { descriptor, bridge } = options;
  const ledger = createWorkflowLedger(descriptor.budgetTokens);
  const progress = (): void =>
    options.enqueueEvent({ channel: "workflow_budget", spent: ledger.spent() });
  const ctx: WorkflowCtx = {
    deps: options.deps,
    owner: options.owner,
    managerRunId: options.runId,
    signal: options.signal,
    ledger,
    leaderCount: createWorkflowLeaderCount(descriptor.maxTotalLeaders),
    semaphore: createWorkflowSemaphore(descriptor.maxConcurrency),
    maxConcurrency: descriptor.maxConcurrency,
    maxParallelSubagents: descriptor.maxParallelSubagents,
    elicitWaitMs: descriptor.elicitWaitMs,
    ...(descriptor.leaderProfiles === undefined
      ? {}
      : { leaderProfiles: descriptor.leaderProfiles }),
    ...(descriptor.workflowDefs === undefined ? {} : { workflowDefs: descriptor.workflowDefs }),
    assemble: (spec, { runId }) =>
      bridge.capability(
        randomUUID(),
        {
          method: RUNTIME_WORKFLOWS_METHOD,
          revision: REVISION,
          arguments: { operation: "prepare", runId, spec },
        },
        options.signal,
      ) as Promise<RunRequest>,
    runDeps: {
      generateExecutionId,
      async executeRun(args) {
        const runId = (args.rawBody as RunRequest).execution_id!;
        const release = options.registerChild(runId, args);
        try {
          return (await bridge.capability(
            randomUUID(),
            {
              method: RUNTIME_WORKFLOWS_METHOD,
              revision: REVISION,
              arguments: { operation: "execute", runId },
            },
            args.externalSignal,
          )) as ExecuteRunOutcome;
        } finally {
          release();
          progress();
        }
      },
    },
    onSequenceState: (state) => {
      progress();
      options.enqueueEvent({ channel: "workflow_state", state });
    },
    onBudgetExhausted: () => options.enqueueEvent({ channel: "workflow_budget_exhausted" }),
  };
  return [
    createWorkflowsCapability(ctx),
    {
      name: "workflows.runtime-progress",
      forRun: () => ({
        name: "workflows.runtime-progress",
        forAgent: () => null,
        lifecycle: [{ onRunEnd: async () => progress() }],
      }),
    },
  ];
}

const sequenceSchema = z
  .object({
    sessionId: z.string(),
    status: z.enum([
      "running_round",
      "awaiting_manager",
      "completed",
      "stopped",
      "failed",
      "cancelled",
    ]),
    revision: z.number().int().nonnegative(),
    roundId: z.string().optional(),
    pass: z.number().int().optional(),
    nextRoundId: z.string().optional(),
    nextPass: z.number().int().optional(),
    leadersStarted: z.number().int().nonnegative(),
    maxTotalLeaders: z.number().int().positive(),
    reason: z.string().optional(),
  })
  .strict();

/** Persist guest scheduler progress through the owning host workflow's existing callbacks. */
export function consumeGuestWorkflowEvent(ctx: WorkflowCtx | undefined, value: unknown): boolean {
  if (ctx === undefined || typeof value !== "object" || value === null) return false;
  const event = value as { channel?: unknown; spent?: unknown; state?: unknown };
  if (event.channel === "workflow_budget") {
    const spent = z.number().int().nonnegative().parse(event.spent);
    if (ctx.ledger.total !== null && spent > ctx.ledger.total)
      throw new Error("workflow spend exceeds its admitted budget");
    const delta = spent - ctx.ledger.spent();
    if (delta > 0) ctx.ledger.reserveOutput(delta)?.settle(delta);
    return true;
  }
  if (event.channel === "workflow_state") {
    ctx.onSequenceState?.(sequenceSchema.parse(event.state));
    return true;
  }
  if (event.channel === "workflow_budget_exhausted") {
    ctx.onBudgetExhausted?.();
    return true;
  }
  return false;
}
