import type { RootOptions } from "@clarvis/paths";
import {
  prepareRuntimeWorkspace,
  setRuntimeState,
  type PreparedRuntimeWorkspace,
} from "./runtime-store.ts";
import { createRuntimeSupervisor } from "./supervisor.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import type { RuntimeBackend, RuntimeInfo, RuntimeSession } from "./types.ts";
import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";

/** Live prepared generation returned to the host composition layer. */
export interface IsolatedRuntimeController {
  readonly prepared: PreparedRuntimeWorkspace;
  readonly info: RuntimeInfo;
  readonly session: RuntimeSession;
  close(): Promise<void>;
}

/** Capture a generation and launch its explicitly configured backend without fallback. */
export async function launchIsolatedRuntime(options: {
  readonly settings: ResolvedContainerRuntimeSettings;
  readonly generation: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly workspaceRoot: string;
  readonly configurationRevision: string;
  readonly extensionRevision: string;
  readonly capabilityMethods: readonly string[];
  readonly backend: RuntimeBackend;
  readonly roots?: RootOptions;
}): Promise<IsolatedRuntimeController> {
  const prepared = await prepareRuntimeWorkspace({
    runtimeId: options.generation,
    ownerId: options.ownerId,
    project: options.project,
    workspace: options.workspace,
    sourceWorkspaceRoot: options.workspaceRoot,
    ...(options.roots === undefined ? {} : { roots: options.roots }),
  });
  const supervisor = createRuntimeSupervisor(options.backend);
  try {
    const session = await supervisor.launch({
      generation: options.generation,
      ownerId: options.ownerId,
      project: options.project,
      workspace: options.workspace,
      sourceWorkspaceRoot: prepared.record.sourceWorkspaceRoot,
      retainedWorkspaceRoot: prepared.record.retainedWorkspaceRoot,
      imageDigest: options.settings.image_digest,
      configurationRevision: options.configurationRevision,
      extensionRevision: options.extensionRevision,
      network: options.settings.network,
      limits: {
        cpuCount: options.settings.limits.cpu_count,
        memoryBytes: options.settings.limits.memory_bytes,
        processCount: options.settings.limits.process_count,
        outputBytes: options.settings.limits.output_bytes,
        storageBytes: options.settings.limits.storage_bytes,
      },
      capabilityMethods: options.capabilityMethods,
    });
    await setRuntimeState(options.workspaceRoot, options.generation, "active", options.roots);
    let closed = false;
    return {
      prepared,
      info: session.info,
      session,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await session.stop();
          await setRuntimeState(
            options.workspaceRoot,
            options.generation,
            "stopped",
            options.roots,
          );
        } catch (error) {
          await setRuntimeState(
            options.workspaceRoot,
            options.generation,
            "cleanup_pending",
            options.roots,
          );
          throw error;
        }
      },
    };
  } catch (error) {
    await setRuntimeState(options.workspaceRoot, options.generation, "failed", options.roots).catch(
      () => undefined,
    );
    throw error;
  }
}
