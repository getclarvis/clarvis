import type { Elicit, ElicitRawResult } from "@clarvis/loop";
import type { ElicitationRequest, ElicitationResponse } from "@clarvis/protocol";
import type { GuardElicitParams } from "../guard/guard-elicit.ts";
import { kernelError } from "../core/errors.ts";

/**
 * Bridges engine `Elicit` callbacks to protocol elicitation requests/responses for a single run.
 */
export interface ElicitBridge {
  /** The engine-facing {@link Elicit} callback: each call raises a protocol
   * {@link ElicitationRequest} and resolves once the client responds or the
   * request is cancelled. */
  readonly elicit: Elicit;
  /** Registers a handler invoked when the engine requests user input. */
  onElicit(handler: (req: ElicitationRequest) => void): () => void;
  /** Notify once when a previously published question is answered or cancelled. */
  onSettled(handler: (id: string) => void): () => void;
  /** Completes a pending elicit with the client's response. */
  respond(res: ElicitationResponse): void;
  /** Retire the bridge and cancel every outstanding question. */
  close(): void;
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
  const handlers = new Set<(req: ElicitationRequest) => void>();
  const settled = new Set<(id: string) => void>();
  let pendingBytes = 0;
  let closed = false;
  const pending = new Map<
    string,
    {
      request: ElicitationRequest;
      resolve: (result: ElicitRawResult) => void;
      bytes: number;
      cleanup(): void;
    }
  >();

  const deliver = (handler: (req: ElicitationRequest) => void, req: ElicitationRequest): void => {
    try {
      handler(req);
    } catch {
      // A client handler cannot break or settle the engine's pending question.
    }
  };

  const finish = (id: string, result: ElicitRawResult): void => {
    const item = pending.get(id);
    if (item === undefined) return;
    pending.delete(id);
    pendingBytes -= item.bytes;
    item.cleanup();
    for (const handler of settled) {
      try {
        handler(id);
      } catch {
        /* An observer cannot prevent question settlement. */
      }
    }
    item.resolve(result);
  };

  const subscribe = <T>(listeners: Set<T>, handler: T): (() => void) => {
    if (closed) return () => {};
    if (listeners.size >= 16)
      throw kernelError("resource_exhausted", "too many elicitation observers");
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  };

  const enqueue = (
    request: Omit<ElicitationRequest, "id" | "execution_id">,
    signal?: AbortSignal,
  ): Promise<ElicitRawResult> =>
    new Promise<ElicitRawResult>((resolve) => {
      if (closed || signal?.aborted) {
        resolve({ action: "cancel" });
        return;
      }
      const id = `${executionId}:elicit:${seq++}`;
      const req: ElicitationRequest = {
        id,
        execution_id: executionId,
        ...request,
      };
      const bytes = Buffer.byteLength(JSON.stringify(req));
      if (pending.size >= 64 || pendingBytes + bytes > 8 * 1024 * 1024) {
        throw kernelError("resource_exhausted", "pending elicitation budget exhausted");
      }
      const abort = (): void => finish(id, { action: "cancel" });
      pending.set(id, {
        request: req,
        resolve,
        bytes,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      pendingBytes += bytes;
      signal?.addEventListener("abort", abort, { once: true });
      for (const h of handlers) {
        if (!pending.has(id)) break;
        deliver(h, req);
      }
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
    onElicit(handler) {
      const unsubscribe = subscribe(handlers, handler);
      for (const item of pending.values()) deliver(handler, item.request);
      return unsubscribe;
    },
    onSettled: (handler) => subscribe(settled, handler),
    respond(res): void {
      finish(res.id, {
        action: res.action,
        ...(res.content !== undefined ? { content: res.content as Record<string, unknown> } : {}),
      });
    },
    close() {
      closed = true;
      for (const id of pending.keys()) finish(id, { action: "cancel" });
      handlers.clear();
      settled.clear();
    },
  };
}
