import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ResolvedSandboxSettings } from "@clarvis/loop/host";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { createSandboxPolicyResolver, pinSandboxPolicy } from "../../src/sandbox/policy.ts";
import { environmentFixture } from "../helpers/process-fixtures.ts";
import { SANDBOX_CACHE_PROBE_PATH } from "../fixtures/sandbox-cache-probe.ts";

describe("sandbox host policy", () => {
  it("rejects a changed Sandbox snapshot before another run can use it", () => {
    let current: ResolvedSandboxSettings = {
      type: "native",
      filesystem: "workspace-write",
      network: "none",
      pass_env: ["CI"],
      toolchains: { include: ["bun"] },
      resolved_runtime_paths: ["/opt/runtime"],
    };
    const admitted = pinSandboxPolicy({ resolve: () => current });
    expect(admitted()).toEqual(current);
    expect(Object.isFrozen(admitted())).toBe(true);
    expect(Object.isFrozen(admitted()?.pass_env)).toBe(true);
    expect(Object.isFrozen(admitted()?.toolchains?.include)).toBe(true);
    expect(Object.isFrozen(admitted()?.resolved_runtime_paths)).toBe(true);
    current = { ...current, filesystem: "workspace-read-only" };
    expect(admitted).toThrow("Sandbox policy changed since host startup");
  });
  it("reports effective host-visible reads and the selected write posture", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-access-"));
    const globalDir = join(root, "global");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
    try {
      const resolver = createSandboxPolicyResolver(store, workspace);
      expect((await resolver.inspect()).filesystem).toEqual({
        placement: "host",
        reads: "host-visible",
        writes: "host-os",
        workspace: "read-write",
      });
      store.writeSettings("global", {
        sandbox: {
          type: "native",
          filesystem: "workspace-read-only",
          toolchains: { mode: "manual" },
        },
      });
      expect((await resolver.inspect()).filesystem).toEqual({
        placement: "sandbox",
        reads: "host-visible",
        writes: "declared-roots",
        workspace: "read-only",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1")(
    "inspects a discovered toolchain without executing it through the real native backend",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-policy-canary-"));
      const globalDir = join(root, "global");
      const workspace = join(root, "workspace");
      const bin = join(root, "runtime", "bin");
      const executable = join(bin, "bun");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(executable, "#!/bin/sh\nexit 73\n", { mode: 0o755 });
      const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
      store.writeSettings("workspace", {
        sandbox: { type: "native", toolchains: { include: ["bun"] } },
      });
      const environment = environmentFixture({
        ...process.env,
        PATH: process.env.PATH ? `${bin}${delimiter}${process.env.PATH}` : bin,
      });
      try {
        const inspection = await createSandboxPolicyResolver(
          store,
          workspace,
          environment,
        ).inspect();
        expect(inspection.backend).toMatchObject({
          type: process.platform === "darwin" ? "seatbelt" : "bubblewrap",
          available: true,
        });
        expect(inspection.toolchains[0]).toMatchObject({
          id: "bun",
          available: true,
        });
        expect(inspection.toolchains[0]).not.toHaveProperty("version");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("combines global absolute and workspace-relative extra paths", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-policy-"));
    const globalDir = join(root, "global");
    const workspace = join(root, "workspace");
    const globalSdk = join(root, "global-sdk");
    mkdirSync(globalSdk, { recursive: true });
    mkdirSync(join(workspace, "vendor", "sdk"), { recursive: true });
    const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
    store.writeSettings("global", {
      sandbox: {
        type: "native",
        toolchains: { mode: "manual", extra_paths: [globalSdk] },
      },
    });
    store.writeSettings("workspace", {
      sandbox: {
        type: "native",
        toolchains: { extra_paths: ["./vendor/sdk"] },
      },
    });

    const resolved = createSandboxPolicyResolver(store, workspace).resolve();
    expect(resolved?.resolved_read_only_paths).toEqual([
      globalSdk,
      join(workspace, "vendor", "sdk"),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "does not execute a discovered toolchain while building host inspection",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-passive-inspection-"));
      const globalDir = join(root, "global");
      const workspace = join(root, "workspace");
      const bin = join(root, "runtime", "bin");
      const sentinel = join(root, "entrypoint-ran");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "bun"),
        '#!/bin/sh\nprintf invoked > "$(dirname "$0")/../../entrypoint-ran"\n',
        { mode: 0o755 },
      );
      const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
      store.writeSettings("workspace", {
        sandbox: { type: "native", toolchains: { include: ["bun"] } },
      });
      const environment = environmentFixture({ ...process.env, PATH: bin });
      try {
        const inspection = await createSandboxPolicyResolver(
          store,
          workspace,
          environment,
        ).inspect();
        expect(inspection.toolchains[0]).toMatchObject({ id: "bun", available: true });
        expect(inspection.toolchains[0]).not.toHaveProperty("version");
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the global Sandbox floor when an untrusted workspace asks for weaker access", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-exclude-"));
    const globalDir = join(root, "global");
    const workspace = join(root, "workspace");
    const globalSdk = join(root, "global-sdk");
    mkdirSync(globalSdk, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
    store.writeSettings("global", {
      sandbox: {
        type: "native",
        filesystem: "workspace-read-only",
        network: "none",
        pass_env: ["CI"],
        toolchains: { mode: "manual", extra_paths: [globalSdk] },
      },
    });
    store.writeSettings("workspace", {
      sandbox: {
        type: "native",
        enabled: false,
        filesystem: "workspace-write",
        network: "host",
        pass_env: ["TERM"],
        toolchains: { mode: "auto", include: ["python"], excluded_paths: [globalSdk] },
      },
    });
    const resolver = createSandboxPolicyResolver(store, workspace);
    const resolved = resolver.resolve();
    expect(resolved).toMatchObject({
      enabled: true,
      filesystem: "workspace-read-only",
      network: "none",
      pass_env: ["CI"],
      toolchains: { mode: "manual", include: [] },
      resolved_read_only_paths: [globalSdk],
    });
    expect((await resolver.inspect()).filesystem).toEqual({
      placement: "sandbox",
      reads: "host-visible",
      writes: "declared-roots",
      workspace: "read-only",
    });
    expect((await resolver.inspect()).effective_network).toBe("none");
  });

  it("reports broad and workspace-containing paths without resolving them", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-invalid-"));
    const globalDir = join(root, "global");
    const workspace = join(root, "workspace", "project");
    mkdirSync(workspace, { recursive: true });
    const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
    store.writeSettings("workspace", {
      sandbox: {
        type: "native",
        toolchains: { mode: "manual", extra_paths: ["/", join(root, "workspace")] },
      },
    });

    const resolver = createSandboxPolicyResolver(store, workspace);
    expect(resolver.resolve()?.resolved_read_only_paths).toBeUndefined();
    expect((await resolver.inspect()).extra_paths).toEqual([
      {
        path: "/",
        scope: "workspace",
        available: false,
        error: "sandbox path is too broad",
      },
      {
        path: join(root, "workspace"),
        scope: "workspace",
        available: false,
        error: "sandbox path may not contain the workspace",
      },
    ]);
  });

  it("caches discovery until the environment changes or refresh is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-cache-"));
    const bin = join(root, "runtime", "bin");
    try {
      const child = Bun.spawn({
        cmd: [process.execPath, SANDBOX_CACHE_PROBE_PATH, root],
        env: { ...process.env, PATH: bin },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([true, true, false, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
