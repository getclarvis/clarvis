import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths, workspacePaths } from "@clarvis/paths";

import { createPluginContributions } from "../../src/plugins/plugin-contributions.ts";
import { createPluginService } from "../../src/plugins/plugin-service.ts";
import { PLUGIN_RESOURCE_LIMITS } from "@clarvis/loop/host";
import { recordingLogger, type RecordingLogger } from "../helpers/logger.ts";

function install(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  options: { agent?: boolean; skill?: boolean } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, ...manifest }));
  if (options.agent) {
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "worker.md"), "---\ndescription: worker\n---\nbody\n");
  }
  if (options.skill) {
    mkdirSync(join(dir, "skills", "guide"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "guide", "SKILL.md"),
      "---\nname: guide\ndescription: guide\n---\n",
    );
  }
  return dir;
}

describe("plugin contributions", () => {
  let root: string;
  let globalDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarvis-plugin-contributions-"));
    globalDir = join(root, "global");
    workspaceRoot = join(root, "workspace");
    mkdirSync(globalPaths(globalDir).pluginsDir, { recursive: true });
    mkdirSync(workspacePaths(workspaceRoot).pluginsDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const contributions = () =>
    createPluginContributions({
      globalDir,
      workspaceConfigDir: workspacePaths(workspaceRoot).clarvisDir,
    });

  it("installation plus enablement loads skills and agents without global fingerprint trust", () => {
    install(globalPaths(globalDir).pluginsDir, "demo", {}, { agent: true, skill: true });
    const loaded = contributions();
    expect(loaded.skillRoots(["demo"])).toEqual([
      {
        path: join(globalPaths(globalDir).pluginsDir, "demo", "skills"),
        scope: "user",
        source: "plugin:demo",
      },
    ]);
    expect(loaded.agents(["demo"]).map((agent) => agent.name)).toEqual(["demo:worker"]);
    expect(loaded.readAgent(["demo"], "demo:worker")?.body.trim()).toBe("body");
    expect(loaded.skillRoots([])).toEqual([]);
  });

  it("bounds plugin skill roots and projects an optional bootstrap skill", () => {
    const enabled: string[] = [];
    for (let pluginIndex = 0; pluginIndex < 7; pluginIndex += 1) {
      const name = `roots-${String(pluginIndex)}`;
      enabled.push(name);
      const roots = Array.from({ length: 4 }, (_, rootIndex) => `skills-${String(rootIndex)}`);
      const dir = install(globalPaths(globalDir).pluginsDir, name, {
        skills: roots,
        ...(pluginIndex === 0 ? { bootstrapSkill: "guide" } : {}),
      });
      for (const rootName of roots) mkdirSync(join(dir, rootName), { recursive: true });
    }
    const logger = recordingLogger();
    const loaded = createPluginContributions({ globalDir, logger });

    expect(loaded.skillRoots(enabled)).toHaveLength(24);
    expect(loaded.skillBootstraps(enabled)[0]).toMatchObject({
      plugin: "roots-0",
      skill: "guide",
    });
    expect(
      logger.events("kernel.plugin.skipped").some(({ phase }) => phase === "skills"),
    ).toBeTrue();
  });

  it("withholds only unmanaged hooks until their exact definitions are reviewed", async () => {
    install(globalPaths(globalDir).pluginsDir, "demo", {
      mcpServers: { files: { command: "file-server" } },
      hooks: [{ event: "run_start", command: "check" }],
    });
    const loaded = contributions();
    expect(loaded.settingsScopes(["demo"])[0]!.settings).toMatchObject({
      mcpServers: { "demo:files": { command: "file-server" } },
      hooks: undefined,
    });
    const service = createPluginService({
      globalDir,
      enabledPlugins: () => ["demo"],
      environment: process.env,
    });
    const [hook] = await service.hooks();
    await service.approveHook("demo", hook!.fingerprint);
    expect(
      (
        loaded.settingsScopes(["demo"])[0]!.settings as {
          hooks?: { event: string; command: string }[];
        }
      ).hooks,
    ).toEqual([{ event: "run_start", command: "check" }]);
  });

  it("qualifies same-named MCP servers once and preserves provider provenance", () => {
    const alpha = install(globalPaths(globalDir).pluginsDir, "alpha", {
      version: "1.2.3",
      mcpServers: { tasks: { type: "http", url: "https://alpha.example/mcp" } },
    });
    install(globalPaths(globalDir).pluginsDir, "beta", {
      mcpServers: { tasks: { command: "beta-server" } },
    });
    writeFileSync(join(alpha, "install-record.json"), JSON.stringify({ revision: "abc123" }));

    const loaded = contributions();
    expect(loaded.mcpServers([])).toEqual([]);
    expect(loaded.mcpServers(["alpha", "beta"])).toEqual([
      {
        effectiveName: "alpha:tasks",
        plugin: "alpha",
        pluginVersion: "1.2.3",
        resolvedRevision: "abc123",
        declaration: { type: "http", url: "https://alpha.example/mcp" },
      },
      {
        effectiveName: "beta:tasks",
        plugin: "beta",
        declaration: { type: "stdio", command: "beta-server" },
      },
    ]);
    expect(
      loaded.settingsScopes(["alpha", "beta"]).map((scope) => scope.settings.mcpServers),
    ).toEqual([
      { "alpha:tasks": { type: "http", url: "https://alpha.example/mcp" } },
      { "beta:tasks": { type: "stdio", command: "beta-server" } },
    ]);
  });

  it("contributes the servers a manifest names a companion document for", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "atlas", {
      mcpServers: "./.mcp.json",
    });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { charts: { command: "atlas-mcp" } } }),
    );

    const loaded = contributions();
    expect(loaded.mcpServers(["atlas"])).toEqual([
      {
        effectiveName: "atlas:charts",
        plugin: "atlas",
        declaration: { type: "stdio", command: "atlas-mcp" },
      },
    ]);
    expect(loaded.settingsScopes(["atlas"]).map((scope) => scope.settings.mcpServers)).toEqual([
      { "atlas:charts": { type: "stdio", command: "atlas-mcp" } },
    ]);
  });

  it("keeps the rest of a plugin when its companion server document is unusable", () => {
    const dir = install(
      globalPaths(globalDir).pluginsDir,
      "atlas",
      { mcpServers: "./.mcp.json" },
      { agent: true, skill: true },
    );
    writeFileSync(join(dir, ".mcp.json"), "{nope");

    const loaded = contributions();
    expect(loaded.mcpServers(["atlas"])).toEqual([]);
    expect(loaded.agents(["atlas"]).map((agent) => agent.name)).toEqual(["atlas:worker"]);
    expect(loaded.skillRoots(["atlas"])).toHaveLength(1);
  });

  it("locates an enabled selected capability executable without reading its code", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "speckit", {
      capabilityExecutables: {
        memory: {
          command: "python3",
          args: ["-B", "./providers/server.py", "memory"],
          platforms: { win32: { command: "py", args: ["-3", "server.py", "memory"] } },
        },
      },
    });
    const loaded = contributions();
    expect(loaded.locateCapabilityExecutable([], "memory", "speckit")).toEqual({
      error: "plugin 'speckit' is not enabled for this workspace",
    });
    expect(loaded.locateCapabilityExecutable(["speckit"], "memory", "speckit")).toEqual({
      root: dir,
      declaration: expect.objectContaining({ command: "python3" }),
    });
    expect(loaded.locateCapabilityExecutable(["speckit"], "plans", "speckit")).toEqual({
      error: "plugin 'speckit' offers no capability executable 'plans'",
    });
  });

  it("returns per-skill policy only for an enabled plugin that declared it", () => {
    install(globalPaths(globalDir).pluginsDir, "speckit", {
      capabilityRunPolicies: {
        plans: { skills: { "speckit-plan": "off", "speckit-implement": "review" } },
      },
    });
    const loaded = contributions();
    expect(loaded.skillPlansMode([], "speckit", "speckit-plan")).toBeUndefined();
    expect(loaded.skillPlansMode(["speckit"], "speckit", "speckit-plan")).toBe("off");
    expect(loaded.skillPlansMode(["speckit"], "speckit", "speckit-implement")).toBe("review");
    expect(loaded.skillPlansMode(["speckit"], "speckit", "unknown")).toBeUndefined();
  });

  it("workspace plugins shadow global plugins of the same name", () => {
    install(globalPaths(globalDir).pluginsDir, "demo", {}, { skill: true });
    install(workspacePaths(workspaceRoot).pluginsDir, "demo", {}, { agent: true });
    const loaded = contributions();
    expect(loaded.skillRoots(["demo"])).toEqual([]);
    expect(loaded.agents(["demo"]).map((agent) => agent.name)).toEqual(["demo:worker"]);
  });

  it("omits every executable contribution when one agent exceeds its file budget", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "heavy", {
      mcpServers: { dangerous: { command: "would-run" } },
      hooks: [{ event: "run_start", command: "also-would-run" }],
    });
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "huge.md"), "x");
    truncateSync(join(dir, "agents", "huge.md"), PLUGIN_RESOURCE_LIMITS.agentFileBytes + 1);

    const loaded = contributions();
    expect(loaded.agents(["heavy"])).toEqual([]);
    expect(loaded.settingsScopes(["heavy"])).toEqual([]);
    expect(loaded.mcpServers(["heavy"])).toEqual([]);
    expect(loaded.locateCapabilityExecutable(["heavy"], "plans", "heavy")).toEqual({
      error: "plugin 'heavy' has no readable manifest",
    });
  });

  it("omits the whole plugin when its install record exceeds its byte budget", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "recorded", {
      mcpServers: { dangerous: { command: "would-run" } },
    });
    writeFileSync(join(dir, "install-record.json"), "x");
    truncateSync(join(dir, "install-record.json"), PLUGIN_RESOURCE_LIMITS.installRecordBytes + 1);

    const loaded = contributions();
    expect(loaded.settingsScopes(["recorded"])).toEqual([]);
    expect(loaded.mcpServers(["recorded"])).toEqual([]);
  });

  it("contributes no hooks when the convention document exceeds its budget, and the rest anyway", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "hooks-heavy", {
      mcpServers: { dangerous: { command: "would-run" } },
    });
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "hooks.json"), "x");
    truncateSync(join(dir, "hooks", "hooks.json"), PLUGIN_RESOURCE_LIMITS.hookDocumentBytes + 1);

    const loaded = contributions();
    expect(loaded.settingsScopes(["hooks-heavy"])[0]?.settings.hooks).toBeUndefined();
    expect(loaded.mcpServers(["hooks-heavy"]).map((s) => s.effectiveName)).toEqual([
      "hooks-heavy:dangerous",
    ]);
  });
});

describe("an enabled plugin that contributes nothing says so", () => {
  let root: string;
  let globalDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarvis-plugin-skipped-"));
    globalDir = join(root, "global");
    mkdirSync(globalPaths(globalDir).pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function contributions(logger: RecordingLogger) {
    return createPluginContributions({ globalDir, logger });
  }

  it("reports a plugin that is enabled but not installed", () => {
    const logger = recordingLogger();
    expect(contributions(logger).skillRoots(["ghost"])).toEqual([]);
    expect(logger.events("kernel.plugin.skipped")[0]).toMatchObject({
      plugin: "ghost",
      scope: "none",
      phase: "dir",
    });
  });

  it("reports a plugin whose manifest cannot be read", () => {
    const logger = recordingLogger();
    mkdirSync(join(globalPaths(globalDir).pluginsDir, "bare"), { recursive: true });
    expect(contributions(logger).agents(["bare"])).toEqual([]);
    const skipped = logger.events("kernel.plugin.skipped")[0];
    expect(skipped).toMatchObject({ plugin: "bare", scope: "global", phase: "manifest" });
    expect(String(skipped?.cause)).toContain("plugin.json");
  });

  it("reports a plugin whose manifest is not valid JSON", () => {
    const logger = recordingLogger();
    const dir = join(globalPaths(globalDir).pluginsDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{ not json");
    expect(contributions(logger).agents(["broken"])).toEqual([]);
    expect(logger.events("kernel.plugin.skipped")[0]).toMatchObject({ phase: "manifest" });
  });

  it("reports a plugin with no skills directory", () => {
    const logger = recordingLogger();
    install(globalPaths(globalDir).pluginsDir, "noskills", {});
    expect(contributions(logger).skillRoots(["noskills"])).toEqual([]);
    expect(logger.events("kernel.plugin.skipped")[0]).toMatchObject({
      plugin: "noskills",
      phase: "skills",
    });
  });

  it("stays silent for a plugin that loads", () => {
    const logger = recordingLogger();
    install(globalPaths(globalDir).pluginsDir, "ok", {}, { skill: true });
    expect(contributions(logger).skillRoots(["ok"])).toHaveLength(1);
    expect(logger.events("kernel.plugin.skipped")).toEqual([]);
  });
});
