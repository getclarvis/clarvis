import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["docker", "podman"] as const)(
  "rejects configuration in %s before inference or a runtime switch",
  async (backend) => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-configuration-placement-"));
    temporary.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    mkdirSync(workspaceRoot);
    mkdirSync(globalDir);
    writeFileSync(
      globalPaths(globalDir).settingsFile,
      JSON.stringify({
        default_model: "anthropic/test",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        runtime: { backend },
      }),
    );
    await expect(
      createFileKernel({
        workspaceRoot,
        globalDir,
        logger: NOOP_LOGGER,
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
        subscriptions: false,
        builtins: { hooks: false, tasks: false },
      }),
    ).rejects.toThrow("connectLocalContainerKernel");
  },
);
