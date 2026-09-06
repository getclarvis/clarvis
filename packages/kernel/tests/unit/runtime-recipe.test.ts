import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { HOME_ENV } from "@clarvis/paths";

import type { DockerCommandResult, DockerControl } from "../../src/index.ts";
import { RUNTIME_PROTOCOL_LABEL, RUNTIME_PROTOCOL_REVISION } from "../../src/index.ts";
import { resolveDockerRuntimeRecipe } from "../../src/runtime/runtime-recipe.ts";

const baseDigest = `sha256:${"b".repeat(64)}`;
const derivedDigest = `sha256:${"d".repeat(64)}`;

function image(id: string, labels: Readonly<Record<string, string>>): string {
  return JSON.stringify([{ Id: id, Config: { Labels: labels } }]);
}

function attachedNever(): ReturnType<DockerControl["attach"]> {
  throw new Error("attach is outside runtime recipe tests");
}

function labelsFromBuild(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {
    [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const pair = args[index + 1] ?? "";
    const separator = pair.indexOf("=");
    labels[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return labels;
}

async function fixture(): Promise<{
  root: string;
  recipeDir: string;
  script: string;
  roots: { env: Record<string, string> };
}> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-recipe-test-"));
  const recipeDir = join(root, "home", "runtime-recipes");
  await mkdir(recipeDir, { recursive: true });
  const script = join(recipeDir, "recipe.sh");
  await writeFile(script, "apt-get update\nprintf 'installed' > /opt/recipe-proof\n");
  return {
    root,
    recipeDir,
    script,
    roots: { env: { [HOME_ENV]: join(root, "home") } },
  };
}

describe("Docker runtime recipe", () => {
  it("builds from captured bytes in a minimal context and pins the derived image id", async () => {
    const files = await fixture();
    const calls: string[][] = [];
    let built = false;
    let builtLabels: Record<string, string> = {};
    let buildContext = "";
    const preparations: string[] = [];
    try {
      const control: DockerControl = {
        async run(args, _signal, options): Promise<DockerCommandResult> {
          calls.push([...args]);
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image" && args[1] === "tag") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image") {
            return built
              ? { exitCode: 0, stdout: image(derivedDigest, builtLabels), stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing" };
          }
          if (args[0] === "build") {
            expect(options?.timeoutMs).toBe(30 * 60 * 1_000);
            builtLabels = labelsFromBuild(args);
            buildContext = args.at(-1) ?? "";
            expect((await readdir(buildContext)).sort()).toEqual([
              ".dockerignore",
              "Containerfile",
              "recipe.sh",
            ]);
            expect(await readFile(join(buildContext, "recipe.sh"), "utf8")).toBe(
              "apt-get update\nprintf 'installed' > /opt/recipe-proof\n",
            );
            const dockerfile = await readFile(join(buildContext, "Containerfile"), "utf8");
            expect(dockerfile).toContain("FROM ${CLARVIS_RUNTIME_BASE}");
            expect(dockerfile).toContain("USER root");
            expect(dockerfile).toContain("--mount=type=bind,source=recipe.sh");
            expect(dockerfile).not.toContain("COPY");
            built = true;
            return { exitCode: 0, stdout: `${derivedDigest}\n`, stderr: "" };
          }
          throw new Error(`unexpected Docker call: ${args.join(" ")}`);
        },
        attach: attachedNever,
      };
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "outbound" },
          control,
          roots: files.roots,
          temporaryRoot: files.root,
          onPreparation: (name) => preparations.push(name),
        }),
      ).resolves.toBe(derivedDigest);
      expect(preparations).toEqual(["java-25"]);
      const build = calls.find((call) => call[0] === "build")!;
      expect(build).toContain(
        `CLARVIS_RUNTIME_BASE=clarvis-runtime-recipe-base:${baseDigest.slice("sha256:".length)}`,
      );
      expect(build).toContain("--network=default");
      expect(build).toContain("HTTP_PROXY=");
      expect(build).toContain("http_proxy=");
      expect(build).not.toContain(files.script);
      await expect(lstat(buildContext)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("reuses an exactly labelled content-addressed image without rebuilding", async () => {
    const files = await fixture();
    let built = false;
    let builtLabels: Record<string, string> = {};
    let builds = 0;
    try {
      const control: DockerControl = {
        async run(args) {
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image" && args[1] === "tag") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image") {
            return built
              ? { exitCode: 0, stdout: image(derivedDigest, builtLabels), stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing" };
          }
          if (args[0] === "build") {
            builds += 1;
            builtLabels = labelsFromBuild(args);
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
      };
      await expect(resolveDockerRuntimeRecipe(options)).resolves.toBe(derivedDigest);
      let repeatedPreparation = false;
      await expect(
        resolveDockerRuntimeRecipe({
          ...options,
          onPreparation: () => {
            repeatedPreparation = true;
          },
        }),
      ).resolves.toBe(derivedDigest);
      expect(builds).toBe(1);
      expect(repeatedPreparation).toBe(false);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("fails closed for unsafe scripts, base drift, cache drift and build failures", async () => {
    const files = await fixture();
    try {
      const baseControl = (protocol = RUNTIME_PROTOCOL_REVISION): DockerControl => ({
        run: async (args) => {
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, { [RUNTIME_PROTOCOL_LABEL]: protocol }),
              stderr: "",
            };
          }
          return { exitCode: 1, stdout: "", stderr: "missing" };
        },
        attach: attachedNever,
      });
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: "relative.sh", network: "none" },
          control: baseControl(),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      const hardlinked = join(files.recipeDir, "hardlinked.sh");
      await writeFile(hardlinked, "true\n");
      await link(hardlinked, join(files.root, "hardlinked-alias.sh"));
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: hardlinked, network: "none" },
          control: baseControl(),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      const symlinkPath = join(files.recipeDir, "recipe-link.sh");
      await symlink(files.script, symlinkPath);
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: symlinkPath, network: "none" },
          control: baseControl(),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      const outside = join(files.root, "outside.sh");
      await writeFile(outside, "true\n");
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: outside, network: "none" },
          control: baseControl(),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      for (const [name, bytes] of [
        ["empty.sh", Buffer.alloc(0)],
        ["nul.sh", Buffer.from([0])],
        ["invalid-utf8.sh", Buffer.from([0xff])],
      ] as const) {
        const invalid = join(files.recipeDir, name);
        await writeFile(invalid, bytes);
        await expect(
          resolveDockerRuntimeRecipe({
            baseImageDigest: baseDigest,
            recipe: { name: "java-25", script: invalid, network: "none" },
            control: baseControl(),
            roots: files.roots,
          }),
        ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      }
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "none" },
          control: baseControl("wrong"),
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "handshake_mismatch" });
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "none" },
          control: {
            run: async () => {
              throw new Error("Docker transport failed");
            },
            attach: attachedNever,
          },
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_failed" });
      const throwingEnvironment = Object.create(null) as Record<string, string>;
      Object.defineProperty(throwingEnvironment, HOME_ENV, {
        get() {
          throw new Error("root lookup failed");
        },
      });
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "none" },
          control: baseControl(),
          roots: { env: throwingEnvironment },
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_failed" });

      const corruptCache: DockerControl = {
        run: async (args) => {
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          return {
            exitCode: 0,
            stdout: image(derivedDigest, {
              [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
            }),
            stderr: "",
          };
        },
        attach: attachedNever,
      };
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "none" },
          control: corruptCache,
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_failed" });

      const failedBuild: DockerControl = {
        run: async (args) => {
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image" && args[1] === "tag") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "build") {
            return {
              exitCode: 23,
              stdout: "",
              stderr: "config api_key=OPAQUEvalue123 loaded",
            };
          }
          return { exitCode: 1, stdout: "", stderr: "missing" };
        },
        attach: attachedNever,
      };
      const buildError = await resolveDockerRuntimeRecipe({
        baseImageDigest: baseDigest,
        recipe: { name: "java-25", script: files.script, network: "none" },
        control: failedBuild,
        roots: files.roots,
        temporaryRoot: files.root,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(buildError).toMatchObject({ code: "runtime_recipe_failed" });
      expect(buildError).toBeInstanceOf(Error);
      if (buildError instanceof Error) {
        expect(buildError.message).not.toContain("OPAQUEvalue123");
        expect(buildError.message).toContain("[redacted]");
      }
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "none" },
          control: failedBuild,
          roots: files.roots,
          temporaryRoot: join(files.root, "missing-temporary-root"),
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_failed" });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic global recipe directory", async () => {
    const files = await fixture();
    try {
      const actual = join(files.root, "actual-recipes");
      await mkdir(actual);
      const script = join(actual, "recipe.sh");
      await writeFile(script, "true\n");
      await rm(files.recipeDir, { recursive: true });
      await symlink(actual, files.recipeDir, "dir");
      const control: DockerControl = {
        async run() {
          return {
            exitCode: 0,
            stdout: image(baseDigest, {
              [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
            }),
            stderr: "",
          };
        },
        attach: attachedNever,
      };
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "linked-root", script, network: "none" },
          control,
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent cache misses through the host lease", async () => {
    const files = await fixture();
    let built = false;
    let builtLabels: Record<string, string> = {};
    let builds = 0;
    try {
      const control: DockerControl = {
        async run(args) {
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image" && args[1] === "tag") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image") {
            return built
              ? { exitCode: 0, stdout: image(derivedDigest, builtLabels), stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing" };
          }
          if (args[0] === "build") {
            builds += 1;
            await Bun.sleep(20);
            builtLabels = labelsFromBuild(args);
            built = true;
            return { exitCode: 0, stdout: derivedDigest, stderr: "" };
          }
          throw new Error(`unexpected Docker call: ${args.join(" ")}`);
        },
        attach: attachedNever,
      };
      const options = {
        baseImageDigest: baseDigest,
        recipe: { name: "coalesced", script: files.script, network: "none" as const },
        control,
        roots: files.roots,
        temporaryRoot: files.root,
      };
      await expect(
        Promise.all([resolveDockerRuntimeRecipe(options), resolveDockerRuntimeRecipe(options)]),
      ).resolves.toEqual([derivedDigest, derivedDigest]);
      expect(builds).toBe(1);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("rejects oversized recipe files before any derived image lookup", async () => {
    const files = await fixture();
    try {
      await mkdir(join(files.recipeDir, "large"));
      const large = join(files.recipeDir, "large", "recipe.sh");
      await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 97));
      let imageInspects = 0;
      const control: DockerControl = {
        run: async (_args) => {
          imageInspects += 1;
          return {
            exitCode: 0,
            stdout: image(baseDigest, {
              [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
            }),
            stderr: "",
          };
        },
        attach: attachedNever,
      };
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "large", script: large, network: "outbound" },
          control,
          roots: files.roots,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_invalid" });
      expect(imageInspects).toBe(1);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("fails closed when build-lease ownership is lost before release", async () => {
    const files = await fixture();
    let built = false;
    let builtLabels: Record<string, string> = {};
    try {
      const control: DockerControl = {
        async run(args) {
          if (args[0] === "image" && args[2] === baseDigest) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image" && args[1] === "tag") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "image" && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
            return {
              exitCode: 0,
              stdout: image(baseDigest, {
                [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
              }),
              stderr: "",
            };
          }
          if (args[0] === "image") {
            return built
              ? { exitCode: 0, stdout: image(derivedDigest, builtLabels), stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing" };
          }
          if (args[0] === "build") {
            builtLabels = labelsFromBuild(args);
            built = true;
            const leaseDirectory = join(files.root, "home", "state", "runtime-recipes");
            const lease = (await readdir(leaseDirectory)).find((name) => name.endsWith(".lock"));
            if (lease === undefined) throw new Error("expected active recipe lease");
            await unlink(join(leaseDirectory, lease));
            return { exitCode: 0, stdout: derivedDigest, stderr: "" };
          }
          throw new Error(`unexpected Docker call: ${args.join(" ")}`);
        },
        attach: attachedNever,
      };
      await expect(
        resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: "java-25", script: files.script, network: "outbound" },
          control,
          roots: files.roots,
          temporaryRoot: files.root,
        }),
      ).rejects.toMatchObject({ code: "runtime_recipe_failed" });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });

  it("reports every image-control boundary that can invalidate a recipe build", async () => {
    const files = await fixture();
    type FailurePoint =
      | "base-missing"
      | "base-invalid-json"
      | "base-invalid-id"
      | "announce"
      | "coordination"
      | "tag"
      | "tag-inspect"
      | "tag-drift"
      | "build-result"
      | "built-image-missing";
    const cases: ReadonlyArray<{
      point: FailurePoint;
      message: string;
      code?: string;
    }> = [
      { point: "base-missing", message: "base image is not installed" },
      { point: "base-invalid-json", message: "returned invalid JSON" },
      { point: "base-invalid-id", message: "returned an invalid image id" },
      { point: "announce", message: "preparation could not be announced" },
      { point: "coordination", message: "build coordination failed" },
      { point: "tag", message: "could not create the private" },
      { point: "tag-inspect", message: "did not retain the private" },
      { point: "tag-drift", message: "base reference changed", code: "handshake_mismatch" },
      { point: "build-result", message: "build context could not be prepared" },
      { point: "built-image-missing", message: "did not retain the completed" },
    ];
    try {
      for (const current of cases) {
        const stateRoot = join(files.root, "home", "state");
        if (current.point === "coordination") await writeFile(stateRoot, "not a directory");
        const control: DockerControl = {
          async run(args) {
            const imageInspect = args[0] === "image" && args[1] === "inspect";
            if (imageInspect && args[2] === baseDigest) {
              if (current.point === "base-missing") {
                return { exitCode: 1, stdout: "", stderr: "missing" };
              }
              if (current.point === "base-invalid-json") {
                return { exitCode: 0, stdout: "not-json", stderr: "" };
              }
              if (current.point === "base-invalid-id") {
                return { exitCode: 0, stdout: JSON.stringify([{ Config: {} }]), stderr: "" };
              }
              return {
                exitCode: 0,
                stdout: image(baseDigest, {
                  [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION,
                }),
                stderr: "",
              };
            }
            if (args[0] === "image" && args[1] === "tag") {
              return current.point === "tag"
                ? { exitCode: 1, stdout: "", stderr: "refused" }
                : { exitCode: 0, stdout: "", stderr: "" };
            }
            if (imageInspect && args[2]?.startsWith("clarvis-runtime-recipe-base:")) {
              if (current.point === "tag-inspect") {
                return { exitCode: 1, stdout: "", stderr: "missing" };
              }
              const id = current.point === "tag-drift" ? derivedDigest : baseDigest;
              return {
                exitCode: 0,
                stdout: image(id, { [RUNTIME_PROTOCOL_LABEL]: RUNTIME_PROTOCOL_REVISION }),
                stderr: "",
              };
            }
            if (args[0] === "build") {
              if (current.point === "build-result") {
                return Object.defineProperty({ stdout: "", stderr: "" }, "exitCode", {
                  get() {
                    throw new Error("invalid build result");
                  },
                }) as DockerCommandResult;
              }
              return { exitCode: 0, stdout: derivedDigest, stderr: "" };
            }
            if (imageInspect) return { exitCode: 1, stdout: "", stderr: "missing" };
            throw new Error(`unexpected Docker call: ${args.join(" ")}`);
          },
          attach: attachedNever,
        };
        const result = resolveDockerRuntimeRecipe({
          baseImageDigest: baseDigest,
          recipe: { name: `failure-${current.point}`, script: files.script, network: "none" },
          control,
          roots: files.roots,
          temporaryRoot: files.root,
          ...(current.point === "announce"
            ? {
                onPreparation: () => {
                  throw new Error("observer failed");
                },
              }
            : {}),
        });
        await expect(result).rejects.toMatchObject({
          code: current.code ?? "runtime_recipe_failed",
          message: expect.stringContaining(current.message),
        });
        if (current.point === "coordination") await unlink(stateRoot);
      }
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
});
