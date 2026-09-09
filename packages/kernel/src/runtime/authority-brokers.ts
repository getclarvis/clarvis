import { createHash } from "node:crypto";
import { boundJsonValue } from "../core/bounded-json.ts";
import { createSemaphore } from "@clarvis/capability";

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
  /** Bounded FIFO waiting allowance, independent of container CPU resources. */
  readonly maxQueued?: number;
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
  const permits = createSemaphore(lease.maxConcurrent);
  let admitted = 0;
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
      signal?.throwIfAborted();
      if (admitted >= lease.maxConcurrent + (lease.maxQueued ?? 0)) {
        throw brokerError("resource_exhausted", "model lease queue is full");
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
      liveControllers.add(controller);
      admitted += 1;
      let acquired = false;
      try {
        await permits.acquire(controller.signal);
        acquired = true;
        controller.signal.throwIfAborted();
        if (now() >= lease.expiresAt) {
          throw brokerError("unauthorized", "model lease expired while queued");
        }
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
        admitted -= 1;
        if (acquired) permits.release();
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
  /** Releases bounded run-owned transfer state when the grant is revoked. */
  revoke?(): void;
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
  /** Maximum distinct attempted calls retained for replay fencing during one run. */
  readonly maxCalls?: number;
  /** Aggregate byte allowance for completed replay results and in-flight reservations. */
  readonly maxRetainedResultBytes?: number;
}): CapabilityBroker {
  const maxCalls = options.maxCalls ?? 16_384;
  const maxRetainedResultBytes = options.maxRetainedResultBytes ?? 8 * 1024 * 1024;
  for (const limit of [
    maxCalls,
    maxRetainedResultBytes,
    options.maxArgumentsBytes,
    options.maxResultBytes,
  ]) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("capability broker limits must be positive safe integers");
  }
  const grants = new Map<string, HostCapabilityGrant>();
  for (const grant of options.grants) {
    if (grants.has(grant.method)) throw new Error(`duplicate capability grant '${grant.method}'`);
    grants.set(grant.method, grant);
  }
  const calls = new Map<
    string,
    {
      readonly method: string;
      readonly fingerprint: string;
      readonly result?: unknown;
      readonly complete: boolean;
    }
  >();
  const live = new Set<AbortController>();
  let revoked = false;
  let retainedResultBytes = 0;
  let reservedResultBytes = 0;
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
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([request.revision, request.arguments]))
        .digest("hex");
      if (prior !== undefined) {
        if (
          prior.method !== request.method ||
          prior.fingerprint !== fingerprint ||
          !grant.idempotent ||
          !prior.complete
        ) {
          throw brokerError("outcome_unknown", "capability call identity cannot be replayed");
        }
        return prior.result;
      }
      signal?.throwIfAborted();
      const reservation = grant.idempotent ? options.maxResultBytes : 0;
      if (
        calls.size >= maxCalls ||
        retainedResultBytes + reservedResultBytes + reservation > maxRetainedResultBytes
      ) {
        throw brokerError("resource_exhausted", "capability replay history bound exceeded");
      }
      calls.set(identity.callId, { method: request.method, fingerprint, complete: false });
      reservedResultBytes += reservation;
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      live.add(controller);
      try {
        const result = await grant.invoke(request.arguments, controller.signal);
        const resultBytes = byteLength(result);
        if (resultBytes > options.maxResultBytes) {
          throw brokerError("resource_exhausted", "capability result exceeds the response bound");
        }
        if (!revoked) {
          if (grant.idempotent) retainedResultBytes += resultBytes;
          calls.set(identity.callId, {
            method: request.method,
            fingerprint,
            complete: true,
            ...(grant.idempotent ? { result } : {}),
          });
        }
        return result;
      } finally {
        reservedResultBytes -= reservation;
        signal?.removeEventListener("abort", abort);
        live.delete(controller);
      }
    },
    revoke(): void {
      if (revoked) return;
      revoked = true;
      for (const controller of live) controller.abort(new Error("capability grant revoked"));
      live.clear();
      calls.clear();
      retainedResultBytes = 0;
      for (const grant of grants.values()) grant.revoke?.();
    },
  };
}
