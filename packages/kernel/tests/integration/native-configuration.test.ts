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
        runtime: { backend, ...(backend === "docker" ? { fallback: "fail" } : {}) },
      }),
    );
    let nativeRuns = 0;
    let containerStarts = 0;
    const kernel = await createFileKernel({
      workspaceRoot,
      globalDir,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      subscriptions: false,
      builtins: { hooks: false, tasks: false },
      executeRun: async () => {
        nativeRuns++;
        throw new Error("unexpected native inference");
      },
      runtimeFactory: {
        create: async () => {
          containerStarts++;
          throw new Error("ordinary placement");
        },
      },
    });
    try {
      const run = await kernel.runs.start({
        messages: [{ role: "user", content: "Create a local reviewer." }],
        skill: { name: "clarvis-configure", task: "Create a local reviewer." },
      });
      let prompts = 0;
      run.onElicit((request) => {
        prompts++;
        void run.respond({ id: request.id, action: "decline" });
      });
      const result = await run.done;
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("Isolation Sandbox or Host");
      expect(nativeRuns).toBe(0);
      expect(containerStarts).toBe(0);
      expect(prompts).toBe(0);
      const ordinary = await kernel.runs.start({
        messages: [{ role: "user", content: "Inspect the project." }],
        agent: "coder",
      });
      expect((await ordinary.done).status).toBe("failed");
      expect(containerStarts).toBe(1);
      expect(nativeRuns).toBe(0);
    } finally {
      await kernel.close();
    }
  },
);
