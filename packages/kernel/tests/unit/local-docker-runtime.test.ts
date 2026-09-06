import { describe, expect, it } from "bun:test";
import type { ExecuteRunDeps } from "@clarvis/loop";

import {
  runtimeSettingsSchema,
  type DockerCommandResult,
  type DockerControl,
} from "../../src/index.ts";
import { createLocalDockerRuntime } from "../../src/runtime/local-docker-runtime.ts";

const digest = `sha256:${"d".repeat(64)}`;

function input(
  over: Partial<Parameters<typeof createLocalDockerRuntime>[0]["settings"]> = {},
): Parameters<typeof createLocalDockerRuntime>[0] {
  const settings = runtimeSettingsSchema.parse({
    backend: "docker",
    network: "outbound",
    limits: {
      cpu_count: 1,
      memory_bytes: 64 * 1024 * 1024,
      process_count: 32,
      output_bytes: 1024 * 1024,
      storage_bytes: 128 * 1024 * 1024,
    },
    executable: "/injected/docker",
    connection: "test",
    ...over,
  });
  if (settings.backend !== "docker") throw new Error("expected Docker settings");
  return {
    generation: "docker-composition",
    ownerId: "owner",
    project: { id: "project" },
    workspace: { id: "workspace", projectId: "project", label: "main", kind: "primary" },
    workspaceRoot: "/definitely/missing/clarvis-workspace",
    configurationRevision: "config",
    extensionRevision: "extensions",
    deps: {} as ExecuteRunDeps,
    settings,
  };
}

function control(
  respond: (args: readonly string[]) => DockerCommandResult | Promise<DockerCommandResult>,
): DockerControl {
  return {
    run: async (args) => respond(args),
    attach: () => {
      throw new Error("attach is outside this test");
    },
  };
}

describe("local Docker runtime composition", () => {
  it("requires the Docker backend", async () => {
    const podman = runtimeSettingsSchema.parse({
      backend: "podman",
      image_digest: digest,
      network: "none",
      limits: {
        cpu_count: 1,
        memory_bytes: 1,
        process_count: 1,
        output_bytes: 1,
        storage_bytes: 1,
      },
      executable: "/usr/bin/podman",
      connection: "local",
    });
    await expect(
      createLocalDockerRuntime({ ...input(), settings: podman } as Parameters<
        typeof createLocalDockerRuntime
      >[0]),
    ).rejects.toThrow("requires backend: docker");
  });

  it("maps context discovery failures and rejects malformed context output", async () => {
    const withoutConnection = input({ connection: undefined });
    await expect(
      createLocalDockerRuntime(withoutConnection, {
        processRunner: { run: () => Promise.reject(new Error("spawn failed")) },
        resolveImage: () => Promise.reject(new Error("unreachable")),
      }),
    ).rejects.toMatchObject({ code: "engine_missing" });

    for (const result of [
      { exitCode: 1, stdout: "default", stderr: "failed" },
      { exitCode: 0, stdout: "   ", stderr: "" },
      { exitCode: 0, stdout: "one\ntwo", stderr: "" },
      { exitCode: 0, stdout: "one\0two", stderr: "" },
    ]) {
      await expect(
        createLocalDockerRuntime(withoutConnection, {
          processRunner: { run: () => Promise.resolve(result) },
          resolveImage: () => Promise.reject(new Error("unreachable")),
        }),
      ).rejects.toMatchObject({ code: "operational_failure" });
    }

    const calls: unknown[] = [];
    await expect(
      createLocalDockerRuntime(withoutConnection, {
        processRunner: {
          run: (request) => {
            calls.push(request);
            return Promise.resolve({ exitCode: 0, stdout: "desktop-linux\n", stderr: "" });
          },
        },
        resolveImage: () => Promise.reject(new Error("manifest unavailable")),
      }),
    ).rejects.toMatchObject({ code: "operational_failure" });
    expect(calls).toHaveLength(1);
  });

  it("classifies release-manifest resolution failures", async () => {
    const injected = control(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    await expect(
      createLocalDockerRuntime(input(), {
        control: injected,
        resolveImage: () =>
          Promise.reject(
            Object.assign(new Error("bad signature"), { code: "runtime_image_integrity" }),
          ),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_launch_spec" }));
    await expect(
      createLocalDockerRuntime(input(), {
        control: injected,
        resolveImage: () => Promise.reject(new Error("registry offline")),
      }),
    ).rejects.toMatchObject({ code: "operational_failure" });
  });

  it("accepts only local tags or immutable pull references", async () => {
    const injected = control(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    for (const selection of [
      { reference: "registry.example/clarvis:latest", pull: true },
      { reference: "UPPERCASE", pull: false },
      { reference: "registry.example/clarvis@sha256:short", pull: true },
    ]) {
      await expect(
        createLocalDockerRuntime(input(), {
          control: injected,
          resolveImage: () => Promise.resolve(selection),
        }),
      ).rejects.toThrow("reference is invalid");
    }
  });

  it("reports pull, inspect and Docker image identity failures", async () => {
    const pinned = `registry.example/clarvis/runtime@${digest}`;
    await expect(
      createLocalDockerRuntime(input(), {
        control: control((args) =>
          Promise.resolve({
            exitCode: args[0] === "pull" ? 1 : 0,
            stdout: "",
            stderr: "failed",
          }),
        ),
        resolveImage: () => Promise.resolve({ reference: pinned, pull: true }),
      }),
    ).rejects.toThrow("download failed");

    await expect(
      createLocalDockerRuntime(input(), {
        control: control(() => Promise.resolve({ exitCode: 1, stdout: "", stderr: "missing" })),
        resolveImage: () =>
          Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
      }),
    ).rejects.toThrow("not installed");

    for (const stdout of ["not-json", "null", "[]", JSON.stringify({ Id: "sha256:bad" })]) {
      await expect(
        createLocalDockerRuntime(input(), {
          control: control(() => Promise.resolve({ exitCode: 0, stdout, stderr: "" })),
          resolveImage: () =>
            Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
        }),
      ).rejects.toThrow("invalid runtime image id");
    }
  });

  it("pins a resolved image id before inspecting the selected backend", async () => {
    const calls: string[][] = [];
    await expect(
      createLocalDockerRuntime(input(), {
        control: control((args) => {
          calls.push([...args]);
          return Promise.resolve({
            exitCode: 0,
            stdout: args[0] === "image" ? JSON.stringify([{ Id: digest }]) : "",
            stderr: "",
          });
        }),
        resolveImage: () =>
          Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
      }),
    ).rejects.toThrow("docker info returned invalid JSON");
    expect(calls).toEqual([
      ["image", "inspect", "clarvis-runtime:development"],
      ["info", "--format", "{{json .}}"],
    ]);
  });
});
