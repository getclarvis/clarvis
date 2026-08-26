import type { KernelTransport } from "@clarvis/protocol";
import { detachObserved, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { observationSink } from "../core/observed.ts";
import type { KernelServer } from "./server.ts";

/**
 * Build an in-process {@link KernelTransport} bound directly to a
 * {@link KernelServer}, with no serialization on the wire.
 *
 * @param server - the server to connect this transport to; a single
 *   {@link KernelConnection} is opened for the transport's lifetime.
 * @returns a {@link KernelTransport} that dispatches straight into the server
 *   connection — the swap-in used to run the same client against the same kernel
 *   with no network in between.
 * @remarks Every payload crossing the seam (request params, results, and pushed
 *   notifications) is deep-cloned via `JSON.parse(JSON.stringify(...))`, so
 *   neither side can hold a mutable reference into the other's state — matching the
 *   isolation a real transport would give for free. `notify` is fire-and-forget:
 *   the dispatched call's result is discarded. `close` is idempotent and fans out
 *   to every `onClose` listener.
 */
export function createLoopbackTransport(
  server: KernelServer,
  logger: Logger = NOOP_LOGGER,
): KernelTransport {
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

  const handlers = new Map<string, ((params: unknown) => void)[]>();
  const closeHandlers = new Set<(reason?: unknown) => void>();
  let closed = false;
  const terminate = (reason?: unknown): void => {
    if (closed) return;
    closed = true;
    conn.close();
    for (const handler of closeHandlers) handler(reason);
    closeHandlers.clear();
  };
  const conn = server.connect((method, params) => {
    const cloned = clone(params);
    for (const h of handlers.get(method) ?? []) h(cloned);
  }, terminate);

  return {
    async request<T = unknown>(
      method: string,
      params?: unknown,
      options?: Parameters<KernelTransport["request"]>[2],
    ): Promise<T> {
      const result = await conn.handle(
        method,
        clone(params),
        options?.signal as AbortSignal | undefined,
      );
      return clone(result) as T;
    },
    notify(method: string, params?: unknown): void {
      detachObserved(() => conn.handle(method, clone(params)), {
        operation: `kernel_loopback_notify:${method}`,
        logger: observationSink(logger, "transport.notify_failed"),
      });
    },
    onNotification(method: string, handler: (params: unknown) => void): () => void {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
      return () =>
        handlers.set(
          method,
          (handlers.get(method) ?? []).filter((h) => h !== handler),
        );
    },
    onClose(handler: (reason?: unknown) => void): () => void {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    async close(): Promise<void> {
      terminate();
    },
  };
}
