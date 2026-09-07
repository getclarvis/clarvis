import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { createSandboxPolicyResolver } from "../../src/sandbox/policy.ts";

describe("sandbox host policy", () => {
  it("strengthens Docker fallback to a required native sandbox without discarding tuning", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-docker-fallback-policy-"));
    const globalDir = join(root, "global");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
    store.writeSettings("global", {
      runtime: { backend: "docker" },
      sandbox: {
        type: "native",
        enabled: false,
        availability: "optional",
        filesystem: "workspace-read-only",
        network: "none",
      },
    });
    expect(createSandboxPolicyResolver(store, workspace).resolve()).toMatchObject({
      type: "native",
      enabled: true,
      availability: "required",
      filesystem: "workspace-read-only",
      network: "none",
    });
    rmSync(root, { recursive: true, force: true });
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
      const previousPath = process.env.PATH;
      process.env.PATH = previousPath ? `${bin}${delimiter}${previousPath}` : bin;
      try {
        const inspection = await createSandboxPolicyResolver(store, workspace).inspect();
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
        process.env.PATH = previousPath;
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
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const inspection = await createSandboxPolicyResolver(store, workspace).inspect();
        expect(inspection.toolchains[0]).toMatchObject({ id: "bun", available: true });
        expect(inspection.toolchains[0]).not.toHaveProperty("version");
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        process.env.PATH = previousPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("lets workspace excluded_paths suppress an inherited global path", () => {
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
        toolchains: { mode: "manual", extra_paths: [globalSdk] },
      },
    });
    store.writeSettings("workspace", {
      sandbox: {
        type: "native",
        toolchains: { excluded_paths: [globalSdk] },
      },
    });

    expect(
      createSandboxPolicyResolver(store, workspace).resolve()?.resolved_read_only_paths,
    ).toBeUndefined();
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
    const globalDir = join(root, "global");
    const workspace = join(root, "workspace");
    const bin = join(root, "runtime", "bin");
    const executable = join(bin, "bun");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(executable, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
    const store = createFileConfigStore({ workspaceRoot: workspace, globalDir });
    store.writeSettings("workspace", {
      sandbox: {
        type: "native",
        toolchains: { include: ["bun"] },
      },
    });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const resolver = createSandboxPolicyResolver(store, workspace);
      expect((await resolver.inspect()).toolchains[0]?.available).toBe(true);

      rmSync(executable);
      expect((await resolver.inspect()).toolchains[0]?.available).toBe(true);
      expect((await resolver.inspect({ refresh: true })).toolchains[0]?.available).toBe(false);

      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const otherBin = join(root, "other");
      mkdirSync(otherBin);
      process.env.PATH = `${otherBin}:${bin}`;
      expect((await resolver.inspect()).toolchains[0]?.available).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
