/**
 * The elicitation multiplexer — the one piece of new plumbing a workflow needs
 * beyond the loop's per-run machinery.
 *
 * Elicitation is per-run in the loop: each run already serializes its own prompts
 * FIFO. But a workflow runs several leaders concurrently, so without a tree-wide
 * gate two leaders could prompt the user at the same moment. {@link createElicitMux}
 * wraps the host's real {@link Elicit} in a single external FIFO shared by the
 * manager and every leader, so at most one prompt is presented across the whole
 * tree at a time; response routing stays safe because the underlying transport
 * already keys replies by request id.
 */
import type { Elicit, ElicitRawResult, Logger } from "@clarvis/capability";
import { NOOP_LOGGER } from "@clarvis/capability";
import { createElicitSerializer } from "@clarvis/loop/workflows";

/**
 * The multiplexed elicit channels for a workflow: `manager` for the manager run,
 * and a per-leader channel from {@link ElicitMux.forLeader} that tags each prompt
 * with its origin leader so a UI can label "leader X asks…".
 */
export interface ElicitMux {
  manager: Elicit;
  forLeader(runId: string): Elicit;
}

/** What a host may wire into {@link createElicitMux} beyond the transport. */
export interface ElicitMuxOptions {
  /**
   * Operator diagnostics for the tree-wide queue.
   *
   * @remarks Optional rather than defaulted because the sole production caller
   * — the kernel's workflow service — may itself have been built without one.
   * It is resolved to {@link NOOP_LOGGER} once, so no call site branches.
   */
  logger?: Logger;
}

/**
 * Wrap a host {@link Elicit} in a tree-wide FIFO so concurrent leaders' prompts are
 * presented one at a time.
 *
 * @param user - the host's real elicit transport (already per-run serialized).
 * @param options - see {@link ElicitMuxOptions}.
 * @returns an {@link ElicitMux} whose `manager` and `forLeader(runId)` channels all
 *   drain through one shared queue.
 * @remarks A queued prompt whose `signal` aborts is settled **immediately** as a
 *   `cancel`, and is skipped rather than presented when its turn comes. Waiting
 *   for it to reach the front of the queue was tolerable while a stopped leader
 *   still blocked its manager anyway; under background spawn it is not, because
 *   `agent_stop` on a child parked behind someone else's prompt would free
 *   neither its registry slot nor its semaphore permit until an unrelated human
 *   answered an unrelated question. Skipping also stops an orphaned prompt from
 *   surfacing to the human minutes after the agent that asked it was killed.
 */
export function createElicitMux(user: Elicit, options: ElicitMuxOptions = {}): ElicitMux {
  const logger = options.logger ?? NOOP_LOGGER;
  const serialize = createElicitSerializer();
  const cancelled: ElicitRawResult = { action: "cancel" };
  let depth = 0;
  const skipped = (fields: Record<string, unknown>, waitedMs: number): void => {
    logger.warn(
      { event: "workflow.elicit_skipped", ...fields, queue_depth: depth, waited_ms: waitedMs },
      "a queued prompt was abandoned because the agent that asked it was stopped; the human is never shown it",
    );
  };
  const channel =
    (kind: "manager" | "leader", runId?: string, tag?: string): Elicit =>
    (params, opts) => {
      const signal = opts.signal;
      const fields =
        runId === undefined ? { kind } : { kind, leader_run_id: runId, agent_id: runId };
      if (signal?.aborted === true) {
        skipped(fields, 0);
        return Promise.resolve(cancelled);
      }
      depth += 1;
      const enqueuedAt = Date.now();
      logger.debug(
        { event: "workflow.elicit_queued", ...fields, queue_depth: depth },
        "a prompt joined the tree-wide elicitation queue; only one leader may face the human at a time",
      );
      const queued = serialize(() => {
        const waitedMs = Date.now() - enqueuedAt;
        depth -= 1;
        if (signal?.aborted === true) {
          skipped(fields, waitedMs);
          return Promise.resolve(cancelled);
        }
        return user(
          tag === undefined ? params : { ...params, message: `${tag} ${params.message}` },
          opts,
        );
      });
      if (signal === undefined) return queued;
      return new Promise<ElicitRawResult>((resolve, reject) => {
        const onAbort = (): void => {
          resolve(cancelled);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void queued.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err: unknown) => {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) resolve(cancelled);
            else reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    };
  return {
    manager: channel("manager"),
    forLeader: (runId: string): Elicit => channel("leader", runId, `[leader ${runId.slice(0, 8)}]`),
  };
}
