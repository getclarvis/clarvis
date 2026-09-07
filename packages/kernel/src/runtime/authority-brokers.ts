import { boundJsonValue } from "../core/bounded-json.ts";

/** Host-owned allowance for one runtime's authenticated model traffic. */
export interface ModelBrokerLease {
  readonly id: string;
  readonly generation: string;
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly destination: URL;
  readonly expiresAt: number;
  readonly maxConcurrent: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

/** Secret-free logical request admitted by the host model broker. */
export interface GuestModelRequest {
  readonly leaseId: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly conversationId?: string;
  readonly body: unknown;
}

/** Host transport that alone receives the fixed destination and credentials. */
export type HostModelExecutor = (
  request: GuestModelRequest,
  authority: { readonly destination: URL; readonly signal: AbortSignal },
) => AsyncIterable<unknown>;

/** Bounded host model result; credentials and policy are never represented. */
export interface HostModelResult {
  readonly events: readonly unknown[];
  readonly outputBytes: number;
}

/** Exact identity supplied by the private execution envelope. */
export interface BrokerIdentity {
  readonly generation: string;
  readonly runId: string;
  readonly callId: string;
}

/** Model broker with host-side expiry, concurrency and byte enforcement. */
export interface ModelBroker {
  execute(
    identity: BrokerIdentity,
    request: GuestModelRequest,
    signal?: AbortSignal,
    onEvent?: (event: unknown) => Promise<void>,
  ): Promise<HostModelResult>;
  revoke(): void;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function brokerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Create a model broker whose authority cannot be widened by request payloads. */
export function createModelBroker(
  lease: ModelBrokerLease,
  execute: HostModelExecutor,
  now: () => number = Date.now,
): ModelBroker {
  let active = 0;
  let revoked = false;
  const liveControllers = new Set<AbortController>();
  return {
    async execute(identity, request, signal, onEvent) {
      if (
        revoked ||
        now() >= lease.expiresAt ||
        identity.generation !== lease.generation ||
        identity.runId !== lease.runId ||
        request.leaseId !== lease.id
      ) {
        throw brokerError("unauthorized", "model lease is not active for this execution");
      }
      if (request.provider !== lease.provider || request.model !== lease.model) {
        throw brokerError("unauthorized", "provider or model is outside the lease");
      }
      if (byteLength(request.body) > lease.maxInputBytes) {
        throw brokerError("resource_exhausted", "model input exceeds the lease bound");
      }
      if (active >= lease.maxConcurrent) {
        throw brokerError("resource_exhausted", "model lease concurrency is exhausted");
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
      liveControllers.add(controller);
      active += 1;
      try {
        controller.signal.throwIfAborted();
        const events: unknown[] = [];
        let outputBytes = 0;
        for await (const event of execute(request, {
          destination: new URL(lease.destination.href),
          signal: controller.signal,
        })) {
          if (revoked || now() >= lease.expiresAt) {
            controller.abort(new Error("model lease revoked"));
            throw brokerError("unauthorized", "model lease expired during execution");
          }
          const bounded = boundJsonValue(event, {
            maxDepth: 16,
            maxNodes: 8_192,
            maxChars: lease.maxOutputBytes,
          });
          if (bounded.truncated) {
            throw brokerError("resource_exhausted", "model event exceeds the lease bound");
          }
          const eventBytes = byteLength(bounded.value);
          if (outputBytes + eventBytes > lease.maxOutputBytes) {
            throw brokerError("resource_exhausted", "model output exceeds the lease bound");
          }
          outputBytes += eventBytes;
          if (
            onEvent !== undefined &&
            (bounded.value as { type?: unknown } | null)?.type === "stream"
          ) {
            await onEvent(bounded.value);
          } else {
            events.push(bounded.value);
          }
        }
        return { events, outputBytes };
      } finally {
        controller.abort(new Error("model broker call closed"));
        signal?.removeEventListener("abort", abort);
        liveControllers.delete(controller);
        active -= 1;
      }
    },
    revoke(): void {
      if (revoked) return;
      revoked = true;
      for (const controller of liveControllers) controller.abort(new Error("model lease revoked"));
      liveControllers.clear();
    },
  };
}

/** One exact host capability admitted to an immutable runtime generation. */
export interface HostCapabilityGrant {
  readonly method: string;
  readonly revision: string;
  readonly idempotent: boolean;
  validateArguments(argumentsValue: unknown): boolean;
  invoke(argumentsValue: unknown, signal: AbortSignal): Promise<unknown>;
}

/** Guest request for one declared host-owned capability. */
export interface GuestCapabilityRequest {
  readonly method: string;
  readonly revision: string;
  readonly arguments: unknown;
}

/** Generation-bound exact-method host capability broker. */
export interface CapabilityBroker {
  invoke(
    identity: BrokerIdentity,
    request: GuestCapabilityRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
  revoke(): void;
}

/** Create a broker that admits only the immutable run envelope's declared methods. */
export function createCapabilityBroker(options: {
  readonly generation: string;
  readonly runId: string;
  readonly grants: readonly HostCapabilityGrant[];
  readonly maxArgumentsBytes: number;
  readonly maxResultBytes: number;
}): CapabilityBroker {
  const grants = new Map<string, HostCapabilityGrant>();
  for (const grant of options.grants) {
    if (grants.has(grant.method)) throw new Error(`duplicate capability grant '${grant.method}'`);
    grants.set(grant.method, grant);
  }
  const calls = new Map<
    string,
    { readonly method: string; readonly result?: unknown; readonly complete: boolean }
  >();
  const live = new Set<AbortController>();
  let revoked = false;
  return {
    async invoke(identity, request, signal) {
      if (
        revoked ||
        identity.generation !== options.generation ||
        identity.runId !== options.runId
      ) {
        throw brokerError("unauthorized", "capability identity is outside this run");
      }
      const grant = grants.get(request.method);
      if (grant === undefined)
        throw brokerError("unauthorized", "capability method is not granted");
      if (request.revision !== grant.revision) {
        throw brokerError("conflict", "capability revision is stale");
      }
      if (
        byteLength(request.arguments) > options.maxArgumentsBytes ||
        !grant.validateArguments(request.arguments)
      ) {
        throw brokerError("invalid_request", "capability arguments were refused");
      }
      const prior = calls.get(identity.callId);
      if (prior !== undefined) {
        if (prior.method !== request.method || !grant.idempotent || !prior.complete) {
          throw brokerError("outcome_unknown", "capability call identity cannot be replayed");
        }
        return prior.result;
      }
      calls.set(identity.callId, { method: request.method, complete: false });
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      live.add(controller);
      try {
        const result = await grant.invoke(request.arguments, controller.signal);
        if (byteLength(result) > options.maxResultBytes) {
          throw brokerError("resource_exhausted", "capability result exceeds the response bound");
        }
        calls.set(identity.callId, { method: request.method, result, complete: true });
        return result;
      } finally {
        signal?.removeEventListener("abort", abort);
        live.delete(controller);
      }
    },
    revoke(): void {
      if (revoked) return;
      revoked = true;
      for (const controller of live) controller.abort(new Error("capability grant revoked"));
      live.clear();
    },
  };
}
