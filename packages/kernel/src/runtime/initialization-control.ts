import type { ContainerControl } from "./types.ts";

/**
 * Bind engine acquisition commands to generation cancellation while preserving each operation's
 * own signal and byte/time bounds. Keep the original control for teardown after cancellation.
 */
export function initializationControl(
  control: ContainerControl,
  signal?: AbortSignal,
): ContainerControl {
  if (signal === undefined) return control;
  return {
    async run(args, requestSignal, options) {
      signal.throwIfAborted();
      return control.run(
        args,
        requestSignal === undefined ? signal : AbortSignal.any([signal, requestSignal]),
        options,
      );
    },
    attach(args) {
      signal.throwIfAborted();
      return control.attach(args);
    },
  };
}
