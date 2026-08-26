import { createSignal, type Accessor } from "solid-js";
import type { ElicitRequestParams, ElicitResult } from "./elicit-types.ts";
import { CANCEL_RESULT } from "./elicitation.ts";

/**
 * A single-slot elicitation queue: one pending question the UI renders and
 * resolves at a time.
 */
export interface ElicitSlot {
  request: Accessor<ElicitRequestParams | null>;
  ask(params: ElicitRequestParams): Promise<ElicitResult>;
  resolve(result: ElicitResult): void;
  cancelPending(): void;
}

/**
 * Builds an {@link ElicitSlot}.
 *
 * @remarks A new `ask()` call while one is still pending settles the earlier
 *   one as {@link CANCEL_RESULT} before replacing it — the slot holds at most
 *   one live question.
 */
export function createElicitSlot(): ElicitSlot {
  const [request, setRequest] = createSignal<ElicitRequestParams | null>(null);
  let pending: ((result: ElicitResult) => void) | undefined;

  function resolve(result: ElicitResult): void {
    const settle = pending;
    pending = undefined;
    setRequest(null);
    settle?.(result);
  }

  return {
    request,
    ask: (params) =>
      new Promise<ElicitResult>((res) => {
        pending?.(CANCEL_RESULT);
        pending = res;
        setRequest(params);
      }),
    resolve,
    cancelPending: () => {
      if (pending) resolve(CANCEL_RESULT);
    },
  };
}
