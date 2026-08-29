import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsPluginsDirs, globalPaths, workspacePaths } from "@clarvis/paths";

import { createPluginContributions } from "../../src/plugins/plugin-contributions.ts";
import {
  PLUGIN_EXECUTABLE_RESOURCE_LIMITS,
  snapshotPluginExecutables,
} from "../../src/plugins/plugin-executable-snapshot.ts";
import { PLUGIN_RESOURCE_LIMITS, type PluginManifest } from "@clarvis/loop/host";
import { recordingLogger, type RecordingLogger } from "../helpers/logger.ts";
import type { PluginRef } from "@clarvis/protocol";

const ref = (name: string): PluginRef => ({ scope: "global", source: "clarvis", name });
const refs = (...names: string[]): PluginRef[] => names.map(ref);
const exactRef = (
  name: string,
  scope: PluginRef["scope"],
  source: PluginRef["source"],
): PluginRef => ({ scope, source, name });

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
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarvis-plugin-contributions-"));
    globalDir = join(root, "global");
    workspaceRoot = join(root, "workspace");
    home = join(root, "home");
    mkdirSync(globalPaths(globalDir).pluginsDir, { recursive: true });
    mkdirSync(workspacePaths(workspaceRoot).pluginsDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const contributions = () =>
    createPluginContributions({
      globalDir,
      home,
      workspaceRoot,
    });

  it("installation plus enablement loads skills and agents without global fingerprint trust", () => {
    install(globalPaths(globalDir).pluginsDir, "demo", {}, { agent: true, skill: true });
    const loaded = contributions();
    expect(loaded.skillRoots(refs("demo"))).toEqual([
      {
        path: join(globalPaths(globalDir).pluginsDir, "demo", "skills"),
        scope: "user",
        source: "plugin:demo",
      },
    ]);
    expect(loaded.agents(refs("demo")).map((agent) => agent.name)).toEqual(["demo:worker"]);
    expect(loaded.readAgent(refs("demo"), "demo:worker")?.body.trim()).toBe("body");
    expect(loaded.skillRoots([])).toEqual([]);
  });

  it("bounds plugin skill roots and projects an optional bootstrap skill", () => {
    const enabled: PluginRef[] = [];
    for (let pluginIndex = 0; pluginIndex < 7; pluginIndex += 1) {
      const name = `roots-${String(pluginIndex)}`;
      enabled.push(ref(name));
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

  it("activates valid plugin hooks with the selected atomic contribution", async () => {
    install(globalPaths(globalDir).pluginsDir, "demo", {
      mcpServers: { files: { command: "file-server" } },
      hooks: [{ event: "run_start", command: "check" }],
    });
    const loaded = contributions();
    expect(
      (
        loaded.settingsScopes(refs("demo"))[0]!.settings as {
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
    expect(loaded.mcpServers(refs("alpha", "beta"))).toEqual([
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
      loaded.settingsScopes(refs("alpha", "beta")).map((scope) => scope.settings.mcpServers),
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
    expect(loaded.mcpServers(refs("atlas"))).toEqual([
      {
        effectiveName: "atlas:charts",
        plugin: "atlas",
        declaration: { type: "stdio", command: "atlas-mcp" },
      },
    ]);
    expect(loaded.settingsScopes(refs("atlas")).map((scope) => scope.settings.mcpServers)).toEqual([
      { "atlas:charts": { type: "stdio", command: "atlas-mcp" } },
    ]);
  });

  it("serves pinned in-memory contributions and rejects drift before filesystem-backed roots", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "atlas", {
      mcpServers: "./.mcp.json",
    });
    const companion = join(dir, ".mcp.json");
    writeFileSync(
      companion,
      JSON.stringify({ mcpServers: { charts: { command: "atlas-mcp-v1" } } }),
    );
    const loaded = contributions();
    loaded.pin(refs("atlas"));

    expect(loaded.mcpServers(refs("atlas"))[0]?.declaration.command).toBe("atlas-mcp-v1");
    expect(() => loaded.mcpServers([])).toThrow(/active plugin selection changed/);
    writeFileSync(
      companion,
      JSON.stringify({ mcpServers: { charts: { command: "atlas-mcp-v2" } } }),
    );

    expect(() => loaded.settingsScopes(refs("atlas"))).toThrow(/reconnect the kernel/);
    expect(() => loaded.mcpServers(refs("atlas"))).toThrow(/reconnect the kernel/);
    expect(loaded.agents(refs("atlas"))).toEqual([]);
    expect(() => loaded.skillRoots(refs("atlas"))).toThrow(/reconnect the kernel/);
  });

  it("rejects drift in a selected skill resource", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "handbook", {}, { skill: true });
    const resources = join(dir, "skills", "guide", "references");
    mkdirSync(resources, { recursive: true });
    const reference = join(resources, "runtime.md");
    writeFileSync(reference, "runtime v1\n");
    const loaded = contributions();
    loaded.pin(refs("handbook"));

    writeFileSync(reference, "runtime v2\n");
    expect(() => loaded.skillRoots(refs("handbook"))).toThrow(/selected plugin content changed/);
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
    expect(loaded.mcpServers(refs("atlas"))).toEqual([]);
    expect(loaded.agents(refs("atlas")).map((agent) => agent.name)).toEqual(["atlas:worker"]);
    expect(loaded.skillRoots(refs("atlas"))).toHaveLength(1);
  });

  it("locates an enabled selected capability executable captured by the snapshot", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "speckit", {
      capabilityExecutables: {
        memory: {
          command: "python3",
          args: ["-B", "./providers/server.py", "memory"],
          platforms: { win32: { command: "py", args: ["-3", "server.py", "memory"] } },
        },
      },
    });
    mkdirSync(join(dir, "providers"), { recursive: true });
    writeFileSync(join(dir, "providers", "server.py"), "print('ready')\n");
    const loaded = contributions();
    expect(loaded.locateCapabilityExecutable([], "memory", "speckit")).toEqual({
      error: "plugin 'speckit' is not enabled for this workspace",
    });
    expect(loaded.locateCapabilityExecutable(refs("speckit"), "memory", "speckit")).toEqual({
      root: dir,
      declaration: expect.objectContaining({ command: "python3" }),
    });
    expect(loaded.locateCapabilityExecutable(refs("speckit"), "plans", "speckit")).toEqual({
      error: "plugin 'speckit' offers no capability executable 'plans'",
    });
  });

  it("rejects drift in package-local MCP, hook, and capability process files", () => {
    const dir = join(globalPaths(globalDir).pluginsDir, "runtime");
    install(globalPaths(globalDir).pluginsDir, "runtime", {
      mcpServers: {
        docs: { command: "python3", args: ["./server.py"], cwd: dir },
      },
      hooks: [{ event: "run_start", command: `python3 "${join(dir, "hook.py")}"` }],
      capabilityExecutables: {
        memory: { command: "python3", args: ["./provider.py"] },
      },
    });
    const files = ["server.py", "hook.py", "provider.py"];
    for (const file of files) writeFileSync(join(dir, file), `${file}:v1\n`);

    const cases = [
      {
        file: "server.py",
        read: (loaded: ReturnType<typeof contributions>) => loaded.mcpServers(refs("runtime")),
      },
      {
        file: "hook.py",
        read: (loaded: ReturnType<typeof contributions>) => loaded.settingsScopes(refs("runtime")),
      },
      {
        file: "provider.py",
        read: (loaded: ReturnType<typeof contributions>) =>
          loaded.locateCapabilityExecutable(refs("runtime"), "memory", "runtime"),
      },
    ];
    for (const entry of cases) {
      const loaded = contributions();
      loaded.pin(refs("runtime"));
      writeFileSync(join(dir, entry.file), `${entry.file}:v2\n`);
      expect(() => entry.read(loaded)).toThrow(/selected plugin content changed/);
      writeFileSync(join(dir, entry.file), `${entry.file}:v1\n`);
    }
  });

  it("omits a plugin whose referenced process file exceeds the executable byte bound", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "huge-runtime", {
      capabilityExecutables: {
        memory: { command: "python3", args: ["./provider.py"] },
      },
    });
    writeFileSync(join(dir, "provider.py"), "x");
    truncateSync(join(dir, "provider.py"), PLUGIN_EXECUTABLE_RESOURCE_LIMITS.fileBytes + 1);

    const loaded = contributions();
    expect(loaded.snapshot(refs("huge-runtime"))).toEqual([]);
    expect(
      loaded.locateCapabilityExecutable(refs("huge-runtime"), "memory", "huge-runtime"),
    ).toEqual({ error: "plugin 'huge-runtime' has no readable manifest" });
  });

  it("fails a direct executable snapshot when the plugin root is absent", () => {
    expect(
      snapshotPluginExecutables(join(root, "missing"), { name: "missing" } as PluginManifest),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("plugin root could not be resolved"),
    });
  });

  it("ignores process paths and working directories outside the package", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "confined", {});
    const outside = join(root, "outside.py");
    writeFileSync(outside, "print('outside')\n");

    expect(
      snapshotPluginExecutables(dir, {
        name: "confined",
        mcpServers: {
          outside: { type: "stdio", command: outside, cwd: root },
          absent: { type: "stdio", command: "./missing.py", cwd: join(root, "missing") },
        },
        hooks: [{ event: "run_start", command: outside }],
      } as PluginManifest),
    ).toEqual({ ok: true, files: [] });
  });

  it("bounds the number of package-local process files", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "many-runtime-files", {});
    const args = Array.from(
      { length: PLUGIN_EXECUTABLE_RESOURCE_LIMITS.files + 1 },
      (_, index) => `./runtime-${String(index)}.js`,
    );
    for (const arg of args) writeFileSync(join(dir, arg), "");

    expect(
      snapshotPluginExecutables(dir, {
        name: "many-runtime-files",
        capabilityExecutables: {
          memory: { command: "node", args, env: {}, timeout_ms: 30_000 },
        },
      } as PluginManifest),
    ).toEqual({
      ok: false,
      error: `package executable surface exceeds the ${String(PLUGIN_EXECUTABLE_RESOURCE_LIMITS.files)}-file resource limit`,
    });
  });

  it("bounds aggregate package-local process bytes", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "large-runtime-surface", {});
    const args = Array.from({ length: 5 }, (_, index) => `./runtime-${String(index)}.bin`);
    for (const [index, arg] of args.entries()) {
      const path = join(dir, arg);
      writeFileSync(path, "");
      truncateSync(
        path,
        index === args.length - 1 ? 1 : PLUGIN_EXECUTABLE_RESOURCE_LIMITS.fileBytes,
      );
    }

    expect(
      snapshotPluginExecutables(dir, {
        name: "large-runtime-surface",
        capabilityExecutables: {
          memory: { command: "node", args, env: {}, timeout_ms: 30_000 },
        },
      } as PluginManifest),
    ).toEqual({
      ok: false,
      error:
        `package executable surface exceeds the ` +
        `${String(PLUGIN_EXECUTABLE_RESOURCE_LIMITS.aggregateBytes)}-byte aggregate limit`,
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
    expect(loaded.skillPlansMode(refs("speckit"), "speckit", "speckit-plan")).toBe("off");
    expect(loaded.skillPlansMode(refs("speckit"), "speckit", "speckit-implement")).toBe("review");
    expect(loaded.skillPlansMode(refs("speckit"), "speckit", "unknown")).toBeUndefined();
  });

  it("same-named installations never substitute for an exact reference", () => {
    install(globalPaths(globalDir).pluginsDir, "demo", {}, { skill: true });
    install(workspacePaths(workspaceRoot).pluginsDir, "demo", {}, { agent: true });
    const loaded = contributions();
    expect(loaded.skillRoots([exactRef("demo", "global", "clarvis")])).toHaveLength(1);
    expect(loaded.agents([exactRef("demo", "global", "clarvis")])).toEqual([]);
    expect(loaded.skillRoots([exactRef("demo", "workspace", "clarvis")])).toEqual([]);
    expect(
      loaded.agents([exactRef("demo", "workspace", "clarvis")]).map((agent) => agent.name),
    ).toEqual(["demo:worker"]);
  });

  it("loads shared .agents plugins from user and workspace inventories by exact source", () => {
    const agents = agentsPluginsDirs({ home, cwd: workspaceRoot, env: {} });
    install(agents.user, "shared", {}, { skill: true });
    install(agents.workspace, "project", {}, { agent: true });
    install(globalPaths(globalDir).pluginsDir, "shared", {}, { agent: true });
    const loaded = contributions();

    expect(loaded.skillRoots([exactRef("shared", "global", "agents")])).toHaveLength(1);
    expect(loaded.agents([exactRef("shared", "global", "agents")])).toEqual([]);
    expect(
      loaded.agents([exactRef("shared", "global", "clarvis")]).map((agent) => agent.name),
    ).toEqual(["shared:worker"]);
    expect(
      loaded.agents([exactRef("project", "workspace", "agents")]).map((agent) => agent.name),
    ).toEqual(["project:worker"]);
  });

  it("loads a Codex-layout package from .agents without repackaging it for Clarvis", () => {
    const agents = agentsPluginsDirs({ home, cwd: workspaceRoot, env: {} });
    const dir = join(agents.user, "codex-kit");
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    mkdirSync(join(dir, "skills", "research"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "codex-kit",
        version: "preview-1",
        skills: "../skills",
        mcpServers: "../.mcp.json",
      }),
    );
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "codex-docs-server" } } }),
    );
    writeFileSync(
      join(dir, "skills", "research", "SKILL.md"),
      "---\nname: research\ndescription: Research with Codex tools\n---\n",
    );
    writeFileSync(
      join(dir, "agents", "reviewer.md"),
      "---\ndescription: reviewer\n---\nReview the result.\n",
    );
    const loaded = contributions();
    const selected = [exactRef("codex-kit", "global", "agents")];

    expect(loaded.skillRoots(selected)).toEqual([
      {
        path: join(dir, "skills"),
        scope: "user",
        source: "plugin:codex-kit",
      },
    ]);
    expect(loaded.agents(selected).map((agent) => agent.name)).toEqual(["codex-kit:reviewer"]);
    expect(loaded.mcpServers(selected)).toMatchObject([
      {
        effectiveName: "codex-kit:docs",
        plugin: "codex-kit",
        pluginVersion: "preview-1",
        declaration: { command: "codex-docs-server" },
      },
    ]);
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
    expect(loaded.agents(refs("heavy"))).toEqual([]);
    expect(loaded.settingsScopes(refs("heavy"))).toEqual([]);
    expect(loaded.mcpServers(refs("heavy"))).toEqual([]);
    expect(loaded.locateCapabilityExecutable(refs("heavy"), "plans", "heavy")).toEqual({
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
    expect(loaded.settingsScopes(refs("recorded"))).toEqual([]);
    expect(loaded.mcpServers(refs("recorded"))).toEqual([]);
  });

  it("contributes no hooks when the convention document exceeds its budget, and the rest anyway", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "hooks-heavy", {
      mcpServers: { dangerous: { command: "would-run" } },
    });
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "hooks.json"), "x");
    truncateSync(join(dir, "hooks", "hooks.json"), PLUGIN_RESOURCE_LIMITS.hookDocumentBytes + 1);

    const loaded = contributions();
    expect(loaded.settingsScopes(refs("hooks-heavy"))[0]?.settings.hooks).toBeUndefined();
    expect(loaded.mcpServers(refs("hooks-heavy")).map((s) => s.effectiveName)).toEqual([
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
    expect(contributions(logger).skillRoots(refs("ghost"))).toEqual([]);
    expect(logger.events("kernel.plugin.skipped")[0]).toMatchObject({
      plugin: "ghost",
      scope: "global",
      source: "clarvis",
      phase: "dir",
    });
  });

  it("reports a plugin whose manifest cannot be read", () => {
    const logger = recordingLogger();
    mkdirSync(join(globalPaths(globalDir).pluginsDir, "bare"), { recursive: true });
    expect(contributions(logger).agents(refs("bare"))).toEqual([]);
    const skipped = logger.events("kernel.plugin.skipped")[0];
    expect(skipped).toMatchObject({ plugin: "bare", scope: "global", phase: "manifest" });
    expect(String(skipped?.cause)).toContain("plugin.json");
  });

  it("reports a plugin whose manifest is not valid JSON", () => {
    const logger = recordingLogger();
    const dir = join(globalPaths(globalDir).pluginsDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{ not json");
    expect(contributions(logger).agents(refs("broken"))).toEqual([]);
    expect(logger.events("kernel.plugin.skipped")[0]).toMatchObject({ phase: "manifest" });
  });

  it("reports a plugin with no skills directory", () => {
    const logger = recordingLogger();
    install(globalPaths(globalDir).pluginsDir, "noskills", {});
    expect(contributions(logger).skillRoots(refs("noskills"))).toEqual([]);
    expect(logger.events("kernel.plugin.skipped")[0]).toMatchObject({
      plugin: "noskills",
      phase: "skills",
    });
  });

  it("stays silent for a plugin that loads", () => {
    const logger = recordingLogger();
    install(globalPaths(globalDir).pluginsDir, "ok", {}, { skill: true });
    expect(contributions(logger).skillRoots(refs("ok"))).toHaveLength(1);
    expect(logger.events("kernel.plugin.skipped")).toEqual([]);
  });
});
