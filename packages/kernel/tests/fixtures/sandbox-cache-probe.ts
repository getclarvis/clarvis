import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { createSandboxPolicyResolver } from "../../src/sandbox/policy.ts";

export const SANDBOX_CACHE_PROBE_PATH = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const root = process.argv[2];
  if (root === undefined) throw new Error("sandbox cache probe requires its temporary root");

  const globalDir = join(root, "global");
  const workspace = join(root, "workspace");
  const bin = join(root, "runtime", "bin");
  const executable = join(bin, "bun");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
  store.writeSettings("workspace", {
    sandbox: { type: "native", toolchains: { include: ["bun"] } },
  });
  let path = bin;
  const environment = Object.freeze(
    Object.defineProperty({ ...process.env }, "PATH", {
      configurable: false,
      enumerable: true,
      get: () => path,
    }),
  );
  const resolver = createSandboxPolicyResolver(store, workspace, environment);
  const observations: boolean[] = [];
  observations.push((await resolver.inspect()).toolchains[0]?.available === true);
  rmSync(executable);
  observations.push((await resolver.inspect()).toolchains[0]?.available === true);
  observations.push((await resolver.inspect({ refresh: true })).toolchains[0]?.available === true);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const otherBin = join(root, "other");
  mkdirSync(otherBin);
  path = `${otherBin}${delimiter}${bin}`;
  observations.push((await resolver.inspect()).toolchains[0]?.available === true);
  process.stdout.write(`${JSON.stringify(observations)}\n`);
}

if (import.meta.main) await main();
