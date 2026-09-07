import type { RootOptions } from "@clarvis/paths";
import type { ExecutionRequestHandler, GuestExecutionMethod } from "./execution-rpc.ts";
import type {
  CapabilityBroker,
  GuestCapabilityRequest,
  GuestModelRequest,
  ModelBroker,
} from "./authority-brokers.ts";
import {
  appendRuntimeCheckpoint,
  settleRuntimeTerminal,
  type RuntimeCheckpointInput,
  type RuntimeSettlementParticipant,
} from "./runtime-checkpoints.ts";

/** Host persistence and authority dependencies for one admitted guest run. */
export interface RuntimeHostBridgeOptions {
  readonly workspaceRoot: string;
  readonly generation: string;
  readonly runId: string;
  readonly model: ModelBroker;
  readonly capabilities: CapabilityBroker;
  readonly appendEvent: (event: unknown) => Promise<void>;
  readonly terminalParticipants: () => readonly RuntimeSettlementParticipant[];
  readonly roots?: RootOptions;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("runtime payload must be an object"), {
      code: "invalid_request",
    });
  }
  return value as Record<string, unknown>;
}

/** Bind private guest RPC handlers to one exact generation and run. */
export function createRuntimeHostHandlers(
  options: RuntimeHostBridgeOptions,
): Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>> {
  const identity = (request: Parameters<ExecutionRequestHandler>[0]) => {
    if (
      request.generation !== options.generation ||
      request.runId !== options.runId ||
      request.callId === undefined
    ) {
      throw Object.assign(new Error("runtime authority identity mismatch"), {
        code: "unauthorized",
      });
    }
    return {
      generation: request.generation,
      runId: request.runId,
      callId: request.callId,
    };
  };
  return {
    "host.model": (request) =>
      options.model.execute(
        identity(request),
        payloadRecord(request.payload) as unknown as GuestModelRequest,
        request.signal,
        request.emit,
      ),
    "host.capability": (request) =>
      options.capabilities.invoke(
        identity(request),
        payloadRecord(request.payload) as unknown as GuestCapabilityRequest,
        request.signal,
      ),
    "host.event": async (request) => {
      if (request.generation !== options.generation || request.runId !== options.runId) {
        throw Object.assign(new Error("runtime event identity mismatch"), { code: "unauthorized" });
      }
      await options.appendEvent(request.payload);
      return { accepted: true };
    },
    "host.checkpoint": async (request) => {
      if (request.generation !== options.generation || request.runId !== options.runId) {
        throw Object.assign(new Error("runtime checkpoint identity mismatch"), {
          code: "unauthorized",
        });
      }
      const payload = payloadRecord(request.payload);
      const checkpoint: RuntimeCheckpointInput = {
        generation: options.generation,
        runId: options.runId,
        sequence: payload.sequence as number,
        terminal: payload.terminal as boolean,
        state: payload.state,
      };
      const accepted = checkpoint.terminal
        ? await settleRuntimeTerminal({
            workspaceRoot: options.workspaceRoot,
            checkpoint: { ...checkpoint, terminal: true },
            participants: options.terminalParticipants(),
            ...(options.roots === undefined ? {} : { roots: options.roots }),
          })
        : await appendRuntimeCheckpoint(options.workspaceRoot, checkpoint, options.roots);
      return { acceptedSequence: accepted.sequence, terminal: accepted.terminal };
    },
  };
}
