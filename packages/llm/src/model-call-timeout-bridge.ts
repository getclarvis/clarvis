import { ProviderError, type LLMCallParams } from "@clarvis/capability";

const MODEL_CALL_TIMEOUT_BRIDGE = Symbol("clarvis.model-call-timeout-bridge");

/** Internal rendezvous between the adapter that owns the timeout timer and the
 * admission gate that owns the physical-call permit. */
export interface ModelCallTimeoutBridge {
  /** Resolves once, when the adapter's per-call timeout fires. */
  readonly timeout: Promise<ProviderError>;
  /** Publish the timeout and return the error used as the abort reason. */
  markTimedOut(timeoutMs: number): ProviderError;
  /** Register timer cleanup. */
  registerCleanup(cleanup: () => void): () => void;
  /** Release timer/listener resources when the admission boundary exits. */
  cleanup(): void;
}

type BridgedCallParams = LLMCallParams & {
  [MODEL_CALL_TIMEOUT_BRIDGE]?: ModelCallTimeoutBridge;
};

/** Attach one timeout observation channel without changing the public params. */
export function bridgeModelCallTimeout(params: LLMCallParams): {
  params: LLMCallParams;
  bridge: ModelCallTimeoutBridge;
} {
  let resolveTimeout!: (error: ProviderError) => void;
  const timeout = new Promise<ProviderError>((resolve) => {
    resolveTimeout = resolve;
  });
  const cleanups = new Set<() => void>();
  let timeoutError: ProviderError | undefined;
  let cleaned = false;

  const runCleanup = (cleanup: () => void): void => {
    try {
      cleanup();
    } catch {
      // Timer cleanup is housekeeping. It must never replace a provider result.
    }
  };

  const bridge: ModelCallTimeoutBridge = {
    timeout,
    markTimedOut(timeoutMs) {
      if (timeoutError !== undefined) return timeoutError;
      timeoutError = new ProviderError(
        `Model call exceeded the per-call timeout of ${String(timeoutMs)}ms.`,
        { kind: "transient" },
      );
      resolveTimeout(timeoutError);
      return timeoutError;
    },
    registerCleanup(cleanup) {
      if (cleaned) return () => {};
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const cleanup of cleanups) runCleanup(cleanup);
      cleanups.clear();
    },
  };

  const bridged: BridgedCallParams = {
    ...params,
    [MODEL_CALL_TIMEOUT_BRIDGE]: bridge,
  };
  return { params: bridged, bridge };
}

/** Read the internal bridge when admission wrapped this adapter call. */
export function modelCallTimeoutBridgeOf(
  params: LLMCallParams,
): ModelCallTimeoutBridge | undefined {
  return (params as BridgedCallParams)[MODEL_CALL_TIMEOUT_BRIDGE];
}
