import { globalPaths, workspaceRoot } from "@clarvis/paths";
import { createLogger } from "@clarvis/kernel/logger";
import type { Mode } from "./cli-args.ts";
import { openPublicUrl } from "./adapters/open-public-url.ts";
import { WorkspaceClientManager } from "./adapters/workspace-client-manager.ts";

type RunMode = Extract<Mode, { kind: "run" }>;

/** Start the immutable workspace kernel while the complete application chunk is still loading. */
export function prepareStartupFoundation(mode: RunMode): Promise<WorkspaceClientManager> {
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
  });
}
