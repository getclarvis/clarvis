import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsPluginsDirs, globalPaths, workspacePaths } from "@clarvis/paths";

import {
  createPluginContributions,
  PLUGIN_SKILL_RESOURCE_LIMITS,
} from "../../src/plugins/plugin-contributions.ts";
import { snapshotPluginExecutables } from "../../src/plugins/plugin-executable-snapshot.ts";
import { PLUGIN_RESOURCE_LIMITS, type PluginManifest } from "@clarvis/loop/host";
import { MAX_SKILL_FILE_CHARS } from "@clarvis/skills";
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
        executionRoot: join(globalPaths(globalDir).pluginsDir, "demo"),
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
    ).toMatchObject([{ event: "run_start", command: "check" }]);
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

  it("serves captured projections while retaining explicit drift diagnostics", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "atlas", {
      mcpServers: "./.mcp.json",
    });
    const companion = join(dir, ".mcp.json");
    writeFileSync(
      companion,
      JSON.stringify({ mcpServers: { charts: { command: "atlas-mcp-v1" } } }),
    );
    const loaded = contributions();
    const pinnedDigest = loaded.pin(refs("atlas"))[0]!.digest;
    const pinnedRoots = loaded.skillRoots(refs("atlas"));

    expect(loaded.mcpServers(refs("atlas"))[0]?.declaration.command).toBe("atlas-mcp-v1");
    expect(() => loaded.mcpServers([])).toThrow(/active plugin selection changed/);
    writeFileSync(
      companion,
      JSON.stringify({ mcpServers: { charts: { command: "atlas-mcp-v2" } } }),
    );

    expect(loaded.settingsScopes(refs("atlas"))).toHaveLength(1);
    expect(loaded.mcpServers(refs("atlas"))[0]?.declaration.command).toBe("atlas-mcp-v1");
    expect(loaded.agents(refs("atlas"))).toEqual([]);
    expect(loaded.skillRoots(refs("atlas"))).toEqual(pinnedRoots);
    expect(loaded.snapshot(refs("atlas"))[0]!.digest).not.toBe(pinnedDigest);
  });

  it("projects pinned skill roots without a second content validation", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "handbook", {}, { skill: true });
    const loaded = contributions();
    loaded.pin(refs("handbook"));
    const before = loaded.pinnedSkillRoots(refs("handbook"));

    writeFileSync(
      join(dir, "skills", "guide", "SKILL.md"),
      "---\nname: guide\ndescription: changed\n---\n\nchanged\n",
    );

    expect(loaded.pinnedSkillRoots(refs("handbook"))).toEqual(before);
    expect(loaded.skillRoots(refs("handbook"))).toEqual(before);
  });

  it("keeps the pinned skill projection while a fresh diagnostic snapshot sees resource drift", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "handbook", {}, { skill: true });
    const resources = join(dir, "skills", "guide", "references");
    mkdirSync(resources, { recursive: true });
    const reference = join(resources, "runtime.md");
    writeFileSync(reference, "runtime v1\n");
    const loaded = contributions();
    const pinnedDigest = loaded.pin(refs("handbook"))[0]!.digest;
    const pinnedRoots = loaded.skillRoots(refs("handbook"));

    writeFileSync(reference, "runtime v2\n");
    expect(loaded.skillRoots(refs("handbook"))).toEqual(pinnedRoots);
    expect(loaded.snapshot(refs("handbook"))[0]!.digest).not.toBe(pinnedDigest);
  });

  it("streams large binary and text resources into the exact skill snapshot", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "large-resources", {}, { skill: true });
    const resources = join(dir, "skills", "guide", "references");
    mkdirSync(resources, { recursive: true });
    const binary = join(resources, "font.woff2");
    const text = join(resources, "manual.md");
    writeFileSync(binary, "");
    truncateSync(binary, 512 * 1024);
    writeFileSync(text, "x".repeat(75_000));
    const loaded = contributions();

    const pinned = loaded.pin(refs("large-resources"))[0]!;
    expect(pinned.skills).toEqual(["guide"]);
    writeFileSync(text, "y".repeat(75_000));
    expect(loaded.snapshot(refs("large-resources"))[0]!.digest).not.toBe(pinned.digest);
  });

  it("withholds plugin skills when one resource exceeds the streaming file bound", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "huge-resource", {}, { skill: true });
    const resources = join(dir, "skills", "guide", "assets");
    mkdirSync(resources, { recursive: true });
    const archive = join(resources, "archive.bin");
    writeFileSync(archive, "");
    truncateSync(archive, PLUGIN_SKILL_RESOURCE_LIMITS.fileBytes + 1);

    const loaded = contributions();
    expect(loaded.pin(refs("huge-resource"))[0]?.skills).toEqual([]);
    expect(loaded.skillRoots(refs("huge-resource"))).toEqual([]);
  });

  it("withholds plugin skills when their resources exceed the aggregate snapshot bound", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "huge-snapshot", {}, { skill: true });
    const resources = join(dir, "skills", "guide", "assets");
    mkdirSync(resources, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      const asset = join(resources, `asset-${String(index)}.bin`);
      writeFileSync(asset, "");
      truncateSync(asset, 7 * 1024 * 1024);
    }

    const loaded = contributions();
    expect(loaded.pin(refs("huge-snapshot"))[0]?.skills).toEqual([]);
    expect(loaded.skillRoots(refs("huge-snapshot"))).toEqual([]);
  });

  it("hashes a canonical list of per-file digests instead of an ambiguous byte stream", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "framed", {}, { skill: true });
    const resources = join(dir, "skills", "guide", "references");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "a"), "X\0resource\0b\0Y");
    const loaded = contributions();
    const single = loaded.snapshot(refs("framed"))[0]!.digest;

    writeFileSync(join(resources, "a"), "X");
    writeFileSync(join(resources, "b"), "Y");
    const split = loaded.snapshot(refs("framed"))[0]!.digest;

    expect(split).not.toBe(single);
  });

  it("rejects an overlong skill manifest while constructing the contribution snapshot", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "long-skill", {}, { skill: true });
    writeFileSync(
      join(dir, "skills", "guide", "SKILL.md"),
      "---\nname: guide\ndescription: guide\n---\n" + "x".repeat(MAX_SKILL_FILE_CHARS + 1),
    );

    const loaded = contributions();
    expect(loaded.pin(refs("long-skill"))[0]?.skills).toEqual([]);
    expect(loaded.skillRoots(refs("long-skill"))).toEqual([]);
  });

  it("withholds every plugin skill when one skill cannot be captured atomically", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "mixed-skills", {}, { skill: true });
    const broken = join(dir, "skills", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      join(broken, "SKILL.md"),
      "---\nname: broken\ndescription: broken\n---\n" + "x".repeat(MAX_SKILL_FILE_CHARS + 1),
    );
    const guide = join(dir, "skills", "guide", "SKILL.md");
    const loaded = contributions();
    expect(loaded.pin(refs("mixed-skills"))[0]?.skills).toEqual([]);
    expect(loaded.skillRoots(refs("mixed-skills"))).toEqual([]);

    writeFileSync(guide, "---\nname: guide\ndescription: guide v2\n---\nchanged\n");
    expect(loaded.skillRoots(refs("mixed-skills"))).toEqual([]);
  });

  it("fingerprints sidecar-derived presentation metadata", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "presented", {}, { skill: true });
    const agents = join(dir, "skills", "guide", "agents");
    mkdirSync(agents, { recursive: true });
    const sidecar = join(agents, "openai.yaml");
    writeFileSync(sidecar, "short-description: First presentation\n");
    const loaded = contributions();
    const before = loaded.snapshot(refs("presented"))[0]!.digest;

    writeFileSync(sidecar, "short-description: Second presentation\n");
    const after = loaded.snapshot(refs("presented"))[0]!.digest;

    expect(after).not.toBe(before);
  });

  it("fingerprints sidecar-derived MCP dependencies", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "dependent", {}, { skill: true });
    const agents = join(dir, "skills", "guide", "agents");
    mkdirSync(agents, { recursive: true });
    const sidecar = join(agents, "openai.yaml");
    writeFileSync(sidecar, "dependencies:\n  tools:\n    - type: mcp\n      value: docs\n");
    const loaded = contributions();
    const before = loaded.snapshot(refs("dependent"))[0]!.digest;

    writeFileSync(sidecar, "dependencies:\n  tools:\n    - type: mcp\n      value: search\n");
    const after = loaded.snapshot(refs("dependent"))[0]!.digest;

    expect(after).not.toBe(before);
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

  it("withdraws a pinned MCP executable when its monitored path changes", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "monitored", {});
    const program = join(dir, "server.sh");
    writeFileSync(program, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "monitored",
        mcpServers: { local: { type: "stdio", command: "./server.sh", cwd: dir } },
      }),
    );
    const events: string[] = [];
    const logger = recordingLogger();
    const watchers: { path: string; changed: () => void; closed: boolean }[] = [];
    const loaded = createPluginContributions({
      globalDir,
      home,
      workspaceRoot,
      logger,
      onRuntimeDrift: ({ path }) => {
        events.push(path);
        throw new Error("fixture drift observer failed");
      },
      watchRuntimePath: (path, changed) => {
        const watcher = { path, changed, closed: false };
        watchers.push(watcher);
        return { close: () => (watcher.closed = true) };
      },
    });
    try {
      expect(loaded.pin(refs("monitored"))).toHaveLength(1);
      expect(loaded.mcpServers(refs("monitored"))).toHaveLength(1);
      expect(watchers.map((watcher) => watcher.path)).toEqual([program]);
      watchers[0]!.changed();
      watchers[0]!.changed();
      expect(events).toEqual([program]);
      expect(logger.events("kernel.plugin.runtime_drift_notice_failed")).toMatchObject([
        { plugin: "monitored", cause: "fixture drift observer failed" },
      ]);
      expect(watchers[0]!.closed).toBeTrue();
      expect(loaded.mcpServers(refs("monitored"))).toEqual([]);
    } finally {
      loaded.close();
    }
  });

  it("observes a physical change to a pinned MCP executable", async () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "physical", {});
    const program = join(dir, "server.sh");
    writeFileSync(program, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "physical",
        mcpServers: { local: { type: "stdio", command: "./server.sh", cwd: dir } },
      }),
    );
    let reportDrift: (() => void) | undefined;
    const drift = new Promise<void>((resolve) => {
      reportDrift = resolve;
    });
    const loaded = createPluginContributions({
      globalDir,
      home,
      workspaceRoot,
      onRuntimeDrift: () => reportDrift?.(),
    });
    try {
      loaded.pin(refs("physical"));
      expect(loaded.mcpServers(refs("physical"))).toHaveLength(1);
      writeFileSync(program, "#!/bin/sh\nexit 1\n");
      utimesSync(program, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
      let fuse: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          drift,
          new Promise<never>((_, reject) => {
            fuse = setTimeout(
              () => reject(new Error("physical watcher did not report drift")),
              5_000,
            );
          }),
        ]);
      } finally {
        if (fuse !== undefined) clearTimeout(fuse);
      }
      expect(loaded.mcpServers(refs("physical"))).toEqual([]);
    } finally {
      loaded.close();
    }
  });

  it("keeps a pinned MCP server available when live path monitoring cannot start", () => {
    const dir = install(globalPaths(globalDir).pluginsDir, "unwatched", {});
    writeFileSync(join(dir, "server.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "unwatched",
        mcpServers: { local: { type: "stdio", command: "./server.sh", cwd: dir } },
      }),
    );
    const logger = recordingLogger();
    const loaded = createPluginContributions({
      globalDir,
      home,
      workspaceRoot,
      logger,
      watchRuntimePath: () => {
        throw new Error("fixture monitor unavailable");
      },
    });
    try {
      expect(loaded.pin(refs("unwatched"))).toHaveLength(1);
      expect(loaded.mcpServers(refs("unwatched"))).toHaveLength(1);
      expect(logger.events("kernel.plugin.runtime_watch_unavailable")).toMatchObject([
        { plugin: "unwatched", cause: "fixture monitor unavailable" },
      ]);
    } finally {
      loaded.close();
    }
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
        executionRoot: dir,
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
