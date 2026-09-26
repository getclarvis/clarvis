import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { createConfigService } from "../../src/config/config-service.ts";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { resolveIsolationSettings } from "../../src/config/isolation-settings.ts";
import { snapshotRunConfiguration } from "../../src/runs/configuration-snapshot.ts";

describe("global isolation settings", () => {
  it("ignores workspace content and writes while retaining global siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-isolation-settings-"));
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    mkdirSync(workspaceRoot);
    mkdirSync(globalDir);
    const workspaceSettings = workspacePaths(workspaceRoot).settingsFile;
    mkdirSync(workspacePaths(workspaceRoot).clarvisDir);
    writeFileSync(
      workspaceSettings,
      JSON.stringify({ isolation: { mode: "sandbox", network: "disabled" } }),
    );
    const store = createFileConfigStore({ workspaceRoot, globalDir });
    const config = createConfigService(store);
    expect((await config.getSettings()).merged.isolation).toBeUndefined();
    expect((await config.getSettings()).withheld_workspace_fields).toBeUndefined();
    expect((await config.getIsolationStatus()).configured).toEqual({
      mode: "host",
      workspace: "read-write",
      network: "enabled",
    });
    await config.updateSettings(
      "workspace",
      { isolation: { mode: "sandbox" } },
      store.readSettings().sources.find((source) => source.scope === "workspace")!.revision,
    );
    expect((await config.getSettings()).merged.isolation).toBeUndefined();
    expect(JSON.parse(readFileSync(workspaceSettings, "utf8")).isolation).toBeUndefined();

    await config.updateSettings(
      "global",
      {
        isolation: { mode: "sandbox", workspace: "read-only", network: "disabled" },
      },
      null,
    );
    const before = snapshotRunConfiguration(store);
    const revision = store
      .readSettings()
      .sources.find((source) => source.scope === "global")!.revision;
    await config.updateSettings("global", { isolation: { mode: "host" } }, revision);
    expect(resolveIsolationSettings(before.readSettings().scopes.global?.isolation)).toEqual({
      mode: "sandbox",
      workspace: "read-only",
      network: "disabled",
    });
    expect((await config.getIsolationStatus()).configured).toEqual({
      mode: "host",
      workspace: "read-only",
      network: "disabled",
    });
    expect(JSON.parse(readFileSync(globalPaths(globalDir).settingsFile, "utf8")).isolation).toEqual(
      {
        mode: "host",
        workspace: "read-only",
        network: "disabled",
      },
    );
  });
});
