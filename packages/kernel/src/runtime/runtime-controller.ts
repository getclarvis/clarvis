import { createRuntimeSupervisor } from "./supervisor.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import type { RuntimeBackend, RuntimeInfo, RuntimeSession } from "./types.ts";
import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";

/** Live isolated generation returned to the host composition layer. */
export interface IsolatedRuntimeController {
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
  readonly readOnlyWorkspacePaths?: readonly string[];
  readonly gitCommonDir?: string;
  readonly configurationRevision: string;
  readonly extensionRevision: string;
  readonly capabilityMethods: readonly string[];
  readonly backend: RuntimeBackend;
}): Promise<IsolatedRuntimeController> {
  const supervisor = createRuntimeSupervisor(options.backend);
  const session = await supervisor.launch({
    generation: options.generation,
    ownerId: options.ownerId,
    project: options.project,
    workspace: options.workspace,
    workspaceRoot: options.workspaceRoot,
    readOnlyWorkspacePaths: options.readOnlyWorkspacePaths ?? [],
    ...(options.gitCommonDir === undefined ? {} : { gitCommonDir: options.gitCommonDir }),
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
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    info: session.info,
    session,
    async close() {
      if (closed) return;
      if (closing !== undefined) return closing;
      closing = session
        .stop()
        .then(() => {
          closed = true;
        })
        .finally(() => {
          closing = undefined;
        });
      return closing;
    },
  };
}
