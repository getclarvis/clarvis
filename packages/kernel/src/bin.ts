#!/usr/bin/env bun
/**
 * CLI entry: serves a file kernel over stdio, or an explicitly selected independent local host.
 */
import { serveFileKernelOverStdio } from "./serve.ts";
import { detachObserved } from "@clarvis/capability";
import { parseLocalHostArguments } from "./hosting/launcher.ts";
import { serveLocalFileKernel } from "./hosting/serve-local.ts";

/**
 * Extracts the workspace root from `--workspace <path>` in the given args,
 * falling back to `process.cwd()` when the flag is absent or has no value.
 */
function workspaceFromArgv(argv: readonly string[]): string {
  const i = argv.indexOf("--workspace");
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value ?? process.cwd();
}

async function main(): Promise<void> {
  const local = parseLocalHostArguments(process.argv.slice(2));
  if (local !== null) {
    process.env.CLARVIS_HOME = local.globalDir;
    process.env.CLARVIS_WORKSPACE_ROOT = local.workspaceRoot;
    const host = await serveLocalFileKernel({ kernel: local, artifactId: local.artifactId });
    if (host === null) return;
    const shutdown = (): void =>
      detachObserved(() => host.close(), {
        operation: "hosting.process.shutdown",
        observer: () => {
          process.exitCode = 1;
        },
      });
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await host.closed;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    return;
  }
  const workspaceRoot = workspaceFromArgv(process.argv.slice(2));
  const handle = await serveFileKernelOverStdio({ workspaceRoot });
  const shutdown = (): void => {
    detachObserved(() => handle.close().finally(() => process.exit(0)), {
      operation: "kernel_stdio_shutdown",
      observer: ({ cause }) => process.stderr.write(`clarvis-kernel shutdown failed: ${cause}\n`),
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`clarvis-kernel failed to start: ${String(err)}\n`);
  process.exit(1);
});
