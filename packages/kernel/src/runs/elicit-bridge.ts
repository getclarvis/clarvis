import type { Elicit, ElicitRawResult } from "@clarvis/loop";
import type { ElicitationRequest, ElicitationResponse } from "@clarvis/protocol";
import type { GuardElicitParams } from "../guard/guard-elicit.ts";

/**
 * Bridges engine `Elicit` callbacks to protocol elicitation requests/responses for a single run.
 */
export interface ElicitBridge {
  /** The engine-facing {@link Elicit} callback: each call raises a protocol
   * {@link ElicitationRequest} and resolves once the client responds or the
   * request is cancelled. */
  readonly elicit: Elicit;
  /** Registers a handler invoked when the engine requests user input. */
  onElicit(handler: (req: ElicitationRequest) => void): void;
  /** Completes a pending elicit with the client's response. */
  respond(res: ElicitationResponse): void;
}

/**
 * Creates an {@link ElicitBridge} scoped to `executionId`.
 *
 * @param executionId - the run this bridge belongs to; namespaces each pending
 *   request id (`<executionId>:elicit:<n>`).
 * @returns a bridge whose `elicit` the engine calls and whose `onElicit` /
 *   `respond` the client drives.
 * @remarks A late-registered handler is replayed the still-pending requests, so
 *   a client that subscribes after a question was raised still sees it. A
 *   handler that throws cannot break or settle the engine's pending question -
 *   the throw is swallowed. Each pending elicit settles as `cancel` when its
 *   call's abort signal fires; an unknown or already-settled response id is
 *   ignored.
 */
export function createElicitBridge(executionId: string): ElicitBridge {
  let seq = 0;
  const handlers: ((req: ElicitationRequest) => void)[] = [];
  const pending = new Map<
    string,
    { request: ElicitationRequest; resolve: (result: ElicitRawResult) => void }
  >();

  const deliver = (handler: (req: ElicitationRequest) => void, req: ElicitationRequest): void => {
    try {
      handler(req);
    } catch {
      // A client handler cannot break or settle the engine's pending question.
    }
  };

  const enqueue = (
    request: Omit<ElicitationRequest, "id" | "execution_id">,
    signal?: AbortSignal,
  ): Promise<ElicitRawResult> =>
    new Promise<ElicitRawResult>((resolve) => {
      const id = `${executionId}:elicit:${seq++}`;
      const req: ElicitationRequest = {
        id,
        execution_id: executionId,
        ...request,
      };
      pending.set(id, { request: req, resolve });
      for (const h of handlers) deliver(h, req);
      signal?.addEventListener("abort", () => {
        const item = pending.get(id);
        if (item !== undefined) {
          pending.delete(id);
          item.resolve({ action: "cancel" });
        }
      });
    });

  const elicit: Elicit = (params, opts) => {
    const { detail } = params as GuardElicitParams;
    return enqueue(
      {
        kind: params.kind ?? "ask_user",
        prompt: params.message,
        schema: params.requestedSchema as unknown as Record<string, unknown>,
        ...(detail !== undefined ? { detail } : {}),
      },
      opts.signal,
    );
  };

  return {
    elicit,
    onElicit(handler): void {
      handlers.push(handler);
      for (const item of pending.values()) deliver(handler, item.request);
    },
    respond(res): void {
      const item = pending.get(res.id);
      if (item === undefined) return;
      pending.delete(res.id);
      item.resolve({
        action: res.action,
        ...(res.content !== undefined ? { content: res.content as Record<string, unknown> } : {}),
      });
    },
  };
}
