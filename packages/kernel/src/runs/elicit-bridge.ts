import type { Elicit, ElicitParams, ElicitRawResult } from "@clarvis/loop";
import type {
  ElicitationPresentation,
  ElicitationPresentationAck,
  ElicitationRequest,
  ElicitationResponse,
  ElicitWindowPolicy,
} from "@clarvis/protocol";
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
  /**
   * Confirm a pending question is on screen, starting the run's question window
   * when its policy declares one and the request is the model's own `ask_user`.
   *
   * @param presentation - the question's id and the presenting client's identity.
   * @returns whether the question was still pending, plus the window's remaining
   *   projection when one applies.
   * @remarks Idempotent: only the first valid confirmation starts the single
   *   deadline, and every later confirmation (from any presenter) reports what is
   *   left. A confirmation for an unknown, settled or never-windowed request
   *   changes nothing.
   */
  present(presentation: ElicitationPresentation): ElicitationPresentationAck;
  /** Retire the bridge and cancel every outstanding question. */
  close(): void;
}

/** Cancelable timer owned by the bridge's window scheduler. @internal */
export interface ElicitWindowTimer {
  cancel(): void;
}

/**
 * The longest decision window a run may declare, in milliseconds.
 *
 * @remarks A host scheduler cannot represent a longer delay: a timer above this
 *   ceiling is not honoured for the duration asked for, so a window longer than
 *   it would close a question far earlier than the policy promised — the
 *   opposite of leaving it open. A policy above the ceiling therefore publishes
 *   no window at all, and the question keeps the operational wait bound as the
 *   only way its wait ends.
 */
export const MAX_ELICIT_WINDOW_MS = 2_147_483_647;

/**
 * Monotonic clock and scheduler seam for the question window.
 *
 * @remarks Deliberately not the wall clock: an operator's machine may step its
 *   wall clock (NTP, timezone-independent but still skewed) while a question is
 *   on screen, and a window measured by wall time could then expire early,
 *   expire late, or never. Durations only, so nothing here needs to agree with a
 *   remote frontend's clock — that is why the protocol carries a remaining-time
 *   projection instead of a deadline timestamp.
 *
 * @internal
 */
export interface ElicitWindowRuntime {
  /** Milliseconds from an arbitrary monotonic origin. */
  now(): number;
  /**
   * Run `task` after `delayMs`, returning a cancelable handle.
   *
   * @remarks Never called with a delay above {@link MAX_ELICIT_WINDOW_MS}: the
   *   window is refused where the policy is read, not silently shortened here.
   */
  schedule(task: () => void, delayMs: number): ElicitWindowTimer;
}

/** What a run may configure on its bridge beyond the run id. */
export interface ElicitBridgeOptions {
  /**
   * Host policy for an interactive question window, taken from the run-creation
   * request. Omit it and no question gets a window.
   */
  policy?: ElicitWindowPolicy;
  /**
   * Deterministic clock seam for the window; see {@link ElicitWindowRuntime}.
   *
   * @internal
   */
  runtime?: ElicitWindowRuntime;
}

/**
 * The interactive question window a run-creation request declares, if any.
 *
 * @param params - the validated run-creation parameters.
 * @returns the bridge options for that run, or `undefined` when the caller
 *   declared no policy and every question keeps the operational wait bound.
 * @remarks Read where each run is constructed — an ordinary run, a workflow
 *   manager whose leaders present through its bridge — so the window belongs to
 *   the execution the request asked for rather than to a process-wide default.
 *   A headless caller and the MCP facade never declare one.
 * @internal
 */
export function elicitWindowFor(params: {
  elicit_policy?: ElicitWindowPolicy;
}): ElicitBridgeOptions | undefined {
  return params.elicit_policy === undefined ? undefined : { policy: params.elicit_policy };
}

const DEFAULT_WINDOW_RUNTIME: ElicitWindowRuntime = {
  now: () => performance.now(),
  schedule(task, delayMs) {
    const timer = setTimeout(task, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * The window a request may receive, in milliseconds, or `undefined` for none.
 *
 * @remarks Eligibility is a provenance decision, never a naming one. The
 *   projected `kind` defaults to `ask_user` when a request omits it and travels
 *   verbatim to the UI, so a relayed external request could arrive wearing that
 *   name; the engine marks its own `ask_user` tool's requests `origin: "model"`
 *   and the relay layer marks everything else `"external"`, and only an
 *   explicit model-origin `ask_user` may receive a host window.
 *
 *   The declared duration must also be one this host can actually measure: a
 *   policy that is absent, non-integral, non-positive or longer than
 *   {@link MAX_ELICIT_WINDOW_MS} publishes no window, because a host must never
 *   promise time it cannot grant.
 */
function windowFor(
  policy: ElicitWindowPolicy | undefined,
  params: ElicitParams,
): number | undefined {
  const configured = policy?.ask_user_window_ms;
  if (
    typeof configured !== "number" ||
    !Number.isSafeInteger(configured) ||
    configured <= 0 ||
    configured > MAX_ELICIT_WINDOW_MS
  ) {
    return undefined;
  }
  if (params.origin !== "model" || params.kind !== "ask_user") return undefined;
  return configured;
}

/**
 * Creates an {@link ElicitBridge} scoped to `executionId`.
 *
 * @param executionId - the run this bridge belongs to; namespaces each pending
 *   request id (`<executionId>:elicit:<n>`).
 * @param options - the run's window policy and clock seam; see
 *   {@link ElicitBridgeOptions}.
 * @returns a bridge whose `elicit` the engine calls and whose `onElicit` /
 *   `respond` / `present` the client drives.
 * @remarks A late-registered handler is replayed the still-pending requests, so
 *   a client that subscribes after a question was raised still sees it. A
 *   handler that throws cannot break or settle the engine's pending question -
 *   the throw is swallowed. Each pending elicit settles as `cancel` when its
 *   call's abort signal fires; an unknown or already-settled response id is
 *   ignored. When a window policy applies, the request is published with its
 *   duration and the kernel starts the single deadline only once a client
 *   confirms the question is on screen; reaching that deadline resolves the
 *   question as an unattributed decline carrying `windowElapsed`, so the engine
 *   can tell the host's window from the operational wait bound and from a human
 *   refusal.
 */
export function createElicitBridge(
  executionId: string,
  options: ElicitBridgeOptions = {},
): ElicitBridge {
  const runtime = options.runtime ?? DEFAULT_WINDOW_RUNTIME;
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
      /** Duration of the question's window, when the request may receive one. */
      windowMs?: number;
      /** Absolute monotonic deadline; set by the first valid presentation. */
      deadline?: number;
      timer?: ElicitWindowTimer;
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
    item.timer?.cancel();
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
    windowMs?: number,
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
        ...(windowMs !== undefined ? { window_ms: windowMs } : {}),
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
        ...(windowMs === undefined ? {} : { windowMs }),
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
      windowFor(options.policy, params),
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
    present(presentation): ElicitationPresentationAck {
      const item = pending.get(presentation.id);
      if (item === undefined) return { accepted: false };
      if (item.windowMs === undefined) return { accepted: true };
      if (item.deadline === undefined) {
        item.deadline = runtime.now() + item.windowMs;
        item.timer = runtime.schedule(
          () => finish(item.request.id, { action: "decline", windowElapsed: true }),
          item.windowMs,
        );
      }
      const remaining = item.deadline - runtime.now();
      return { accepted: true, remaining_ms: Math.max(0, Math.ceil(remaining)) };
    },
    close() {
      closed = true;
      for (const id of pending.keys()) finish(id, { action: "cancel" });
      handlers.clear();
      settled.clear();
    },
  };
}
