/**
 * Run-scoped operator interrupt of one live tool invocation.
 *
 * @remarks The channel is not model content and never enters the transcript.
 * Delivery is push-based: a blocked shell cannot wait for the next iteration.
 */

/** Internal abort reason for a selective tool interrupt. Not a public tools type. */
export const OPERATOR_INTERRUPTED_TOOL = Object.freeze({
  kind: "operator_interrupted_tool" as const,
});

/** Whether `reason` is the loop-local operator-interrupt marker. */
export function isOperatorInterruptedTool(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { kind?: unknown }).kind === "operator_interrupted_tool"
  );
}

/** Settlement values mirrored by the protocol receipt, without importing protocol. */
export type ToolInterruptSettleStatus = "accepted" | "already_requested" | "not_running";

/** One interrupt request waiting for the live registry to settle it. */
export interface ToolInterruptDelivery {
  readonly toolExecutionId: string;
  settle(status: ToolInterruptSettleStatus): void;
  /** Reject delivery without claiming the invocation is no longer running. */
  fail(error: unknown): void;
}

/** Push source of operator interrupt requests for one execution. */
export interface ToolInterruptSource {
  subscribe(listener: (delivery: ToolInterruptDelivery) => void): () => void;
}

/** Live child-controller registry for interruptible invocations in one run. */
export interface ToolInterruptRegistry {
  register(entry: { toolExecutionId: string; callId: string; controller: AbortController }): void;
  retain(
    toolExecutionId: string,
    continuation: { stop(): Promise<boolean>; completed: Promise<unknown> },
    onReleased: () => void,
  ): void;
  unregister(toolExecutionId: string): void;
  deliver(delivery: ToolInterruptDelivery): void;
  close(): void;
}

/** Create an empty run-local interrupt registry. */
export function createToolInterruptRegistry(): ToolInterruptRegistry {
  const entries = new Map<
    string,
    { controller: AbortController; requested: boolean; stop?: () => Promise<boolean> }
  >();
  let closed = false;
  return {
    register(entry) {
      if (closed) return;
      entries.set(entry.toolExecutionId, { controller: entry.controller, requested: false });
    },
    retain(toolExecutionId, continuation, onReleased) {
      const entry = entries.get(toolExecutionId);
      if (entry !== undefined && !closed) {
        entry.stop = () => continuation.stop();
        void continuation.completed.then(
          () => {
            if (entries.get(toolExecutionId) !== entry) return;
            entries.delete(toolExecutionId);
            if (!closed) onReleased();
          },
          () => {
            if (entries.get(toolExecutionId) !== entry) return;
            entries.delete(toolExecutionId);
            if (!closed) onReleased();
          },
        );
      }
    },
    unregister(toolExecutionId) {
      entries.delete(toolExecutionId);
    },
    deliver(delivery) {
      if (closed) {
        delivery.settle("not_running");
        return;
      }
      const entry = entries.get(delivery.toolExecutionId);
      if (entry === undefined) {
        delivery.settle("not_running");
        return;
      }
      if (entry.requested) {
        delivery.settle("already_requested");
        return;
      }
      entry.requested = true;
      if (entry.stop === undefined) entry.controller.abort(OPERATOR_INTERRUPTED_TOOL);
      else void entry.stop().catch(() => undefined);
      delivery.settle("accepted");
    },
    close() {
      closed = true;
      entries.clear();
    },
  };
}

const NEVER_ABORTED = new AbortController().signal;

/** Run signal when one exists, otherwise a signal that never aborts. */
export function invocationRunSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? NEVER_ABORTED;
}

/**
 * True when the operator interrupted this invocation and the run itself is still live.
 *
 * @remarks Global cancel wins: a aborted run signal is never classified as a
 * selective interrupt, even if the child controller also aborted.
 */
export function wasOperatorInterrupted(runSignal?: AbortSignal, toolSignal?: AbortSignal): boolean {
  if (runSignal?.aborted === true) return false;
  return toolSignal?.aborted === true && isOperatorInterruptedTool(toolSignal.reason);
}
