import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { HOME_ENV } from "@clarvis/paths";

import type { DockerControl } from "../../src/index.ts";
import { createNodeDockerControl } from "../../src/local.ts";
import { resolveDockerRuntimeRecipe } from "../../src/runtime/runtime-recipe.ts";

const baseImageDigest = process.env.CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST;
const context = process.env.CLARVIS_DOCKER_RUNTIME_CONTEXT;
const enabled =
  process.env.CLARVIS_DOCKER_RUNTIME_CANARY === "1" &&
  /^sha256:[a-f0-9]{64}$/u.test(baseImageDigest ?? "") &&
  typeof context === "string" &&
  context.length > 0;

test.skipIf(!enabled)(
  "builds and reuses an operator recipe through a real Docker or Colima engine",
  async () => {
    const executable = Bun.which("docker");
    if (executable === null || baseImageDigest === undefined || context === undefined) {
      throw new Error("Docker recipe canary inputs disappeared after admission");
    }
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-recipe-e2e-"));
    const recipeDir = join(root, "home", "runtime-recipes");
    await mkdir(recipeDir, { recursive: true });
    const script = join(recipeDir, "recipe.sh");
    await writeFile(
      script,
      "install -d /opt/clarvis-runtime-recipe\nprintf '%s' 'recipe-e2e-v1' > /opt/clarvis-runtime-recipe/proof\n",
    );
    const nodeControl = createNodeDockerControl({
      executable,
      context,
      environment: Object.fromEntries(
        ["HOME", "PATH"].flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    });
    const calls: string[][] = [];
    let lastDockerStderr = "";
    const control: DockerControl = {
      async run(args, signal, options) {
        calls.push([...args]);
        const result = await nodeControl.run(args, signal, options);
        lastDockerStderr = result.stderr.slice(-4_096);
        return result;
      },
      attach: (args) => nodeControl.attach(args),
    };
    const options = {
      baseImageDigest,
      recipe: { name: "e2e-v1", script, network: "none" as const },
      control,
      roots: { env: { [HOME_ENV]: join(root, "home") } },
    };
    try {
      const first = await resolveDockerRuntimeRecipe(options).catch((cause: unknown) => {
        throw new Error(`Docker recipe canary failed: ${lastDockerStderr}`, { cause });
      });
      const buildsAfterFirst = calls.filter((call) => call[0] === "build").length;
      const second = await resolveDockerRuntimeRecipe(options);
      expect(second).toBe(first);
      expect(calls.filter((call) => call[0] === "build")).toHaveLength(buildsAfterFirst);
      const proof = await nodeControl.run([
        "run",
        "--rm",
        "--read-only",
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        first,
        "-c",
        'test "$(cat /opt/clarvis-runtime-recipe/proof)" = recipe-e2e-v1',
      ]);
      expect(proof).toMatchObject({ exitCode: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
