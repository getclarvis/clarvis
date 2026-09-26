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
      JSON.stringify({
        isolation: { mode: "sandbox", network: "disabled" },
        approval_mode: "never",
        approval_policy: "never",
        judge: { model: "untrusted/model" },
        execution_requirements: { deny_read_paths: [root] },
      }),
    );
    const store = createFileConfigStore({ workspaceRoot, globalDir });
    const config = createConfigService(store);
    expect((await config.getSettings()).merged.isolation).toBeUndefined();
    expect((await config.getSettings()).merged.approval_mode).toBeUndefined();
    expect((await config.getSettings()).merged.approval_policy).toBeUndefined();
    expect((await config.getSettings()).merged.judge).toBeUndefined();
    expect((await config.getSettings()).merged.execution_requirements).toBeUndefined();
    expect((await config.getSettings()).withheld_workspace_fields).toBeUndefined();
    expect((await config.getIsolationStatus()).configured).toEqual({
      mode: "sandbox",
      workspace: "read-write",
      network: "disabled",
      additional_write_roots: [],
    });
    await config.updateSettings(
      "workspace",
      { isolation: { mode: "sandbox" }, approval_policy: "never" },
      store.readSettings().sources.find((source) => source.scope === "workspace")!.revision,
    );
    expect((await config.getSettings()).merged.isolation).toBeUndefined();
    expect(JSON.parse(readFileSync(workspaceSettings, "utf8")).isolation).toBeUndefined();
    expect(JSON.parse(readFileSync(workspaceSettings, "utf8")).approval_policy).toBeUndefined();

    await expect(
      config.updateSettings("global", { approval_mode: "auto" }, null),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await config.updateSettings(
      "global",
      {
        approval_mode: "auto",
        judge: { max_attempts: 2 },
        default_model: "fixture/test",
        providers: [
          {
            name: "fixture",
            kind: "anthropic",
            models: { test: { context_window_tokens: 8192, max_output_tokens: 1024 } },
          },
        ],
      },
      null,
    );
    expect((await config.getSettings()).merged.approval_mode).toBe("auto");
    await expect(
      config.updateSettings(
        "global",
        { judge: { max_attempts: 4 } },
        store.readSettings().sources.find((source) => source.scope === "global")!.revision,
      ),
    ).rejects.toThrow();

    await config.updateSettings(
      "global",
      {
        isolation: { mode: "sandbox", workspace: "read-only", network: "disabled" },
      },
      store.readSettings().sources.find((source) => source.scope === "global")!.revision,
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
      additional_write_roots: [],
    });
    expect((await config.getIsolationStatus()).configured).toEqual({
      mode: "host",
      workspace: "read-only",
      network: "disabled",
      additional_write_roots: [],
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
