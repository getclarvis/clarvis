import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";
import { createConfigService, createFileConfigStore } from "../../src/config.ts";
import { createSettingsRunAssembler } from "../../src/runs/settings-assembler.ts";
import { DEFAULT_ENTRY_AGENT } from "../../src/config/builtin-agents/index.ts";

/**
 * A host that has never written an agent file: a bare workspace and a global
 * directory holding nothing but providers and a default model.
 */
function bareHost(): { ws: string; globalDir: string } {
  const ws = mkdtempSync(join(tmpdir(), "clarvis-fleet-"));
  const globalDir = join(ws, "global");
  const settings = globalPaths(globalDir).settingsFile;
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(
    settings,
    JSON.stringify({
      default_model: "anthropic/x",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    }),
  );
  return { ws, globalDir };
}

/** The parts of an assembled run request these tests read. */
interface AssembledRun {
  entry: string;
  profiles: { name: string; model: string; grants?: string[]; base_prompt?: string }[];
}

/** Assemble a default run: no `agent` param, so the assembler falls back. */
function assembled(assemble: ReturnType<typeof createSettingsRunAssembler>): AssembledRun {
  return assemble({
    messages: [{ role: "user", content: "hi" }],
    execution_id: "e",
  }) as AssembledRun;
}

describe("a host with no agent files at all", () => {
  it("still has the whole fleet, in order, with nothing written to disk", async () => {
    const { ws, globalDir } = bareHost();
    const config = createConfigService(createFileConfigStore({ workspaceRoot: ws, globalDir }));

    const listed = await config.listAgents();
    expect(listed.map((a) => a.name)).toEqual([
      "marshall",
      "admiral",
      "coder",
      "explorer",
      "planner",
    ]);
    expect(listed.every((a) => a.scope === "builtin")).toBe(true);
    /* Not "the directory is empty" — the directory was never created. Listing
       the fleet must not be a write. */
    expect(existsSync(globalPaths(globalDir).agentsDir)).toBe(false);
  });

  it("assembles a run on the default entry agent, with its sub-agents attached", () => {
    const { ws, globalDir } = bareHost();
    const store = createFileConfigStore({ workspaceRoot: ws, globalDir });
    const assemble = createSettingsRunAssembler(store, { defaultAgent: DEFAULT_ENTRY_AGENT });

    const request = assembled(assemble);
    expect(request.entry).toBe("marshall");
    /* `marshall` can spawn three, so the graph is four profiles deep — proof the
       `can_spawn` walk resolves through the shipped fleet and not only through
       files. */
    expect(request.profiles.map((p) => p.name).sort()).toEqual([
      "coder",
      "explorer",
      "marshall",
      "planner",
    ]);
    expect(request.profiles.every((p) => p.model === "anthropic/x")).toBe(true);
    expect(request.profiles.find((p) => p.name === "marshall")?.base_prompt).toContain("marshall");
  });

  it("boots a real file kernel and reports the fleet over its config service", async () => {
    const { ws, globalDir } = bareHost();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir,
    });
    try {
      expect((await kernel.listAgents()).map((a) => a.name)).toContain(DEFAULT_ENTRY_AGENT);
      const doc = await kernel.config.getAgent("builtin", "marshall");
      expect(doc.scope).toBe("builtin");
      expect(doc.body.length).toBeGreaterThan(0);
    } finally {
      await kernel.close();
    }
  });
});

describe("a customization written into the global scope", () => {
  it("changes the one field it names and leaves the shipped prompt in place", async () => {
    const { ws, globalDir } = bareHost();
    const agents = globalPaths(globalDir).agentsDir;
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "marshall.md"), `---\niteration_limit: 80\n---\n\n`);

    const store = createFileConfigStore({ workspaceRoot: ws, globalDir });
    const effective = store.readEffectiveAgent("marshall")!;
    expect(effective.frontmatter.iteration_limit).toBe(80);
    expect(effective.body).toContain("You are `marshall`");
    expect(effective.overlay).toEqual({ scope: "global", status: "applied" });

    const config = createConfigService(store);
    const listed = await config.listAgents();
    expect(listed.filter((a) => a.name === "marshall")).toHaveLength(1);
    /* The document the editor opens is the file the user wrote, not the merge —
       otherwise a save would write the whole shipped prompt back out. */
    const doc = await config.getAgent("global", "marshall");
    expect(doc.frontmatter).toEqual({ iteration_limit: 80 });
    expect(doc.body.trim()).toBe("");
  });

  it("is refused when it does not parse, and the run still gets the shipped agent", () => {
    const { ws, globalDir } = bareHost();
    const agents = globalPaths(globalDir).agentsDir;
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "marshall.md"), `---\ngrants: [unclosed\n---\n\nmine\n`);

    const store = createFileConfigStore({ workspaceRoot: ws, globalDir });
    const effective = store.readEffectiveAgent("marshall")!;
    expect(effective.scope).toBe("builtin");
    expect(effective.overlay?.status).toBe("rejected");
    expect(effective.body).toContain("You are `marshall`");

    const assemble = createSettingsRunAssembler(store, { defaultAgent: DEFAULT_ENTRY_AGENT });
    const request = assembled(assemble);
    expect(request.entry).toBe("marshall");
    expect(request.profiles.find((profile) => profile.name === "marshall")?.base_prompt).toContain(
      "You are `marshall`",
    );
  });
});
