import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@clarvis/loop";
import type { StartRunParams } from "@clarvis/protocol";
import {
  admitContainerCoreRun,
  assertContainerCoreRuntimeRequest,
  CONTAINER_CORE_CAPABILITY_METHODS,
  CONTAINER_CORE_GRANTS,
  containerCorePolicy,
} from "../../src/runtime/container-core-policy.ts";

const params: StartRunParams = {
  messages: [{ role: "user", content: "test" }],
};

function profile(name: string, grants: string[] = []): AgentProfile {
  return {
    name,
    model: "provider/model",
    tools: [],
    grants,
    iteration_limit: 10,
    timeout_ms: 1_000,
    tool_timeout_ms: 1_000,
  } as AgentProfile;
}

function admit(options: {
  profiles?: AgentProfile[];
  params?: StartRunParams;
  scopes?: Record<string, "builtin" | "global" | "workspace" | "plugin">;
  frontmatters?: Record<string, Record<string, unknown>>;
  missing?: readonly string[];
  servers?: unknown[];
  customAssembler?: boolean;
}) {
  const profiles = options.profiles ?? [profile("marshall", ["edit_workspace", "use_skills"])];
  return admitContainerCoreRun({
    params: options.params ?? params,
    assembled: {
      messages: params.messages,
      servers: options.servers ?? [],
      profiles,
      entry: profiles[0]!.name,
      providers: [{ name: "provider", kind: "openai" }],
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    },
    source: {
      readEffectiveAgent: (name) =>
        options.missing?.includes(name)
          ? null
          : {
              name,
              scope: options.scopes?.[name] ?? "builtin",
              frontmatter: options.frontmatters?.[name] ?? {},
              body: "prompt",
            },
    },
    customAssembler: options.customAssembler ?? false,
    goalRequested: false,
  });
}

describe("container core admission", () => {
  test("publishes closed capability and grant vocabularies", () => {
    expect(CONTAINER_CORE_CAPABILITY_METHODS).toEqual(["runtime.elicit"]);
    expect(CONTAINER_CORE_GRANTS).toEqual([
      "ask_user",
      "read_workspace",
      "edit_workspace",
      "run_commands",
    ]);
    expect(
      containerCorePolicy({
        toolPolicy: { enabled: true, confine: true, maxGrant: "exec" },
        network: "outbound",
        gitMetadata: "read-only",
      }),
    ).toEqual({
      revision: 1,
      toolPolicy: { enabled: true, confine: true, maxGrant: "exec" },
      network: "outbound",
      gitMetadata: "read-only",
      commandReview: "off",
      hostFeatures: "none",
    });
  });

  test("projects shipped profiles and extension servers to the core surface", () => {
    const body = admit({ servers: [{ name: "plugin.server" }] });
    expect(body.servers).toEqual([]);
    expect(body.profiles[0]?.grants).toEqual(["edit_workspace"]);
  });

  test.each([
    ["Skills", { skill: "review" }],
    ["Tasks", { task: { provider: "x", id: "1" } }],
    ["Plans", { plans: "off" }],
    ["Memory", { memory: "off" }],
    ["Command Review", { guard_mode: "on" }],
    ["Command Review", { guard_judge: { guidance: "check" } }],
  ] as const)("refuses explicit %s before projection", (capability, extra) => {
    expect(() => admit({ params: { ...params, ...extra } as StartRunParams })).toThrow(
      `${capability} is unavailable in Isolation Container`,
    );
  });

  test("refuses admiral, plugin agents and custom extension grants", () => {
    expect(() => admit({ profiles: [profile("admiral", ["workflow"])] })).toThrow(
      "Workflow is unavailable",
    );
    expect(() =>
      admit({ profiles: [profile("plugin:agent")], scopes: { "plugin:agent": "plugin" } }),
    ).toThrow("Plugin Agent 'plugin:agent' is unavailable");
    expect(() =>
      admit({ profiles: [profile("custom", ["use_skills"])], scopes: { custom: "global" } }),
    ).toThrow("Skills is unavailable");
  });

  test("allows a custom profile only when its whole graph is core", () => {
    const body = admit({
      profiles: [
        {
          ...profile("custom", ["ask_user", "run_commands"]),
          can_spawn: ["reader"],
          default_spawn: "reader",
        },
        profile("reader", ["read_workspace"]),
      ],
      scopes: { custom: "global", reader: "workspace" },
    });
    expect(body.profiles.map((item) => item.name)).toEqual(["custom", "reader"]);
  });

  test("refuses missing default spawns and source declarations hidden by a custom assembler", () => {
    expect(() =>
      admit({
        profiles: [{ ...profile("custom"), default_spawn: "missing" }],
        scopes: { custom: "global" },
      }),
    ).toThrow("depends on unavailable profile 'missing'");
    expect(() =>
      admit({
        profiles: [profile("custom")],
        scopes: { custom: "workspace" },
        frontmatters: { custom: { grants: ["use_skills"] } },
        customAssembler: true,
      }),
    ).toThrow("Skills is unavailable");
    expect(() =>
      admit({
        profiles: [profile("custom")],
        scopes: { custom: "workspace" },
        frontmatters: { custom: { tools: ["plugin.server/tool"] } },
        customAssembler: true,
      }),
    ).toThrow("MCP tools in Agent Profile 'custom' is unavailable");
    expect(() => admit({ profiles: [profile("missing")], missing: ["missing"] })).toThrow(
      "Agent Profile 'missing' is unavailable in Isolation Container",
    );
  });

  test("treats feature fields from a custom assembler as explicit", () => {
    expect(() => {
      const body = admit({ customAssembler: true });
      return admitContainerCoreRun({
        params,
        assembled: { ...body, plans: "off" },
        source: {
          readEffectiveAgent: () => ({
            name: "marshall",
            scope: "builtin",
            frontmatter: {},
            body: "",
          }),
        },
        customAssembler: true,
        goalRequested: false,
      });
    }).toThrow("Plans is unavailable");
  });

  test("runtime defense rejects every legacy feature field before broker construction", () => {
    const body = admit({});
    expect(() => assertContainerCoreRuntimeRequest(body)).not.toThrow();
    for (const field of ["hostCapabilities", "hooks", "workflow", "goal", "guard_mode"]) {
      expect(() => assertContainerCoreRuntimeRequest({ ...body, [field]: {} })).toThrow(
        "outside the admitted core surface",
      );
    }
  });
});
