import { randomUUID } from "node:crypto";

import {
  createCapabilityRequestView,
  createCapabilityServices,
  type Capability,
  type CapabilityEvent,
  type RunRequest,
} from "@clarvis/capability";
import {
  createMemoryCapability,
  firstUserText,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  prepareMemoryRuntime,
  type MemoryFactory,
  type MemoryProvider,
  type MemoryRuntimeDescriptor,
  type MemoryToolDef,
  type MemoryToolName,
  type PreparedMemoryRuntime,
} from "@clarvis/memory/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

/** Exact private method used to execute memory while its provider stays on the host. */
export const RUNTIME_MEMORY_METHOD = "runtime.memory";
export const RUNTIME_MEMORY_REVISION = "v1";

const MAX_RUNTIME_MEMORY_SEED_CHARS = 256 * 1024;

interface RuntimeMemoryRequest {
  readonly operation: "seed" | "call" | "finish";
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
}

/** Per-run host memory projection paired with its exact capability grant. */
export interface HostMemoryBridge {
  readonly descriptor: MemoryRuntimeDescriptor;
  readonly grant: HostCapabilityGrant;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const admitted = new Set(keys);
  return Object.keys(value).every((key) => admitted.has(key));
}

function sameVocabulary(value: unknown, expected: readonly string[]): value is MemoryToolName[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return false;
  const actual = [...new Set(value as string[])].sort();
  const canonical = [...expected].sort();
  return (
    value.length === expected.length &&
    actual.length === canonical.length &&
    actual.every((entry, index) => entry === canonical[index])
  );
}

/** Validate the bounded, provider-opaque memory description accepted by the guest. */
export function validRuntimeMemoryDescriptor(value: unknown): value is MemoryRuntimeDescriptor {
  const descriptor = record(value);
  return (
    descriptor !== undefined &&
    only(descriptor, ["providerDigest", "seedMaxChars", "readTools"]) &&
    typeof descriptor.providerDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(descriptor.providerDigest) &&
    Number.isSafeInteger(descriptor.seedMaxChars) &&
    (descriptor.seedMaxChars as number) > 0 &&
    (descriptor.seedMaxChars as number) <= MAX_RUNTIME_MEMORY_SEED_CHARS &&
    sameVocabulary(descriptor.readTools, MEMORY_READ_TOOL_NAMES)
  );
}

function validRuntimeMemoryRequest(
  value: unknown,
  runtime: PreparedMemoryRuntime,
): value is RuntimeMemoryRequest {
  const request = record(value);
  if (request === undefined || typeof request.operation !== "string") return false;
  if (request.operation === "seed" || request.operation === "finish") {
    return only(request, ["operation"]);
  }
  return (
    request.operation === "call" &&
    only(request, ["operation", "name", "arguments"]) &&
    typeof request.name === "string" &&
    record(request.arguments) !== undefined &&
    runtime.accepts(request.name, request.arguments)
  );
}

function entryGrants(request: RunRequest): readonly string[] {
  const entry = request.profiles.find((profile) => profile.name === request.entry);
  return entry?.grants ?? [];
}

/**
 * Resolve one host memory provider for an isolated run and expose only its fixed read vocabulary.
 *
 * @remarks Seed selection, provider calls, durable enqueueing, policy and credentials remain on
 * the host. The guest receives only {@link MemoryRuntimeDescriptor} plus bounded read results;
 * mutating names are absent from the descriptor and rejected again by the host grant validator.
 */
export async function createHostMemoryBridge(options: {
  readonly factory: MemoryFactory;
  readonly rawBody: unknown;
  readonly owner: string;
  readonly runId: string;
  readonly deps: ExecuteRunDeps;
  readonly signal?: AbortSignal;
  readonly onCapabilityEvent?: (event: CapabilityEvent) => void;
}): Promise<HostMemoryBridge | undefined> {
  const request = options.rawBody as RunRequest;
  const view = createCapabilityRequestView(request);
  const runtime = await prepareMemoryRuntime(options.factory, {
    ...view,
    owner: options.owner,
    entryGrants: entryGrants(request),
    env: options.deps.env,
    workspaceRoot: options.deps.workspaceRoot,
    llm: options.deps.llm,
    ...(options.deps.logger === undefined ? {} : { logger: options.deps.logger }),
    emit: (event) => {
      try {
        options.onCapabilityEvent?.(event);
      } catch {
        return;
      }
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    services: createCapabilityServices(),
    executionId: options.runId,
  });
  if (runtime === null) return undefined;

  const task = firstUserText(request.messages);
  let seed: Promise<string | null> | undefined;
  let finished = false;
  const grant: HostCapabilityGrant = {
    method: RUNTIME_MEMORY_METHOD,
    revision: RUNTIME_MEMORY_REVISION,
    idempotent: false,
    validateArguments: (value) => validRuntimeMemoryRequest(value, runtime),
    async invoke(value, signal) {
      if (!validRuntimeMemoryRequest(value, runtime)) {
        throw Object.assign(new Error("runtime memory request is invalid"), {
          code: "invalid_request",
        });
      }
      if (value.operation === "seed") {
        seed ??= runtime.seed(task);
        return { kind: "seed", value: await seed };
      }
      if (value.operation === "call") {
        const result = await runtime.invoke(value.name!, value.arguments!, signal);
        return { kind: "result", ...result };
      }
      if (finished) {
        throw Object.assign(new Error("runtime memory was already finalized"), {
          code: "conflict",
        });
      }
      const stored = options.deps.traceStore.getById(options.owner, options.runId);
      if (
        stored === null ||
        stored.id !== options.runId ||
        stored.owner_key_name !== options.owner
      ) {
        throw Object.assign(new Error("runtime memory requires a durable host trace"), {
          code: "unavailable",
        });
      }
      finished = true;
      await runtime.finish(stored);
      return { kind: "finished" };
    },
  };
  return { descriptor: runtime.descriptor, grant };
}

function runtimeTool(name: MemoryToolName, bridge: GuestExecutionBridge): MemoryToolDef {
  return {
    name,
    description: MEMORY_TOOL_CONTRACTS[name].description,
    parameters: memoryToolParameters(name),
    async execute(args, signal) {
      try {
        const value = record(
          await bridge.capability(
            randomUUID(),
            {
              method: RUNTIME_MEMORY_METHOD,
              revision: RUNTIME_MEMORY_REVISION,
              arguments: { operation: "call", name, arguments: args },
            },
            signal,
          ),
        );
        if (
          value?.kind !== "result" ||
          typeof value.text !== "string" ||
          typeof value.isError !== "boolean"
        ) {
          return { text: "host memory returned an invalid result", isError: true };
        }
        return { text: value.text, isError: value.isError };
      } catch (error) {
        return {
          text: `host memory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

/** Create the guest-side canonical memory capability over a host execution proxy. */
export function createGuestMemoryCapability(
  descriptor: MemoryRuntimeDescriptor | undefined,
  bridge: GuestExecutionBridge,
): Capability {
  if (descriptor === undefined) return createMemoryCapability();
  if (!validRuntimeMemoryDescriptor(descriptor)) {
    throw new Error("guest memory descriptor is invalid");
  }
  const provider: MemoryProvider = {
    kind: "runtime",
    readTools: descriptor.readTools.map((name) => runtimeTool(name, bridge)),
    async seed() {
      const value = record(
        await bridge.capability(randomUUID(), {
          method: RUNTIME_MEMORY_METHOD,
          revision: RUNTIME_MEMORY_REVISION,
          arguments: { operation: "seed" },
        }),
      );
      if (value?.kind !== "seed") {
        throw new Error("host memory returned an invalid seed");
      }
      const seed = value.value;
      if (typeof seed === "string") return seed;
      if (seed === null) return null;
      throw new Error("host memory returned an invalid seed");
    },
  };
  const factory: MemoryFactory = {
    forOwner: () => undefined,
    forOwnerControlPlane: () => undefined,
    providerFor: async () => ({
      ok: true,
      provider,
      key: `runtime:${descriptor.providerDigest}`,
      seedMaxChars: descriptor.seedMaxChars,
    }),
    start() {},
    poke() {},
    async stop() {},
    subscribeToRun: () => () => undefined,
  };
  const capability = createMemoryCapability(factory, { enqueueOnRunEnd: false });
  return {
    ...capability,
    async forRun(ctx) {
      const run = await capability.forRun(ctx);
      if (run === null) return null;
      return {
        ...run,
        async onRunEnd() {
          await bridge.capability(randomUUID(), {
            method: RUNTIME_MEMORY_METHOD,
            revision: RUNTIME_MEMORY_REVISION,
            arguments: { operation: "finish" },
          });
        },
      };
    },
  };
}
