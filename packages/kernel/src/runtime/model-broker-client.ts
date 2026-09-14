import { randomUUID } from "node:crypto";
import type { LLMCallParams, LLMProvider } from "@clarvis/capability";
import type { KernelTransport } from "@clarvis/protocol";
import {
  assertModelJson,
  containerModelDeltaSchema,
  containerModelTerminalSchema,
  MODEL_INPUT_BYTES,
  modelBrokerError,
  modelCallInput,
  nativeModelResult,
  type ContainerModelCall,
} from "../hosting/container-model-contract.ts";
import { decodeRuntimeProviderError, runtimeProviderErrorSchema } from "./provider-error.ts";

/** Compatibility seam for tests and embedders that already own an execution-local context. */
export interface ContainerModelContextPort {
  current(): Pick<ContainerModelCall, "runId" | "sessionId" | "agentInstanceId" | "purpose">;
}

/** Adapt an existing model-channel transport; the client never constructs SDKs or retries calls. */
export function createContainerModelProvider(options: {
  transport: KernelTransport;
  leaseId: string;
  generation: string;
  context?: ContainerModelContextPort;
}): LLMProvider {
  const pending = new Map<string, { params: LLMCallParams; sequence: number }>();
  let invalid = false;
  const fail = (): void => {
    invalid = true;
    void options.transport.close().catch(() => undefined);
  };
  options.transport.onNotification("model.delta", (value) => {
    try {
      assertModelJson(value, MODEL_INPUT_BYTES);
      const parsed = containerModelDeltaSchema.safeParse(value);
      if (!parsed.success) {
        fail();
        return;
      }
      const delta = parsed.data;
      const call = pending.get(delta.callId);
      if (call === undefined || delta.sequence !== call.sequence + 1) {
        fail();
        return;
      }
      call.sequence = delta.sequence;
      const event = delta.event;
      if (event.type === "stream") call.params.onStreamDelta?.(event.delta);
      else if (event.type === "tool_input") call.params.onToolInputDelta?.(event.delta);
      else call.params.onRetry?.(event.info);
    } catch {
      fail();
    }
  });
  options.transport.onClose?.(() => {
    invalid = true;
    pending.clear();
  });
  return {
    async call(params) {
      if (invalid) throw modelBrokerError("unavailable");
      const context = options.context?.current();
      const executionId = params.executionId ?? context?.runId;
      if (executionId === undefined) throw modelBrokerError("invalid_request");
      const callId = randomUUID();
      const request: ContainerModelCall = {
        leaseId: options.leaseId,
        generation: options.generation,
        callId,
        runId: executionId,
        purpose: params.callPurpose ?? context?.purpose ?? "generation",
        provider: params.provider,
        model: params.model,
        input: modelCallInput(params),
      };
      const sessionId = params.sessionId ?? context?.sessionId;
      const agentInstanceId = params.agentInstanceId ?? context?.agentInstanceId;
      if (sessionId !== undefined) request.sessionId = sessionId;
      if (agentInstanceId !== undefined) request.agentInstanceId = agentInstanceId;
      const state = { params, sequence: 0 };
      pending.set(callId, state);
      try {
        const value = await options.transport.request("model.call", request, {
          signal: params.signal,
        });
        assertModelJson(value, MODEL_INPUT_BYTES);
        const parsed = containerModelTerminalSchema.safeParse(value);
        if (
          invalid ||
          !parsed.success ||
          parsed.data.callId !== callId ||
          parsed.data.lastSequence !== state.sequence
        ) {
          fail();
          throw modelBrokerError("unavailable", true);
        }
        return nativeModelResult(parsed.data.result);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "details" in error &&
          typeof error.details === "object" &&
          error.details !== null &&
          "provider" in error.details
        ) {
          const provider = runtimeProviderErrorSchema.safeParse(error.details.provider);
          if (provider.success)
            throw decodeRuntimeProviderError(
              error instanceof Error ? error.message : "Model provider failed",
              provider.data,
            );
        }
        throw error;
      } finally {
        pending.delete(callId);
      }
    },
  };
}
