import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentToText, loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { buildExecuteRunDeps, executeRun, type AgentProfile } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { configurationRoots, globalPaths, type ConfigurationRoot } from "@clarvis/paths";
import { createAgentSkills } from "@clarvis/skills";
import { loadWorkflow, loadWorkflows } from "@clarvis/workflows/artifact";
import { resolveWorkflowDefinitions } from "@clarvis/workflows";
import { createAgentWorkflowPolicy } from "../../src/application/workflow-policy.ts";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import {
  configurationFileOperation,
  type ConfigurationFileRequest,
} from "../../src/configuration/files.ts";
import { createNativeConfigurationRuns } from "../../src/configuration/native-configuration.ts";
import { createExtensionProfileManager } from "../../src/extension-profiles/extension-profile-manager.ts";
import { createInProcessKernel } from "../../src/kernel.ts";
import { createPluginContributions } from "../../src/plugins/plugin-contributions.ts";
import { createSettingsRunAssembler } from "../../src/runs/settings-assembler.ts";
import { withBuiltinSkills } from "../../src/skills/builtin-skills.ts";
import { CONFIGURATION_EXAMPLES as EXAMPLES } from "../../src/skills/configuration-examples.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "clarvis-configuration-guide-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const workspaceRoot = join(home, "workspace");
  const globalDir = join(home, "global");
  mkdirSync(workspaceRoot);
  const roots = configurationRoots({ home, workspaceRoot, globalDir });
  const call = (request: ConfigurationFileRequest) => configurationFileOperation(roots, request);
  const write = (name: keyof typeof EXAMPLES, root: ConfigurationRoot = "global_clarvis") =>
    call({
      operation: "write",
      root,
      path: EXAMPLES[name].path,
      content: EXAMPLES[name].content,
      expected_revision: null,
    });
  const store = createFileConfigStore({ globalDir, workspaceRoot, logger: NOOP_LOGGER });
  const manager = (cliSelection?: string) => {
    const instance = createExtensionProfileManager({
      globalDir,
      workspaceRoot,
      home,
      logger: NOOP_LOGGER,
      pluginContributions: createPluginContributions({ globalDir, workspaceRoot, home }),
      ...(cliSelection === undefined ? {} : { cliSelection }),
    });
    cleanups.push(() => instance.close());
    return instance;
  };
  return { home, workspaceRoot, globalDir, roots, call, write, store, manager };
}

describe("configuration guide against product loaders", () => {
  it.each(["model", "extensions", "mcp", "hooks", "capabilities", "runtime"] as const)(
    "%s: saves the documented settings through the native file tool and reads the effective block",
    (name) => {
      const f = fixture();
      f.write(name);
      const snapshot = f.store.readSettings();
      expect(snapshot.sources.find((source) => source.scope === "global")?.error).toBeUndefined();
      expect(snapshot.merged).toMatchObject(JSON.parse(EXAMPLES[name].content));
    },
  );

  it("assembles the documented reviewer overlay into Marshall's executable child graph", () => {
    const f = fixture();
    for (const name of ["model", "reviewer", "marshall"] as const) f.write(name);
    const request = createSettingsRunAssembler(f.store)({
      agent: "marshall",
      messages: [],
      execution_id: "guide-agents",
    }) as { profiles: AgentProfile[] };
    expect(request.profiles.find((profile) => profile.name === "marshall")).toMatchObject({
      can_spawn: ["coder", "explorer", "planner", "reviewer"],
      default_spawn: "coder",
    });
    expect(request.profiles.find((profile) => profile.name === "reviewer")).toMatchObject({
      model: "local/example-model",
      grants: ["read_workspace", "use_skills"],
      iteration_limit: 20,
    });
    expect(
      createAgentWorkflowPolicy(f.store).isManagerRun({ messages: [], agent: "marshall" }),
    ).toBe(false);
    expect(
      createAgentWorkflowPolicy(f.store).isManagerRun({ messages: [], agent: "admiral" }),
    ).toBe(true);
  });

  it("authors a nonempty Extension Profile, previews selection, and activates the launcher on reconnect", async () => {
    const f = fixture();
    for (const name of ["plugin", "workflowSkill", "extensionProfile"] as const) f.write(name);
    const manager = f.manager();
    manager.resolveActive([], { state: "unapproved" });
    const ref = { scope: "global", name: "review" } as const;
    const authored = await manager.service.get(ref);
    expect(authored.status).toBe("ready");
    expect(authored.issues).toEqual([]);
    expect(authored.plugins).toMatchObject([
      {
        active: true,
        installed: true,
        ref: { scope: "global", source: "clarvis", name: "review-tools" },
      },
    ]);
    expect(authored.standalone_skills).toMatchObject([
      {
        active: true,
        found: true,
        ref: { scope: "user", source: "clarvis", name: "review-project" },
      },
    ]);
    expect((await manager.service.current()).id).toBe("builtin:default");
    const preview = await manager.service.preview(ref, { selection_scope: "workspace" });
    expect(preview.requires_workspace_trust).toBe(false);
    expect(
      await manager.service.select(ref, {
        selection_scope: "workspace",
        preview_token: preview.token,
      }),
    ).toMatchObject({ reconnect_required: true });
    expect((await manager.service.current()).id).toBe("builtin:default");
    const connected = f.manager();
    expect(connected.resolveActive([], { state: "unapproved" })).toMatchObject({
      id: "global:review",
      status: "ready",
    });
    const skills = withBuiltinSkills(createAgentSkills({ roots: connected.skillRoots() }));
    expect(
      skills
        .listSkills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["clarvis-configure", "review-project"]);
    expect(skills.loadSkill("review-project")?.metadata.agent).toBe("admiral");
    expect(
      createAgentWorkflowPolicy(f.store, skills).isManagerRun({
        agent: "coder",
        messages: [],
        skill: { name: "review-project", task: "src/" },
      }),
    ).toBe(true);
  });

  it.each([
    { plugins: [], skills: [{ scope: "global", source: "clarvis", name: "review-project" }] },
    { plugins: [{ scope: "workspace", source: "clarvis", name: "review-tools" }], skills: [] },
    {
      plugins: [],
      skills: [
        { scope: "user", source: "clarvis", name: "review-project" },
        { scope: "user", source: "agents", name: "review-project" },
      ],
    },
  ])(
    "reports invalid Extension Profile identities instead of substituting another root: %j",
    async (fields) => {
      const f = fixture();
      f.call({
        operation: "write",
        root: "global_clarvis",
        path: EXAMPLES.extensionProfile.path,
        content: JSON.stringify({ schema_version: 1, ...fields }),
        expected_revision: null,
      });
      const result = await f.manager().service.get({ scope: "global", name: "review" });
      expect(result.status).toBe("invalid");
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.plugins.every((plugin) => !plugin.active)).toBe(true);
      expect(result.standalone_skills.every((skill) => !skill.active)).toBe(true);
    },
  );

  it("loads the complete workflow, diagnoses broken briefs, and reloads workspace overrides", () => {
    const f = fixture();
    f.write("workflowBrief");
    f.write("workflow");
    const globalRoot = globalPaths(f.globalDir).workflowsDir;
    const dir = join(f.globalDir, dirname(EXAMPLES.workflow.path));
    expect(loadWorkflow(dir)).toMatchObject({
      name: "review-project",
      args: ["scope"],
      rounds: [
        {
          profile: "explorer",
          type: "free",
          over: { kind: "once" },
          brief: EXAMPLES.workflowBrief.content,
        },
      ],
    });
    f.write("workflowBrief", "workspace_clarvis");
    f.write("workflow", "workspace_clarvis");
    const path = EXAMPLES.workflowBrief.path;
    const revision = (
      f.call({ operation: "read", root: "workspace_clarvis", path }) as { revision: string }
    ).revision;
    f.call({
      operation: "edit",
      root: "workspace_clarvis",
      path,
      expected_revision: revision,
      old_text: "Review {{args.scope}}",
      new_text: "Workspace review of {{args.scope}}",
    });
    const workspaceRoot = join(f.roots.workspace_clarvis, "workflows");
    const loaded = loadWorkflows([globalRoot, workspaceRoot]);
    expect(loaded.errors).toEqual([]);
    expect(
      resolveWorkflowDefinitions(loaded.workflows).find(
        (workflow) => workflow.name === "review-project",
      )?.rounds[0]?.brief,
    ).toStartWith("Workspace review");
    const updated = f.call({ operation: "read", root: "workspace_clarvis", path }) as {
      revision: string;
    };
    f.call({
      operation: "delete",
      root: "workspace_clarvis",
      path,
      expected_revision: updated.revision,
    });
    const broken = loadWorkflows([globalRoot, workspaceRoot]);
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]?.message).toContain("could not be read");
    expect(broken.workflows[0]?.rounds[0]?.brief).toBe(EXAMPLES.workflowBrief.content);
  });

  it("creates a workflow in native mode and runs it through Admiral with an independent preflight", async () => {
    const f = fixture();
    f.write("model");
    const llm = new MockLLM({
      script: [],
      routes: [
        {
          name: "configure",
          when: (call) => call.tools.some((tool) => tool.wireName === "configure_clarvis"),
          script: [
            ...(["workflowBrief", "workflow"] as const).map((name) => ({
              toolCalls: [
                {
                  name: "configure_clarvis",
                  arguments: {
                    operation: "write",
                    root: "global_clarvis",
                    path: EXAMPLES[name].path,
                    content: EXAMPLES[name].content,
                    expected_revision: null,
                  },
                },
              ],
            })),
            { text: "Workflow authored; run it in an ordinary Admiral turn." },
          ],
        },
        {
          name: "title",
          when: (call) => call.tools.some((tool) => tool.wireName === "set_title"),
          script: [{ text: "" }],
        },
        {
          name: "manager",
          when: (call) => call.tools.some((tool) => tool.wireName === "run_workflow"),
          script: [
            {
              toolCalls: [
                {
                  name: "run_workflow",
                  arguments: { name: "review-project", args: { scope: "src/" }, explain: true },
                },
              ],
            },
            {
              toolCalls: [
                {
                  name: "run_workflow",
                  arguments: { name: "review-project", args: { scope: "src/" } },
                },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "Review completed from the independent leader's evidence." },
          ],
        },
        {
          name: "leader",
          when: (call) =>
            call.messages.some((message) =>
              contentToText(message.content).includes("Review src/ using the available read tools"),
            ),
          script: [{ text: "No findings in the fixture; no real repository checks were run." }],
        },
      ],
    });
    const built = await buildExecuteRunDeps({
      workspaceRoot: f.workspaceRoot,
      traceDir: join(f.home, "traces"),
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: NOOP_LOGGER,
      builtins: { tools: false, hooks: false },
      skillRoots: [],
      composeSkills: withBuiltinSkills,
    });
    const deps = { ...built.deps, llm };
    const native = createNativeConfigurationRuns({
      roots: f.roots,
      store: f.store,
      skills: built.skills,
      nativeExecuteRun: executeRun,
    });
    const kernel = createInProcessKernel({
      workspaceRoot: f.workspaceRoot,
      globalConfigDir: f.globalDir,
      ...kernelIdentity(f.workspaceRoot),
      configStore: f.store,
      deps,
      skillsProvider: built.skills,
      nativeConfiguration: native,
      logger: NOOP_LOGGER,
      assemblerOptions: { defaultAgent: "marshall" },
    });
    try {
      const configure = await kernel.runs.start({
        messages: [],
        skill: { name: "clarvis-configure", task: "Author review-project" },
        configuration_session_id: "guide-live",
      });
      configure.onElicit((request) => {
        expect(request.kind).toBe("configuration_access");
        void configure.respond({
          id: request.id,
          action: "accept",
          content: { answer: "allow_session" },
        });
      });
      expect(await configure.done).toMatchObject({ status: "completed" });
      expect(llm.calls).toHaveLength(3);
      expect(await kernel.workflows.list()).toMatchObject({ items: [] });
      const manager = await kernel.runs.start({
        agent: "admiral",
        messages: [{ role: "user", content: "Review src/" }],
      });
      let preflights = 0;
      manager.onElicit((request) => {
        expect(request.kind).toBe("workflow_review");
        expect(
          llm.calls.some((call) =>
            call.messages.some((message) =>
              contentToText(message.content).includes("Review src/ using the available read tools"),
            ),
          ),
        ).toBe(false);
        preflights++;
        void manager.respond({ id: request.id, action: "accept", content: { decision: "run" } });
      });
      expect(await manager.done).toMatchObject({ status: "completed" });
      expect(preflights).toBe(1);
      const workflow = await kernel.workflows.get(manager.execution_id);
      expect(workflow.status).toBe("completed");
      expect(workflow.nodes.filter((node) => node.kind === "leader")).toMatchObject([
        { profile: "explorer", status: "completed" },
      ]);
      const managerCalls = llm.calls.filter((call) =>
        call.tools.some((tool) => tool.wireName === "run_workflow"),
      );
      expect(
        managerCalls.every((call) =>
          call.tools.every((tool) => tool.wireName !== "configure_clarvis"),
        ),
      ).toBe(true);
    } finally {
      native.close();
      await kernel.close();
      await built.dispose();
    }
  });
});
