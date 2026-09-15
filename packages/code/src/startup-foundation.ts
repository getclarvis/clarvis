import { globalPaths, workspaceRoot } from "@clarvis/paths";
import { createLogger } from "@clarvis/kernel/logger";
import type { ContainerConnectionPhase } from "@clarvis/kernel/bootstrap";
import type { Mode } from "./cli-args.ts";
import { openPublicUrl } from "./adapters/open-public-url.ts";
import { WorkspaceClientManager } from "./adapters/workspace-client-manager.ts";

type RunMode = Extract<Mode, { kind: "run" }>;

/** Human startup copy for the engine-owned phases emitted by the Container connector. */
export function containerConnectionStatus(phase: ContainerConnectionPhase): string {
  switch (phase) {
    case "inspecting_engine":
      return "inspecting Container engine";
    case "resolving_runtime":
      return "resolving Container runtime";
    case "inspecting_workspace":
      return "inspecting workspace mount";
    case "preparing_workspace":
      return "preparing workspace isolation";
    case "preparing_artifact":
      return "preparing Kernel artifact";
    case "preparing_state":
      return "preparing Container state";
    case "starting_kernel":
      return "starting Container Kernel";
  }
}

/** Start the immutable workspace kernel while the complete application chunk is still loading. */
export function prepareStartupFoundation(
  mode: RunMode,
  onContainerProgress?: (status: string) => void,
): Promise<WorkspaceClientManager> {
  const workspace = workspaceRoot();
  const owner = process.env.CLARVIS_OWNER;
  return WorkspaceClientManager.create({
    workspaceRoot: workspace,
    globalDir: globalPaths().root,
    ...(mode.extensionProfileSelector === undefined
      ? {}
      : { extensionProfileSelector: mode.extensionProfileSelector }),
    ...(owner === undefined ? {} : { defaultOwner: owner }),
    logger: createLogger("silent"),
    openMcpAuthorizationUrl: openPublicUrl,
    ...(onContainerProgress === undefined
      ? {}
      : { onContainerProgress: (phase) => onContainerProgress(containerConnectionStatus(phase)) }),
    ...(mode.remote === undefined ? {} : { destination: { kind: "ssh" as const, ...mode.remote } }),
  });
}
