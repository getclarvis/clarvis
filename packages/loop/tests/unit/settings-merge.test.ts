import { describe, it, expect } from "../bun-test.ts";
import {
  SETTINGS_MERGE_STRATEGY_KEYS,
  mergeSettings,
  type SettingsScope,
} from "../../src/settings/settings-merge.ts";
import { settingsSchema, type SettingsFile } from "../../src/settings/settings-schema.ts";
import { MAX_HOOKS_PER_RUN } from "@clarvis/capability";
import { createCapabilityRegistry } from "@clarvis/capability";
import { z } from "zod";

const operator = (settings: SettingsFile): SettingsScope => ({ origin: "operator", settings });
const plugin = (settings: SettingsFile): SettingsScope => ({ origin: "plugin", settings });
const pluginRef = (name: string) => ({
  scope: "global" as const,
  source: "clarvis" as const,
  name,
});

describe("mergeSettings", () => {
  it("returns an empty object when there are no scopes", () => {
    expect(mergeSettings([])).toEqual({});
  });

  it("returns the lone scope untouched", () => {
    const global: SettingsFile = {
      providers: [{ name: "p", kind: "anthropic" }],
      mcpServers: { fs: { type: "stdio", command: "x" } },
      default_model: "anthropic/x",
      budget: { on_exceed: "stop", total_token_limit: 1 },
    };
    expect(mergeSettings([operator(global)])).toEqual(global);
  });

  it("shallow-merges mcpServers by key (later scope wins on collision)", () => {
    const global: SettingsFile = {
      mcpServers: {
        fs: { type: "stdio", command: "global" },
        git: { type: "stdio", command: "git-mcp" },
      },
    };
    const workspace: SettingsFile = {
      mcpServers: { fs: { type: "stdio", command: "workspace" } },
    };
    const merged = mergeSettings([operator(global), operator(workspace)]);
    expect(merged.mcpServers).toEqual({
      fs: { type: "stdio", command: "workspace" },
      git: { type: "stdio", command: "git-mcp" },
    });
  });

  it("overrides providers by name and lets the later scope's budget and default_model win", () => {
    const global: SettingsFile = {
      providers: [{ name: "p", kind: "anthropic" }],
      default_model: "anthropic/old",
      budget: { on_exceed: "stop", total_token_limit: 1 },
    };
    const workspace: SettingsFile = {
      providers: [
        { name: "p", kind: "openai" },
        { name: "q", kind: "google" },
      ],
      default_model: "anthropic/new",
      budget: { on_exceed: "stop", total_token_limit: 2 },
    };
    const merged = mergeSettings([operator(global), operator(workspace)]);
    expect(merged.providers).toEqual([
      { name: "p", kind: "openai" },
      { name: "q", kind: "google" },
    ]);
    expect(merged.default_model).toBe("anthropic/new");
    expect(merged.budget).toEqual({ on_exceed: "stop", total_token_limit: 2 });
  });

  it("a lastWins block falls back to the earlier scope when the later declares none", () => {
    const global: SettingsFile = { guard: { type: "shell", mode: "on" } };
    expect(mergeSettings([operator(global), operator({ providers: [] })]).guard).toEqual(
      global.guard,
    );
    const workspace: SettingsFile = { guard: { type: "shell", mode: "off" } };
    expect(mergeSettings([operator(global), operator(workspace)]).guard).toEqual(workspace.guard);
  });

  it("falls back to an earlier scope's default_model when a later one declares none", () => {
    const merged = mergeSettings([
      operator({ default_model: "anthropic/g" }),
      operator({ providers: [] }),
    ]);
    expect(merged.default_model).toBe("anthropic/g");
  });

  it("lets the later default_reasoning_effort win and falls back to the earlier otherwise", () => {
    const global: SettingsFile = { default_reasoning_effort: "low" };
    expect(
      mergeSettings([operator(global), operator({ providers: [] })]).default_reasoning_effort,
    ).toBe("low");
    const workspace: SettingsFile = { default_reasoning_effort: "high" };
    expect(mergeSettings([operator(global), operator(workspace)]).default_reasoning_effort).toBe(
      "high",
    );
  });

  it("carries an earlier scope's hooks and guard through when a later one declares none", () => {
    const global: SettingsFile = {
      hooks: [{ event: "pre_tool_use", command: "echo hi" }],
      guard: { type: "shell", allowed_commands: ["echo"] },
    };
    const merged = mergeSettings([operator(global), operator({ providers: [] })]);
    expect(merged.hooks).toEqual([{ event: "pre_tool_use", command: "echo hi" }]);
    expect(merged.guard).toEqual({ type: "shell", allowed_commands: ["echo"] });
  });

  it("concatenates operator hooks in scope order and lets the later guard win", () => {
    const global: SettingsFile = {
      hooks: [{ event: "pre_tool_use", command: "global" }],
      guard: { type: "shell", allowed_commands: ["global"] },
    };
    const workspace: SettingsFile = {
      hooks: [{ event: "post_tool_use", command: "workspace" }],
      guard: { type: "shell", allowed_commands: ["workspace"] },
    };
    const merged = mergeSettings([operator(global), operator(workspace)]);
    expect(merged.hooks).toEqual([
      { event: "pre_tool_use", command: "global" },
      { event: "post_tool_use", command: "workspace" },
    ]);
    expect(merged.guard).toEqual({
      type: "shell",
      allowed_commands: ["workspace"],
    });
  });

  it("merges sandbox scalars last-wins and unions scoped toolchain paths", () => {
    const merged = mergeSettings([
      operator({
        sandbox: {
          type: "native",
          network: "none",
          pass_env: ["CI"],
          toolchains: {
            mode: "auto",
            include: ["node", "python3"],
            extra_paths: ["/opt/global", "/opt/shared"],
          },
        },
      }),
      operator({
        sandbox: {
          type: "native",
          network: "host",
          pass_env: ["TERM"],
          toolchains: {
            exclude: ["python3"],
            extra_paths: ["./vendor/sdk", "/opt/shared"],
            excluded_paths: ["/opt/global"],
          },
        },
      }),
    ]);
    expect(merged.sandbox).toEqual({
      type: "native",
      network: "host",
      pass_env: ["CI", "TERM"],
      toolchains: {
        mode: "auto",
        include: ["node", "python3"],
        exclude: ["python3"],
        extra_paths: ["/opt/shared", "./vendor/sdk"],
        excluded_paths: ["/opt/global"],
      },
    });
  });
});

describe("mergeSettings — plugin scopes (D7)", () => {
  it("appends plugin hooks AFTER every operator hook, even though plugin is the lowest scope", () => {
    const merged = mergeSettings([
      plugin({ hooks: [{ event: "pre_tool_use", command: "plugin-a" }] }),
      operator({ hooks: [{ event: "pre_tool_use", command: "global" }] }),
      operator({ hooks: [{ event: "pre_tool_use", command: "workspace" }] }),
      plugin({ hooks: [{ event: "pre_tool_use", command: "plugin-b" }] }),
    ]);
    expect(merged.hooks?.map((h) => h.command)).toEqual([
      "global",
      "workspace",
      "plugin-a",
      "plugin-b",
    ]);
  });

  it("bounds the merged hook chain even when many trusted scopes contribute", () => {
    const hook = { event: "run_start" as const, command: "true" };
    const merged = mergeSettings(
      Array.from({ length: 3 }, () =>
        operator({ hooks: Array.from({ length: 64 }, () => ({ ...hook })) }),
      ),
    );
    expect(merged.hooks).toHaveLength(MAX_HOOKS_PER_RUN);
  });

  it("keeps plugin LOWEST for every other key, so an operator scope always wins", () => {
    const merged = mergeSettings([
      plugin({
        default_model: "anthropic/plugin",
        guard: { type: "shell", allowed_commands: ["plugin"] },
      }),
      operator({ default_model: "anthropic/operator" }),
    ]);
    expect(merged.default_model).toBe("anthropic/operator");
    expect(merged.guard).toEqual({ type: "shell", allowed_commands: ["plugin"] });
  });
});

describe("mergeSettings — enabledPlugins", () => {
  it("concatenates scopes and de-duplicates, keeping first-seen order", () => {
    const merged = mergeSettings([
      operator({ enabledPlugins: [pluginRef("a"), pluginRef("b")] }),
      operator({ enabledPlugins: [pluginRef("b"), pluginRef("c")] }),
    ]);
    expect(merged.enabledPlugins).toEqual([pluginRef("a"), pluginRef("b"), pluginRef("c")]);
  });

  it("stays absent when no scope declares it", () => {
    expect(mergeSettings([operator({ providers: [] })]).enabledPlugins).toBeUndefined();
  });

  it("cannot be un-enabled by a later scope — a workspace only ever adds", () => {
    const merged = mergeSettings([
      operator({ enabledPlugins: [pluginRef("a")] }),
      operator({ enabledPlugins: [] }),
    ]);
    expect(merged.enabledPlugins).toEqual([pluginRef("a")]);
  });
});

describe("mergeSettings — marketplaces", () => {
  it("concatenates distinct locations in first-seen order", () => {
    const merged = mergeSettings([
      operator({ marketplaces: ["getclarvis/core", "company/internal"] }),
      operator({ marketplaces: ["company/internal", "company/research"] }),
    ]);
    expect(merged.marketplaces).toEqual([
      "getclarvis/core",
      "company/internal",
      "company/research",
    ]);
  });

  it("bounds the aggregate marketplace list across scopes", () => {
    const marketplaces = Array.from(
      { length: 257 },
      (_, index) => `company/market-${String(index)}`,
    );
    expect(() => mergeSettings([operator({ marketplaces })])).toThrow("merged list exceeds");
  });
});

describe("mergeSettings — aggregate limits", () => {
  it("rejects provider and enabled-plugin unions that exceed their aggregate ceilings", () => {
    const providers = Array.from({ length: 1_001 }, (_, index) => ({
      name: `p${String(index)}`,
      kind: "anthropic" as const,
    }));
    expect(() => mergeSettings([operator({ providers })])).toThrow(/providers exceed 1000/);

    const enabledPlugins = Array.from({ length: 257 }, (_, index) =>
      pluginRef(`plugin-${String(index)}`),
    );
    expect(() => mergeSettings([operator({ enabledPlugins })])).toThrow(/list exceeds 256/);
  });

  it("rejects MCP and sandbox collections that exceed a ceiling only after merging", () => {
    const servers = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          `${prefix}${index}`,
          { type: "stdio" as const, command: "server" },
        ]),
      );
    expect(() =>
      mergeSettings([
        operator({ mcpServers: servers("a") }),
        operator({ mcpServers: servers("b") }),
      ]),
    ).toThrow(/256/);

    expect(() =>
      mergeSettings([
        operator({ sandbox: { type: "native", pass_env: Array(129).fill("A") } }),
        operator({
          sandbox: {
            type: "native",
            pass_env: Array.from({ length: 129 }, (_, index) => `B${index}`),
          },
        }),
      ]),
    ).not.toThrow(); // Duplicate values in one source collapse before the aggregate ceiling.
    expect(() =>
      mergeSettings([
        operator({
          sandbox: {
            type: "native",
            pass_env: Array.from({ length: 129 }, (_, index) => `A${index}`),
          },
        }),
        operator({
          sandbox: {
            type: "native",
            pass_env: Array.from({ length: 129 }, (_, index) => `B${index}`),
          },
        }),
      ]),
    ).toThrow(/256/);
  });
});

describe("mergeSettings — registered capabilities", () => {
  it("applies a registered custom merge and skips a registered built-in key", () => {
    const registry = createCapabilityRegistry();
    registry.register({
      key: "audit",
      schema: z.object({ level: z.string() }),
      merge: (scopes) => scopes.map((scope) => scope.value).at(0),
      pluginContributable: false,
    });
    registry.register({
      key: "guard",
      schema: z.any(),
      merge: "lastWins",
      pluginContributable: false,
    });
    const merged = mergeSettings(
      [operator({ audit: { level: "high" } } as unknown as SettingsFile)],
      registry,
    ) as unknown as Record<string, unknown>;

    expect(merged.audit).toEqual({ level: "high" });
  });
});

describe("settings merge strategy table", () => {
  it("declares a strategy for every key in settingsSchema — a new key cannot silently vanish", () => {
    expect([...SETTINGS_MERGE_STRATEGY_KEYS].map(String).sort()).toEqual(
      Object.keys(settingsSchema.shape).sort(),
    );
  });
});
