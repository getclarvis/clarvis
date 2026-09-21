import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { createContainerModelCatalog } from "../../src/config/container-model-catalog.ts";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import { projectContainerHostConfiguration } from "../../src/config/project-container-host.ts";
import { createHash } from "node:crypto";
import { envSchema, type ModelExecutionInfo } from "@clarvis/capability";
import type { SettingsData } from "@clarvis/protocol";
import type { AgentRecord } from "../../src/config/config-store.ts";
import { resolveStoreSharedPrompt, stampedSharedPrompt } from "../../src/config/shared-prompt.ts";
import {
  canonicalContainerJson,
  containerConfigurationDigest,
  containerConfigurationSchema,
  CONTAINER_ENV_SCOPES,
  containerLoopEnvironment,
  containerProfileAdmissions,
  createContainerConfigStore,
  parseContainerConfiguration,
  projectContainerConfiguration,
  validateContainerProfileSelection,
  type ContainerProjectionInputs,
} from "../../src/config/container-projection.ts";

const model: ModelExecutionInfo = {
  provider: "logical",
  model: "model/v1",
  kind: "openai-compatible",
  contextWindowTokens: 128000,
  maxOutputTokens: 4096,
  capabilities: ["tool_calling", "vision"],
  reasoningEfforts: ["low", "high"],
  promptCache: "implicit",
};
function inputs(
  settings: SettingsData = {},
  agents: AgentRecord[] = [],
): ContainerProjectionInputs {
  return {
    store: {
      readSettings: () => ({
        merged: { default_model: "plugin/secret" },
        operator_merged: settings,
        scopes: {},
        sources: [],
      }),
      listAgents: () => agents,
    },
    env: envSchema.parse({}),
    modelCatalog: [model],
    sharedPrompt: "Shared ${SECRET}",
    contexts: [{ scope: "workspace", content: "Context ${SECRET}" }],
    memoryPolicy: "Memory ${SECRET}",
    workflowDefinitions: [],
  };
}
const profile = (
  name: string,
  frontmatter: AgentRecord["frontmatter"] = {},
  scope: AgentRecord["scope"] = "global",
): AgentRecord => ({ name, frontmatter, scope, body: "Prompt ${SECRET}" });
const project = (settings: SettingsData = {}, agents: AgentRecord[] = []) =>
  projectContainerConfiguration(inputs(settings, agents));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Container configuration projection", () => {
  test("host projection resolves instruction files and logical models without provider authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-projection-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    const workspace = workspacePaths(workspaceRoot);
    const global = globalPaths(globalDir);
    await Promise.all([
      mkdir(workspace.workflowsDir, { recursive: true }),
      mkdir(global.workflowsDir, { recursive: true }),
      mkdir(dirname(global.memoryPolicyFile), { recursive: true }),
    ]);
    await writeFile(global.memoryPolicyFile, "Keep durable facts.\n");
    const base = createMemoryConfigStore({
      settings: {
        global: {
          default_model: "logical/model-v1",
          memory: { enabled: true },
          providers: [
            {
              name: "logical",
              kind: "openai-compatible",
              base_url: "https://provider.invalid/v1",
              api_key_env: "SECRET",
              models: {
                "model-v1": {
                  context_window_tokens: 8192,
                  max_output_tokens: 1024,
                  capabilities: ["tool_calling"],
                  reasoning_efforts: ["low"],
                  prompt_cache: "explicit",
                },
              },
            },
          ],
        },
      },
      context: { global: "Global context", workspace: "Workspace context" },
      sharedPrompts: { global: "Shared prompt" },
    });
    const snapshot = base.readSettings();
    const store = {
      ...base,
      readSettings: () => ({ ...snapshot, operator_merged: snapshot.merged }),
    };
    const projected = await projectContainerHostConfiguration({
      store,
      models: {
        get: async () => ({
          source: "bundle",
          providers: [
            {
              id: "openai-compatible",
              kind: "openai-compatible",
              name: "Compatible",
              needs_base_url: true,
              models: [],
            },
          ],
        }),
        refresh: async () => {
          throw new Error("unexpected refresh");
        },
        getEntitled: async () => {
          throw new Error("unexpected subscription");
        },
        refreshEntitled: async () => {
          throw new Error("unexpected subscription refresh");
        },
      },
      env: envSchema.parse({}),
      workspaceRoot,
      globalDir,
      defaultAgent: "default",
    });
    expect(projected.modelCatalog).toEqual([
      expect.objectContaining({
        provider: "logical",
        model: "model-v1",
        kind: "openai-compatible",
        contextWindowTokens: 8192,
        maxOutputTokens: 1024,
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("provider.invalid");
    expect(JSON.stringify(projected)).not.toContain("SECRET");
    expect(projected.contexts).toEqual([
      { scope: "global", content: "Global context" },
      { scope: "workspace", content: "Workspace context" },
    ]);
    expect(projected.memoryPolicy).toContain("Keep durable facts.");
    expect(projected.workflows.definitions.some((workflow) => workflow.origin === "builtin")).toBe(
      true,
    );
    await rm(workspace.workflowsDir, { recursive: true });
    await writeFile(workspace.workflowsDir, "not a workflow catalogue");
    await expect(
      projectContainerHostConfiguration({
        store,
        models: {
          get: async () => ({ source: "bundle", providers: [] }),
          refresh: async () => ({ source: "bundle", providers: [] }),
          getEntitled: async () => {
            throw new Error("unexpected subscription");
          },
          refreshEntitled: async () => {
            throw new Error("unexpected subscription refresh");
          },
        },
        env: envSchema.parse({}),
        workspaceRoot,
        globalDir,
      }),
    ).rejects.toThrow("unreadable definitions");
  });
  test("guest catalog resolves aliases without endpoints or host refresh authority", async () => {
    const configuration = projectContainerConfiguration({
      ...inputs(),
      modelCatalog: [model, { ...model, provider: "subscription", kind: "openai-codex" }],
    });
    const { resolver, service } = createContainerModelCatalog(configuration);
    const catalog = await service.get();
    expect(catalog.source).toBe("projection");
    expect(catalog.providers.map((provider) => provider.kind)).toEqual([
      "openai-compatible",
      "openai-codex",
    ]);
    expect(
      catalog.providers.every(
        (provider) =>
          !provider.needs_base_url &&
          provider.base_url === undefined &&
          provider.api_key_env === undefined,
      ),
    ).toBe(true);
    expect(resolver.resolve("logical", "model/v1")).toEqual(model);
    expect(resolver.resolve("other", "model/v1")).toBeUndefined();
    expect(resolver.resolve("logical", "other")).toBeUndefined();
    catalog.providers[0]!.models.length = 0;
    expect((await service.get()).providers[0]!.models).toHaveLength(1);
    await expect(service.refresh()).rejects.toMatchObject({ code: "unsupported" });
    await expect(service.getEntitled("openai-codex")).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(service.refreshEntitled("openai-codex")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(() =>
      createContainerModelCatalog(
        projectContainerConfiguration({
          ...inputs(),
          modelCatalog: [model, { ...model, model: "other", kind: "openai-codex" }],
        }),
      ),
    ).toThrow("inconsistent provider kinds");
  });
  test("strict versioned schema, recursive keys, canonical defaults and UTF-8 bounds", () => {
    const valid = project();
    expect(containerConfigurationSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, providers: [] },
      { ...valid, defaults: { ...valid.defaults, endpoint: "hidden" } },
      { ...valid, loopPolicy: { ...valid.loopPolicy, CLARVIS_MCP_MAX_CONNECTIONS: 1 } },
      { ...valid, toolPolicy: { ...valid.toolPolicy, enabled: "true" } },
      { ...valid, plans: { mode: "on" } },
      {
        ...valid,
        profiles: [{ ...valid.profiles[0], frontmatter: { orchestration: { external: true } } }],
      },
      {
        // The engine no longer owns any key in this block, so the Container
        // refuses a profile that still names the retired one instead of
        // projecting it away — a container configuration is closed and canonical,
        // and a silently dropped key would change meaning without saying so.
        ...valid,
        profiles: [
          ...valid.profiles,
          {
            name: "legacy",
            frontmatter: { orchestration: { force_tool_on_nudge: true } },
            prompt: "",
            origin: "global" as const,
          },
        ],
      },
      {
        ...valid,
        profiles: Array.from({ length: 1025 }, (_, i) => ({
          name: `p${i}`,
          frontmatter: {},
          prompt: "",
          origin: "global",
        })),
      },
      { ...valid, memoryPolicy: "é".repeat(2 * 1024 * 1024) },
    ])
      expect(() => parseContainerConfiguration(invalid)).toThrow();
  });

  test("canonical SHA-256 sorts recursively but preserves array order and rejects all non-JSON", () => {
    expect(canonicalContainerJson({ z: [2, 1], a: { b: 1, a: 0 } })).toBe(
      '{"a":{"a":0,"b":1},"z":[2,1]}',
    );
    const valid = project();
    expect(containerConfigurationDigest(valid)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(containerConfigurationDigest(valid)).toBe(
      `sha256:${createHash("sha256").update(canonicalContainerJson(valid)).digest("hex")}`,
    );
    const reordered = Object.fromEntries(Object.entries(valid).reverse());
    expect(containerConfigurationDigest(parseContainerConfiguration(reordered))).toBe(
      containerConfigurationDigest(valid),
    );
    expect(
      containerConfigurationDigest(
        parseContainerConfiguration({ ...valid, profiles: [...valid.profiles].reverse() }),
      ),
    ).not.toBe(containerConfigurationDigest(valid));
    let calls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        calls++;
        return "hidden";
      },
    });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const invalid of [
      undefined,
      NaN,
      Infinity,
      -0,
      1n,
      () => 1,
      Symbol(),
      new Date(),
      new Map(),
      cycle,
      accessor,
      Object.assign(new Array<unknown>(2), { 1: 1 }),
      { x: undefined },
      { [Symbol()]: 1 },
    ])
      expect(() => canonicalContainerJson(invalid)).toThrow();
    expect(calls).toBe(0);
    expect(canonicalContainerJson("é")).toBe('"é"');
    expect(() => canonicalContainerJson("é".repeat(2 * 1024 * 1024 - 1))).not.toThrow();
    expect(() => canonicalContainerJson("é".repeat(2 * 1024 * 1024))).toThrow();
  });

  test("host secrets, plugin settings, diagnostic paths and inherited Tasks never enter output", () => {
    const input = inputs(
      {
        default_model: "logical/model/v1",
        providers: [
          {
            name: "logical",
            kind: "openai-compatible",
            base_url: "https://private.invalid/secret",
            api_key_env: "SUPER_SECRET",
          },
        ],
        tasks: { provider: { kind: "mcp", server: "private-server" } },
        hooks: { executable: "/host/private" },
        enabledPlugins: [{ scope: "global", source: "clarvis", name: "private-plugin" }],
      },
      [profile("plugin_agent", { grants: ["private.grant"] }, "plugin")],
    );
    input.modelCatalog = [
      {
        ...model,
        base_url: "https://hidden",
        api_key: "hidden-secret",
        prices: { input: 8 },
      } as ModelExecutionInfo,
    ];
    const output = projectContainerConfiguration(input);
    const wire = JSON.stringify(output);
    for (const absent of [
      "SUPER_SECRET",
      "private.invalid",
      "plugin/secret",
      "private-server",
      "/host/private",
      "private-plugin",
      "plugin_agent",
      "hidden-secret",
      "base_url",
      "prices",
      '"tasks"',
    ])
      expect(wire).not.toContain(absent);
    expect(output.sharedPrompt).toBe("Shared ${SECRET}");
    expect(output.contexts[0]?.content).toBe("Context ${SECRET}");
    expect(output.modelCatalog[0]).toEqual(model);
    expect(output.defaults.default_model).toBe("logical/model/v1");
    expect(() =>
      projectContainerConfiguration({
        ...input,
        store: { ...input.store, readSettings: () => ({ merged: {}, scopes: {}, sources: [] }) },
      }),
    ).toThrow("operator_merged");
  });

  test("logical compatible and subscription metadata survives without endpoint configuration", () => {
    for (const kind of ["openai-compatible", "openai-codex", "xai-grok"] as const) {
      const output = projectContainerConfiguration({
        ...inputs(),
        modelCatalog: [{ ...model, kind }],
      });
      expect(output.modelCatalog[0]).toEqual({ ...model, kind });
      expect(createContainerConfigStore(output).readSettings().merged.providers).toBeUndefined();
    }
  });

  test("every EnvConfig key is classified; extensions are withheld, identity/trace/locks preserved", () => {
    const env = envSchema.parse({
      CLARVIS_OWNER: "owner",
      CLARVIS_LOG: "private:debug",
      CLARVIS_MEMORY_LOCK_WARN_MS: 777,
      CLARVIS_TRACE_TTL_DAYS: 12,
    });
    expect(Object.keys(CONTAINER_ENV_SCOPES).sort()).toEqual(Object.keys(envSchema.shape).sort());
    const output = projectContainerConfiguration({ ...inputs(), env });
    for (const [key, classification] of Object.entries(CONTAINER_ENV_SCOPES)) {
      if (key.startsWith("CLARVIS_MCP_") || key.startsWith("CLARVIS_MAX_CONCURRENT_EXTENSION_"))
        expect(classification).toBe("withheld");
      if (!["loop", "disabled"].includes(classification))
        expect(Object.hasOwn(output.loopPolicy, key)).toBe(false);
    }
    expect(output.loopPolicy.CLARVIS_OWNER).toBe("owner");
    expect(output.loopPolicy.CLARVIS_MEMORY_LOCK_WARN_MS).toBe(777);
    expect(output.loopPolicy.CLARVIS_TRACE_TTL_DAYS).toBe(12);
    expect(output.loopPolicy.CLARVIS_SKILLS_ENABLED).toBe(false);
    expect(output.loopPolicy.CLARVIS_HOOKS_ENABLED).toBe(false);
    const restored = containerLoopEnvironment(output.loopPolicy, output.toolPolicy);
    expect(restored.CLARVIS_OWNER).toBe("owner");
    expect(restored.CLARVIS_LOG_LEVEL).toBe("silent");
    expect(restored.CLARVIS_LOG).toBeUndefined();
    expect(() =>
      parseContainerConfiguration({
        ...output,
        loopPolicy: {
          ...output.loopPolicy,
          CLARVIS_DEFAULT_ITERATION_LIMIT: output.loopPolicy.CLARVIS_ITERATION_CEILING + 1,
        },
      }),
    ).toThrow();
  });

  test("original builtins retain Workflow, remove only skills; operator overrides are not builtin", () => {
    const output = project();
    expect(output.profiles).toHaveLength(5);
    expect(output.profiles.find((item) => item.name === "admiral")?.frontmatter.grants).toContain(
      "workflow",
    );
    expect(output.profiles.every((item) => !item.frontmatter.grants?.includes("use_skills"))).toBe(
      true,
    );
    expect(containerProfileAdmissions(output).every((item) => item.selectable)).toBe(true);
    const overridden = project({}, [
      profile("marshall", { model: "logical/model/v1", grants: ["use_skills"] }, "workspace"),
    ]);
    expect(overridden.profiles.find((item) => item.name === "marshall")?.origin).toBe("workspace");
    expect(() => validateContainerProfileSelection(overridden, "marshall")).toThrow();
    expect(() => validateContainerProfileSelection(overridden, "coder")).not.toThrow();
    expect(
      createContainerConfigStore(overridden).readEffectiveAgent("marshall")?.malformed,
    ).toBeDefined();
  });

  test("Tasks/external grants/MCP tools are nonselectable; missing targets reject and native cycles work", () => {
    const output = project({}, [
      profile("a", { can_spawn: ["b"] }),
      profile("b", { can_spawn: ["a"] }),
      profile("missing", { can_spawn: ["absent"] }),
      profile("badname", { can_spawn: ["../a"] }),
      profile("tasks", { grants: ["tasks.read"] }),
      profile("external", { grants: ["external.operation"] }),
      profile("mcp", { tools: ["server.tool"] }),
      profile("skills", { grants: ["use_skills"] }),
      profile("default", { default_spawn: "a" }),
    ]);
    expect(() => validateContainerProfileSelection(output, "a")).not.toThrow();
    for (const name of ["missing", "badname", "tasks", "external", "mcp", "skills", "default"])
      expect(() => validateContainerProfileSelection(output, name)).toThrow();
    expect(() => validateContainerProfileSelection(output, "coder")).not.toThrow();
  });

  test("Memory absent/off strips providers and policy; local wiki/file active and external providers refused", () => {
    expect(project().memory).toEqual({ enabled: false });
    const off = project({
      memory: { enabled: false, provider: { kind: "executable", command: "private" } },
    });
    expect(off.memory).toEqual({ enabled: false });
    expect(off.memoryPolicy).toBe("");
    expect(JSON.stringify(off)).not.toContain("private");
    expect(project({ memory: { enabled: true } }).memory).toEqual({
      enabled: true,
      provider: { kind: "wiki" },
    });
    expect(project({ memory: { enabled: true } }).memoryPolicy).toBe("Memory ${SECRET}");
    expect(
      project({ memory: { enabled: true, provider: { kind: "file", paths: ["notes/memory.md"] } } })
        .memory,
    ).toEqual({ enabled: true, provider: { kind: "file", paths: ["notes/memory.md"] } });
    for (const path of [
      "../secret",
      "/etc/passwd",
      "C:/secret",
      "C:\\secret",
      "\\\\host\\file",
      "a/../b",
    ])
      expect(() =>
        project({ memory: { enabled: true, provider: { kind: "file", paths: [path] } } }),
      ).toThrow();
    for (const provider of [
      { kind: "executable", command: "private" },
      { kind: "plugin", plugin: "private" },
    ] as const)
      expect(() => project({ memory: { enabled: true, provider } })).toThrow("External Memory");
  });

  test("Plans canonical defaults, off strips external providers and active external fails", () => {
    expect(project().plans).toEqual({
      mode: "on",
      retention: "keep",
      pending_task_nudges: 3,
      provider: { kind: "markdown" },
    });
    const off = project({ plans: { mode: "off", provider: { kind: "plugin", plugin: "hidden" } } });
    expect(off.plans.provider).toBeUndefined();
    expect(JSON.stringify(off)).not.toContain("hidden");
    expect(() => project({ plans: { provider: { kind: "plugin", plugin: "external" } } })).toThrow(
      "External Plans",
    );
  });

  test("resolved native workflows preserve data and precedence, not host paths; unknown nested keys fail", () => {
    const definition = {
      name: "review",
      description: "Review",
      args: [],
      rounds: [
        {
          id: "start",
          type: "free" as const,
          over: { kind: "once" as const },
          title: "Review",
          brief: "Resolved ${SECRET}",
          fanout: 1,
        },
      ],
      synthesis: "Finish",
      dir: "/host/private/workflows/review",
    };
    const input = {
      ...inputs(),
      workflowDefinitions: [
        { origin: "builtin" as const, definition },
        { origin: "workspace" as const, definition: { ...definition, synthesis: "Override" } },
      ],
    };
    const output = projectContainerConfiguration(input);
    expect(output.workflows.definitions).toHaveLength(1);
    expect(output.workflows.definitions[0]?.origin).toBe("workspace");
    expect(output.workflows.definitions[0]?.synthesis).toBe("Override");
    expect(JSON.stringify(output)).not.toContain("/host/private");
    expect(() =>
      projectContainerConfiguration({
        ...input,
        workflowDefinitions: [
          {
            origin: "builtin",
            definition: {
              ...definition,
              rounds: [{ ...definition.rounds[0]!, secret: true }],
            } as unknown as typeof definition,
          },
        ],
      }),
    ).toThrow();
  });

  test("frozen projection and defensive store clones; every mutation refuses before callbacks", () => {
    const output = project({}, [profile("custom", { base_prompt: "Fallback" })]);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.profiles[0]?.frontmatter.grants)).toBe(true);
    const store = createContainerConfigStore(output);
    const settings = store.readSettings();
    settings.merged.default_model = "mutated";
    expect(store.readSettings().merged.default_model).toBeUndefined();
    store.listAgents()[0]!.frontmatter.grants = [];
    expect(store.listAgents()[0]?.frontmatter.grants).not.toEqual([]);
    store.readContext("workspace")!.content = "mutated";
    expect(store.readContext("workspace")?.content).toBe("Context ${SECRET}");
    expect(stampedSharedPrompt(resolveStoreSharedPrompt(store))).toBe(output.sharedPrompt);
    expect(
      stampedSharedPrompt(
        resolveStoreSharedPrompt(
          createContainerConfigStore(parseContainerConfiguration({ ...output, sharedPrompt: "" })),
        ),
      ),
    ).toBe("");
    let calls = 0;
    const callback = () => {
      calls++;
      return {};
    };
    for (const mutation of [
      () => store.writeSettings("global", {}),
      () => store.mutateSettings("global", null, callback),
      () => store.compareAndSwapSettingsDocument("global", "revision", callback),
      () =>
        store.withOperatorWrite?.("global", callback, () => ({
          path: "never",
          expectedRevision: null,
        })),
      () => store.setWorkspaceTrust?.(true),
      () => store.writeAgent("global", "new", { frontmatter: {}, body: "" }),
      () => store.deleteAgent("global", "custom"),
      () => store.writeSharedPrompt("global", "new"),
      () => store.deleteSharedPrompt("global"),
    ])
      expect(mutation).toThrow("read-only");
    expect(calls).toBe(0);
    expect(store.readSettingsDocument("global")).toBeNull();
    expect(store.readSettings().sources).toEqual([]);
    expect(store.readContext("workspace")?.path).toBeUndefined();
  });
});
