import { createKernelEnvironment, type CreateFileKernelOptions } from "@clarvis/kernel/bootstrap";
import { globalPaths, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import { readStartupKeySources } from "./startup-key-sources.ts";

/** Inputs shared by local discovery hosting and the SSH-owned stdio entry. */
export interface CodeHostKernelOptions {
  workspaceRoot: string;
  globalDir: string;
  defaultOwner?: string;
  extensionProfileSelector?: string;
  logger: CreateFileKernelOptions["logger"];
  /** Raw host environment; defaults to the current process and is snapshotted once. */
  environment?: Readonly<Record<string, string | undefined>>;
  runtimeNotice(message: string): void;
}

/** Apply Code's tool ceiling default before launch policy identity and host construction. */
export function codeHostEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...source,
    CLARVIS_AGENT_TOOLS_MAX_GRANT: source.CLARVIS_AGENT_TOOLS_MAX_GRANT ?? "exec",
  };
}

/** Compose the application-owned FileKernel policy without coupling it to one transport. */
export function createCodeHostKernelOptions(
  options: CodeHostKernelOptions,
): Omit<CreateFileKernelOptions, "sessionAllowlistFor" | "ownershipMode"> {
  const dirs = {
    global: globalPaths(options.globalDir),
    workspace: workspacePaths(options.workspaceRoot),
    state: workspaceStatePaths(options.workspaceRoot),
  };
  const environment = options.environment ?? process.env;
  return {
    workspaceRoot: options.workspaceRoot,
    globalDir: options.globalDir,
    ...(environment.CLARVIS_PRODUCT_ROOT === undefined
      ? {}
      : { systemDocsSourceRoot: environment.CLARVIS_PRODUCT_ROOT }),
    ...(options.defaultOwner === undefined ? {} : { defaultOwner: options.defaultOwner }),
    ...(options.extensionProfileSelector === undefined
      ? {}
      : { extensionProfileSelector: options.extensionProfileSelector }),
    memory: true,
    subscriptions: true,
    environment: createKernelEnvironment(codeHostEnvironment(environment)),
    logger: options.logger,
    keySources: readStartupKeySources(dirs),
  };
}
