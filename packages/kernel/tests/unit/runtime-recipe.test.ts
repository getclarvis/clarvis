import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { HOME_ENV } from "@clarvis/paths";

import type { DockerCommandResult, DockerControl } from "../../src/index.ts";
import { resolveDockerRuntimeRecipe } from "../../src/runtime/runtime-recipe.ts";

const baseDigest = `sha256:${"b".repeat(64)}`;
const derivedDigest = `sha256:${"d".repeat(64)}`;
const baseLabels = {
  "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
  "io.clarvis.base.revision": "c".repeat(64),
};

function image(id: string, labels: Readonly<Record<string, string>>): string {
  return JSON.stringify([{ Id: id, Config: { Labels: labels } }]);
}

function attachedNever(): ReturnType<DockerControl["attach"]> {
  throw new Error("attach is outside runtime recipe tests");
}

function labelsFromBuild(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = { ...baseLabels };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const pair = args[index + 1] ?? "";
    const separator = pair.indexOf("=");
    labels[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return labels;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-recipe-test-"));
  const recipeDir = join(root, "home", "runtime-recipes");
  await mkdir(recipeDir, { recursive: true });
  const script = join(recipeDir, "recipe.sh");
  await writeFile(script, "apt-get update\nprintf 'installed' > /opt/recipe-proof\n");
  return { root, script, roots: { env: { [HOME_ENV]: join(root, "home") } } };
}

describe("Docker runtime base recipe", () => {
  test("keys the derived image by base identity and captured recipe bytes", async () => {
    const files = await fixture();
    const calls: string[][] = [];
    let built = false;
    let builtLabels: Record<string, string> = {};
    let buildContext = "";
    try {
      const control: DockerControl = {
        async run(args, _signal, options): Promise<DockerCommandResult> {
          calls.push([...args]);
          if (args[0] === "image" && args[2] === baseDigest)
            return { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" };
          if (args[0] === "image" && args[1] === "tag")
            return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:"))
            return { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" };
          if (args[0] === "image")
            return built
              ? { exitCode: 0, stdout: image(derivedDigest, builtLabels), stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing" };
          if (args[0] === "build") {
            expect(options?.timeoutMs).toBe(30 * 60 * 1_000);
            builtLabels = labelsFromBuild(args);
            buildContext = args.at(-1) ?? "";
            expect((await readdir(buildContext)).sort()).toEqual([
              ".dockerignore",
              "Containerfile",
              "recipe.sh",
            ]);
            expect(await readFile(join(buildContext, "recipe.sh"), "utf8")).toContain("installed");
            expect(await readFile(join(buildContext, "Containerfile"), "utf8")).not.toContain(
              "COPY",
            );
            built = true;
            return { exitCode: 0, stdout: derivedDigest, stderr: "" };
          }
          throw new Error(`unexpected Docker call: ${args.join(" ")}`);
        },
        attach: attachedNever,
      };
      const options = {
        baseImageDigest: baseDigest,
        recipe: { name: "java-25", script: files.script, network: "outbound" as const },
        control,
        roots: files.roots,
        temporaryRoot: files.root,
      };
      await expect(resolveDockerRuntimeRecipe(options)).resolves.toBe(derivedDigest);
      await expect(resolveDockerRuntimeRecipe(options)).resolves.toBe(derivedDigest);
      expect(calls.filter((call) => call[0] === "build")).toHaveLength(1);
      expect(calls.find((call) => call[0] === "build")).toContain("--network=default");
      expect(calls.find((call) => call[0] === "build")).not.toContain(files.script);
      await expect(lstat(buildContext)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  test("fails closed before a build for an unsafe script or mismatched base", async () => {
    const files = await fixture();
    let builds = 0;
    try {
      const control = (labels: Readonly<Record<string, string>>): DockerControl => ({
        async run(args) {
          if (args[0] === "build") builds += 1;
          if (args[0] === "image" && args[2] === baseDigest)
            return { exitCode: 0, stdout: image(baseDigest, labels), stderr: "" };
          return { exitCode: 1, stdout: "", stderr: "missing" };
        },
        attach: attachedNever,
      });
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "unsafe", script: "relative.sh", network: "none" },
          control: control(baseLabels),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "drift", script: files.script, network: "none" },
          control: control({ ...baseLabels, "io.clarvis.base.abi": "other" }),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "handshake_mismatch" });
      expect(builds).toBe(0);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  test("classifies engine and base inspection failures without exposing raw diagnostics", async () => {
    const files = await fixture();
    try {
      for (const scenario of [
        {
          run: async () => ({ exitCode: 1, stdout: "", stderr: "secret base error" }),
          message: "base image is not installed",
        },
        {
          run: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
          message: "invalid JSON",
        },
        {
          run: async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: "short" }]), stderr: "" }),
          message: "invalid image id",
        },
        {
          run: async () => {
            throw new Error("engine transport failed");
          },
          message: "could not be executed",
        },
      ]) {
        await expect(
          resolveDockerRuntimeRecipe({
            baseImageDigest: baseDigest,
            recipe: { name: "failure", script: files.script, network: "none" },
            control: { run: scenario.run, attach: attachedNever },
            roots: files.roots,
          }),
        ).rejects.toThrow(scenario.message);
      }
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe recipe roots and script bytes before cache or build", async () => {
    const files = await fixture();
    const outside = join(files.root, "outside.sh");
    const empty = join(files.root, "home", "runtime-recipes", "empty.sh");
    const invalid = join(files.root, "home", "runtime-recipes", "invalid.sh");
    const nul = join(files.root, "home", "runtime-recipes", "nul.sh");
    await Promise.all([
      writeFile(outside, "echo outside\n"),
      writeFile(empty, ""),
      writeFile(invalid, new Uint8Array([0xff, 0xfe])),
      writeFile(nul, new Uint8Array([0x65, 0x00, 0x66])),
    ]);
    const control: DockerControl = {
      run: async (args) =>
        args[0] === "image" && args[2] === baseDigest
          ? { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "missing" },
      attach: attachedNever,
    };
    try {
      for (const script of [outside, empty, invalid, nul])
        await expect(
          resolveDockerRuntimeRecipe({
            baseImageDigest: baseDigest,
            recipe: { name: "unsafe", script, network: "none" },
            control,
            roots: files.roots,
          }),
        ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "missing-root", script: outside, network: "none" },
          control,
          roots: { env: { [HOME_ENV]: join(files.root, "missing-home") } },
        }),
      ).rejects.toThrow("directory is unavailable or unsafe");
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  test("refuses a poisoned content-addressed recipe cache", async () => {
    const files = await fixture();
    try {
      const control: DockerControl = {
        run: async (args) => {
          if (args[0] === "image" && args[2] === baseDigest)
            return { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" };
          if (args[0] === "image")
            return {
              exitCode: 0,
              stdout: image(derivedDigest, {
                ...baseLabels,
                "io.clarvis.runtime.recipe.key": "wrong",
              }),
              stderr: "",
            };
          throw new Error("unexpected build");
        },
        attach: attachedNever,
      };
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "poisoned", script: files.script, network: "none" },
          control,
          roots: files.roots,
        }),
      ).rejects.toThrow("cache identity did not match");
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  test("fails closed at each private base and image build boundary", async () => {
    const files = await fixture();
    try {
      for (const stage of ["tag", "base-reference", "base-drift", "build", "post-build"] as const) {
        let built = false;
        let builtLabels: Record<string, string> = {};
        const control: DockerControl = {
          async run(args) {
            if (args[0] === "image" && args[1] === "tag")
              return stage === "tag"
                ? { exitCode: 1, stdout: "", stderr: "tag failed" }
                : { exitCode: 0, stdout: "", stderr: "" };
            if (args[0] === "image" && args[2] === baseDigest)
              return { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" };
            if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
              if (stage === "base-reference") return { exitCode: 1, stdout: "", stderr: "missing" };
              return {
                exitCode: 0,
                stdout: image(stage === "base-drift" ? derivedDigest : baseDigest, baseLabels),
                stderr: "",
              };
            }
            if (args[0] === "image")
              return built && stage !== "post-build"
                ? { exitCode: 0, stdout: image(derivedDigest, builtLabels), stderr: "" }
                : { exitCode: 1, stdout: "", stderr: "missing" };
            if (args[0] === "build") {
              built = true;
              builtLabels = labelsFromBuild(args);
              return stage === "build"
                ? {
                    exitCode: 9,
                    stdout: "",
                    stderr: "\u001b[31msecret\tbuild\nfailed\u001b[0m",
                  }
                : { exitCode: 0, stdout: derivedDigest, stderr: "" };
            }
            throw new Error(`unexpected Docker call: ${args.join(" ")}`);
          },
          attach: attachedNever,
        };
        await expect(
          resolveDockerRuntimeRecipe({
            baseImageDigest: baseDigest,
            recipe: { name: `failure-${stage}`, script: files.script, network: "none" },
            control,
            roots: files.roots,
            temporaryRoot: files.root,
          }),
        ).rejects.toMatchObject({
          code: stage === "base-drift" ? "handshake_mismatch" : "runtime_recipe_failed",
        });
      }
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "announcement", script: files.script, network: "none" },
          control: {
            run: async (args) =>
              args[0] === "image" && args[2] === baseDigest
                ? { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" }
                : { exitCode: 1, stdout: "", stderr: "missing" },
            attach: attachedNever,
          },
          roots: files.roots,
          onPreparation: () => {
            throw new Error("listener failed");
          },
        }),
      ).rejects.toThrow("could not be announced");
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  test("classifies private context and cancelled coordination failures", async () => {
    const files = await fixture();
    const control: DockerControl = {
      async run(args) {
        if (args[0] === "image" && args[1] === "tag")
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "image" && args[2] === baseDigest)
          return { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" };
        if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:"))
          return { exitCode: 0, stdout: image(baseDigest, baseLabels), stderr: "" };
        if (args[0] === "image") return { exitCode: 1, stdout: "", stderr: "missing" };
        throw new Error(`unexpected Docker call: ${args.join(" ")}`);
      },
      attach: attachedNever,
    };
    try {
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "context-failure", script: files.script, network: "none" },
          control,
          roots: files.roots,
          temporaryRoot: files.script,
        }),
      ).rejects.toThrow("build context could not be created");
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "cancelled", script: files.script, network: "none" },
          control,
          roots: files.roots,
          signal: AbortSignal.abort(new Error("cancelled")),
        }),
      ).rejects.toThrow("build coordination failed");
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
});
