import type {
  ElicitationRequest,
  ElicitationResponse,
  Message,
  RunEvent,
  RunHandle,
  RunResult,
  StartRunParams,
} from "@clarvis/protocol";
import type { RunHost } from "../../src/host/run-host.ts";

/** What a scripted run emits and returns. */
export interface ScriptedRun {
  events?: RunEvent[];
  /** Questions raised once the handle is live, in order. */
  elicits?: Omit<ElicitationRequest, "execution_id">[];
  result?: Partial<RunResult>;
  /** Keeps `done` pending so control tools can land mid-run. */
  holdUntil?: Promise<void>;
}

/** A fake host plus the calls it recorded. */
export interface FakeRunHost extends RunHost {
  started: StartRunParams[];
  steers: unknown[];
  cancels: string[];
  responses: ElicitationResponse[];
  /** Deterministic lifecycle barrier replacing sleeps in callers. */
  waitForStart(executionId: string): Promise<StartRunParams>;
  /** Resolves once every scripted run has settled. */
  settled(): Promise<void>;
}

/** Await `promise` until it settles or the owning run is cancelled. */
async function untilReleased(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Build a scripted {@link RunHost}.
 *
 * @param script - decides what each start emits and returns.
 * @returns the host and its call log.
 * @remarks Because `RunHost` is only `runs.start`, this needs no engine, no mock
 *   LLM and no network — which is what keeps the package's devDependencies empty.
 *   It reproduces the real handle's semantics that the facade depends on:
 *   `onElicit` replays already-pending questions to a late subscriber, `respond`
 *   settles them, and `events` is a one-shot async iterable.
 */
export function createFakeRunHost(script: (params: StartRunParams) => ScriptedRun): FakeRunHost {
  const started: StartRunParams[] = [];
  const steers: unknown[] = [];
  const cancels: string[] = [];
  const responses: ElicitationResponse[] = [];
  const running: Promise<unknown>[] = [];
  const startWaiters = new Map<string, ((params: StartRunParams) => void)[]>();
  const readyStarts = new Map<string, StartRunParams>();
  let counter = 0;

  return {
    started,
    steers,
    cancels,
    responses,
    waitForStart(executionId): Promise<StartRunParams> {
      const existing = readyStarts.get(executionId);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => {
        startWaiters.set(executionId, [...(startWaiters.get(executionId) ?? []), resolve]);
      });
    },
    settled: async () => {
      await Promise.allSettled(running);
    },
    runs: {
      start(params: StartRunParams): Promise<RunHandle> {
        started.push(params);
        const spec = script(params);
        const executionId = params.execution_id ?? `run-${(counter += 1)}`;
        queueMicrotask(() =>
          queueMicrotask(() => {
            readyStarts.set(executionId, params);
            for (const resolve of startWaiters.get(executionId) ?? []) resolve(params);
            startWaiters.delete(executionId);
          }),
        );

        const queue: RunEvent[] = [...(spec.events ?? [])];
        let closed = false;
        let wake: (() => void) | undefined;
        const signal = (): void => {
          const w = wake;
          wake = undefined;
          w?.();
        };

        const handlers: ((r: ElicitationRequest) => void)[] = [];
        const pending = new Map<
          string,
          { request: ElicitationRequest; resolve: (r: ElicitationResponse) => void }
        >();
        const abort = new AbortController();

        const raise = (
          req: Omit<ElicitationRequest, "execution_id">,
        ): Promise<ElicitationResponse> =>
          new Promise((resolve) => {
            const request: ElicitationRequest = { ...req, execution_id: executionId };
            const onAbort = (): void => {
              if (pending.delete(request.id)) resolve({ id: request.id, action: "cancel" });
            };
            const settle = (response: ElicitationResponse): void => {
              abort.signal.removeEventListener("abort", onAbort);
              resolve(response);
            };
            pending.set(request.id, { request, resolve: settle });
            for (const h of handlers) h(request);
            abort.signal.addEventListener("abort", onAbort, { once: true });
          });

        const done = (async (): Promise<RunResult> => {
          for (const req of spec.elicits ?? []) await raise(req);
          if (spec.holdUntil !== undefined) await untilReleased(spec.holdUntil, abort.signal);
          queue.push({ type: "run_ended", at: Date.now(), status: "completed" });
          closed = true;
          signal();
          return {
            execution_id: executionId,
            status: abort.signal.aborted ? "cancelled" : "completed",
            result: "done",
            ...spec.result,
          };
        })();
        running.push(done.catch(() => undefined));

        async function* events(): AsyncGenerator<RunEvent> {
          for (;;) {
            if (queue.length > 0) {
              yield queue.shift() as RunEvent;
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }

        const handle: RunHandle = {
          execution_id: executionId,
          events: { [Symbol.asyncIterator]: () => events() },
          steer(message: Message | string): Promise<void> {
            steers.push(message);
            return Promise.resolve();
          },
          compact(): Promise<void> {
            return Promise.resolve();
          },
          cancel(): Promise<void> {
            cancels.push(executionId);
            abort.abort();
            return Promise.resolve();
          },
          respond(response: ElicitationResponse): Promise<void> {
            responses.push(response);
            const entry = pending.get(response.id);
            if (entry !== undefined) {
              pending.delete(response.id);
              entry.resolve(response);
            }
            return Promise.resolve();
          },
          onElicit(handler): void {
            handlers.push(handler);
            for (const { request } of pending.values()) handler(request);
          },
          done,
          closed: done.then(() => undefined),
        };
        return Promise.resolve(handle);
      },
    },
  };
}
