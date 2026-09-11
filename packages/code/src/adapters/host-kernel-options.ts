import { createKernelEnvironment, type CreateFileKernelOptions } from "@clarvis/kernel/bootstrap";
import type {
  createLocalDockerRuntime as CreateLocalDockerRuntime,
  createLocalPodmanRuntime as CreateLocalPodmanRuntime,
} from "@clarvis/kernel/local";
import { globalPaths, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import { readStartupKeySources } from "./startup-key-sources.ts";
import { resolveClarvisRuntimeImage } from "./runtime-image.ts";
import { productVersion } from "../cli-args.ts";

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

interface LocalRuntimeModule {
  createLocalDockerRuntime: typeof CreateLocalDockerRuntime;
  createLocalPodmanRuntime: typeof CreateLocalPodmanRuntime;
}

/** Effectful dependencies used only when the lazy container runtime is first selected. */
export interface CodeHostRuntimeDependencies {
  loadLocalRuntime(): Promise<LocalRuntimeModule>;
  resolveRuntimeImage: typeof resolveClarvisRuntimeImage;
  productVersion: typeof productVersion;
}

const DEFAULT_RUNTIME_DEPENDENCIES: CodeHostRuntimeDependencies = {
  loadLocalRuntime: () => import("@clarvis/kernel/local"),
  resolveRuntimeImage: resolveClarvisRuntimeImage,
  productVersion,
};

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
  runtimeDependencies: CodeHostRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES,
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
    ...(options.defaultOwner === undefined ? {} : { defaultOwner: options.defaultOwner }),
    ...(options.extensionProfileSelector === undefined
      ? {}
      : { extensionProfileSelector: options.extensionProfileSelector }),
    memory: true,
    subscriptions: true,
    environment: createKernelEnvironment(codeHostEnvironment(environment)),
    logger: options.logger,
    keySources: readStartupKeySources(dirs),
    runtimeFactory: {
      async create(value) {
        const local = await runtimeDependencies.loadLocalRuntime();
        const resolveImage = (signal?: AbortSignal) =>
          runtimeDependencies.resolveRuntimeImage({
            currentVersion: runtimeDependencies.productVersion(),
            ...(signal === undefined ? {} : { signal }),
          });
        if (value.settings.backend === "podman") {
          return local.createLocalPodmanRuntime(value, { resolveImage });
        }
        return local.createLocalDockerRuntime(value, {
          resolveImage,
          onRecipePreparation(name) {
            options.runtimeNotice(`Preparing Docker environment: ${name}`);
          },
        });
      },
    },
  };
}
