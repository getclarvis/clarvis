import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const removed = [
  "packages/kernel/src/runtime/guest-main.ts",
  "packages/kernel/src/runtime/guest-loop-executor.ts",
  "packages/kernel/src/runtime/execution-worker.ts",
  "packages/kernel/src/runtime/isolated-run-executor.ts",
  "packages/kernel/src/runtime/local-container-runtime.ts",
  "packages/kernel/src/runtime/runtime-checkpoints.ts",
  "packages/kernel/src/runtime/execution-rpc.ts",
  "packages/kernel/src/runtime/host-execution-bridge.ts",
  "packages/kernel/src/runtime/lazy-runtime.ts",
  "packages/kernel/src/runtime/container-session.ts",
  "tooling/runtime/guest-entry.ts",
];

test("Container has one full-Kernel composition and no divided execution entry", () => {
  for (const path of removed) expect(existsSync(path), path).toBe(false);

  const base = readFileSync("Containerfile.runtime", "utf8");
  const artifact = readFileSync("tooling/runtime/build-artifact.ts", "utf8");
  const entry = readFileSync("tooling/runtime/kernel-entry.ts", "utf8");
  const launcher = readFileSync("packages/kernel/src/hosting/container-host-launcher.ts", "utf8");
  const connector = readFileSync("packages/kernel/src/hosting/connect-local-container.ts", "utf8");
  const backend = readFileSync("packages/kernel/src/runtime/container-kernel-backend.ts", "utf8");
  const manager = readFileSync("packages/code/src/adapters/workspace-client-manager.ts", "utf8");

  expect(base).not.toContain("COPY --from=artifact");
  expect(base).not.toContain("/clarvis-runtime");
  for (const flag of [
    "--compile",
    "--env=disable",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "--reject-unresolved",
  ])
    expect(artifact, flag).toContain(flag);
  expect(artifact).toContain('plan.engine === "podman" ? ["--userns=keep-id"] : []');
  expect(artifact).toContain('plan.engine === "podman" ? ["--security-opt", "label=disable"] : []');
  expect(artifact).toContain('"--format=ustar"');
  expect(entry).toContain('from "ajv"');
  expect(entry).toContain('from "ajv-formats"');
  expect(entry).toContain("installBundledAjvModules({ Ajv, addFormats:");

  expect(launcher).not.toContain("executeRun");
  expect(launcher).not.toContain("createFileKernel");
  expect(connector).toContain("launchContainerKernel");
  expect(connector.indexOf("ports.acquireLease ?? acquireLocalLease")).toBeLessThan(
    connector.indexOf("ports.prepareVolumes ?? prepareContainerVolumes"),
  );
  expect(backend).toContain('engine === "podman" ? ["--unsetenv-all"] : []');
  expect(backend).toContain('"--cap-drop",\n    "ALL"');
  expect(backend).toContain('"--read-only"');
  expect(backend).toContain('"no-new-privileges=true"');
  expect(manager).toContain("connectLocalContainerKernel");
  expect(manager).not.toContain("createFileKernel(");
  expect(launcher).not.toContain("operator.config.");
  expect(launcher).not.toContain("operator.secrets.");
});
