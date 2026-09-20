import { createSignal, type Accessor } from "solid-js";
import type { ElicitPresenter, ElicitRequestParams, ElicitResult } from "./elicit-types.ts";
import { CANCEL_RESULT } from "./elicitation.ts";

export type { ElicitPresenter };

/**
 * A single-slot elicitation queue: one pending question the UI renders and
 * resolves at a time.
 */
export interface ElicitSlot {
  request: Accessor<ElicitRequestParams | null>;
  /**
   * Milliseconds left in the presented question's decision window, or `null`
   * while no window is running.
   *
   * @remarks Derived from the kernel's projection at the moment of
   *   presentation, so a slow render shortens the countdown instead of
   *   restarting it. This signal drives the block's countdown line only; the
   *   kernel remains the authority on when the window actually ends.
   */
  remaining: Accessor<number | null>;
  ask(params: ElicitRequestParams, present?: ElicitPresenter): Promise<ElicitResult>;
  /**
   * Confirm the pending question is on screen, once.
   *
   * @remarks Called from the UI's visibility seam — after the block is laid
   *   out and actually inside the viewport, not when the notification arrives.
   *   Repeated calls for the same question are ignored here, and the kernel
   *   treats a duplicate confirmation as idempotent anyway.
   */
  present(): void;
  resolve(result: ElicitResult): void;
  /**
   * Close the presented question because the kernel itself retired it.
   *
   * @param id - the kernel's identity for that question.
   * @remarks The kernel owns expiry and answers: when a question is answered
   *   elsewhere, expires with its decision window, or its run is torn down, it
   *   reports the settlement by id. Settling here removes the prompt and
   *   resolves the waiting `ask` with the `settled` marker, so the run client
   *   closes the question without answering an id the kernel has already
   *   retired. A different pending question — or none at all — is left alone.
   */
  settle(id: string): void;
  cancelPending(): void;
}

/** Wall clock and ticker seam for the visual countdown. */
export interface ElicitSlotRuntime {
  /** Wall-clock milliseconds; display only, never the window's authority. */
  now(): number;
  /** Repeating ticker; returns its cancel function. */
  every(ms: number, tick: () => void): () => void;
}

/** Countdown cadence: one update per second, which is all the copy shows. */
const COUNTDOWN_TICK_MS = 1000;

const DEFAULT_SLOT_RUNTIME: ElicitSlotRuntime = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const handle = setInterval(tick, ms);
    return () => clearInterval(handle);
  },
};

/**
 * Builds an {@link ElicitSlot}.
 *
 * @param runtime - clock/ticker seam; the default is the process clock.
 * @remarks A new `ask()` call while one is still pending settles the earlier
 *   one as {@link CANCEL_RESULT} before replacing it — the slot holds at most
 *   one live question. Only two paths settle a live question: the human's
 *   `resolve()`, and `settle()` for a question the kernel retired by itself.
 *   The kernel is the authority on both the answer and the expiry; the slot
 *   records which one happened and never invents either.
 */
export function createElicitSlot(runtime: ElicitSlotRuntime = DEFAULT_SLOT_RUNTIME): ElicitSlot {
  const [request, setRequest] = createSignal<ElicitRequestParams | null>(null);
  const [remaining, setRemaining] = createSignal<number | null>(null);
  let pending: ((result: ElicitResult) => void) | undefined;
  let presenter: ElicitPresenter | undefined;
  let presented = false;
  let deadline: number | undefined;
  let stopTicker: (() => void) | undefined;

  function stopCountdown(): void {
    stopTicker?.();
    stopTicker = undefined;
  }

  function project(): void {
    if (deadline === undefined) {
      setRemaining(null);
      return;
    }
    const left = Math.max(0, deadline - runtime.now());
    setRemaining(left);
    if (left === 0) stopCountdown();
  }

  function resolve(result: ElicitResult): void {
    const settle = pending;
    pending = undefined;
    presenter = undefined;
    deadline = undefined;
    stopCountdown();
    setRemaining(null);
    setRequest(null);
    settle?.(result);
  }

  return {
    request,
    remaining,
    ask: (params, presentation) =>
      new Promise<ElicitResult>((res) => {
        pending?.(CANCEL_RESULT);
        pending = res;
        presenter = presentation;
        presented = false;
        deadline = undefined;
        stopCountdown();
        setRemaining(null);
        setRequest(params);
      }),
    present: () => {
      if (presented || presenter === undefined) return;
      presented = true;
      const projection = presenter;
      void projection()
        .then((remainingMs) => {
          if (pending === undefined || presenter !== projection) return;
          if (remainingMs === undefined) return;
          deadline = runtime.now() + remainingMs;
          project();
          if (remainingMs > 0) stopTicker = runtime.every(COUNTDOWN_TICK_MS, project);
        })
        .catch(() => undefined);
    },
    resolve,
    settle: (id) => {
      if (pending === undefined || request()?.id !== id) return;
      resolve({ action: "decline", settled: true });
    },
    cancelPending: () => {
      if (pending) resolve(CANCEL_RESULT);
    },
  };
}
