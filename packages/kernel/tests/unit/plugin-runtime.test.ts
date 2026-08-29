import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths, workspaceStatePaths } from "@clarvis/paths";
import { ensurePluginDataDir, pluginDataDir } from "../../src/plugins/plugin-runtime.ts";

const made: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clarvis-plugin-data-"));
  made.push(root);
  return root;
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable plugin data directories", () => {
  it("separates global .agents and .clarvis installations with the same name", () => {
    const globalDir = join(temporaryRoot(), "global");
    const agents = pluginDataDir({
      globalDir,
      ref: { scope: "global", source: "agents", name: "browser" },
    });
    const clarvis = pluginDataDir({
      globalDir,
      ref: { scope: "global", source: "clarvis", name: "browser" },
    });

    expect(agents).toBe(join(globalPaths(globalDir).pluginDataRoot, "agents", "browser"));
    expect(clarvis).toBe(join(globalPaths(globalDir).pluginDataRoot, "clarvis", "browser"));
    expect(agents).not.toBe(clarvis);
  });

  it("keeps workspace plugin data in machine-local state outside the checkout", () => {
    const root = temporaryRoot();
    const globalDir = join(root, "global");
    const workspaceRoot = join(root, "workspace");
    const dir = pluginDataDir({
      globalDir,
      workspaceRoot,
      ref: { scope: "workspace", source: "agents", name: "browser" },
    });
    const state = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    });

    expect(dir).toBe(join(state.pluginDataRoot, "agents", "browser"));
    expect(dir.startsWith(workspaceRoot)).toBe(false);
  });

  it("creates the dedicated persistent directory before a plugin can launch", () => {
    const globalDir = join(temporaryRoot(), "global");
    const dir = ensurePluginDataDir({
      globalDir,
      ref: { scope: "global", source: "agents", name: "browser" },
    });

    expect(statSync(dir).isDirectory()).toBe(true);
    expect(
      ensurePluginDataDir({
        globalDir,
        ref: { scope: "global", source: "agents", name: "browser" },
      }),
    ).toBe(dir);
  });

  it("refuses workspace data resolution when the workspace root is absent", () => {
    expect(() =>
      pluginDataDir({
        globalDir: join(temporaryRoot(), "global"),
        ref: { scope: "workspace", source: "agents", name: "browser" },
      }),
    ).toThrow("workspace plugin data requires a workspace root");
  });
});
