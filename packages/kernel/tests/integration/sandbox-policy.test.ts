import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { createSandboxPolicyResolver } from "../../src/sandbox/policy.ts";

describe("sandbox host policy", () => {
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
        type: "bubblewrap",
        toolchains: { mode: "manual", extra_paths: [globalSdk] },
      },
    });
    store.writeSettings("workspace", {
      sandbox: {
        type: "bubblewrap",
        toolchains: { extra_paths: ["./vendor/sdk"] },
      },
    });

    const resolved = createSandboxPolicyResolver(store, workspace).resolve();
    expect(resolved?.resolved_read_only_paths).toEqual([
      globalSdk,
      join(workspace, "vendor", "sdk"),
    ]);
  });

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
        type: "bubblewrap",
        toolchains: { mode: "manual", extra_paths: [globalSdk] },
      },
    });
    store.writeSettings("workspace", {
      sandbox: {
        type: "bubblewrap",
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
        type: "bubblewrap",
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
        type: "bubblewrap",
        toolchains: { include: ["bun"] },
      },
    });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const resolver = createSandboxPolicyResolver(store, workspace);
      expect((await resolver.inspect()).toolchains[0]?.version).toBe("1.0.0");

      writeFileSync(executable, "#!/bin/sh\necho 2.0.0\n", { mode: 0o755 });
      expect((await resolver.inspect()).toolchains[0]?.version).toBe("1.0.0");
      expect((await resolver.inspect({ refresh: true })).toolchains[0]?.version).toBe("2.0.0");

      const otherBin = join(root, "other");
      mkdirSync(otherBin);
      process.env.PATH = `${otherBin}:${bin}`;
      expect((await resolver.inspect()).toolchains[0]?.version).toBe("2.0.0");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
