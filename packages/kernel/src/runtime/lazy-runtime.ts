import { randomUUID } from "node:crypto";

import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { ProjectRef, RuntimeStatus, WorkspaceRef } from "@clarvis/protocol";
import type { RunExecutor } from "../runs/run-service.ts";
import type { RuntimeSettingsBlock } from "./settings.ts";
import { RuntimeLaunchError, type RuntimeInfo, type RuntimeProtectedMount } from "./types.ts";

/** Inputs a host adapter needs to construct one isolated runtime generation. */
export interface RuntimeHostInput {
  /** Generation-owned initialization cancellation; each waiting run has a separate signal. */
  readonly signal?: AbortSignal;
  readonly settings: Exclude<RuntimeSettingsBlock, { backend: "native" }>;
  readonly generation: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly workspaceRoot: string;
  /** Closed Git metadata projection discovered by the host; every item must be read-only. */
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
  readonly deps: ExecuteRunDeps;
}

/** One ready host runtime and its placement-neutral run executor. */
export interface RuntimeHost {
  readonly executeRun: RunExecutor;
  readonly info: RuntimeInfo;
  /** True once the private channel or its engine process can no longer accept a run. */
  readonly closed: boolean;
  close(): Promise<void>;
}

/** Host constructor that observes generation cancellation and cleans partial resources before rejecting. */
export interface FileKernelRuntimeFactory {
  create(input: RuntimeHostInput): Promise<RuntimeHost>;
}

/** Live placement transition emitted to local user interfaces. */
export interface RuntimePlacementNotice {
  readonly status: RuntimeStatus;
  readonly message?: string;
}

interface RuntimeSelection {
  readonly settings: RuntimeSettingsBlock;
  readonly configurationRevision: string;
}

interface RuntimeSlot {
  readonly key: string;
  readonly host: RuntimeHost;
  active: number;
  retire: boolean;
  closing?: Promise<void>;
}

function selectionKey(selection: RuntimeSelection): string {
  return selection.configurationRevision;
}

/** Lazy runtime state machine shared by ordinary runs and workflows. */
export interface LazyRuntimeCoordinator {
  readonly executeRun: RunExecutor;
  current(): RuntimeStatus;
  close(): Promise<void>;
}

function containerStatus(
  settings: Exclude<RuntimeSettingsBlock, { backend: "native" }>,
  lifecycle: Extract<RuntimeStatus, { kind: "container" }>["lifecycle"],
): Extract<RuntimeStatus, { kind: "container" }> {
  return {
    kind: "container",
    engine: settings.backend,
    host_platform: process.platform,
    guest_platform: "linux",
    network: settings.network,
    lifecycle,
  };
}

function readyStatus(info: RuntimeInfo): Extract<RuntimeStatus, { kind: "container" }> {
  return {
    kind: "container",
    generation: info.generation,
    engine: info.engine,
    engine_version: info.engineVersion,
    host_platform: info.hostPlatform,
    guest_platform: info.guestPlatform,
    image_digest: info.imageDigest,
    runtime_protocol_revision: info.runtimeProtocolRevision,
    network: info.network,
    lifecycle: info.lifecycle,
  };
}

function failureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

/** Stop one caller's wait without cancelling acquisition shared with other runs. */
function waitForInitialization<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("runtime initialization cancelled", { cause: signal.reason }),
      );
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(
          error instanceof Error
            ? error
            : new Error("runtime initialization failed", { cause: error }),
        );
      },
    );
    if (signal.aborted) aborted();
  });
}

/**
 * Select native or container execution at run time, starting a container only
 * when the first run actually needs it.
 *
 * Container acquisition and execution fail closed. A selected container is never
 * replayed through native Host or Sandbox because either placement may already have effects.
 */
export function createLazyRuntimeCoordinator(options: {
  readonly selection: () => RuntimeSelection;
  readonly nativeIsolation: () => "host" | "sandbox";
  readonly nativeExecuteRun: RunExecutor;
  readonly runtimeFactory?: FileKernelRuntimeFactory;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly workspaceRoot: string;
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
  readonly deps: ExecuteRunDeps;
  readonly onPlacement?: (notice: RuntimePlacementNotice) => void;
  readonly logger?: Logger;
}): LazyRuntimeCoordinator {
  const logger = options.logger ?? NOOP_LOGGER;
  const slots = new Map<string, RuntimeSlot>();
  const ownedSlots = new Set<RuntimeSlot>();
  const launches = new Map<string, Promise<RuntimeSlot>>();
  const initialization = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  let status: RuntimeStatus = (() => {
    const selected = options.selection().settings;
    return selected.backend === "native"
      ? {
          kind: "native",
          host_platform: process.platform,
          isolation: options.nativeIsolation(),
          lifecycle: "ready",
        }
      : containerStatus(selected, "cold");
  })();

  const publish = (next: RuntimeStatus, message?: string): void => {
    status = next;
    options.onPlacement?.({ status: next, ...(message === undefined ? {} : { message }) });
  };

  const closeSlot = async (slot: RuntimeSlot): Promise<void> => {
    if (slot.closing !== undefined) return slot.closing;
    slot.closing = Promise.resolve()
      .then(() => slot.host.close())
      .then(() => {
        if (slots.get(slot.key) === slot) slots.delete(slot.key);
        ownedSlots.delete(slot);
      })
      .finally(() => {
        slot.closing = undefined;
      });
    return slot.closing;
  };

  const retireIdleSlots = async (keep: string): Promise<void> => {
    await Promise.all(
      [...ownedSlots]
        .filter((slot) => (slot.retire || slot.key !== keep) && slot.active === 0)
        .map((slot) => closeSlot(slot)),
    );
  };

  const launch = async (
    selected: Exclude<RuntimeSettingsBlock, { backend: "native" }>,
    selection: RuntimeSelection,
  ): Promise<RuntimeSlot> => {
    if (options.runtimeFactory === undefined) {
      throw new RuntimeLaunchError(
        "operational_failure",
        `${selected.backend} runtime support is not available in this host`,
      );
    }
    publish(containerStatus(selected, "starting"));
    const host = await options.runtimeFactory.create({
      signal: initialization.signal,
      settings: selected,
      generation: randomUUID(),
      ownerId: options.ownerId,
      project: options.project,
      workspace: options.workspace,
      workspaceRoot: options.workspaceRoot,
      gitMetadataMounts: options.gitMetadataMounts,
      deps: options.deps,
    });
    const slot: RuntimeSlot = { key: selectionKey(selection), host, active: 0, retire: false };
    ownedSlots.add(slot);
    if (closed) {
      await closeSlot(slot);
      throw new Error("runtime coordinator is closed");
    }
    slots.set(slot.key, slot);
    publish(readyStatus(host.info));
    return slot;
  };

  const slotFor = async (
    selected: Exclude<RuntimeSettingsBlock, { backend: "native" }>,
    selection: RuntimeSelection,
  ): Promise<RuntimeSlot> => {
    const key = selectionKey(selection);
    const existing = slots.get(key);
    if (existing !== undefined && !existing.host.closed && !existing.retire) return existing;
    if (existing !== undefined) {
      existing.retire = true;
      if (slots.get(key) === existing) slots.delete(key);
      if (existing.active === 0) {
        await closeSlot(existing).catch((error: unknown) => {
          logger.warn(
            { event: "runtime.stale_generation_cleanup_failed", cause: failureDetail(error) },
            "a closed isolated runtime generation could not be cleaned up before replacement",
          );
        });
      }
    }
    const pending = launches.get(key);
    if (pending !== undefined) return pending;
    const next = launch(selected, selection).finally(() => launches.delete(key));
    launches.set(key, next);
    return next;
  };

  return {
    current: () => status,
    async executeRun(args) {
      if (closed) throw new Error("runtime coordinator is closed");
      args.externalSignal?.throwIfAborted();
      const waitingSignal =
        args.externalSignal === undefined
          ? initialization.signal
          : AbortSignal.any([initialization.signal, args.externalSignal]);
      const selected = options.selection();
      if (selected.settings.backend === "native") {
        publish({
          kind: "native",
          host_platform: process.platform,
          isolation: options.nativeIsolation(),
          lifecycle: "ready",
        });
        await retireIdleSlots("");
        return options.nativeExecuteRun(args);
      }
      const key = selectionKey(selected);
      const slot = await waitForInitialization(slotFor(selected.settings, selected), waitingSignal);
      await retireIdleSlots(key);
      waitingSignal.throwIfAborted();
      slot.active += 1;
      try {
        return await slot.host.executeRun(args);
      } finally {
        slot.active -= 1;
        if (slot.host.closed) {
          slot.retire = true;
          if (slots.get(slot.key) === slot) slots.delete(slot.key);
          const latest = options.selection();
          if (
            slots.get(slot.key) === undefined &&
            selectionKey(latest) === slot.key &&
            latest.settings.backend !== "native"
          ) {
            publish(containerStatus(latest.settings, "cold"));
          }
        }
        const latest = options.selection();
        if (
          slot.active === 0 &&
          (slot.retire || latest.settings.backend === "native" || selectionKey(latest) !== slot.key)
        ) {
          await closeSlot(slot).catch((error: unknown) => {
            logger.warn(
              { event: "runtime.generation_cleanup_failed", cause: failureDetail(error) },
              "an isolated runtime generation could not be cleaned up after retirement",
            );
          });
        }
      }
    },
    async close() {
      if (closing !== undefined) return closing;
      closed = true;
      initialization.abort(new Error("runtime coordinator is closed"));
      closing = (async () => {
        await Promise.allSettled(launches.values());
        const results = await Promise.allSettled([...ownedSlots].map((slot) => closeSlot(slot)));
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (failures.length > 0) throw new AggregateError(failures, "runtime cleanup failed");
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
