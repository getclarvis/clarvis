#!/usr/bin/env bun
/**
 * CLI entry: serves a file kernel over stdio for the given `--workspace` (default: cwd).
 */
import { serveFileKernelOverStdio } from "./serve.ts";
import { detachObserved } from "@clarvis/capability";

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
