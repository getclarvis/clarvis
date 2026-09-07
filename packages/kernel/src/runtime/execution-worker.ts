import type { Readable, Writable } from "node:stream";
import { createExecutionPeer, type ExecutionPeer } from "./execution-rpc.ts";
import type {
  GuestCapabilityRequest,
  GuestModelRequest,
  HostModelResult,
} from "./authority-brokers.ts";
import type { RuntimeCheckpointInput } from "./runtime-checkpoints.ts";
import { RUNTIME_PROTOCOL_REVISION } from "./protocol-revision.ts";

/** Narrow host authority visible to guest execution code. */
export interface GuestExecutionBridge {
  model(
    callId: string,
    request: GuestModelRequest,
    signal?: AbortSignal,
    onEvent?: (event: unknown) => void,
  ): Promise<HostModelResult>;
  capability(
    callId: string,
    request: GuestCapabilityRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
  event(event: unknown): Promise<void>;
  checkpoint(input: Omit<RuntimeCheckpointInput, "generation" | "runId">): Promise<void>;
}

/** Guest-owned execution implementation assembled around the loop and local tools. */
export interface GuestRunExecutor {
  execute(
    runId: string,
    envelope: unknown,
    bridge: GuestExecutionBridge,
    signal: AbortSignal,
  ): Promise<unknown>;
  steer?(runId: string, input: unknown, signal: AbortSignal): Promise<void>;
}

/** Serve the disposable worker over attached stdin/stdout without exposing a public kernel. */
export function serveExecutionWorker(options: {
  readonly generation: string;
  readonly imageDigest: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly executor: GuestRunExecutor;
}): ExecutionPeer {
  const runs = new Map<string, AbortController>();
  let bootstrapped = false;
  const peer: ExecutionPeer = createExecutionPeer({
    role: "guest",
    generation: options.generation,
    input: options.input,
    output: options.output,
    handlers: {
      "runtime.bootstrap": async ({ payload }) => {
        const request = payload as {
          generation?: unknown;
          imageDigest?: unknown;
          runtimeProtocolRevision?: unknown;
        };
        if (
          request?.generation !== options.generation ||
          request?.imageDigest !== options.imageDigest ||
          request?.runtimeProtocolRevision !== RUNTIME_PROTOCOL_REVISION
        ) {
          throw Object.assign(new Error("bootstrap identity mismatch"), {
            code: "handshake_mismatch",
          });
        }
        bootstrapped = true;
        return {
          generation: options.generation,
          imageDigest: options.imageDigest,
          runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
        };
      },
      "runtime.start": async ({ runId, payload, signal }) => {
        if (!bootstrapped || runId === undefined || runs.has(runId)) {
          throw Object.assign(new Error("run cannot start"), { code: "conflict" });
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        runs.set(runId, controller);
        const bridge: GuestExecutionBridge = {
          model: (callId, request, requestSignal, onEvent) =>
            peer.request("host.model", { generation: options.generation, runId, callId }, request, {
              ...(requestSignal === undefined ? {} : { signal: requestSignal }),
              ...(onEvent === undefined ? {} : { onEvent }),
            }),
          capability: (callId, request, requestSignal) =>
            peer.request(
              "host.capability",
              { generation: options.generation, runId, callId },
              request,
              requestSignal === undefined ? undefined : { signal: requestSignal },
            ),
          async event(event) {
            await peer.request("host.event", { generation: options.generation, runId }, event);
          },
          async checkpoint(input) {
            await peer.request("host.checkpoint", { generation: options.generation, runId }, input);
          },
        };
        try {
          return await options.executor.execute(runId, payload, bridge, controller.signal);
        } finally {
          signal.removeEventListener("abort", abort);
          runs.delete(runId);
        }
      },
      "runtime.steer": async ({ runId, payload, signal }) => {
        if (runId === undefined || !runs.has(runId) || options.executor.steer === undefined) {
          throw Object.assign(new Error("run cannot be steered"), { code: "not_found" });
        }
        await options.executor.steer(runId, payload, signal);
      },
      "runtime.cancel": async ({ runId }) => {
        if (runId === undefined)
          throw Object.assign(new Error("run is required"), { code: "invalid_request" });
        runs.get(runId)?.abort(new Error("run cancelled by host"));
      },
      "runtime.shutdown": async () => {
        for (const controller of runs.values())
          controller.abort(new Error("runtime shutting down"));
        runs.clear();
      },
    },
  });
  return peer;
}
