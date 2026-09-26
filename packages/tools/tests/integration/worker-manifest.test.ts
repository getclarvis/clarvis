import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createExecutionPolicy, SandboxSetupError, type SandboxBackend } from "@clarvis/sandbox";
import { createAgentTools, SandboxToolExecutor } from "../../src/index.ts";

test("a changed worker source is rejected and its repaired manifest is rechecked", async () => {
  const root = mkdtempSync(join(process.cwd(), ".worker-identity-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const install = join(root, "install");
  const scratch = join(root, "scratch");
  for (const path of [workspace, home, install, scratch]) mkdirSync(path);
  const workerPath = join(install, "src", "execution", "worker.ts");
  mkdirSync(dirname(workerPath), { recursive: true });
  mkdirSync(join(install, "assets"));
  writeFileSync(workerPath, "changed source");
  writeFileSync(
    join(install, "assets", "worker.manifest.json"),
    JSON.stringify({
      format: 1,
      protocol: 1,
      os: process.platform,
      architecture: process.arch,
      executables: ["bun", "worker.ts"],
      assets: { "worker.ts": { path: "worker.ts", sha256: "0".repeat(64) } },
    }),
  );
  let launches = 0;
  const backend: SandboxBackend = {
    name: "bubblewrap",
    capabilities: {
      pidNamespace: true,
      mountNamespace: true,
      ipcNamespace: true,
      networkIsolation: true,
    },
    prepare() {
      launches++;
      throw new SandboxSetupError("sandbox_unavailable", "test backend has no native launcher");
    },
  };
  const policy = createExecutionPolicy({
    id: "worker-identity",
    mode: "sandbox",
    workspaceRoot: workspace,
    homeRoot: home,
    globalRoot: join(home, ".clarvis"),
    temporaryWriteRoots: [scratch],
    installationRoots: [install, dirname(realpathSync(process.execPath))],
  });
  const tools = createAgentTools({
    workspaceRoot: workspace,
    temporaryRoots: [scratch],
    executionPolicy: policy,
    sandboxBackend: backend,
    executionPort: new SandboxToolExecutor(policy, backend, scratch, workerPath),
  });
  try {
    const result = await tools.callTool("read_file", { path: "file.txt" });
    expect(result.isError).toBe(true);
    expect(
      JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "{}"),
    ).toMatchObject({
      error: "sandbox_setup_failed",
      execution_started: false,
      execution_mode: "sandbox",
      execution_backend: "bubblewrap",
      policy_id: policy.id,
    });
    expect(launches).toBe(0);
    writeFileSync(
      join(install, "assets", "worker.manifest.json"),
      JSON.stringify({
        format: 1,
        protocol: 1,
        os: process.platform,
        architecture: process.arch,
        executables: ["bun", "worker.ts"],
        assets: {
          "worker.ts": {
            path: "worker.ts",
            sha256: createHash("sha256").update("changed source").digest("hex"),
          },
        },
      }),
    );
    expect((await tools.callTool("read_file", { path: "file.txt" })).isError).toBe(true);
    expect(launches).toBe(1);
  } finally {
    await tools.close();
    rmSync(root, { recursive: true, force: true });
  }
});
