import { describe, expect, it } from "bun:test";
import type { ExecuteRunDeps } from "@clarvis/loop";

import {
  runtimeSettingsSchema,
  type PodmanCommandResult,
  type PodmanControl,
} from "../../src/index.ts";
import { createLocalPodmanRuntime } from "../../src/runtime/local-podman-runtime.ts";

const digest = `sha256:${"d".repeat(64)}`;

function input(
  over: Partial<Parameters<typeof createLocalPodmanRuntime>[0]["settings"]> = {},
): Parameters<typeof createLocalPodmanRuntime>[0] {
  const settings = runtimeSettingsSchema.parse({
    backend: "podman",
    ...over,
  });
  if (settings.backend !== "podman") throw new Error("expected Podman settings");
  return {
    generation: "podman-composition",
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
  respond: (args: readonly string[]) => PodmanCommandResult | Promise<PodmanCommandResult>,
): PodmanControl {
  return {
    run: async (args) => respond(args),
    attach: () => {
      throw new Error("attach is outside this test");
    },
  };
}

describe("local Podman runtime composition", () => {
  it("requires the Podman backend", async () => {
    const docker = runtimeSettingsSchema.parse({ backend: "docker" });
    await expect(
      createLocalPodmanRuntime({ ...input(), settings: docker } as Parameters<
        typeof createLocalPodmanRuntime
      >[0]),
    ).rejects.toThrow("requires backend: podman");
  });

  it("resolves a simple selection through the shared image helper before inspecting Podman", async () => {
    const calls: string[][] = [];
    await expect(
      createLocalPodmanRuntime(input(), {
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
    ).rejects.toThrow("podman info returned invalid JSON");
    expect(calls).toEqual([
      ["image", "inspect", "clarvis-runtime:development"],
      ["info", "--format", "json"],
    ]);
  });

  it("canonicalizes a Podman unprefixed local image id before engine inspect", async () => {
    const calls: string[][] = [];
    await expect(
      createLocalPodmanRuntime(input(), {
        control: control((args) => {
          calls.push([...args]);
          return Promise.resolve({
            exitCode: 0,
            stdout: args[0] === "image" ? JSON.stringify([{ Id: "d".repeat(64) }]) : "",
            stderr: "",
          });
        }),
        resolveImage: () =>
          Promise.resolve({ reference: "clarvis-runtime:development", pull: false }),
      }),
    ).rejects.toThrow("podman info returned invalid JSON");
    expect(calls).toEqual([
      ["image", "inspect", "clarvis-runtime:development"],
      ["info", "--format", "json"],
    ]);
  });
});
