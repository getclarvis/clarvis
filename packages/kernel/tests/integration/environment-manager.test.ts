import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLocalLeaseSync,
  agentsPluginsDirs,
  DIR_MODE,
  globalPaths,
  workspacePaths,
  workspaceStatePaths,
} from "@clarvis/paths";
import type {
  EnvironmentDefinition,
  EnvironmentRef,
  PluginRef,
  WorkspaceTrustVerdict,
} from "@clarvis/protocol";
import { createEnvironmentManager } from "../../src/environments/environment-manager.ts";
import { createPluginContributions } from "../../src/plugins/plugin-contributions.ts";
import { recordingLogger, type RecordingLogger } from "../helpers/logger.ts";

const TRUSTED: WorkspaceTrustVerdict = {
  state: "trusted",
  fingerprint: `sha256:${"1".repeat(64)}`,
};

function definition(
  values: Partial<Omit<EnvironmentDefinition, "schema_version">> = {},
): EnvironmentDefinition {
  return {
    schema_version: 1,
    plugins: [],
    skills: [],
    ...values,
  };
}

function pluginRef(
  name: string,
  scope: PluginRef["scope"] = "global",
  source: PluginRef["source"] = "clarvis",
): PluginRef {
  return { scope, source, name };
}

function installPlugin(root: string, name: string, values: Record<string, unknown> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, ...values }));
  return dir;
}

function writeSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} instructions\n---\n\nUse ${name}.\n`,
  );
}

describe("Environment manager", () => {
  let root: string;
  let globalDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarvis-environment-"));
    globalDir = join(root, "global");
    workspaceRoot = join(root, "workspace");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function manager(cliSelection?: string, logger?: RecordingLogger) {
    return createEnvironmentManager({
      globalDir,
      workspaceRoot,
      home: join(root, "home"),
      pluginContributions: createPluginContributions({
        globalDir,
        home: join(root, "home"),
        workspaceRoot,
        ...(logger === undefined ? {} : { logger }),
      }),
      ...(logger === undefined ? {} : { logger }),
      ...(cliSelection === undefined ? {} : { cliSelection }),
    });
  }

  async function create(
    target: ReturnType<typeof manager>,
    ref: { scope: "global" | "workspace"; name: string },
    value: EnvironmentDefinition,
  ): Promise<void> {
    await target.service.create({ ref, definition: value });
  }

  it("keeps builtin:default virtual, immutable, and exactly qualified", async () => {
    installPlugin(globalPaths(globalDir).pluginsDir, "same", { version: "1.0.0" });
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "same", { version: "2.0.0" });
    writeSkill(globalPaths(globalDir).skillsDir, "environment-global-skill");
    writeSkill(workspacePaths(workspaceRoot).skillsDir, "environment-workspace-skill");
    const target = manager();

    const current = target.resolveActive([pluginRef("same", "workspace")], TRUSTED);

    expect(current).toMatchObject({
      id: "builtin:default",
      immutable: true,
      status: "ready",
      selection_origin: "builtin",
    });
    expect(current.plugins).toHaveLength(1);
    expect(current.plugins[0]).toMatchObject({
      ref: pluginRef("same", "workspace"),
      version: "2.0.0",
      active: true,
    });
    expect(current.standalone_skills.map((skill) => skill.ref.name)).toEqual(
      expect.arrayContaining(["environment-global-skill", "environment-workspace-skill"]),
    );
    expect((await target.service.list())[0]).toEqual({
      ref: { scope: "builtin", name: "default" },
      immutable: true,
    });
  });

  it("materializes an empty global catalog without writing into the workspace", async () => {
    const target = manager();
    const globalCatalog = globalPaths(globalDir).environmentsDir;
    const workspaceCatalog = workspacePaths(workspaceRoot).environmentsDir;
    expect(existsSync(globalCatalog)).toBeFalse();
    expect(existsSync(workspaceCatalog)).toBeFalse();

    expect(await target.service.list()).toEqual([
      { ref: { scope: "builtin", name: "default" }, immutable: true },
    ]);

    expect(existsSync(globalCatalog)).toBeTrue();
    expect(statSync(globalCatalog).mode & 0o777).toBe(DIR_MODE);
    expect(existsSync(workspaceCatalog)).toBeFalse();
  });

  it("activates a configured .agents plugin in builtin:default without a custom Environment", () => {
    const agents = agentsPluginsDirs({ home: join(root, "home"), cwd: workspaceRoot, env: {} });
    installPlugin(agents.user, "portable", { version: "agent-v1" });
    const selected = pluginRef("portable", "global", "agents");
    const target = manager();

    const current = target.resolveActive([selected], TRUSTED);

    expect(current.status).toBe("ready");
    expect(current.plugins).toEqual([
      expect.objectContaining({ ref: selected, version: "agent-v1", active: true }),
    ]);
    expect(target.activePlugins()).toEqual([selected]);
  });

  it("inventories all four scope/source plugin roots independently", async () => {
    const agents = agentsPluginsDirs({ home: join(root, "home"), cwd: workspaceRoot, env: {} });
    installPlugin(globalPaths(globalDir).pluginsDir, "global-native");
    installPlugin(agents.user, "global-shared");
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "workspace-native");
    installPlugin(agents.workspace, "workspace-shared");

    const target = manager();
    target.resolveActive([], TRUSTED);
    const inventory = await target.service.inventory();

    expect(inventory.plugins).toHaveLength(4);
  });

  it("returns every exact plugin and standalone skill origin to the composer", async () => {
    const agents = agentsPluginsDirs({ home: join(root, "home"), cwd: workspaceRoot, env: {} });
    installPlugin(globalPaths(globalDir).pluginsDir, "same", { version: "global-clarvis" });
    installPlugin(agents.user, "same", { version: "global-agents" });
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "same", {
      version: "workspace-clarvis",
    });
    installPlugin(agents.workspace, "same", { version: "workspace-agents" });
    writeSkill(globalPaths(globalDir).skillsDir, "same-skill");
    writeSkill(join(root, "home", ".agents", "skills"), "same-skill");
    writeSkill(workspacePaths(workspaceRoot).skillsDir, "same-skill");
    writeSkill(join(workspaceRoot, ".agents", "skills"), "same-skill");
    const target = manager();
    target.resolveActive([], TRUSTED);

    const inventory = await target.service.inventory();

    expect(
      inventory.plugins.map((plugin) => [plugin.ref.scope, plugin.ref.source, plugin.version]),
    ).toEqual([
      ["global", "agents", "global-agents"],
      ["global", "clarvis", "global-clarvis"],
      ["workspace", "agents", "workspace-agents"],
      ["workspace", "clarvis", "workspace-clarvis"],
    ]);
    expect(inventory.plugins.every((plugin) => !plugin.active)).toBeTrue();
    expect(inventory.standalone_skills.map((skill) => skill.ref)).toEqual([
      { scope: "user", source: "agents", name: "same-skill" },
      { scope: "workspace", source: "agents", name: "same-skill" },
      { scope: "user", source: "clarvis", name: "same-skill" },
      { scope: "workspace", source: "clarvis", name: "same-skill" },
    ]);
    expect(inventory.standalone_skills.every((skill) => skill.found && !skill.active)).toBeTrue();
  });

  it("keeps builtin standalone skill shadowing identical to four-root discovery", async () => {
    writeSkill(globalPaths(globalDir).skillsDir, "same-skill");
    writeSkill(workspacePaths(workspaceRoot).skillsDir, "same-skill");
    const target = manager();

    const current = target.resolveActive([], TRUSTED);

    expect((await target.service.inventory()).standalone_skills).toHaveLength(2);
    expect(current.standalone_skills).toEqual([
      expect.objectContaining({
        ref: { scope: "workspace", source: "clarvis", name: "same-skill" },
        active: true,
      }),
    ]);
  });

  it("uses exact qualified plugin installs and a custom allowlist never inherits default enablement", async () => {
    const agents = agentsPluginsDirs({ home: join(root, "home"), cwd: workspaceRoot, env: {} });
    installPlugin(globalPaths(globalDir).pluginsDir, "same", { version: "1.0.0" });
    installPlugin(agents.user, "same", { version: "agent-v1" });
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "same", { version: "2.0.0" });
    installPlugin(globalPaths(globalDir).pluginsDir, "default-only", { version: "3.0.0" });
    const setup = manager();
    await create(
      setup,
      { scope: "global", name: "research" },
      definition({ plugins: [pluginRef("same", "global", "agents")] }),
    );
    const target = manager("global:research");

    const current = target.resolveActive([pluginRef("default-only")], TRUSTED);

    expect(current.status).toBe("ready");
    expect(current.plugins).toEqual([
      expect.objectContaining({
        ref: pluginRef("same", "global", "agents"),
        version: "agent-v1",
        active: true,
      }),
    ]);
    expect(target.activePlugins()).toEqual([pluginRef("same", "global", "agents")]);
  });

  it("fails closed when exact installs collide on one plugin namespace", () => {
    const agents = agentsPluginsDirs({ home: join(root, "home"), cwd: workspaceRoot, env: {} });
    installPlugin(globalPaths(globalDir).pluginsDir, "same", { version: "clarvis-v1" });
    installPlugin(agents.user, "same", { version: "agents-v1" });
    const target = manager();
    const current = target.resolveActive(
      [pluginRef("same"), pluginRef("same", "global", "agents")],
      TRUSTED,
    );

    expect(current.status).toBe("invalid");
    expect(current.plugins).toEqual([]);
    expect(current.issues).toEqual([
      expect.objectContaining({
        code: "duplicate_plugin_name",
        plugin: pluginRef("same", "global", "agents"),
      }),
    ]);
    expect(target.activePlugins()).toEqual([]);
  });

  it("degrades an installed plugin whose manifest cannot enter the atomic snapshot", async () => {
    const pluginDir = join(globalPaths(globalDir).pluginsDir, "broken");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), "{ not json");
    const setup = manager();
    await create(
      setup,
      { scope: "global", name: "broken-plugin" },
      definition({ plugins: [pluginRef("broken")] }),
    );

    const current = manager("global:broken-plugin").resolveActive([], TRUSTED);

    expect(current.status).toBe("degraded");
    expect(current.plugins).toEqual([
      expect.objectContaining({
        ref: pluginRef("broken"),
        active: false,
        installed: true,
        valid: false,
        error: expect.stringContaining("invalid JSON"),
      }),
    ]);
    expect(current.issues).toEqual([
      expect.objectContaining({ code: "invalid_plugin", plugin: pluginRef("broken") }),
    ]);
  });

  it("keeps unselected installed plugin trees off the active-resolution path", async () => {
    const setup = manager();
    await create(setup, { scope: "global", name: "minimal" }, definition());
    for (let index = 0; index < 64; index += 1) {
      const name = `inactive-${String(index).padStart(2, "0")}`;
      const dir = installPlugin(globalPaths(globalDir).pluginsDir, name, { skills: "./skills" });
      writeSkill(join(dir, "skills"), `${name}-skill`);
    }
    const logger = recordingLogger();
    const target = manager("global:minimal", logger);

    const current = target.resolveActive([], TRUSTED);

    expect(current.status).toBe("ready");
    expect(current.plugins).toEqual([]);
    expect(logger.events("skills.discovered")).toEqual([]);
    expect(logger.events("skill.body_disclosed")).toEqual([]);
    expect((await target.service.inventory()).plugins).toHaveLength(64);
  });

  it("counts installed plugin skills separately from the active atomic contribution", async () => {
    const activeDir = installPlugin(globalPaths(globalDir).pluginsDir, "active", {
      skills: "./skills",
    });
    const inactiveDir = installPlugin(globalPaths(globalDir).pluginsDir, "inactive", {
      skills: "./skills",
    });
    writeSkill(join(activeDir, "skills"), "active-skill");
    writeSkill(join(inactiveDir, "skills"), "inactive-skill");
    const setup = manager();
    await create(
      setup,
      { scope: "global", name: "one-plugin" },
      definition({ plugins: [pluginRef("active")] }),
    );

    const current = manager("global:one-plugin").resolveActive([], TRUSTED);

    expect(current.counts.plugin_skills_active).toBe(1);
    expect(
      (await manager("global:one-plugin").service.inventory()).plugins.reduce(
        (total, plugin) => total + plugin.skills.length,
        0,
      ),
    ).toBe(2);
  });

  it("selects only exact standalone skills and passes exact include filters to @clarvis/skills", async () => {
    writeSkill(globalPaths(globalDir).skillsDir, "only-global");
    writeSkill(globalPaths(globalDir).skillsDir, "not-selected");
    writeSkill(join(workspaceRoot, ".agents", "skills"), "only-workspace-agents");
    const setup = manager();
    await create(
      setup,
      { scope: "workspace", name: "skills" },
      definition({
        skills: [
          { scope: "user", source: "clarvis", name: "only-global" },
          { scope: "workspace", source: "agents", name: "only-workspace-agents" },
        ],
      }),
    );
    const target = manager("workspace:skills");

    const current = target.resolveActive([], TRUSTED);

    expect(current.standalone_skills.map((skill) => skill.ref.name)).toEqual([
      "only-global",
      "only-workspace-agents",
    ]);
    expect(target.skillRoots()).toEqual([
      {
        path: join(workspaceRoot, ".agents", "skills"),
        scope: "workspace",
        source: "agents",
        include: ["only-workspace-agents"],
      },
      {
        path: globalPaths(globalDir).skillsDir,
        scope: "user",
        source: "clarvis",
        include: ["only-global"],
      },
    ]);
  });

  it("degrades on missing inventory without falling back to builtin extensions", async () => {
    installPlugin(globalPaths(globalDir).pluginsDir, "default-only", {});
    const setup = manager();
    await create(
      setup,
      { scope: "global", name: "missing" },
      definition({
        plugins: [pluginRef("default-only", "global", "agents")],
        skills: [{ scope: "user", source: "clarvis", name: "absent" }],
      }),
    );
    const target = manager("global:missing");

    const current = target.resolveActive([pluginRef("default-only")], TRUSTED);

    expect(current.status).toBe("degraded");
    expect(current.counts.plugins_active).toBe(0);
    expect(current.issues.map((issue) => issue.code)).toEqual(["missing_plugin", "missing_skill"]);
    expect(target.activePlugins()).toEqual([]);
  });

  it("fails closed for an invalid persisted selection", () => {
    installPlugin(globalPaths(globalDir).pluginsDir, "default-only", {});
    const selection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(selection, ".."), { recursive: true });
    writeFileSync(selection, "not json");
    const target = manager();

    const current = target.resolveActive([pluginRef("default-only")], TRUSTED);

    expect(current.status).toBe("invalid");
    expect(current.selection_origin).toBe("workspace");
    expect(current.issues[0]?.code).toBe("invalid_selection");
    expect(current.counts.plugins_active).toBe(0);
  });

  it("diagnoses an unknown persisted builtin without falling back or aborting boot", () => {
    const selection = globalPaths(globalDir).environmentSelectionFile;
    mkdirSync(join(selection, ".."), { recursive: true });
    writeFileSync(
      selection,
      JSON.stringify({
        schema_version: 1,
        environment: { scope: "builtin", name: "future" },
      }),
    );

    const current = manager().resolveActive([], TRUSTED);

    expect(current.status).toBe("invalid");
    expect(current.selection_origin).toBe("global");
    expect(current.issues).toEqual([
      { code: "invalid_selection", message: "unknown builtin Environment 'future'" },
    ]);
  });

  it("does not let an invalid workspace definition fall through a bare CLI selector", async () => {
    const setup = manager();
    await create(setup, { scope: "global", name: "research" }, definition());
    const workspaceDefinition = join(
      workspacePaths(workspaceRoot).environmentsDir,
      "research.json",
    );
    mkdirSync(join(workspaceDefinition, ".."), { recursive: true });
    writeFileSync(workspaceDefinition, "not json");

    const current = manager("research").resolveActive([], TRUSTED);

    expect(current.id).toBe("workspace:research");
    expect(current.status).toBe("invalid");
    expect(current.issues[0]?.code).toBe("invalid_definition");
  });

  it("uses CLI over local workspace over global selection precedence", async () => {
    const setup = manager();
    for (const [scope, name] of [
      ["global", "operator"],
      ["global", "local"],
      ["global", "command"],
    ] as const) {
      await create(setup, { scope, name }, definition({ description: name }));
    }
    const globalSelection = globalPaths(globalDir).environmentSelectionFile;
    const workspaceSelection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(globalSelection, ".."), { recursive: true });
    mkdirSync(join(workspaceSelection, ".."), { recursive: true });
    writeFileSync(
      globalSelection,
      JSON.stringify({
        schema_version: 1,
        environment: { scope: "global", name: "operator" },
      }),
    );
    writeFileSync(
      workspaceSelection,
      JSON.stringify({
        schema_version: 1,
        environment: { scope: "global", name: "local" },
      }),
    );

    expect(manager().resolveActive([], TRUSTED).id).toBe("global:local");
    expect(manager("global:command").resolveActive([], TRUSTED).id).toBe("global:command");
    rmSync(workspaceSelection);
    expect(manager().resolveActive([], TRUSTED).id).toBe("global:operator");
  });

  it("pins the current snapshot and rejects a stale preview token with CAS semantics", async () => {
    const target = manager();
    const pinned = target.resolveActive([], TRUSTED);
    const ref = { scope: "global" as const, name: "minimal" };
    const created = await target.service.create({ ref, definition: definition() });
    const preview = await target.service.preview(ref, { selection_scope: "workspace" });
    await target.service.update({
      ref,
      definition: definition({ description: "changed" }),
      expected_revision: created.revision!,
    });

    await expect(
      target.service.select(ref, {
        selection_scope: "workspace",
        preview_token: preview.token,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await target.service.current()).toEqual(pinned);
    expect(target.runRef()).toEqual({ id: pinned.id, fingerprint: pinned.fingerprint });

    const scopedPreview = await target.service.preview(ref, { selection_scope: "workspace" });
    expect(scopedPreview.target.selection_origin).toBe("workspace");
    await expect(
      target.service.select(ref, {
        selection_scope: "global",
        preview_token: scopedPreview.token,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const revisionPreview = await target.service.preview(ref, { selection_scope: "workspace" });
    const workspaceSelection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(workspaceSelection, ".."), { recursive: true });
    writeFileSync(
      workspaceSelection,
      JSON.stringify({ schema_version: 1, environment: { scope: "builtin", name: "default" } }),
    );
    await expect(
      target.service.select(ref, {
        selection_scope: "workspace",
        preview_token: revisionPreview.token,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const currentPreview = await target.service.preview(ref, { selection_scope: "workspace" });
    await target.service.select(ref, {
      selection_scope: "workspace",
      preview_token: currentPreview.token,
    });
    expect((await target.service.current()).id).toBe("builtin:default");
    expect(manager().resolveActive([], TRUSTED).id).toBe("global:minimal");
  });

  it("previews and applies one exact definition plus selection transaction", async () => {
    installPlugin(globalPaths(globalDir).pluginsDir, "context7", {
      mcpServers: { docs: { command: "context7" } },
    });
    writeSkill(globalPaths(globalDir).skillsDir, "research");
    const target = manager();
    const pinned = target.resolveActive([], TRUSTED);
    const input = {
      ref: { scope: "global" as const, name: "research" },
      expected_revision: null,
      selection_scope: "workspace" as const,
      definition: definition({
        plugins: [pluginRef("context7")],
        skills: [{ scope: "user" as const, source: "clarvis" as const, name: "research" }],
      }),
    };

    const preview = await target.service.previewComposition(input);

    expect(preview.current).toEqual(pinned);
    expect(preview.authored.id).toBe("global:research");
    expect(preview.authored.plugins[0]).toMatchObject({
      active: true,
      mcp_servers: ["context7:docs"],
    });
    expect(preview.target.id).toBe("global:research");
    expect(preview.delta.plugins_entering).toEqual([pluginRef("context7")]);
    expect(preview.delta.mcp_servers_entering).toEqual(["context7:docs"]);
    expect(existsSync(join(globalPaths(globalDir).environmentsDir, "research.json"))).toBeFalse();

    const applied = await target.service.applyComposition(input, {
      preview_token: preview.token,
    });

    expect(applied).toMatchObject({
      selected: input.ref,
      effective: input.ref,
      reconnect_required: true,
    });
    expect(applied.definition.definition).toEqual(input.definition);
    expect((await target.service.current()).fingerprint).toBe(pinned.fingerprint);
    expect(manager().resolveActive([], TRUSTED)).toMatchObject({
      id: "global:research",
      counts: { plugins_active: 1, standalone_skills_active: 1, mcp_servers_active: 1 },
    });
    await expect(
      target.service.applyComposition(input, { preview_token: preview.token }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects composition drift before writing either definition or selection", async () => {
    const plugin = installPlugin(globalPaths(globalDir).pluginsDir, "mutable", {
      version: "one",
    });
    const target = manager();
    target.resolveActive([], TRUSTED);
    const input = {
      ref: { scope: "global" as const, name: "drift" },
      expected_revision: null,
      selection_scope: "workspace" as const,
      definition: definition({ plugins: [pluginRef("mutable")] }),
    };
    const preview = await target.service.previewComposition(input);
    writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "mutable", version: "two" }));

    await expect(
      target.service.applyComposition(input, { preview_token: preview.token }),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(existsSync(join(globalPaths(globalDir).environmentsDir, "drift.json"))).toBeFalse();
    expect(
      existsSync(
        workspaceStatePaths(workspaceRoot, { env: { CLARVIS_HOME: globalDir } })
          .environmentSelectionFile,
      ),
    ).toBeFalse();
  });

  it("rejects a stale definition revision before a composition can change selection", async () => {
    const target = manager();
    const ref = { scope: "global" as const, name: "existing" };
    const created = await target.service.create({ ref, definition: definition() });
    target.resolveActive([], TRUSTED);
    const input = {
      ref,
      expected_revision: created.revision!,
      selection_scope: "workspace" as const,
      definition: definition({ description: "reviewed draft" }),
    };
    const preview = await target.service.previewComposition(input);
    await target.service.update({
      ref,
      expected_revision: created.revision!,
      definition: definition({ description: "concurrent edit" }),
    });

    await expect(
      target.service.applyComposition(input, { preview_token: preview.token }),
    ).rejects.toMatchObject({ code: "conflict" });

    expect((await target.service.get(ref)).description).toBe("concurrent edit");
    expect(
      existsSync(
        workspaceStatePaths(workspaceRoot, { env: { CLARVIS_HOME: globalDir } })
          .environmentSelectionFile,
      ),
    ).toBeFalse();
  });

  it("restores definition and selection bytes when composition trust approval fails", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner", {});
    const target = manager();
    target.bindRuntime({
      readWorkspaceTrust: () => ({ state: "unapproved" }),
      approveWorkspace: () => {
        throw new Error("approval store unavailable");
      },
    });
    target.resolveActive([], { state: "unapproved" });
    const input = {
      ref: { scope: "workspace" as const, name: "project" },
      expected_revision: null,
      selection_scope: "workspace" as const,
      definition: definition({ plugins: [pluginRef("runner", "workspace")] }),
    };
    const preview = await target.service.previewComposition(input);
    expect(preview.requires_workspace_trust).toBeTrue();

    await expect(
      target.service.applyComposition(input, {
        preview_token: preview.token,
        approve_workspace: true,
      }),
    ).rejects.toThrow("approval store unavailable");

    expect(
      existsSync(join(workspacePaths(workspaceRoot).environmentsDir, "project.json")),
    ).toBeFalse();
    expect(
      existsSync(
        workspaceStatePaths(workspaceRoot, { env: { CLARVIS_HOME: globalDir } })
          .environmentSelectionFile,
      ),
    ).toBeFalse();
  });

  it("previews normal precedence when a workspace choice shadows a new global default", async () => {
    const setup = manager();
    const local = { scope: "workspace" as const, name: "local" };
    await create(setup, local, definition({ description: "local" }));
    const selection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(selection, ".."), { recursive: true });
    writeFileSync(selection, JSON.stringify({ schema_version: 1, environment: local }));
    const target = manager();
    target.resolveActive([], TRUSTED);
    const input = {
      ref: { scope: "global" as const, name: "operator" },
      expected_revision: null,
      selection_scope: "global" as const,
      definition: definition({ description: "operator" }),
    };

    const preview = await target.service.previewComposition(input);

    expect(preview.authored.id).toBe("global:operator");
    expect(preview.target.id).toBe("workspace:local");
    expect(preview.delta).toEqual({
      plugins_entering: [],
      plugins_leaving: [],
      skills_entering: [],
      skills_leaving: [],
      mcp_servers_entering: [],
      mcp_servers_leaving: [],
      hooks_entering: [],
      hooks_leaving: [],
    });
    const applied = await target.service.applyComposition(input, {
      preview_token: preview.token,
    });
    expect(applied.effective).toEqual(local);
    expect(manager().resolveActive([], TRUSTED).id).toBe("workspace:local");
  });

  it("does not approve an unchanged untrusted workspace target shadowing a global composition", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner", {});
    const setup = manager();
    const local = { scope: "workspace" as const, name: "local" };
    await create(setup, local, definition({ plugins: [pluginRef("runner", "workspace")] }));
    const workspaceSelection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(workspaceSelection, ".."), { recursive: true });
    writeFileSync(workspaceSelection, JSON.stringify({ schema_version: 1, environment: local }));
    const target = manager();
    const unapproved: WorkspaceTrustVerdict = { state: "unapproved" };
    target.bindRuntime({
      readWorkspaceTrust: () => unapproved,
      approveWorkspace: () => {
        throw new Error("a shadowed global composition must not approve workspace trust");
      },
    });
    const current = target.resolveActive([], unapproved);
    const input = {
      ref: { scope: "global" as const, name: "operator" },
      expected_revision: null,
      selection_scope: "global" as const,
      definition: definition({ description: "operator" }),
    };

    const preview = await target.service.previewComposition(input);

    expect(preview.target.id).toBe("workspace:local");
    expect(preview.target.fingerprint).toBe(current.fingerprint);
    expect(preview.requires_workspace_trust).toBeFalse();
    await expect(
      target.service.applyComposition(input, { preview_token: preview.token }),
    ).resolves.toMatchObject({ effective: local });
    expect(manager().resolveActive([], unapproved).id).toBe("workspace:local");
  });

  it("previews a global write through workspace selection precedence", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner", {});
    const setup = manager();
    const operator = { scope: "global" as const, name: "operator" };
    const local = { scope: "workspace" as const, name: "local" };
    await create(setup, operator, definition({ description: "operator" }));
    await create(
      setup,
      local,
      definition({ description: "local", plugins: [pluginRef("runner", "workspace")] }),
    );
    const workspaceSelection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(workspaceSelection, ".."), { recursive: true });
    writeFileSync(workspaceSelection, JSON.stringify({ schema_version: 1, environment: local }));
    const target = manager();
    const unapproved: WorkspaceTrustVerdict = {
      state: "unapproved",
      fingerprint: `sha256:${"4".repeat(64)}`,
    };
    target.bindRuntime({
      readWorkspaceTrust: () => unapproved,
      approveWorkspace: () => {
        throw new Error("a shadowed global write must not approve workspace trust");
      },
    });
    const current = target.resolveActive([], unapproved);
    expect(current.id).toBe("workspace:local");
    expect(current.status).toBe("degraded");

    const preview = await target.service.preview(operator, { selection_scope: "global" });

    expect(preview.target.id).toBe("workspace:local");
    expect(preview.target.fingerprint).toBe(current.fingerprint);
    expect(preview.requires_workspace_trust).toBeFalse();
    expect(preview.delta.plugins_entering).toEqual([]);
    expect(preview.delta.plugins_leaving).toEqual([]);
    writeFileSync(
      workspaceSelection,
      `${JSON.stringify({ schema_version: 1, environment: local }, null, 2)}\n`,
    );
    await expect(
      target.service.select(operator, {
        selection_scope: "global",
        preview_token: preview.token,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const fresh = await target.service.preview(operator, { selection_scope: "global" });
    await target.service.select(operator, {
      selection_scope: "global",
      preview_token: fresh.token,
    });
    expect(manager().resolveActive([], unapproved).id).toBe("workspace:local");
  });

  it("previews and compare-and-swaps the fallback before clearing a local selection", async () => {
    const setup = manager();
    await create(
      setup,
      { scope: "global", name: "operator" },
      definition({ description: "operator" }),
    );
    await create(setup, { scope: "global", name: "local" }, definition({ description: "local" }));
    const globalSelection = globalPaths(globalDir).environmentSelectionFile;
    const workspaceSelection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(globalSelection, ".."), { recursive: true });
    mkdirSync(join(workspaceSelection, ".."), { recursive: true });
    writeFileSync(
      globalSelection,
      JSON.stringify({
        schema_version: 1,
        environment: { scope: "global", name: "operator" },
      }),
    );
    writeFileSync(
      workspaceSelection,
      JSON.stringify({
        schema_version: 1,
        environment: { scope: "global", name: "local" },
      }),
    );
    const target = manager();
    expect(target.resolveActive([], TRUSTED).id).toBe("global:local");

    const preview = await target.service.previewClear("workspace");
    expect(preview.target.id).toBe("global:operator");
    await expect(
      target.service.clearSelection("global", { preview_token: preview.token }),
    ).rejects.toMatchObject({ code: "conflict" });
    const staleBytes = await target.service.previewClear("workspace");
    writeFileSync(
      workspaceSelection,
      `${JSON.stringify({ schema_version: 1, environment: { scope: "global", name: "local" } }, null, 2)}\n`,
    );
    await expect(
      target.service.clearSelection("workspace", { preview_token: staleBytes.token }),
    ).rejects.toMatchObject({ code: "conflict" });
    const fresh = await target.service.previewClear("workspace");
    await target.service.clearSelection("workspace", { preview_token: fresh.token });

    expect(existsSync(workspaceSelection)).toBeFalse();
    expect(manager().resolveActive([], TRUSTED).id).toBe("global:operator");
  });

  it("previews workspace executable trust, records it in the surface, and approves explicitly", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner", {
      mcpServers: { files: { command: "runner" } },
    });
    const setup = manager();
    const ref = { scope: "workspace" as const, name: "project" };
    await create(setup, ref, definition({ plugins: [pluginRef("runner", "workspace")] }));
    const target = manager();
    let trust: WorkspaceTrustVerdict = {
      state: "unapproved",
      fingerprint: `sha256:${"2".repeat(64)}`,
    };
    let approvals = 0;
    target.bindRuntime({
      readWorkspaceTrust: () => trust,
      approveWorkspace: () => {
        approvals += 1;
        trust = { ...trust, state: "trusted", approved: trust.fingerprint };
      },
    });
    target.resolveActive([], TRUSTED);

    const preview = await target.service.preview(ref, { selection_scope: "workspace" });

    expect(preview.requires_workspace_trust).toBeTrue();
    expect(preview.target.status).toBe("ready");
    expect(preview.delta.plugins_entering).toEqual([pluginRef("runner", "workspace")]);
    await target.service.select(ref, {
      selection_scope: "workspace",
      preview_token: preview.token,
      approve_workspace: true,
    });
    expect(approvals).toBe(1);
    expect(target.workspaceTrustSurface()).toMatchObject({
      environment: ref,
      plugins: [pluginRef("runner", "workspace")],
    });
    const reconnected = manager();
    reconnected.bindRuntime({
      readWorkspaceTrust: () => trust,
      approveWorkspace: () => undefined,
    });
    expect(reconnected.resolveActive([], trust).fingerprint).toBe(preview.target.fingerprint);
  });

  it("recomposes selected workspace plugins when trust changes at an idle boundary", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner", {
      mcpServers: { files: { command: "runner" } },
    });
    const setup = manager();
    const ref = { scope: "workspace" as const, name: "project" };
    await create(setup, ref, definition({ plugins: [pluginRef("runner", "workspace")] }));
    const selection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(selection, ".."), { recursive: true });
    writeFileSync(selection, JSON.stringify({ schema_version: 1, environment: ref }));
    let running = false;
    let trust: WorkspaceTrustVerdict = {
      state: "unapproved",
      fingerprint: `sha256:${"3".repeat(64)}`,
    };
    const target = manager();
    target.bindRuntime({
      readWorkspaceTrust: () => trust,
      approveWorkspace: () => undefined,
      hasActiveRuns: () => running,
    });

    const withheld = target.resolveActive([], trust);
    expect(withheld.plugins[0]).toMatchObject({ active: false });
    running = true;
    trust = { ...trust, state: "trusted", approved: trust.fingerprint };
    expect(() => target.resolveActive([], trust)).toThrow(/finish active runs/);
    running = false;

    const approved = target.resolveActive([], trust);
    expect(approved.plugins[0]).toMatchObject({ active: true });
    expect(approved.fingerprint).not.toBe(withheld.fingerprint);
    trust = { ...trust, state: "unapproved" };
    const revoked = target.resolveActive([], trust);
    expect(revoked.plugins[0]).toMatchObject({ active: false });
  });

  it("fingerprints resolved companion MCP, plugin skill, and process-file bytes", async () => {
    const dir = installPlugin(globalPaths(globalDir).pluginsDir, "atlas", {
      mcpServers: "./.mcp.json",
      skills: "./skills",
      capabilityExecutables: {
        memory: { command: "python3", args: ["./provider.py"] },
      },
    });
    const companion = join(dir, ".mcp.json");
    const provider = join(dir, "provider.py");
    writeFileSync(companion, JSON.stringify({ mcpServers: { docs: { command: "atlas-v1" } } }));
    writeFileSync(provider, "print('v1')\n");
    writeSkill(join(dir, "skills"), "atlas-guide");
    const setup = manager();
    const ref = { scope: "global" as const, name: "atlas" };
    await create(setup, ref, definition({ plugins: [pluginRef("atlas")] }));

    const before = manager("global:atlas").resolveActive([], TRUSTED);
    writeFileSync(companion, JSON.stringify({ mcpServers: { docs: { command: "atlas-v2" } } }));
    const afterMcp = manager("global:atlas").resolveActive([], TRUSTED);
    writeFileSync(
      join(dir, "skills", "atlas-guide", "SKILL.md"),
      "---\nname: atlas-guide\ndescription: changed\n---\n\nUse changed guidance.\n",
    );
    const afterSkill = manager("global:atlas").resolveActive([], TRUSTED);
    writeFileSync(provider, "print('v2')\n");
    const afterProcess = manager("global:atlas").resolveActive([], TRUSTED);

    expect(afterMcp.fingerprint).not.toBe(before.fingerprint);
    expect(afterSkill.fingerprint).not.toBe(afterMcp.fingerprint);
    expect(afterProcess.fingerprint).not.toBe(afterSkill.fingerprint);
  });

  it("fingerprints standalone skill resources and rejects their drift until reconnect", () => {
    const root = globalPaths(globalDir).skillsDir;
    writeSkill(root, "research");
    const resource = join(root, "research", "reference.md");
    writeFileSync(resource, "version one\n");
    const target = manager();
    const before = target.resolveActive([], TRUSTED);

    writeFileSync(resource, "version two\n");

    expect(() => target.skillRoots()).toThrow(/reconnect the kernel/);
    const after = manager().resolveActive([], TRUSTED);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("requires a fresh workspace approval when switching between executable Environments", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner-a", {});
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner-b", {});
    const setup = manager();
    const first = { scope: "workspace" as const, name: "first" };
    const second = { scope: "workspace" as const, name: "second" };
    await create(setup, first, definition({ plugins: [pluginRef("runner-a", "workspace")] }));
    await create(setup, second, definition({ plugins: [pluginRef("runner-b", "workspace")] }));
    const selection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    mkdirSync(join(selection, ".."), { recursive: true });
    writeFileSync(selection, JSON.stringify({ schema_version: 1, environment: first }));
    const target = manager();
    let approvals = 0;
    target.bindRuntime({
      readWorkspaceTrust: () => TRUSTED,
      approveWorkspace: () => {
        approvals += 1;
      },
    });
    expect(target.resolveActive([], TRUSTED).id).toBe("workspace:first");

    const preview = await target.service.preview(second, { selection_scope: "workspace" });

    expect(preview.requires_workspace_trust).toBeTrue();
    await target.service.select(second, {
      selection_scope: "workspace",
      preview_token: preview.token,
      approve_workspace: true,
    });
    expect(approvals).toBe(1);
    expect(manager().resolveActive([], TRUSTED).id).toBe("workspace:second");
  });

  it("restores the prior selection when workspace approval fails", async () => {
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "runner", {});
    const setup = manager();
    const ref = { scope: "workspace" as const, name: "project" };
    await create(setup, ref, definition({ plugins: [pluginRef("runner", "workspace")] }));
    const target = manager();
    target.bindRuntime({
      readWorkspaceTrust: () => ({ state: "unapproved" }),
      approveWorkspace: () => {
        throw new Error("approval store unavailable");
      },
    });
    target.resolveActive([], TRUSTED);
    const preview = await target.service.preview(ref, { selection_scope: "workspace" });

    await expect(
      target.service.select(ref, {
        selection_scope: "workspace",
        preview_token: preview.token,
        approve_workspace: true,
      }),
    ).rejects.toThrow("approval store unavailable");

    const selection = workspaceStatePaths(workspaceRoot, {
      env: { CLARVIS_HOME: globalDir },
    }).environmentSelectionFile;
    expect(existsSync(selection)).toBeFalse();
    expect(manager().resolveActive([], TRUSTED).id).toBe("builtin:default");
  });

  it("rejects unsafe authored combinations and supports cloning builtin:default", async () => {
    installPlugin(globalPaths(globalDir).pluginsDir, "global-plugin", {});
    installPlugin(workspacePaths(workspaceRoot).pluginsDir, "workspace-plugin", {});
    const target = manager();
    target.resolveActive([pluginRef("global-plugin")], TRUSTED);

    await expect(
      target.service.create({
        ref: { scope: "global", name: "bad" },
        definition: definition({
          plugins: [pluginRef("workspace-plugin", "workspace")],
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      target.service.create({
        ref: { scope: "workspace", name: "duplicate" },
        definition: definition({
          plugins: [pluginRef("same"), pluginRef("same", "workspace")],
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      target.service.create({
        ref: { scope: "workspace", name: "duplicate-skill" },
        definition: definition({
          skills: [
            { scope: "user", source: "agents", name: "same-skill" },
            { scope: "workspace", source: "clarvis", name: "same-skill" },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(target.service.get({ scope: "builtin", name: "unknown" })).rejects.toMatchObject({
      code: "not_found",
    });

    const cloned = await target.service.clone(
      { scope: "builtin", name: "default" },
      { scope: "global", name: "clone" },
    );
    expect(cloned.definition?.plugins).toEqual([pluginRef("global-plugin")]);
  });

  it("clones builtin:default rather than the currently selected custom Environment", async () => {
    installPlugin(globalPaths(globalDir).pluginsDir, "legacy", {});
    const setup = manager();
    await create(setup, { scope: "global", name: "custom" }, definition());
    const target = manager("global:custom");
    expect(target.resolveActive([pluginRef("legacy")], TRUSTED).plugins).toEqual([]);

    const cloned = await target.service.clone(
      { scope: "builtin", name: "default" },
      { scope: "global", name: "builtin-clone" },
    );

    expect(cloned.definition?.plugins).toEqual([pluginRef("legacy")]);
  });

  it("serializes definition CAS writes with the shared local lease", async () => {
    const target = manager();
    const ref = { scope: "global" as const, name: "leased" };
    const created = await target.service.create({ ref, definition: definition() });
    const path = join(globalPaths(globalDir).environmentsDir, "leased.json");
    const lease = acquireLocalLeaseSync(`${path}.lock`, { staleMs: 60_000 });
    expect(lease).not.toBeNull();
    try {
      await expect(
        target.service.update({
          ref,
          definition: definition({ description: "blocked" }),
          expected_revision: created.revision!,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      lease?.release();
    }

    const updated = await target.service.update({
      ref,
      definition: definition({ description: "written" }),
      expected_revision: created.revision!,
    });
    expect(updated.definition?.description).toBe("written");
  });

  it("deletes only an inactive authored Environment at its exact revision", async () => {
    const setup = manager();
    const removable = { scope: "global" as const, name: "removable" };
    const selected = { scope: "global" as const, name: "selected" };
    const removableView = await setup.service.create({
      ref: removable,
      definition: definition({ description: "remove me" }),
    });
    const selectedView = await setup.service.create({
      ref: selected,
      definition: definition({ description: "keep me" }),
    });

    await expect(
      setup.service.delete(removable, { expected_revision: `sha256:${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await setup.service.get(removable)).description).toBe("remove me");

    await setup.service.delete(removable, { expected_revision: removableView.revision! });
    expect((await setup.service.get(removable)).status).toBe("invalid");
    expect(
      (await setup.service.list()).some((view) => view.ref.name === removable.name),
    ).toBeFalse();

    const active = manager("global:selected");
    active.resolveActive([], TRUSTED);
    await expect(
      active.service.delete(selected, { expected_revision: selectedView.revision! }),
    ).rejects.toThrow("select another Environment and reconnect");
    expect((await active.service.get(selected)).description).toBe("keep me");
  });

  it("serializes catalog creates and enforces both catalog resource bounds", async () => {
    const target = manager();
    const dir = globalPaths(globalDir).environmentsDir;
    const catalogLease = acquireLocalLeaseSync(`${dir}.lock`, { staleMs: 60_000 });
    expect(catalogLease).not.toBeNull();
    try {
      await expect(
        target.service.create({
          ref: { scope: "global", name: "blocked" },
          definition: definition(),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      catalogLease?.release();
    }

    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 128; index += 1) {
      writeFileSync(join(dir, `bounded-${String(index).padStart(3, "0")}.json`), "{}\n");
    }
    const overflow = join(dir, "overflow.json");
    await expect(
      target.service.create({
        ref: { scope: "global", name: "overflow" },
        definition: definition(),
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(existsSync(overflow)).toBeFalse();

    writeFileSync(join(dir, "bounded-128.json"), "{}\n");
    const listed = await target.service.list();
    expect(listed).toContainEqual(
      expect.objectContaining({
        ref: { scope: "global", name: "invalid-directory" },
        error: expect.stringContaining("more than 128 definitions"),
      }),
    );

    const oversized = join(workspacePaths(workspaceRoot).environmentsDir, "oversized.json");
    mkdirSync(workspacePaths(workspaceRoot).environmentsDir, { recursive: true });
    writeFileSync(oversized, " ");
    truncateSync(oversized, 1024 * 1024 + 1);
    expect(await target.service.get({ scope: "workspace", name: "oversized" })).toMatchObject({
      status: "invalid",
      issues: [
        expect.objectContaining({
          message: expect.stringContaining("1048576-byte resource limit"),
        }),
      ],
    });
  });

  it("never replaces an existing definition entry it cannot read safely", async () => {
    const path = join(globalPaths(globalDir).environmentsDir, "occupied.json");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "sentinel"), "keep");

    await expect(
      manager().service.create({
        ref: { scope: "global", name: "occupied" },
        definition: definition(),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(existsSync(join(path, "sentinel"))).toBeTrue();
  });

  it("activates plugin hooks atomically with their Environment membership", async () => {
    const hook = { event: "run_start" as const, command: "echo ready" };
    installPlugin(globalPaths(globalDir).pluginsDir, "hooked", { hooks: [hook] });
    const setup = manager();
    await create(
      setup,
      { scope: "global", name: "hooks" },
      definition({ plugins: [pluginRef("hooked")] }),
    );
    const resolved = manager("global:hooks").resolveActive([], TRUSTED);
    expect(resolved.counts.hooks_declared).toBe(1);
  });

  it("rejects malformed service inputs as invalid requests without touching the filesystem", async () => {
    const target = manager();
    target.resolveActive([], TRUSTED);

    await expect(
      target.service.create({
        ref: { scope: "builtin", name: "default" },
        definition: definition(),
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(target.service.get({ scope: "remote", name: "x" } as never)).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    await expect(
      target.service.preview({ scope: "builtin", name: "default" }, undefined as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      target.service.select({ scope: "builtin", name: "default" }, undefined as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(existsSync(globalPaths(globalDir).environmentsDir)).toBeFalse();
  });

  it("preserves exact reference identity in Environment ids", () => {
    const refs: EnvironmentRef[] = [
      { scope: "builtin", name: "default" },
      { scope: "global", name: "research" },
      { scope: "workspace", name: "research" },
    ];
    expect(refs.map((ref) => `${ref.scope}:${ref.name}`)).toEqual([
      "builtin:default",
      "global:research",
      "workspace:research",
    ]);
  });
});
