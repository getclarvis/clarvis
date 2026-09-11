import { serveRemoteFileKernelOverStdio } from "@clarvis/kernel/bootstrap";
import { createLogger } from "@clarvis/kernel/logger";
import { globalPaths } from "@clarvis/paths";
import { createCodeHostKernelOptions } from "./adapters/host-kernel-options.ts";
import { resolveLocalKernelArtifact } from "./adapters/local-kernel-artifact.ts";
import { parseRemoteKernelArguments } from "./adapters/remote-kernel-arguments.ts";

/** SSH-owned headless composition; authentication is complete before this process starts. */
async function main(): Promise<void> {
  const input = parseRemoteKernelArguments(process.argv.slice(2));
  process.env.CLARVIS_WORKSPACE_ROOT = input.workspaceRoot;
  const logger = createLogger("silent");
  const hostRef: { current?: Awaited<ReturnType<typeof serveRemoteFileKernelOverStdio>> } = {};
  const kernel = createCodeHostKernelOptions({
    workspaceRoot: input.workspaceRoot,
    globalDir: globalPaths().root,
    ...(input.extensionProfileSelector === undefined
      ? {}
      : { extensionProfileSelector: input.extensionProfileSelector }),
    logger,
    runtimeNotice(message) {
      hostRef.current?.host.runtimeNotice(message);
    },
  });
  const host = await serveRemoteFileKernelOverStdio({
    artifactId: (await resolveLocalKernelArtifact()).artifactId,
    kernel,
  });
  hostRef.current = host;
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

await main().catch(() => {
  process.exitCode = 1;
});
