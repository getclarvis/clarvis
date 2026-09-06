import type { CapabilityEvent, TraceEvent } from "@clarvis/capability";
import type { ExecutionRecord } from "@clarvis/capability";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import type { RootOptions } from "@clarvis/paths";
import type { RunExecutor, RunExecutorArgs } from "../runs/run-service.ts";
import type { ExecutionRequestHandler, GuestExecutionMethod } from "./execution-rpc.ts";
import {
  createRuntimeHostHandlers,
  type RuntimeHostBridgeOptions,
} from "./host-execution-bridge.ts";
import { loadRuntimeCheckpoint, settleRuntimeTerminal } from "./runtime-checkpoints.ts";
import type { RuntimeSession } from "./types.ts";

/** Dynamic run registry behind one long-lived runtime generation's guest handlers. */
export interface RuntimeAuthorityRouter {
  readonly handlers: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>;
  bind(
    runId: string,
    handlers: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>,
  ): () => void;
}

type RuntimeRunAuthority = Omit<
  RuntimeHostBridgeOptions,
  "workspaceRoot" | "generation" | "runId" | "appendEvent" | "roots"
> & {
  /** Releases host-only per-run snapshots after every success or failure. */
  readonly dispose?: () => void | Promise<void>;
};

/** Create a router that refuses every request not bound to a currently active run. */
export function createRuntimeAuthorityRouter(generation: string): RuntimeAuthorityRouter {
  const runs = new Map<
    string,
    Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>
  >();
  const dispatch =
    (method: GuestExecutionMethod): ExecutionRequestHandler =>
    async (request) => {
      if (request.generation !== generation || request.runId === undefined) {
        throw Object.assign(new Error("runtime authority identity mismatch"), {
          code: "unauthorized",
        });
      }
      const handler = runs.get(request.runId)?.[method];
      if (handler === undefined) {
        throw Object.assign(new Error("runtime run authority is not active"), {
          code: "unauthorized",
        });
      }
      return handler(request);
    };
  return {
    handlers: {
      "host.model": dispatch("host.model"),
      "host.capability": dispatch("host.capability"),
      "host.event": dispatch("host.event"),
      "host.checkpoint": dispatch("host.checkpoint"),
    },
    bind(runId, handlers) {
      if (runs.has(runId)) throw new Error(`runtime run '${runId}' is already bound`);
      runs.set(runId, handlers);
      return () => {
        if (runs.get(runId) === handlers) runs.delete(runId);
      };
    },
  };
}

function isOutcome(value: unknown): value is ExecuteRunOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ExecuteRunOutcome).executionId === "string" &&
    typeof (value as ExecuteRunOutcome).response === "object" &&
    (value as ExecuteRunOutcome).response !== null
  );
}

/** Build the placement adapter used by both ordinary and workflow executions. */
export function createIsolatedRunExecutor(options: {
  readonly generation: string;
  readonly workspaceRoot: string;
  readonly session: RuntimeSession;
  readonly router: RuntimeAuthorityRouter;
  readonly roots?: RootOptions;
  readonly authority: (
    args: RunExecutorArgs,
    runId: string,
  ) => RuntimeRunAuthority | Promise<RuntimeRunAuthority>;
  readonly pollIntervalMs?: number;
  /** Adds host-sanitized immutable snapshots such as the opaque model lease id. */
  readonly guestEnvelope?: (
    args: RunExecutorArgs,
    runId: string,
  ) => Readonly<Record<string, unknown>>;
  /** Consumes a validated private guest event outside the public trace/capability channels. */
  readonly consumeGuestEvent?: (
    args: RunExecutorArgs,
    runId: string,
    value: unknown,
  ) => boolean | Promise<boolean>;
}): RunExecutor {
  const pollIntervalMs = Math.max(5, Math.min(250, options.pollIntervalMs ?? 25));
  return async (args) => {
    args.externalSignal?.throwIfAborted();
    const raw = args.rawBody as { execution_id?: unknown };
    if (typeof raw?.execution_id !== "string") {
      throw Object.assign(new Error("isolated run requires a host execution id"), {
        code: "invalid_request",
      });
    }
    const runId = raw.execution_id;
    const authority = await options.authority(args, runId);
    if (args.externalSignal?.aborted === true) {
      authority.model.revoke();
      authority.capabilities.revoke();
      await authority.dispose?.();
      args.externalSignal.throwIfAborted();
    }
    const release = options.router.bind(
      runId,
      createRuntimeHostHandlers({
        workspaceRoot: options.workspaceRoot,
        generation: options.generation,
        runId,
        ...authority,
        ...(options.roots === undefined ? {} : { roots: options.roots }),
        appendEvent: async (value) => {
          if (typeof value !== "object" || value === null) {
            throw Object.assign(new Error("runtime event envelope is invalid"), {
              code: "invalid_request",
            });
          }
          const event = value as { channel?: unknown; event?: unknown };
          if (event.channel === "trace") args.onEvent?.(event.event as TraceEvent);
          else if (event.channel === "capability") {
            args.onCapabilityEvent?.(event.event as CapabilityEvent);
          } else if (event.channel === "trace_record") {
            const record = (value as { record?: unknown }).record as ExecutionRecord;
            if (record?.id !== runId || record.owner_key_name !== args.owner) {
              throw Object.assign(new Error("runtime trace identity mismatch"), {
                code: "unauthorized",
              });
            }
            await args.deps.traceStore.insert(record);
          } else if ((await options.consumeGuestEvent?.(args, runId, value)) === true) {
            return;
          } else {
            throw Object.assign(new Error("runtime event channel is invalid"), {
              code: "invalid_request",
            });
          }
        },
      }),
    );
    let finished = false;
    const pump = async (): Promise<void> => {
      while (!finished) {
        for (const message of args.steer?.drain() ?? []) {
          await options.session.steer(runId, { kind: "steer", message });
        }
        for (const request of args.compaction?.drain() ?? []) {
          await options.session.steer(runId, { kind: "compact", request });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollIntervalMs);
          timer.unref?.();
        });
      }
    };
    const abort = (): void => {
      void options.session.cancel(runId).catch(() => undefined);
    };
    let pumpTask = Promise.resolve();
    let listeningForAbort = false;
    try {
      const startTask = options.session.startRun(runId, {
        rawBody: args.rawBody,
        owner: args.owner,
        ...options.guestEnvelope?.(args, runId),
      });
      args.externalSignal?.addEventListener("abort", abort, { once: true });
      listeningForAbort = args.externalSignal !== undefined;
      if (args.externalSignal?.aborted === true) abort();
      pumpTask = pump();
      const result = await startTask;
      if (!isOutcome(result) || result.executionId !== runId) {
        throw Object.assign(new Error("guest returned an invalid execution result"), {
          code: "unavailable",
        });
      }
      const checkpoint = await loadRuntimeCheckpoint(
        options.workspaceRoot,
        options.generation,
        runId,
        options.roots,
      );
      if (checkpoint === null || checkpoint.terminal) {
        throw Object.assign(new Error("guest result lacked a valid reconstruction checkpoint"), {
          code: "unavailable",
        });
      }
      await settleRuntimeTerminal({
        workspaceRoot: options.workspaceRoot,
        checkpoint: {
          generation: options.generation,
          runId,
          sequence: checkpoint.sequence + 1,
          terminal: true,
          state: { outcome: result },
        },
        participants: authority.terminalParticipants(),
        ...(options.roots === undefined ? {} : { roots: options.roots }),
      });
      return result;
    } finally {
      finished = true;
      if (listeningForAbort) args.externalSignal?.removeEventListener("abort", abort);
      await pumpTask;
      release();
      authority.model.revoke();
      authority.capabilities.revoke();
      await authority.dispose?.();
    }
  };
}
