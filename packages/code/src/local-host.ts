import {
  parseLocalHostArguments,
  serveLocalFileKernel,
  type LocalFileKernelHost,
} from "@clarvis/kernel/bootstrap";
import { createLogger } from "@clarvis/kernel/logger";
import { createCodeHostKernelOptions } from "./adapters/host-kernel-options.ts";

/** Headless application composition; this entry never imports Solid, OpenTUI or the TUI runtime. */
async function main(): Promise<void> {
  const input = parseLocalHostArguments(process.argv.slice(2));
  if (input === null) throw new Error("local host entry requires private bootstrap arguments");
  process.env.CLARVIS_HOME = input.globalDir;
  process.env.CLARVIS_WORKSPACE_ROOT = input.workspaceRoot;
  const logger = createLogger("silent");
  const selector = process.env.CLARVIS_HOST_EXTENSION_PROFILE;
  const host: LocalFileKernelHost | null = await serveLocalFileKernel({
    artifactId: input.artifactId,
    kernel: createCodeHostKernelOptions({
      workspaceRoot: input.workspaceRoot,
      globalDir: input.globalDir,
      defaultOwner: input.defaultOwner,
      ...(selector === undefined ? {} : { extensionProfileSelector: selector }),
      logger,
      runtimeNotice(message) {
        host?.host.runtimeNotice(message);
      },
    }),
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
