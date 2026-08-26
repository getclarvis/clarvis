import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createFileKernel } from "../../src/bootstrap.ts";
import { createPluginService } from "../../src/plugins/plugin-service.ts";
import type { SkillSummary } from "@clarvis/protocol";
import { globalPaths } from "@clarvis/paths";

/**
 * A skills-only plugin installed from a fixture directory rather than over the
 * network: the shape a methodology package has to take to install into Clarvis —
 * a Clarvis-valid manifest at the plugin root, and a `skills/` tree beside it.
 */
const SKILLS = ["using-superpowers", "brainstorming", "writing-plans"];

let ws: string;
let globalDir: string;

function installSuperpowers(manifest: Record<string, unknown>): string {
  const dir = join(globalPaths(globalDir).pluginsDir, "superpowers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  for (const name of SKILLS) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(
      join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nInstructions for ${name}.\n`,
    );
  }
  return dir;
}

/** The plugin's own contribution to the catalog. The kernel also scans the real
 * home directory's skill roots, which this fixture cannot control. */
const fromPlugin = (listed: SkillSummary[]): SkillSummary[] =>
  listed.filter((s) => s.provenance?.source === "plugin:superpowers");

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "superpowers",
  version: "6.2.0",
  description: "Agentic skills framework: brainstorming, planning, TDD, debugging, code review.",
  author: "Jesse Vincent",
  ...over,
});

async function kernelFor(): Promise<Awaited<ReturnType<typeof createFileKernel>>> {
  return createFileKernel({
    workspaceRoot: ws,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_SKILLS_ENABLED: "1" }),
    traceDir: join(ws, "traces"),
    globalDir,
  });
}

describe("a skills-only plugin installs, stays inert, and serves its skills", () => {
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "clarvis-plugin-skills-"));
    globalDir = join(ws, "global");
    mkdirSync(join(ws, ".clarvis"), { recursive: true });
    mkdirSync(dirname(globalPaths(globalDir).settingsFile), { recursive: true });
    writeFileSync(
      join(ws, ".clarvis", "settings.json"),
      JSON.stringify({
        default_model: "anthropic/x",
        providers: [{ name: "anthropic", kind: "anthropic" }],
      }),
    );
    // Global scope: `enabledPlugins` is a workspace-trust risk field, so a
    // repository cannot turn a plugin on by shipping a settings file. Enabling
    // one is the operator's decision and lives in their own config.
    writeFileSync(
      globalPaths(globalDir).settingsFile,
      JSON.stringify({ enabledPlugins: ["superpowers"] }),
    );
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("lists a skills-only plugin without a global approval state", async () => {
    installSuperpowers(manifest());
    const views = await createPluginService({
      globalDir,
      enabledPlugins: () => ["superpowers"],
      environment: process.env,
    }).list();
    expect(views.find((v) => v.name === "superpowers")?.contributions.skills).toEqual(
      expect.arrayContaining(SKILLS),
    );
  });

  it("serves every skill through the kernel, attributed to the plugin", async () => {
    installSuperpowers(manifest());
    const kernel = await kernelFor();
    const mine = fromPlugin(await kernel.skills.list());
    expect(mine.map((s) => s.name).sort()).toEqual([...SKILLS].sort());
    for (const summary of mine) {
      expect(summary.provenance).toEqual({ scope: "user", source: "plugin:superpowers" });
    }
    await kernel.close();
  });

  it("applies packaged skill policy only while this plugin is the selected Plans provider", async () => {
    installSuperpowers(
      manifest({
        capabilityExecutables: { plans: { command: "provider", args: ["plans"] } },
        capabilityRunPolicies: { plans: { skills: { "writing-plans": "off" } } },
      }),
    );
    writeFileSync(
      globalPaths(globalDir).settingsFile,
      JSON.stringify({
        enabledPlugins: ["superpowers"],
        plans: { provider: { kind: "plugin", plugin: "superpowers" } },
      }),
    );
    const selected = await kernelFor();
    expect(
      fromPlugin(await selected.skills.list()).find((skill) => skill.name === "writing-plans")
        ?.plansMode,
    ).toBe("off");
    await selected.close();

    writeFileSync(
      globalPaths(globalDir).settingsFile,
      JSON.stringify({
        enabledPlugins: ["superpowers"],
        plans: { provider: { kind: "markdown" } },
      }),
    );
    const unselected = await kernelFor();
    expect(
      fromPlugin(await unselected.skills.list()).find((skill) => skill.name === "writing-plans")
        ?.plansMode,
    ).toBeUndefined();
    await unselected.close();
  });

  it("routes selected Plans and Memory plugin providers through their declared executables", async () => {
    installSuperpowers(
      manifest({
        capabilityExecutables: {
          plans: { command: "clarvis-provider-that-does-not-exist", args: ["plans"] },
          memory: { command: "clarvis-provider-that-does-not-exist", args: ["memory"] },
        },
      }),
    );
    writeFileSync(
      globalPaths(globalDir).settingsFile,
      JSON.stringify({
        enabledPlugins: ["superpowers"],
        plans: { provider: { kind: "plugin", plugin: "superpowers" } },
        memory: {
          enabled: true,
          provider: { kind: "plugin", plugin: "superpowers" },
        },
      }),
    );
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_SKILLS_ENABLED: "1" }),
      traceDir: join(ws, "traces"),
      globalDir,
      memory: true,
    });

    await expect(kernel.plans.list({})).rejects.toThrow();
    const run = await kernel.runs.start({
      messages: [{ role: "user", content: "inspect memory" }],
      agent: "coder",
      memory: "on",
    });
    for await (const _event of run.events) void _event;
    expect((await run.done).status).toBe("failed");
    await kernel.close();
  });

  it("keeps serving its skills once it declares a bootstrap", async () => {
    installSuperpowers(manifest({ bootstrapSkill: "using-superpowers" }));
    const service = createPluginService({
      globalDir,
      enabledPlugins: () => ["superpowers"],
      environment: process.env,
    });
    expect((await service.list()).find((v) => v.name === "superpowers")?.enabled).toBe(true);

    const kernel = await kernelFor();
    expect(fromPlugin(await kernel.skills.list()).map((s) => s.name)).toContain(
      "using-superpowers",
    );
    await kernel.close();
  });

  it("follows the enabled list live, without restarting the kernel", async () => {
    installSuperpowers(manifest({ bootstrapSkill: "using-superpowers" }));
    const kernel = await kernelFor();
    expect(fromPlugin(await kernel.skills.list())).toHaveLength(SKILLS.length);

    writeFileSync(globalPaths(globalDir).settingsFile, JSON.stringify({ enabledPlugins: [] }));
    expect(fromPlugin(await kernel.skills.list())).toEqual([]);
    await kernel.close();
  });

  it("contributes nothing while the operator has not enabled it", async () => {
    installSuperpowers(manifest());
    writeFileSync(globalPaths(globalDir).settingsFile, JSON.stringify({ enabledPlugins: [] }));
    const kernel = await kernelFor();
    expect(fromPlugin(await kernel.skills.list())).toEqual([]);
    await kernel.close();
  });
});
