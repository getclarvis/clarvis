import {
  parseLocalHostArguments,
  serveLocalFileKernel,
  type LocalFileKernelHost,
} from "@clarvis/kernel/bootstrap";
import { createLogger } from "@clarvis/kernel/logger";
import { globalPaths, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import { readStartupKeySources } from "./adapters/startup-key-sources.ts";
import { resolveClarvisRuntimeImage } from "./adapters/runtime-image.ts";
import { productVersion } from "./cli-args.ts";

/** Headless application composition; this entry never imports Solid, OpenTUI or the TUI runtime. */
async function main(): Promise<void> {
  const input = parseLocalHostArguments(process.argv.slice(2));
  if (input === null) throw new Error("local host entry requires private bootstrap arguments");
  process.env.CLARVIS_HOME = input.globalDir;
  process.env.CLARVIS_WORKSPACE_ROOT = input.workspaceRoot;
  const logger = createLogger("silent");
  const selector = process.env.CLARVIS_HOST_EXTENSION_PROFILE;
  const dirs = {
    global: globalPaths(input.globalDir),
    workspace: workspacePaths(input.workspaceRoot),
    state: workspaceStatePaths(input.workspaceRoot),
  };
  const host: LocalFileKernelHost | null = await serveLocalFileKernel({
    artifactId: input.artifactId,
    kernel: {
      ...input,
      memory: true,
      subscriptions: true,
      logger,
      keySources: readStartupKeySources(dirs),
      ...(selector === undefined ? {} : { extensionProfileSelector: selector }),
      runtimeFactory: {
        async create(value) {
          const local = await import("@clarvis/kernel/local");
          if (value.settings.backend !== "docker") return local.createLocalPodmanRuntime(value);
          return local.createLocalDockerRuntime(value, {
            resolveImage: (signal) =>
              resolveClarvisRuntimeImage({
                currentVersion: productVersion(),
                ...(signal === undefined ? {} : { signal }),
              }),
            onRecipePreparation(name) {
              host?.host.runtimeNotice(`Preparing Docker environment: ${name}`);
            },
          });
        },
      },
    },
  });
  if (host === null) return;
  const running = host;
  const shutdown = (): void => {
    void running.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await running.closed;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
