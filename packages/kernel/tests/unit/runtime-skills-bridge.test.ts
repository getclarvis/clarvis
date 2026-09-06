import { describe, expect, it } from "bun:test";
import {
  createCapabilityServices,
  loadEnv,
  type AgentBuildContext,
  type RunCapabilityContext,
  type ToolArgValidate,
  type TraceEntry,
} from "@clarvis/capability";
import type { SkillContent, SkillInfo } from "@clarvis/skills";
import {
  LOAD_SKILL_TOOL_NAME,
  SKILL_RESOURCE_MAX_CHARS,
  type SkillsProvider,
} from "@clarvis/skills/capability";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import {
  createGuestSkillsCapability,
  createHostSkillsGrant,
  createRuntimeSkillBootstraps,
  createRuntimeSkillCatalog,
  RUNTIME_SKILLS_METHOD,
  RUNTIME_SKILLS_REVISION,
} from "../../src/runtime/skills-bridge.ts";

const hostRoot = "/Users/private/.clarvis/skills";
const info: SkillInfo = {
  name: "container-review",
  description: "Review a container change",
  metadata: { name: "container-review", description: "Review a container change" },
  userInvocable: true,
  scope: "user",
  source: hostRoot,
  root: hostRoot,
  dir: `${hostRoot}/container-review`,
  executionRoot: `${hostRoot}/container-review`,
  path: `${hostRoot}/container-review/SKILL.md`,
  dependencies: [
    {
      type: "mcp",
      value: "source-control",
      description: "private host integration",
      url: "https://token@example.invalid/mcp",
    },
  ],
};
const content: SkillContent = {
  ...info,
  body: "Inspect the proposed change.",
  resources: [
    {
      kind: "references",
      rel: "references/checklist.md",
      path: `${hostRoot}/container-review/references/checklist.md`,
    },
  ],
};

function provider(): SkillsProvider {
  return {
    listSkills: () => [info],
    loadSkill: (name) => (name === info.name ? content : undefined),
    readResource: () => "first second",
    readResourceChunk: (_name, _resource, offset = 0) => ({
      text: offset === 0 ? "first " : "second",
      offset,
      totalBytes: 12,
      ...(offset === 0 ? { nextOffset: 6 } : {}),
    }),
  };
}

function runContext(
  enabled: boolean,
  servers: RunCapabilityContext["request"]["servers"] = [],
): RunCapabilityContext {
  return {
    owner: "owner",
    request: {
      messages: [{ role: "user", content: "task" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      providers: [{ name: "anthropic", kind: "anthropic" }],
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    },
    requestParam: () => undefined,
    entryGrants: [],
    env: loadEnv({ CLARVIS_SKILLS_ENABLED: enabled ? "1" : "0" }),
    workspaceRoot: "/workspace",
    llm: { call: () => Promise.reject(new Error("model is outside this test")) },
    emit: () => undefined,
    services: createCapabilityServices(),
    executionId: "execution",
  };
}

function buildContext(validateArgs: ToolArgValidate = () => null): {
  context: AgentBuildContext;
  entries: TraceEntry[];
} {
  const entries: TraceEntry[] = [];
  return {
    entries,
    context: {
      agent: "subagent",
      ctx: {
        appendNote: () => undefined,
        setStableBlock: () => undefined,
        setCanonicalState: () => undefined,
      },
      state: { lastAssistantText: "" },
      trace: {
        record: (kind, detail) => entries.push({ at: 0, kind, detail }),
        signal: () => undefined,
        now: () => 0,
      },
      guards: {
        record: () => undefined,
        takeSoft: () => [],
        tripped: () => null,
        reset: () => undefined,
      },
      toolProgress: (result) => result.errText === null,
      maybeCancelled: () => null,
      validateArgs,
    },
  };
}

function bridge(capability: GuestExecutionBridge["capability"]): GuestExecutionBridge {
  return {
    model: () => Promise.reject(new Error("model is outside this test")),
    capability,
    event: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
}

describe("runtime skills bridge", () => {
  it("projects a host-path-free catalog and discloses admitted content read-only", async () => {
    const skills = provider();
    const catalog = createRuntimeSkillCatalog(skills);
    expect(catalog).toEqual([
      {
        name: "container-review",
        description: "Review a container change",
        scope: "user",
        source: "runtime",
        dependencies: [{ type: "mcp", value: "source-control" }],
      },
    ]);
    expect(JSON.stringify(catalog)).not.toContain(hostRoot);
    expect(JSON.stringify(catalog)).not.toContain("token@example.invalid");

    const grant = createHostSkillsGrant(skills, catalog);
    expect(grant.method).toBe(RUNTIME_SKILLS_METHOD);
    expect(grant.revision).toBe(RUNTIME_SKILLS_REVISION);
    const loaded = await grant.invoke(
      { operation: "load", name: "container-review" },
      new AbortController().signal,
    );
    expect(loaded).toEqual({
      kind: "skill",
      name: "container-review",
      description: "Review a container change",
      body: "Inspect the proposed change.",
      directory: "/runtime/skills/container-review",
      resources: [{ kind: "references", rel: "references/checklist.md" }],
    });
    expect(JSON.stringify(loaded)).not.toContain(hostRoot);

    await expect(
      grant.invoke(
        {
          operation: "resource",
          name: "container-review",
          resource: "references/checklist.md",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "resource",
      chunk: { text: "first ", offset: 0, nextOffset: 6, totalBytes: 12 },
    });
  });

  it("projects active plugin bootstraps as bodies without disclosing their host roots", () => {
    const bootstraps = createRuntimeSkillBootstraps(provider(), () => [
      { plugin: "review-tools", skill: info.name, roots: [hostRoot] },
    ]);
    expect(bootstraps).toEqual([
      {
        plugin: "review-tools",
        skill: info.name,
        body: "Inspect the proposed change.",
      },
    ]);
    expect(JSON.stringify(bootstraps)).not.toContain(hostRoot);
  });

  it("rejects unknown skills, traversal and undeclared fields before provider access", () => {
    const grant = createHostSkillsGrant(provider(), createRuntimeSkillCatalog(provider()));
    expect(grant.validateArguments({ operation: "load", name: "missing" })).toBe(false);
    expect(
      grant.validateArguments({
        operation: "resource",
        name: "container-review",
        resource: "../secret",
      }),
    ).toBe(false);
    expect(
      grant.validateArguments({
        operation: "load",
        name: "container-review",
        hostPath: hostRoot,
      }),
    ).toBe(false);
  });

  it("falls back to a bounded whole-resource read and rejects invalid invocations", async () => {
    const text = "x".repeat(SKILL_RESOURCE_MAX_CHARS + 10);
    const skills: SkillsProvider = {
      ...provider(),
      readResourceChunk: undefined,
      readResource: () => text,
      loadSkill: (name) =>
        name === info.name
          ? {
              ...content,
              resources: [
                ...content.resources,
                { kind: "other", rel: "../private", path: `${hostRoot}/private` },
              ],
            }
          : undefined,
    };
    const grant = createHostSkillsGrant(skills, createRuntimeSkillCatalog(skills));
    await expect(
      grant.invoke(
        {
          operation: "resource",
          name: info.name,
          resource: "references/checklist.md",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      chunk: {
        text: "x".repeat(SKILL_RESOURCE_MAX_CHARS),
        offset: 0,
        totalBytes: text.length,
        nextOffset: SKILL_RESOURCE_MAX_CHARS,
      },
    });
    await expect(
      grant.invoke(
        {
          operation: "resource",
          name: info.name,
          resource: "references/checklist.md",
          offset: 1,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      grant.invoke({ operation: "load", name: "missing" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      grant.invoke({ operation: "load", name: info.name }, new AbortController().signal),
    ).resolves.toMatchObject({ resources: [{ rel: "references/checklist.md" }] });
  });

  it("validates resource shape, offsets and catalog metadata", () => {
    const catalog = createRuntimeSkillCatalog({
      ...provider(),
      listSkills: () => [
        { ...info, source: "clarvis", catalogSuppressed: false, dependencies: undefined },
        { ...info, name: "plugin-skill", source: "plugin:review_tools" },
      ],
    });
    expect(catalog.map((entry) => entry.source)).toEqual(["clarvis", "plugin:review_tools"]);
    expect(catalog[0]).toMatchObject({ catalogSuppressed: false });
    const grant = createHostSkillsGrant(provider(), createRuntimeSkillCatalog(provider()));
    for (const value of [
      null,
      [],
      { operation: "resource", name: info.name, resource: "" },
      { operation: "resource", name: info.name, resource: "/absolute" },
      { operation: "resource", name: info.name, resource: "references//file" },
      { operation: "resource", name: info.name, resource: "references/./file" },
      { operation: "resource", name: info.name, resource: "references/file", offset: -1 },
      { operation: "resource", name: info.name, resource: "references/file", offset: 9_000_000 },
      { operation: "resource", name: info.name, resource: "references/file", offset: 1.5 },
      { operation: "load", name: info.name, resource: "SKILL.md" },
      { operation: "other", name: info.name },
    ]) {
      expect(grant.validateArguments(value)).toBe(false);
    }
  });

  it("activates the guest catalog only for enabled, granted and dependency-ready agents", async () => {
    const catalog = createRuntimeSkillCatalog(provider());
    const capability = createGuestSkillsCapability(
      catalog,
      bridge(() => Promise.reject(new Error("unused"))),
      [{ plugin: "review-tools", skill: info.name, body: "Mandatory review bootstrap." }],
    );
    expect(await capability.forRun(runContext(false))).toBeNull();
    const unavailable = await capability.forRun(runContext(true));
    expect(
      unavailable?.systemSection?.({ agent: "subagent", entry: true, grants: ["use_skills"] }),
    ).toBeUndefined();
    expect(
      unavailable?.forAgent({ agent: "subagent", entry: true, grants: ["use_skills"] }),
    ).toBeNull();

    const run = await capability.forRun(
      runContext(true, [{ name: "source-control", transport: "stdio", command: "mcp" }]),
    );
    expect(run?.systemSection?.({ agent: "subagent", entry: true, grants: [] })).toBeUndefined();
    expect(
      run?.systemSection?.({ agent: "subagent", entry: true, grants: ["use_skills"] }),
    ).toContain("Mandatory review bootstrap.");
    expect(run?.forAgent({ agent: "subagent", entry: true, grants: [] })).toBeNull();
  });

  it("loads skill bodies and resources through the guest tool handler", async () => {
    const calls: unknown[] = [];
    const runtimeBridge = bridge(async (_callId, request) => {
      calls.push(request.arguments);
      const input = request.arguments as { operation: string; offset?: number };
      if (input.operation === "resource") {
        return {
          kind: "resource",
          name: info.name,
          resource: "references/checklist.md",
          chunk: {
            text: "first ",
            offset: input.offset ?? 0,
            totalBytes: 12,
            nextOffset: 6,
          },
        };
      }
      return {
        kind: "skill",
        name: info.name,
        description: info.description,
        body: "Inspect the proposed change.",
        directory: "/runtime/skills/container-review",
        resources: [
          { kind: "references", rel: "references/checklist.md" },
          { kind: "invalid", rel: "ignored" },
        ],
      };
    });
    const run = await createGuestSkillsCapability(
      createRuntimeSkillCatalog(provider()),
      runtimeBridge,
    ).forRun(runContext(true, [{ name: "source-control", transport: "stdio", command: "mcp" }]));
    const agent = run?.forAgent({ agent: "subagent", entry: true, grants: ["use_skills"] });
    const built = buildContext();
    const contribution = agent?.attach(built.context);
    const handler = contribution?.handlers?.[0];
    if (handler === undefined) throw new Error("expected load_skill handler");
    expect(contribution?.tools?.map((tool) => tool.wireName)).toEqual([LOAD_SKILL_TOOL_NAME]);
    expect(contribution?.advertised).toBe(false);
    expect(handler.matches({ id: "other", name: "other", arguments: {} })).toBe(false);

    const body = await handler.handle(
      { id: "body", name: LOAD_SKILL_TOOL_NAME, arguments: { name: info.name } },
      2,
    );
    expect(body).toMatchObject({ kind: "result", progress: true });
    expect(body.kind === "result" ? body.text : "").toContain("Bundled resources");

    const alias = await handler.handle(
      {
        id: "alias",
        name: LOAD_SKILL_TOOL_NAME,
        arguments: { name: info.name, resource: `${info.name}/SKILL.md`, offset: 0 },
      },
      3,
    );
    expect(alias).toMatchObject({ kind: "result", progress: true });

    const resource = await handler.handle(
      {
        id: "resource",
        name: LOAD_SKILL_TOOL_NAME,
        arguments: { name: info.name, resource: " references/checklist.md ", offset: 0 },
      },
      4,
    );
    expect(resource).toMatchObject({ kind: "result", progress: true });
    expect(resource.kind === "result" ? resource.text : "").toContain("resource continues");
    expect(calls).toContainEqual({
      operation: "resource",
      name: info.name,
      resource: "references/checklist.md",
      offset: 0,
    });
    expect(built.entries.some((entry) => entry.kind === "tool_call_started")).toBe(true);
  });

  it("maps guest validation, availability and bridge failures to tool results", async () => {
    const catalog = createRuntimeSkillCatalog(provider());
    const readyRun = async (runtimeBridge: GuestExecutionBridge) => {
      const run = await createGuestSkillsCapability(catalog, runtimeBridge).forRun(
        runContext(true, [{ name: "source-control", transport: "stdio", command: "mcp" }]),
      );
      const agent = run?.forAgent({ agent: "subagent", entry: true, grants: ["use_skills"] });
      if (agent === null || agent === undefined) throw new Error("expected skills capability");
      return agent;
    };

    const invalidBuild = buildContext(() => "arguments must contain name");
    const invalidHandler = (await readyRun(bridge(() => Promise.resolve(null)))).attach(
      invalidBuild.context,
    ).handlers?.[0];
    const invalid = await invalidHandler?.handle(
      { id: "invalid", name: LOAD_SKILL_TOOL_NAME, arguments: {} },
      1,
    );
    expect(invalid).toMatchObject({ kind: "result", progress: false });

    const unavailableHandler = (
      await readyRun(bridge(() => Promise.resolve({ kind: "wrong" })))
    ).attach(buildContext().context).handlers?.[0];
    await expect(
      unavailableHandler?.handle(
        { id: "gone", name: LOAD_SKILL_TOOL_NAME, arguments: { name: info.name } },
        1,
      ),
    ).resolves.toMatchObject({ kind: "result", progress: false });

    const throwingHandler = (
      await readyRun(bridge(() => Promise.reject(new Error("host bridge closed"))))
    ).attach(buildContext().context).handlers?.[0];
    await expect(
      throwingHandler?.handle(
        { id: "throw", name: LOAD_SKILL_TOOL_NAME, arguments: { name: info.name } },
        1,
      ),
    ).resolves.toMatchObject({ kind: "result", progress: false });

    const handler = (await readyRun(bridge(() => Promise.resolve(null)))).attach(
      buildContext().context,
    ).handlers?.[0];
    await expect(
      handler?.handle(
        { id: "unknown", name: LOAD_SKILL_TOOL_NAME, arguments: { name: "missing" } },
        1,
      ),
    ).resolves.toMatchObject({ kind: "result", progress: false });
    await expect(
      handler?.handle(
        {
          id: "offset",
          name: LOAD_SKILL_TOOL_NAME,
          arguments: { name: info.name, resource: "SKILL.md", offset: 1 },
        },
        1,
      ),
    ).resolves.toMatchObject({ kind: "result", progress: false });
  });
});
