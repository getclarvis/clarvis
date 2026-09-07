import { randomUUID } from "node:crypto";

import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { PluginBootstrapSkill } from "@clarvis/loop/host";
import type { MemoryFactory } from "@clarvis/memory/capability";
import type { PlanFactory } from "@clarvis/plan";
import type { TaskProviderResolver } from "@clarvis/tasks";
import type { SkillsProvider } from "@clarvis/skills/capability";
import type { ProjectRef, RuntimeStatus, WorkspaceRef } from "@clarvis/protocol";
import type { GuardSettings } from "../guard/resolver.ts";
import type { RunExecutor } from "../runs/run-service.ts";
import type { RuntimeSettingsBlock } from "./settings.ts";
import { RuntimeLaunchError, type RuntimeInfo } from "./types.ts";

/** Inputs a host adapter needs to construct one isolated runtime generation. */
export interface RuntimeHostInput {
  readonly settings: Exclude<RuntimeSettingsBlock, { backend: "native" }>;
  readonly generation: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly workspaceRoot: string;
  /** External common Git directory needed only by a linked worktree. */
  readonly gitCommonDir?: string;
  readonly configurationRevision: string;
  readonly extensionRevision: string;
  readonly deps: ExecuteRunDeps;
  /** Canonical host plan provider exposed to the guest through an exact per-run bridge. */
  readonly planFactory?: PlanFactory;
  /** Shared host selector used by the native and guest Tasks capabilities. */
  readonly taskResolver?: TaskProviderResolver;
  /** Immutable host-admitted skill view disclosed through a read-only runtime bridge. */
  readonly skillsProvider?: SkillsProvider;
  /** Active plugins' bootstrap declarations, resolved against the admitted skill snapshot. */
  readonly skillBootstraps?: () => readonly PluginBootstrapSkill[];
  /** Canonical host memory factory; stores, providers and policy never enter the guest. */
  readonly memoryFactory?: MemoryFactory;
  /** Fresh host policy snapshot serialized into each guest run. */
  readonly loadGuardSettings?: () => GuardSettings;
  /** Dedicated host audit sink for validated guard records returned by the guest. */
  readonly guardAudit?: Logger;
}

/** One ready host runtime and its placement-neutral run executor. */
export interface RuntimeHost {
  readonly executeRun: RunExecutor;
  readonly info: RuntimeInfo;
  /** True once the private channel or its engine process can no longer accept a run. */
  readonly closed: boolean;
  close(): Promise<void>;
}

/** Host-specific constructor for an explicitly selected isolated execution generation. */
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
  readonly extensionRevision: string;
}

interface RuntimeSlot {
  readonly key: string;
  readonly host: RuntimeHost;
  active: number;
  retire: boolean;
  closing?: Promise<void>;
}

function selectionKey(selection: RuntimeSelection): string {
  return `${selection.configurationRevision}\0${selection.extensionRevision}`;
}

/** Lazy runtime state machine shared by ordinary runs and workflows. */
export interface LazyRuntimeCoordinator {
  readonly executeRun: RunExecutor;
  current(): RuntimeStatus;
  retry(): void;
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

function operationalFailure(error: unknown): boolean {
  return (
    !(error instanceof RuntimeLaunchError) ||
    error.code === "engine_missing" ||
    error.code === "engine_stopped" ||
    error.code === "unsupported_platform" ||
    error.code === "operational_failure"
  );
}

function failureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Select native or container execution at run time, starting a container only
 * when the first run actually needs it.
 *
 * @remarks Docker operational failures latch to a required native-sandbox
 * fallback for the lifetime of this coordinator. Integrity, handshake and
 * effective-policy failures remain fail-closed. A failure after guest execution
 * begins is never replayed natively because the run may already have effects.
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
  readonly gitCommonDir?: string;
  readonly deps: ExecuteRunDeps;
  readonly planFactory?: PlanFactory;
  readonly skillsProvider?: SkillsProvider;
  readonly taskResolver?: TaskProviderResolver;
  readonly skillBootstraps?: () => readonly PluginBootstrapSkill[];
  readonly memoryFactory?: MemoryFactory;
  readonly loadGuardSettings?: () => GuardSettings;
  readonly guardAudit?: Logger;
  readonly assertFallbackSandbox?: () => Promise<void>;
  readonly onPlacement?: (notice: RuntimePlacementNotice) => void;
  readonly logger?: Logger;
}): LazyRuntimeCoordinator {
  const logger = options.logger ?? NOOP_LOGGER;
  const slots = new Map<string, RuntimeSlot>();
  const ownedSlots = new Set<RuntimeSlot>();
  const launches = new Map<string, Promise<RuntimeSlot>>();
  const fallback = new Map<string, string>();
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
      settings: selected,
      generation: randomUUID(),
      ownerId: options.ownerId,
      project: options.project,
      workspace: options.workspace,
      workspaceRoot: options.workspaceRoot,
      ...(options.gitCommonDir === undefined ? {} : { gitCommonDir: options.gitCommonDir }),
      configurationRevision: selection.configurationRevision,
      extensionRevision: selection.extensionRevision,
      deps: options.deps,
      ...(options.planFactory === undefined ? {} : { planFactory: options.planFactory }),
      ...(options.taskResolver === undefined ? {} : { taskResolver: options.taskResolver }),
      ...(options.skillsProvider === undefined ? {} : { skillsProvider: options.skillsProvider }),
      ...(options.skillBootstraps === undefined
        ? {}
        : { skillBootstraps: options.skillBootstraps }),
      ...(options.memoryFactory === undefined ? {} : { memoryFactory: options.memoryFactory }),
      ...(options.loadGuardSettings === undefined
        ? {}
        : { loadGuardSettings: options.loadGuardSettings }),
      ...(options.guardAudit === undefined ? {} : { guardAudit: options.guardAudit }),
    });
    const slot: RuntimeSlot = { key: selectionKey(selection), host, active: 0, retire: false };
    ownedSlots.add(slot);
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

  const runFallback = async (
    selected: Extract<RuntimeSettingsBlock, { backend: "docker" }>,
    key: string,
    args: Parameters<RunExecutor>[0],
    detail: string,
    announce: boolean,
  ): ReturnType<RunExecutor> => {
    await options.assertFallbackSandbox?.();
    const next: RuntimeStatus = {
      kind: "native",
      host_platform: process.platform,
      isolation: "sandbox",
      lifecycle: "fallback",
      fallback_from: selected.backend,
    };
    publish(
      next,
      announce
        ? `Docker could not start (${detail || "operational failure"}). Isolation switched to Sandbox for this Clarvis session.`
        : undefined,
    );
    if (announce) {
      logger.warn(
        {
          event: "runtime.docker_fallback",
          engine: selected.backend,
          reason: "operational_failure",
        },
        "the selected Docker runtime failed before execution; this session uses the required native sandbox",
      );
    }
    fallback.set(key, detail);
    return options.nativeExecuteRun(args);
  };

  return {
    current: () => status,
    retry(): void {
      const selected = options.selection();
      if (selected.settings.backend === "native") return;
      fallback.delete(selectionKey(selected));
      publish(containerStatus(selected.settings, "cold"));
    },
    async executeRun(args) {
      if (closed) throw new Error("runtime coordinator is closed");
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
      const priorFailure = fallback.get(key);
      if (
        selected.settings.backend === "docker" &&
        selected.settings.fallback === "sandbox" &&
        priorFailure !== undefined
      ) {
        return runFallback(selected.settings, key, args, priorFailure, false);
      }
      let slot: RuntimeSlot;
      try {
        slot = await slotFor(selected.settings, selected);
      } catch (error) {
        if (
          selected.settings.backend === "docker" &&
          selected.settings.fallback === "sandbox" &&
          operationalFailure(error)
        ) {
          return runFallback(selected.settings, key, args, failureDetail(error), true);
        }
        throw error;
      }
      await retireIdleSlots(key);
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
