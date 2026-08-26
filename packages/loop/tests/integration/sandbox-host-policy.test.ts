import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandboxHostPolicy, resolveSandboxPath } from "../../src/capabilities-tools.ts";

const roots = new Set<string>();

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("sandbox host policy", () => {
  it("resolves safe workspace-relative paths and rejects unsafe roots", () => {
    const root = tempRoot("clarvis-host-policy-");
    const workspace = join(root, "workspace");
    const sdk = join(workspace, "vendor", "sdk");
    mkdirSync(sdk, { recursive: true });

    expect(resolveSandboxPath("./vendor/sdk", workspace, true)).toEqual({ path: sdk });
    expect(resolveSandboxPath("../outside", workspace, true).error).toBe(
      "workspace sandbox path escapes the workspace",
    );
    expect(resolveSandboxPath("/", workspace, true).error).toBe("sandbox path is too broad");
    expect(resolveSandboxPath("./vendor/sdk", workspace, false).error).toBe(
      "global sandbox paths must be absolute",
    );
  });

  it("compiles manual extra paths without automatic discovery", () => {
    const root = tempRoot("clarvis-host-policy-manual-");
    const workspace = join(root, "workspace");
    const sdk = join(root, "sdk");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sdk);

    expect(
      resolveSandboxHostPolicy(
        {
          type: "bubblewrap",
          toolchains: {
            mode: "manual",
            extra_paths: [sdk, "/", join(root, "missing")],
          },
        },
        workspace,
      ),
    ).toEqual({
      type: "bubblewrap",
      toolchains: {
        mode: "manual",
        extra_paths: [sdk, "/", join(root, "missing")],
      },
      resolved_read_only_paths: [sdk],
    });
  });

  it("discovers an included runtime and filters an explicitly excluded one", () => {
    const root = tempRoot("clarvis-host-policy-auto-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);

    const included = resolveSandboxHostPolicy(
      { type: "bubblewrap", toolchains: { mode: "auto", include: ["bun"] } },
      workspace,
    );
    expect(included?.resolved_runtime_paths?.length).toBeGreaterThan(0);

    const excluded = resolveSandboxHostPolicy(
      {
        type: "bubblewrap",
        toolchains: { mode: "auto", include: ["bun"], exclude: ["bun"] },
      },
      workspace,
    );
    expect(excluded?.resolved_runtime_paths).toBeUndefined();
  });
});
